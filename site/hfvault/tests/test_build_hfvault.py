"""Tests for site/hfvault/build_hfvault.py: passphrase policy, OUT_DIR deletion guard, index-merge error handling. FAKE data only."""
import importlib.util, json, os
from pathlib import Path
import pytest

pytest.importorskip("cryptography")
HERE = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def b():
    spec = importlib.util.spec_from_file_location("build_hfvault_t", HERE / "build_hfvault.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


GOOD = ["mango violet harbor quartz lantern", "orbit-pickle-trumpet-glacier-hammock", "Zebra.Quill.Meadow.Anvil.Fossil"]
BAD = {
    "password password password password": "repeated",
    "aaaa aaaa aaaa aaaaaaaa": "repeated/same-letter",
    "mango violet harbor mango violet harbor": "repeated",
    "mango red sun fig": "short (<20 chars)",
    "mango violet harbor": "3 words",
    "zzzzzz mango violet harbor quartz": "all-same-letter word",
    "correct horse battery staple extra": "common phrase",
    "to be or not to be that is": "common phrase",
    "never gonna give you up ever": "common phrase",
    "one two three four five": "sequence phrase",
    "mango violet harbor password lantern": "password word",
    "": "empty",
}


@pytest.mark.parametrize("p", GOOD)
def test_good_passphrases_accepted(b, p):
    assert b.passphrase_problem(p) is None
    b.check_passphrase(p)


@pytest.mark.parametrize("p", list(BAD))
def test_bad_passphrases_rejected(b, p, capsys):
    assert b.passphrase_problem(p), BAD[p]
    with pytest.raises(SystemExit):
        b.check_passphrase(p)
    err = capsys.readouterr().err
    assert p.strip() == "" or p not in err  # the rejected passphrase is never echoed


def test_hint_without_wordlist_says_so_and_invents_nothing(b, monkeypatch):
    monkeypatch.setattr(b, "wordlist_candidates", lambda: ["", "/nonexistent/words"])
    h = b.passphrase_hint()
    assert "No usable wordlist" in h and "secrets.choice" in h and "python3 -c" not in h


def test_hint_with_wordlist_gives_command(b, monkeypatch, tmp_path):
    wl = tmp_path / "words.txt"; wl.write_text("\n".join(f"{c1}{c2}{c3}word" for c1 in "abcdefghijklmnopqrstuvwxyz" for c2 in "abcdefghijklmnopqrstuvwxyz" for c3 in "abcdefgh"))
    monkeypatch.setattr(b, "wordlist_candidates", lambda: [str(wl)])
    h = b.passphrase_hint()
    assert "python3 -c" in h and "import secrets" in h and str(wl) in h and "bits" in h
    small = tmp_path / "small.txt"; small.write_text("alpha\nbravo\ncharlie\n")
    monkeypatch.setattr(b, "wordlist_candidates", lambda: [str(small)])
    assert "No usable wordlist" in b.passphrase_hint()


# ---------- OUT_DIR guard ----------
def test_out_dir_absent_or_empty_ok(b, tmp_path):
    assert b.prepare_out_dir(tmp_path / "new") == (tmp_path / "new").resolve()
    (tmp_path / "e").mkdir(); b.prepare_out_dir(tmp_path / "e")


def test_out_dir_nonempty_without_marker_refused(b, tmp_path):
    d = tmp_path / "precious"; d.mkdir(); (d / "keep.txt").write_text("x")
    with pytest.raises(SystemExit): b.prepare_out_dir(d)
    assert (d / "keep.txt").exists()


def test_out_dir_with_marker_is_cleaned(b, tmp_path):
    d = tmp_path / "built"; d.mkdir(); (d / b.MARKER).write_text("m"); (d / "old.bin").write_text("x")
    b.prepare_out_dir(d)
    assert not d.exists() or not any(d.iterdir())


def test_out_dir_marker_must_be_a_regular_file(b, tmp_path):
    d = tmp_path / "fake"; d.mkdir(); (d / "other").write_text("x"); (d / b.MARKER).mkdir()
    with pytest.raises(SystemExit): b.prepare_out_dir(d)
    assert (d / "other").exists()


def test_out_dir_never_cwd_repo_parent_or_root(b, tmp_path, monkeypatch):
    work = tmp_path / "work"; (work / "sub").mkdir(parents=True)
    (work / b.MARKER).write_text("even with a marker")   # a marker must not make a parent of cwd deletable
    (work / "sub" / "f").write_text("x")
    monkeypatch.chdir(work / "sub")
    for bad in (".", str(work / "sub"), str(work), "..", str(work.parent), str(b.REPO), str(b.REPO.parent), str(b.HERE), "/", str(Path.home())):
        with pytest.raises(SystemExit): b.prepare_out_dir(bad)
    assert (work / "sub" / "f").exists() and b.REPO.exists()


def test_out_dir_symlink_and_file_refused(b, tmp_path):
    t = tmp_path / "t"; t.mkdir(); (t / b.MARKER).write_text("m"); (t / "f").write_text("x")
    (tmp_path / "ln").symlink_to(t)
    with pytest.raises(SystemExit): b.prepare_out_dir(tmp_path / "ln")
    (tmp_path / "afile").write_text("x")
    with pytest.raises(SystemExit): b.prepare_out_dir(tmp_path / "afile")
    assert (t / "f").exists()


# ---------- index merge ----------
hub = pytest.importorskip("huggingface_hub")
from huggingface_hub.errors import EntryNotFoundError, LocalEntryNotFoundError, RepositoryNotFoundError  # noqa: E402


def _raise(exc):
    def f(*a, **k): raise exc
    return f


def _make(cls, msg="boom"):
    try: return cls(msg)
    except TypeError:
        e = cls.__new__(cls); Exception.__init__(e, msg); return e


ITEMS = [{"id": "s2/a", "stream": "s2"}]


def test_merge_first_upload_when_not_found(b):
    for cls in (EntryNotFoundError, RepositoryNotFoundError):
        assert b.merge_remote_index("o/d", "hf_" "FAKE", ITEMS, download=_raise(_make(cls))) == ITEMS


@pytest.mark.parametrize("exc", [RuntimeError("401 unauthorized"), ConnectionError("net down"), TimeoutError("t"), PermissionError("p")])
def test_merge_aborts_on_other_errors(b, exc):
    with pytest.raises(SystemExit): b.merge_remote_index("o/d", "hf_" "FAKE", ITEMS, download=_raise(exc))


def test_merge_aborts_on_offline_local_entry_error(b):
    with pytest.raises(SystemExit): b.merge_remote_index("o/d", "hf_" "FAKE", ITEMS, download=_raise(_make(LocalEntryNotFoundError)))


def test_merge_aborts_on_corrupt_remote_index(b, tmp_path):
    p = tmp_path / "index.json"; p.write_text("{not json")
    with pytest.raises(SystemExit): b.merge_remote_index("o/d", "hf_" "FAKE", ITEMS, download=lambda *a, **k: str(p))
    p.write_text(json.dumps({"nope": 1}))
    with pytest.raises(SystemExit): b.merge_remote_index("o/d", "hf_" "FAKE", ITEMS, download=lambda *a, **k: str(p))


def test_merge_keeps_old_clips(b, tmp_path):
    p = tmp_path / "index.json"
    p.write_text(json.dumps({"clips": [{"id": "s1/x", "stream": "s1"}, {"id": "s2/a", "stream": "s2", "old": True}]}))
    out = b.merge_remote_index("o/d", "hf_" "FAKE", ITEMS, download=lambda *a, **k: str(p))
    assert [c["id"] for c in out] == ["s2/a", "s1/x"] and "old" not in out[0]


# ---------- v2 metadata enrichment and upload merge safety (site with trash/edit support) ----------
import hashlib, os, re, shutil, subprocess, time  # noqa: E402

ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")


def _mp4(tmp_path):
    out = tmp_path / "src.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=64x48:r=10:d=1", "-pix_fmt", "yuv420p", "-y", str(out)], check=True)
    return out


@pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg/ffprobe missing")
def test_enrich_item_adds_all_v2_fields_with_ffprobe(b, tmp_path):
    f = _mp4(tmp_path)
    os.utime(f, (1700000000, 1700000000))
    it = b.enrich_item({"id": "stream 1/clip:a", "stream": "s", "title": "T", "dur": None, "score": 7, "video": "clips/x.mp4"}, f, now=1800000000)
    assert it["id"] == "stream_1_clip_a" and it["sha256"] == hashlib.sha256(f.read_bytes()).hexdigest() and it["size"] == f.stat().st_size
    assert it["added_at"] == "2023-11-14T22:13:20Z" and it["updated_at"] == "2027-01-15T08:00:00Z"  # source mtime, UTC, Z
    assert (it["width"], it["height"], it["codec"]) == (64, 48, "h264") and abs(it["fps"] - 10) < 0.1 and isinstance(it["bitrate"], int)
    assert 0.5 < it["dur"] < 1.5 and it["score"] == 7 and it["tags"] == [] and it["trashed_at"] is None and it["purge_after"] is None
    assert it["poster"] is None and it["post"] == "" and it["desc"] == "" and it["hook"] == ""


def test_enrich_item_without_ffprobe_uses_null_and_keeps_builder_values(b, tmp_path, monkeypatch):
    f = tmp_path / "a.mp4"; f.write_bytes(b"not a video")
    monkeypatch.setattr(b.shutil, "which", lambda n: None)
    it = b.enrich_item({"id": "a/b", "stream": "s", "title": "T", "dur": 44.5, "score": 3, "video": "clips/a_b.mp4", "poster": "clips/a_b.jpg"}, f)
    assert (it["width"], it["height"], it["fps"], it["codec"], it["bitrate"]) == (None,) * 5
    assert it["dur"] == 44.5 and it["poster"] == "clips/a_b.jpg" and ISO.fullmatch(it["added_at"]) and it["sha256"] == hashlib.sha256(b"not a video").hexdigest()


def test_probe_survives_ffprobe_garbage(b, tmp_path, monkeypatch):
    f = tmp_path / "a.mp4"; f.write_bytes(b"x")
    monkeypatch.setattr(b.shutil, "which", lambda n: "/usr/bin/ffprobe")
    monkeypatch.setattr(b.subprocess, "run", lambda *a, **k: type("R", (), {"stdout": b"{garbage"})())
    assert set(b.probe_video(f).values()) == {None}
    monkeypatch.setattr(b.subprocess, "run", lambda *a, **k: type("R", (), {"stdout": json.dumps({"streams": [{"codec_type": "video", "width": "x", "avg_frame_rate": "0/0", "bit_rate": "nan"}], "format": {"duration": "N/A"}}).encode()})())
    assert set(b.probe_video(f).values()) == {None}
    monkeypatch.setattr(b.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(TimeoutError()))
    assert set(b.probe_video(f).values()) == {None}


def test_index_doc_is_version_2_with_utc_timestamp(b):
    d = b.index_doc([{"id": "a"}])
    assert d["version"] == 2 and ISO.fullmatch(d["updated_at"]) and d["clips"] == [{"id": "a"}]


def _remote(tmp_path, clips):
    p = tmp_path / "index.json"; p.write_text(json.dumps({"version": 2, "clips": clips}))
    return lambda *a, **k: str(p)


def test_merge_keeps_remote_trash_state_added_at_and_admin_edits(b, tmp_path):
    local = [{"id": "s2_a", "stream": "s2", "title": "local title", "hook": "", "desc": "", "post": "", "tags": [], "added_at": "2026-11-17T00:00:00Z",
              "trashed_at": None, "purge_after": None, "size": 9, "sha256": "new", "width": 1080}]
    remote = [{"id": "s2_a", "stream": "s2", "title": "Edited in the site", "hook": "H", "desc": "D", "post": "P", "tags": ["x"], "added_at": "2026-01-01T00:00:00Z",
               "trashed_at": "2026-11-01T00:00:00Z", "purge_after": "2026-12-01T00:00:00Z", "size": 1, "sha256": "old", "extra": True}]
    out = b.merge_remote_index("o/d", "hf_" "FAKE", local, download=_remote(tmp_path, remote))
    c = out[0]
    assert (c["title"], c["hook"], c["desc"], c["post"], c["tags"]) == ("Edited in the site", "H", "D", "P", ["x"])
    assert c["added_at"] == "2026-01-01T00:00:00Z" and c["trashed_at"] == "2026-11-01T00:00:00Z" and c["purge_after"] == "2026-12-01T00:00:00Z"
    assert c["size"] == 9 and c["sha256"] == "new" and c["width"] == 1080 and "extra" not in c  # technical fields come from the source files
    assert b.upload_ignore_patterns(out) == ["clips/s2_a.mp4", "clips/s2_a.jpg"]  # a trashed clip's files are NOT re-uploaded to clips/


def test_merge_restore_in_the_site_is_kept_too(b, tmp_path):
    local = [{"id": "a", "stream": "s", "title": "t", "trashed_at": None, "purge_after": None}]
    remote = [{"id": "a", "stream": "s", "title": "t", "trashed_at": None, "purge_after": None}]
    out = b.merge_remote_index("o/d", "hf_" "FAKE", local, download=_remote(tmp_path, remote))
    assert out[0]["trashed_at"] is None and b.upload_ignore_patterns(out) == []


def test_merge_does_not_duplicate_v1_slash_ids_against_v2_safe_ids(b, tmp_path):
    local = [{"id": "s1_x", "stream": "s1", "title": "t"}]
    remote = [{"id": "s1/x", "stream": "s1", "title": "old v1"}, {"id": "s0/other", "stream": "s0"}]
    out = b.merge_remote_index("o/d", "hf_" "FAKE", local, download=_remote(tmp_path, remote))
    assert [c["id"] for c in out] == ["s1_x", "s0/other"] and out[0]["title"] == "old v1"  # same clip: one record, remote edits kept


def test_remote_hard_deleted_clip_comes_back_on_rerun_is_a_known_limit(b, tmp_path):
    out = b.merge_remote_index("o/d", "hf_" "FAKE", [{"id": "gone", "stream": "s"}], download=_remote(tmp_path, []))
    assert [c["id"] for c in out] == ["gone"]  # no tombstones: documented in SETUP.md (risks)


def test_safe_id_matches_the_site_rule(b):
    assert b.safe_id("a/b c:d") == "a_b_c_d" and b.safe_id("ok-1.2_x") == "ok-1.2_x"


def test_old_page_validates_dataset_paths_like_hubapi():
    """app.js must refuse poster/video paths from index.json that are not clips/<safe name>.mp4|jpg|jpeg (same SAFE as hubapi.js)."""
    import re, shutil, subprocess
    app = (HERE / "app.js").read_text()
    hub = (HERE.parent / "hfstatic" / "src" / "hubapi.js").read_text()
    lit = re.search(r"const SAFE\s*=\s*(/.*/);", hub).group(1)
    assert "const SAFE=" + lit + ";" in app
    assert "!SAFE.test(p)" in app and 'p.includes("..")' in app
    node = shutil.which("node")
    if node:
        js = f"const SAFE={lit};const ok=p=>p.includes('..')?false:SAFE.test(p);" \
             "const good=['clips/a.mp4','clips/b-1.jpg'],bad=['clips/../x.mp4','https://evil/x.mp4','clips/a.exe','/etc/passwd','clips/a/b.mp4','index.json'];" \
             "process.exit(good.every(ok)&&!bad.some(ok)?0:1)"
        assert subprocess.run([node, "-e", js]).returncode == 0


# ------------------------------------------------------------------ Library metadata helpers (D39)
def test_normalize_meta_defaults_limits_and_enums():
    import build_hfvault as bh
    m = bh.normalize_meta({"group": "g", "variant": "clean", "reaction": "mild", "reaction_note": "x" * 120, "why": "y " * 80, "rank": 3, "tier": "B"}, "s")
    assert m["kind"] == "reaction" and m["stream"] == "s" and len(m["reaction_note"]) == 80 and len(m["why"]) <= 110 and m["rank"] == 3
    d = bh.normalize_meta({"group": "g", "variant": "with-girl"}, "s")
    assert d["reaction"] == "unrated" and d["kind"] == "game" and d["tier"] is None and d["rank"] is None
    for bad in ({"reaction": "huge"}, {"variant": "x"}, {"tier": "D"}, {"rank": 0}, {"rank": "1"}, {"rank": True}, {"kind": "x"}):
        with pytest.raises(ValueError): bh.normalize_meta(bad, "s")


def test_apply_meta_fills_hook_and_stream_only_when_empty():
    import build_hfvault as bh
    it = {"id": "a", "stream": "s", "hook": "", "title": "T"}
    bh.apply_meta(it, {"stream": "other", "hook": "H", "rank": 2})
    assert it["hook"] == "H" and it["stream"] == "s" and it["rank"] == 2 and it["title"] == "T"


def test_merge_streams_recounts_sorts_and_keeps_remote_only(tmp_path):
    import build_hfvault as bh
    local = [{"id": "b", "title": "B", "channel": "c", "date": "2026-11-18", "url": "u", "thumb": "streams/b/thumb.jpg"}]
    remote = [{"id": "a", "title": "A", "date": "2026-11-01", "clip_count": 9}]
    clips = [{"stream": "b"}, {"stream": "b", "trashed_at": "x"}, {"stream": "a"}]
    out = bh.merge_streams(remote, local, clips, thumbs_ok=set())
    assert [s["id"] for s in out] == ["b", "a"] and out[0]["clip_count"] == 1 and out[1]["clip_count"] == 1 and "thumb" not in out[0]
    assert "thumb" in bh.merge_streams(remote, local, clips, thumbs_ok={"b"})[0]


def test_clipped_at_and_lang_contract(tmp_path):
    import build_hfvault as bh
    m = bh.normalize_meta({"group": "g", "variant": "clean", "clipped_at": "2026-11-18T14:02:12Z", "lang": "en"}, "s")
    assert m["clipped_at"] == "2026-11-18T14:02:12Z" and m["lang"] == "en"
    assert "clipped_at" not in bh.normalize_meta({"group": "g"}, "s") and "lang" not in bh.normalize_meta({}, "s")
    for bad in ({"clipped_at": "2026-11-18"}, {"clipped_at": "2026-11-18T14:02:12+01:00"}, {"lang": "English"}, {"lang": "EN"}):
        with pytest.raises(ValueError): bh.normalize_meta(bad, "s")
    assert bh.normalize_meta({"lang": "unknown"}, "s")["lang"] == "unknown"


def test_stream_records_language_never_guessed_and_merge_sorts_by_clipped_at(tmp_path):
    import build_hfvault as bh
    (tmp_path / "streams").mkdir()
    ids = {"2026-11-18_kai": ("en", "20261111"), "2026-11-14_gamer": ("hi", "20261114"), "2026-11-10_none": (None, "20261110")}
    (tmp_path / "streams/index.json").write_text(json.dumps({"streams": [{"slug": k, "title": k, **({"language": v[0]} if v[0] else {})} for k, v in ids.items()]}))
    for sid, (_, ud) in ids.items():
        d = tmp_path / "streams" / sid / "docs"; d.mkdir(parents=True); (d / "info.json").write_text(json.dumps({"upload_date": ud}))
    recs = {r["id"]: r for r in bh.stream_records(tmp_path)}
    assert (recs["2026-11-18_kai"]["lang"], recs["2026-11-18_kai"]["lang_name"]) == ("en", "English")
    assert recs["2026-11-14_gamer"]["lang_name"] == "Hindi" and recs["2026-11-10_none"]["lang"] == "unknown"
    clips = [{"stream": "2026-11-18_kai", "clipped_at": "2026-11-18T13:31:34Z"}, {"stream": "2026-11-18_kai", "clipped_at": "2026-11-18T14:09:00Z"},
             {"stream": "2026-11-14_gamer", "clipped_at": "2026-11-14T00:00:00Z"}, {"stream": "2026-11-14_gamer", "clipped_at": "2026-11-20T00:00:00Z", "trashed_at": "x"}]
    out = bh.merge_streams([], list(recs.values()), clips)
    assert out[0]["id"] == "2026-11-18_kai" and out[0]["clipped_at"] == "2026-11-18T14:09:00Z" and out[1]["clipped_at"] == "2026-11-14T00:00:00Z"  # newest clip, trash ignored
    # the stream with the OLDER YouTube date but clipped later comes first
    late = [{"stream": "2026-11-14_gamer", "clipped_at": "2026-11-19T10:00:00Z"}]
    assert bh.merge_streams([], list(recs.values()), clips[:2] + late)[0]["id"] == "2026-11-14_gamer"
    # old data without clipped_at falls back to date (YouTube upload date)
    old = bh.merge_streams([{"id": "z", "date": "2026-11-17"}], [recs["2026-11-18_kai"]], [])
    assert [s["id"] for s in old] == ["z", "2026-11-18_kai"]   # kai: date 2026-11-11, no clipped_at -> by date
