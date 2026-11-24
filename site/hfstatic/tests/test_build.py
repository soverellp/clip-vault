"""pytest for build_static.py and deploy_static.py. Fake secrets only."""
import fnmatch, json, re, subprocess, sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import build_static as bs  # noqa: E402
import deploy_static as ds  # noqa: E402

TOKEN = "hf_" "FAKEREADTOKEN00000000000000000000"
GOOD = "copper lantern meadow quiver"
WEAK = "hunter2"


@pytest.fixture
def env():
    return {"VAULT_READ_TOKEN": TOKEN, "VAULT_PASSPHRASE": GOOD}


@pytest.fixture(autouse=True)
def no_info_copy(monkeypatch, tmp_path):
    monkeypatch.setattr(bs, "INFO_COPY", tmp_path / "info-copy.json")  # not the repo copy


def run_cli(args, env, tmp):
    import os
    e = {k: v for k, v in os.environ.items() if not k.startswith("VAULT_") and not k.startswith("HF_")}
    e.update(env)
    return subprocess.run([sys.executable, str(HERE / "build_static.py"), "--no-info-copy", "--out", str(tmp / "o"), *args], capture_output=True, text=True, env=e)


def test_roundtrip_decrypts_with_right_passphrase_only(env, tmp_path):
    out, _ = bs.build(tmp_path / "d", env=env)
    cfg = json.loads((out / "config.json").read_text())
    assert cfg["dataset"] == "Soverellp/clip-vault" and cfg["iter"] == 600000
    assert bs.decrypt_token(cfg, GOOD) == TOKEN
    with pytest.raises(Exception):
        bs.decrypt_token(cfg, "copper lantern meadow quivr")
    assert TOKEN not in (out / "config.json").read_text()


def test_salt_and_iv_are_fresh_each_build(env, tmp_path):
    a = json.loads((bs.build(tmp_path / "a", env=env)[0] / "config.json").read_text())
    b = json.loads((bs.build(tmp_path / "b", env=env)[0] / "config.json").read_text())
    assert a["salt"] != b["salt"] and a["iv"] != b["iv"] and a["token"] != b["token"]


@pytest.mark.parametrize("pw", ["password password password password", "aaaa bbbb", "correct horse battery staple", "one two three four five six",
                                "alpha alpha beta gamma delta eps"])
def test_default_rejects_weak(pw, env, tmp_path):
    with pytest.raises(SystemExit) as e:
        bs.build(tmp_path / "d", env={**env, "VAULT_PASSPHRASE": pw})
    assert "rejected" in str(e.value)
    assert not (tmp_path / "d" / "config.json").exists()


def test_four_distinct_words_20_chars_accepted(env, tmp_path):
    bs.build(tmp_path / "d", env={**env, "VAULT_PASSPHRASE": "granite harbor velvet comet"})


@pytest.mark.parametrize("tok", ["", "abc", "hf_ has space 12345", "xx_FAKEREADTOKEN0000000"])
def test_bad_token_refused(tok, env, tmp_path):
    with pytest.raises(SystemExit):
        bs.build(tmp_path / "d", env={**env, "VAULT_READ_TOKEN": tok})


@pytest.mark.parametrize("name", ["HF_Token", "VAULT_WRITE_TOKEN"])
def test_read_token_must_differ_from_write_token(name, env, tmp_path):
    with pytest.raises(SystemExit) as e:
        bs.build(tmp_path / "d", env={**env, name: TOKEN})
    assert "differ" in str(e.value)


def test_weak_flag_default_off_then_on(env, tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(bs, "INFO_COPY", tmp_path / "info-copy.json")
    e = {**env, "VAULT_PASSPHRASE": WEAK}
    with pytest.raises(SystemExit):
        bs.build(tmp_path / "d1", env=e)
    out, info = bs.build(tmp_path / "d2", env=e, weak=True, today="2026-11-18")
    err = capsys.readouterr().err
    assert "WEAK PASSPHRASE ACCEPTED" in err and "PUBLIC" in err and err.count("WARNING") >= 4
    assert WEAK not in err and WEAK not in capsys.readouterr().out
    assert info["weak_passphrase_accepted"] is True
    # the PUBLIC dist must never say the passphrase is weak (it would tell an attacker); only the repo-local copy records it
    pub = ((out / "README.md").read_text() + (out / "build-info.json").read_text()).lower()
    assert "weak" not in pub and "accepted by owner" not in pub
    assert "weak_passphrase_accepted" not in json.loads((out / "build-info.json").read_text())
    assert bs.decrypt_token(json.loads((out / "config.json").read_text()), WEAK) == TOKEN
    assert WEAK not in "".join(p.read_text(errors="ignore") for p in out.rglob("*") if p.is_file())
    assert "WEAK PASSPHRASE ACCEPTED BY OWNER on 2026-11-18" in json.loads((tmp_path / "info-copy.json").read_text())["note"]


def test_weak_flag_skips_only_strength_not_other_checks(env, tmp_path):
    with pytest.raises(SystemExit):  # empty passphrase still refused
        bs.build(tmp_path / "a", env={**env, "VAULT_PASSPHRASE": ""}, weak=True)
    with pytest.raises(SystemExit):  # bad token still refused
        bs.build(tmp_path / "b", env={**env, "VAULT_PASSPHRASE": WEAK, "VAULT_READ_TOKEN": "nope"}, weak=True)
    with pytest.raises(SystemExit):  # token == write token still refused
        bs.build(tmp_path / "c", env={**env, "VAULT_PASSPHRASE": WEAK, "HF_Token": TOKEN}, weak=True)


def test_cli_never_prints_passphrase_or_token(env, tmp_path):
    r = run_cli(["--accept-weak-passphrase"], {**env, "VAULT_PASSPHRASE": WEAK}, tmp_path)
    assert r.returncode == 0, r.stderr
    for text in (r.stdout, r.stderr):
        assert WEAK not in text and TOKEN not in text
    assert "WEAK PASSPHRASE ACCEPTED" in r.stderr
    r2 = run_cli([], {**env, "VAULT_PASSPHRASE": WEAK}, tmp_path)
    assert r2.returncode != 0 and WEAK not in r2.stdout + r2.stderr and "--accept-weak-passphrase" in r2.stderr


def test_default_build_info_says_not_weak(env, tmp_path):
    out, info = bs.build(tmp_path / "d", env=env)
    assert info["weak_passphrase_accepted"] is False and "WEAK" not in (out / "README.md").read_text()


def test_dist_shape(env, tmp_path):
    out, _ = bs.build(tmp_path / "d", env=env)
    html = (out / "index.html").read_text()
    assert html.index('<meta charset="utf-8">') < html.index("Content-Security-Policy") < html.index("framebust.js")
    for part in ["script-src 'self'", "connect-src 'self' https://huggingface.co https://*.hf.co", "img-src 'self' blob:", "media-src blob:",
                 "style-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]:
        assert part in html
    assert "data:" not in html.split("Content-Security-Policy")[1].split(">")[0]   # img-src data: was unused and is gone
    assert not re.search(r"<script(?![^>]*src=)", html) and "<style" not in html
    assert "/js/hubchrome.js" in html and "/css/static-mode.css" in html
    ar = (out / "js" / "autorefresh.js").read_text()   # live refresh ships, imported by hubchrome.js, no storage, no innerHTML
    assert "import './autorefresh.js'" in (out / "js" / "hubchrome.js").read_text() and "no-store" in (out / "js" / "hubapi.js").read_text()
    assert not re.search(r"localStorage|sessionStorage|innerHTML|indexedDB", ar)
    assert (out / "js" / "api.js").read_text().strip().endswith("export * from './hubapi.js';")
    readme = (out / "README.md").read_text()
    assert readme.startswith("---\n") and "sdk: static" in readme and "app_file: index.html" in readme
    assert not list(out.rglob("*.md")) == [] and not list(out.rglob("*.map"))
    assert not any(p.suffix == ".py" for p in out.rglob("*"))


def test_dist_copies_ui_instead_of_forking(env, tmp_path):
    out, _ = bs.build(tmp_path / "d", env=env)
    for f in ["main.js", "library.js", "drawer.js", "admin.js", "upload.js", "player.js"]:
        assert (out / "js" / f).read_bytes() == (bs.DEFAULT_UI / "js" / f).read_bytes()


def test_interface_check_fails_loudly(env, tmp_path):
    ui = tmp_path / "ui"
    import shutil
    shutil.copytree(bs.DEFAULT_UI, ui)
    (ui / "js" / "api.js").write_text((ui / "js" / "api.js").read_text() + "\nexport const brandNewCall = () => 1;\n")
    with pytest.raises(SystemExit) as e:
        bs.build(tmp_path / "d", ui=ui, env=env)
    assert "brandNewCall" in str(e.value)


def test_forbidden_api_in_ui_fails(env, tmp_path):
    import shutil
    ui = tmp_path / "ui"
    shutil.copytree(bs.DEFAULT_UI, ui)
    (ui / "js" / "dom.js").write_text((ui / "js" / "dom.js").read_text() + "\nlocalStorage.setItem('a','b');\n")
    with pytest.raises(SystemExit) as e:
        bs.build(tmp_path / "d", ui=ui, env=env)
    assert "forbidden" in str(e.value)


def test_inline_script_in_html_fails(env, tmp_path):
    import shutil
    ui = tmp_path / "ui"
    shutil.copytree(bs.DEFAULT_UI, ui)
    p = ui / "index.html"
    p.write_text(p.read_text().replace("</head>", "<script>alert(1)</script></head>"))
    with pytest.raises(SystemExit):
        bs.build(tmp_path / "d", ui=ui, env=env)


def test_out_dir_safety(env, tmp_path, monkeypatch):
    stray = tmp_path / "stray"
    stray.mkdir()
    (stray / "keep.txt").write_text("x")
    with pytest.raises(SystemExit):
        bs.build(stray, env=env)
    assert (stray / "keep.txt").exists()
    with pytest.raises(SystemExit):
        bs.build(HERE.parent, env=env)  # a parent of the repo content
    out, _ = bs.build(tmp_path / "ok", env=env)
    bs.build(out, env=env)  # rebuild over a marked dir is fine


def test_allow_list_only_dist_files(env, tmp_path):
    out, _ = bs.build(tmp_path / "d", env=env)
    for junk in [".env", "secrets.env", "notes.txt", "tests/test_x.js", "cookies.txt", "debug.log", "js/hubapi.test.js.map", "shot.png"]:
        p = out / junk
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x")
    files = ds.planned_files(out)
    assert {"index.html", "README.md", "config.json", "js/hubapi.js", "css/static-mode.css"} <= set(files)
    for junk in ["notes.txt", "cookies.txt", "debug.log", "shot.png", "build-info.json", ".env", "secrets.env", "tests/test_x.js"]:
        assert junk not in files
    assert not any(f.endswith(".map") for f in files)


def test_secret_scan_blocks_upload(env, tmp_path):
    out, _ = bs.build(tmp_path / "d", env=env)
    (out / "js" / "oops.js").write_text("const t='hf_" + "A" * 30 + "';")
    assert ds.scan_for_secrets(out, ds.planned_files(out)) == ["js/oops.js"]
    assert ds.scan_for_secrets(out, [f for f in ds.planned_files(out) if f != "js/oops.js"]) == []


def test_deploy_dry_run_prints_names_only(env, tmp_path, capsys, monkeypatch):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    ds.main(["--dist", str(tmp_path / "d"), "--dry-run"])
    out = capsys.readouterr().out
    assert "dry run" in out and TOKEN not in out and GOOD not in out


def test_deploy_passes_delete_patterns_limited_to_the_allow_list(env, tmp_path, monkeypatch):
    import huggingface_hub
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("HF_Token", "hf_" "FAKEACCOUNTTOKEN000000000000000000")
    seen = {}

    class FakeApi:
        def __init__(self, token=None): pass
        def create_repo(self, *a, **k): pass
        def upload_folder(self, **k): seen.update(k)

    monkeypatch.setattr(huggingface_hub, "HfApi", FakeApi)
    ds.main(["--dist", str(tmp_path / "d")])
    assert seen["delete_patterns"] == bs.DEPLOY_ALLOW and seen["allow_patterns"] == bs.DEPLOY_ALLOW
    assert seen["repo_type"] == "space" and "build-info.json" not in bs.DEPLOY_ALLOW


def test_delete_patterns_remove_stale_allow_listed_files_only(monkeypatch):
    """Drives huggingface_hub's own deletion planner (remote listing faked): stale deployed files go, everything else stays."""
    from huggingface_hub import HfApi
    remote = ["index.html", "README.md", "config.json", ".gitattributes", "js/hubapi.js", "js/old-renamed.js", "css/old.css",
              "fonts/gone.woff2", "assets/old.svg", "vendor/old.js", "notes.txt", "private/keep.txt", "build-info.json", "tests/x.js", ".env"]
    api = HfApi(token="hf_" "FAKE")
    monkeypatch.setattr(api, "list_repo_files", lambda **k: remote)
    got = sorted(o.path_in_repo for o in api._prepare_folder_deletions("o/n", "space", None, "", bs.DEPLOY_ALLOW))
    assert "js/old-renamed.js" in got and "css/old.css" in got and "fonts/gone.woff2" in got and "assets/old.svg" in got and "vendor/old.js" in got
    for keep in (".gitattributes", "notes.txt", "private/keep.txt", "build-info.json", "tests/x.js", ".env"):
        assert keep not in got


def test_public_space_readme_never_mentions_a_weak_passphrase(env, tmp_path):
    out, _ = bs.build(tmp_path / "d", env=dict(env, VAULT_PASSPHRASE=WEAK), weak=True)
    assert "weak" not in (out / "README.md").read_text().lower()
    assert "WEAK" not in (out / "build-info.json").read_text()


def _chrome_with(extra, tmp_path):
    import shutil
    # build copies hubchrome.js from src/, so test the check function directly on text
    return bs.forbidden_hit("hubchrome.js", (HERE / "src" / "hubchrome.js").read_text() + extra)


def test_real_hubchrome_passes_and_uses_only_pass_key():
    src = (HERE / "src" / "hubchrome.js").read_text()
    assert bs.forbidden_hit("hubchrome.js", src) is None
    assert src.count("localStorage") == 3 and "const PASS_KEY = 'cv.pass';" in src
    assert "sessionStorage" not in src


@pytest.mark.parametrize("extra", [
    "\nlocalStorage.setItem('other', v);\n", "\nlocalStorage.clear();\n", "\nwindow.localStorage.getItem(PASS_KEY);\n",
    "\nlocalStorage['cv.pass'];\n", "\nsessionStorage.setItem(PASS_KEY, v);\n", "\nindexedDB.open('x');\n", "\ndocument.cookie = 'a=b';\n",
    "\nlocalStorage.setItem(PASS_KEY, writeToken);\n", "\nconst k = localStorage;\n"])
def test_any_other_storage_use_fails(extra, tmp_path):
    assert _chrome_with(extra, tmp_path) is not None


def test_pass_key_calls_not_allowed_in_other_files_or_with_changed_key():
    snippet = "const PASS_KEY = 'cv.pass';\nlocalStorage.getItem(PASS_KEY);\n"
    assert bs.forbidden_hit("hubapi.js", snippet) is not None
    assert bs.forbidden_hit("hubchrome.js", snippet.replace("cv.pass", "cv.other")) is not None
    assert bs.forbidden_hit("hubchrome.js", snippet + "const PASS_KEY = 'cv.pass';\n") is not None  # key declared twice


def test_build_fails_when_hubchrome_gets_extra_storage(env, tmp_path, monkeypatch):
    import shutil
    fake = tmp_path / "hfstatic"
    shutil.copytree(HERE / "src", fake / "src")
    (fake / "src" / "hubchrome.js").write_text((HERE / "src" / "hubchrome.js").read_text() + "\nlocalStorage.setItem('x','y');\n")
    monkeypatch.setattr(bs, "HERE", fake)
    with pytest.raises(SystemExit) as e:
        bs.build(tmp_path / "d", env=env)
    assert "forbidden" in str(e.value)


def test_brand_png_is_deployed_but_other_pngs_are_not(env, tmp_path):
    out, _ = bs.build(tmp_path / "d", env=env)
    assert (out / "assets" / "brand" / "fragbag-96.png").is_file() and (out / "assets" / "brand" / "fragbag-192.png").is_file()  # the build copies the folder
    for stray in ["shot.png", "assets/shot.png", "assets/brand/notes.txt", "js/x.png"]:
        p = out / stray
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"\x89PNG")
    files = ds.planned_files(out)
    assert {"assets/brand/fragbag-96.png", "assets/brand/fragbag-192.png"} <= set(files)
    for stray in ["shot.png", "assets/shot.png", "assets/brand/notes.txt", "js/x.png"]:
        assert stray not in files


# ---------------------------------------------------------------- shortlist (admin-only star, _config/shortlist.json)
def test_shortlist_ships_and_both_api_modes_export_it(env, tmp_path):
    out, _ = bs.build(tmp_path / "d", env=env)
    assert (out / "js" / "shortlist.js").is_file()
    server = bs.exported_names((bs.DEFAULT_UI / "js" / "api.js").read_text())
    static = bs.exported_names((bs.HERE / "src" / "hubapi.js").read_text())
    assert {"listShortlist", "setShortlist"} <= server and {"listShortlist", "setShortlist"} <= static
    assert any(fnmatch.fnmatch("js/shortlist.js", pat) for pat in bs.DEPLOY_ALLOW)      # a --only patch of js/*.js includes it
    assert bs.forbidden_hit("shortlist.js", (out / "js" / "shortlist.js").read_text()) is None
    assert bs.forbidden_hit("hubapi.js", (out / "js" / "hubapi.js").read_text()) is None  # still no storage API, no innerHTML


def test_shortlist_write_uses_the_shortlist_token_and_its_own_commit_path():
    src = (bs.HERE / "src" / "hubapi.js").read_text()
    body = src.split("export async function setShortlist", 1)[1].split("export async function patchClip", 1)[0]
    assert "requireAdmin()" not in body and "writeToken" not in body            # no admin mode needed, never the admin write token
    assert "token: slToken" in body and "cfg.sl.dataset" in body and "parentCommit: rev" in body and "parseShortlistStrict" in body
    assert "action: on ? 'shortlist' : 'unshortlist'" in body                   # audit line in the same commit
    assert "token: readToken" not in body and "token: writeToken" not in body
    assert "localStorage" not in src and "sessionStorage" not in src


def test_config_carries_the_shortlist_token_only_encrypted(env, tmp_path):
    e = dict(env, VAULT_SHORTLIST_TOKEN="hf_" + "S" * 30)
    out, _ = bs.build(tmp_path / "d", env=e)
    raw = (out / "config.json").read_text()
    cfg = json.loads(raw)
    assert set(cfg) == {"v", "dataset", "iter", "salt", "iv", "token", "sl"} and set(cfg["sl"]) == {"dataset", "path", "iv", "token"}
    assert e["VAULT_SHORTLIST_TOKEN"] not in raw and e["VAULT_READ_TOKEN"] not in raw
    assert bs.decrypt_token(cfg, e["VAULT_PASSPHRASE"]) == e["VAULT_READ_TOKEN"]
    assert bs.decrypt_shortlist_token(cfg, e["VAULT_PASSPHRASE"]) == e["VAULT_SHORTLIST_TOKEN"]
    with pytest.raises(Exception):
        bs.decrypt_shortlist_token(cfg, "wrong wrong wrong wrong words")
    assert cfg["sl"]["iv"] != cfg["iv"]                                          # never reuse an iv under the same key


def test_config_without_a_shortlist_token_is_unchanged(env, tmp_path):
    out, _ = bs.build(tmp_path / "d", env=env)
    assert set(json.loads((out / "config.json").read_text())) == {"v", "dataset", "iter", "salt", "iv", "token"}


def test_shortlist_token_must_differ_from_the_read_token(env, tmp_path):
    with pytest.raises(SystemExit):
        bs.build(tmp_path / "d", env=dict(env, VAULT_SHORTLIST_TOKEN=env["VAULT_READ_TOKEN"]))


def test_python_uploaders_never_write_the_shortlist_file():
    for rel in ("site/hfvault/build_hfvault.py", ".claude/skills/clips/scripts/finalise.py"):
        txt = (bs.REPO / rel).read_text()
        assert "shortlist" not in txt.lower() and "_config/" not in txt, rel


def test_deploy_verify_decrypt_passes_with_the_right_passphrase_and_fails_with_a_wrong_one(env, tmp_path, monkeypatch):
    e = dict(env, VAULT_SHORTLIST_TOKEN="hf_" + "S" * 30)
    out, _ = bs.build(tmp_path / "d", env=e)
    for k, v in e.items():
        monkeypatch.setenv(k, v)
    assert ds.verify_config(out) is True
    monkeypatch.setenv("VAULT_PASSPHRASE", "totally different words here now")
    assert ds.verify_config(out) is False


# ---- D47: the per-viewer Post info switch may use localStorage in viewpref.js only, key cv.postmode only
def test_viewpref_passes_and_uses_only_its_key():
    src = (HERE.parent / "hfspace" / "static" / "js" / "viewpref.js").read_text()
    assert bs.forbidden_hit("viewpref.js", src) is None
    assert src.count("localStorage") == 6 and "const PL_KEY = 'cv.pl';" in src and "const PM_KEY = 'cv.postmode';" in src


@pytest.mark.parametrize("extra", ["\nlocalStorage.setItem('other', '1');\n", "\nlocalStorage.clear();\n", "\nwindow.localStorage.getItem(PM_KEY);\n", "\nlocalStorage.removeItem(PM_KEY);\n", "\nsessionStorage.getItem(PM_KEY);\n"])
def test_viewpref_any_other_storage_use_fails(extra):
    src = (HERE.parent / "hfspace" / "static" / "js" / "viewpref.js").read_text()
    assert bs.forbidden_hit("viewpref.js", src + extra) is not None


def test_pm_key_not_allowed_in_other_files():
    snippet = "const PM_KEY = 'cv.postmode';\nlocalStorage.getItem(PM_KEY);\n"
    assert bs.forbidden_hit("library.js", snippet) is not None and bs.forbidden_hit("viewpref.js", snippet) is None
