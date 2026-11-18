"""Shared fakes for the tests AND tests/ui_launcher.py: an in-memory VaultStore and a fake Google verifier.

Fake data only. The fake store mirrors the real one's contract: snapshot(), commit(rev, changes, month) that raises
Conflict when `rev` is stale, audit lines appended in the SAME commit, files kept as bytes by path.
"""
import hashlib
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import auth  # noqa: E402
import store  # noqa: E402

CLIENT_ID = "fake-client-id.apps.googleusercontent.com"
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"fake-video-bytes" * 8
JPG = b"\xff\xd8\xff\xe0" + b"fake-jpeg-bytes" * 8


class FakeState:
    """The 'remote' dataset. One per test; every FakeVaultStore points at it."""

    def __init__(self):
        self.files = {}  # path -> bytes
        self.rev_n = 0
        self.commits = []  # [{rev, ops summary, audit_lines}]
        self.before_commit = None  # hook(state) run right before a commit is checked (conflict simulation)
        self.fail_commit = False
        self.fail_reads = False
        self.big = {}  # dst -> (size, sha256) of every uploaded file
        self.add_reads = []  # sizes of local files read for uploads, chunk by chunk

    @property
    def rev(self):
        return f"rev{self.rev_n}"


def make_store_class(state: FakeState):
    class FakeVaultStore:
        instances = []

        def __init__(self, dataset, read_token, write_token=""):
            self.dataset, self.read_token, self.write_token = dataset, read_token, write_token
            FakeVaultStore.instances.append(self)

        @property
        def can_write(self):
            return bool(self.write_token)

        def snapshot(self):
            if state.fail_reads:
                raise store.StoreError("read")
            idx = json.loads(state.files["index.json"]) if "index.json" in state.files else {}
            users = json.loads(state.files["users.json"]) if "users.json" in state.files else {}
            return store.Snapshot(state.rev, store.normalize_index(idx), store.normalize_users(users))

        def audit_tail(self, rev, limit=100):
            lines = []
            for p in sorted(k for k in state.files if k.startswith("_audit/")):
                lines += state.files[p].decode().splitlines()
            return store.parse_audit(lines, limit)

        def commit(self, rev, ch, month):
            if state.before_commit:
                hook, state.before_commit = state.before_commit, None
                hook(state)
            if state.fail_commit:
                raise store.StoreError("commit")
            if rev != state.rev:
                raise store.Conflict()
            files = dict(state.files)
            if ch.index is not None:
                files["index.json"] = json.dumps(ch.index).encode()
            if ch.users is not None:
                files["users.json"] = json.dumps(ch.users).encode()
            for dst, local in ch.add_files:
                data, h, n = bytearray(), hashlib.sha256(), 0
                with open(local, "rb") as f:
                    while True:
                        b = f.read(65536)
                        if not b:
                            break
                        n += len(b)
                        h.update(b)
                        if n <= 1024 * 1024:  # large files are not kept in RAM by the fake either (only size and hash)
                            data += b
                        state.add_reads.append(len(b))
                state.big[dst] = (n, h.hexdigest())
                files[dst] = bytes(data) if n <= 1024 * 1024 else b"BIG-FILE-STUB"
            for src, dst in ch.copies:
                if src not in files:
                    raise store.StoreError("commit")
                files[dst] = files[src]
            for p in ch.deletes:
                if p not in files:
                    raise store.StoreError("commit")
                del files[p]
            if ch.tombstones:
                files["_config/tombstones.json"] = json.dumps(store.merge_tombstones(
                    json.loads(files["_config/tombstones.json"]) if "_config/tombstones.json" in files else None, ch.tombstones)).encode()
            if ch.audit:
                ap = f"_audit/{month}.jsonl"
                files[ap] = files.get(ap, b"") + b"".join(json.dumps(a, separators=(",", ":")).encode() + b"\n" for a in ch.audit)
            state.files = files
            state.rev_n += 1
            state.commits.append({"rev": state.rev, "message": ch.message, "audit": list(ch.audit), "paths": sorted(
                [d for d, _ in ch.add_files] + [d for _, d in ch.copies] + ch.deletes)})
    return FakeVaultStore


def clip(cid, title=None, trashed=False, **over):
    now = "2026-11-10T10:00:00Z"
    c = {"id": cid, "stream": "stream-a", "title": title or f"Title {cid}", "hook": "h", "desc": "d", "post": "p", "tags": ["x"],
         "dur": 45.0, "score": 8.5, "size": len(MP4), "width": 1080, "height": 1920, "fps": 30.0, "codec": "h264",
         "bitrate": 1000000, "sha256": f"sha-{cid}", "added_at": now, "updated_at": now, "video": f"clips/{cid}.mp4",
         "poster": f"clips/{cid}.jpg", "trashed_at": None, "purge_after": None}
    if trashed:
        c["trashed_at"], c["purge_after"] = "2026-11-12T10:00:00Z", "2026-12-12T10:00:00Z"
    c.update(over)
    return c


def seed(state: FakeState, clips, users=None):
    """Write an index (and the clip files at the right place: clips/ or trash/clips/) into the fake dataset."""
    state.files["index.json"] = json.dumps({"version": 2, "updated_at": "2026-11-12T10:00:00Z", "clips": clips}).encode()
    for c in clips:
        base = ("trash/" if c["trashed_at"] else "")
        state.files[base + c["video"]] = MP4
        if c["poster"]:
            state.files[base + c["poster"]] = JPG
    if users is not None:
        state.files["users.json"] = json.dumps({"version": 1, "users": users}).encode()
    state.rev_n += 1


def fake_fetch_factory(state: FakeState, log=None):
    def fake_fetch(cfg, path, rng):
        if log is not None:
            log.append((path, rng, cfg["token"]))
        if path not in state.files:
            return 404, {}, iter([b"nope"]), lambda: None
        data = state.files[path]
        if rng:
            a, _, b = rng[len("bytes="):].partition("-")
            start = int(a or 0)
            end = min(int(b) if b else len(data) - 1, len(data) - 1)
            chunk = data[start:end + 1]
            return 206, {"Content-Range": f"bytes {start}-{end}/{len(data)}", "Content-Length": str(len(chunk)),
                         "Accept-Ranges": "bytes"}, iter([chunk]), lambda: None
        return 200, {"Content-Length": str(len(data)), "Accept-Ranges": "bytes"}, iter([data]), lambda: None
    return fake_fetch


def fake_verify(credential, nonce):
    """Stands in for auth.verify_google_credential. credential = '<kind>:<email>:<sub>:<padding>'.

    kinds: ok | badnonce | badaud | unverified | badiss | expired | boom. The claims go through the REAL
    auth.check_claims, so wrong audience / nonce / issuer / expiry / unverified e-mail are rejected by production code.
    """
    parts = credential.split(":")
    kind, email, sub = parts[0], parts[1], (parts[2] if len(parts) > 2 else "")
    claims = {"aud": CLIENT_ID, "iss": "https://accounts.google.com", "exp": time.time() + 600, "email": email,
              "email_verified": True, "sub": sub or "sub-" + email.split("@")[0], "nonce": nonce,
              "name": email.split("@")[0].title(), "picture": "https://lh3.googleusercontent.com/a/fake"}
    if kind == "boom":
        raise auth.CredentialError("verify")
    if kind == "badnonce":
        claims["nonce"] = "someone-elses-nonce"
    elif kind == "badaud":
        claims["aud"] = "other-client.apps.googleusercontent.com"
    elif kind == "unverified":
        claims["email_verified"] = False
    elif kind == "badiss":
        claims["iss"] = "https://evil.example"
    elif kind == "expired":
        claims["exp"] = time.time() - 3600
    return auth.check_claims(claims, CLIENT_ID, nonce)


def cred(email, kind="ok", sub=""):
    # real Google credentials are long JWTs; the app rejects anything under 20 characters before verifying
    return f"{kind}:{email}:{sub}:" + "x" * 24
