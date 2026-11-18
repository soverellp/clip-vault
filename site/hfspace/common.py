"""Shared plumbing for the Clip Vault Space: env/config, signed cookies, sessions, rate limits, errors.

Nothing here talks to Google or to the dataset (auth.py and store.py do). Secrets are read from the environment on
every call so that editing a Space secret needs no code change.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import threading
import time
from collections import OrderedDict

from fastapi import Request
from fastapi.responses import JSONResponse, Response

SESSION_COOKIE = "__Host-cv_session"  # __Host-: Secure, Path=/, no Domain, so a sibling *.hf.space cannot overwrite it
NONCE_COOKIE = "__Host-cv_nonce"
SESSION_TTL = 8 * 3600
NONCE_TTL = 300
REAUTH_WINDOW = 300  # seconds since the last Google sign-in during which step-up actions are allowed
MIN_SECRET = 32
MAX_SUB = 128
MAX_COOKIE = 3800
DATASET_RE = re.compile(r"[A-Za-z0-9_.\-]{1,96}/[A-Za-z0-9_.\-]{1,96}")
EMAIL_RE = re.compile(r"[a-z0-9._%+\-']{1,64}@[a-z0-9\-]{1,63}(\.[a-z0-9\-]{1,63}){1,5}")
PICTURE_RE = re.compile(r"https://[a-z0-9\-]+\.googleusercontent\.com/[A-Za-z0-9_\-./=%?&~:+,;@!]{1,280}")
CSP = ("default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client; "
       "frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; "
       "style-src 'self' https://accounts.google.com/gsi/style; img-src 'self' data: blob: https://*.googleusercontent.com; "
       "media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; "
       "form-action 'self'; object-src 'none'")

# bucket -> (max requests, window seconds). IP buckets key on the client address, user buckets on the account email.
LIMITS = {"auth": (10, 60), "config": (120, 60), "api": (600, 60), "admin_mut": (30, 60), "upload": (5, 600)}
RATE_WINDOW = 60.0
RATE_MAX_KEYS = 10000

MESSAGES = {
    "unauthorized": "Sign in first.", "forbidden": "Not allowed.", "not_found": "Not found.",
    "method_not_allowed": "Method not allowed.", "conflict": "The data changed; try again.",
    "too_large": "The request is too large.", "unsupported_media_type": "Unsupported content type.",
    "invalid": "The request is not valid.", "rate_limited": "Too many requests. Try again in a minute.",
    "read_only": "The vault is read-only.", "not_configured": "The site is not configured.",
    "upstream_error": "The vault is not reachable right now.", "confirm_mismatch": "The confirmation does not match.",
    "reauth_required": "Confirm it's you with Google first.", "root_admin": "This admin is set in the Space secrets.",
    "self": "You cannot change your own access.", "duplicate": "This clip is already in the vault.",
    "exists": "Already on the list.", "in_trash": "The clip is in the trash.", "not_in_trash": "The clip is not in the trash.",
    "managed_by_secret": "This person is set in the Space secrets.", "bad_request": "Bad request.",
    "server_error": "Something went wrong.",
}

_hits: "OrderedDict[tuple, list]" = OrderedDict()
_lock = threading.Lock()
_last_prune = 0.0


class ApiError(Exception):
    def __init__(self, status: int, code: str, extra: dict = None, headers: dict = None):
        self.status, self.code, self.extra, self.headers = status, code, extra or {}, headers or {}


def err(status: int, code: str, extra: dict = None, **headers) -> JSONResponse:
    body = {"error": code, "message": MESSAGES.get(code, "Error.")}
    body.update(extra or {})
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store", **headers})


def ok(body: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


def no_content() -> Response:
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


def now_iso(t: float = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if t is None else t))


# ---------------------------------------------------------------- config

def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def _config():
    """Config dict, or None if anything required is missing or invalid (fail closed)."""
    cfg = {"token": _env("VAULT_READ_TOKEN"), "dataset": _env("VAULT_DATASET") or "Soverellp/clip-vault",
           "secret": _env("SESSION_SECRET"), "client_id": _env("GOOGLE_CLIENT_ID")}
    if not all(cfg[k] for k in ("token", "secret", "client_id")):
        return None
    if len(cfg["secret"]) < MIN_SECRET or not DATASET_RE.fullmatch(cfg["dataset"]) or len(cfg["client_id"]) > 256:
        return None
    w = _env("VAULT_WRITE_TOKEN")
    cfg["write_token"] = w if w and w != cfg["token"] else ""  # equal tokens: refuse writes (fail closed)
    return cfg


def _parse_list(value: str) -> dict:
    """{lowercase email: set of pinned subs}. Empty set = bare email (any sub). `email:` with an empty sub is dropped."""
    out: dict = {}
    for entry in value.split(","):
        entry = entry.strip()
        if not entry:
            continue
        email, sep, sub = entry.partition(":")
        email, sub = email.strip().lower(), sub.strip()
        if not email or (sep and not sub):
            continue
        out.setdefault(email, set())
        if sub:
            out[email].add(sub)
    return out


def allowed_env() -> dict:
    return _parse_list(os.environ.get("ALLOWED_EMAILS", ""))


def admins_env() -> dict:
    return _parse_list(os.environ.get("ADMIN_EMAILS", ""))


def pin_ok(pins, sub) -> bool:
    if not pins:
        return True
    return isinstance(sub, str) and any(hmac.compare_digest(sub.encode(), p.encode()) for p in pins)


def _not_before() -> float:
    v = _env("SESSIONS_NOT_BEFORE")
    if not v:
        return 0.0
    try:
        f = float(v)
        return f if f == f else float("inf")
    except ValueError:
        return float("inf")


# ---------------------------------------------------------------- signed cookies

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(secret: str, kind: str, payload: dict) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    mac = hmac.new(secret.encode(), f"{kind}.{body}".encode(), hashlib.sha256).digest()
    return f"{body}.{_b64(mac)}"


def _unsign(secret: str, kind: str, value: str):
    try:
        body, mac = value.split(".", 1)
        want = hmac.new(secret.encode(), f"{kind}.{body}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(want, _unb64(mac)):
            return None
        data = json.loads(_unb64(body))
        if not isinstance(data, dict) or not isinstance(data.get("exp"), (int, float)) or data["exp"] < time.time():
            return None
        return data
    except Exception:
        return None


def _set_cookie(resp: Response, name: str, value: str, max_age: int):
    resp.set_cookie(name, value, max_age=max_age, path="/", httponly=True, secure=True, samesite="lax")


def _del_cookie(resp: Response, name: str):
    resp.delete_cookie(name, path="/", httponly=True, secure=True, samesite="lax")


def csrf_token(cfg, email: str, sub: str, iat) -> str:
    return hmac.new(cfg["secret"].encode(), f"csrf|{email}|{sub}|{iat}".encode(), hashlib.sha256).hexdigest()


def session_cookie_value(cfg, email, sub, name, picture, iat, ra, exp) -> str:
    return _sign(cfg["secret"], "session", {"u": email, "sub": sub, "nm": name, "pic": picture, "iat": iat, "ra": ra, "exp": exp})


def clean_name(v, email: str) -> str:
    if isinstance(v, str):
        v = "".join(ch for ch in v if ch.isprintable()).strip()[:100]
        if v:
            return v
    return email.split("@")[0][:100]


def clean_picture(v):
    return v if isinstance(v, str) and PICTURE_RE.fullmatch(v) else None


# ---------------------------------------------------------------- roles and sessions

def role_of(email, sub, users: list) -> tuple:
    """(role or None, root bool), computed from the CURRENT lists: env secrets plus users.json (managed in the site)."""
    if not isinstance(email, str):
        return None, False
    email = email.lower()
    a = admins_env().get(email)
    if a is not None and pin_ok(a, sub):
        return "admin", True
    v = allowed_env().get(email)
    for u in users or []:
        if u.get("email") == email:
            return (u["role"] if u.get("role") in ("viewer", "admin") else "viewer"), False
    if v is not None and pin_ok(v, sub):
        return "viewer", False
    return None, False


class Session:
    def __init__(self, email, sub, name, picture, role, root, iat, ra, csrf):
        self.email, self.sub, self.name, self.picture = email, sub, name, picture
        self.role, self.root, self.iat, self.ra, self.csrf = role, root, iat, ra, csrf

    @property
    def admin(self):
        return self.role == "admin"

    @property
    def age(self) -> int:
        return max(0, int(time.time() - self.ra))


def read_session(request: Request, cfg, users_loader):
    """A valid, not revoked Session whose user is STILL on a list right now (role recomputed), else None."""
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw or len(raw) > MAX_COOKIE:
        return None
    data = _unsign(cfg["secret"], "session", raw)
    if not data:
        return None
    iat, email, sub = data.get("iat"), data.get("u"), data.get("sub")
    if not isinstance(iat, (int, float)) or iat < _not_before() or iat > time.time() + 300:
        return None
    if not isinstance(email, str) or not isinstance(sub, str):
        return None
    role, root = role_of(email, sub, users_loader())
    if role is None:
        return None
    ra = data.get("ra")
    ra = ra if isinstance(ra, (int, float)) and iat <= ra <= time.time() + 300 else iat
    return Session(email, sub, clean_name(data.get("nm"), email), clean_picture(data.get("pic")), role, root, iat, ra,
                   csrf_token(cfg, email, sub, iat))


# ---------------------------------------------------------------- rate limiting

def _now() -> float:
    return time.monotonic()


def _limited(key: str, bucket: str) -> bool:
    global _last_prune
    limit, window = LIMITS[bucket]
    now = _now()
    k = (key, bucket)
    with _lock:
        if now - _last_prune >= RATE_WINDOW:  # sweep expired windows at most once per minute, not per request
            _last_prune = now
            for kk in [kk for kk, v in _hits.items() if now - v[0] >= v[2]]:
                del _hits[kk]
        win = _hits.get(k)
        if win is None or now - win[0] >= window:
            win = [now, 0, window]
        win[1] += 1
        _hits[k] = win
        _hits.move_to_end(k)
        while len(_hits) > RATE_MAX_KEYS:
            _hits.popitem(last=False)
        return win[1] > limit


def client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:  # the platform proxy appends the real peer last
        return xff.split(",")[-1].strip()[:64]
    return request.client.host if request.client else "?"


# ---------------------------------------------------------------- text cleaning

_BIDI = set(range(0x202A, 0x202F)) | set(range(0x2066, 0x206A)) | {0x200E, 0x200F, 0x061C, 0xFEFF}


def clean_text(s: str, multiline: bool) -> str:
    """Plain text only: control characters (and bidi overrides) removed; newlines/tabs kept only where multiline."""
    out = []
    for ch in s:
        o = ord(ch)
        if ch in "\n\t" and multiline:
            out.append(ch)
        elif ch == "\r":
            continue
        elif ch in "\n\t":
            out.append(" ")
        elif o < 32 or o == 127 or 0x80 <= o < 0xA0 or o in _BIDI or 0xD800 <= o <= 0xDFFF:
            continue
        else:
            out.append(ch)
    return "".join(out).strip()
