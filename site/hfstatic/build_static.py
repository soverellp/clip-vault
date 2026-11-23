#!/usr/bin/env python3
"""Build the STATIC (no server) Clip Vault site into dist/, ready for a free Hugging Face Static Space.

The UI is COPIED from site/hfspace/static/ (never forked). Two things are added: hubapi.js (the same interface as the
server's api.js, talking to the Hub straight from the browser) and a few small runtime files. A PBKDF2-SHA256 (600k) +
AES-256-GCM encrypted READ token goes into config.json, exactly like site/hfvault/build_hfvault.py.

Reads ONLY these environment variable NAMES (values are never printed or written in clear):
  VAULT_READ_TOKEN   fine-grained, read-only, this dataset only
  VAULT_PASSPHRASE   4+ DISTINCT random words, 20+ characters (see --accept-weak-passphrase)
Optional guards: HF_Token / VAULT_WRITE_TOKEN (the read token must differ from them).

Usage: python3 site/hfstatic/build_static.py [--out DIR] [--dataset OWNER/NAME] [--ui DIR] [--accept-weak-passphrase]
"""
import argparse, datetime, hashlib, importlib.util, json, os, re, secrets, shutil, sys
from pathlib import Path
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DEFAULT_UI = REPO / "site" / "hfspace" / "static"
DEFAULT_OUT = HERE / "dist"
INFO_COPY = HERE / "build-info.json"  # tracked copy (no secrets) that clip-vault-project/DECISIONS.md can reference
DEFAULT_DATASET = "Soverellp/clip-vault"
ITER = 600_000
MARKER = ".hfstatic-build"
WEAK_NOTE = "WEAK PASSPHRASE ACCEPTED BY OWNER"

CSP = ("default-src 'none'; script-src 'self'; connect-src 'self' https://huggingface.co https://*.hf.co; "
       "img-src 'self' blob:; media-src blob:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'")
# Files that deploy_static.py may upload (everything else, tests and .env included, is never sent).
DEFAULT_SL_PATH = "_config/shortlist.json"
DEPLOY_ALLOW = ["index.html", "README.md", "config.json", "css/*.css", "js/*.js", "vendor/*.js", "assets/*.svg", "assets/brand/*.png", "fonts/*.woff2"]
FORBIDDEN = re.compile(r"localStorage|sessionStorage|indexedDB|document\.cookie|\beval\s*\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write|serviceWorker|setAttribute\(\s*['\"]style['\"]|cssText", re.I)

# The ONE allowed storage use (owner request D37, "Remember on this device"): in hubchrome.js only, the key 'cv.pass' only, through exactly
# these three call shapes. Everything else (any other key, clear(), bracket access, window.localStorage, sessionStorage, ...) still fails.
REMEMBER_FILE = "hubchrome.js"
REMEMBER_KEY_DECL = "const PASS_KEY = 'cv.pass';"
REMEMBER_ALLOWED = re.compile(r"(?<![\w.])localStorage\.(?:getItem\(PASS_KEY\)|setItem\(PASS_KEY, v\)|removeItem\(PASS_KEY\))")
# D47: the per-viewer "Post info" switch, viewpref.js only, key 'cv.postmode' only, exactly these two call shapes.
PREF_FILE = "viewpref.js"
PREF_KEY_DECL = "const PM_KEY = 'cv.postmode';"
PREF_ALLOWED = re.compile(r"(?<![\w.])localStorage\.(?:getItem\(PM_KEY\)|setItem\(PM_KEY, on \? '1' : '0'\))")





def forbidden_hit(name, src):
    """First forbidden-API match in a js file (comments stripped), or None. hubchrome.js may use the three PASS_KEY calls and nothing more."""
    code = strip_comments(src)
    if name == REMEMBER_FILE and code.count(REMEMBER_KEY_DECL) == 1:
        code = REMEMBER_ALLOWED.sub("", code)
    if name == PREF_FILE and code.count(PREF_KEY_DECL) == 1:
        code = PREF_ALLOWED.sub("", code)
    m = FORBIDDEN.search(code)
    return m.group(0) if m else None


def die(msg):
    sys.exit("error: " + msg)


def _load_hfvault():
    spec = importlib.util.spec_from_file_location("build_hfvault", REPO / "site" / "hfvault" / "build_hfvault.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def passphrase_problem(p):
    """Same strength rules as build_hfvault (single source of truth)."""
    return _load_hfvault().passphrase_problem(p)


def check_passphrase(p, weak=False):
    if not (p or "").strip():
        die("VAULT_PASSPHRASE is empty")
    if len(p) > 256:
        die("VAULT_PASSPHRASE is longer than 256 characters (the page refuses those)")
    why = passphrase_problem(p)
    if not why:
        return
    if not weak:
        print(_load_hfvault().passphrase_hint(), file=sys.stderr)
        die("VAULT_PASSPHRASE rejected: " + why + " (need 4+ distinct random words, 20+ characters, no repeats). "
            "The owner may knowingly override this with --accept-weak-passphrase.")
    print("\n".join([
        "WARNING: WEAK PASSPHRASE ACCEPTED (--accept-weak-passphrase). Reason it would be rejected: " + why + ".",
        "WARNING: config.json is PUBLIC. Anyone can copy it and guess passphrases offline at full speed; PBKDF2 slows each guess",
        "WARNING: but cannot stop a short or common passphrase from being found, and then the read token (every clip) is exposed.",
        "WARNING: The in-page attempt delay does not help against that. Prefer 6 random words. This choice is recorded in build-info.json.",
    ]), file=sys.stderr)


def check_token(tok, env):
    if not tok.startswith("hf_") or len(tok) < 10 or re.search(r"\s", tok):
        die("VAULT_READ_TOKEN missing or not an hf_ token (set it in the environment)")
    for name in ("HF_Token", "HF_TOKEN", "VAULT_WRITE_TOKEN"):
        if env.get(name) and env[name] == tok:
            die(f"VAULT_READ_TOKEN must differ from the write token {name}")


def prepare_out_dir(out):
    out = Path(out)
    if out.is_symlink():
        die(f"OUT {out} is a symlink: refusing")
    r = out.resolve()
    for g in (Path.cwd().resolve(), REPO.resolve(), HERE.resolve(), Path.home().resolve(), Path(r.anchor)):
        if r == g or r in g.parents:
            die(f"OUT {out} is (or contains) the current directory, the repo or a system folder: refusing to delete it")
    if r.exists():
        if not r.is_dir():
            die(f"OUT {out} exists and is not a directory")
        if any(r.iterdir()):
            m = r / MARKER
            if not (m.is_file() and not m.is_symlink()):
                die(f"OUT {out} is not empty and has no {MARKER} marker (not built by this script): choose a new or empty folder")
            shutil.rmtree(r)
    r.mkdir(parents=True, exist_ok=True)
    (r / MARKER).write_text("written by build_static.py; safe to delete this folder\n")
    return r


def encrypt_token(token, passphrase, iterations=ITER, extra=None):
    """extra = optional second secret (the shortlist writer): same salt and key (one PBKDF2), its own random iv -> cfg["sl"] fields iv/token."""
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = PBKDF2HMAC(hashes.SHA256(), 32, salt, iterations).derive(passphrase.encode())
    out = {"iter": iterations, "salt": salt.hex(), "iv": iv.hex(), "token": AESGCM(key).encrypt(iv, token.encode(), None).hex()}
    if extra:
        iv2 = secrets.token_bytes(12)
        out["sl"] = {"iv": iv2.hex(), "token": AESGCM(key).encrypt(iv2, extra.encode(), None).hex()}
    return out


def decrypt_token(cfg, passphrase):
    key = PBKDF2HMAC(hashes.SHA256(), 32, bytes.fromhex(cfg["salt"]), cfg["iter"]).derive(passphrase.encode())
    return AESGCM(key).decrypt(bytes.fromhex(cfg["iv"]), bytes.fromhex(cfg["token"]), None).decode()


def decrypt_shortlist_token(cfg, passphrase):
    """The shortlist token, or None when the config has none."""
    if not cfg.get("sl"):
        return None
    key = PBKDF2HMAC(hashes.SHA256(), 32, bytes.fromhex(cfg["salt"]), cfg["iter"]).derive(passphrase.encode())
    return AESGCM(key).decrypt(bytes.fromhex(cfg["sl"]["iv"]), bytes.fromhex(cfg["sl"]["token"]), None).decode()


def transform_index(html):
    """CSP meta right after the charset meta, the frame-buster first, static-mode.css and hubchrome.js added. Asserts the shape."""
    marker = '<meta charset="utf-8">'
    if html.count(marker) != 1:
        die('index.html drift: expected exactly one <meta charset="utf-8">')
    if re.search(r"<script(?![^>]*\bsrc=)", html) or re.search(r"<style\b|\sstyle=", html):
        die("index.html drift: an inline <script>, <style> or style= attribute would be blocked by the CSP")
    main = '<script type="module" src="/js/main.js"></script>'
    if html.count(main) != 1 or html.count("</head>") != 1:
        die("index.html drift: main.js script tag or </head> not found exactly once")
    html = html.replace(marker, marker + f'\n<meta http-equiv="Content-Security-Policy" content="{CSP}">\n<script src="/js/framebust.js"></script>')
    html = html.replace("</head>", '<link rel="stylesheet" href="/css/static-mode.css">\n</head>')
    return html.replace(main, main + '\n<script type="module" src="/js/hubchrome.js"></script>')


EXPORT_RE = re.compile(r"^export\s+(?:async\s+)?(?:const|let|function\*?|class)\s+([A-Za-z_$][\w$]*)", re.M)
EXPORT_LIST_RE = re.compile(r"^export\s*\{([^}]*)\}", re.M)


def exported_names(src):
    names = set(EXPORT_RE.findall(src))
    for grp in EXPORT_LIST_RE.findall(src):
        names |= {x.split(" as ")[-1].strip() for x in grp.split(",") if x.strip()}
    return names


def strip_comments(js):
    out = []
    for line in js.splitlines():
        out.append(re.sub(r"(?<![:\w'\"`])//.*$", "", line))
    return re.sub(r"/\*.*?\*/", "", "\n".join(out), flags=re.S)


def readme_text(dataset, weak, today):
    note = ""  # never say 'weak passphrase' in the PUBLIC Space README: it would tell an attacker the password is guessable
    return f"""---
title: Clip Vault
sdk: static
app_file: index.html
pinned: false
short_description: Private clip library (one shared passphrase)
---

# Clip Vault (static site)

A static page with no server. It holds no clips. It carries one read-only Hugging Face token for the private
dataset `{dataset}`, encrypted with a passphrase (PBKDF2-SHA256 600k + AES-256-GCM). Built {today}.
{note}"""


def build(out=DEFAULT_OUT, dataset=DEFAULT_DATASET, ui=DEFAULT_UI, env=None, weak=False, today=None, write_info_copy=True, sl_dataset=None, sl_path=DEFAULT_SL_PATH):
    env = os.environ if env is None else env
    ui = Path(ui)
    if not re.fullmatch(r"[\w.\-]+/[\w.\-]+", dataset):
        die("--dataset must look like OWNER/NAME")
    tok, pw = env.get("VAULT_READ_TOKEN", ""), env.get("VAULT_PASSPHRASE", "")
    check_token(tok, env)
    check_passphrase(pw, weak)
    sl_tok = env.get("VAULT_SHORTLIST_TOKEN", "")
    sl_dataset = sl_dataset or dataset
    if sl_tok:
        if not sl_tok.startswith("hf_") or re.search(r"\s", sl_tok):
            die("VAULT_SHORTLIST_TOKEN is not an hf_ token")
        if sl_tok == tok:
            die("VAULT_SHORTLIST_TOKEN must differ from the read token")
        if not re.fullmatch(r"[\w.\-]+/[\w.\-]+", sl_dataset) or not re.fullmatch(r"[\w.\-/]{1,100}", sl_path) or ".." in sl_path or sl_path.startswith("/"):
            die("bad shortlist dataset or path")
    for need in ("index.html", "js/api.js", "js/main.js", "js/state.js"):
        if not (ui / need).is_file():
            die(f"UI folder {ui} lacks {need}")
    today = today or datetime.date.today().isoformat()
    out = prepare_out_dir(out)
    shutil.copytree(ui, out, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.md", "tests", ".env*", "*.map"))
    # the interface contract: every name the server api.js exports must exist in hubapi.js
    hubapi = (HERE / "src" / "hubapi.js").read_text()
    missing = sorted(exported_names((ui / "js" / "api.js").read_text()) - exported_names(hubapi))
    if missing:
        shutil.rmtree(out)
        die("hubapi.js lacks names exported by the server api.js: " + ", ".join(missing))
    shutil.copy2(HERE / "src" / "hubapi.js", out / "js" / "hubapi.js")
    shutil.copy2(HERE / "src" / "hubchrome.js", out / "js" / "hubchrome.js")
    shutil.copy2(HERE / "src" / "autorefresh.js", out / "js" / "autorefresh.js")
    shutil.copy2(HERE / "src" / "framebust.js", out / "js" / "framebust.js")
    shutil.copy2(HERE / "src" / "static-mode.css", out / "css" / "static-mode.css")
    (out / "js" / "api.js").write_text("// Static mode: the same interface as the server api.js, implemented in hubapi.js (generated by build_static.py).\nexport * from './hubapi.js';\n")
    (out / "index.html").write_text(transform_index((ui / "index.html").read_text()))
    for f in sorted((out / "js").glob("*.js")):
        bad = forbidden_hit(f.name, f.read_text())
        if bad:
            shutil.rmtree(out)
            die(f"{f.name} uses a forbidden browser API ({bad!r}); the static site keeps everything in memory (only the 'cv.pass' remember key in {REMEMBER_FILE} is allowed)")
    cfg = {"v": 1, "dataset": dataset, **encrypt_token(tok, pw, extra=sl_tok or None)}
    if sl_tok:
        cfg["sl"].update({"dataset": sl_dataset, "path": sl_path})
    (out / "config.json").write_text(json.dumps(cfg))
    (out / "README.md").write_text(readme_text(dataset, weak, today))
    (out / ".nojekyll").write_text("")
    files = sorted(p for p in out.rglob("*") if p.is_file() and p.name not in (MARKER,))
    info = {"built": today, "dataset": dataset, "kdf": "PBKDF2-SHA256", "iterations": ITER, "cipher": "AES-256-GCM",
            "weak_passphrase_accepted": bool(weak), "note": WEAK_NOTE + f" on {today}" if weak else "passphrase met the strength rules",
            "files": {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest()[:16] for p in files}}
    # the PUBLIC dist/build-info.json must not reveal the weakness; only the repo-local copy records the accepted risk
    public = {k: v for k, v in info.items() if k not in ("weak_passphrase_accepted", "note")} if weak else info
    (out / "build-info.json").write_text(json.dumps(public, indent=1))
    if write_info_copy:  # a copy outside dist/ that clip-vault-project/DECISIONS.md can reference (no secrets in it)
        INFO_COPY.write_text(json.dumps({k: v for k, v in info.items() if k != "files"}, indent=1))
    return out, info


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--dataset", default=DEFAULT_DATASET)
    ap.add_argument("--ui", default=str(DEFAULT_UI))
    ap.add_argument("--no-info-copy", action="store_true", help="do not refresh site/hfstatic/build-info.json (used by the tests)")
    ap.add_argument("--shortlist-dataset", default=None, help="dataset holding the shortlist file (default: the clip dataset)")
    ap.add_argument("--shortlist-path", default=DEFAULT_SL_PATH)
    ap.add_argument("--accept-weak-passphrase", action="store_true",
                    help="owner opt-in: skip ONLY the passphrase strength rules (prints a warning, recorded in build-info.json)")
    a = ap.parse_args(argv)
    out, info = build(a.out, a.dataset, a.ui, weak=a.accept_weak_passphrase, write_info_copy=not a.no_info_copy, sl_dataset=a.shortlist_dataset, sl_path=a.shortlist_path)
    print(f"ok: {len(info['files'])} files -> {out} (secrets not printed)" + ("; WEAK PASSPHRASE ACCEPTED BY OWNER" if a.accept_weak_passphrase else ""))


if __name__ == "__main__":
    main()
