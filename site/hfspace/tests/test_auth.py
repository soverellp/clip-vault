"""Google sign-in, sessions, roles computed at request time, CSRF, step-up."""
import asyncio
import json
import threading
import time

import pytest

import app as A
import auth
import common
import fakes
import store
from conftest import SESSION_SECRET
from helpers import as_user, client, login, stale_session

ADMIN2 = {"email": "boss2@example.com", "role": "admin", "added_at": "2026-11-01T00:00:00Z", "added_by": "root@example.com"}


def set_users(state, users):
    state.files["users.json"] = json.dumps({"version": 1, "users": users}).encode()
    state.rev_n += 1
    store.invalidate()


def test_config_sets_a_signed_short_nonce_cookie():
    c = client()
    r = c.get("/api/auth/config")
    assert r.status_code == 200 and set(r.json()) == {"client_id", "nonce"} and len(r.json()["nonce"]) >= 24
    sc = r.headers["set-cookie"].lower()
    assert sc.startswith("__host-cv_nonce=") and "httponly" in sc and "secure" in sc and "samesite=lax" in sc and "max-age=300" in sc
    assert "path=/" in sc and "domain" not in sc
    assert r.json()["nonce"] not in sc  # the cookie is signed, the nonce travels in the JSON
    assert common._unsign(SESSION_SECRET, "nonce", c.cookies.get("__Host-cv_nonce"))["n"] == r.json()["nonce"]
    assert c.get("/api/auth/config").json()["nonce"] != r.json()["nonce"]


def test_login_happy_path_viewer_and_admin():
    c, r = login("Viewer@Example.com", sub="g-123")
    assert r.status_code == 204 and r.content == b""
    cookies = r.headers.get_list("set-cookie")
    sess = [h for h in cookies if h.startswith("__Host-cv_session=")][0].lower()
    assert "httponly" in sess and "secure" in sess and "samesite=lax" in sess and "max-age=28800" in sess and "path=/" in sess
    assert any(h.startswith("__Host-cv_nonce=") and "max-age=0" in h.lower() for h in cookies)  # the nonce is single use
    me = c.get("/api/me").json()
    assert me["email"] == "viewer@example.com" and me["role"] == "viewer" and me["sub"] == "g-123" and me["root"] is False
    assert me["can_write"] is True and me["picture"].startswith("https://lh3.googleusercontent.com/") and me["name"]
    assert len(me["csrf"]) == 64 and me["session_age_seconds"] < 5
    c2, r2 = login("root@example.com")
    me2 = c2.get("/api/me").json()
    assert r2.status_code == 204 and me2["role"] == "admin" and me2["root"] is True
    assert c2.get("/api/me").headers["cache-control"] == "no-store"


def test_session_payload_has_iat_ra_and_8h_ttl():
    c, _ = login("viewer@example.com")
    data = common._unsign(SESSION_SECRET, "session", c.cookies.get("__Host-cv_session"))
    assert data["u"] == "viewer@example.com" and abs(data["iat"] - time.time()) < 5 and data["ra"] == data["iat"]
    assert data["exp"] - data["iat"] == 8 * 3600 and "role" not in data  # the role is NOT stored: computed per request


@pytest.mark.parametrize("kind", ["badnonce", "badaud", "unverified", "badiss", "expired", "boom"])
def test_bad_credentials_are_refused_identically(kind):
    c, r = login("viewer@example.com", kind=kind)
    ref = login("stranger@example.com")[1]
    assert r.status_code == 403 and r.json() == ref.json() == {"error": "forbidden", "message": common.MESSAGES["forbidden"]}
    assert "__Host-cv_session" not in "".join(r.headers.get_list("set-cookie"))
    assert c.get("/api/me").status_code == 401


def test_not_listed_account_gets_generic_403_identical_body():
    a = login("stranger@example.com")[1]
    b = login("viewer@example.com", kind="badaud")[1]
    assert a.status_code == b.status_code == 403 and a.content == b.content


def test_nonce_is_single_use_and_required():
    c = client()
    c.get("/api/auth/config")
    body = {"credential": fakes.cred("viewer@example.com")}
    assert c.post("/api/auth/google", json=body).status_code == 204
    c.cookies.delete("__Host-cv_session")
    assert c.post("/api/auth/google", json=body).status_code == 403  # nonce cookie was deleted: replay refused
    assert client().post("/api/auth/google", json=body).status_code == 403  # never fetched a nonce
    c2 = client()
    c2.get("/api/auth/config")
    c2.cookies.set("__Host-cv_nonce", "garbage", domain="fake-space.hf.space", path="/")
    assert c2.post("/api/auth/google", json=body).status_code == 403


def test_expired_nonce_cookie_is_refused(monkeypatch):
    c = client()
    c.get("/api/auth/config")
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + 301)
    assert c.post("/api/auth/google", json={"credential": fakes.cred("viewer@example.com")}).status_code == 403


def test_empty_lists_deny_everybody(monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", "")
    monkeypatch.setenv("ADMIN_EMAILS", " , ,")
    assert login("viewer@example.com")[1].status_code == 403 and login("root@example.com")[1].status_code == 403


def test_list_parsing(monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", " A@X.com ,,b@x.com:sub1, b@x.com:sub2,c@x.com:, :bad")
    assert common.allowed_env() == {"a@x.com": set(), "b@x.com": {"sub1", "sub2"}}


def test_pinned_sub_must_match_at_login_and_on_every_request(monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", "pin@example.com:sub-good")
    assert login("pin@example.com", sub="sub-bad")[1].status_code == 403
    c, r = login("pin@example.com", sub="sub-good")
    assert r.status_code == 204 and c.get("/api/me").json()["sub"] == "sub-good"
    monkeypatch.setenv("ALLOWED_EMAILS", "pin@example.com:other")
    assert c.get("/api/me").status_code == 401


def test_allowlist_edit_takes_effect_immediately(monkeypatch):
    c, _ = as_user("viewer@example.com")
    assert c.get("/api/files/clips/c1.mp4").status_code == 200
    monkeypatch.setenv("ALLOWED_EMAILS", "friend@example.com")  # removed viewer
    assert c.get("/api/me").status_code == 401
    assert c.get("/api/files/clips/c1.mp4").status_code == 401 and c.get("/api/clips").status_code == 401


def test_admin_demotion_and_removal_take_effect_on_the_next_request(env):
    set_users(env["state"], [ADMIN2])
    c, hdr = as_user("boss2@example.com")
    assert c.get("/api/me").json()["role"] == "admin" and c.get("/api/audit").status_code == 200
    set_users(env["state"], [dict(ADMIN2, role="viewer")])
    assert c.get("/api/me").json()["role"] == "viewer"  # same session cookie
    assert c.get("/api/audit").status_code == 403 and c.get("/api/clips?trash=1").status_code == 403
    assert c.post("/api/clips/c1/trash", json={}, headers={"X-CSRF-Token": c.get("/api/me").json()["csrf"]}).status_code == 403
    assert c.get("/api/files/trash/clips/t1.mp4").status_code == 404
    set_users(env["state"], [])
    assert c.get("/api/me").status_code == 401 and c.get("/api/files/clips/c1.mp4").status_code == 401


def test_user_added_in_the_site_can_sign_in(env):
    assert login("newbie@example.com")[1].status_code == 403
    set_users(env["state"], [{"email": "newbie@example.com", "role": "viewer", "added_at": None, "added_by": None}])
    assert login("newbie@example.com")[1].status_code == 204


def test_store_outage_falls_back_to_the_env_lists(env):
    set_users(env["state"], [ADMIN2])
    env["state"].fail_reads = True
    store.invalidate()
    assert login("boss2@example.com")[1].status_code == 403  # fail closed for site-managed users
    assert login("root@example.com")[1].status_code == 204 and login("viewer@example.com")[1].status_code == 204


def test_tampered_expired_future_and_revoked_sessions(monkeypatch):
    cfg = common._config()
    now = time.time()

    def cookie_for(**over):
        d = dict(email="viewer@example.com", sub="s", name="V", picture=None, iat=now, ra=now, exp=now + 3600)
        d.update(over)
        return common.session_cookie_value(cfg, **d)
    def status(raw):
        c = client()
        c.cookies.set("__Host-cv_session", raw)
        return c.get("/api/me").status_code
    assert status(cookie_for()) == 200
    good = cookie_for()
    assert status(good[:-3] + ("AAA" if not good.endswith("AAA") else "BBB")) == 401
    assert status(cookie_for(exp=now - 5)) == 401
    assert status(cookie_for(iat=now + 1000, ra=now + 1000, exp=now + 5000)) == 401
    assert status(common._sign("y" * 48, "session", {"u": "viewer@example.com", "iat": now, "exp": now + 99})) == 401
    assert status("x" * 5000) == 401
    monkeypatch.setenv("SESSIONS_NOT_BEFORE", str(now + 10))
    assert status(good) == 401
    monkeypatch.setenv("SESSIONS_NOT_BEFORE", str(now - 10))
    assert status(good) == 200
    monkeypatch.setenv("SESSIONS_NOT_BEFORE", "garbage")
    assert status(good) == 401  # unparsable: everybody out


def test_session_without_iat_is_rejected():
    c = client()
    c.cookies.set("__Host-cv_session", common._sign(SESSION_SECRET, "session", {"u": "viewer@example.com", "sub": "s", "exp": time.time() + 99}))
    assert c.get("/api/me").status_code == 401


def test_logout_is_post_only_and_clears_cookie():
    c, _ = as_user("viewer@example.com")
    g = c.get("/logout")
    assert g.status_code == 405 and g.headers["allow"] == "POST" and g.json()["error"] == "method_not_allowed"
    assert c.get("/api/me").status_code == 200
    assert c.post("/logout", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert c.get("/api/me").status_code == 200
    r = c.post("/logout", headers={"Sec-Fetch-Site": "same-origin"})
    low = r.headers["set-cookie"].lower()
    assert r.status_code == 303 and r.headers["location"] == "/" and low.startswith("__host-cv_session=") and "max-age=0" in low and "path=/" in low
    c.cookies.clear()
    assert c.get("/api/me").status_code == 401


# ---------------------------------------------------------------- CSRF and fetch metadata

MUTATIONS = [("POST", "/api/clips/c1/trash"), ("POST", "/api/clips/t1/restore"), ("PATCH", "/api/clips/c1"), ("DELETE", "/api/clips/t1"),
             ("POST", "/api/trash/empty"), ("POST", "/api/users"), ("PATCH", "/api/users/friend@example.com"),
             ("DELETE", "/api/users/friend@example.com"), ("POST", "/api/clips"), ("POST", "/api/auth/reauth")]


@pytest.mark.parametrize("method,path", MUTATIONS)
def test_csrf_missing_wrong_and_cross_site(method, path):
    c, hdr = as_user("root@example.com")
    r = c.request(method, path, json={"title": "x"})
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    assert c.request(method, path, json={"title": "x"}, headers={"X-CSRF-Token": "0" * 64}).status_code == 403
    assert c.request(method, path, json={"title": "x"}, headers={"X-CSRF-Token": hdr["X-CSRF-Token"][:-1]}).status_code == 403
    for site in ("cross-site", "same-site"):
        assert c.request(method, path, json={}, headers={**hdr, "Sec-Fetch-Site": site}).status_code == 403
    assert client().request(method, path, json={}).status_code in (401, 403)


def test_csrf_token_belongs_to_the_session():
    a, ha = as_user("root@example.com")
    b, hb = as_user("viewer@example.com")
    assert ha != hb
    assert a.post("/api/clips/c1/trash", json={}, headers=hb).status_code == 403
    assert a.post("/api/clips/c1/trash", json={}, headers={**ha, "Sec-Fetch-Site": "same-origin"}).status_code == 200
    assert a.post("/api/clips/t1/restore", json={}, headers={**ha, "Sec-Fetch-Site": "none"}).status_code == 200


def test_login_post_cross_site_is_refused_and_has_no_csrf_header_requirement():
    c = client()
    c.get("/api/auth/config")
    r = c.post("/api/auth/google", json={"credential": fakes.cred("viewer@example.com")}, headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    assert c.post("/api/auth/google", json={"credential": fakes.cred("viewer@example.com")}, headers={"Sec-Fetch-Site": "same-origin"}).status_code == 204


def test_viewer_cannot_call_any_mutation_or_admin_read():
    c, hdr = as_user("viewer@example.com")
    for method, path in MUTATIONS[:-1]:
        r = c.request(method, path, json={"title": "x", "role": "viewer", "email": "n@example.com", "confirm": "x"}, headers=hdr)
        assert r.status_code == 403 and r.json()["error"] == "forbidden", (method, path)
    for path in ("/api/audit", "/api/users", "/api/clips?trash=1", "/api/files/trash/clips/t1.mp4"):
        assert c.get(path).status_code in (403, 404)
    assert c.get("/api/audit").status_code == 403 and c.get("/api/users").status_code == 403
    assert c.get("/api/clips?trash=1").status_code == 403


# ---------------------------------------------------------------- body limits and error shapes

def test_auth_body_limit_is_enforced_before_reading_and_while_streaming():
    c = client()
    c.get("/api/auth/config")
    big = json.dumps({"credential": "x" * 9000})
    r = c.post("/api/auth/google", content=big, headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json()["error"] == "too_large"

    def gen():  # chunked: no Content-Length, the cap is counted while streaming
        for _ in range(200):
            yield b"x" * 100
    r = c.post("/api/auth/google", content=gen(), headers={"content-type": "application/json"})
    assert r.status_code == 413


@pytest.mark.parametrize("body,ctype,status", [
    ("not json", "application/json", 422), ("[]", "application/json", 422), ('{"credential": 5}', "application/json", 422),
    ('{"credential": "short"}', "application/json", 422), ('{"credential": "' + "x" * 30 + '", "extra": 1}', "application/json", 422),
    ('{"credential": "' + "x" * 30 + '"}', "text/plain", 415), ("", "application/json", 422)])
def test_auth_body_validation(body, ctype, status):
    c = client()
    c.get("/api/auth/config")
    r = c.post("/api/auth/google", content=body, headers={"content-type": ctype})
    assert r.status_code == status and set(r.json()) == {"error", "message"}


def test_errors_are_json_and_never_echo_input():
    c, hdr = as_user("root@example.com")
    evil = "<script>alert(1)</script>"
    for r in (c.get("/api/files/" + evil), c.patch(f"/api/clips/{evil}", json={"title": "x"}, headers=hdr),
              c.patch("/api/clips/c1", json={evil: 1}, headers=hdr), c.get("/nope/" + evil),
              c.request("DELETE", "/api/clips/t1", json={"confirm": evil}, headers=hdr),
              c.post("/api/users", json={"email": evil, "role": "viewer"}, headers=hdr)):
        assert evil not in r.text and r.headers["content-type"].startswith("application/json")
        assert set(r.json()) >= {"error", "message"}


# ---------------------------------------------------------------- the Google call itself

def test_verify_google_credential_uses_audience_skew_timeout_and_cache(monkeypatch):
    seen = {}

    def fake_verify(token, request, audience=None, clock_skew_in_seconds=0):
        seen.update(token=token, request=request, audience=audience, skew=clock_skew_in_seconds)
        return {"aud": audience, "iss": "accounts.google.com", "exp": time.time() + 99, "email": "a@example.com",
                "email_verified": True, "sub": "s", "nonce": "N1"}
    monkeypatch.setattr(auth.id_token, "verify_oauth2_token", fake_verify)
    monkeypatch.setattr(auth, "_transport", auth._Transport())
    claims = auth.verify_google_credential.__wrapped__("tok", "N1") if hasattr(auth.verify_google_credential, "__wrapped__") else None
    # the autouse fixture replaced verify_google_credential with the fake: load the real function from the module source
    import importlib.util
    spec = importlib.util.spec_from_file_location("auth_real", auth.__file__)
    real = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(real)
    monkeypatch.setattr(real.id_token, "verify_oauth2_token", fake_verify)
    claims = real.verify_google_credential("tok", "N1")
    assert claims["email"] == "a@example.com" and seen["audience"] == fakes.CLIENT_ID and 0 < seen["skew"] <= 30
    with pytest.raises(real.CredentialError):
        real.verify_google_credential("tok", "OTHER")  # nonce mismatch is rejected even if the library accepts the token

    def boom(*a, **k):
        raise ValueError("Wrong number of segments: secret-token-text")
    monkeypatch.setattr(real.id_token, "verify_oauth2_token", boom)
    with pytest.raises(real.CredentialError) as e:
        real.verify_google_credential("tok", "N1")
    assert "secret" not in str(e.value) and e.value.__cause__ is None


def test_transport_forces_timeout_and_caches_certs(monkeypatch):
    calls = []

    class R:
        status = 200
        data = b"{}"
    monkeypatch.setattr(auth.g_requests.Request, "__call__", lambda self, url, method="GET", body=None, headers=None, timeout=None, **kw: calls.append((url, timeout)) or R())
    t = auth._Transport()
    t("https://www.googleapis.com/oauth2/v1/certs", timeout=120)
    t("https://www.googleapis.com/oauth2/v1/certs", timeout=120)
    assert len(calls) == 1 and calls[0][1] == auth.GOOGLE_TIMEOUT  # 120 s default replaced; second call served from cache


@pytest.mark.parametrize("patch,ok", [({}, True), ({"aud": ["x", fakes.CLIENT_ID]}, True), ({"aud": "no"}, False), ({"iss": "x"}, False),
                                       ({"email_verified": "true"}, False), ({"email_verified": None}, False), ({"exp": 1}, False),
                                       ({"nonce": "other"}, False), ({"nonce": None}, False), ({"email": ""}, False), ({"sub": ""}, False)])
def test_check_claims_is_strict(patch, ok):
    claims = {"aud": fakes.CLIENT_ID, "iss": "accounts.google.com", "exp": time.time() + 60, "email": "a@example.com",
              "email_verified": True, "sub": "s", "nonce": "N"}
    claims.update(patch)
    if ok:
        assert auth.check_claims(claims, fakes.CLIENT_ID, "N")
    else:
        with pytest.raises(auth.CredentialError):
            auth.check_claims(claims, fakes.CLIENT_ID, "N")


def test_check_claims_cannot_be_bypassed_by_a_lenient_verifier(monkeypatch):
    """Even if verify_google_credential returns bad claims, the route re-checks them."""
    monkeypatch.setattr(auth, "verify_google_credential", lambda c, n: {"aud": "evil", "iss": "accounts.google.com", "exp": time.time() + 9,
                        "email": "viewer@example.com", "email_verified": True, "sub": "s", "nonce": n})
    assert login("viewer@example.com")[1].status_code == 403


def test_google_timeout_gives_502_and_slot_stays_held_until_the_worker_ends(monkeypatch):
    from fastapi import HTTPException  # noqa: F401
    from common import ApiError
    monkeypatch.setattr(auth, "VERIFY_DEADLINE", 0.2)
    release = threading.Event()

    def slow(cred, nonce):
        release.wait(10)
        return fakes.fake_verify(cred, nonce)
    monkeypatch.setattr(auth, "verify_google_credential", slow)
    loop = asyncio.new_event_loop()  # no shutdown_default_executor, like a long-running server
    try:
        with pytest.raises(ApiError) as e:
            loop.run_until_complete(A._verified_claims(fakes.cred("viewer@example.com"), "N", common._config()))
        assert e.value.status == 502 and e.value.code == "upstream_error"
        held = []
        try:
            while auth.google_sem.acquire(blocking=False):
                held.append(1)
            assert len(held) == auth.GOOGLE_CONCURRENCY - 1  # the timed-out worker still owns one slot
        finally:
            for _ in held:
                auth.google_sem.release()
        release.set()
        for _ in range(100):
            got = [auth.google_sem.acquire(blocking=False) for _ in range(auth.GOOGLE_CONCURRENCY)]
            for g in got:
                if g:
                    auth.google_sem.release()
            if all(got):
                break
            time.sleep(0.05)
        assert all(got)  # the worker's own finally released it
    finally:
        release.set()
        loop.close()


def test_google_semaphore_full_gives_429_without_calling_google(monkeypatch):
    calls = []
    monkeypatch.setattr(auth, "verify_google_credential", lambda c, n: calls.append(1))
    held = [auth.google_sem.acquire(blocking=False) for _ in range(auth.GOOGLE_CONCURRENCY)]
    try:
        r = login("viewer@example.com")[1]
        assert r.status_code == 429 and r.headers["retry-after"] and calls == []
    finally:
        for _ in held:
            auth.google_sem.release()


# ---------------------------------------------------------------- step-up (reauth)

def test_me_reports_root_and_session_age():
    c, _ = as_user("root@example.com")
    me = c.get("/api/me").json()
    assert me["root"] is True and 0 <= me["session_age_seconds"] < 5
    stale_session(c, "root@example.com", age=1000)
    assert 990 <= c.get("/api/me").json()["session_age_seconds"] <= 1010


def test_reauth_refreshes_the_session_for_the_same_account_only():
    c, hdr = as_user("root@example.com")
    stale_session(c, "root@example.com", age=4000)
    hdr = {"X-CSRF-Token": c.get("/api/me").json()["csrf"]}
    iat_before = common._unsign(SESSION_SECRET, "session", c.cookies.get("__Host-cv_session"))["iat"]
    c.get("/api/auth/config")
    r = c.post("/api/auth/reauth", json={"credential": fakes.cred("viewer@example.com")}, headers=hdr)  # a different account
    assert r.status_code == 403 and c.get("/api/me").json()["session_age_seconds"] >= 3990
    c.get("/api/auth/config")
    r = c.post("/api/auth/reauth", json={"credential": fakes.cred("root@example.com")}, headers=hdr)
    assert r.status_code == 204
    me = c.get("/api/me").json()
    data = common._unsign(SESSION_SECRET, "session", c.cookies.get("__Host-cv_session"))
    assert me["session_age_seconds"] < 5 and data["iat"] == iat_before and data["exp"] == iat_before + 8 * 3600  # TTL not extended
    assert me["csrf"] == hdr["X-CSRF-Token"]


def test_reauth_needs_session_nonce_and_pinned_sub(monkeypatch):
    assert client().post("/api/auth/reauth", json={"credential": fakes.cred("root@example.com")}).status_code == 401
    c, hdr = as_user("root@example.com", sub="sub-r")
    assert c.post("/api/auth/reauth", json={"credential": fakes.cred("root@example.com", sub="sub-r")}, headers=hdr).status_code == 403  # no nonce yet
    c.get("/api/auth/config")
    assert c.post("/api/auth/reauth", json={"credential": fakes.cred("root@example.com", kind="badnonce", sub="sub-r")}, headers=hdr).status_code == 403
    c.get("/api/auth/config")
    assert c.post("/api/auth/reauth", json={"credential": fakes.cred("root@example.com", sub="sub-OTHER")}, headers=hdr).status_code == 403
