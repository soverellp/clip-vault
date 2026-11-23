#!/usr/bin/env python3
"""Fetch index.json the way the site does (GET .../resolve/main/index.json with the READ token) and check the Library fields (D39).

  python3 site/hfvault/check_index.py [--hf-dataset OWNER/NAME] [--dataset KAGGLE_USER/NAME] [--from-dir DIR]

The read token comes from the environment (VAULT_READ_TOKEN) or in memory from the credential file (with_vault_creds); it is only
sent as the Authorization header, never printed. Output: counts only. Exit 0 ok, 1 on a problem.
"""
import argparse, json, os, sys, urllib.request
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import with_vault_creds as wc  # noqa: E402


def main(argv=None):
    p = argparse.ArgumentParser(); p.add_argument("--hf-dataset", default="Soverellp/clip-vault")
    p.add_argument("--dataset", default=None); p.add_argument("--from-dir", default=None)
    a = p.parse_args(argv)
    tok = os.environ.get("VAULT_READ_TOKEN") or wc.load_credentials(a.dataset, a.from_dir)["values"].get("VAULT_READ_TOKEN")
    if not tok: sys.exit("error: no read token (env VAULT_READ_TOKEN or credential file key VAULT_READ_TOKEN)")
    base = f"https://huggingface.co/datasets/{a.hf_dataset}/resolve/main/"
    def get(path):
        r = urllib.request.Request(base + path, headers={"Authorization": "Bearer " + tok})
        with urllib.request.urlopen(r, timeout=60) as f: return f.status, f.read()
    st, body = get("index.json")
    idx = json.loads(body); clips, streams = idx.get("clips", []), idx.get("streams", [])
    bad = []
    for k in ("stream", "group", "variant", "reaction", "kind", "why", "clipped_at", "lang"):
        n = sum(1 for c in clips if c.get(k) not in (None, ""))
        print(f"clips with {k}: {n}/{len(clips)}")
        if n != len(clips) and k != "why": bad.append(k)
    pos = [c.get("posted_on") for c in clips if c.get("posted_on") is not None]  # optional field: old data without it stays valid
    print(f"clips with posted_on (optional): {len(pos)}/{len(clips)}")
    if any(not isinstance(v, list) or any(x not in ("youtube", "instagram", "tiktok", "x", "other") for x in v) for v in pos): bad.append("posted_on")
    print("reactions:", {r: sum(1 for c in clips if c.get("reaction") == r) for r in ("strong", "mild", "none", "unrated")})
    print("ranked:", sorted(c["rank"] for c in clips if c.get("rank") and c.get("variant") == "with-girl"))
    ids = {s["id"] for s in streams}
    for s in streams:
        code, img = get(s["thumb"]) if s.get("thumb") else (None, b"")
        print(f"stream {s['id']}: lang {s.get('lang')} ({s.get('lang_name')}), clipped_at {s.get('clipped_at')}, {s.get('clip_count')} clips, thumb {len(img) // 1000} KB (HTTP {code})")
        if not img.startswith(b"\xff\xd8"): bad.append("thumb " + s["id"])
    if any(c.get("stream") not in ids for c in clips): bad.append("clip stream not in streams[]")
    print("HTTP", st, "version", idx.get("version"), "streams", len(streams), "PROBLEMS: " + ", ".join(bad) if bad else "ok")
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
