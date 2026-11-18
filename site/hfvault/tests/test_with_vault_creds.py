"""Tests for site/hfvault/with_vault_creds.py. Every credential here is FAKE; nothing touches the network
(whoami points at a closed local port or a local stub server)."""
import base64, http.server, importlib.util, json, os, signal, subprocess, sys, threading, time, urllib.parse
from pathlib import Path
import pytest

HERE = Path(__file__).resolve().parent.parent
WRAPPER = HERE / "with_vault_creds.py"

WRITE = "hf_" "FAKEWRITETOKENaaaaaaaaaaaaaaaaaaaa"
READ = "hf_" "FAKEREADTOKENbbbbbbbbbbbbbbbbbbbbbb"
PASSPHRASE = "fakeword alpha bravo charlie delta"
KG = "KGAT_" "FAKEKAGGLEKEYcccccccccccccccccc"
ODD = "hf_" "FAKEODDKEYddddddddddddddddddddd"
TWO_A = "hf_" "FAKEPAIRAeeeeeeeeeeeeeeeeeeeeeee"
TWO_B = "hf_" "FAKEPAIRBfffffffffffffffffffffff"
SPECIAL = 'fa/ke+key"q&=x ü中-9876'  # needs URL quoting and JSON escaping
KAGGLE_TOK = "FAKEKAGGLEAPITOKENvalue1234567890"

CREDS = f"""# fake credentials
HF_Tokem={WRITE}
Clip_vault_HFToken={READ}
VAULT_PASSPHRASE={PASSPHRASE}
Kaggle_Key_Backup={KG}
{ODD}: read token
Pair_one={TWO_A}   Pair_two={TWO_B}
"""

CHILD = r'''
import base64, json, os, sys, time, urllib.parse
mode = sys.argv[1]
if mode == "env":
    for k, v in sorted(os.environ.items()): print(f"{k}={v}")
elif mode == "split":
    s = os.environ[sys.argv[2]]; h = len(s) // 2
    sys.stdout.write("before " + s[:h]); sys.stdout.flush(); time.sleep(0.3)
    sys.stdout.write(s[h:] + " after\n"); sys.stdout.flush()
elif mode == "split_bytes":  # many tiny writes through the raw fd
    s = os.environ[sys.argv[2]].encode()
    for i in range(0, len(s), 3): os.write(1, s[i:i+3]); time.sleep(0.01)
    os.write(1, b"\n")
elif mode == "encodings":
    s = os.environ[sys.argv[2]]
    print("b64", base64.b64encode(s.encode()).decode())
    print("b64url", base64.urlsafe_b64encode(s.encode()).decode())
    print("quote", urllib.parse.quote(s, safe=""))
    print("quote_plus", urllib.parse.quote_plus(s))
    print("json", json.dumps(s)); print("json_raw", json.dumps(s, ensure_ascii=False))
    print("basic", base64.b64encode(("user:" + s).encode()).decode())
    print("hex", s.encode().hex())
elif mode == "exit": sys.exit(int(sys.argv[2]))
elif mode == "binary":
    sys.stdout.buffer.write(b"bad \xff\xfe bytes " + os.environ[sys.argv[2]].encode() + b" end\n"); sys.stdout.flush()
'''

FAKE_KAGGLE = '''#!{py}
import os, sys, time
tmp = sys.argv[sys.argv.index("-p") + 1]
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "seen_dir"), "w").write(tmp)
open(os.path.join(tmp, "creds.txt"), "w").write({creds!r})
if os.environ.get("FAKE_KAGGLE_SLEEP"): time.sleep(60)
'''


@pytest.fixture
def env(tmp_path):
    (tmp_path / "tmp").mkdir(); (tmp_path / "shm").mkdir()
    e = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "TMPDIR": str(tmp_path / "tmp"),
         "VAULTCREDS_SHM": str(tmp_path / "shm"), "TEST_WHOAMI_URL": "http://127.0.0.1:1/whoami",
         "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
         "KAGGLE_USERNAME": "fakeuser", "KAGGLE_APITOKEN": KAGGLE_TOK, "KAGGLE_KEY": "FAKEKAGGLELEGACYKEY999999",
         "MY_API_KEY": SPECIAL, "SESSION_SECRET": "fake-session-secret-0123456789abcdef"}
    return e


@pytest.fixture
def creds_dir(tmp_path):
    d = tmp_path / "creds"; d.mkdir(); (d / "creds.txt").write_text(CREDS); return d


@pytest.fixture
def child(tmp_path):
    p = tmp_path / "child.py"; p.write_text(CHILD); return p


DRIVER = """import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("wvc", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.WHOAMI_URL = os.environ["TEST_WHOAMI_URL"]  # the wrapper has no env override (it is a fixed https://huggingface.co/ URL)
sys.argv = [sys.argv[1]] + sys.argv[2:]; m.main()
"""


def run(env, creds_dir, *args, timeout=60):
    drv = Path(creds_dir).parent / "driver.py"; drv.write_text(DRIVER)
    cmd = [sys.executable, str(drv), str(WRAPPER), "--from-dir", str(creds_dir), *args]
    return subprocess.run(cmd, env=env, capture_output=True, timeout=timeout)


def out_of(r): return r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


def all_forms(s):
    b = s.encode()
    return {s, base64.b64encode(b).decode(), base64.b64encode(b).decode().rstrip("="), base64.urlsafe_b64encode(b).decode(),
            urllib.parse.quote(s, safe=""), urllib.parse.quote_plus(s), json.dumps(s)[1:-1], json.dumps(s, ensure_ascii=False)[1:-1],
            b.hex()} - {""}


INJECTED = [WRITE, READ, PASSPHRASE]
ALL_FAKES = INJECTED + [KG, ODD, TWO_A, TWO_B, SPECIAL, KAGGLE_TOK, "FAKEKAGGLELEGACYKEY999999", "fake-session-secret-0123456789abcdef"]


def assert_clean(text, secrets=ALL_FAKES):
    for s in secrets:
        for f in all_forms(s):
            if len(f) >= 6: assert f not in text, f"leaked form {f[:12]}... of a fake secret"


def test_env_dump_is_masked_and_kaggle_stripped(env, creds_dir, child):
    r = run(env, creds_dir, "--", sys.executable, str(child), "env")
    so, se = out_of(r)
    assert r.returncode == 0, se
    assert_clean(so + se)
    assert "HF_Token=***" in so and "VAULT_READ_TOKEN=***" in so and "VAULT_PASSPHRASE=***" in so
    assert "MY_API_KEY=***" in so and "SESSION_SECRET=***" in so   # other secret-named env values masked too
    for name in ("KAGGLE_APITOKEN", "KAGGLE_API_TOKEN", "KAGGLE_KEY"):
        assert name + "=" not in so, name + " must not reach the child"
    assert "KAGGLE_USERNAME=fakeuser" in so  # only the secret ones are stripped


def test_keep_kaggle_flag_keeps_vars_but_still_masks(env, creds_dir, child):
    r = run(env, creds_dir, "--keep-kaggle", "--", sys.executable, str(child), "env")
    so, se = out_of(r)
    assert r.returncode == 0, se
    assert "KAGGLE_APITOKEN=***" in so and "KAGGLE_KEY=***" in so
    assert_clean(so + se)


@pytest.mark.parametrize("mode,var", [("split", "HF_Token"), ("split", "VAULT_READ_TOKEN"), ("split_bytes", "HF_Token"),
                                       ("split", "VAULT_PASSPHRASE"), ("split", "MY_API_KEY")])
def test_secret_split_across_two_writes_is_masked(env, creds_dir, child, mode, var):
    r = run(env, creds_dir, "--", sys.executable, str(child), mode, var)
    so, se = out_of(r)
    assert r.returncode == 0, se
    assert "***" in so
    assert_clean(so + se)


def test_encoded_forms_are_masked(env, creds_dir, child):
    for var in ("HF_Token", "VAULT_READ_TOKEN", "MY_API_KEY"):
        r = run(env, creds_dir, "--", sys.executable, str(child), "encodings", var)
        so, se = out_of(r)
        assert r.returncode == 0, se
        assert_clean(so + se)
        assert so.count("***") >= 6, so  # b64, b64url, quote, quote_plus, json, hex all replaced


def test_exit_codes_pass_through(env, creds_dir, child):
    for code in (0, 3, 42):
        r = run(env, creds_dir, "--", sys.executable, str(child), "exit", str(code))
        assert r.returncode == code, out_of(r)[1]


def test_non_utf8_output_does_not_crash(env, creds_dir, child):
    r = run(env, creds_dir, "--", sys.executable, str(child), "binary", "HF_Token")
    so, se = out_of(r)
    assert r.returncode == 0, se
    assert "�" in so and "UnicodeDecodeError" not in se and "Traceback" not in se
    assert_clean(so + se)


def test_odd_keys_and_two_values_per_line_not_printed(env, creds_dir, child):
    r = run(env, creds_dir, "--", sys.executable, str(child), "exit", "0")
    so, se = out_of(r)
    assert r.returncode == 0, se
    assert ODD not in se and ODD not in so and "hf_" "FAKEODD" not in se   # token used as a "key" name
    assert TWO_A not in se and TWO_B not in se
    assert "recognisable names" in se
    # two tokens on one line are each masked individually
    r = run(env, creds_dir, "--", sys.executable, "-c", f"print({TWO_A!r}); print({TWO_B!r}); print({ODD!r})")
    so, se = out_of(r)
    assert so.count("***") == 3 and TWO_A not in so and TWO_B not in so and ODD not in so


def test_pick_splits_two_values_on_one_line(tmp_path, env):
    d = tmp_path / "c2"; d.mkdir()
    (d / "x.txt").write_text(f"HF_Tokem={WRITE}\nClip_vault_HFToken={TWO_A}   Other={TWO_B}\nVAULT_PASSPHRASE={PASSPHRASE}\n")
    c = tmp_path / "c.py"; c.write_text("import os;print(os.environ['VAULT_READ_TOKEN'] == os.environ.get('X_EXPECT'))")
    e = dict(env, X_EXPECT=TWO_A)
    r = run(e, d, "--", sys.executable, "-c", "import os;print(len(os.environ['VAULT_READ_TOKEN']), ' ' in os.environ['VAULT_READ_TOKEN'])")
    so, se = out_of(r)
    assert so.strip() == f"{len(TWO_A)} False", (so, se)


def test_equal_read_and_write_tokens_refused(env, tmp_path, child):
    d = tmp_path / "eq"; d.mkdir()
    (d / "x.txt").write_text(f"HF_Tokem={WRITE}\nClip_vault_HFToken={WRITE}\nVAULT_PASSPHRASE={PASSPHRASE}\n")
    r = run(env, d, "--", sys.executable, str(child), "env")
    so, se = out_of(r)
    assert r.returncode != 0 and "equals write token" in se and so == ""
    assert WRITE not in se


def test_missing_values_refused(env, tmp_path, child):
    d = tmp_path / "miss"; d.mkdir(); (d / "x.txt").write_text(f"HF_Tokem={WRITE}\n")
    r = run(env, d, "--", sys.executable, str(child), "env")
    assert r.returncode != 0 and "missing" in out_of(r)[1]


# ---------- read-only check against a local stub of whoami-v2 ----------
class Stub(http.server.BaseHTTPRequestHandler):
    answers = {}
    def do_GET(self):
        tok = (self.headers.get("Authorization") or "").replace("Bearer ", "")
        body = self.answers.get(tok)
        code = 200 if body is not None else 401
        data = json.dumps(body if body is not None else {"error": "no"}).encode()
        self.send_response(code); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def log_message(self, *a): pass


@pytest.fixture
def whoami():
    srv = http.server.HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/whoami", Stub.answers
    srv.shutdown(); Stub.answers.clear()


def tokinfo(role=None, **fg):
    t = {}
    if role: t["role"] = role
    if fg: t["fineGrained"] = fg
    return {"name": "fakeuser", "auth": {"accessToken": t}}


def test_readonly_role_read_ok(env, creds_dir, child, whoami):
    url, ans = whoami; ans[READ] = tokinfo("read"); ans[WRITE] = tokinfo("write")
    r = run(dict(env, TEST_WHOAMI_URL=url), creds_dir, "--", sys.executable, str(child), "exit", "0")
    assert r.returncode == 0 and "WARNING" not in out_of(r)[1]


def test_readonly_finegrained_read_ok_and_check_mode(env, creds_dir, whoami):
    url, ans = whoami
    ans[READ] = tokinfo("fineGrained", scoped=[{"entity": {"type": "dataset"}, "permissions": ["repo.content.read"]}], **{"global": []})
    ans[WRITE] = tokinfo("write")
    r = run(dict(env, TEST_WHOAMI_URL=url), creds_dir, "--check")
    so, se = out_of(r)
    assert r.returncode == 0, se
    assert "VAULT_READ_TOKEN: read-only" in se and "HF_Token: valid, user fakeuser" in se
    assert_clean(so + se)


@pytest.mark.parametrize("info", [tokinfo("write"), tokinfo("admin"),
        tokinfo("fineGrained", scoped=[{"permissions": ["repo.content.read", "repo.write"]}]),
        tokinfo("fineGrained", **{"global": ["discussion.write"], "scoped": []})])
def test_write_capable_read_token_refused_in_run_and_check(env, creds_dir, child, whoami, info):
    url, ans = whoami; ans[READ] = info; ans[WRITE] = tokinfo("write")
    e = dict(env, TEST_WHOAMI_URL=url)
    r = run(e, creds_dir, "--", sys.executable, str(child), "exit", "0")
    assert r.returncode != 0 and "not read-only" in out_of(r)[1]
    r = run(e, creds_dir, "--check")
    assert r.returncode != 0 and "not read-only" in out_of(r)[1]


def test_undeterminable_readonly_is_warning_not_error(env, creds_dir, child, whoami):
    url, ans = whoami
    ans[READ] = {"name": "fakeuser", "auth": {"accessToken": {"displayName": "x"}}}  # no role
    r = run(dict(env, TEST_WHOAMI_URL=url), creds_dir, "--", sys.executable, str(child), "exit", "0")
    assert r.returncode == 0 and "WARNING" in out_of(r)[1]
    # whoami unreachable (closed port) is also only a warning
    r = run(env, creds_dir, "--", sys.executable, str(child), "exit", "0")
    assert r.returncode == 0 and "WARNING" in out_of(r)[1]


# ---------- temp dir: /dev/shm-style location, SIGTERM, stale sweep ----------
def fake_kaggle(tmp_path):
    b = tmp_path / "fakebin"; b.mkdir()
    k = b / "kaggle"; k.write_text(FAKE_KAGGLE.format(py=sys.executable, creds=CREDS)); k.chmod(0o755)
    return b


def vault_dirs(*bases):
    return [p for b in bases for p in Path(b).glob("vaultcreds-*")]


def test_download_uses_shm_dir_and_cleans_up(env, tmp_path, child):
    b = fake_kaggle(tmp_path); e = dict(env, PATH=f"{b}:{env['PATH']}")
    r = subprocess.run([sys.executable, str(WRAPPER), "--dataset", "fakeuser/kagglegpu1", "--", "python3", "site/hfvault/build_hfvault.py", "--help"],
                       env=e, capture_output=True, timeout=60)
    so, se = out_of(r)
    assert (b / "seen_dir").read_text().startswith(env["VAULTCREDS_SHM"] + "/vaultcreds-")
    assert not vault_dirs(env["VAULTCREDS_SHM"], env["TMPDIR"])
    assert_clean(so + se)


def test_sigterm_removes_temp_dir(env, tmp_path):
    b = fake_kaggle(tmp_path); e = dict(env, PATH=f"{b}:{env['PATH']}", FAKE_KAGGLE_SLEEP="1")
    p = subprocess.Popen([sys.executable, str(WRAPPER), "--dataset", "fakeuser/kagglegpu1", "--", "python3", "site/hfvault/build_hfvault.py", "--help"],
                         env=e, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        end = time.time() + 20
        while time.time() < end and not list(Path(env["VAULTCREDS_SHM"]).glob("vaultcreds-*/creds.txt")): time.sleep(0.05)
        assert vault_dirs(env["VAULTCREDS_SHM"]), "temp dir (with the fake creds) never appeared"
        p.send_signal(signal.SIGTERM)
        p.wait(timeout=20)
    finally:
        if p.poll() is None: p.kill()
    assert p.returncode == 128 + signal.SIGTERM
    assert not vault_dirs(env["VAULTCREDS_SHM"], env["TMPDIR"])


def test_sighup_removes_temp_dir(env, tmp_path):
    b = fake_kaggle(tmp_path); e = dict(env, PATH=f"{b}:{env['PATH']}", FAKE_KAGGLE_SLEEP="1")
    p = subprocess.Popen([sys.executable, str(WRAPPER), "--dataset", "fakeuser/kagglegpu1", "--", "python3", "site/hfvault/build_hfvault.py", "--help"],
                         env=e, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        end = time.time() + 20
        while time.time() < end and not list(Path(env["VAULTCREDS_SHM"]).glob("vaultcreds-*/creds.txt")): time.sleep(0.05)
        p.send_signal(signal.SIGHUP); p.wait(timeout=20)
    finally:
        if p.poll() is None: p.kill()
    assert not vault_dirs(env["VAULTCREDS_SHM"], env["TMPDIR"])


def test_stale_dirs_swept_fresh_kept(env, creds_dir, child, tmp_path):
    old = []
    for base in (env["VAULTCREDS_SHM"], env["TMPDIR"]):
        o = Path(base) / "vaultcreds-old"; o.mkdir(); (o / "creds.txt").write_text("x")
        t = time.time() - 1200; os.utime(o, (t, t)); old.append(o)
    fresh = Path(env["TMPDIR"]) / "vaultcreds-fresh"; fresh.mkdir()
    other = Path(env["TMPDIR"]) / "unrelated-old"; other.mkdir(); t = time.time() - 9999; os.utime(other, (t, t))
    r = run(env, creds_dir, "--", sys.executable, str(child), "exit", "0")
    assert r.returncode == 0, out_of(r)[1]
    assert not any(o.exists() for o in old)
    assert fresh.exists() and other.exists()


# ---------- unit tests on the masker ----------
@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("with_vault_creds_t", WRAPPER)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def test_masker_catches_secret_at_every_split_point(mod):
    secrets_ = mod.collect_secrets({"HF_Token": READ}, set())
    data = b"line one\nabc " + READ.encode() + b" tail\nxyz " + base64.b64encode(READ.encode()) + b"\nend"
    for i in range(len(data) + 1):
        m = mod.Masker(secrets_)
        out = m.feed(data[:i]) + m.feed(data[i:]) + m.flush()
        assert READ.encode() not in out and base64.b64encode(READ.encode()) not in out, i
        assert out.count(b"***") == 2, (i, out)


def test_masker_three_way_and_byte_by_byte(mod):
    secrets_ = mod.collect_secrets({"HF_Token": READ}, set())
    data = b"x" + READ.encode() + b"y" + READ.encode()
    m = mod.Masker(secrets_); out = b"".join(m.feed(data[i:i+1]) for i in range(len(data))) + m.flush()
    assert out == b"x***y***"


def test_collect_secrets_by_name_and_extra_tokens(mod, monkeypatch):
    monkeypatch.setenv("SOME_PASSWORD", "fake-pw-value-12345"); monkeypatch.setenv("HARMLESS", "fake-pw-value-67890")
    forms = mod.collect_secrets({}, {TWO_A}, {"Backup_Key": "fakebackupvalue1"})
    joined = b"\n".join(forms)
    assert b"fake-pw-value-12345" in joined and TWO_A.encode() in joined and b"fakebackupvalue1" in joined
    assert b"fake-pw-value-67890" not in joined


def test_classify_readonly_cases(mod):
    assert mod.classify_readonly(tokinfo("read"))[0] == "read"
    assert mod.classify_readonly(tokinfo("write"))[0] == "write"
    assert mod.classify_readonly({})[0] == "unknown" and mod.classify_readonly(None)[0] == "unknown"
    assert mod.classify_readonly(tokinfo("fineGrained"))[0] == "unknown"
    assert mod.classify_readonly(tokinfo("fineGrained", scoped=[{"permissions": ["repo.content.read", "inference.serverless.write"]}]))[0] == "write"


# ---------- load_credentials (importable API) ----------
WSCOPED = "hf_" "FAKEDATASETSCOPEDWRITEgggggggggg"

def test_load_credentials_from_dir_returns_values_names_and_mask_list_without_touching_env(mod, tmp_path, monkeypatch):
    (tmp_path / "c.txt").write_text(CREDS + f"Clip_vault_Write={WSCOPED}\n")
    before = dict(os.environ)
    c = mod.load_credentials(from_dir=str(tmp_path))
    assert c["values"]["HF_Token"] == WRITE and c["values"]["VAULT_READ_TOKEN"] == READ
    assert c["values"]["VAULT_WRITE_TOKEN"] == WSCOPED and c["names"]["VAULT_WRITE_TOKEN"] == "Clip_vault_Write"
    joined = b"\n".join(c["secrets"])
    for t in (WRITE, READ, WSCOPED):
        assert t.encode() in joined and base64.b64encode(t.encode()) in joined
    assert dict(os.environ) == before


def test_load_credentials_accepts_both_write_key_names_and_does_not_require_every_key(mod, tmp_path):
    (tmp_path / "c.txt").write_text(f"VAULT_WRITE_TOKEN={WSCOPED}\n")
    c = mod.load_credentials(from_dir=str(tmp_path))
    assert c["values"] == {"VAULT_WRITE_TOKEN": WSCOPED}


def test_load_credentials_default_dataset_is_lower_case_and_is_what_fetch_gets(mod, monkeypatch):
    seen = []
    monkeypatch.setattr(mod, "fetch", lambda ds: (seen.append(ds) or ({"HF_Token": WRITE}, set())))
    assert mod.DEFAULT_DATASET == "arvr7plays/kagglegpu1"
    mod.load_credentials(); mod.load_credentials("someone/else")
    assert seen == ["arvr7plays/kagglegpu1", "someone/else"]


# ---------- command allow-list (real credentials never reach an arbitrary command) ----------
def run_real(env, *cmd):
    return subprocess.run([sys.executable, str(WRAPPER), "--dataset", "fakeuser/kagglegpu1", "--", *cmd], env=env, capture_output=True, timeout=60)


@pytest.mark.parametrize("cmd", [("bash", "-c", "env"), ("sh", "-c", "env"), ("env",), ("printenv",), ("python3", "-c", "import os"),
        ("python3", "-m", "http.server"), ("python3", "-"), ("python3", "/tmp/evil.py"), ("python3", "site/hfvault/tests/test_with_vault_creds.py"),
        ("python3", "../site/hfstatic/deploy_static.py"), ("node", "-e", "1"), ("perl", "-e", "1"), ("python3",), ("cat", "x")])
def test_disallowed_commands_refused_before_any_credential_is_read(env, tmp_path, cmd):
    b = fake_kaggle(tmp_path); e = dict(env, PATH=f"{b}:{env['PATH']}")
    r = run_real(e, *cmd)
    so, se = out_of(r)
    assert r.returncode != 0 and so == ""
    assert "refus" in se and "build_hfvault.py" in se and "vault_sync.py" in se   # names the allowed list
    assert not (b / "seen_dir").exists(), "Kaggle must not even be called for a refused command"


def test_allowed_scripts_pass_the_check_and_run(env, tmp_path):
    mod = importlib.util.spec_from_file_location("wvc2", WRAPPER); m = importlib.util.module_from_spec(mod); mod.loader.exec_module(m)
    repo = HERE.parents[1]
    for s in m.ALLOWED_SCRIPTS:
        assert (repo / s).is_file(), s
        m.check_command(["python3", str(repo / s), "--help"])
        m.check_command([sys.executable, s])
    b = fake_kaggle(tmp_path); e = dict(env, PATH=f"{b}:{env['PATH']}", PYTHONPATH="")
    r = subprocess.run([sys.executable, str(WRAPPER), "--dataset", "fakeuser/kagglegpu1", "--", "python3", "site/hfstatic/build_static.py", "--help"],
                       env=e, capture_output=True, timeout=60, cwd=str(repo))
    so, se = out_of(r)
    assert (b / "seen_dir").exists() and "refus" not in se, se   # passed the allow-list, credentials were fetched
    assert_clean(so + se)


def test_from_dir_test_escape_still_runs_any_command(env, creds_dir, child):
    r = run(env, creds_dir, "--", sys.executable, "-c", "print('ok')")
    assert r.returncode == 0 and out_of(r)[0].strip() == "ok"


def test_whoami_url_override_is_gone(mod):
    assert mod.WHOAMI_URL == "https://huggingface.co/api/whoami-v2"
    src = WRAPPER.read_text()
    assert "VAULTCREDS_WHOAMI_URL" not in src and "os.environ.get(\"TEST_WHOAMI_URL" not in src


def test_whoami_ignores_env_override(mod, monkeypatch):
    seen = []
    monkeypatch.setenv("VAULTCREDS_WHOAMI_URL", "http://127.0.0.1:1/evil")
    monkeypatch.setattr(mod.urllib.request, "urlopen", lambda req, timeout=0: (seen.append(req.full_url), (_ for _ in ()).throw(OSError("x")))[1])
    mod.hf_whoami("hf_" "FAKEREADTOKENbbbbbbbbbbbbbbbbbbbbbb")
    assert seen == ["https://huggingface.co/api/whoami-v2"]


@pytest.mark.parametrize("pw", ["abc", "x", "1234"])
def test_short_passphrase_is_always_masked(mod, tmp_path, env, child, pw):
    forms = b"\n".join(mod.collect_secrets({"VAULT_PASSPHRASE": pw}, set()))
    assert pw.encode() in forms
    d = tmp_path / "sp"; d.mkdir()
    (d / "x.txt").write_text(f"HF_Tokem={WRITE}\nClip_vault_HFToken={READ}\nVAULT_PASSPHRASE={pw}\n")
    r = run(env, d, "--", sys.executable, str(child), "env")
    so, se = out_of(r)
    assert r.returncode == 0, se
    assert "VAULT_PASSPHRASE=***" in so
