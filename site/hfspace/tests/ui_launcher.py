#!/usr/bin/env python3
"""Boots the REAL backend (app.py) with FAKES for Playwright/UI work: in-memory VaultStore, fake Google verifier, fake env.

    python3 site/hfspace/tests/ui_launcher.py [PORT]        (default 8787; needs fastapi, uvicorn, python-multipart, requests)

What is fake: the dataset (tests/fakes.py), Google (credentials look like `ok:<email>:<sub>:<24+ chars of padding>`; the REAL
claim checks still run: wrong nonce/aud/issuer/expiry/unverified e-mail are rejected), the secrets (all throw-away).
What is real: every route, cookie, CSRF check, rate limit, security header, the CSP, the upload parser, step-up.

Test-only helpers live ONLY in this file (never in app code):
    GET /__as/<email>[?stale=1][&sub=..]   sign in as that account without Google (sets the real signed session cookie, 302 to /)
                                           stale=1 makes the last Google sign-in 1 hour old, so step-up actions answer reauth_required
    GET /__reset                           re-seed the fake vault (3 active clips, 1 in trash, users) and clear rate limits
    GET /__accounts                        JSON list of the seeded accounts and roles
Accounts: root@example.com (admin, ROOT), boss2@example.com (admin, added in the site), viewer@example.com and
friend@example.com (viewers from ALLOWED_EMAILS), guest@example.com (viewer added in the site). Any other e-mail is not listed (403).
Media: a real 3 s 360x640 mp4 and a jpg poster are made with ffmpeg when it exists (otherwise fake bytes: not playable).
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

FAKE_ENV = {"VAULT_READ_TOKEN": "hf_" "FAKE_read_token_0000", "VAULT_WRITE_TOKEN": "hf_" "FAKE_write_token_1111",
            "SESSION_SECRET": "launcher-secret-" + "x" * 32, "GOOGLE_CLIENT_ID": "fake-client-id.apps.googleusercontent.com",
            "ALLOWED_EMAILS": "viewer@example.com,friend@example.com", "ADMIN_EMAILS": "root@example.com"}
for k, v in FAKE_ENV.items():
    os.environ[k] = v
for k in ("VAULT_DATASET", "SESSIONS_NOT_BEFORE"):
    os.environ.pop(k, None)

import fakes  # noqa: E402  (after the env: fakes.CLIENT_ID is read by the verifier through common._config)

fakes.CLIENT_ID = FAKE_ENV["GOOGLE_CLIENT_ID"]
import auth  # noqa: E402
import common  # noqa: E402
import store  # noqa: E402
import app as appmod  # noqa: E402
from fastapi.responses import JSONResponse, RedirectResponse  # noqa: E402

ACCOUNTS = {"root@example.com": "admin (ROOT)", "boss2@example.com": "admin (site)", "viewer@example.com": "viewer (secret)",
            "friend@example.com": "viewer (secret)", "guest@example.com": "viewer (site)"}
STATE = fakes.FakeState()
MEDIA = {"mp4": fakes.MP4, "jpg": fakes.JPG}


def make_media():
    if not shutil.which("ffmpeg"):
        return
    d = Path(tempfile.mkdtemp(prefix="cv-launcher-"))
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=360x640:r=24:d=3", "-f", "lavfi", "-i", "sine=d=3",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", "-y", str(d / "v.mp4")],
                       check=True, timeout=60)
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=360x640", "-frames:v", "1", "-y", str(d / "p.jpg")],
                       check=True, timeout=60)
        MEDIA["mp4"], MEDIA["jpg"] = (d / "v.mp4").read_bytes(), (d / "p.jpg").read_bytes()
    except Exception:
        pass
    finally:
        shutil.rmtree(d, ignore_errors=True)


def reseed():
    STATE.files.clear()
    STATE.commits.clear()
    clips = [fakes.clip("morning-run-20261110-100000", "Morning run highlights", stream="stream-2026-11-10", tags=["run", "morning"], dur=47.2, score=9.1),
             fakes.clip("clutch-play-20261109-180000", "Clutch play of the night", stream="stream-2026-11-09", tags=["clutch"], dur=41.0, score=8.4,
                        added_at="2026-11-09T18:00:00Z", updated_at="2026-11-09T18:00:00Z"),
             fakes.clip("funny-fail-20261108-120000", "Funny fail compilation", stream="stream-2026-11-08", poster=None, dur=52.3, score=7.2,
                        added_at="2026-11-08T12:00:00Z", updated_at="2026-11-08T12:00:00Z"),
             fakes.clip("old-take-20261001-090000", "Old take that was trashed", stream="stream-2026-10-01", trashed=True)]
    for c in clips:
        c["size"] = len(MEDIA["mp4"])
    fakes.seed(STATE, clips, users=[{"email": "boss2@example.com", "role": "admin", "added_at": "2026-11-01T09:30:00Z", "added_by": "root@example.com"},
                                    {"email": "guest@example.com", "role": "viewer", "added_at": "2026-11-05T14:00:00Z", "added_by": "boss2@example.com"}])
    for p in list(STATE.files):
        if p.endswith(".mp4"):
            STATE.files[p] = MEDIA["mp4"]
        elif p.endswith(".jpg"):
            STATE.files[p] = MEDIA["jpg"]
    store.invalidate()
    common._hits.clear()


def install():
    make_media()
    reseed()
    store.VaultStore = fakes.make_store_class(STATE)
    store.reset()
    auth.verify_google_credential = fakes.fake_verify
    appmod.fetch_upstream = fakes.fake_fetch_factory(STATE)
    appmod._proxy_logged = True

    @appmod.app.get("/__as/{email}")
    def login_as(email: str, stale: int = 0, sub: str = ""):
        cfg = common._config()
        now = time.time()
        iat = now - (3600 if stale else 0)
        resp = RedirectResponse("/", status_code=302)
        common._set_cookie(resp, common.SESSION_COOKIE, common.session_cookie_value(
            cfg, email.lower(), sub or "sub-" + email.split("@")[0], email.split("@")[0].title(), None, iat, iat, iat + common.SESSION_TTL),
            common.SESSION_TTL)
        return resp

    @appmod.app.get("/__reset")
    def reset():
        reseed()
        return JSONResponse({"ok": True})

    @appmod.app.get("/__accounts")
    def accounts():
        return JSONResponse(ACCOUNTS)
    for _ in range(3):  # the static mount is the last route and would swallow /__*: move ours in front of it
        appmod.app.router.routes.insert(0, appmod.app.router.routes.pop())
    return appmod.app


if __name__ == "__main__":
    import uvicorn
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    application = install()
    print(f"ui_launcher: http://127.0.0.1:{port}/  (sign in: /__as/root@example.com, /__as/viewer@example.com, ...; reset: /__reset)", flush=True)
    uvicorn.run(application, host="127.0.0.1", port=port, log_level="warning", access_log=False)
