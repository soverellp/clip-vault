#!/usr/bin/env python3
"""Sync the finished clips (streams/index.json + streams/<s>/clips/<id>/) into the PRIVATE dataset Soverellp/clip-vault.

One command, no wrapper prefix: the write token is loaded IN MEMORY by with_vault_creds.load_credentials (or taken from
the environment) and goes only into huggingface_hub's HfApi(token=...). It is never put into os.environ, argv, a file or a
child process, and every printed line and every exception text is masked. See site/hfvault/VAULT-SYNC.md.

  python3 site/hfvault/vault_sync.py [--stream SUBSTR] [--limit N]          dry run (default): table + the exact --yes command
  python3 site/hfvault/vault_sync.py [--stream SUBSTR] [--limit N] --yes    upload (<= 3 videos per commit), never deletes
  python3 site/hfvault/vault_sync.py --meta-only [--stream SUBSTR] [--yes]   Library metadata only (D39): merge the contract fields
      of streams/<s>/docs/vault_meta.json, the streams[] list and streams/<id>/thumb.jpg into the EXISTING remote index.json in ONE
      commit (parent revision), never touching title, desc, post, tags, trash state or admin-edited hook/stream; audit line; verify.

Options: --hf-dataset OWNER/NAME (default Soverellp/clip-vault)  --dataset USER/NAME (the KAGGLE credential dataset,
default arvr7plays/kagglegpu1)  --from-dir DIR (read the credential file from a folder, for tests)  --repo DIR (repo root).
Exit codes: 0 ok, 2 nothing to do, 1 error.
"""
import argparse, json, os, re, signal, sys, time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import with_vault_creds as wc  # noqa: E402

try:
    import build_hfvault as bh  # noqa: E402  (enrich_item, safe_id, PREFER, probe_video: one source of truth for index v2)
except ImportError as _e:  # build_hfvault needs `cryptography` at import time
    sys.exit("error: cannot import build_hfvault (" + type(_e).__name__ + "): pip install cryptography")

HF_DATASET = "Soverellp/clip-vault"
INDEX = "index.json"
TOMBSTONES = "_config/tombstones.json"
SHORTLIST = "_config/shortlist.json"  # owned by the site (admin mode); sync must never write, replace or delete it
AUDIT_DIR = "_audit"
MAX_VIDEOS_PER_COMMIT = 3
MAX_UNITS_PER_COMMIT = 12
RETRIES = 4                              # retries after the first attempt
BACKOFF = (2, 5, 15, 30)                 # seconds
FILE_FIELDS = ("sha256", "size", "dur", "width", "height", "fps", "codec", "bitrate", "updated_at")
ACTIONABLE = ("NEW", "CHANGED", "FIX")
sleep = time.sleep                       # tests replace it


class SyncError(Exception):
    """Fixed, human-readable failure. Always printed through the masker."""


class Conflict(Exception):
    pass


class Transient(Exception):
    pass


# ---------------------------------------------------------------- masking
class Mask:
    def __init__(self):
        self.forms = []

    def add(self, byte_forms):
        fs = {b.decode("utf-8", "replace") for b in byte_forms if b}
        self.forms = sorted(set(self.forms) | fs, key=len, reverse=True)

    def __call__(self, s):
        s = str(s)
        for f in self.forms:
            if f in s: s = s.replace(f, "***")
        return s


MASK = Mask()


class MaskedStream:
    """Wraps stdout/stderr for the whole run: a secret printed by any library is masked before it leaves."""
    def __init__(self, inner): self._inner = inner
    def write(self, s): return self._inner.write(MASK(s) if isinstance(s, str) else s)
    def writelines(self, lines): [self.write(x) for x in lines]
    def __getattr__(self, n): return getattr(self._inner, n)


def say(msg="", err=False):
    print(MASK(msg), file=sys.stderr if err else sys.stdout, flush=True)


def warn(msg): say("WARNING: " + msg, err=True)


def now_iso(): return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- credentials
def get_credentials(kaggle_dataset=None, from_dir=None, allow_account_token=False):
    """-> write token (str). Env first (VAULT_WRITE_TOKEN, then HF_Token) and no Kaggle download; else the credential file.
    Secrets are registered with the masker; nothing is exported."""
    env = os.environ
    write, read, scoped, source = env.get("VAULT_WRITE_TOKEN"), env.get("VAULT_READ_TOKEN"), True, "environment VAULT_WRITE_TOKEN"
    MASK.add(wc.collect_secrets({k: v for k, v in (("VAULT_WRITE_TOKEN", write), ("VAULT_READ_TOKEN", read)) if v}, set()))
    if not write:
        acct = env.get("HF_Token") or env.get("HF_TOKEN")
        if acct:
            write, scoped, source = acct, False, "environment HF_Token"
    if not write:
        c = wc.load_credentials(kaggle_dataset, from_dir)
        MASK.add(c["secrets"])
        vals = c["values"]
        read = read or vals.get("VAULT_READ_TOKEN")
        if vals.get("VAULT_WRITE_TOKEN"):
            write, source = vals["VAULT_WRITE_TOKEN"], "credential file key " + c["names"]["VAULT_WRITE_TOKEN"]
        elif vals.get("HF_Token"):
            write, scoped, source = vals["HF_Token"], False, "credential file key " + c["names"]["HF_Token"]
    if not write:
        raise SyncError("no write token found (env VAULT_WRITE_TOKEN / HF_Token, or file key VAULT_WRITE_TOKEN / Clip_vault_Write / HF_Token)")
    MASK.add(wc.collect_secrets({"VAULT_WRITE_TOKEN": write, **({"VAULT_READ_TOKEN": read} if read else {})}, set()))
    if not write.startswith("hf_"): raise SyncError("the write token does not look like an hf_ token")
    if read and read == write: raise SyncError("the write token equals the read token: create a separate dataset-scoped write token")
    if not scoped:
        if not allow_account_token:
            raise SyncError("refusing the account-wide HF_Token (" + source + "): create a dataset-scoped write token "
                            "(env VAULT_WRITE_TOKEN or file key VAULT_WRITE_TOKEN / Clip_vault_Write). To knowingly use the "
                            "account token anyway, pass --allow-account-token")
        warn("account-wide token allowed by --allow-account-token: create a dataset-scoped write token (file key VAULT_WRITE_TOKEN)")
    say(f"write token: {source}" + ("" if scoped else " (account-wide)"))
    return write


# ---------------------------------------------------------------- the hub (the only code that talks to huggingface_hub)
def retryable(e):
    if isinstance(e, (OSError, TimeoutError, ConnectionError)) or type(e).__module__.split(".")[0] in ("httpx", "httpx2", "requests", "urllib3"):
        st = getattr(getattr(e, "response", None), "status_code", None)
        return st is None or st in (408, 429) or st >= 500
    return False


def status_of(e): return getattr(getattr(e, "response", None), "status_code", None)


class Hub:
    def __init__(self, dataset, token):
        from huggingface_hub import HfApi
        self.dataset, self.token = dataset, token
        self.api = HfApi(token=token)

    def head(self):
        try: return self.api.dataset_info(self.dataset, timeout=30).sha
        except Exception as e:
            raise SyncError(f"cannot read dataset {self.dataset} ({type(e).__name__}: dataset missing, or the token has no access)") from e

    def read_text(self, path, rev):
        """Text of a file at a revision; None ONLY when the file does not exist. Anything else aborts the run."""
        from huggingface_hub import hf_hub_download
        from huggingface_hub.errors import EntryNotFoundError, LocalEntryNotFoundError
        try:
            p = hf_hub_download(self.dataset, path, repo_type="dataset", revision=rev, token=self.token)
        except LocalEntryNotFoundError as e:  # offline / cache miss: NOT proof that the file is absent
            raise SyncError(f"cannot read remote {path} ({type(e).__name__}); aborting before anything is written") from e
        except EntryNotFoundError:
            return None
        except Exception as e:
            raise SyncError(f"cannot read remote {path} ({type(e).__name__}); aborting before anything is written") from e
        return Path(p).read_text(encoding="utf-8")

    def sizes(self, rev):
        """{path: size} of every file in the dataset (names and sizes only)."""
        try:
            return {f.path: getattr(f, "size", None) for f in self.api.list_repo_tree(self.dataset, repo_type="dataset", recursive=True, revision=rev)
                    if hasattr(f, "size")}
        except Exception as e:
            raise SyncError(f"cannot list dataset files ({type(e).__name__})") from e

    def commit(self, rev, adds, texts, message):
        """adds: [(path_in_repo, local_path)], texts: [(path_in_repo, str)]. ONE commit, only if the head is still `rev`."""
        from huggingface_hub import CommitOperationAdd
        bad = [d for d, _ in list(adds) + list(texts) if d.startswith("_config/")]
        if bad: raise SyncError(f"refusing to write site-owned file {bad[0]} (the site owns _config/)")
        ops = [CommitOperationAdd(dst, str(local)) for dst, local in adds] + [CommitOperationAdd(dst, t.encode("utf-8")) for dst, t in texts]
        try:
            self.api.create_commit(self.dataset, ops, commit_message=message[:200], repo_type="dataset", parent_commit=rev)
        except Exception as e:
            st = status_of(e)
            if st in (409, 412): raise Conflict() from None
            if retryable(e): raise Transient(f"{type(e).__name__}") from e
            raise SyncError(f"commit refused ({type(e).__name__}, status {st})") from e


# ---------------------------------------------------------------- remote snapshot
class Snap:
    def __init__(self, rev, raw, clips, tomb, files):
        self.rev, self.raw, self.clips, self.tomb, self.files = rev, raw, clips, tomb, files
        self.by_id = {bh.safe_id(c["id"]): c for c in clips if isinstance(c, dict) and "id" in c}


def parse_remote_index(text):
    """v1 or v2 `{clips:[...]}` (or a bare list) -> (raw dict, clips list). Unreadable -> SyncError (never 'first upload')."""
    try:
        raw = json.loads(text)
        clips = raw["clips"] if isinstance(raw, dict) else raw
        if not isinstance(clips, list): raise ValueError
        return (raw if isinstance(raw, dict) else {"clips": clips}), [c for c in clips if isinstance(c, dict)]
    except Exception:
        raise SyncError("remote index.json is unreadable; aborting before anything is overwritten") from None


def parse_tombstones(text):
    if text is None: return set()
    try:
        ids = json.loads(text)["ids"]
        return {bh.safe_id(i["id"] if isinstance(i, dict) else i) for i in ids}
    except Exception:
        raise SyncError(f"remote {TOMBSTONES} is unreadable; aborting (deleted clips could come back)") from None


def take_snapshot(hub):
    rev = hub.head()
    txt = hub.read_text(INDEX, rev)
    raw, clips = ({"clips": []}, []) if txt is None else parse_remote_index(txt)  # None = first upload
    return Snap(rev, raw, clips, parse_tombstones(hub.read_text(TOMBSTONES, rev)), hub.sizes(rev))


# ---------------------------------------------------------------- local clips
class Local:
    def __init__(self, item, vid, poster):
        self.it, self.vid, self.poster = item, vid, poster
        self.id, self.stream, self.size = item["id"], item["stream"], item["size"]


def local_ids(repo, flt=""):
    """[(safe id, stream, clip dir, video path)] for every final clip with a video file; same file preference as build_hfvault."""
    try: idx = json.loads((repo / "streams/index.json").read_text())
    except Exception as e: raise SyncError(f"cannot read streams/index.json ({type(e).__name__})") from None
    out, seen = [], set()
    for c in idx.get("clips", []):
        if flt and flt not in c.get("stream", ""): continue
        d = repo / "streams" / c["stream"] / "clips" / c["id"]
        vid = next((d / p for p in bh.PREFER if (d / p).exists()), None)
        sid = bh.safe_id(c["id"])
        if not vid or sid in seen: continue
        seen.add(sid); out.append((sid, c, d, vid))
    return out


_META_CACHE = {}


def meta_for(repo, stream):
    """{clip id: contract fields} of a stream (cached per run); a bad vault_meta.json is a SyncError."""
    key = (str(repo), stream)
    if key not in _META_CACHE:
        try: _META_CACHE[key] = bh.load_vault_meta(repo, stream)
        except ValueError as e: raise SyncError(str(e)) from None
    return _META_CACHE[key]


def build_local(sid, c, d, vid, repo=None):
    it = {"id": sid, "stream": c["stream"], "title": c["title"], "hook": c.get("hook", ""), "desc": c.get("description", ""),
          "dur": c.get("duration"), "score": c.get("score"), "video": f"clips/{sid}.mp4", "size": vid.stat().st_size}
    poster = d / "poster.jpg" if (d / "poster.jpg").exists() else None
    if poster: it["poster"] = f"clips/{sid}.jpg"
    if (d / "post.md").exists(): it["post"] = (d / "post.md").read_text()
    bh.enrich_item(it, vid)
    if repo is not None: bh.apply_meta(it, meta_for(repo, c["stream"]).get(c["id"]))  # NEW entries carry the Library fields
    return Local(it, vid, poster)


# ---------------------------------------------------------------- classification and merge
def classify(lc, snap):
    """-> (action, reason). NEW / CHANGED / FIX / UNCHANGED / SKIP."""
    cid = lc.id
    if cid in snap.tomb: return "SKIP", "tombstoned (deleted forever in the site)"
    r = snap.by_id.get(cid)
    if r is not None and r.get("trashed_at"): return "SKIP", "in the site's trash"
    if r is None: return "NEW", "not in the remote index"
    vsize = snap.files.get(f"clips/{cid}.mp4")
    if vsize is None: return "CHANGED", "video file missing in the dataset"
    rsha = r.get("sha256")
    if rsha and rsha != lc.it["sha256"]: return "CHANGED", "sha256 differs"
    if vsize != lc.size: return "CHANGED", "remote file size differs"
    fixes = []
    if not rsha: fixes.append("sha256 backfill")
    if lc.poster and f"clips/{cid}.jpg" not in snap.files: fixes.append("poster missing")
    if fixes: return "FIX", ", ".join(fixes)
    return "UNCHANGED", "same sha256"


def merged_entry(lc, snap, action):
    if action == "NEW": return dict(lc.it)
    e = dict(snap.by_id[lc.id])  # admin-edited metadata (title, hook, desc, post, tags, stream, ...) stays exactly as it is
    if action == "CHANGED":
        for k in FILE_FIELDS:
            if lc.it.get(k) is not None: e[k] = lc.it[k]
    elif not e.get("sha256"): e["sha256"] = lc.it["sha256"]
    e["video"] = lc.it["video"]
    if lc.poster and not e.get("poster"): e["poster"] = lc.it["poster"]
    return e


def new_index(snap, entries):
    by = dict(snap.by_id)
    out, placed = [], set()
    for c in snap.clips:
        sid = bh.safe_id(c["id"]) if "id" in c else None
        out.append(entries.get(sid, c)); placed.add(sid)
    out += [e for sid, e in entries.items() if sid not in placed]
    out.sort(key=lambda x: x.get("stream") or "", reverse=True)
    doc = {k: v for k, v in snap.raw.items() if k != "clips"}
    doc.update({"version": 2, "updated_at": now_iso(), "clips": out})
    return doc


def table(rows):
    w = max([len(r[0]) for r in rows] + [2])
    ws = max([len(r[1]) for r in rows] + [6])
    say(f"{'id'.ljust(w)}  {'stream'.ljust(ws)}  {'MB':>7}  {'action':<9}  reason")
    for cid, stream, size, action, reason in rows:
        say(f"{cid.ljust(w)}  {stream.ljust(ws)}  {size / 1e6:7.1f}  {action:<9}  {reason}")


# ---------------------------------------------------------------- the sync
def batches(units):
    cur, vids = [], 0
    for lc, action, reason in units:
        v = 0 if action == "FIX" else 1
        if cur and (vids + v > MAX_VIDEOS_PER_COMMIT or len(cur) >= MAX_UNITS_PER_COMMIT):
            yield cur; cur, vids = [], 0
        cur.append((lc, action, reason)); vids += v
    if cur: yield cur


def commit_batch(hub, batch):
    """One commit for `batch`, re-planned against a FRESH snapshot on every attempt (a conflict or a retry after a
    half-seen success must not duplicate or resurrect anything). Returns the units that were really committed."""
    last = None
    for attempt in range(RETRIES + 1):
        try:
            snap = take_snapshot(hub)
            plan = []
            for lc, _, _ in batch:
                action, reason = classify(lc, snap)
                if action in ACTIONABLE: plan.append((lc, action, reason))
            if not plan: return []
            entries, adds, audit = {}, [], []
            at = now_iso()
            for lc, action, reason in plan:
                entries[lc.id] = merged_entry(lc, snap, action)
                if action != "FIX": adds.append((f"clips/{lc.id}.mp4", lc.vid))
                if lc.poster and (action != "FIX" or f"clips/{lc.id}.jpg" not in snap.files): adds.append((f"clips/{lc.id}.jpg", lc.poster))
                audit.append({"at": at, "actor": "vault_sync", "actor_email": "vault_sync", "action": "sync", "clip_id": lc.id,
                              "detail": {"kind": action, "reason": reason, "stream": lc.stream, "sha256": lc.it["sha256"], "size": lc.size}})
            apath = f"{AUDIT_DIR}/{at[:7]}.jsonl"
            old = hub.read_text(apath, snap.rev) or ""
            if old and not old.endswith("\n"): old += "\n"
            new_audit = old + "".join(json.dumps(a, ensure_ascii=False, separators=(",", ":")) + "\n" for a in audit)
            doc = json.dumps(new_index(snap, entries), ensure_ascii=False, indent=1)
            msg = "vault_sync: " + ", ".join(f"{a.lower()} {lc.id}" for lc, a, _ in plan)
            hub.commit(snap.rev, adds, [(INDEX, doc), (apath, new_audit)], msg)
            return plan
        except Conflict:
            last = "the dataset changed while uploading (conflict)"
        except Transient as e:
            last = f"network error ({e})"
        if attempt < RETRIES:
            say(f"  retry {attempt + 1}/{RETRIES} after: {last}")
            sleep(BACKOFF[min(attempt, len(BACKOFF) - 1)])
    raise SyncError(f"gave up after {RETRIES + 1} attempts: {last}")


def verify(hub, done):
    files = hub.sizes(hub.head())
    bad = []
    for lc in done:
        if files.get(f"clips/{lc.id}.mp4") != lc.size: bad.append(f"clips/{lc.id}.mp4")
        if lc.poster and files.get(f"clips/{lc.id}.jpg") != lc.poster.stat().st_size: bad.append(f"clips/{lc.id}.jpg")
    return bad


# ---------------------------------------------------------------- --meta-only (Library metadata, D39)
THUMB = "streams/{}/thumb.jpg"


class MetaPlan:
    def __init__(self):
        self.rows = []        # (clip id, [changed fields])
        self.entries = {}     # sid -> new remote entry (changed ones only)
        self.missing = []     # local clips with meta that are not in the remote index (a normal sync adds them)
        self.no_meta = 0
        self.thumbs = []      # (path in repo, local file)
        self.streams = None   # new streams[] (None = unchanged)
        self.stream_rows = []
        self.doc = None
        self.empty = True


def local_entries(repo, flt=""):
    """[(safe id, streams/index.json entry)] for every clip of streams/index.json (no video file needed: metadata only)."""
    try: idx = json.loads((repo / "streams/index.json").read_text())
    except Exception as e: raise SyncError(f"cannot read streams/index.json ({type(e).__name__})") from None
    out, seen = [], set()
    for c in idx.get("clips", []):
        if flt and flt not in c.get("stream", ""): continue
        sid = bh.safe_id(c["id"])
        if sid not in seen: seen.add(sid); out.append((sid, c))
    return out


def plan_meta(repo, snap, flt=""):
    """What --meta-only would change against `snap`. The contract fields come from vault_meta.json and always win (they are
    the pipeline's data), except `stream` and `hook` which admins edit in the site: those are only filled when empty. Titles,
    desc, post, tags, trash state, sha256 and files are never touched."""
    plan = MetaPlan()
    for sid, c in local_entries(repo, flt):
        meta = meta_for(repo, c["stream"]).get(c["id"])
        if meta is None: plan.no_meta += 1; continue
        r = snap.by_id.get(sid)
        if r is None: plan.missing.append(sid); continue
        new, changed = dict(r), []
        for k, v in meta.items():
            if k in bh.META_FILL_ONLY and r.get(k): continue
            if r.get(k) != v or k not in r: new[k] = v; changed.append(k)
        if changed: plan.entries[sid] = new; plan.rows.append((sid, changed))
    # streams[]: only streams that have at least one clip in the remote index
    used = {c.get("stream") for sid, c in local_entries(repo, flt) if sid in snap.by_id}
    recs = bh.stream_records(repo, used)
    for rec in recs:
        if not rec.get("thumb"): continue
        loc = repo / rec["thumb"]
        if snap.files.get(rec["thumb"]) != loc.stat().st_size: plan.thumbs.append((rec["thumb"], loc))
    clips = [plan.entries.get(bh.safe_id(c["id"]), c) if "id" in c else c for c in snap.clips]
    thumbs_ok = {r["id"] for r in recs if r.get("thumb") and (snap.files.get(r["thumb"]) is not None or any(t[0] == r["thumb"] for t in plan.thumbs))}
    streams = bh.merge_streams(snap.raw.get("streams") if isinstance(snap.raw.get("streams"), list) else [], recs, clips, thumbs_ok)
    if streams and streams != snap.raw.get("streams"):
        plan.streams = streams
        old = {s.get("id"): s for s in (snap.raw.get("streams") or []) if isinstance(s, dict)}
        for s in streams:
            o = old.get(s["id"])
            plan.stream_rows.append((s["id"], "NEW" if o is None else "UPDATE", [k for k in s if (o or {}).get(k) != s[k]]))
    plan.empty = not (plan.entries or plan.thumbs or plan.streams is not None)
    if not plan.empty:
        doc = {k: v for k, v in snap.raw.items() if k not in ("clips", "streams")}
        doc.update({"version": 2, "updated_at": now_iso(), "clips": clips})
        if plan.streams is not None: doc["streams"] = plan.streams
        elif "streams" in snap.raw: doc["streams"] = snap.raw["streams"]
        plan.doc = doc
    return plan


def show_meta_plan(plan, hf_dataset):
    if plan.rows:
        w = max(len(r[0]) for r in plan.rows)
        say(f"{'clip'.ljust(w)}  fields set or changed")
        for cid, ch in plan.rows: say(f"{cid.ljust(w)}  {', '.join(ch)}")
    for sid, kind, ch in plan.stream_rows: say(f"stream {sid}  {kind}  {', '.join(ch)}")
    for dst, loc in plan.thumbs: say(f"thumb  {dst}  {loc.stat().st_size / 1e3:.0f} KB  upload")
    if plan.missing: say(f"not in the vault yet ({len(plan.missing)}): left alone, a normal sync adds them: " + ", ".join(plan.missing[:5]) + (" ..." if len(plan.missing) > 5 else ""))
    if plan.no_meta: say(f"{plan.no_meta} local clip(s) have no entry in vault_meta.json: untouched")
    say(f"summary: {len(plan.rows)} clip entries, {len(plan.stream_rows)} stream entries, {len(plan.thumbs)} thumbnails; "
        f"title, desc, post, tags, trash state, files: untouched")


def commit_meta(hub, repo, flt):
    """ONE commit (index.json + thumbnails + audit line), parent = the revision read; re-planned against a fresh snapshot on every attempt."""
    last = None
    for attempt in range(RETRIES + 1):
        try:
            snap = take_snapshot(hub)
            plan = plan_meta(repo, snap, flt)
            if plan.empty: return None, snap
            at = now_iso()
            apath = f"{AUDIT_DIR}/{at[:7]}.jsonl"
            old = hub.read_text(apath, snap.rev) or ""
            if old and not old.endswith("\n"): old += "\n"
            line = {"at": at, "actor": "vault_sync", "actor_email": "vault_sync", "action": "meta", "clip_id": "",
                    "detail": {"clips": len(plan.rows), "streams": len(plan.stream_rows), "thumbs": [t[0] for t in plan.thumbs],
                               "fields": sorted({f for _, ch in plan.rows for f in ch})}}
            texts = [(INDEX, json.dumps(plan.doc, ensure_ascii=False, indent=1)),
                     (apath, old + json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n")]
            hub.commit(snap.rev, list(plan.thumbs), texts, f"vault_sync: library metadata for {len(plan.rows)} clip(s), {len(plan.stream_rows)} stream(s)")
            return plan, snap
        except Conflict: last = "the dataset changed while uploading (conflict)"
        except Transient as e: last = f"network error ({e})"
        if attempt < RETRIES:
            say(f"  retry {attempt + 1}/{RETRIES} after: {last}")
            sleep(BACKOFF[min(attempt, len(BACKOFF) - 1)])
    raise SyncError(f"gave up after {RETRIES + 1} attempts: {last}")


def verify_meta(hub, plan, before):
    """Read index.json back at the new head: every planned field is there, nothing else of any entry changed, streams[] and thumbs exist."""
    head = hub.head()
    txt = hub.read_text(INDEX, head)
    if txt is None: return ["index.json missing after the commit"]
    _, clips = parse_remote_index(txt)
    got = {bh.safe_id(c["id"]): c for c in clips if "id" in c}
    bad = []
    for sid, want in plan.entries.items():
        if got.get(sid) != want: bad.append(sid)
    for sid, c in before.by_id.items():
        if sid not in plan.entries and got.get(sid) != c: bad.append(sid + " (should be untouched)")
    if len(got) != len(before.by_id): bad.append("clip count changed")
    try: streams = json.loads(txt).get("streams")
    except Exception: streams = None
    if plan.streams is not None and streams != plan.streams: bad.append("streams[]")
    files = hub.sizes(head)
    bad += [dst for dst, loc in plan.thumbs if files.get(dst) != loc.stat().st_size]
    return bad


def run_meta(a, repo, hub):
    snap = take_snapshot(hub)
    say(f"remote {a.hf_dataset}: {len(snap.clips)} clips, {len(snap.tomb)} tombstones (meta-only)")
    if not snap.clips: raise SyncError("the remote index has no clips: --meta-only only enriches existing entries (run a normal sync first)")
    plan = plan_meta(repo, snap, a.stream)
    show_meta_plan(plan, a.hf_dataset)
    if plan.empty: say("nothing to do: the Library fields, streams list and thumbnails are already in the vault"); return 2
    if not a.yes:
        say("DRY RUN: nothing was written. Run:")
        say("  python3 site/hfvault/vault_sync.py --meta-only" + (f" --stream {a.stream}" if a.stream else "")
            + (f" --hf-dataset {a.hf_dataset}" if a.hf_dataset != HF_DATASET else "") + (" --allow-account-token" if a.allow_account_token else "") + " --yes")
        return 0
    done, before = commit_meta(hub, repo, a.stream)
    if done is None: say("nothing to commit any more (the dataset already has it)"); return 2
    say(f"committed: {len(done.rows)} clip entries, {len(done.stream_rows)} stream entries, {len(done.thumbs)} thumbnails, 1 audit line")
    bad = verify_meta(hub, done, before)
    if bad: raise SyncError("verify FAILED (read back from the dataset): " + ", ".join(bad[:5]))
    say(f"verify ok: index.json read back at the new revision matches the plan; other entries unchanged; {len(done.thumbs)} thumbnail(s) present")
    return 0


# ---------------------------------------------------------------- --refresh-text (post kits rewritten after upload)
TEXT_FIELDS = ("title", "hook", "desc", "post", "tags")


def local_text(repo, c, d):
    """The text fields of a local clip, derived like build_local does for NEW entries (streams/index.json title/hook/description,
    post.md, vault_meta hook when the index has none) plus the tags of clip.json post.youtube.tags. Empty values are left out:
    a field the local clip does not have is never blanked in the vault."""
    t = {"title": c.get("title"), "hook": c.get("hook") or (meta_for(repo, c["stream"]).get(c["id"]) or {}).get("hook"),
         "desc": c.get("description")}
    try: t["post"] = (d / "post.md").read_text()
    except OSError: pass
    try:
        tags = json.loads((d / "clip.json").read_text())["post"]["youtube"]["tags"]
        if isinstance(tags, list): t["tags"] = [str(x) for x in tags]
    except Exception: pass
    return {k: v for k, v in t.items() if v not in (None, "", [])}


def plan_text(repo, snap, flt="", ids=None):
    """-> (rows [(clip id, [fields that differ])], entries {sid: new remote entry}). Only existing, non-tombstoned, non-trashed
    remote entries that exist locally; only TEXT_FIELDS are overwritten, everything else of the entry stays byte-identical."""
    rows, entries = [], {}
    for sid, c in local_entries(repo, flt):
        if ids is not None and sid not in ids: continue
        r = snap.by_id.get(sid)
        if r is None or sid in snap.tomb or r.get("trashed_at"): continue
        d = repo / "streams" / c["stream"] / "clips" / c["id"]
        new, changed = dict(r), []
        for k, v in local_text(repo, c, d).items():
            if r.get(k) != v or k not in r: new[k] = v; changed.append(k)
        if changed: entries[sid] = new; rows.append((sid, changed))
    return rows, entries


def commit_text(hub, repo, flt, ids):
    """ONE commit (index.json + audit line 'refresh-text', field names only), re-planned against a fresh snapshot on every attempt."""
    last = None
    for attempt in range(RETRIES + 1):
        try:
            snap = take_snapshot(hub)
            rows, entries = plan_text(repo, snap, flt, ids)
            if not rows: return None, None, snap
            at = now_iso()
            apath = f"{AUDIT_DIR}/{at[:7]}.jsonl"
            old = hub.read_text(apath, snap.rev) or ""
            if old and not old.endswith("\n"): old += "\n"
            audit = "".join(json.dumps({"at": at, "actor": "vault_sync", "actor_email": "vault_sync", "action": "refresh-text", "clip_id": cid,
                                        "detail": {"fields": ch}}, ensure_ascii=False, separators=(",", ":")) + "\n" for cid, ch in rows)
            doc = json.dumps(new_index(snap, entries), ensure_ascii=False, indent=1)
            hub.commit(snap.rev, [], [(INDEX, doc), (apath, old + audit)], "vault_sync: refresh text of " + ", ".join(cid for cid, _ in rows))
            return rows, entries, snap
        except Conflict: last = "the dataset changed while uploading (conflict)"
        except Transient as e: last = f"network error ({e})"
        if attempt < RETRIES:
            say(f"  retry {attempt + 1}/{RETRIES} after: {last}")
            sleep(BACKOFF[min(attempt, len(BACKOFF) - 1)])
    raise SyncError(f"gave up after {RETRIES + 1} attempts: {last}")


def verify_text(hub, entries, before):
    txt = hub.read_text(INDEX, hub.head())
    if txt is None: return ["index.json missing after the commit"]
    got = {bh.safe_id(c["id"]): c for c in parse_remote_index(txt)[1] if "id" in c}
    bad = [sid for sid, want in entries.items() if got.get(sid) != want]
    bad += [sid + " (should be untouched)" for sid, c in before.by_id.items() if sid not in entries and got.get(sid) != c]
    if len(got) != len(before.by_id): bad.append("clip count changed")
    return bad


def run_text(a, repo, hub):
    """Returns 0 (done / dry run with changes) or 2 (nothing differs)."""
    ids = {bh.safe_id(x) for x in a.ids.split(",") if x.strip()} if a.ids else None
    snap = take_snapshot(hub)
    rows, _ = plan_text(repo, snap, a.stream, ids)
    if not rows: say("refresh-text: the vault text already matches the local clips"); return 2
    w = max(len(r[0]) for r in rows)
    say(f"{'clip'.ljust(w)}  text fields that differ (names only)")
    for cid, ch in rows: say(f"{cid.ljust(w)}  {', '.join(ch)}")
    if not a.yes:
        say(f"refresh-text DRY RUN: nothing was written. {len(rows)} clip(s). Add --yes to overwrite title, hook, desc, post, tags of these entries"); return 0
    rows, entries, before = commit_text(hub, repo, a.stream, ids)
    if rows is None: say("refresh-text: nothing to commit any more"); return 2
    say(f"refresh-text committed: {len(rows)} clip entries, 1 audit line")
    bad = verify_text(hub, entries, before)
    if bad: raise SyncError("verify FAILED (read back from the dataset): " + ", ".join(bad[:5]))
    say("verify ok: text read back matches; every other field and entry unchanged")
    return 0


def run(a):
    repo = Path(a.repo).resolve()
    token = get_credentials(a.dataset, a.from_dir, a.allow_account_token)
    hub = Hub(a.hf_dataset, token)
    if a.meta_only: return run_meta(a, repo, hub)
    rc = run_sync(a, repo, hub)
    if not a.refresh_text: return rc
    if rc == 1: return rc
    rt = run_text(a, repo, hub)
    return 0 if 0 in (rc, rt) else 2


def run_sync(a, repo, hub):
    snap = take_snapshot(hub)
    say(f"remote {a.hf_dataset}: {len(snap.clips)} clips, {len(snap.tomb)} tombstones" + ("" if snap.raw.get("clips") or snap.files else " (first upload)"))
    locs = local_ids(repo, a.stream)
    if not locs:
        say("no local clips with a video file" + (f" matching --stream {a.stream!r}" if a.stream else "")); return 2
    rows, units, counts = [], [], {}
    for sid, c, d, vid in locs:
        if sid in snap.tomb or (snap.by_id.get(sid) or {}).get("trashed_at"):  # skipped before hashing the file
            action, reason = classify(Local({"id": sid, "stream": c["stream"], "size": 0, "sha256": ""}, vid, None), snap)
            rows.append((sid, c["stream"], vid.stat().st_size, action, reason)); counts[action] = counts.get(action, 0) + 1; continue
        lc = build_local(sid, c, d, vid, repo)
        action, reason = classify(lc, snap)
        counts[action] = counts.get(action, 0) + 1
        if action in ACTIONABLE and a.limit is not None and len(units) >= a.limit:
            action, reason = "DEFERRED", "over --limit"
        rows.append((sid, c["stream"], lc.size, action, reason))
        if action in ACTIONABLE: units.append((lc, action, reason))
    show = [r for r in rows if r[3] != "UNCHANGED"]
    if show: table(show)
    say("summary: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    if not units:
        say("nothing to do: the vault already has every clip (or the ones left are skipped)"); return 2
    mb = sum(lc.size for lc, _, _ in units if _ != "FIX") / 1e6
    if not a.yes:
        cmd = "python3 site/hfvault/vault_sync.py" + (f" --stream {a.stream}" if a.stream else "") + (f" --limit {a.limit}" if a.limit is not None else "")
        cmd += (f" --hf-dataset {a.hf_dataset}" if a.hf_dataset != HF_DATASET else "") + (f" --dataset {a.dataset}" if a.dataset else "") + " --yes"
        say(f"DRY RUN: nothing was written. {len(units)} clip(s), about {mb:.0f} MB to upload. Run:")
        say("  " + cmd); return 0
    done, nb = [], 0
    for b in batches(units):
        nb += 1
        say(f"commit {nb}: " + ", ".join(f"{act} {lc.id}" for lc, act, _ in b))
        got = commit_batch(hub, b)
        done += [lc for lc, _, _ in got]
        say(f"  committed {len(got)} clip(s)" if got else "  already in the vault, nothing to commit")
    bad = verify(hub, done)
    if bad: raise SyncError("verify FAILED (missing or wrong size in the dataset): " + ", ".join(bad[:5]))
    say(f"verify ok: {len(done)} clip(s) present in {a.hf_dataset} with matching sizes (names and sizes only checked)")
    if done: say("next: python3 site/hfvault/vault_sync.py --meta-only  (streams list, thumbnails, Library fields; dry run first)")
    return 0 if done else 2


def parser():
    p = argparse.ArgumentParser(description="Sync final clips into the private clip-vault dataset (dry run unless --yes).")
    p.add_argument("--yes", action="store_true", help="really upload (default: dry run)")
    p.add_argument("--stream", default="", help="only streams whose folder name contains this text")
    p.add_argument("--limit", type=int, default=None, help="at most N clips to upload")
    p.add_argument("--hf-dataset", default=HF_DATASET)
    p.add_argument("--dataset", default=None, help="Kaggle credential dataset (default " + wc.DEFAULT_DATASET + ")")
    p.add_argument("--from-dir", default=None, help="read the credential file from this folder (tests)")
    p.add_argument("--meta-only", action="store_true",
                   help="only merge the Library metadata (vault_meta.json fields, streams[], thumbnails) into the existing remote index (dry run unless --yes)")
    p.add_argument("--refresh-text", action="store_true",
                   help="overwrite title, hook, desc, post, tags of EXISTING remote entries from the local clips (dry run unless --yes); nothing else changes")
    p.add_argument("--ids", default="", help="with --refresh-text: only these clip ids (comma separated)")
    p.add_argument("--allow-account-token", action="store_true",
                   help="knowingly accept the account-wide HF_Token when no dataset-scoped VAULT_WRITE_TOKEN exists (refused otherwise)")
    p.add_argument("--repo", default=str(HERE.parents[1]), help="repo root (tests)")
    return p


def main(argv=None):
    wc.install_signal_handlers()
    wc.sweep_stale()
    _META_CACHE.clear()
    MASK.forms = []
    MASK.add(wc.collect_secrets({}, set()))  # every secret-looking env value, before anything can fail
    old = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = MaskedStream(old[0]), MaskedStream(old[1])
    try:
        a = parser().parse_args(argv)
        if a.limit is not None and a.limit < 1: raise SyncError("--limit must be 1 or more")
        if a.meta_only and a.limit is not None: raise SyncError("--limit does not apply to --meta-only")
        if a.refresh_text and a.meta_only: raise SyncError("--refresh-text and --meta-only are separate runs")
        if a.ids and not a.refresh_text: raise SyncError("--ids only applies to --refresh-text")
        return run(a)
    except SystemExit as e:
        if e.code in (None, 0) or isinstance(e.code, int): return e.code or 0
        say("error: " + str(e.code), err=True); return 1
    except SyncError as e:
        say("error: " + str(e), err=True); return 1
    except KeyboardInterrupt:
        say("interrupted: committed batches stay; run again to continue", err=True); return 1
    except Exception as e:
        say(f"error: {type(e).__name__}: {str(e)[:300]}", err=True); return 1
    finally:
        sys.stdout, sys.stderr = old


if __name__ == "__main__":
    sys.exit(main())
