#!/usr/bin/env python3
"""Build the private Hugging Face clip vault.

Clips live in a PRIVATE HF dataset. The page (public, ~15 KB, holds no clips) carries a
READ-ONLY, single-dataset HF token encrypted with a passphrase (PBKDF2-SHA256 600k + AES-256-GCM).
Friends type the passphrase; the browser decrypts the token in memory and fetches the clips.

Secrets come ONLY from environment variables and are never printed or written in clear:
  VAULT_READ_TOKEN   fine-grained, read-only, this dataset only (Clip_vault_HFToken)
  VAULT_PASSPHRASE   4+ DISTINCT random words, 20+ characters (see check_passphrase)
  HF_Token           write token, only needed with --upload (never goes into the page)

Usage: python3 site/hfvault/build_hfvault.py OUT_DIR OWNER/DATASET [--stream SUBSTR] [--upload]
OUT_DIR/page = index.html app.js style.css config.json   (publish anywhere public and static)
OUT_DIR/data = clips/*.mp4, clips/*.jpg, index.json (v2: version, sha256, added_at, width/height/fps/codec/bitrate, tags,
               trashed_at, purge_after; goes to the private dataset). With --upload, clips that already exist in the remote
               index keep their remote trash state and admin edits, and clips in the trash are not re-uploaded.
"""
import hashlib, json, math, os, re, secrets, shutil, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

ITER = 600_000
HERE = Path(__file__).parent
REPO = HERE.parents[1]
PREFER = ["youtube-shorts.mp4", "social.mp4", "clean.mp4", "instagram-reels.mp4", "facetop.mp4"]

def die(m): sys.exit("error: " + m)

COMMON_PHRASES = [
    "correct horse battery staple", "the quick brown fox", "quick brown fox jumps over the lazy dog",
    "to be or not to be", "never gonna give you up", "twinkle twinkle little star", "open sesame",
    "one two three four", "two three four five", "three four five six", "abc def ghi",
    "this is my password", "this is my passphrase", "my secret passphrase", "my secret password",
    "let me in please", "i love you", "happy birthday to you", "once upon a time", "lorem ipsum dolor sit",
]
BAD_WORDS = {"password", "passphrase", "qwerty", "letmein", "changeme"}

def wordlist_candidates():
    return [os.environ.get("VAULT_WORDLIST", ""), str(HERE / "wordlist.txt"),
            "/usr/share/dict/words", "/usr/share/dict/american-english"]

def passphrase_hint():
    """Text telling the user how to generate a passphrase. Never invents a wordlist: if none exists, says so."""
    for path in wordlist_candidates():
        if not path or not Path(path).is_file(): continue
        try: words = [w for w in (x.strip().lower() for x in Path(path).read_text(errors="ignore").splitlines()) if w.isalpha() and 4 <= len(w) <= 9]
        except Exception: continue
        if len(words) < 2000: continue  # too small to give real entropy
        bits = 6 * math.log2(len(words))
        return (f"Generate one (about {bits:.0f} bits from {len(words)} words in {path}):\n"
                f"  python3 -c \"import secrets;w=[x.strip().lower() for x in open('{path}') if x.strip().isalpha() and 4<=len(x.strip())<=9];"
                f"print(' '.join(secrets.choice(w) for _ in range(6)))\"")
    return ("No usable wordlist (2000+ words) was found on this machine, so no generator command is offered here. Get one "
            "(for example the EFF large wordlist, 7776 words, from eff.org), point VAULT_WORDLIST at it and pick 6 words with "
            "secrets.choice. Do not choose words by hand.")

def passphrase_problem(p):
    """Return a reason string, or None when the passphrase is acceptable."""
    p = (p or "").strip()
    words = [w for w in re.split(r"[\s\-_.]+", p.lower()) if w]
    if len(p) < 20: return "shorter than 20 characters"
    if len(set(words)) < 4: return "needs at least 4 DISTINCT words"
    if len(set(words)) != len(words): return "a word is repeated"
    if any(len(set(w)) == 1 and len(w) > 1 for w in words): return "contains an all-same-letter word"
    if any(w in BAD_WORDS for w in words): return "contains a very common password word"
    flat = " ".join(words)
    if any(ph in flat for ph in COMMON_PHRASES): return "contains a well-known phrase"
    return None

def check_passphrase(p):
    why = passphrase_problem(p)
    if why:
        print(passphrase_hint(), file=sys.stderr)
        die("VAULT_PASSPHRASE rejected: " + why + " (need 4+ distinct random words, 20+ characters, no repeats)")

MARKER = ".hfvault-build"

def prepare_out_dir(out):
    """Make OUT_DIR ready (empty or absent). rmtree only a directory this script built (marker file), never a parent of the repo or cwd."""
    out = Path(out)
    if out.is_symlink(): die(f"OUT_DIR {out} is a symlink: refusing")
    r = out.resolve()
    guards = [Path.cwd().resolve(), REPO.resolve(), HERE.resolve(), Path.home().resolve(), Path(r.anchor)]
    for g in guards:
        if r == g or r in g.parents:
            die(f"OUT_DIR {out} is (or contains) the current directory, the repo or a system folder: refusing to delete it")
    if r.exists():
        if not r.is_dir(): die(f"OUT_DIR {out} exists and is not a directory")
        if any(r.iterdir()):
            m = r / MARKER
            if not (m.is_file() and not m.is_symlink()):
                die(f"OUT_DIR {out} is not empty and has no {MARKER} marker (not built by this script): choose a new or empty folder")
            shutil.rmtree(r)
    return r

UNSAFE_ID = re.compile(r"[^A-Za-z0-9_.\-]")
# fields an admin may have edited in the site (or that the site owns): on a re-run the REMOTE value wins for ids that already exist
REMOTE_WINS = ("title", "hook", "desc", "post", "tags", "stream", "posted_by", "added_at", "trashed_at", "purge_after")

def safe_id(i):
    return UNSAFE_ID.sub("_", str(i))

def iso_utc(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""): h.update(chunk)
    return h.hexdigest()

def probe_video(path):
    """width/height/fps/codec/bitrate/dur from ffprobe; every value None when ffprobe is missing or fails."""
    out = dict(width=None, height=None, fps=None, codec=None, bitrate=None, dur=None)
    if not shutil.which("ffprobe"): return out
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
                           capture_output=True, timeout=60, check=False)
        info = json.loads(r.stdout or b"{}")
        v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
        if isinstance(v.get("width"), int): out["width"] = v["width"]
        if isinstance(v.get("height"), int): out["height"] = v["height"]
        a, _, b = str(v.get("avg_frame_rate") or v.get("r_frame_rate") or "").partition("/")
        try:
            if float(b or 1) and float(a): out["fps"] = round(float(a) / float(b or 1), 3)
        except ValueError: pass
        if isinstance(v.get("codec_name"), str): out["codec"] = v["codec_name"]
        try:
            br = float(v.get("bit_rate") or info.get("format", {}).get("bit_rate"))
            if br > 0: out["bitrate"] = int(br)
        except (TypeError, ValueError): pass
        try:
            d = float(info.get("format", {}).get("duration"))
            if d > 0: out["dur"] = round(d, 2)
        except (TypeError, ValueError): pass
    except Exception:
        pass
    return out

def enrich_item(it, vid, now=None):
    """Add the v2 fields to an index entry built from the source file `vid` (never overwrites the builder's own dur/score)."""
    st = Path(vid).stat()
    p = probe_video(vid)
    it["id"] = safe_id(it["id"])
    it.update({"tags": [], "sha256": file_sha256(vid), "size": st.st_size, "added_at": iso_utc(st.st_mtime),
               "updated_at": iso_utc(now if now is not None else st.st_mtime), "width": p["width"], "height": p["height"],
               "fps": p["fps"], "codec": p["codec"], "bitrate": p["bitrate"], "trashed_at": None, "purge_after": None})
    if it.get("dur") is None: it["dur"] = p["dur"]
    it.setdefault("poster", None); it.setdefault("post", ""); it.setdefault("desc", ""); it.setdefault("hook", "")
    return it

# ---------------------------------------------------------------- Library metadata (D39): streams[] + per-clip contract fields
REACTIONS = ("strong", "mild", "none", "unrated")
VARIANTS = ("with-streamer", "with-girl", "clean", "face-top")
TIERS = ("A", "B", "C")
KINDS = ("reaction", "game")
# every contract field a clip entry may carry (all optional; old clients ignore them)
META_FIELDS = ("stream", "group", "variant", "reaction", "reaction_note", "kind", "tier", "rank", "why", "hook", "clipped_at", "lang", "posted_by")
# edited in the site by admins (D39): vault_sync only FILLS these when the remote value is empty, never overwrites
META_FILL_ONLY = ("stream", "hook", "posted_by")
META_LIMITS = {"reaction_note": 80, "why": 110, "posted_by": 40}
STREAM_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,200}$")

def _one_line(s, limit=None):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if limit is None or len(s) <= limit else s[:limit - 1].rstrip() + "…"

def normalize_meta(raw, stream=None):
    """vault_meta.json entry -> the contract fields (only keys that are meaningful). Raises ValueError on a bad enum/rank."""
    if not isinstance(raw, dict): raise ValueError("meta entry is not an object")
    m = {}
    st = raw.get("stream") or stream
    if st: m["stream"] = str(st)
    if raw.get("group"): m["group"] = str(raw["group"])
    v = raw.get("variant")
    if v is not None:
        if v not in VARIANTS: raise ValueError(f"variant {v!r} not in {VARIANTS}")
        m["variant"] = v
    r = raw.get("reaction", "unrated")
    if r not in REACTIONS: raise ValueError(f"reaction {r!r} not in {REACTIONS}")
    m["reaction"] = r
    m["reaction_note"] = _one_line(raw.get("reaction_note"), META_LIMITS["reaction_note"])
    t = raw.get("tier")
    if t is not None and t not in TIERS: raise ValueError(f"tier {t!r} not in {TIERS} or null")
    m["tier"] = t
    k = raw.get("rank")
    if k is not None and (isinstance(k, bool) or not isinstance(k, int) or k < 1): raise ValueError(f"rank {k!r} must be an int >= 1 or null")
    m["rank"] = k
    kind = raw.get("kind")
    if kind is None: kind = "reaction" if r in ("strong", "mild") else "game"
    if kind not in KINDS: raise ValueError(f"kind {kind!r} not in {KINDS}")
    m["kind"] = kind
    m["why"] = _one_line(raw.get("why"), META_LIMITS["why"])
    if raw.get("hook"): m["hook"] = _one_line(raw["hook"])
    pb = raw.get("posted_by")  # optional free text (a person's name or the original uploader); absent/empty = Unassigned
    if pb is not None:
        if not isinstance(pb, str): raise ValueError(f"posted_by {pb!r} must be a string")
        pb = _one_line(pb)
        if len(pb) > META_LIMITS["posted_by"]: raise ValueError(f"posted_by is longer than {META_LIMITS['posted_by']} characters")
        if pb: m["posted_by"] = pb
    ca = raw.get("clipped_at")
    if ca is not None:
        if not isinstance(ca, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", ca): raise ValueError(f"clipped_at {ca!r} must be YYYY-MM-DDTHH:MM:SSZ (UTC)")
        m["clipped_at"] = ca
    lg = raw.get("lang")
    if lg is not None:
        if lg != "unknown" and not (isinstance(lg, str) and LANG_RE.match(lg)): raise ValueError(f"lang {lg!r} must be a short code like en, hi or 'unknown'")
        m["lang"] = lg
    return m

def load_vault_meta(repo, stream):
    """streams/<stream>/docs/vault_meta.json -> {clip folder id: normalized contract fields}. Missing file -> {}.
    Format: {"version": 1, "stream": "<id>", "clips": {"<clip id>": {group, variant, reaction, ...}}}. Bad file -> ValueError."""
    p = Path(repo) / "streams" / stream / "docs" / "vault_meta.json"
    if not p.exists(): return {}
    try: doc = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e: raise ValueError(f"{p.name} of {stream} is not valid JSON ({type(e).__name__})") from None
    clips = doc.get("clips") if isinstance(doc, dict) else None
    if not isinstance(clips, dict): raise ValueError(f"{p.name} of {stream}: top level needs a 'clips' object keyed by clip id")
    out = {}
    for cid, raw in clips.items():
        try: out[cid] = normalize_meta(raw, stream)
        except ValueError as e: raise ValueError(f"{p.name} of {stream}, clip {cid}: {e}") from None
    return out

def apply_meta(it, meta):
    """NEW entries only: copy the contract fields into the index entry (hook/stream only when the entry has none)."""
    for k, v in (meta or {}).items():
        if k in META_FILL_ONLY and it.get(k): continue
        it[k] = v
    return it

LANG_NAMES = {"en": "English", "hi": "Hindi", "es": "Spanish", "fr": "French", "de": "German", "pt": "Portuguese", "ar": "Arabic", "ja": "Japanese", "ko": "Korean", "ru": "Russian", "id": "Indonesian", "tr": "Turkish"}
LANG_RE = re.compile(r"^[a-z]{2,3}$")

def lang_of_stream(repo, sid, entry=None):
    """The stream's language code from streams/index.json, stream.json or docs/info.json ('language'); never guessed: 'unknown' when absent (D40)."""
    cands = [(entry or {}).get("language")]
    for rel in ("stream.json", "docs/info.json"):
        try: cands.append(json.loads((Path(repo) / "streams" / sid / rel).read_text(encoding="utf-8")).get("language"))
        except Exception: pass
    for v in cands:
        v = str(v or "").strip().lower().split("-")[0]
        if LANG_RE.match(v): return v
    return "unknown"

def stream_records(repo, wanted=None):
    """[{id,title,channel,date,lang,lang_name,url,thumb?}] from streams/index.json 'streams' (+ docs/info.json upload_date); thumb only when
    streams/<id>/thumb.jpg exists locally. clip_count is added by the caller from the final clip list."""
    try: idx = json.loads((Path(repo) / "streams/index.json").read_text(encoding="utf-8"))
    except Exception: return []
    out = []
    for s in idx.get("streams", []):
        sid = s.get("slug")
        if not sid or not STREAM_ID_RE.match(sid) or (wanted is not None and sid not in wanted): continue
        date = ""
        try:
            ud = str(json.loads((Path(repo) / "streams" / sid / "docs" / "info.json").read_text(encoding="utf-8")).get("upload_date") or "")
            if re.fullmatch(r"\d{8}", ud): date = f"{ud[:4]}-{ud[4:6]}-{ud[6:]}"
        except Exception: pass
        date = date or str(s.get("date_added") or "") or sid[:10]
        rec = {"id": sid, "title": str(s.get("title") or sid), "channel": str(s.get("channel") or ""), "date": date, "url": str(s.get("url") or "")}
        if (Path(repo) / "streams" / sid / "thumb.jpg").exists(): rec["thumb"] = f"streams/{sid}/thumb.jpg"
        lg = lang_of_stream(repo, sid, s)
        rec["lang"], rec["lang_name"] = lg, LANG_NAMES.get(lg, lg.upper() if lg != "unknown" else "Unknown")
        out.append(rec)
    return out

def merge_streams(remote, local, clips, thumbs_ok=None):
    """Remote streams[] merged with the local records: local fields win, remote-only streams are kept, clip_count is recomputed
    from `clips` (entries not in the trash). thumb: the local path when thumbs_ok (set of stream ids) says the file is in the
    dataset, else whatever the remote entry already had. Sorted newest clipped first (D40; old data: date)."""
    by = {s["id"]: dict(s) for s in (remote or []) if isinstance(s, dict) and s.get("id")}
    for rec in local:
        cur = by.get(rec["id"], {})
        cur.update({k: v for k, v in rec.items() if k != "thumb"})
        if rec.get("thumb") and (thumbs_ok is None or rec["id"] in thumbs_ok): cur["thumb"] = rec["thumb"]
        by[rec["id"]] = cur
    for sid, s in by.items():
        mine = [c for c in clips if c.get("stream") == sid and not c.get("trashed_at")]
        s["clip_count"] = len(mine)
        stamps = [c["clipped_at"] for c in mine if isinstance(c.get("clipped_at"), str) and c["clipped_at"]]
        if stamps: s["clipped_at"] = max(stamps)   # the stream's newest clip (D40)
    return sorted(by.values(), key=lambda s: (s.get("clipped_at") or s.get("date") or "", s.get("date") or "", s["id"]), reverse=True)

def index_doc(items, streams=None):
    doc = {"version": 2, "updated_at": iso_utc(datetime.now(timezone.utc).timestamp()), "clips": items}
    if streams: doc["streams"] = streams
    return doc

def upload_ignore_patterns(items):
    """Clips the site moved to the trash must not be re-uploaded to clips/ (that would resurrect their files)."""
    pats = []
    for c in items:
        if c.get("trashed_at"):
            pats += [f"clips/{safe_id(c['id'])}.mp4", f"clips/{safe_id(c['id'])}.jpg"]
    return pats

def merge_remote_index(ds, w, items, download=None, streams_out=None):
    """Merge with the index.json already in the dataset. Only 'repo/file not found' means first upload; any other error aborts."""
    from huggingface_hub.errors import EntryNotFoundError, LocalEntryNotFoundError, RepositoryNotFoundError
    if download is None:
        from huggingface_hub import hf_hub_download as download
    try:
        path = download(ds, "index.json", repo_type="dataset", token=w)
    except LocalEntryNotFoundError as e:  # subclass of EntryNotFoundError: offline/cache miss, NOT proof the file is absent
        die(f"cannot read the remote index.json ({type(e).__name__}); aborting before anything is overwritten")
    except (EntryNotFoundError, RepositoryNotFoundError):
        return items  # first upload: no remote index yet
    except Exception as e:
        die(f"cannot read the remote index.json ({type(e).__name__}); aborting before anything is overwritten")
    try:
        doc = json.loads(Path(path).read_text()); old = doc["clips"]
        if streams_out is not None and isinstance(doc.get("streams"), list): streams_out.extend(doc["streams"])
    except Exception as e:
        die(f"remote index.json is unreadable ({type(e).__name__}); aborting before anything is overwritten")
    remote = {safe_id(c["id"]): c for c in old if isinstance(c, dict) and "id" in c}
    for c in items:  # the site owns trash state and admin edits: keep the remote values for clips that already exist there
        r = remote.get(safe_id(c["id"]))
        if r:
            for k in REMOTE_WINS:
                if k in r and (r[k] is not None or k in ("trashed_at", "purge_after")): c[k] = r[k]
    have = {safe_id(c["id"]) for c in items}
    merged = items + [c for c in old if safe_id(c["id"]) not in have]
    merged.sort(key=lambda x: x["stream"], reverse=True)
    return merged

def main():
    a = sys.argv[1:]
    up = "--upload" in a
    flt = a[a.index("--stream") + 1] if "--stream" in a else ""
    pos = [x for i, x in enumerate(a) if not x.startswith("--") and (i == 0 or a[i-1] != "--stream")]
    if len(pos) != 2 or "/" not in pos[1]:
        die("usage: build_hfvault.py OUT_DIR OWNER/DATASET [--stream SUBSTR] [--upload]")
    out, ds = Path(pos[0]), pos[1]
    tok, pw = os.environ.get("VAULT_READ_TOKEN", ""), os.environ.get("VAULT_PASSPHRASE", "")
    if not tok.startswith("hf_"): die("VAULT_READ_TOKEN missing or not an hf_ token (set it in the environment)")
    check_passphrase(pw)
    if tok == os.environ.get("HF_Token"): die("VAULT_READ_TOKEN must differ from the write token HF_Token")
    out = prepare_out_dir(out)
    page, data = out / "page", out / "data"
    out.mkdir(parents=True, exist_ok=True); (out / MARKER).write_text("written by build_hfvault.py; safe to delete this folder\n")
    page.mkdir(parents=True); (data / "clips").mkdir(parents=True)
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = PBKDF2HMAC(hashes.SHA256(), 32, salt, ITER).derive(pw.encode())
    blob = AESGCM(key).encrypt(iv, tok.encode(), None)
    cfg = {"dataset": ds, "iter": ITER, "salt": salt.hex(), "iv": iv.hex(), "token": blob.hex()}
    (page / "config.json").write_text(json.dumps(cfg))
    for f in ("index.html", "app.js", "style.css"):
        shutil.copy2(HERE / f, page / f)
    (page / ".nojekyll").write_text("")
    idx = json.loads((REPO / "streams/index.json").read_text())
    items, total, metas = [], 0, {}
    for c in idx["clips"]:
        if flt and flt not in c["stream"]: continue
        d = REPO / "streams" / c["stream"] / "clips" / c["id"]
        vid = next((d / p for p in PREFER if (d / p).exists()), None)
        if not vid: continue
        safe = safe_id(c["id"])
        shutil.copy2(vid, data / "clips" / f"{safe}.mp4")
        it = {"id": safe, "stream": c["stream"], "title": c["title"], "hook": c.get("hook", ""),
              "desc": c.get("description", ""), "dur": c.get("duration"), "score": c.get("score"),
              "video": f"clips/{safe}.mp4", "size": vid.stat().st_size}
        if (d / "poster.jpg").exists():
            shutil.copy2(d / "poster.jpg", data / "clips" / f"{safe}.jpg"); it["poster"] = f"clips/{safe}.jpg"
        if (d / "post.md").exists(): it["post"] = (d / "post.md").read_text()
        enrich_item(it, vid)
        if c["stream"] not in metas:
            try: metas[c["stream"]] = load_vault_meta(REPO, c["stream"])
            except ValueError as e: die(str(e))
        apply_meta(it, metas[c["stream"]].get(c["id"]))
        total += it["size"]; items.append(it)
    items.sort(key=lambda x: x["stream"], reverse=True)
    local_streams = stream_records(REPO, {i["stream"] for i in items})
    for rec in local_streams:  # thumbnails go to the dataset as streams/<id>/thumb.jpg
        if rec.get("thumb"):
            (data / "streams" / rec["id"]).mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO / "streams" / rec["id"] / "thumb.jpg", data / rec["thumb"])
    (data / "index.json").write_text(json.dumps(index_doc(items, merge_streams([], local_streams, items)), ensure_ascii=False))
    print(f"ok: {len(items)} clips, {total/1e6:.0f} MB -> {out}/page and {out}/data (secrets not printed)")
    if up:
        w = os.environ.get("HF_Token", "")
        if not w: die("--upload needs HF_Token (write token) in the environment")
        from huggingface_hub import HfApi
        remote_streams = []
        items = merge_remote_index(ds, w, items, streams_out=remote_streams)  # keeps clips of other streams listed
        (data / "index.json").write_text(json.dumps(index_doc(items, merge_streams(remote_streams, local_streams, items)), ensure_ascii=False))
        HfApi(token=w).upload_folder(folder_path=str(data), repo_id=ds, repo_type="dataset", commit_message="Add clips",
                                     ignore_patterns=upload_ignore_patterns(items) or None)
        print(f"uploaded to private dataset {ds}")
if __name__ == "__main__":
    main()
