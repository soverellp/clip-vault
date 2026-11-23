#!/usr/bin/env python3
"""Owner-approved purge of ALL clips of the given stream ids from the remote vault (dry run by default).
  python3 site/hfvault/with_bw_creds.py --only HF_Token -- python3 site/hfvault/purge_streams.py STREAM_ID [STREAM_ID ...] [--yes]
ONE atomic commit: delete clips/<id>.* + poster/thumb files of those clips, drop them from index.json, set clip_count 0 on the
streams[] entry, drop stale ids from _config/shortlist|playlists|templates.json, append an audit line. Never prints a token."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vault_sync as vs

def ids_in(o, ids):
    """True if the json value mentions one of ids (as string value)."""
    if isinstance(o, str): return o in ids
    if isinstance(o, list): return any(ids_in(x, ids) for x in o)
    if isinstance(o, dict): return any(ids_in(v, ids) for v in o.values()) or any(k in ids for k in o)
    return False

def scrub(o, ids):
    if isinstance(o, list): return [scrub(x, ids) for x in o if not (isinstance(x, str) and x in ids)]
    if isinstance(o, dict): return {k: scrub(v, ids) for k, v in o.items() if k not in ids}
    return o

def main():
    argv = sys.argv[1:]; yes = "--yes" in argv; streams = [x for x in argv if not x.startswith("--")]
    if not streams: sys.exit("usage: STREAM_ID... [--yes]")
    a = vs.parser().parse_args([])
    tok = vs.get_credentials(allow_account_token=True)
    hub = vs.Hub(a.hf_dataset, tok)
    rev = hub.head()
    raw = json.loads(hub.read_text(vs.INDEX, rev))
    clips = raw["clips"]
    gone = [c for c in clips if c.get("stream") in streams]
    ids = {c["id"] for c in gone}
    files = hub.sizes(rev)
    delete = sorted(p for p in files if any(p.startswith(f"clips/{i}.") or p.startswith(f"clips/{i}/") for i in ids))
    # every path mentioned by the entries themselves (video/poster/extras)
    for c in gone:
        for v in c.values():
            if isinstance(v, str) and v in files and v not in delete and v.startswith("clips/"): delete.append(v)
    delete += sorted(p for p in files if any(p.startswith(f"streams/{s}/") for s in streams) and p not in delete)
    per = {s: sum(1 for c in gone if c["stream"] == s) for s in streams}
    print("clips per stream:", per, "| total ids", len(ids), "| files to delete", len(delete), "| index clips", len(clips))
    print("sample ids:", sorted(ids)[:5]); print("sample files:", delete[:5])
    print("other-stream ids accidentally matched:", [c["id"] for c in gone if c.get("stream") not in streams])
    cfg = {}
    for n in ("shortlist", "playlists", "templates"):
        t = hub.read_text(f"_config/{n}.json", rev)
        if t is None: print(f"_config/{n}.json: absent"); continue
        j = json.loads(t); cfg[n] = j
        print(f"_config/{n}.json: refs={ids_in(j, ids)} type={type(j).__name__} size={len(t)}")
    st = [s for s in raw.get("streams") or [] if s.get("id") in streams]
    print("streams[] entries:", [(s["id"], s.get("clip_count")) for s in st])
    rest = {}
    for c in clips:
        if c.get("stream") not in streams: rest[c.get("stream")] = rest.get(c.get("stream"), 0) + 1
    print("remaining per stream:", rest)
    if not yes: print("DRY RUN (no --yes)"); return
    from huggingface_hub import CommitOperationAdd, CommitOperationDelete
    ops = [CommitOperationDelete(p) for p in delete]
    new = dict(raw); new["clips"] = [c for c in clips if c.get("stream") not in streams]
    new["streams"] = [s for s in raw.get("streams") or [] if s.get("id") not in streams]
    new["updated_at"] = vs.now_iso()
    ops.append(CommitOperationAdd(vs.INDEX, json.dumps(new, ensure_ascii=False, indent=1).encode()))
    for n, j in cfg.items():
        if ids_in(j, ids):
            ops.append(CommitOperationAdd(f"_config/{n}.json", json.dumps(scrub(j, ids), ensure_ascii=False, indent=1).encode()))
    at = vs.now_iso(); apath = f"{vs.AUDIT_DIR}/{at[:7]}.jsonl"
    old = hub.read_text(apath, rev) or ""
    if old and not old.endswith("\n"): old += "\n"
    line = {"at": at, "actor": "owner-request", "actor_email": "owner", "action": "purge_streams", "detail": {"streams": streams, "clips": len(ids), "files": len(delete)}}
    ops.append(CommitOperationAdd(apath, (old + json.dumps(line, separators=(",", ":")) + "\n").encode()))
    hub.api.create_commit(hub.dataset, ops, commit_message=f"purge clips of {len(streams)} streams (owner request)", repo_type="dataset", parent_commit=rev)
    print("COMMITTED")

if __name__ == "__main__":
    try: main()
    except vs.SyncError as e: sys.exit(vs.MASK(str(e)))
