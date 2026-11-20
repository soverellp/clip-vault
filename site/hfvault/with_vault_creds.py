#!/usr/bin/env python3
"""LEGACY: replaced by site/hfvault/with_bw_creds.py (Bitwarden); kept until Bitwarden is verified.

Run a command with the clip-vault credentials injected, without anyone seeing them.

The credentials live in the Kaggle dataset <KAGGLE_USERNAME>/kagglegpu1 (plain text KEY=VALUE lines).
This script downloads it to a private temp folder, parses it IN MEMORY, deletes the folder, and starts
YOUR command with these variables in the child's environment only:
    HF_Token            write token of the new Hugging Face account        (file key: HF_Tokem, a typo kept as is; HF_Token also accepted)
    VAULT_READ_TOKEN    read-only, clip-vault dataset only                 (file key: Clip_vault_HFToken)
    VAULT_PASSPHRASE    friends' passphrase                                (file key containing "passphrase")
Nothing is exported to the parent shell and nothing is written outside the temp folder (under /dev/shm when it
exists; removed on exit, Ctrl-C, SIGTERM and SIGHUP; stale vaultcreds-* folders older than 10 minutes are swept at
start). In the child's output the injected values, every env value whose NAME matches TOKEN|KEY|SECRET|PASS, and
every hf_... / KGAT_... token found in the file are masked ("***") in raw, base64, URL-quoted, JSON-escaped and hex
form, even when split across output chunks. Only key NAMES are ever printed.
The child does NOT get KAGGLE_APITOKEN / KAGGLE_API_TOKEN / KAGGLE_KEY unless you pass --keep-kaggle.

Only a fixed list of repo scripts may run after `--` (ALLOWED_SCRIPTS below), always as `python3 SCRIPT ...`; shells and
interpreter one-liners (-c / -e / -m) and every other command are refused before any credential is read. The one exception
is --from-dir (fake credentials from a folder, used by the tests): no real key is read there, so any command is allowed.

Usage:
  python3 site/hfvault/with_vault_creds.py --check
  python3 site/hfvault/with_vault_creds.py -- python3 site/hfvault/build_hfvault.py /tmp/vault OWNER/clip-vault --upload
Options: --dataset USER/NAME (default $KAGGLE_USERNAME/kagglegpu1), --from-dir DIR (read files from a folder, for tests),
         --keep-kaggle (leave the KAGGLE_* secrets in the child environment)
Needs KAGGLE_USERNAME + KAGGLE_APITOKEN in the environment and the `kaggle` CLI (pip install kaggle) unless --from-dir.
"""
import base64, binascii, codecs, contextlib, json, os, re, shutil, signal, stat, subprocess, sys, tempfile, time
import urllib.parse, urllib.request
from pathlib import Path

WANT = {  # child variable -> (exact file keys, substring match)
    "HF_Token": (["HF_Token", "HF_TOKEN", "HF_Tokem"], None),
    "VAULT_READ_TOKEN": (["Clip_vault_HFToken", "CLIP_VAULT_HFTOKEN", "VAULT_READ_TOKEN"], None),
    "VAULT_PASSPHRASE": (["VAULT_PASSPHRASE"], "passphrase"),
}
SECRETY = re.compile(r"TOKEN|KEY|SECRET|PASS", re.I)          # env var NAMES whose values are masked
TOKEN_RE = re.compile(r"hf_[A-Za-z0-9]{20,}|KGAT_[A-Za-z0-9]{20,}")  # tokens found anywhere in the file text
KAGGLE_STRIP = ("KAGGLE_APITOKEN", "KAGGLE_API_TOKEN", "KAGGLE_KEY")
STALE_SECONDS = 600
MIN_SECRET = 6
REPO = Path(__file__).resolve().parents[2]
ALLOWED_SCRIPTS = ("site/hfstatic/deploy_static.py", "site/hfstatic/build_static.py",
                   "site/hfvault/build_hfvault.py", "site/hfvault/vault_sync.py")
PYTHON_NAMES = re.compile(r"python3?(\.\d+)?")

def die(m): sys.exit("error: " + m)

def warn(m): print("WARNING: " + m, file=sys.stderr)

def check_command(cmd):
    """die() unless cmd is `python3 <one of ALLOWED_SCRIPTS> [args]`. The script is matched by its resolved path, so
    `bash`, `python3 -c ...`, `python3 -m ...`, `env`, `sh -c` and any other program are all refused."""
    allowed = ", ".join(ALLOWED_SCRIPTS)
    if len(cmd) < 2 or not PYTHON_NAMES.fullmatch(os.path.basename(cmd[0])) or cmd[1].startswith("-"):
        die("refused command. After `--` only `python3 SCRIPT [args]` is allowed, SCRIPT being one of: " + allowed)
    ok = {(REPO / a).resolve() for a in ALLOWED_SCRIPTS}
    cands = [Path(cmd[1]).resolve()] if os.path.isabs(cmd[1]) else [(b / cmd[1]).resolve() for b in (Path.cwd(), REPO)]
    if not any(c in ok and c.is_file() for c in cands):
        die("refused script " + os.path.basename(cmd[1]) + ". Allowed scripts: " + allowed)

# ---------- temp dirs ----------
def tmp_bases():
    """/dev/shm first when it exists (RAM only), then the system temp dir. VAULTCREDS_SHM overrides /dev/shm ('' disables)."""
    out = []
    shm = os.environ.get("VAULTCREDS_SHM", "/dev/shm")
    if shm and os.path.isdir(shm) and os.access(shm, os.W_OK | os.X_OK): out.append(shm)
    sysd = tempfile.gettempdir()
    if sysd not in out: out.append(sysd)
    return out

def sweep_stale(now=None):
    now = time.time() if now is None else now
    for base in tmp_bases():
        try: names = os.listdir(base)
        except OSError: continue
        for n in names:
            if not n.startswith("vaultcreds-"): continue
            p = os.path.join(base, n)
            try:
                st = os.lstat(p)
                if stat.S_ISDIR(st.st_mode) and st.st_uid == os.geteuid() and now - st.st_mtime > STALE_SECONDS:
                    shutil.rmtree(p, ignore_errors=True)
            except OSError: pass

def make_tmp():
    for base in tmp_bases():
        try:
            tmp = tempfile.mkdtemp(prefix="vaultcreds-", dir=base); os.chmod(tmp, 0o700); return tmp
        except OSError: continue
    die("cannot create a temp folder")

@contextlib.contextmanager
def workdir():
    tmp = make_tmp()
    try: yield tmp
    finally: shutil.rmtree(tmp, ignore_errors=True)

def install_signal_handlers():
    def h(signum, frame): raise SystemExit(128 + signum)  # unwinds through the finally blocks that delete the temp dir
    for s in (signal.SIGTERM, signal.SIGHUP): signal.signal(s, h)

# ---------- parsing ----------
def parse(text):
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"): continue
        line = re.sub(r"^export\s+", "", line)
        m = re.match(r"^([A-Za-z0-9_.\-]+)\s*[=:]\s*(.+)$", line)
        if m: out[m.group(1)] = m.group(2).strip().strip("'\"")
    return out

def read_dir(d):
    """Return (key->value dict, set of every hf_/KGAT_ token found anywhere in the file text)."""
    kv, extra = {}, set()
    for p in Path(d).rglob("*"):
        if not p.is_file(): continue
        if p.suffix.lower() == ".pdf":  # text is extracted in memory only, as kaggle.py does for kagglegpu2.pdf
            r = subprocess.run(["pdftotext", "-layout", str(p), "-"], capture_output=True, text=True)
            txt = r.stdout if r.returncode == 0 else ""
        else:
            try: txt = p.read_text(errors="ignore")
            except Exception: continue
        extra.update(TOKEN_RE.findall(txt))
        if p.suffix == ".json":
            try:
                j = json.loads(txt)
                if isinstance(j, dict): kv.update({k: str(v) for k, v in j.items() if isinstance(v, (str, int))})
                continue
            except Exception: pass
        kv.update(parse(txt))
    return kv, extra

def fetch(dataset):
    exe = shutil.which("kaggle") or str(Path.home() / "kvenv/bin/kaggle")
    if not Path(exe).exists(): die("kaggle CLI not found: pip install kaggle (or python3 -m venv ~/kvenv && ~/kvenv/bin/pip install kaggle)")
    if not os.environ.get("KAGGLE_USERNAME") or not os.environ.get("KAGGLE_APITOKEN"):
        die("KAGGLE_USERNAME and KAGGLE_APITOKEN must be set in the environment")
    with workdir() as tmp:
        kenv = {**os.environ, "KAGGLE_API_TOKEN": os.environ.get("KAGGLE_API_TOKEN") or os.environ["KAGGLE_APITOKEN"]}
        r = subprocess.run([exe, "datasets", "download", "-d", dataset, "-p", tmp, "--unzip", "-q"],
                           capture_output=True, text=True, env=kenv)
        if r.returncode != 0:
            die("dataset download failed (" + re.sub(r"[A-Za-z0-9_\-]{24,}", "***", (r.stderr or r.stdout))[-300:] + ")")
        return read_dir(tmp)

def pick(kv):
    env, names = {}, {}
    for var, (exact, sub) in WANT.items():
        key = next((k for k in exact if k in kv), None)
        if not key and sub: key = next((k for k in kv if sub in k.lower()), None)
        if key:
            val = kv[key]
            if var != "VAULT_PASSPHRASE" and val.startswith("hf_") and val.split()[0] != val:
                val = val.split()[0]  # "two values on one line" in a PDF layout: keep the first token only
            env[var], names[var] = val, key
    return env, names

# ---------- masking ----------
def _b64_forms(s, minlen=MIN_SECRET):
    """base64 of s as it appears inside a larger base64 string (3 byte alignments), padded and unpadded, std and urlsafe."""
    b = s.encode("utf-8", "replace"); out = set()
    for off, skip in ((0, 0), (1, 2), (2, 3)):
        raw = base64.b64encode(b"\0" * off + b)
        full = raw.decode()[skip:]
        cands = {full, full.rstrip("=")}
        if (off + len(b)) % 3: cands.add(full.rstrip("=")[:-1])  # last char may depend on the following byte
        for c in cands:
            out.add(c); out.add(c.replace("+", "-").replace("/", "_"))
    return {x for x in out if len(x) >= minlen}

def secret_forms(s):
    """All textual forms of one secret that must never reach the output."""
    forms = {s, urllib.parse.quote(s, safe=""), urllib.parse.quote(s), urllib.parse.quote_plus(s),
             json.dumps(s)[1:-1], json.dumps(s, ensure_ascii=False)[1:-1],
             "".join("\\u%04x" % ord(c) for c in s), "".join("\\u%04X" % ord(c) for c in s),
             s.replace("/", "\\/"), s.encode("utf-8", "replace").hex(), s.encode("utf-8", "replace").hex().upper(),
             repr(s)[1:-1]}
    minlen = min(MIN_SECRET, len(s))  # a short secret (a short passphrase) is still masked in full
    forms |= _b64_forms(s, minlen)
    return {f for f in forms if f and len(f) >= minlen}

def collect_secrets(injected, extra, kv=None):
    base = set()
    for k, v in {**os.environ, **injected}.items():
        if SECRETY.search(k) and (len(v) >= MIN_SECRET or (k == "VAULT_PASSPHRASE" and v)): base.add(v)
    base |= {v for v in injected.values() if len(v) >= MIN_SECRET}
    if injected.get("VAULT_PASSPHRASE"): base.add(injected["VAULT_PASSPHRASE"])  # always masked, however short
    base |= {t for t in extra if len(t) >= MIN_SECRET}
    for k, v in (kv or {}).items():
        if SECRETY.search(k) and len(v) >= MIN_SECRET: base.add(v)
    forms = set()
    for s in base: forms |= secret_forms(s)
    return sorted((f.encode("utf-8", "replace") for f in forms), key=len, reverse=True)

class Masker:
    """Streaming masker: feed raw byte chunks, get masked bytes back. The last max_len-1 bytes stay unflushed so a
    secret split across two chunks is still caught; flush() releases the rest at end of stream."""
    def __init__(self, secrets_):
        self.secrets = [s for s in secrets_ if s]
        self.maxlen = max((len(s) for s in self.secrets), default=1)
        self.line_safe = not any(b"\n" in s or b"\r" in s for s in self.secrets)
        self.hold = b""
    def _sub(self, data):
        for s in self.secrets: data = data.replace(s, b"***")
        return data
    def feed(self, chunk):
        data = self._sub(self.hold + chunk)
        cut = max(len(data) - (self.maxlen - 1), 0)
        if self.line_safe: cut = max(cut, data.rfind(b"\n") + 1)  # a newline-free secret cannot straddle a newline
        out, self.hold = data[:cut], data[cut:]
        return out
    def flush(self):
        out, self.hold = self._sub(self.hold), b""
        return out

def run_child(cmd, env, secrets_):
    p = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
    m, dec = Masker(secrets_), codecs.getincrementaldecoder("utf-8")(errors="replace")
    try: sys.stdout.reconfigure(errors="replace")
    except Exception: pass
    def emit(b):
        t = dec.decode(b)
        if t: sys.stdout.write(t); sys.stdout.flush()
    try:
        fd = p.stdout.fileno()
        while True:
            chunk = os.read(fd, 65536)
            if not chunk: break
            emit(m.feed(chunk))
        emit(m.flush()); emit(b"")
        sys.stdout.write(dec.decode(b"", final=True)); sys.stdout.flush()
        rc = p.wait()
    finally:
        if p.poll() is None:  # wrapper is being unwound (signal, Ctrl-C): do not leave the child holding the secrets
            p.terminate()
            try: p.wait(5)
            except Exception: p.kill()
    return rc if rc >= 0 else 128 - rc

# ---------- Hugging Face checks ----------
WHOAMI_URL = "https://huggingface.co/api/whoami-v2"

def hf_whoami(tok):
    url = WHOAMI_URL  # fixed: an overridable URL would send the token to whatever the override names
    try:
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
        return json.load(urllib.request.urlopen(req, timeout=15)), None
    except Exception as e:
        return None, getattr(e, "code", type(e).__name__)

def hf_who(tok):
    d, err = hf_whoami(tok)
    return (d.get("name") if isinstance(d, dict) else None), err

WRITEY = re.compile(r"write|create|delete|manage|admin|edit", re.I)

def classify_readonly(data):
    """-> ('read'|'write'|'unknown', reason). Never raises."""
    try:
        acc = ((data or {}).get("auth") or {}).get("accessToken") or {}
        role = acc.get("role")
        if role == "read": return "read", "role read"
        if role in ("write", "admin"): return "write", "role " + role
        if role == "fineGrained":
            fg = acc.get("fineGrained") or {}
            perms = list(fg.get("global") or [])
            for sc in fg.get("scoped") or []: perms += list((sc or {}).get("permissions") or [])
            if not perms: return "unknown", "fine-grained token without a readable permission list"
            bad = sorted({p for p in perms if isinstance(p, str) and WRITEY.search(p)})
            return ("write", "write scope: " + ", ".join(bad)) if bad else ("read", "fine-grained, no write scope")
        return "unknown", "role not reported"
    except Exception:
        return "unknown", "unparseable whoami response"

def verify_read_only(tok):
    """die() if the token is provably not read-only; WARNING if it cannot be determined. Returns a status line."""
    data, err = hf_whoami(tok)
    if data is None:
        warn(f"cannot confirm VAULT_READ_TOKEN is read-only (whoami failed: {err})"); return "read-only status unknown"
    kind, why = classify_readonly(data)
    if kind == "write": die("VAULT_READ_TOKEN is not read-only (" + why + "): create a read-only token")
    if kind == "unknown": warn("cannot confirm VAULT_READ_TOKEN is read-only (" + why + ")"); return "read-only status unknown"
    return "read-only (" + why + ")"

# ---------- importable API (used by vault_sync.py; the CLI below does not depend on it) ----------
DEFAULT_DATASET = "arvr7plays/kagglegpu1"
WRITE_KEYS = ["VAULT_WRITE_TOKEN", "Clip_vault_Write"]  # dataset-scoped write token (file keys); preferred over HF_Token

def load_credentials(dataset=None, from_dir=None):
    """Read the credential file IN MEMORY (Kaggle download to a private temp folder that is deleted at once, or --from-dir)
    and return {"values": {VAR: value}, "names": {VAR: file key}, "secrets": [bytes masking forms]}.
    VAR is HF_Token / VAULT_READ_TOKEN / VAULT_PASSPHRASE (as the CLI injects them) plus VAULT_WRITE_TOKEN when the file has
    one of WRITE_KEYS. Nothing is put into os.environ; nothing is printed. Exits via die() (SystemExit with a message)
    when the Kaggle step fails; a missing key is simply absent from "values". Callers must mask every message they print."""
    kv, extra = read_dir(from_dir) if from_dir else fetch(dataset or DEFAULT_DATASET)
    env, names = pick(kv)
    wk = next((k for k in WRITE_KEYS if k in kv), None)
    if wk:
        val = kv[wk]
        if val.startswith("hf_") and val.split()[0] != val: val = val.split()[0]
        env["VAULT_WRITE_TOKEN"], names["VAULT_WRITE_TOKEN"] = val, wk
    return {"values": env, "names": names, "secrets": collect_secrets(env, extra, kv)}

def opt(opts, name, default=None):
    return opts[opts.index(name) + 1] if name in opts and opts.index(name) + 1 < len(opts) else default

def main():
    install_signal_handlers()
    sweep_stale()
    a = sys.argv[1:]
    if "--" in a: i = a.index("--"); opts, cmd = a[:i], a[i+1:]
    else: opts, cmd = a, []
    if "--list" in opts:
        d = opt(opts, "--from-dir")
        if d:
            return
        ds = opt(opts, "--dataset") or f"{os.environ.get('KAGGLE_USERNAME','')}/kagglegpu1"
        with workdir() as tmp:
            subprocess.run([shutil.which("kaggle") or str(Path.home() / "kvenv/bin/kaggle"), "datasets", "download", "-d", ds, "-p", tmp, "--unzip", "-q"],
                           capture_output=True, env={**os.environ, "KAGGLE_API_TOKEN": os.environ.get("KAGGLE_API_TOKEN") or os.environ.get("KAGGLE_APITOKEN", "")})
            for q in sorted(Path(tmp).rglob("*")):
                if q.is_file(): print(f"{q.relative_to(tmp)}  {q.stat().st_size} bytes", file=sys.stderr)
        return
    if not cmd and "--check" not in opts: die("usage: with_vault_creds.py --check | -- python3 SCRIPT ...")
    if cmd and "--from-dir" not in opts: check_command(cmd)  # --from-dir = fake test credentials only, never the real dataset
    ds = opt(opts, "--dataset") or f"{os.environ.get('KAGGLE_USERNAME','')}/kagglegpu1"
    kv, extra = read_dir(opt(opts, "--from-dir")) if "--from-dir" in opts else fetch(ds)
    env, names = pick(kv)
    if "VAULT_PASSPHRASE" not in env and os.environ.get("VAULT_PASSPHRASE"):
        env["VAULT_PASSPHRASE"], names["VAULT_PASSPHRASE"] = os.environ["VAULT_PASSPHRASE"], "environment variable"
    # never echo odd-looking keys: in binary/PDF text they can be fragments of a secret or a secret itself
    sane = sorted(k for k in kv if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,40}", k)
                  and not re.match(r"(hf_|KGAT_)", k, re.I) and len(k) <= 30)
    print(f"{len(kv)} KEY=VALUE pairs; recognisable names: " + (", ".join(k for k in sane if any(w in k.lower() for w in ("hf", "token", "vault", "pass", "kaggle", "key", "user"))) or "none"), file=sys.stderr)
    for var in WANT: print(f"  {var}: {'found as ' + names[var] if var in env else 'MISSING'}", file=sys.stderr)
    miss = [v for v in WANT if v not in env]
    if miss: die("missing: " + ", ".join(miss))
    if not env["HF_Token"].startswith("hf_") or not env["VAULT_READ_TOKEN"].startswith("hf_"): die("tokens must start with hf_")
    if env["HF_Token"] == env["VAULT_READ_TOKEN"]: die("read token equals write token: use two different fine-grained tokens")
    ro = verify_read_only(env["VAULT_READ_TOKEN"])
    if "--check" in opts:
        n, err = hf_who(env["HF_Token"]); print(f"  HF_Token: " + (f"valid, user {n}" if n else f"rejected ({err})"), file=sys.stderr)
        print(f"  VAULT_READ_TOKEN: {ro}", file=sys.stderr)
        return
    secrets_ = collect_secrets(env, extra, kv)
    child = {k: v for k, v in os.environ.items() if "--keep-kaggle" in opts or k not in KAGGLE_STRIP}
    child.update(env)
    sys.exit(run_child(cmd, child, secrets_))

if __name__ == "__main__":
    main()
