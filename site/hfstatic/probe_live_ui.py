#!/usr/bin/env python3
"""Live-site UI probe (Playwright). Prints ok/FAIL, console errors and screenshot paths only; the passphrase comes from the env.
Run: python3 site/hfvault/with_bw_creds.py -- python3 site/hfstatic/probe_live_ui.py [diag|layout|playlist|load]"""
import os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True).stdout.strip()
env = dict(os.environ, NODE_PATH=root, PLAYWRIGHT_BROWSERS_PATH=os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"))
sys.exit(subprocess.run(["node", os.path.join(here, "probe_live_ui.js")] + sys.argv[1:], env=env).returncode)
