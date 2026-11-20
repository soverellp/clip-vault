"""Tests for site/hfvault/with_bw_creds.py with a MOCK `bw` on PATH. Every credential here is FAKE; no network."""
import json, os, stat, subprocess, sys, textwrap
from pathlib import Path
import pytest

HERE = Path(__file__).resolve().parent.parent
WRAPPER = HERE / "with_bw_creds.py"
sys.path.insert(0, str(HERE))
import with_bw_creds as W  # noqa: E402

WRITE = "hf_" "FAKEWRITEbwtokenaaaaaaaaaaaaaaaaaa"
READ = "hf_" "FAKEREADbwtokenbbbbbbbbbbbbbbbbbbb"
PASS = "fake pass phrase alpha"
NOTE = "KGAT_" "FAKEnotevalueccccccccccccccccc"
MASTER, CSECRET, SESSIONKEY = "fakemasterpw-12345", "fakeclientsecret-98765", "fakesessionkey-ZZZ111"

MOCK = f'''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
log = os.environ["MOCK_LOG"]
rec = {{"args": a, "session": os.environ.get("BW_SESSION"), "appdir": os.environ.get("BITWARDENCLI_APPDATA_DIR"),
        "mode": oct(os.stat(os.environ["BITWARDENCLI_APPDATA_DIR"]).st_mode & 0o777)}}
open(log, "a").write(json.dumps(rec) + "\\n")
cmd = a[0]
if cmd == "login":
    if os.environ.get("BW_CLIENTSECRET") != "{CSECRET}" or os.environ.get("MOCK_BAD_LOGIN"):
        sys.stderr.write("client_id or client_secret is incorrect {CSECRET}\\n"); sys.exit(1)
elif cmd == "unlock":
    if a[1:] != ["--passwordenv", "BW_PASSWORD", "--raw"] or os.environ.get("BW_PASSWORD") != "{MASTER}":
        sys.stderr.write("Invalid master password.\\n"); sys.exit(1)
    sys.stdout.write("{SESSIONKEY}")
elif cmd == "list":
    if os.environ.get("BW_SESSION") != "{SESSIONKEY}": sys.stderr.write("not unlocked\\n"); sys.exit(1)
    sys.stdout.write(open(os.environ["MOCK_ITEMS"]).read())
'''

def item(name, pw=None, typ=1, notes=None, user="someuser"):
    return {"name": name, "type": typ, "notes": notes, "login": {"username": user, "password": pw} if typ == 1 else None}

ITEMS = [item("HF_Tokem", WRITE), item("Clip_vault_HFToken", READ), item("VAULT_PASSPHRASE", PASS),
         item("KAGGLE_USERNAME", "arvrfake"), item("NOTE_TOKEN", typ=2, notes=NOTE + "\n"),
         item("not a valid name", "zzzzzzzz"), item("BW_PASSWORD", "evil-override"), item("PATH", "/evil"), item("EMPTY", "")]

CHILD = textwrap.dedent('''
    import os, sys
    for k in ("HF_Token","HF_Tokem","VAULT_READ_TOKEN","VAULT_PASSPHRASE","KAGGLE_USERNAME","NOTE_TOKEN","BW_PASSWORD",
              "BW_CLIENTID","BW_SESSION"):
        print(k, "SET" if os.environ.get(k) else "unset")
    print("PATH_OK", os.environ.get("PATH") != "/evil")
    print("echo", os.environ["HF_Token"], os.environ["VAULT_PASSPHRASE"], os.environ["NOTE_TOKEN"])
    sys.stdout.flush(); sys.exit(int(os.environ.get("RC", "0")))
''')

@pytest.fixture
def env(tmp_path, monkeypatch):
    bindir = tmp_path / "bin"; bindir.mkdir()
    bw = bindir / "bw"; bw.write_text(MOCK); bw.chmod(bw.stat().st_mode | stat.S_IXUSR)
    items = tmp_path / "items.json"; items.write_text(json.dumps(ITEMS))
    script = tmp_path / "child.py"; script.write_text(CHILD)
    for k in ("HF_Token", "HF_Tokem", "HF_TOKEN", "VAULT_READ_TOKEN", "VAULT_PASSPHRASE", "KAGGLE_USERNAME", "NOTE_TOKEN"):
        monkeypatch.delenv(k, raising=False)  # the real session may have them set
    monkeypatch.setenv("PATH", f"{bindir}:{os.environ['PATH']}")
    monkeypatch.setenv("MOCK_LOG", str(tmp_path / "log")); monkeypatch.setenv("MOCK_ITEMS", str(items))
    monkeypatch.setenv("BW_CLIENTID", "user.fake-id"); monkeypatch.setenv("BW_CLIENTSECRET", CSECRET)
    monkeypatch.setenv("BW_PASSWORD", MASTER); monkeypatch.setenv("VAULTCREDS_SHM", "")
    monkeypatch.setattr(W, "REPO", tmp_path); monkeypatch.setattr(W, "ALLOWED_SCRIPTS", ("child.py",))
    monkeypatch.setenv("TMPDIR", str(tmp_path)); import tempfile; tempfile.tempdir = str(tmp_path)
    yield tmp_path
    tempfile.tempdir = None

def calls(tmp): return [json.loads(l) for l in (tmp / "log").read_text().splitlines()] if (tmp / "log").exists() else []

def run(env, capsys, *args, rc=None):
    code = W.main(list(args)) if True else None
    out = capsys.readouterr()
    return code, out.out, out.err

def assert_clean(tmp, out, err):
    text = out + err
    for s in (WRITE, READ, PASS, NOTE, MASTER, CSECRET, SESSIONKEY, "evil-override"): assert s not in text
    names = [c["args"][0] for c in calls(tmp)]
    assert names[-2:] == ["lock", "logout"]
    for c in calls(tmp): assert not Path(c["appdir"]).exists()
    assert not list(tmp.glob("bwcreds-*"))

def test_flow_mapping_masking_cleanup(env, capsys):
    code, out, err = run(env, capsys, "--skip-readonly-check", "--", "python3", "child.py")
    assert code == 0
    assert "HF_Token SET" in out and "HF_Tokem unset" in out and "VAULT_READ_TOKEN SET" in out
    assert "VAULT_PASSPHRASE SET" in out and "KAGGLE_USERNAME SET" in out and "NOTE_TOKEN SET" in out
    assert "BW_PASSWORD unset" in out and "BW_CLIENTID unset" in out and "BW_SESSION unset" in out
    assert "PATH_OK True" in out and "echo *** *** ***" in out
    assert "loaded 5 item(s)" in err and "HF_Tokem" in err and "Clip_vault_HFToken" in err
    assert_clean(env, out, err)
    cs = calls(env)
    assert [c["args"][0] for c in cs] == ["login", "unlock", "list", "lock", "logout"]
    assert cs[0]["args"] == ["login", "--apikey"] and cs[0]["mode"] == "0o700"
    assert cs[2]["session"] == SESSIONKEY and cs[0]["session"] is None
    assert all(SESSIONKEY not in a for c in cs for a in c["args"]) and all(MASTER not in a for c in cs for a in c["args"])

def test_exit_code_passthrough(env, capsys, monkeypatch):
    monkeypatch.setenv("RC", "7")
    code, out, err = run(env, capsys, "--skip-readonly-check", "--", "python3", "child.py")
    assert code == 7; assert_clean(env, out, err)

def test_only_and_alias(env, capsys):
    code, out, err = run(env, capsys, "--only", "HF_Token,VAULT_PASSPHRASE,NOTE_TOKEN", "--skip-readonly-check", "--", "python3", "child.py")
    assert code == 0 and "VAULT_READ_TOKEN unset" in out and "KAGGLE_USERNAME unset" in out and "HF_Token SET" in out
    assert "loaded 3 item(s)" in err; assert_clean(env, out, err)

def test_only_missing_item(env, capsys):
    with pytest.raises(SystemExit) as e: W.main(["--only", "NOPE", "--", "python3", "child.py"])
    assert "NOPE is missing" in str(e.value); out = capsys.readouterr()
    assert_clean(env, out.out, out.err)

def test_list_names_only(env, capsys):
    code, out, err = run(env, capsys, "--list")
    assert code == 0 and "HF_Tokem" in out and "VAULT_PASSPHRASE" in out and "not a valid name" not in out
    assert "someuser" not in out + err; assert_clean(env, out, err)

def test_empty_command_refused(env, capsys):
    with pytest.raises(SystemExit) as e: W.main(["--"])
    assert "no command" in str(e.value) and calls(env) == []

def test_disallowed_command_refused_before_login(env, capsys):
    for cmd in (["bash", "-c", "env"], ["python3", "-c", "print(1)"], ["python3", "other.py"]):
        with pytest.raises(SystemExit): W.main(["--", *cmd])
    assert calls(env) == []

@pytest.mark.parametrize("drop", ["BW_CLIENTID", "BW_CLIENTSECRET", "BW_PASSWORD"])
def test_missing_bw_vars(env, monkeypatch, drop):
    monkeypatch.delenv(drop)
    with pytest.raises(SystemExit) as e: W.main(["--", "python3", "child.py"])
    assert drop in str(e.value) and calls(env) == []

def test_wrong_master_password(env, monkeypatch, capsys):
    monkeypatch.setenv("BW_PASSWORD", "fakewrongpassword")
    with pytest.raises(SystemExit) as e: W.main(["--", "python3", "child.py"])
    assert "unlock failed" in str(e.value) and "fakewrongpassword" not in str(e.value)
    assert [c["args"][0] for c in calls(env)][-2:] == ["lock", "logout"]
    assert not list(env.glob("bwcreds-*"))

def test_bad_login_masks_secret(env, monkeypatch):
    monkeypatch.setenv("MOCK_BAD_LOGIN", "1")
    with pytest.raises(SystemExit) as e: W.main(["--", "python3", "child.py"])
    assert "login failed" in str(e.value) and CSECRET not in str(e.value)
    assert not list(env.glob("bwcreds-*"))

def test_read_equals_write_refused(env, capsys):
    Path(os.environ["MOCK_ITEMS"]).write_text(json.dumps([item("HF_Tokem", WRITE), item("Clip_vault_HFToken", WRITE)]))
    with pytest.raises(SystemExit) as e: W.main(["--skip-readonly-check", "--", "python3", "child.py"])
    assert "equals write token" in str(e.value) and WRITE not in str(e.value)
    assert not list(env.glob("bwcreds-*"))

def test_write_scoped_read_token_refused(env, monkeypatch):
    monkeypatch.setattr(W.wvc, "hf_whoami", lambda tok: ({"auth": {"accessToken": {"role": "write"}}}, None))
    with pytest.raises(SystemExit) as e: W.main(["--", "python3", "child.py"])
    assert "not read-only" in str(e.value)

def test_bw_missing(env, monkeypatch):
    monkeypatch.setenv("PATH", "/nonexistent")
    with pytest.raises(SystemExit) as e: W.main(["--", "python3", "child.py"])
    assert "`bw` is not installed" in str(e.value)

def test_sigterm_handler_unwinds(env):
    import signal
    W.wvc.install_signal_handlers()
    h = signal.getsignal(signal.SIGTERM)
    with pytest.raises(SystemExit) as e: h(signal.SIGTERM, None)
    assert e.value.code == 143

def test_cli_refuses_empty_and_missing_vars():
    e = {k: v for k, v in os.environ.items() if not k.startswith("BW_")}
    r = subprocess.run([sys.executable, str(WRAPPER), "--"], capture_output=True, text=True, env=e)
    assert r.returncode != 0 and "no command" in r.stderr
    r = subprocess.run([sys.executable, str(WRAPPER), "--list"], capture_output=True, text=True, env=e)
    assert r.returncode != 0 and "BW_CLIENTID" in r.stderr
