"""Tests for site/hfvault/check_creds.py with mocked HTTP / subprocess. All values are FAKE."""
import subprocess, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import check_creds as C  # noqa: E402

def acc(role, **kw): return {"name": "Soverellp", "auth": {"accessToken": {"role": role, **kw}}}
FG_W = acc("fineGrained", fineGrained={"scoped": [{"entity": {"type": "dataset", "name": C.DATASET}, "permissions": ["repo.content.read", "repo.write"]}]})
FG_R = acc("fineGrained", fineGrained={"scoped": [{"entity": {"type": "dataset", "name": C.DATASET}, "permissions": ["repo.content.read"]}]})

def test_analyse():
    assert C.analyse(acc("write"))["can_write_dataset"] is True
    assert C.analyse(acc("read"))["can_write_dataset"] is False
    assert C.analyse(FG_W)["can_write_dataset"] is True and C.analyse(FG_W)["fine"]
    assert C.analyse(FG_R)["can_write_dataset"] is False

def test_hf_readonly_rule(monkeypatch):
    monkeypatch.setattr(C, "whoami", lambda t: (FG_W, None))
    assert C.check_hf("VAULT_READ_TOKEN", "x", True)[1] is False
    assert C.check_hf("HF_Token", "x")[1] is True
    monkeypatch.setattr(C, "whoami", lambda t: (FG_R, None))
    assert C.check_hf("VAULT_READ_TOKEN", "x", True)[1] is True
    monkeypatch.setattr(C, "whoami", lambda t: (None, "401"))
    n, ok, why = C.check_hf("HF_Token", "x"); assert not ok and "401" in why

def test_passphrase_no_value():
    assert C.check_passphrase("alpha beta gamma delta epsilon")[1] is True
    n, ok, why = C.check_passphrase("short phrase here"); assert not ok and "short phrase" not in why
    assert C.check_passphrase("a" * 30)[1] is False

def test_kaggle_missing_cli(monkeypatch):
    monkeypatch.setattr(C, "_kaggle_bin", lambda: None)
    assert "pip install kaggle" in C.check_kaggle("K", "u", "t")[2]

def test_kaggle_results(monkeypatch):
    monkeypatch.setattr(C, "_kaggle_bin", lambda: "/x/kaggle")
    mk = lambda rc, err: (lambda *a, **k: subprocess.CompletedProcess(a, rc, "", err))
    monkeypatch.setattr(C.subprocess, "run", mk(0, "")); assert C.check_kaggle("K", "u", "SECRETTOKEN")[1] is True
    monkeypatch.setattr(C.subprocess, "run", mk(1, "401 Unauthorized SECRETTOKEN"))
    r = C.check_kaggle("K", "u", "SECRETTOKEN"); assert r[1] is False and "SECRETTOKEN" not in r[2]

def test_run_absent_and_no_leak(monkeypatch, capsys):
    monkeypatch.setattr(C, "whoami", lambda t: (FG_R, None))
    monkeypatch.setattr(C, "_kaggle_bin", lambda: None)
    monkeypatch.setattr(C.sys, "argv", ["x"])
    env = {"VAULT_READ_TOKEN": "hf_FAKESECRETVALUE", "VAULT_PASSPHRASE": "alpha beta gamma delta epsilon",
           "KAGGLE_USERNAME": "u", "KAGGLE_APITOKEN": "KGAT_FAKESECRET"}
    monkeypatch.setattr(C.os, "environ", env)
    rc = C.main(); out = capsys.readouterr().out
    assert "FAKESECRET" not in out and "alpha" not in out
    assert "absent" in out and "kaggle CLI missing" in out and rc == 1

def test_allowed_by_wrapper():
    import with_bw_creds as W
    assert "site/hfvault/check_creds.py" in W.ALLOWED_SCRIPTS
