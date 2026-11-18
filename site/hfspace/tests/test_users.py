"""Users view backend: list, add, change role, remove; root admins locked; self-lock; step-up; audit."""
import json

import pytest

import common
import fakes
import store
from helpers import as_user, client, stale_session
from test_clips import audit_lines

SITE = {"email": "boss2@example.com", "role": "admin", "added_at": "2026-11-01T00:00:00Z", "added_by": "root@example.com"}
GUEST = {"email": "guest@example.com", "role": "viewer", "added_at": "2026-11-02T00:00:00Z", "added_by": "root@example.com"}


def users_file(state):
    return json.loads(state.files["users.json"])["users"]


def seed_users(state, users):
    state.files["users.json"] = json.dumps({"version": 1, "users": users}).encode()
    state.rev_n += 1
    store.invalidate()


def test_list_users_contract_and_root_flags(env):
    seed_users(env["state"], [SITE, GUEST])
    c, _ = as_user("root@example.com")
    d = c.get("/api/users").json()
    assert d["root_admins"] == ["root@example.com"]
    rows = {u["email"]: u for u in d["users"]}
    assert set(rows["root@example.com"]) >= {"email", "role", "root", "added_at", "added_by"}
    assert rows["root@example.com"]["root"] is True and rows["root@example.com"]["role"] == "admin"
    assert rows["boss2@example.com"] == {"email": "boss2@example.com", "role": "admin", "root": False, "source": "site",
                                          "added_at": "2026-11-01T00:00:00Z", "added_by": "root@example.com"}
    assert rows["guest@example.com"]["role"] == "viewer" and rows["guest@example.com"]["root"] is False
    assert rows["viewer@example.com"]["source"] == "secret" and rows["viewer@example.com"]["root"] is True  # listed in ALLOWED_EMAILS
    assert as_user("viewer@example.com")[0].get("/api/users").status_code == 403
    assert client().get("/api/users").status_code == 401


def test_add_user_then_they_can_sign_in_and_audit_is_written(env):
    st = env["state"]
    c, hdr = as_user("root@example.com")
    n = len(st.commits)
    r = c.post("/api/users", json={"email": " New.Person@Example.com ", "role": "viewer"}, headers=hdr)
    assert r.status_code == 201 and r.json()["user"]["email"] == "new.person@example.com" and r.json()["user"]["added_by"] == "root@example.com"
    assert users_file(st)[0]["role"] == "viewer" and len(st.commits) == n + 1
    a = audit_lines(st)[-1]
    assert a["action"] == "user_add" and a["actor_email"] == "root@example.com" and a["detail"] == {"email": "new.person@example.com", "role": "viewer"}
    from helpers import login
    assert login("new.person@example.com")[1].status_code == 204
    assert c.post("/api/users", json={"email": "admin2@example.com", "role": "admin"}, headers=hdr).status_code == 201
    assert as_user("admin2@example.com")[0].get("/api/audit").status_code == 200


@pytest.mark.parametrize("body,status", [
    ({"email": "x", "role": "viewer"}, 422), ({"email": "a@b", "role": "viewer"}, 422), ({"email": "a@b.co", "role": "owner"}, 422),
    ({"email": "a@b.co"}, 422), ({"role": "viewer"}, 422), ({"email": 5, "role": "viewer"}, 422), ({"email": "a b@c.co", "role": "viewer"}, 422),
    ({"email": "a@b.co", "role": "viewer", "root": True}, 422), ({"email": "x" * 300 + "@b.co", "role": "viewer"}, 422), ({}, 422),
    ({"email": "root@example.com", "role": "viewer"}, 409), ({"email": "VIEWER@example.com", "role": "admin"}, 409),
    ({"email": "boss2@example.com", "role": "viewer"}, 409)])
def test_add_user_validation_and_duplicates(env, body, status):
    seed_users(env["state"], [SITE])
    c, hdr = as_user("root@example.com")
    r = c.post("/api/users", json=body, headers=hdr)
    assert r.status_code == status and set(r.json()) >= {"error", "message"}
    assert len(users_file(env["state"])) == 1


def test_change_role_and_remove_with_typed_confirmation(env):
    st = env["state"]
    seed_users(st, [SITE, GUEST])
    c, hdr = as_user("root@example.com")
    r = c.patch("/api/users/guest@example.com", json={"role": "admin"}, headers=hdr)
    assert r.status_code == 200 and r.json()["user"]["role"] == "admin" and [u["role"] for u in users_file(st)] == ["admin", "admin"]
    assert audit_lines(st)[-1]["detail"] == {"email": "guest@example.com", "from": "viewer", "to": "admin"}
    assert c.patch("/api/users/guest@example.com", json={"role": "boss"}, headers=hdr).status_code == 422
    assert c.patch("/api/users/guest@example.com", json={"role": "viewer", "x": 1}, headers=hdr).status_code == 422
    assert c.patch("/api/users/nobody@example.com", json={"role": "viewer"}, headers=hdr).status_code == 404
    for bad in ("", "GUEST", "guest@example.com ", None, "guest", "other@example.com"):
        r = c.request("DELETE", "/api/users/guest@example.com", json={"confirm": bad}, headers=hdr)
        assert r.status_code == 400 and r.json()["error"] == "confirm_mismatch"
    assert c.request("DELETE", "/api/users/guest@example.com", json={}, headers=hdr).status_code == 400
    assert len(users_file(st)) == 2
    r = c.request("DELETE", "/api/users/guest@example.com", json={"confirm": "guest@example.com"}, headers=hdr)
    assert r.status_code == 200 and r.json() == {"ok": True} and [u["email"] for u in users_file(st)] == ["boss2@example.com"]
    assert audit_lines(st)[-1]["action"] == "user_remove"
    assert c.request("DELETE", "/api/users/guest@example.com", json={"confirm": "guest@example.com"}, headers=hdr).status_code == 404


def test_removed_user_loses_access_on_their_next_request(env):
    seed_users(env["state"], [GUEST])
    g, _ = as_user("guest@example.com")
    assert g.get("/api/files/clips/c1.mp4").status_code == 200
    c, hdr = as_user("root@example.com")
    c.request("DELETE", "/api/users/guest@example.com", json={"confirm": "guest@example.com"}, headers=hdr)
    assert g.get("/api/files/clips/c1.mp4").status_code == 401 and g.get("/api/me").status_code == 401


def test_demoted_admin_loses_admin_on_their_next_request(env):
    seed_users(env["state"], [SITE])
    b, bh = as_user("boss2@example.com")
    c, hdr = as_user("root@example.com")
    assert c.patch("/api/users/boss2@example.com", json={"role": "viewer"}, headers=hdr).status_code == 200
    assert b.get("/api/me").json()["role"] == "viewer" and b.get("/api/users").status_code == 403
    assert b.post("/api/clips/c1/trash", json={}, headers={"X-CSRF-Token": b.get("/api/me").json()["csrf"]}).status_code == 403


def test_root_admins_are_locked_and_you_cannot_change_yourself(env):
    seed_users(env["state"], [SITE])
    b, bh = as_user("boss2@example.com")  # a site-made admin
    r = b.patch("/api/users/root@example.com", json={"role": "viewer"}, headers=bh)
    assert r.status_code == 403 and r.json()["error"] == "root_admin"
    r = b.request("DELETE", "/api/users/root@example.com", json={"confirm": "root@example.com"}, headers=bh)
    assert r.status_code == 403 and r.json()["error"] == "root_admin"
    r = b.patch("/api/users/boss2@example.com", json={"role": "viewer"}, headers=bh)
    assert r.status_code == 403 and r.json()["error"] == "self"
    r = b.request("DELETE", "/api/users/boss2@example.com", json={"confirm": "boss2@example.com"}, headers=bh)
    assert r.status_code == 403 and r.json()["error"] == "self"
    root, rh = as_user("root@example.com")
    assert root.patch("/api/users/root@example.com", json={"role": "viewer"}, headers=rh).json()["error"] == "self"  # self wins for a root too
    assert [u["email"] for u in users_file(env["state"])] == ["boss2@example.com"]


def test_secret_listed_viewers_cannot_be_edited_from_the_site(env):
    c, hdr = as_user("root@example.com")
    r = c.patch("/api/users/viewer@example.com", json={"role": "admin"}, headers=hdr)
    assert r.status_code == 403 and r.json()["error"] == "managed_by_secret"
    r = c.request("DELETE", "/api/users/viewer@example.com", json={"confirm": "viewer@example.com"}, headers=hdr)
    assert r.status_code == 403 and r.json()["error"] == "managed_by_secret"


def test_all_users_mutations_need_step_up_and_retry_works(env):
    st = env["state"]
    seed_users(st, [GUEST])
    c, _ = as_user("root@example.com")
    stale_session(c, "root@example.com", age=common.REAUTH_WINDOW + 60)
    hdr = {"X-CSRF-Token": c.get("/api/me").json()["csrf"]}
    calls = [("POST", "/api/users", {"email": "n@example.com", "role": "viewer"}), ("PATCH", "/api/users/guest@example.com", {"role": "admin"}),
             ("DELETE", "/api/users/guest@example.com", {"confirm": "guest@example.com"})]
    for m, p, b in calls:
        r = c.request(m, p, json=b, headers=hdr)
        assert r.status_code == 403 and r.json()["error"] == "reauth_required", (m, p)
    assert users_file(st) == [GUEST]
    c.get("/api/auth/config")
    assert c.post("/api/auth/reauth", json={"credential": fakes.cred("root@example.com")}, headers=hdr).status_code == 204
    for m, p, b in calls[:1]:
        assert c.request(m, p, json=b, headers=hdr).status_code == 201


def test_step_up_window_edges(env, monkeypatch):
    c, hdr = as_user("root@example.com")
    assert c.post("/api/users", json={"email": "a@example.com", "role": "viewer"}, headers=hdr).status_code == 201  # fresh login
    stale_session(c, "root@example.com", age=common.REAUTH_WINDOW - 20)
    hdr = {"X-CSRF-Token": c.get("/api/me").json()["csrf"]}
    assert c.post("/api/users", json={"email": "b@example.com", "role": "viewer"}, headers=hdr).status_code == 201
    stale_session(c, "root@example.com", age=common.REAUTH_WINDOW + 20)
    hdr = {"X-CSRF-Token": c.get("/api/me").json()["csrf"]}
    assert c.post("/api/users", json={"email": "c@example.com", "role": "viewer"}, headers=hdr).status_code == 403


def test_users_limit(env):
    seed_users(env["state"], [{"email": f"u{i}@example.com", "role": "viewer", "added_at": None, "added_by": None} for i in range(200)])
    c, hdr = as_user("root@example.com")
    assert c.post("/api/users", json={"email": "extra@example.com", "role": "viewer"}, headers=hdr).status_code == 422


def test_users_json_garbage_is_ignored(env):
    env["state"].files["users.json"] = json.dumps({"users": [5, {"email": 3}, {"email": "bad"}, {"email": "ok@example.com", "role": "weird"},
                                                           {"email": "OK@example.com"}]}).encode()
    env["state"].rev_n += 1
    store.invalidate()
    c, _ = as_user("root@example.com")
    got = [u for u in c.get("/api/users").json()["users"] if u["source"] == "site"]
    assert got == [{"email": "ok@example.com", "role": "viewer", "root": False, "source": "site", "added_at": None, "added_by": None}]
