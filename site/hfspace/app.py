"""Clip Vault site: Google sign-in, viewers and admins, a proxy to the private dataset, and clip/user management.

Modules: common.py (config, cookies, sessions, limits), auth.py (the only Google calls), store.py (the only dataset
writes, the only user of the write token), admin.py (clip and user endpoints). This file: wiring, guard, auth routes,
file proxy, static hosting.

Env (every list and secret is re-read on EVERY request, so editing a Space secret needs no code change):
  GOOGLE_CLIENT_ID    public OAuth client id (a Space variable is fine)
  VAULT_READ_TOKEN    secret, read-only token for ONE dataset
  VAULT_WRITE_TOKEN   optional secret, fine-grained write token for the SAME dataset only (different from the read token);
                      unset = read-only mode (all mutations answer 503 read_only)
  VAULT_DATASET       default Soverellp/clip-vault
  ALLOWED_EMAILS      secret, viewers: comma separated `email` or `email:sub`
  ADMIN_EMAILS        secret, root admins (implicitly viewers; cannot be changed from the site): same format
  SESSION_SECRET      secret, at least 32 characters
  SESSIONS_NOT_BEFORE optional unix seconds; sessions issued before it are rejected
"""
import asyncio
import contextlib
import logging
import re
import secrets
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from starlette.exceptions import HTTPException as StarletteHTTPException

import admin
import auth
import common
import store
from common import (ApiError, CSP, NONCE_COOKIE, NONCE_TTL, SESSION_COOKIE, SESSION_TTL, _config, _del_cookie, _limited,  # noqa: F401
                    _set_cookie, _sign, _unsign, err, no_content, ok)

HF_BASE = "https://huggingface.co"
CHUNK = 64 * 1024
MAX_REDIRECTS = 5
FILE_RE = re.compile(r"(trash/)?clips/([A-Za-z0-9_][A-Za-z0-9_.\-]{0,199})\.(mp4|jpg)")
RANGE_RE = re.compile(r"bytes=\d{0,15}-\d{0,15}")
CONTENT_TYPES = {"mp4": "video/mp4", "jpg": "image/jpeg"}
AUTH_BODY_LIMIT = 8 * 1024
_ip = common.client_ip
_proxy_logged = False


@contextlib.asynccontextmanager
async def lifespan(app):
    def purge():  # best effort: expired trash is removed at startup; failures only log one fixed line
        try:
            cfg = _config()
            if cfg:
                admin.maybe_purge(cfg, store.snapshot(cfg), "system")
        except Exception:
            print("startup purge skipped", flush=True)
    threading.Thread(target=purge, daemon=True).start()
    yield


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


# ---------------------------------------------------------------- upstream (dataset) reads

def _http_get(url: str, headers: dict):
    return requests.get(url, headers=headers, stream=True, allow_redirects=False, timeout=(10, 60))


def fetch_upstream(cfg, path: str, range_header: str):
    """GET a dataset file with the READ token. Follows redirects by hand so the token never goes to another host.

    Returns (status, headers, chunk_iterator, close_fn).
    """
    url = f"{HF_BASE}/datasets/{cfg['dataset']}/resolve/main/{path}"
    home = urlparse(HF_BASE).hostname
    for _ in range(MAX_REDIRECTS + 1):
        host = urlparse(url).hostname
        headers = {"Accept-Encoding": "identity"}
        if host == home:
            headers["Authorization"] = f"Bearer {cfg['token']}"
        if range_header:
            headers["Range"] = range_header
        r = _http_get(url, headers)
        if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("Location"):
            nxt = urljoin(url, r.headers["Location"])
            r.close()
            if urlparse(nxt).scheme != "https":
                raise RuntimeError("bad redirect")
            url = nxt
            continue
        return r.status_code, r.headers, r.iter_content(CHUNK), r.close
    raise RuntimeError("too many redirects")


# ---------------------------------------------------------------- logging helpers

def _log_proxy_shape_once(request: Request):
    """Once per process, to stdout: how many X-Forwarded-For hops and whether x-real-ip exists. Counts only."""
    global _proxy_logged
    with common._lock:
        if _proxy_logged:
            return
        _proxy_logged = True
    xff = request.headers.get("x-forwarded-for", "")
    hops = len([h for h in xff.split(",") if h.strip()]) if xff else 0
    real = "yes" if "x-real-ip" in request.headers else "no"
    print(f"proxy-shape: x-forwarded-for hops={hops} x-real-ip={real}", file=sys.stdout, flush=True)


class _EndedEarly(logging.Filter):
    """uvicorn logs a traceback when a response ends shorter than its Content-Length (our mid-stream abort)."""

    def filter(self, record):
        ei = record.exc_info
        if ei and ei[1] is not None and "Too little data for declared Content-Length" in str(ei[1]):
            record.exc_info = record.exc_text = None
            record.msg, record.args = "upstream stream ended early; response truncated", ()
        return True


logging.getLogger("uvicorn.error").addFilter(_EndedEarly())


def _quiet(chunks, close):
    """Pass chunks through; if the upstream breaks mid-stream, stop without logging anything."""
    try:
        yield from chunks
    except Exception:
        return
    finally:
        try:
            close()
        except Exception:
            pass


# ---------------------------------------------------------------- errors and guard

@app.exception_handler(ApiError)
async def _api_error(request, e: ApiError):
    hdrs = dict(e.headers)
    if e.status == 413:
        hdrs["Connection"] = "close"  # stop the sender instead of draining the rest of an oversized body
    return err(e.status, e.code, e.extra, **hdrs)


@app.exception_handler(StarletteHTTPException)
async def _http_error(request, e):
    code = {401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed"}.get(e.status_code, "bad_request")
    return err(e.status_code, code, **({"Allow": e.headers["Allow"]} if e.headers and "Allow" in e.headers else {}))


@app.exception_handler(RequestValidationError)
async def _validation_error(request, e):
    return err(422, "invalid")


@app.middleware("http")
async def guard(request: Request, call_next):
    _log_proxy_shape_once(request)
    path = request.url.path
    bucket = ("auth" if path in ("/api/auth/google", "/api/auth/reauth") else "config" if path in ("/api/auth/config", "/logout")
              else "api" if path.startswith("/api/") else None)
    if not path.startswith("/api/files/"):  # Range only matters for media (CPU-amplification guard)
        request.scope["headers"] = [h for h in request.scope["headers"] if h[0] != b"range"]
    if bucket and _limited(_ip(request), bucket):
        resp = err(429, "rate_limited", **{"Retry-After": "60"})
    elif _config() is None:
        resp = err(503, "not_configured")
    elif request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("sec-fetch-site", "same-origin") not in ("same-origin", "none"):
        resp = err(403, "forbidden")  # cross-site unsafe request
    else:
        resp = await call_next(request)
    resp.headers.setdefault("Cache-Control", "no-store")
    resp.headers["Content-Security-Policy"] = CSP
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    resp.headers["Strict-Transport-Security"] = "max-age=31536000"
    return resp


# ---------------------------------------------------------------- auth routes

@app.get("/api/auth/config")
def auth_config():
    cfg = _config()
    nonce = secrets.token_urlsafe(24)
    resp = ok({"client_id": cfg["client_id"], "nonce": nonce})
    _set_cookie(resp, NONCE_COOKIE, _sign(cfg["secret"], "nonce", {"n": nonce, "exp": time.time() + NONCE_TTL}), NONCE_TTL)
    return resp


async def _credential(request: Request, cfg):
    """(credential, nonce) from the body and the nonce cookie; the body is capped at 8 KB before it is read."""
    raw_cookie = request.cookies.get(NONCE_COOKIE, "")
    data = _unsign(cfg["secret"], "nonce", raw_cookie) if raw_cookie and len(raw_cookie) < 512 else None
    body = await admin.json_body(request, AUTH_BODY_LIMIT, allow_empty=False)
    cred = body.get("credential")
    if not isinstance(cred, str) or not (20 <= len(cred) <= 4096) or set(body) != {"credential"}:
        raise ApiError(422, "invalid")
    if not data or not isinstance(data.get("n"), str):
        raise ApiError(403, "forbidden")
    return cred, data["n"]


async def _verified_claims(cred: str, nonce: str, cfg) -> dict:
    if not auth.google_sem.acquire(blocking=False):  # shed load instead of queueing
        raise ApiError(429, "rate_limited", headers={"Retry-After": "30"})

    def work():
        try:
            return auth.verify_google_credential(cred, nonce)
        finally:  # released by the worker itself, so a timed-out thread still counts against the cap until it ends
            auth.google_sem.release()
    try:
        claims = await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(None, work), auth.VERIFY_DEADLINE)
        return auth.check_claims(claims, cfg["client_id"], nonce)  # app-side re-check of aud, iss, exp, email_verified, nonce
    except asyncio.TimeoutError:
        raise ApiError(502, "upstream_error") from None
    except Exception:
        raise ApiError(403, "forbidden") from None


def _finish(resp, cfg, email, sub, name, picture, iat, ra):
    _set_cookie(resp, SESSION_COOKIE, common.session_cookie_value(cfg, email, sub, name, picture, iat, ra, iat + SESSION_TTL), SESSION_TTL)


@app.post("/api/auth/google")
async def auth_google(request: Request):
    cfg = _config()
    has_nonce = NONCE_COOKIE in request.cookies
    try:
        cred, nonce = await _credential(request, cfg)
        claims = await _verified_claims(cred, nonce, cfg)
        email, sub = claims["email"].strip().lower(), claims["sub"]
        role, _root = common.role_of(email, sub, await asyncio.get_running_loop().run_in_executor(None, store.users_or_empty, cfg))
        if role is None:
            raise ApiError(403, "forbidden")
    except ApiError as e:
        resp = err(e.status, e.code, e.extra, **e.headers)
        if has_nonce and e.code != "rate_limited":
            _del_cookie(resp, NONCE_COOKIE)
        return resp
    now = time.time()
    resp = no_content()
    _finish(resp, cfg, email, sub, common.clean_name(claims.get("name"), email), common.clean_picture(claims.get("picture")), now, now)
    _del_cookie(resp, NONCE_COOKIE)
    return resp


@app.post("/api/auth/reauth")
async def auth_reauth(request: Request):
    cfg = _config()
    s = admin.need_session(request, csrf=True)
    try:
        cred, nonce = await _credential(request, cfg)
        claims = await _verified_claims(cred, nonce, cfg)
    except ApiError as e:
        resp = err(e.status, e.code, e.extra, **e.headers)
        if e.code != "rate_limited":
            _del_cookie(resp, NONCE_COOKIE)
        return resp
    if claims["email"].strip().lower() != s.email or claims["sub"] != s.sub:
        resp = err(403, "forbidden")  # a different Google account: nothing changes
        _del_cookie(resp, NONCE_COOKIE)
        return resp
    resp = no_content()
    _finish(resp, cfg, s.email, s.sub, s.name, s.picture, s.iat, time.time())
    _del_cookie(resp, NONCE_COOKIE)
    return resp


@app.post("/logout")
def logout(request: Request):
    resp = Response(status_code=303, headers={"Location": "/", "Cache-Control": "no-store"})  # the browser follows with GET /
    _del_cookie(resp, SESSION_COOKIE)
    return resp


@app.get("/logout")
def logout_get():
    return err(405, "method_not_allowed", Allow="POST")


@app.get("/api/me")
def me(request: Request):
    s = admin.need_session(request)
    return ok({"email": s.email, "name": s.name, "picture": s.picture, "role": s.role, "csrf": s.csrf,
               "can_write": store.get_store(_config()).can_write, "sub": s.sub, "root": s.root, "session_age_seconds": s.age})


# ---------------------------------------------------------------- file proxy

@app.get("/api/files/{path:path}")
def files(path: str, request: Request):
    cfg = _config()
    s = admin.need_session(request)
    raw = request.scope.get("raw_path") or b""
    m = FILE_RE.fullmatch(path)
    if b"%" in raw or ".." in path or not m or (m.group(1) and not s.admin):
        raise ApiError(404, "not_found")
    try:
        snap = store.snapshot(cfg)
    except Exception:
        raise ApiError(502, "upstream_error") from None
    c = store.find(snap.index, m.group(2))
    ext = m.group(3)
    if c is None or bool(c["trashed_at"]) != bool(m.group(1)) or (ext == "jpg" and not c["poster"]):
        raise ApiError(404, "not_found")
    rng = request.headers.get("range", "")
    try:
        status, hdrs, chunks, close = fetch_upstream(cfg, path, rng if RANGE_RE.fullmatch(rng) else "")
    except Exception:
        raise ApiError(502, "upstream_error") from None
    if status == 404:
        close()
        raise ApiError(404, "not_found")
    if status not in (200, 206):
        close()
        raise ApiError(502, "upstream_error")
    out = {"Content-Type": CONTENT_TYPES[ext], "Cache-Control": "no-store"}
    for h in ("Content-Length", "Content-Range", "Accept-Ranges", "ETag"):
        if hdrs.get(h):
            out[h] = hdrs[h]
    return StreamingResponse(_quiet(chunks, close), status_code=status, headers=out, background=BackgroundTask(close))


app.include_router(admin.router)
app.mount("/", StaticFiles(directory=str(Path(__file__).parent / "static"), html=True), name="static")
