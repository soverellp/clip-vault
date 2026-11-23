#!/usr/bin/env python3
"""Read-only: per stream id of the REMOTE vault index.json: clip_count, streams[] clipped_at/date, min/max clip clipped_at. Names and dates only.
Run: python3 site/hfvault/with_bw_creds.py -- python3 site/hfvault/show_stream_times.py"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vault_sync as vs
a = vs.parser().parse_args([])
creds = vs.get_credentials(allow_account_token=True)
tok = creds[0] if isinstance(creds, (tuple, list)) else creds
hub = vs.Hub(a.hf_dataset, tok)
rev = hub.head()
raw = json.loads(hub.read_text(vs.INDEX, rev))
meta = {s.get("id"): s for s in raw.get("streams") or [] if isinstance(s, dict)}
by = {}
for c in raw.get("clips", []):
    by.setdefault(c.get("stream", ""), []).append(str(c.get("clipped_at", "")))
for sid in sorted(set(by) | set(meta), key=lambda i: max(by.get(i, [""]))):
    ts = sorted(by.get(sid, [])); m = meta.get(sid, {})
    print(f"{sid[:48]:48} n={len(ts)} meta.clipped_at={m.get('clipped_at', '-')} date={m.get('date', '-')} min={ts[0] if ts else '-'} max={ts[-1] if ts else '-'}")
