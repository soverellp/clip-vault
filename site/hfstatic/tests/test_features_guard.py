"""pytest (no network): feature-marker guard of deploy_static.py and the live md5 check of check_live_config.py."""
import hashlib, sys
from pathlib import Path
import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import check_live_config as clc  # noqa: E402
import deploy_static as ds  # noqa: E402

LIB, MOM = b"x teaser tpill vpill", b"y teaser"


def mkdist(tmp_path, lib=LIB, mom=MOM):
    (tmp_path / "js").mkdir()
    (tmp_path / "js/library.js").write_bytes(lib)
    (tmp_path / "js/moments.js").write_bytes(mom)
    return tmp_path


def fake(files):
    def f(url):
        name = url.split("/", 3)[3].split("?")[0]
        if name not in files: raise OSError("404")
        return files[name]
    return f


def test_required_list_has_teaser_for_both_files():
    r = clc.required()
    assert "teaser" in r["js/library.js"] and "teaser" in r["js/moments.js"]


def test_missing_markers_flags_old_build(tmp_path):
    assert clc.missing_markers(mkdist(tmp_path)) == []
    assert any("moments.js lacks 'teaser'" in x for x in clc.missing_markers(_old(tmp_path)))


def _old(tmp_path):
    d = tmp_path / "old"; d.mkdir()
    return mkdist(d, mom=b"old")


def test_real_dist_has_the_markers():
    assert clc.missing_markers(HERE / "dist") == []


def test_deploy_guard_message(tmp_path, monkeypatch):
    import shutil
    d = tmp_path / "dist"; shutil.copytree(HERE / "dist", d)
    (d / "js/moments.js").write_text("old build")
    with pytest.raises(SystemExit) as e:
        ds.main(["--no-build", "--dry-run", "--dist", str(d)])
    assert "REFUSING" in str(e.value.code) and "merge --no-edit origin/main" in str(e.value.code)


def test_compare_ok_and_mismatch(tmp_path):
    d = mkdist(tmp_path)
    ok, lines = clc.compare_features(d, fetch=fake({"js/library.js": LIB, "js/moments.js": MOM}))
    assert ok and all(l.startswith("ok") for l in lines) and hashlib.md5(LIB).hexdigest() in lines[0]
    ok, lines = clc.compare_features(d, fetch=fake({"js/library.js": b"old", "js/moments.js": MOM}))
    assert not ok and lines[0].startswith("MISMATCH") and "teaser 0" in lines[0]
    ok, lines = clc.compare_features(d, fetch=fake({"js/library.js": LIB}))
    assert not ok and "not fetchable" in lines[1]


def test_wait_retries_until_live_catches_up(tmp_path):
    d = mkdist(tmp_path); n = []
    def f(url):
        n.append(url)
        return b"old" if len(n) <= 4 else (LIB if "library" in url else MOM)
    ok, _ = clc.wait_features(d, fetch=f, sleep=lambda s: None)
    assert ok and len(n) > 4


def test_wait_gives_up(tmp_path):
    ok, _ = clc.wait_features(mkdist(tmp_path), fetch=fake({}), tries=3, sleep=lambda s: None)
    assert not ok


def test_features_cli_exit_codes(tmp_path, monkeypatch, capsys):
    import build_static as bs
    d = mkdist(tmp_path)
    monkeypatch.setattr(bs, "DEFAULT_OUT", d)
    monkeypatch.setattr(clc, "fetch_live", lambda p, b=None, fetch=None: {"js/library.js": LIB, "js/moments.js": MOM}[p])
    assert clc.main(["--features"]) == 0 and "VERIFIED" in capsys.readouterr().out
    monkeypatch.setattr(clc, "fetch_live", lambda p, b=None, fetch=None: b"old")
    assert clc.main(["--features"]) == 1 and "MISMATCH" in capsys.readouterr().out
