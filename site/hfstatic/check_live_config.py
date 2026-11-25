#!/usr/bin/env python3
"""Does VAULT_PASSPHRASE unlock the LIVE site config.json (and give VAULT_READ_TOKEN)? Prints ok/FAIL only, never a value.
Run: python3 site/hfvault/with_bw_creds.py -- python3 site/hfstatic/check_live_config.py
--features: NO keys needed (public GET). Compares the LIVE js files listed in required_features.json with dist/ (md5 + count of
the markers, e.g. 'teaser'); one line per file; exit 1 on mismatch. Run it after every vault sync with -teaser clips and every deploy:
  python3 site/hfstatic/check_live_config.py --features   (live page must show the four toggles)"""
import hashlib, json, os, sys, time, urllib.request
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
LIVE_BASE = os.environ.get("LIVE_BASE_URL", "https://soverellp-clip-vault-site.static.hf.space")
FEATURES = HERE / "required_features.json"


def required(path=FEATURES):
    j = json.loads(Path(path).read_text())
    return {k: v for k, v in j.items() if not k.startswith("_")}


def missing_markers(dist, req=None):
    """-> list of 'file lacks marker' strings for the files in dist (empty = all required markers present)."""
    out = []
    for f, marks in (req or required()).items():
        p = Path(dist) / f
        txt = p.read_text(errors="ignore") if p.is_file() else ""
        out += [f"{f} lacks '{m}'" for m in marks if m not in txt]
    return out


def fetch_live(path, base=None, fetch=None):
    """Public GET of a live file (cache-busted). Returns bytes or None."""
    url = f"{(base or LIVE_BASE).rstrip('/')}/{path}?_={int(time.time())}"
    try:
        if fetch:
            return fetch(url)
        return urllib.request.urlopen(urllib.request.Request(url, headers={"Cache-Control": "no-cache"}), timeout=30).read()
    except Exception:
        return None


def compare_features(dist, base=None, fetch=None, req=None):
    """-> (ok, lines). One line per file: live md5, repo md5, teaser count live; MISMATCH when md5 differs or a marker is missing live."""
    ok, lines = True, []
    for f, marks in (req or required()).items():
        p = Path(dist) / f
        repo = p.read_bytes() if p.is_file() else b""
        live = fetch_live(f, base, fetch)
        rmd = hashlib.md5(repo).hexdigest()
        if live is None:
            ok = False; lines.append(f"MISMATCH {f}: live file not fetchable, repo md5 {rmd}"); continue
        lmd = hashlib.md5(live).hexdigest()
        txt = live.decode("utf-8", "ignore")
        bad = [m for m in marks if m not in txt]
        good = lmd == rmd and not bad
        ok = ok and good
        lines.append(f"{'ok' if good else 'MISMATCH'} {f}: live md5 {lmd} repo md5 {rmd} teaser {txt.count('teaser')}"
                     + (f" (live lacks: {', '.join(bad)})" if bad else ""))
    return ok, lines


def wait_features(dist, base=None, fetch=None, tries=7, delay=10, sleep=time.sleep):
    """Retry compare_features (the static host can lag ~60 s). Returns (ok, lines) of the last try."""
    for i in range(tries):
        ok, lines = compare_features(dist, base, fetch)
        if ok or i == tries - 1:
            return ok, lines
        sleep(delay)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if "--features" in argv:
        from build_static import DEFAULT_OUT
        ok, lines = compare_features(DEFAULT_OUT)
        print("\n".join(lines))
        print("features VERIFIED: the live page runs the repo's code" if ok else
              "FEATURES MISMATCH: the live page is NOT the repo build (older build?). Fix: git fetch origin main && git merge --no-edit origin/main, then deploy_static.py")
        return 0 if ok else 1
    import build_static as b
    URL = os.environ.get("LIVE_CONFIG_URL", LIVE_BASE + "/config.json")
    try:
        c = json.load(urllib.request.urlopen(URL, timeout=30))
        ok = b.decrypt_token(c, os.environ["VAULT_PASSPHRASE"]) == os.environ["VAULT_READ_TOKEN"]
        print("live config: the passphrase unlocks it and the read token matches" if ok else "FAIL live config: wrong passphrase or token mismatch")
        print("live config has the shortlist writer:", "yes" if "sl" in c else "no")
        if "sl" in c:
            try:
                t = b.decrypt_shortlist_token(c, os.environ["VAULT_PASSPHRASE"])
                print("live shortlist writer decrypts with the passphrase: yes; equals HF_Token:", "yes" if t == os.environ.get("HF_Token") else "no")
                print("live shortlist target:", c["sl"].get("dataset"), c["sl"].get("path"))
            except Exception as e:
                print("FAIL live shortlist writer does not decrypt:", type(e).__name__); ok = False
        return 0 if ok else 1
    except Exception as e:
        print("FAIL live config:", type(e).__name__); return 1


if __name__ == "__main__":
    sys.exit(main())
