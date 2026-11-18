"""Clips: list, edit, upload, trash/restore/delete forever, purge, audit, read-only, concurrency, v1 compatibility."""
import hashlib
import json
import re
import subprocess
import time
import tracemalloc
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import admin
import common
import fakes
import store
from helpers import as_user, client, stale_session

ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")


def audit_lines(state):
    out = []
    for p in sorted(k for k in state.files if k.startswith("_audit/")):
        out += [json.loads(x) for x in state.files[p].decode().splitlines()]
    return out


def idx(state):
    return json.loads(state.files["index.json"])


def by_id(state, cid):
    return next(c for c in idx(state)["clips"] if c["id"] == cid)


# ---------------------------------------------------------------- list

def test_viewer_lists_active_clips_only_with_contract_shape():
    c, _ = as_user("viewer@example.com")
    r = c.get("/api/clips")
    d = r.json()
    assert r.status_code == 200 and set(d) == {"clips", "counts", "updated_at", "can_write"}
    assert [x["id"] for x in d["clips"]] == ["c1", "c2"] and d["counts"] == {"active": 2, "trash": 0} and d["can_write"] is True
    assert set(d["clips"][0]) == {"id", "stream", "title", "hook", "desc", "post", "tags", "dur", "score", "size", "width", "height", "fps",
                                  "codec", "bitrate", "sha256", "added_at", "updated_at", "video", "poster", "trashed_at", "purge_after"}
    assert ISO.fullmatch(d["updated_at"]) and ISO.fullmatch(d["clips"][0]["added_at"])  # UTC ISO-8601 with Z
    assert c.get("/api/clips?trash=1").status_code == 403


def test_admin_lists_trash_and_counts():
    c, _ = as_user("root@example.com")
    d = c.get("/api/clips").json()
    assert [x["id"] for x in d["clips"]] == ["c1", "c2"] and d["counts"] == {"active": 2, "trash": 1}
    t = c.get("/api/clips?trash=1").json()
    assert [x["id"] for x in t["clips"]] == ["t1"] and t["clips"][0]["trashed_at"] and ISO.fullmatch(t["clips"][0]["purge_after"])


def test_list_store_failure_is_502_without_details(env):
    env["state"].fail_reads = True
    store.invalidate()
    c, _ = as_user("root@example.com")  # env lists still sign in
    r = c.get("/api/clips")
    assert r.status_code == 502 and r.json()["error"] == "upstream_error"


# ---------------------------------------------------------------- edit

def test_patch_updates_metadata_and_audits_in_the_same_commit(env):
    c, hdr = as_user("root@example.com")
    n = len(env["state"].commits)
    r = c.patch("/api/clips/c1", json={"title": "New title", "hook": "H", "desc": "line1\nline2", "post": "P\tq", "stream": "s9", "tags": ["a", "b", "a", " "]}, headers=hdr)
    assert r.status_code == 200 and r.json()["ok"] is True
    clip = r.json()["clip"]
    assert clip["title"] == "New title" and clip["desc"] == "line1\nline2" and clip["tags"] == ["a", "b"] and clip["stream"] == "s9"
    assert ISO.fullmatch(clip["updated_at"]) and by_id(env["state"], "c1")["title"] == "New title"
    assert len(env["state"].commits) == n + 1  # ONE commit: index and audit together
    last = env["state"].commits[-1]
    assert last["audit"][0]["action"] == "edit" and last["audit"][0]["actor_email"] == "root@example.com"
    lines = audit_lines(env["state"])
    assert lines[-1]["clip_id"] == "c1" and ISO.fullmatch(lines[-1]["at"]) and "New title" not in json.dumps(lines[-1])
    assert c.get("/api/clips").json()["clips"][0]["title"] == "New title"  # the cache was invalidated by our own commit


@pytest.mark.parametrize("body,status", [
    ({}, 422), ({"nope": "x"}, 422), ({"title": ""}, 422), ({"title": "  \x00 "}, 422), ({"title": 5}, 422), ({"title": "x" * 201}, 422),
    ({"hook": "x" * 301}, 422), ({"desc": "x" * 2001}, 422), ({"post": "x" * 20001}, 422), ({"stream": "x" * 121}, 422),
    ({"tags": "a,b"}, 422), ({"tags": ["x"] * 21}, 422), ({"tags": ["x" * 41]}, 422), ({"tags": [1]}, 422), ({"title": None}, 422),
    ({"title": "x" * 200, "hook": "x" * 300, "desc": "x" * 2000, "post": "x" * 20000, "stream": "x" * 120, "tags": [f"t{i}" for i in range(20)]}, 200),
])
def test_patch_validation_limits(body, status):
    c, hdr = as_user("root@example.com")
    assert c.patch("/api/clips/c1", json=body, headers=hdr).status_code == status


def test_patch_strips_control_characters_keeps_newlines_where_multiline():
    c, hdr = as_user("root@example.com")
    r = c.patch("/api/clips/c1", json={"title": "a\x00b\x07c\r\nd\u202ee", "hook": "x\ny", "desc": "l1\r\nl2\x1b", "tags": ["t\x00ag"]}, headers=hdr)
    clip = r.json()["clip"]
    assert clip["title"] == "abc de" and clip["hook"] == "x y" and clip["desc"] == "l1\nl2" and clip["tags"] == ["tag"]


def test_patch_body_limits_and_content_type():
    c, hdr = as_user("root@example.com")
    assert c.patch("/api/clips/c1", content=json.dumps({"post": "é" * 20000}), headers={**hdr, "content-type": "application/json"}).status_code == 200
    big = json.dumps({"post": "x" * 170000})
    assert c.patch("/api/clips/c1", content=big, headers={**hdr, "content-type": "application/json"}).status_code == 413
    assert c.patch("/api/clips/c1", content='{"title":"x"}', headers={**hdr, "content-type": "text/plain"}).status_code == 415
    assert c.patch("/api/clips/c1", content="{bad", headers={**hdr, "content-type": "application/json"}).status_code == 422


@pytest.mark.parametrize("cid", ["missing", "a..b", ".hidden", "x" * 201, "a%2Fb", "..", "%2e%2e", "a b", "t1x"])
def test_ids_are_validated_and_unknown_ids_are_404(cid):
    c, hdr = as_user("root@example.com")
    for method, path, body in (("PATCH", f"/api/clips/{cid}", {"title": "x"}), ("POST", f"/api/clips/{cid}/trash", {}),
                               ("POST", f"/api/clips/{cid}/restore", {}), ("DELETE", f"/api/clips/{cid}", {"confirm": "x"})):
        r = c.request(method, path, json=body, headers=hdr)
        assert r.status_code in (404, 405), (method, cid, r.status_code)


def test_patch_trashed_clip_is_409(env):
    c, hdr = as_user("root@example.com")
    r = c.patch("/api/clips/t1", json={"title": "x"}, headers=hdr)
    assert r.status_code == 409 and r.json()["error"] == "in_trash"


# ---------------------------------------------------------------- trash lifecycle

def test_trash_restore_trash_delete_forever(env):
    st = env["state"]
    c, hdr = as_user("root@example.com")
    n = len(st.commits)
    r = c.post("/api/clips/c1/trash", json={}, headers=hdr)
    assert r.status_code == 200 and r.json()["clip"]["trashed_at"]
    clip = r.json()["clip"]
    t, p = datetime.strptime(clip["trashed_at"], "%Y-%m-%dT%H:%M:%SZ"), datetime.strptime(clip["purge_after"], "%Y-%m-%dT%H:%M:%SZ")
    assert p - t == timedelta(days=30)
    assert len(st.commits) == n + 1  # copy + delete + index + audit in ONE commit
    assert {"clips/c1.mp4", "trash/clips/c1.mp4", "clips/c1.jpg", "trash/clips/c1.jpg"} <= set(st.commits[-1]["paths"])
    assert st.commits[-1]["audit"][0]["action"] == "trash"
    assert "clips/c1.mp4" not in st.files and st.files["trash/clips/c1.mp4"] == fakes.MP4
    assert [x["id"] for x in c.get("/api/clips").json()["clips"]] == ["c2"]
    assert c.get("/api/files/clips/c1.mp4").status_code == 404 and c.get("/api/files/trash/clips/c1.mp4").status_code == 200
    assert c.post("/api/clips/c1/trash", json={}, headers=hdr).status_code == 409  # already trashed
    r = c.post("/api/clips/c1/restore", json={}, headers=hdr)
    assert r.status_code == 200 and r.json()["clip"]["trashed_at"] is None and r.json()["clip"]["purge_after"] is None
    assert st.files["clips/c1.mp4"] == fakes.MP4 and "trash/clips/c1.mp4" not in st.files
    assert c.post("/api/clips/c1/restore", json={}, headers=hdr).status_code == 409
    assert c.post("/api/clips/c1/trash", json={}, headers=hdr).status_code == 200
    # delete forever: needs the exact title
    title = by_id(st, "c1")["title"]
    for bad in ("", "title c1", title + " ", title.upper(), None, 5, "c1"):
        r = c.request("DELETE", "/api/clips/c1", json={"confirm": bad}, headers=hdr)
        assert r.status_code == 400 and r.json()["error"] == "confirm_mismatch", bad
    assert c.request("DELETE", "/api/clips/c1", json={}, headers=hdr).status_code == 400
    assert "trash/clips/c1.mp4" in st.files and any(x["id"] == "c1" for x in idx(st)["clips"])
    r = c.request("DELETE", "/api/clips/c1", json={"confirm": title}, headers=hdr)
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert not any("c1" in k for k in st.files if k.endswith((".mp4", ".jpg"))) and not any(x["id"] == "c1" for x in idx(st)["clips"])
    actions = [a["action"] for a in audit_lines(st)]
    assert actions == ["trash", "restore", "trash", "delete_forever"]
    assert c.request("DELETE", "/api/clips/c1", json={"confirm": title}, headers=hdr).status_code == 404
    tomb = json.loads(st.files["_config/tombstones.json"])  # same commit as the delete
    assert [t["id"] for t in tomb["ids"]] == ["c1"] and tomb["version"] == 1


def test_delete_forever_only_for_trashed_clips(env):
    c, hdr = as_user("root@example.com")
    r = c.request("DELETE", "/api/clips/c2", json={"confirm": "Title c2"}, headers=hdr)
    assert r.status_code == 409 and r.json()["error"] == "not_in_trash" and "clips/c2.mp4" in env["state"].files


def test_delete_forever_and_empty_trash_need_step_up_then_retry(env):
    st = env["state"]
    c, _ = as_user("root@example.com")
    stale_session(c, "root@example.com", age=1000)
    hdr = {"X-CSRF-Token": c.get("/api/me").json()["csrf"]}
    r = c.request("DELETE", "/api/clips/t1", json={"confirm": "Title t1"}, headers=hdr)
    assert r.status_code == 403 and r.json()["error"] == "reauth_required" and "trash/clips/t1.mp4" in st.files
    r = c.post("/api/trash/empty", json={"confirm": "EMPTY TRASH", "all": True}, headers=hdr)
    assert r.status_code == 403 and r.json()["error"] == "reauth_required"
    assert c.post("/api/clips/c1/trash", json={}, headers=hdr).status_code == 200  # trashing needs no step-up
    c.get("/api/auth/config")
    assert c.post("/api/auth/reauth", json={"credential": fakes.cred("root@example.com")}, headers=hdr).status_code == 204
    assert c.request("DELETE", "/api/clips/t1", json={"confirm": "Title t1"}, headers=hdr).status_code == 200
    assert "trash/clips/t1.mp4" not in st.files


def test_empty_trash(env):
    st = env["state"]
    fakes.seed(st, [fakes.clip("a"), fakes.clip("old", trashed=True, purge_after="2026-11-01T00:00:00Z"), fakes.clip("new", trashed=True)])
    c, hdr = as_user("root@example.com")
    for body in ({}, {"confirm": "empty trash"}, {"confirm": "EMPTY TRASH ", "all": True}, {"all": True}):
        assert c.post("/api/trash/empty", json=body, headers=hdr).status_code == 400
    assert c.post("/api/trash/empty", json={"confirm": "EMPTY TRASH", "all": "yes"}, headers=hdr).status_code == 422
    r = c.post("/api/trash/empty", json={"confirm": "EMPTY TRASH"}, headers=hdr)  # only what is past purge_after
    assert r.status_code == 200 and r.json() == {"ok": True, "purged": 1} and "trash/clips/new.mp4" in st.files
    r = c.post("/api/trash/empty", json={"confirm": "EMPTY TRASH", "all": True}, headers=hdr)
    assert r.json()["purged"] == 1 and "trash/clips/new.mp4" not in st.files and [x["id"] for x in idx(st)["clips"]] == ["a"]
    n = len(st.commits)
    assert c.post("/api/trash/empty", json={"confirm": "EMPTY TRASH", "all": True}, headers=hdr).json()["purged"] == 0
    assert len(st.commits) == n  # nothing to do: no empty commit
    assert [a["action"] for a in audit_lines(st)] == ["empty_trash", "empty_trash"]


def test_expired_trash_is_purged_lazily_on_the_next_admin_list_but_not_by_viewers(env):
    st = env["state"]
    fakes.seed(st, [fakes.clip("a"), fakes.clip("old", trashed=True, purge_after="2026-11-01T00:00:00Z"), fakes.clip("new", trashed=True)])
    v, _ = as_user("viewer@example.com")
    v.get("/api/clips")
    assert "trash/clips/old.mp4" in st.files  # a viewer's list does not purge
    c, _ = as_user("root@example.com")
    d = c.get("/api/clips?trash=1").json()
    assert [x["id"] for x in d["clips"]] == ["new"] and d["counts"] == {"active": 1, "trash": 1}
    assert "trash/clips/old.mp4" not in st.files and "trash/clips/old.jpg" not in st.files and "trash/clips/new.mp4" in st.files
    a = audit_lines(st)[-1]
    assert a["action"] == "purge" and a["clip_id"] == "old" and a["actor_email"] == "system"


def test_startup_purge_runs_and_failures_are_silent(env, capfd):
    from fastapi.testclient import TestClient
    import app as A
    st = env["state"]
    fakes.seed(st, [fakes.clip("old", trashed=True, purge_after="2026-11-01T00:00:00Z")])
    with TestClient(A.app, base_url="https://fake-space.hf.space"):
        for _ in range(100):
            if "trash/clips/old.mp4" not in st.files:
                break
            time.sleep(0.05)
    assert "trash/clips/old.mp4" not in st.files
    fakes.seed(st, [fakes.clip("old2", trashed=True, purge_after="2026-11-01T00:00:00Z")])
    st.fail_commit = True
    store.reset()
    with TestClient(A.app, base_url="https://fake-space.hf.space"):
        time.sleep(0.3)
    out = capfd.readouterr()
    assert "Traceback" not in out.err and "trash/clips" not in out.out + out.err  # one fixed line at most


def test_purge_is_skipped_in_read_only_mode(env, monkeypatch):
    monkeypatch.delenv("VAULT_WRITE_TOKEN")
    fakes.seed(env["state"], [fakes.clip("old", trashed=True, purge_after="2026-11-01T00:00:00Z")])
    c, _ = as_user("root@example.com")
    assert c.get("/api/clips?trash=1").status_code == 200 and "trash/clips/old.mp4" in env["state"].files


# ---------------------------------------------------------------- read-only mode

MUT = [("POST", "/api/clips/c1/trash", {}), ("POST", "/api/clips/t1/restore", {}), ("PATCH", "/api/clips/c1", {"title": "x"}),
       ("DELETE", "/api/clips/t1", {"confirm": "Title t1"}), ("POST", "/api/trash/empty", {"confirm": "EMPTY TRASH"}),
       ("POST", "/api/users", {"email": "n@example.com", "role": "viewer"}), ("PATCH", "/api/users/friend@example.com", {"role": "admin"}),
       ("DELETE", "/api/users/friend@example.com", {"confirm": "friend@example.com"})]


@pytest.mark.parametrize("why", ["unset", "same_as_read"])
def test_read_only_mode_503_everywhere_but_reads_work(env, monkeypatch, why):
    if why == "unset":
        monkeypatch.delenv("VAULT_WRITE_TOKEN")
    else:
        monkeypatch.setenv("VAULT_WRITE_TOKEN", env_read_token())
    c, hdr = as_user("root@example.com")
    me = c.get("/api/me").json()
    assert me["can_write"] is False and c.get("/api/clips").json()["can_write"] is False
    assert c.get("/api/clips").status_code == 200 and c.get("/api/files/clips/c1.mp4").status_code == 200
    assert c.get("/api/audit").status_code == 200 and c.get("/api/users").status_code == 200
    n = len(env["state"].commits)
    for method, path, body in MUT:
        r = c.request(method, path, json=body, headers=hdr)
        assert r.status_code == 503 and r.json()["error"] == "read_only", (method, path)
    r = c.post("/api/clips", files={"video": ("a.mp4", fakes.MP4, "video/mp4")}, data={"title": "t"}, headers=hdr)
    assert r.status_code == 503 and len(env["state"].commits) == n


def env_read_token():
    import os
    return os.environ["VAULT_READ_TOKEN"]


def test_write_token_is_only_handed_to_the_store(env):
    c, hdr = as_user("root@example.com")
    c.post("/api/clips/c1/trash", json={}, headers=hdr)
    inst = store.get_store(common._config())
    assert inst.read_token == "hf_" "FAKE_read_token_0000" and inst.write_token == "hf_" "FAKE_write_token_1111"
    assert "write_token" in common._config()
    for src in ("app.py", "admin.py", "auth.py"):
        text = (Path(__file__).resolve().parents[1] / src).read_text()
        assert "VAULT_WRITE_TOKEN" not in text.replace('"VAULT_WRITE_TOKEN"', "") or src == "app.py"
    for src in ("admin.py", "auth.py", "store.py"):
        assert "write_token" not in (Path(__file__).resolve().parents[1] / src).read_text().split("def get_store")[0].replace("self._write", "") or src == "store.py"


# ---------------------------------------------------------------- concurrency

def test_optimistic_concurrency_retries_on_conflict_and_keeps_the_other_writers_change(env):
    st = env["state"]

    def other_writer(state):  # somebody else commits between our snapshot and our commit
        data = json.loads(state.files["index.json"])
        data["clips"][1]["title"] = "Changed by someone else"
        state.files["index.json"] = json.dumps(data).encode()
        state.rev_n += 1
    st.before_commit = other_writer
    c, hdr = as_user("root@example.com")
    before = len(st.commits)
    r = c.patch("/api/clips/c1", json={"title": "Mine"}, headers=hdr)
    assert r.status_code == 200
    assert by_id(st, "c1")["title"] == "Mine" and by_id(st, "c2")["title"] == "Changed by someone else"  # re-planned on the new snapshot
    assert len(st.commits) == before + 1 and len([a for a in audit_lines(st) if a["action"] == "edit"]) == 1


def test_conflict_gives_up_after_three_retries_with_409(env):
    st = env["state"]
    attempts = []

    def always(state):
        attempts.append(1)
        state.rev_n += 1
        state.before_commit = always
    st.before_commit = always
    c, hdr = as_user("root@example.com")
    r = c.patch("/api/clips/c1", json={"title": "Mine"}, headers=hdr)
    assert r.status_code == 409 and r.json()["error"] == "conflict" and len(attempts) == store.MAX_RETRIES + 1
    assert by_id(st, "c1")["title"] == "Title c1" and audit_lines(st) == []  # nothing half-written


def test_commit_failure_is_502_and_leaves_no_trace(env):
    env["state"].fail_commit = True
    c, hdr = as_user("root@example.com")
    r = c.post("/api/clips/c1/trash", json={}, headers=hdr)
    assert r.status_code == 502 and r.json()["error"] == "upstream_error"
    env["state"].fail_commit = False
    assert "clips/c1.mp4" in env["state"].files and by_id(env["state"], "c1")["trashed_at"] is None and audit_lines(env["state"]) == []


def test_admin_mutation_rate_limit_is_per_user(env):
    c, hdr = as_user("root@example.com")
    codes = [c.patch("/api/clips/c1", json={"hook": f"h{i}"}, headers=hdr).status_code for i in range(31)]
    assert codes[:30] == [200] * 30 and codes[30] == 429
    r = c.patch("/api/clips/c1", json={"hook": "x"}, headers=hdr)
    assert r.status_code == 429 and r.headers["retry-after"] and r.json()["error"] == "rate_limited"
    env["state"].files["users.json"] = json.dumps({"version": 1, "users": [{"email": "boss2@example.com", "role": "admin"}]}).encode()
    store.invalidate()
    c2, hdr2 = as_user("boss2@example.com")
    assert c2.patch("/api/clips/c1", json={"hook": "y"}, headers=hdr2).status_code == 200  # another admin is unaffected


# ---------------------------------------------------------------- audit

def test_audit_returns_last_100_newest_first_admin_only(env):
    st = env["state"]
    lines = "".join(json.dumps({"at": f"2026-11-01T00:00:{i % 60:02d}Z", "actor_email": "a@example.com", "action": "edit", "clip_id": f"c{i}", "detail": {}}) + "\n" for i in range(120))
    st.files["_audit/2026-11.jsonl"] = lines.encode() + b"garbage line\n"
    c, hdr = as_user("root@example.com")
    e = c.get("/api/audit").json()["entries"]
    assert len(e) == 100 and e[0]["clip_id"] == "c119" and set(e[0]) == {"at", "actor_email", "action", "clip_id", "detail"}
    c.post("/api/clips/c1/trash", json={}, headers=hdr)
    top = c.get("/api/audit").json()["entries"][0]
    assert top["action"] == "trash" and top["actor_email"] == "root@example.com" and top["clip_id"] == "c1"
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    assert f"_audit/{month}.jsonl" in st.files
    assert as_user("viewer@example.com")[0].get("/api/audit").status_code == 403
    assert client().get("/api/audit").status_code == 401


def test_every_mutation_writes_exactly_one_audit_line_in_its_commit(env):
    st = env["state"]
    c, hdr = as_user("root@example.com")
    ops = [lambda: c.patch("/api/clips/c1", json={"hook": "z"}, headers=hdr), lambda: c.post("/api/clips/c2/trash", json={}, headers=hdr),
           lambda: c.post("/api/clips/c2/restore", json={}, headers=hdr), lambda: c.post("/api/clips/c2/trash", json={}, headers=hdr),
           lambda: c.request("DELETE", "/api/clips/c2", json={"confirm": "Title c2"}, headers=hdr)]
    for op in ops:
        n = len(st.commits)
        assert op().status_code == 200
        assert len(st.commits) == n + 1 and len(st.commits[-1]["audit"]) == 1
    assert len(audit_lines(st)) == 5


# ---------------------------------------------------------------- v1 index compatibility

V1 = {"clips": [
    {"id": "streamA/clip1", "stream": "streamA", "title": "Old one", "hook": "hk", "description": "old desc", "dur": 44, "score": 7,
     "video": "clips/streamA_clip1.mp4", "size": 123, "poster": "clips/streamA_clip1.jpg", "post": "old post"},
    {"id": "streamB/clip2", "stream": "streamB", "title": "No poster", "video": "clips/streamB_clip2.mp4", "size": 5},
    {"id": "../evil", "title": "bad id", "video": "http://evil/x.mp4"},
    "junk", 5, {"title": "no id"}, {"id": "dup", "video": "clips/streamB_clip2.mp4"},
]}


def seed_v1(state):
    state.files["index.json"] = json.dumps(V1).encode()
    for n in ("streamA_clip1.mp4", "streamA_clip1.jpg", "streamB_clip2.mp4"):
        state.files["clips/" + n] = fakes.MP4
    state.rev_n += 1


def test_v1_index_loads_with_defaults_and_works_end_to_end(env):
    st = env["state"]
    seed_v1(st)
    c, hdr = as_user("viewer@example.com")
    d = c.get("/api/clips").json()
    ids = [x["id"] for x in d["clips"]]
    assert ids == ["streamA_clip1", "streamB_clip2", "evil"][:len(ids)] and "streamA_clip1" in ids and "streamB_clip2" in ids
    a = d["clips"][0]
    assert a["desc"] == "old desc" and a["tags"] == [] and a["sha256"] is None and a["added_at"] is None and a["width"] is None
    assert a["trashed_at"] is None and a["video"] == "clips/streamA_clip1.mp4" and a["poster"] == "clips/streamA_clip1.jpg"
    assert d["clips"][1]["poster"] is None and d["updated_at"] is None
    assert c.get("/api/files/clips/streamA_clip1.mp4").status_code == 200 and c.get("/api/files/clips/streamB_clip2.jpg").status_code == 404
    ac, ah = as_user("root@example.com")
    assert ac.post("/api/clips/streamA_clip1/trash", json={}, headers=ah).status_code == 200
    saved = idx(st)
    assert saved["version"] == 2 and ISO.fullmatch(saved["updated_at"]) and "trash/clips/streamA_clip1.jpg" in st.files


@pytest.mark.parametrize("raw", [{}, [], {"clips": "x"}, {"clips": None}, [1, 2], {"version": 2, "clips": [{"id": 5}]}, "string", None])
def test_garbage_index_never_crashes(env, raw):
    env["state"].files["index.json"] = json.dumps(raw).encode()
    env["state"].rev_n += 1
    store.invalidate()
    c, _ = as_user("viewer@example.com")
    r = c.get("/api/clips")
    assert r.status_code == 200 and r.json()["clips"] == [] and r.json()["counts"] == {"active": 0, "trash": 0}


def test_missing_index_is_an_empty_vault(env):
    del env["state"].files["index.json"]
    env["state"].rev_n += 1
    store.invalidate()
    assert as_user("viewer@example.com")[0].get("/api/clips").json()["clips"] == []


# ---------------------------------------------------------------- upload

def mp(video=fakes.MP4, poster=fakes.JPG, **fields):
    files = {"video": ("a.mp4", video, "video/mp4")}
    if poster is not None:
        files["poster"] = ("p.jpg", poster, "image/jpeg")
    return {"files": files, "data": {"title": "My Great Clip!", **fields}}


def test_upload_happy_path(env):
    st = env["state"]
    c, hdr = as_user("root@example.com")
    n = len(st.commits)
    r = c.post("/api/clips", headers=hdr, **mp(hook="hook", desc="d\nd", post="post", stream="s1", tags="a, b ,,a"))
    assert r.status_code == 201, r.text
    clip = r.json()["clip"]
    assert re.fullmatch(r"my-great-clip-\d{8}-\d{6}(-[0-9a-f]{4})?", clip["id"]) and clip["sha256"] == hashlib.sha256(fakes.MP4).hexdigest()
    assert clip["size"] == len(fakes.MP4) and clip["tags"] == ["a", "b"] and clip["stream"] == "s1" and clip["title"] == "My Great Clip!"
    assert clip["video"] == f"clips/{clip['id']}.mp4" and clip["poster"] == f"clips/{clip['id']}.jpg" and clip["trashed_at"] is None
    assert ISO.fullmatch(clip["added_at"]) and clip["added_at"] == clip["updated_at"]
    assert st.files[clip["video"]] == fakes.MP4 and st.files[clip["poster"]] == fakes.JPG
    assert len(st.commits) == n + 1 and st.commits[-1]["audit"][0]["action"] == "upload"  # files + index + audit in one commit
    assert idx(st)["clips"][0]["id"] == clip["id"] and re.fullmatch(r"[A-Za-z0-9_.\-]+", clip["id"])
    assert c.get(f"/api/files/{clip['video']}").content == fakes.MP4


def test_upload_without_poster_and_with_odd_title(env):
    c, hdr = as_user("root@example.com")
    r = c.post("/api/clips", headers=hdr, **mp(poster=None, title="../../etc/passwd \u202e\x00 ünïcode"))
    assert r.status_code == 201 and r.json()["clip"]["poster"] is None
    assert re.fullmatch(r"[A-Za-z0-9_.\-]+", r.json()["clip"]["id"]) and ".." not in r.json()["clip"]["id"]
    r = c.post("/api/clips", headers=hdr, **mp(video=fakes.MP4 + b"2", poster=None, title="日本語"))
    assert r.status_code == 201 and r.json()["clip"]["id"].startswith("clip-")


def test_upload_two_same_titles_get_unique_ids(env):
    c, hdr = as_user("root@example.com")
    a = c.post("/api/clips", headers=hdr, **mp(poster=None)).json()["clip"]["id"]
    b = c.post("/api/clips", headers=hdr, **mp(video=fakes.MP4 + b"x", poster=None)).json()["clip"]["id"]
    assert a != b and len({x["id"] for x in idx(env["state"])["clips"]}) == 5


@pytest.mark.skipif(not (Path("/usr/bin/ffmpeg").exists() or Path("/usr/local/bin/ffmpeg").exists()), reason="ffmpeg missing")
def test_upload_probes_real_mp4_with_ffprobe(env, tmp_path):
    out = tmp_path / "t.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=64x48:r=10:d=1", "-pix_fmt", "yuv420p", "-y", str(out)], check=True)
    c, hdr = as_user("root@example.com")
    r = c.post("/api/clips", headers=hdr, **mp(video=out.read_bytes(), poster=None))
    clip = r.json()["clip"]
    assert r.status_code == 201 and clip["width"] == 64 and clip["height"] == 48 and clip["codec"] == "h264" and abs(clip["fps"] - 10) < 0.1
    assert 0.5 < clip["dur"] < 1.5 and isinstance(clip["bitrate"], int)


def test_upload_probe_falls_back_to_null_without_ffprobe(env, monkeypatch):
    monkeypatch.setattr(admin.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError()))
    c, hdr = as_user("root@example.com")
    clip = c.post("/api/clips", headers=hdr, **mp(poster=None)).json()["clip"]
    assert (clip["dur"], clip["width"], clip["height"], clip["fps"], clip["codec"], clip["bitrate"]) == (None,) * 6


@pytest.mark.parametrize("kw,field", [
    (dict(video=b"\x00\x00\x00\x18notftypmp4" + b"x" * 40), "video"), (dict(video=b"short"), "video"), (dict(video=b""), "video"),
    (dict(poster=b"\x89PNG\r\n\x1a\n" + b"x" * 30), "poster"), (dict(poster=b""), "poster"), (dict(title=""), "title"), (dict(title="  \x00 "), "title"),
    (dict(title="x" * 201), "title"), (dict(hook="x" * 301), "hook"), (dict(tags=",".join(f"t{i}" for i in range(21))), "tags"),
    (dict(tags="x" * 41), "tags")])
def test_upload_validation_422(env, kw, field):
    c, hdr = as_user("root@example.com")
    n = len(env["state"].commits)
    r = c.post("/api/clips", headers=hdr, **mp(**kw))
    assert r.status_code == 422 and r.json()["error"] == "invalid" and r.json().get("field", field) == field
    assert len(env["state"].commits) == n and not any(k.startswith("clips/") and "great" in k for k in env["state"].files)


def test_upload_structure_errors(env):
    c, hdr = as_user("root@example.com")
    assert c.post("/api/clips", json={"title": "x"}, headers=hdr).status_code == 415
    assert c.post("/api/clips", data={"title": "x"}, headers=hdr).status_code == 415  # urlencoded, not multipart
    common._hits.clear()
    r = c.post("/api/clips", headers=hdr, files={"poster": ("p.jpg", fakes.JPG, "image/jpeg")}, data={"title": "x"})
    assert r.status_code == 422  # no video
    r = c.post("/api/clips", headers=hdr, files={"video": ("a.mp4", fakes.MP4, "video/mp4"), "other": ("o.bin", b"x", "x/y")}, data={"title": "x"})
    assert r.status_code == 422
    r = c.post("/api/clips", headers=hdr, files=[("video", ("a.mp4", fakes.MP4)), ("video", ("b.mp4", fakes.MP4))], data={"title": "x"})
    assert r.status_code == 422
    r = c.post("/api/clips", headers=hdr, files={"video": ("a.mp4", fakes.MP4)}, data={"title": "x", "evil": "1"})
    assert r.status_code == 422
    common._hits.clear()
    r = c.post("/api/clips", headers={**hdr, "content-type": "multipart/form-data; boundary=BND"}, content=b"--BND\r\nbroken")
    assert r.status_code == 422


def test_upload_size_limits_by_content_length_and_while_streaming(env, monkeypatch):
    monkeypatch.setattr(admin, "MAX_VIDEO", 5000)
    monkeypatch.setattr(admin, "MAX_POSTER", 1000)
    c, hdr = as_user("root@example.com")
    big = fakes.MP4 + b"v" * 6000
    r = c.post("/api/clips", headers=hdr, **mp(video=big))
    assert r.status_code == 413 and r.json()["error"] == "too_large"
    r = c.post("/api/clips", headers=hdr, **mp(poster=fakes.JPG + b"p" * 1200))
    assert r.status_code == 413
    assert c.post("/api/clips", headers=hdr, **mp(video=fakes.MP4 + b"v" * 4000, poster=fakes.JPG)).status_code == 201  # just under the cap
    # declared Content-Length above everything: refused before a byte is read
    reads = []

    def body():
        reads.append(1)
        yield b"x"
    r = c.post("/api/clips", headers={**hdr, "content-type": "multipart/form-data; boundary=zz", "content-length": str(10 ** 9)}, content=body())
    assert r.status_code == 413 and not reads


def multipart_body(video_len, chunk=64 * 1024, boundary="BND", counter=None):
    head = (f'--{boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nStream test\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="video"; filename="v.mp4"\r\nContent-Type: video/mp4\r\n\r\n').encode()

    def gen():
        yield head + fakes.MP4
        sent = len(fakes.MP4)
        while sent < video_len:
            n = min(chunk, video_len - sent)
            if counter is not None:
                counter.append(n)
            yield b"\x07" * n
            sent += n
        yield f"\r\n--{boundary}--\r\n".encode()
    return gen()


@pytest.fixture
def live_server():
    """A real uvicorn: the TestClient buffers whole request bodies, so streaming is only provable over a socket."""
    import socket
    import threading
    import uvicorn
    import app as A
    with socket.socket() as s0:
        s0.bind(("127.0.0.1", 0))
        port = s0.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(A.app, host="127.0.0.1", port=port, log_level="warning", access_log=False))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    assert srv.started
    cfg, now = common._config(), time.time()
    cookie = common.session_cookie_value(cfg, "root@example.com", "s1", "Root", None, now, now, now + 3600)
    headers = {"X-CSRF-Token": common.csrf_token(cfg, "root@example.com", "s1", now), "Content-Type": "multipart/form-data; boundary=BND"}
    yield f"http://127.0.0.1:{port}", {"__Host-cv_session": cookie}, headers
    srv.should_exit = True
    th.join(timeout=5)


def test_upload_streams_to_disk_and_never_buffers_the_file(env, live_server):
    """20 MB chunked over a real socket: peak Python memory stays far below the file size; temp file reads are chunked."""
    import requests as rq
    url, cookies, headers = live_server
    size = 20 * 1024 * 1024
    tracemalloc.start()
    tracemalloc.reset_peak()
    r = rq.post(url + "/api/clips", data=multipart_body(size), headers=headers, cookies=cookies, timeout=60)  # generator => chunked
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    assert r.status_code == 201, r.text
    clip = r.json()["clip"]
    assert clip["size"] == size and peak < 8 * 1024 * 1024, peak
    assert env["state"].add_reads and max(env["state"].add_reads) <= 65536
    assert env["state"].big[clip["video"]] == (size, clip["sha256"])
    assert not [p for p in Path("/tmp").glob("cv-upload-*") if time.time() - p.stat().st_mtime < 120]  # temp dir removed


def test_upload_stops_reading_once_over_the_cap(env, live_server, monkeypatch):
    import requests as rq
    monkeypatch.setattr(admin, "MAX_VIDEO", 1024 * 1024)
    url, cookies, headers = live_server
    counter = []
    try:
        r = rq.post(url + "/api/clips", data=multipart_body(60 * 1024 * 1024, counter=counter), headers=headers, cookies=cookies, timeout=60)
        assert r.status_code == 413 and r.json()["error"] == "too_large"
    except rq.exceptions.RequestException:
        pass  # the server may close the socket before the client reads the 413
    assert sum(counter) < 30 * 1024 * 1024  # the sender was cut off long before the end
    assert not any(k.startswith("clips/stream-test") for k in env["state"].files)


def test_upload_duplicate_sha_is_409_with_existing_clip_id(env):
    c, hdr = as_user("root@example.com")
    first = c.post("/api/clips", headers=hdr, **mp(poster=None)).json()["clip"]
    n = len(env["state"].commits)
    r = c.post("/api/clips", headers=hdr, **mp(poster=None, title="Other title"))
    assert r.status_code == 409 and r.json()["error"] == "duplicate" and r.json()["clip_id"] == first["id"]
    assert len(env["state"].commits) == n
    c.post(f"/api/clips/{first['id']}/trash", json={}, headers=hdr)
    assert c.post("/api/clips", headers=hdr, **mp(poster=None)).status_code == 409  # also against trashed clips


def test_upload_rate_limit_5_per_10_minutes_per_user(env):
    c, hdr = as_user("root@example.com")
    codes = [c.post("/api/clips", headers=hdr, files={"video": ("a.mp4", b"nope")}, data={"title": "x"}).status_code for _ in range(6)]
    assert codes[:5] == [422] * 5 and codes[5] == 429
    assert common.LIMITS["upload"] == (5, 600) and common.LIMITS["admin_mut"] == (30, 60)


def test_viewer_cannot_upload(env):
    c, hdr = as_user("viewer@example.com")
    assert c.post("/api/clips", headers=hdr, **mp()).status_code == 403
    assert not any(k.startswith("clips/my-great") for k in env["state"].files)


def test_delete_forever_and_trash_purge_add_tombstones_in_the_same_commit(env):
    st = env["state"]
    fakes.seed(st, [fakes.clip("a", trashed=True), fakes.clip("old", trashed=True, purge_after="2026-11-01T00:00:00Z"), fakes.clip("keep")])
    c, hdr = as_user("root@example.com")
    n = len(st.commits)
    r = c.request("DELETE", "/api/clips/a", json={"confirm": by_id(st, "a")["title"]}, headers=hdr)
    assert r.status_code == 200 and len(st.commits) == n + 1
    assert [t["id"] for t in json.loads(st.files["_config/tombstones.json"])["ids"]] == ["a"]
    assert json.loads(st.files["_config/tombstones.json"])["ids"][0]["sha256"] == "sha-a"
    assert c.post("/api/trash/empty", json={"confirm": "EMPTY TRASH"}, headers=hdr).json()["purged"] == 1
    assert [t["id"] for t in json.loads(st.files["_config/tombstones.json"])["ids"]] == ["a", "old"]  # appended, not replaced
    assert "keep" not in st.files["_config/tombstones.json"].decode()


# ---------------------------------------------------------------- Library data (D39): unknown fields and "streams" survive every write

LIB_FIELDS = {"group": "30092-30120s", "variant": "with-girl", "reaction": "strong", "reaction_note": "jumps", "kind": "reaction", "tier": "A", "rank": 1,
              "why": "he screams", "hook": "boss dies", "future_field": {"nested": [1, 2]}}
LIB_STREAMS = [{"id": "2026-11-18_kai", "title": "Kai \U0001F3AE", "channel": "Kai", "date": "2026-11-18", "url": "https://youtu.be/x", "thumb": "streams/2026-11-18_kai/thumb.jpg", "clip_count": 2}]


def _with_library_data(state):
    raw = json.loads(state.files["index.json"])
    for c in raw["clips"]:
        if c["id"] == "c1":
            c.update(LIB_FIELDS)
    raw["streams"] = LIB_STREAMS
    raw["extra_top"] = {"keep": True}
    state.files["index.json"] = json.dumps(raw).encode()
    store.invalidate()


def _assert_library_data_kept(state, cid="c1"):
    raw = idx(state)
    c = by_id(state, cid)
    for k, v in LIB_FIELDS.items():
        assert c[k] == v, k
    assert raw["streams"] == LIB_STREAMS and raw["extra_top"] == {"keep": True}


def test_edit_trash_restore_keep_library_fields_and_streams(env):
    _with_library_data(env["state"])
    c, hdr = as_user("root@example.com")
    r = c.patch("/api/clips/c1", json={"title": "Renamed"}, headers=hdr)
    assert r.status_code == 200 and r.json()["clip"]["group"] == "30092-30120s"  # the API hands the fields out too
    _assert_library_data_kept(env["state"])
    assert by_id(env["state"], "c1")["title"] == "Renamed"
    assert c.post("/api/clips/c1/trash", json={}, headers=hdr).status_code == 200
    _assert_library_data_kept(env["state"])
    assert c.post("/api/clips/c1/restore", json={}, headers=hdr).status_code == 200
    _assert_library_data_kept(env["state"])


def test_delete_forever_keeps_streams_and_other_clips_fields(env):
    _with_library_data(env["state"])
    c, hdr = as_user("root@example.com")
    t = by_id(env["state"], "t1")
    r = c.request("DELETE", "/api/clips/t1", json={"confirm": t["title"]}, headers=hdr)
    assert r.status_code in (200, 204)
    _assert_library_data_kept(env["state"])


def test_normalizers_pass_unknown_fields_and_streams_through():
    out = store.normalize_index({"streams": LIB_STREAMS, "x": 1, "clips": [{"id": "a", "video": "clips/a.mp4", "title": "T", **LIB_FIELDS}]})
    assert out["streams"] == LIB_STREAMS and out["x"] == 1 and out["version"] == 2
    assert all(out["clips"][0][k] == v for k, v in LIB_FIELDS.items()) and out["clips"][0]["title"] == "T"
    # known fields still win over junk
    assert store.normalize_index({"clips": [{"id": "a", "tags": "no"}]})["clips"][0]["tags"] == []
