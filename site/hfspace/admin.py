"""Clip and user management endpoints (everything except the Google sign-in and the file proxy)."""
import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

import common
import store
from common import ApiError, ok

router = APIRouter()

MAX_VIDEO = 150 * 1024 * 1024
MAX_POSTER = 3 * 1024 * 1024
MULTIPART_OVERHEAD = 256 * 1024
MAX_JSON = 8 * 1024
MAX_PATCH_JSON = 160 * 1024
MAX_USERS = 200
UPLOAD_CHUNK = 64 * 1024
LIMITS_TEXT = {"title": 200, "hook": 300, "desc": 2000, "post": 20000, "stream": 120}
MULTILINE = {"desc", "post"}
EDITABLE = set(LIMITS_TEXT) | {"tags"}


# ---------------------------------------------------------------- guards

def current(request: Request):
    cfg = common._config()
    return common.read_session(request, cfg, lambda: store.users_or_empty(cfg))


def need_session(request: Request, admin=False, csrf=False, write=False, bucket=None):
    """Order: 401, CSRF 403, role 403, read-only 503, rate limit 429."""
    s = current(request)
    if s is None:
        raise ApiError(401, "unauthorized")
    if csrf:
        sent = request.headers.get("x-csrf-token", "")
        if not sent or len(sent) > 128 or not hmac.compare_digest(sent.encode(), s.csrf.encode()):
            raise ApiError(403, "forbidden")
    if admin and not s.admin:
        raise ApiError(403, "forbidden")
    if write and not store.get_store(common._config()).can_write:
        raise ApiError(503, "read_only")
    if bucket and common._limited(s.email, bucket):
        raise ApiError(429, "rate_limited", headers={"Retry-After": "60"})
    return s


def need_fresh(s):
    if s.age > common.REAUTH_WINDOW:
        raise ApiError(403, "reauth_required")


async def read_limited(request: Request, limit: int) -> bytes:
    """Body with a hard cap: refused from Content-Length BEFORE reading, and counted while streaming (chunked bodies)."""
    cl = request.headers.get("content-length")
    if cl is not None:
        if not cl.isdigit() or int(cl) > limit:
            raise ApiError(413, "too_large")
    buf, n = bytearray(), 0
    async for chunk in request.stream():
        n += len(chunk)
        if n > limit:
            raise ApiError(413, "too_large")
        buf += chunk
    return bytes(buf)


async def json_body(request: Request, limit: int = MAX_JSON, allow_empty=True) -> dict:
    ct = request.headers.get("content-type", "").split(";")[0].strip().lower()
    raw = await read_limited(request, limit)
    if not raw.strip():
        if allow_empty:
            return {}
        raise ApiError(422, "invalid")
    if ct != "application/json":
        raise ApiError(415, "unsupported_media_type")
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):
        raise ApiError(422, "invalid") from None
    if not isinstance(data, dict):
        raise ApiError(422, "invalid")
    return data


def valid_id(cid: str):
    if not store.ID_RE.fullmatch(cid) or ".." in cid:
        raise ApiError(404, "not_found")


def public_clip(c: dict, admin: bool) -> dict:
    d = dict(c)
    if not admin:
        d["trashed_at"] = d["purge_after"] = None
    return d


def invalid(field: str):
    return ApiError(422, "invalid", {"field": field})


# ---------------------------------------------------------------- clips: read

def maybe_purge(cfg, snap, actor="system"):
    """Best effort: purge expired trash. Never raises."""
    try:
        if not store.get_store(cfg).can_write:
            return snap
        if not store.expired(snap.index, datetime.now(timezone.utc)):
            return snap
        store.transact(cfg, actor, lambda s: (store.purge_changes(s.index, store.expired(s.index, datetime.now(timezone.utc)), actor), None))
        return store.snapshot(cfg)
    except Exception:
        print("trash purge skipped", flush=True)
        return snap


@router.get("/api/clips")
def list_clips(request: Request, trash: str = ""):
    s = need_session(request)
    cfg = common._config()
    want_trash = trash not in ("", "0")
    if want_trash and not s.admin:
        raise ApiError(403, "forbidden")
    try:
        snap = store.snapshot(cfg)
        if s.admin:
            snap = maybe_purge(cfg, snap, "system")
    except ApiError:
        raise
    except Exception:
        raise ApiError(502, "upstream_error") from None
    clips = snap.index["clips"]
    active = [c for c in clips if not c["trashed_at"]]
    trashed = [c for c in clips if c["trashed_at"]]
    shown = trashed if want_trash else active
    counts = {"active": len(active), "trash": len(trashed) if s.admin else 0}
    can_write = store.get_store(cfg).can_write
    return ok({"clips": [public_clip(c, s.admin) for c in shown], "counts": counts,
               "updated_at": snap.index.get("updated_at"), "can_write": can_write})


@router.get("/api/audit")
def audit(request: Request):
    need_session(request, admin=True)
    cfg = common._config()
    try:
        st = store.get_store(cfg)
        snap = store.snapshot(cfg)
        return ok({"entries": st.audit_tail(snap.rev, 100)})
    except Exception:
        raise ApiError(502, "upstream_error") from None


# ---------------------------------------------------------------- clips: edit

def clean_tags(v):
    if not isinstance(v, list) or len(v) > 20:
        raise invalid("tags")
    out = []
    for t in v:
        if not isinstance(t, str):
            raise invalid("tags")
        t = common.clean_text(t, False)
        if len(t) > 40:
            raise invalid("tags")
        if t and t not in out:
            out.append(t)
    return out


def clean_field(name: str, v):
    if not isinstance(v, str):
        raise invalid(name)
    v = common.clean_text(v, name in MULTILINE)
    if len(v) > LIMITS_TEXT[name]:
        raise invalid(name)
    return v


@router.patch("/api/clips/{cid}")
async def patch_clip(cid: str, request: Request):
    s = need_session(request, admin=True, csrf=True, write=True, bucket="admin_mut")
    valid_id(cid)
    data = await json_body(request, MAX_PATCH_JSON, allow_empty=False)
    if not data or set(data) - EDITABLE:
        raise ApiError(422, "invalid")
    new = {k: (clean_tags(v) if k == "tags" else clean_field(k, v)) for k, v in data.items()}
    if "title" in new and not new["title"]:
        raise invalid("title")
    cfg = common._config()

    def build(snap):
        c = store.find(snap.index, cid)
        if c is None:
            raise ApiError(404, "not_found")
        if c["trashed_at"]:
            raise ApiError(409, "in_trash")
        c.update(new)
        c["updated_at"] = store.iso(datetime.now(timezone.utc))
        ch = store.Changes()
        ch.index, ch.message = snap.index, "Edit clip metadata"
        ch.audit.append({"action": "edit", "clip_id": cid, "detail": {"fields": sorted(new)}})
        return ch, dict(c)
    clip = await run_in_threadpool(store.transact, cfg, s.email, build)
    return ok({"ok": True, "clip": clip})


# ---------------------------------------------------------------- clips: trash / restore / delete

def _move(cid, actor, to_trash: bool):
    cfg = common._config()

    def build(snap):
        c = store.find(snap.index, cid)
        if c is None:
            raise ApiError(404, "not_found")
        if to_trash and c["trashed_at"]:
            raise ApiError(409, "in_trash")
        if not to_trash and not c["trashed_at"]:
            raise ApiError(409, "not_in_trash")
        ch = store.Changes()
        for p in store.clip_files(c):
            src, dst = (p, store.trash_path(p)) if to_trash else (store.trash_path(p), p)
            ch.copies.append((src, dst))
            ch.deletes.append(src)
        now = datetime.now(timezone.utc)
        if to_trash:
            store.trash_clip(c, now)
        else:
            c["trashed_at"] = c["purge_after"] = None
            c["updated_at"] = store.iso(now)
        ch.index, ch.message = snap.index, ("Trash clip" if to_trash else "Restore clip")
        ch.audit.append({"action": "trash" if to_trash else "restore", "clip_id": cid, "detail": {}})
        return ch, dict(c)
    return store.transact(cfg, actor, build)


@router.post("/api/clips/{cid}/trash")
async def trash_clip(cid: str, request: Request):
    s = need_session(request, admin=True, csrf=True, write=True, bucket="admin_mut")
    valid_id(cid)
    await json_body(request)
    return ok({"ok": True, "clip": await run_in_threadpool(_move, cid, s.email, True)})


@router.post("/api/clips/{cid}/restore")
async def restore_clip(cid: str, request: Request):
    s = need_session(request, admin=True, csrf=True, write=True, bucket="admin_mut")
    valid_id(cid)
    await json_body(request)
    return ok({"ok": True, "clip": await run_in_threadpool(_move, cid, s.email, False)})


def _confirm_ok(given, expected: str) -> bool:
    return isinstance(given, str) and hmac.compare_digest(given.encode(), expected.encode())


@router.delete("/api/clips/{cid}")
async def delete_forever(cid: str, request: Request):
    s = need_session(request, admin=True, csrf=True, write=True, bucket="admin_mut")
    valid_id(cid)
    data = await json_body(request)
    need_fresh(s)
    cfg = common._config()

    def build(snap):
        c = store.find(snap.index, cid)
        if c is None:
            raise ApiError(404, "not_found")
        if not c["trashed_at"]:
            raise ApiError(409, "not_in_trash")
        if not _confirm_ok(data.get("confirm"), c["title"]):
            raise ApiError(400, "confirm_mismatch")
        ch = store.purge_changes(snap.index, [c], s.email)
        ch.audit = [{"action": "delete_forever", "clip_id": cid, "detail": {"title": c["title"]}}]
        ch.message = "Delete clip forever"
        return ch, None
    await run_in_threadpool(store.transact, cfg, s.email, build)
    return ok({"ok": True})


@router.post("/api/trash/empty")
async def empty_trash(request: Request):
    s = need_session(request, admin=True, csrf=True, write=True, bucket="admin_mut")
    data = await json_body(request)
    if not _confirm_ok(data.get("confirm"), "EMPTY TRASH"):
        raise ApiError(400, "confirm_mismatch")
    if "all" in data and not isinstance(data["all"], bool):
        raise invalid("all")
    need_fresh(s)
    cfg = common._config()

    def build(snap):
        now = datetime.now(timezone.utc)
        victims = [c for c in snap.index["clips"] if c["trashed_at"]] if data.get("all") else store.expired(snap.index, now)
        if not victims:
            return store.Changes(), 0
        ch = store.purge_changes(snap.index, victims, s.email)
        for a in ch.audit:
            a["action"] = "empty_trash"
        return ch, len(victims)
    n = await run_in_threadpool(store.transact, cfg, s.email, build)
    return ok({"ok": True, "purged": n})


# ---------------------------------------------------------------- clips: upload

class _Abort(Exception):
    pass


def probe(path: str) -> dict:
    """ffprobe metadata, all None when ffprobe is missing or the file is not parseable."""
    out = dict(dur=None, width=None, height=None, fps=None, codec=None, bitrate=None)
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path],
                           capture_output=True, timeout=30, check=False)
        info = json.loads(r.stdout or b"{}")
        v = next((x for x in info.get("streams", []) if x.get("codec_type") == "video"), {})
        fmt = info.get("format", {})

        def num(x):
            try:
                f = float(x)
                return f if f == f and f not in (float("inf"), float("-inf")) else None
            except (TypeError, ValueError):
                return None
        out["dur"] = num(fmt.get("duration")) or num(v.get("duration"))
        out["width"] = int(v["width"]) if isinstance(v.get("width"), int) else None
        out["height"] = int(v["height"]) if isinstance(v.get("height"), int) else None
        rate = str(v.get("avg_frame_rate") or v.get("r_frame_rate") or "")
        a, _, b = rate.partition("/")
        if num(a) and num(b or 1):
            out["fps"] = round(num(a) / num(b or 1), 3)
        out["codec"] = v.get("codec_name") if isinstance(v.get("codec_name"), str) else None
        br = num(v.get("bit_rate")) or num(fmt.get("bit_rate"))
        out["bitrate"] = int(br) if br else None
        if out["dur"]:
            out["dur"] = round(out["dur"], 2)
    except Exception:
        pass
    return out


def slug(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60].strip("-")
    return s or "clip"


async def parse_upload(request: Request, tmp: Path) -> dict:
    """Stream the multipart body: files go to disk in chunks (sha256 on the fly), never into memory."""
    from python_multipart.multipart import MultipartParser, parse_options_header
    ctype, opts = parse_options_header(request.headers.get("content-type", ""))
    if ctype != b"multipart/form-data" or not opts.get(b"boundary") or len(opts[b"boundary"]) > 200:
        raise ApiError(415, "unsupported_media_type")
    total_cap = MAX_VIDEO + MAX_POSTER + MULTIPART_OVERHEAD
    cl = request.headers.get("content-length")
    if cl is not None and (not cl.isdigit() or int(cl) > total_cap):
        raise ApiError(413, "too_large")
    st = {"hf": None, "hv": None, "name": None, "filename": None, "kind": None, "fh": None, "sha": None, "size": 0,
          "head": b"", "fields": {}, "buf": bytearray(), "nparts": 0}
    files = {}  # name -> {"path", "sha", "size"}

    def on_part_begin():
        st.update(hf=b"", hv=b"", name=None, filename=None, kind=None, fh=None, head=b"", size=0)
        st["buf"] = bytearray()
        st["nparts"] += 1
        if st["nparts"] > 12:
            raise _Abort("parts")

    def on_header_field(data, s, e):
        st["hf"] += data[s:e]

    def on_header_value(data, s, e):
        st["hv"] += data[s:e]

    def on_header_end():
        if st["hf"].lower() == b"content-disposition":
            _, p = parse_options_header(st["hv"])
            st["name"] = p.get(b"name", b"").decode("utf-8", "replace")
            st["filename"] = p.get(b"filename")
        st["hf"], st["hv"] = b"", b""

    def on_headers_finished():
        if st["filename"] is not None:
            if st["name"] not in ("video", "poster") or st["name"] in files:
                raise _Abort("file")
            st["kind"] = st["name"]
            st["fh"] = open(tmp / st["name"], "wb")
            st["sha"] = hashlib.sha256()
        elif st["name"] not in ("title", "hook", "desc", "post", "stream", "tags") or st["name"] in st["fields"]:
            raise _Abort("field")

    def on_part_data(data, s, e):
        chunk = data[s:e]
        if st["kind"]:
            cap = MAX_VIDEO if st["kind"] == "video" else MAX_POSTER
            st["size"] += len(chunk)
            if st["size"] > cap:
                raise ApiError(413, "too_large")
            if len(st["head"]) < 12:
                st["head"] += chunk[:12]
            st["fh"].write(chunk)
            st["sha"].update(chunk)
        else:
            st["buf"] += chunk
            if len(st["buf"]) > 64 * 1024:
                raise ApiError(413, "too_large")

    def on_part_end():
        if st["kind"]:
            st["fh"].close()
            files[st["kind"]] = {"path": str(tmp / st["kind"]), "sha": st["sha"].hexdigest(), "size": st["size"], "head": st["head"]}
            st["kind"], st["fh"] = None, None
        elif st["name"]:
            st["fields"][st["name"]] = bytes(st["buf"]).decode("utf-8", "replace")

    parser = MultipartParser(opts[b"boundary"], {
        "on_part_begin": on_part_begin, "on_header_field": on_header_field, "on_header_value": on_header_value,
        "on_header_end": on_header_end, "on_headers_finished": on_headers_finished, "on_part_data": on_part_data,
        "on_part_end": on_part_end}, max_size=total_cap)
    n = 0
    try:
        async for chunk in request.stream():
            n += len(chunk)
            if n > total_cap:
                raise ApiError(413, "too_large")
            parser.write(chunk)
        parser.finalize()
    except ApiError:
        raise
    except _Abort:
        raise ApiError(422, "invalid") from None
    except Exception:
        raise ApiError(422, "invalid") from None
    finally:
        if st["fh"]:
            st["fh"].close()
    return {"files": files, "fields": st["fields"]}


@router.post("/api/clips")
async def upload_clip(request: Request):
    s = need_session(request, admin=True, csrf=True, write=True, bucket="admin_mut")
    if common._limited(s.email, "upload"):
        raise ApiError(429, "rate_limited", headers={"Retry-After": "60"})
    tmp = Path(tempfile.mkdtemp(prefix="cv-upload-"))
    try:
        got = await parse_upload(request, tmp)
        files, fields = got["files"], got["fields"]
        vid, post = files.get("video"), files.get("poster")
        if not vid or vid["size"] == 0 or vid["head"][4:8] != b"ftyp":
            raise invalid("video")
        if post and (post["size"] == 0 or post["head"][:3] != b"\xff\xd8\xff"):
            raise invalid("poster")
        meta = {k: clean_field(k, fields.get(k, "")) for k in LIMITS_TEXT}
        if not meta["title"]:
            raise invalid("title")
        tags = clean_tags([t for t in fields.get("tags", "").split(",") if t.strip()]) if len(fields.get("tags", "")) <= 2000 else None
        if tags is None:
            raise invalid("tags")
        info = await run_in_threadpool(probe, vid["path"])
        cfg = common._config()
        now = datetime.now(timezone.utc)

        def build(snap):
            for c in snap.index["clips"]:
                if c["sha256"] and c["sha256"] == vid["sha"]:
                    raise ApiError(409, "duplicate", {"clip_id": c["id"]})
            ids = {c["id"] for c in snap.index["clips"]}
            cid = f"{slug(meta['title'])}-{now.strftime('%Y%m%d-%H%M%S')}"
            while cid in ids:
                cid = f"{slug(meta['title'])}-{now.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}"
            clip = {"id": cid, **meta, "tags": tags, "dur": info["dur"], "score": None, "size": vid["size"],
                    "width": info["width"], "height": info["height"], "fps": info["fps"], "codec": info["codec"],
                    "bitrate": info["bitrate"], "sha256": vid["sha"], "added_at": store.iso(now), "updated_at": store.iso(now),
                    "video": f"clips/{cid}.mp4", "poster": f"clips/{cid}.jpg" if post else None,
                    "trashed_at": None, "purge_after": None}
            ch = store.Changes()
            ch.add_files.append((clip["video"], vid["path"]))
            if post:
                ch.add_files.append((clip["poster"], post["path"]))
            ch.index = dict(snap.index, clips=[clip] + snap.index["clips"])
            ch.message = "Upload clip"
            ch.audit.append({"action": "upload", "clip_id": cid, "detail": {"sha256": vid["sha"], "size": vid["size"]}})
            return ch, clip
        clip = await run_in_threadpool(store.transact, cfg, s.email, build)
        return ok({"ok": True, "clip": clip}, 201)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- users (who may sign in)

def _users_view(users: list) -> dict:
    admins, viewers = common.admins_env(), common.allowed_env()
    out, seen = [], set()
    for e in sorted(admins):
        out.append({"email": e, "role": "admin", "root": True, "source": "secret", "added_at": None, "added_by": None})
        seen.add(e)
    for u in users:
        if u["email"] in seen:
            continue
        seen.add(u["email"])
        out.append({"email": u["email"], "role": u["role"], "root": False, "source": "site",
                    "added_at": u["added_at"], "added_by": u["added_by"]})
    for e in sorted(viewers):
        if e not in seen:
            out.append({"email": e, "role": "viewer", "root": True, "source": "secret", "added_at": None, "added_by": None})
    return {"users": out, "root_admins": sorted(admins)}


@router.get("/api/users")
def list_users(request: Request):
    need_session(request, admin=True)
    cfg = common._config()
    try:
        users = store.snapshot(cfg).users["users"]
    except Exception:
        raise ApiError(502, "upstream_error") from None
    return ok(_users_view(users))


def _email(v) -> str:
    if not isinstance(v, str):
        raise invalid("email")
    v = v.strip().lower()
    if len(v) > 254 or not common.EMAIL_RE.fullmatch(v):
        raise invalid("email")
    return v


def _role(v) -> str:
    if v not in ("viewer", "admin"):
        raise invalid("role")
    return v


def _guard_target(s, email):
    if email == s.email:
        raise ApiError(403, "self")
    if common.admins_env().get(email) is not None:
        raise ApiError(403, "root_admin")


def _site_user_missing(email):
    return ApiError(403, "managed_by_secret") if email in common.allowed_env() else ApiError(404, "not_found")


@router.post("/api/users")
async def add_user(request: Request):
    s = need_session(request, admin=True, csrf=True, write=True, bucket="admin_mut")
    data = await json_body(request, allow_empty=False)
    if set(data) - {"email", "role"}:
        raise ApiError(422, "invalid")
    email, role = _email(data.get("email")), _role(data.get("role"))
    need_fresh(s)
    cfg = common._config()

    def build(snap):
        if email in common.admins_env() or email in common.allowed_env() or any(u["email"] == email for u in snap.users["users"]):
            raise ApiError(409, "exists")
        if len(snap.users["users"]) >= MAX_USERS:
            raise invalid("email")
        u = {"email": email, "role": role, "added_at": store.iso(datetime.now(timezone.utc)), "added_by": s.email}
        ch = store.Changes()
        ch.users = dict(snap.users, users=snap.users["users"] + [u])
        ch.message = "Add user"
        ch.audit.append({"action": "user_add", "clip_id": None, "detail": {"email": email, "role": role}})
        return ch, u
    u = await run_in_threadpool(store.transact, cfg, s.email, build)
    return ok({"ok": True, "user": dict(u, root=False, source="site")}, 201)


@router.patch("/api/users/{email}")
async def change_user(email: str, request: Request):
    s = need_session(request, admin=True, csrf=True, write=True, bucket="admin_mut")
    email = _email(email)
    data = await json_body(request, allow_empty=False)
    if set(data) != {"role"}:
        raise ApiError(422, "invalid")
    role = _role(data["role"])
    _guard_target(s, email)
    need_fresh(s)
    cfg = common._config()

    def build(snap):
        users = [dict(u) for u in snap.users["users"]]
        u = next((x for x in users if x["email"] == email), None)
        if u is None:
            raise _site_user_missing(email)
        before, u["role"] = u["role"], role
        ch = store.Changes()
        ch.users = dict(snap.users, users=users)
        ch.message = "Change user role"
        ch.audit.append({"action": "user_role", "clip_id": None, "detail": {"email": email, "from": before, "to": role}})
        return ch, u
    u = await run_in_threadpool(store.transact, cfg, s.email, build)
    return ok({"ok": True, "user": dict(u, root=False, source="site")})


@router.delete("/api/users/{email}")
async def remove_user(email: str, request: Request):
    s = need_session(request, admin=True, csrf=True, write=True, bucket="admin_mut")
    email = _email(email)
    data = await json_body(request, allow_empty=False)
    _guard_target(s, email)
    if not _confirm_ok(data.get("confirm"), email):
        raise ApiError(400, "confirm_mismatch")
    need_fresh(s)
    cfg = common._config()

    def build(snap):
        users = [u for u in snap.users["users"] if u["email"] != email]
        if len(users) == len(snap.users["users"]):
            raise _site_user_missing(email)
        ch = store.Changes()
        ch.users = dict(snap.users, users=users)
        ch.message = "Remove user"
        ch.audit.append({"action": "user_remove", "clip_id": None, "detail": {"email": email}})
        return ch, None
    await run_in_threadpool(store.transact, cfg, s.email, build)
    return ok({"ok": True})
