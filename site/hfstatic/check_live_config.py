#!/usr/bin/env python3
"""Does VAULT_PASSPHRASE unlock the LIVE site config.json (and give VAULT_READ_TOKEN)? Prints ok/FAIL only, never a value.
Run: python3 site/hfvault/with_bw_creds.py -- python3 site/hfstatic/check_live_config.py"""
import json, os, sys, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_static as b
URL = os.environ.get("LIVE_CONFIG_URL", "https://soverellp-clip-vault-site.static.hf.space/config.json")
try:
    c = json.load(urllib.request.urlopen(URL, timeout=30))
    ok = b.decrypt_token(c, os.environ["VAULT_PASSPHRASE"]) == os.environ["VAULT_READ_TOKEN"]
    print("live config: the passphrase unlocks it and the read token matches" if ok else "FAIL live config: wrong passphrase or token mismatch")
    print("live config has the shortlist writer:", "yes" if "sl" in c else "no")
    sys.exit(0 if ok else 1)
except Exception as e:
    print("FAIL live config:", type(e).__name__); sys.exit(1)
