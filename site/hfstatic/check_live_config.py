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
    if "sl" in c:
        try:
            t = b.decrypt_shortlist_token(c, os.environ["VAULT_PASSPHRASE"])
            print("live shortlist writer decrypts with the passphrase: yes; equals HF_Token:", "yes" if t == os.environ.get("HF_Token") else "no")
            print("live shortlist target:", c["sl"].get("dataset"), c["sl"].get("path"))
        except Exception as e:
            print("FAIL live shortlist writer does not decrypt:", type(e).__name__); ok = False
    sys.exit(0 if ok else 1)
except Exception as e:
    print("FAIL live config:", type(e).__name__); sys.exit(1)
