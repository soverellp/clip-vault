"""The ONLY module that holds the write token and the only one that mutates the private dataset.

VaultStore wraps huggingface_hub. Higher-level functions (load, normalize, transact) work on plain data so tests can swap
VaultStore for an in-memory fake. Errors raised from here carry fixed codes, never upstream text.
"""
import json
import re
import threading
import time
from datetime import datetime, timedelta, timezone

import common

INDEX_PATH = "index.json"
USERS_PATH = "users.json"
AUDIT_DIR = "_audit"
TOMBSTONES_PATH = "_config/tombstones.json"
MAX_TOMBSTONES = 5000
TRASH_DAYS = 30
SNAPSHOT_TTL = 5.0
MAX_RETRIES = 3
ID_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.\-]{0,199}")
VIDEO_RE = re.compile(r"clips/([A-Za-z0-9_.\-]{1,200})\.mp4")
UNSAFE = re.compile(r"[^A-Za-z0-9_.\-]")


class Conflict(Exception):
    """The dataset moved since the snapshot (parent_commit mismatch)."""


class StoreError(Exception):
    """Any other store failure. Fixed text only."""


class Changes:
    """What one commit does. All of it lands in ONE commit together with the audit line."""

    def __init__(self):
        self.index = None  # full new index dict, or None for unchanged
        self.users = None  # full new users dict, or None
        self.add_files = []  # [(path_in_repo, local_path)]
        self.copies = []  # [(src_path, dst_path)]
        self.deletes = []  # [path_in_repo]
        self.audit = []  # [dict]
        self.tombstones = []  # [{"id", "deleted_at", "sha256"}]: appended to _config/tombstones.json in the SAME commit
        self.message = "Update"


class Snapshot:
    def __init__(self, rev, index, users):
        self.rev, self.index, self.users = rev, index, users


# ---------------------------------------------------------------- data helpers (pure)

def iso(dt) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _s(v, n):
    return v[:n] if isinstance(v, str) else ""


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _iso_or_none(v):
    return v if isinstance(v, str) and parse_iso(v) else None


KNOWN_CLIP_KEYS = frozenset({"id", "stream", "title", "hook", "desc", "description", "post", "tags", "dur", "score", "size", "width", "height", "fps", "codec",
                             "bitrate", "sha256", "added_at", "updated_at", "video", "poster", "trashed_at", "purge_after"})


def normalize_clip(c):
    """A v1 or v2 record -> a v2 record, or None if unusable. id is always the stem of the video file name."""
    if not isinstance(c, dict):
        return None
    video = c.get("video")
    m = VIDEO_RE.fullmatch(video) if isinstance(video, str) else None
    if m:
        cid = m.group(1)
    else:
        raw = c.get("id")
        if not isinstance(raw, str) or not raw:
            return None
        cid = UNSAFE.sub("_", raw)[:200]
    if not ID_RE.fullmatch(cid) or ".." in cid:
        return None
    tags = c.get("tags")
    tags = [t[:40] for t in tags if isinstance(t, str) and t][:20] if isinstance(tags, list) else []
    known = {
        "id": cid, "stream": _s(c.get("stream"), 120), "title": _s(c.get("title"), 200) or cid, "hook": _s(c.get("hook"), 300),
        "desc": _s(c.get("desc", c.get("description")), 2000), "post": _s(c.get("post"), 20000), "tags": tags,
        "dur": _num(c.get("dur")), "score": _num(c.get("score")), "size": _num(c.get("size")),
        "width": _num(c.get("width")), "height": _num(c.get("height")), "fps": _num(c.get("fps")),
        "codec": c.get("codec") if isinstance(c.get("codec"), str) else None, "bitrate": _num(c.get("bitrate")),
        "sha256": c.get("sha256") if isinstance(c.get("sha256"), str) else None,
        "added_at": _iso_or_none(c.get("added_at")), "updated_at": _iso_or_none(c.get("updated_at")),
        "video": f"clips/{cid}.mp4", "poster": f"clips/{cid}.jpg" if c.get("poster") else None,
        "trashed_at": _iso_or_none(c.get("trashed_at")), "purge_after": _iso_or_none(c.get("purge_after")),
    }
    # Fields this code does not know (the Library data: group, variant, reaction, reaction_note, kind, tier, rank, why, ...) pass through
    # UNCHANGED, so a metadata edit, upload, trash, restore or delete never erases them (D39). Known fields above always win.
    extra = {k: v for k, v in c.items() if isinstance(k, str) and k not in KNOWN_CLIP_KEYS}
    return {**extra, **known}


def normalize_index(raw) -> dict:
    """Never crashes: v1 files ({clips:[...]} without version) load with null/default fields."""
    clips_raw = raw.get("clips") if isinstance(raw, dict) else raw if isinstance(raw, list) else []
    seen, clips = set(), []
    for c in clips_raw if isinstance(clips_raw, list) else []:
        n = normalize_clip(c)
        if n and n["id"] not in seen:
            seen.add(n["id"])
            clips.append(n)
    upd = raw.get("updated_at") if isinstance(raw, dict) else None
    # top-level keys we do not own (notably "streams", the Library folders) are carried through unchanged
    extra = {k: v for k, v in raw.items() if isinstance(k, str) and k not in ("version", "updated_at", "clips")} if isinstance(raw, dict) else {}
    return {**extra, "version": 2, "updated_at": _iso_or_none(upd), "clips": clips}


def normalize_users(raw) -> dict:
    out, seen = [], set()
    items = raw.get("users") if isinstance(raw, dict) else None
    for u in items if isinstance(items, list) else []:
        if not isinstance(u, dict):
            continue
        email = u.get("email")
        if not isinstance(email, str) or not common.EMAIL_RE.fullmatch(email.lower()) or email.lower() in seen:
            continue
        seen.add(email.lower())
        out.append({"email": email.lower(), "role": "admin" if u.get("role") == "admin" else "viewer",
                    "added_at": _iso_or_none(u.get("added_at")), "added_by": _s(u.get("added_by"), 254) or None})
    return {"version": 1, "updated_at": _iso_or_none(raw.get("updated_at")) if isinstance(raw, dict) else None, "users": out}


def trash_path(path: str) -> str:
    return "trash/" + path


def trash_clip(c: dict, now: datetime) -> list:
    """Mutates the record; returns (copies, deletes) for its files."""
    c["trashed_at"] = iso(now)
    c["purge_after"] = iso(now + timedelta(days=TRASH_DAYS))
    c["updated_at"] = iso(now)


def clip_files(c: dict) -> list:
    return [p for p in (c["video"], c["poster"]) if p]


def find(index: dict, cid: str):
    return next((c for c in index["clips"] if c["id"] == cid), None)


def expired(index: dict, now: datetime) -> list:
    out = []
    for c in index["clips"]:
        pa = parse_iso(c.get("purge_after"))
        if c.get("trashed_at") and pa and pa <= now:
            out.append(c)
    return out


def purge_changes(index: dict, victims: list, actor: str) -> Changes:
    ch = Changes()
    gone = {c["id"] for c in victims}
    for c in victims:
        ch.deletes += [trash_path(p) for p in clip_files(c)]
        ch.audit.append({"action": "purge", "clip_id": c["id"], "detail": {"title": c["title"]}})
        ch.tombstones.append({"id": c["id"], "deleted_at": iso(datetime.now(timezone.utc)), "sha256": c.get("sha256")})
    index = dict(index, clips=[c for c in index["clips"] if c["id"] not in gone])
    ch.index, ch.message = index, f"Purge {len(victims)} clip(s) from trash"
    return ch


# ---------------------------------------------------------------- the real store

class VaultStore:
    """huggingface_hub wrapper. Reads use the read token; commits use the write token (never leaves this class)."""

    def __init__(self, dataset: str, read_token: str, write_token: str = ""):
        self.dataset = dataset
        self._read = read_token
        self._write = write_token
        self._api = None

    @property
    def can_write(self) -> bool:
        return bool(self._write)

    def _hub(self):
        from huggingface_hub import HfApi
        if self._api is None:
            self._api = HfApi()
        return self._api

    def head(self) -> str:
        try:
            return self._hub().dataset_info(self.dataset, token=self._read, timeout=15).sha
        except Exception:
            raise StoreError("head") from None

    def read_json(self, path: str, rev: str):
        """Parsed JSON at a revision, or None when the file does not exist."""
        from huggingface_hub import hf_hub_download
        from huggingface_hub.errors import EntryNotFoundError
        try:
            p = hf_hub_download(self.dataset, path, repo_type="dataset", revision=rev, token=self._read)
            with open(p, "rb") as f:
                return json.loads(f.read())
        except EntryNotFoundError:
            return None
        except Exception:
            raise StoreError("read") from None

    def read_text(self, path: str, rev: str):
        from huggingface_hub import hf_hub_download
        from huggingface_hub.errors import EntryNotFoundError
        try:
            p = hf_hub_download(self.dataset, path, repo_type="dataset", revision=rev, token=self._read)
            with open(p, "r", encoding="utf-8") as f:
                return f.read()
        except EntryNotFoundError:
            return None
        except Exception:
            raise StoreError("read") from None

    def snapshot(self) -> Snapshot:
        rev = self.head()
        return Snapshot(rev, normalize_index(self.read_json(INDEX_PATH, rev) or {}), normalize_users(self.read_json(USERS_PATH, rev) or {}))

    def audit_tail(self, rev: str, limit: int = 100) -> list:
        now = datetime.now(timezone.utc)
        months = [now.strftime("%Y-%m"), (now.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")]
        lines = []
        for m in months:
            text = self.read_text(f"{AUDIT_DIR}/{m}.jsonl", rev)
            if text:
                lines = text.splitlines() + lines
            if len(lines) >= limit:
                break
        return parse_audit(lines, limit)

    def commit(self, rev: str, ch: Changes, month: str):
        """ONE commit: index/users/audit/file operations, only if the dataset head is still `rev`. Raises Conflict/StoreError."""
        from huggingface_hub import CommitOperationAdd, CommitOperationCopy, CommitOperationDelete
        from huggingface_hub.errors import HfHubHTTPError
        ops = []
        if ch.index is not None:
            ops.append(CommitOperationAdd(INDEX_PATH, json.dumps(ch.index, ensure_ascii=False, indent=1).encode()))
        if ch.users is not None:
            ops.append(CommitOperationAdd(USERS_PATH, json.dumps(ch.users, ensure_ascii=False, indent=1).encode()))
        for dst, local in ch.add_files:
            ops.append(CommitOperationAdd(dst, local))  # a path: huggingface_hub reads it from disk, not into RAM
        ops += [CommitOperationCopy(src, dst) for src, dst in ch.copies]
        ops += [CommitOperationDelete(p) for p in ch.deletes]
        if ch.audit:
            audit_path = f"{AUDIT_DIR}/{month}.jsonl"
            old = self.read_text(audit_path, rev) or ""
            new = old + "".join(json.dumps(a, ensure_ascii=False, separators=(",", ":")) + "\n" for a in ch.audit)
            ops.append(CommitOperationAdd(audit_path, new.encode()))
        if ch.tombstones:
            try:
                old_t = self.read_json(TOMBSTONES_PATH, rev)
            except StoreError:
                raise  # unreadable: never overwrite a list we could not read
            ops.append(CommitOperationAdd(TOMBSTONES_PATH, json.dumps(merge_tombstones(old_t, ch.tombstones), ensure_ascii=False, indent=1).encode()))
        try:
            self._hub().create_commit(self.dataset, ops, commit_message=ch.message[:200], repo_type="dataset",
                                      token=self._write, parent_commit=rev)
        except HfHubHTTPError as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (409, 412):
                raise Conflict() from None
            raise StoreError("commit") from None
        except Exception:
            raise StoreError("commit") from None


def merge_tombstones(old, new: list) -> dict:
    """Existing _config/tombstones.json content (any junk tolerated) + new entries -> {"version":1,"ids":[...]}, one entry per id
    (latest wins), bounded to the newest MAX_TOMBSTONES."""
    ids = old.get("ids") if isinstance(old, dict) else None
    by = {}
    for t in (ids if isinstance(ids, list) else []) + list(new):
        t = {"id": t} if isinstance(t, str) else t
        if isinstance(t, dict) and isinstance(t.get("id"), str) and t["id"]:
            by.pop(t["id"], None)
            by[t["id"]] = {"id": t["id"], "deleted_at": t.get("deleted_at"), "sha256": t.get("sha256")}
    return {"version": 1, "ids": list(by.values())[-MAX_TOMBSTONES:]}


def parse_audit(lines, limit=100) -> list:
    out = []
    for ln in lines:
        try:
            d = json.loads(ln)
        except ValueError:
            continue
        if isinstance(d, dict):
            out.append({k: d.get(k) for k in ("at", "actor_email", "action", "clip_id", "detail")})
    return out[-limit:][::-1]  # newest first


# ---------------------------------------------------------------- cached access and transactions

_lock = threading.Lock()
_store = None
_store_key = None
_cache = {"snap": None, "at": 0.0}


def reset():
    global _store, _store_key
    with _lock:
        _store, _store_key = None, None
        _cache.update(snap=None, at=0.0)


def invalidate():
    with _lock:
        _cache.update(snap=None, at=0.0)


def get_store(cfg) -> "VaultStore":
    global _store, _store_key
    key = (cfg["dataset"], cfg["token"], cfg["write_token"])
    with _lock:
        if _store is None or _store_key != key:
            _store, _store_key = VaultStore(cfg["dataset"], cfg["token"], cfg["write_token"]), key
            _cache.update(snap=None, at=0.0)
        return _store


def snapshot(cfg, fresh=False) -> Snapshot:
    st = get_store(cfg)
    with _lock:
        s, at = _cache["snap"], _cache["at"]
    if not fresh and s is not None and time.monotonic() - at < SNAPSHOT_TTL:
        return s
    s = st.snapshot()
    with _lock:
        _cache.update(snap=s, at=time.monotonic())
    return s


def users_or_empty(cfg) -> list:
    """Current users.json users; on a store failure, none (env lists alone decide: fail closed for added users)."""
    try:
        return snapshot(cfg).users["users"]
    except Exception:
        return []


def transact(cfg, actor: str, build):
    """Read a snapshot, let `build(snapshot) -> (Changes, result)` plan the change, commit it with parent_commit.

    Retries up to MAX_RETRIES times on Conflict, re-reading the snapshot each time. Audit lines get actor and time here.
    """
    st = get_store(cfg)
    if not st.can_write:
        raise common.ApiError(503, "read_only")
    for _ in range(MAX_RETRIES + 1):
        try:
            snap = snapshot(cfg, fresh=True)
            ch, result = build(snap)
            now = datetime.now(timezone.utc)
            for a in ch.audit:
                a["at"], a["actor_email"] = iso(now), actor
                a.setdefault("clip_id", None)
                a.setdefault("detail", {})
            if ch.index is not None:
                ch.index["updated_at"] = iso(now)
                ch.index["version"] = 2
            if ch.users is not None:
                ch.users["updated_at"] = iso(now)
            if not (ch.index or ch.users or ch.add_files or ch.copies or ch.deletes or ch.audit):
                return result
            st.commit(snap.rev, ch, now.strftime("%Y-%m"))
            invalidate()
            return result
        except Conflict:
            invalidate()
            continue
        except StoreError:
            invalidate()
            raise common.ApiError(502, "upstream_error") from None
    raise common.ApiError(409, "conflict")
