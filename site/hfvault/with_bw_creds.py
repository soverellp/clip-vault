#!/usr/bin/env python3
"""Run a command with credentials from Bitwarden injected into the CHILD environment only.

Usage:
  python3 site/hfvault/with_bw_creds.py [--only NAME,...] [--skip-readonly-check] -- python3 SCRIPT [args]
  python3 site/hfvault/with_bw_creds.py --list      (item NAMES only)
  python3 site/hfvault/with_bw_creds.py --check     (log in, map, report names; runs nothing)

Needs the Bitwarden CLI `bw` and BW_CLIENTID, BW_CLIENTSECRET (personal API key) and BW_PASSWORD (master password)
in the environment. Flow: private temp BITWARDENCLI_APPDATA_DIR (0700) -> `bw login --apikey` -> `bw unlock
--passwordenv BW_PASSWORD --raw` (session key only in memory, passed to bw via the BW_SESSION env, never on a command
line, never printed) -> `bw list items` -> every LOGIN item becomes an env var named exactly like the item (value = the
password field; usernames are never read); a Secure Note item works too (value = notes) -> child runs with those
variables (BW_* removed) and its output is masked -> always `bw lock`, `bw logout`, temp dir removed (also on Ctrl-C,
SIGTERM, SIGHUP). Only counts and item NAMES are printed. Items whose names are not valid env names are ignored.
Aliases: HF_Tokem/HF_TOKEN -> HF_Token, Clip_vault_HFToken/CLIP_VAULT_HFTOKEN -> VAULT_READ_TOKEN.
Refuses: empty command, a read token equal to the write token, a VAULT_READ_TOKEN that is provably not read-only.
Like the legacy with_vault_creds.py, only `python3 <allowed repo script>` may run after `--` (ALLOWED_SCRIPTS: deploy/build/vault_sync,
kaggle.py, check_creds.py = the credential health check).
"""
import importlib.util, json, os, re, shutil, signal, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
_spec = importlib.util.spec_from_file_location("with_vault_creds", HERE / "with_vault_creds.py")
wvc = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(wvc)  # masking helpers, read-only check

ALLOWED_SCRIPTS = wvc.ALLOWED_SCRIPTS + (".claude/skills/clips/scripts/download/kaggle.py", "site/hfvault/check_creds.py", "site/hfstatic/check_live_config.py", "site/hfvault/show_stream_times.py", "site/hfvault/purge_streams.py", ".claude/skills/clips/scripts/long_run.py")
ALIASES = {"HF_Tokem": "HF_Token", "HF_TOKEN": "HF_Token", "Clip_vault_HFToken": "VAULT_READ_TOKEN",
           "CLIP_VAULT_HFTOKEN": "VAULT_READ_TOKEN"}
ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
BLOCKED = {"PATH", "HOME", "SHELL", "USER", "PWD", "IFS", "ENV", "BASH_ENV", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME",
           "NODE_OPTIONS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"}
BW_NEEDED = ("BW_CLIENTID", "BW_CLIENTSECRET", "BW_PASSWORD")

def die(m): sys.exit("error: " + m)

def bad_name(n):
    return (not ENV_NAME.fullmatch(n)) or n.startswith("BW_") or n.upper() in BLOCKED or n.upper().startswith(("LD_", "DYLD_"))

class BW:
    def __init__(self, appdir, mask):
        self.appdir, self.mask, self.session = appdir, mask, None
    def env(self, extra=True):
        e = dict(os.environ, BITWARDENCLI_APPDATA_DIR=self.appdir, BW_NOINTERACTION="true", BITWARDENCLI_DEBUG="false")
        if self.session and extra: e["BW_SESSION"] = self.session
        return e
    def run(self, args):
        try:
            return subprocess.run(["bw", *args], capture_output=True, text=True, env=self.env(), timeout=120)
        except FileNotFoundError: die("the Bitwarden CLI `bw` is not installed (npm i -g @bitwarden/cli)")
        except subprocess.TimeoutExpired: die("bw timed out: " + " ".join(args[:2]))
    def err(self, r):
        t = (r.stderr or r.stdout or "").strip().splitlines()
        return self.mask(t[-1][:160]) if t else "no message"

def fetch_items(bw):
    r = bw.run(["login", "--apikey"])
    if r.returncode != 0: die("bw login failed (check BW_CLIENTID / BW_CLIENTSECRET): " + bw.err(r))
    r = bw.run(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"])
    if r.returncode != 0 or not r.stdout.strip(): die("bw unlock failed (wrong master password in BW_PASSWORD?)")
    bw.session = r.stdout.strip()
    r = bw.run(["list", "items"])
    if r.returncode != 0: die("bw list items failed: " + bw.err(r))
    try: items = json.loads(r.stdout)
    except ValueError: die("bw list items returned unreadable output")
    return items if isinstance(items, list) else []

def field_value(it, name):
    """Fallback when password/notes are empty: a custom text/hidden field named like the item, else the only non-empty one."""
    fs = [f for f in (it.get("fields") or []) if isinstance(f, dict) and f.get("type") in (0, 1)
          and isinstance(f.get("value"), str) and f["value"].strip()]
    named = [f for f in fs if (f.get("name") or "") == name]
    pick = named[0] if named else (fs[0] if len(fs) == 1 else None)
    return pick["value"] if pick else None

# Secure Notes whose item names are not env names: item name -> [(source, VAR)]; source "notes" = notes text,
# "field" = the note's only non-empty custom field (the token).
ITEM_MAP = {
    "Hugging Face Token 1 (SovereLLP)": [("field", "HF_Token"), ("field", "VAULT_WRITE_TOKEN")],
    "Hugging Face Clip Vault Token (SovereLLP)": [("field", "VAULT_READ_TOKEN")],
    "Hugging Face Token 2 (ARVR7Plays)": [("field", "HF_Token_Backup")],
    "Clip Vault Site": [("field", "VAULT_PASSPHRASE")],
    "Kaggle GPU (ARVR7Plays)": [("notes", "KAGGLE_USERNAME"), ("field", "KAGGLE_APITOKEN")],
    "Kaggle GPU (SovereLLP)": [("notes", "KAGGLE_USERNAME2"), ("field", "KAGGLE_APITOKEN2")],
}


def norm_username(v):
    """Kaggle slug from a note: first non-empty line, optional 'Username:' label dropped, first word, lowercase."""
    import re
    line = next((l.strip() for l in (v or "").splitlines() if l.strip()), "")
    line = re.sub(r"^(user\s*name|username|user|slug)\s*[:=-]\s*", "", line, flags=re.I)
    return (line.split() or [""])[0].lower()

def map_items(items):
    """-> (env {VAR: value}, names [env names loaded], ignored count). Never touches Login usernames."""
    env, names, ignored = {}, [], 0
    for it in items:
        if not isinstance(it, dict): continue
        name, typ = it.get("name") or "", it.get("type")
        if name in ITEM_MAP and typ == 2:
            got = 0
            for src, var in ITEM_MAP[name]:
                v = (it.get("notes") if src == "notes" else field_value(it, None)) or ""
                v = v.strip()
                if var in ("KAGGLE_USERNAME", "KAGGLE_USERNAME2"): v = norm_username(v)
                if not v or var in env: continue
                env[var] = v; names.append(var); got += 1
            if not got: ignored += 1
            continue
        if typ == 1: val = (it.get("login") or {}).get("password")
        elif typ == 2: val = it.get("notes")
        else: ignored += 1; continue
        from_field = not (val or "").strip()
        if from_field: val = field_value(it, name)
        if bad_name(name) or not val: ignored += 1; continue
        val = val.strip() if typ == 2 or from_field else val
        var = ALIASES.get(name, name)
        if var in env: print(f"WARNING: duplicate item {name} ignored (first one kept)", file=sys.stderr); continue
        env[var] = val; names.append(name)
    return env, names, ignored

def select_only(env, names, only):
    keep = {}
    for o in only:
        var = ALIASES.get(o, o)
        if var not in env: die(f"item {o} is missing in the vault (or has an empty value)")
        keep[var] = env[var]
    return keep, [n for n in names if ALIASES.get(n, n) in keep]

def check_command(cmd):
    if not cmd: die("no command given. Usage: with_bw_creds.py [--only NAME,...] -- python3 SCRIPT [args]")
    wvc.REPO, wvc.ALLOWED_SCRIPTS = REPO, ALLOWED_SCRIPTS
    wvc.check_command(cmd)
    if not os.path.isabs(cmd[1]) and not (Path.cwd() / cmd[1]).is_file(): cmd[1] = str(REPO / cmd[1])  # run from any folder

def main(argv=None):
    wvc.install_signal_handlers()
    try: signal.signal(signal.SIGINT, signal.default_int_handler)
    except Exception: pass
    a = list(sys.argv[1:] if argv is None else argv)
    i = a.index("--") if "--" in a else None
    opts, cmd = (a[:i], a[i + 1:]) if i is not None else (a, [])
    listing, checking = "--list" in opts, "--check" in opts
    only = [x for x in (wvc.opt(opts, "--only", "") or "").split(",") if x]
    if not (listing or checking):
        if not cmd: die("no command given. Usage: with_bw_creds.py [--only NAME,...] -- python3 SCRIPT [args]")
        check_command(cmd)
    miss = [v for v in BW_NEEDED if not os.environ.get(v)]
    if miss: die("missing environment variable(s): " + ", ".join(miss) + " (see migration-setup/BITWARDEN.md)")
    if not shutil.which("bw"): die("the Bitwarden CLI `bw` is not installed (npm i -g @bitwarden/cli)")
    base = [os.environ.get(v) for v in BW_NEEDED]
    state = {"extra": set(v for v in base if v), "forms": []}
    def mask(t):
        for s in sorted({f for x in state["extra"] for f in wvc.secret_forms(x)}, key=len, reverse=True): t = t.replace(s, "***")
        return t
    wvc.sweep_stale()
    tmp = None
    bw = None
    try:
        tmp = tempfile.mkdtemp(prefix="bwcreds-", dir=(wvc.tmp_bases() or [None])[0]); os.chmod(tmp, 0o700)
        bw = BW(tmp, mask)
        items = fetch_items(bw)
        state["extra"].add(bw.session)
        env, names, ignored = map_items(items)
        if listing:
            print(f"{len(names)} usable item(s), {ignored} ignored:", ", ".join(sorted(names)) or "none")
            if ignored:
                for it in items:
                    if isinstance(it, dict) and mask(str(it.get("name") or "")) and (it.get("name") or "") not in names and (it.get("name") or "") not in ITEM_MAP:
                        print("  ignored:", mask(repr(it.get("name") or "")), "type", it.get("type"),
                              "fields", [(f.get("name") if not bad_name(f.get("name") or "") else "?", f.get("type"), bool((f.get("value") or "").strip() if isinstance(f.get("value"), str) else 0))
                                         for f in (it.get("fields") or []) if isinstance(f, dict)],
                              "bad_name" if bad_name(it.get("name") or "") else "")
            return 0
        if only: env, names = select_only(env, names, only)
        print(f"loaded {len(env)} item(s) from Bitwarden: " + (", ".join(names) or "none"), file=sys.stderr)
        if env.get("HF_Token") and env.get("HF_Token") == env.get("VAULT_READ_TOKEN"):
            die("read token equals write token: use two different fine-grained tokens")
        if env.get("VAULT_READ_TOKEN") and "--skip-readonly-check" not in opts and checking:
            print("  VAULT_READ_TOKEN: " + wvc.verify_read_only(env["VAULT_READ_TOKEN"]), file=sys.stderr)
        elif env.get("VAULT_READ_TOKEN") and "--skip-readonly-check" not in opts:
            wvc.verify_read_only(env["VAULT_READ_TOKEN"])
        if checking: return 0
        child = {k: v for k, v in os.environ.items() if not k.startswith("BW_") and k != "BITWARDENCLI_APPDATA_DIR"}
        child.update(env)
        if env.get("HF_Token") and "VAULT_SHORTLIST_TOKEN" not in child: child["VAULT_SHORTLIST_TOKEN"] = env["HF_Token"]  # owner 2026-11-23: HF_Token is also the shortlist/playlist writer (child only)
        secrets_ = wvc.collect_secrets(env, state["extra"])
        return wvc.run_child(cmd, child, secrets_)
    finally:
        if bw:
            for c in (["lock"], ["logout"]):
                try: bw.run(c)
                except BaseException: pass
        if tmp: shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    sys.exit(main())
