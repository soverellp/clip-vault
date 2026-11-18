import time

from fastapi.testclient import TestClient

import common
import fakes
from conftest import SESSION_SECRET
import app as A

BASE = "https://fake-space.hf.space"


def client():
    return TestClient(A.app, base_url=BASE, follow_redirects=False)


def login(email, sub="", kind="ok", c=None):
    """Full sign-in through the real routes. Returns (client, response of POST /api/auth/google)."""
    c = c or client()
    cfg = c.get("/api/auth/config").json()
    assert cfg["client_id"] == fakes.CLIENT_ID
    return c, c.post("/api/auth/google", json={"credential": fakes.cred(email, kind, sub)})


def as_user(email="root@example.com", sub=""):
    """(client, csrf header dict) for a signed-in user."""
    c, r = login(email, sub)
    assert r.status_code == 204, r.text
    return c, {"X-CSRF-Token": c.get("/api/me").json()["csrf"]}


def stale_session(c, email, age=3600):
    """Replace the client's session by one whose last Google sign-in is `age` seconds old (step-up needed)."""
    cfg = common._config()
    now = time.time()
    me = c.get("/api/me").json()
    raw = common.session_cookie_value(cfg, email, me["sub"], me["name"], None, now - age, now - age, now - age + common.SESSION_TTL)
    c.cookies.clear()
    c.cookies.set("__Host-cv_session", raw, domain="fake-space.hf.space", path="/")
