# Tests and the UI launcher

## Run the backend tests (about 15 seconds)

    cd site/hfspace/tests && python3 -m pytest -q -p no:cacheprovider
    cd site/hfvault/tests && python3 -m pytest -q -p no:cacheprovider

Everything is faked: no network, no real tokens. `fakes.py` holds the in-memory `VaultStore` (same contract as the real one:
snapshot, `commit(rev, changes, month)` raising `Conflict` on a stale revision, audit line in the same commit) and the fake
Google verifier (`fake_verify`; the REAL `auth.check_claims` still judges audience, issuer, expiry, e-mail verification and nonce).
`test_store.py` exercises the real `VaultStore` against a fake `huggingface_hub`. Needs: fastapi, starlette, httpx, pytest,
python-multipart, requests, google-auth, huggingface_hub, uvicorn (ffmpeg/ffprobe optional; a few tests skip without it).
`test_ui.js` is an older Playwright script written for the previous (Hugging Face login) launcher; it does not use this launcher.

## UI launcher (real backend, fake data) for Playwright

    python3 site/hfspace/tests/ui_launcher.py 8787

Opens `http://127.0.0.1:8787/` with the real routes, cookies, CSRF, CSP, rate limits, upload parser and step-up, on seeded data:
3 active clips (one without a poster), 1 clip in the trash, 2 site-managed users. Test-only helpers exist ONLY in the launcher file:

| URL | what it does |
|---|---|
| `/__as/root@example.com` | sign in as a root admin (302 to `/`). Others: `boss2@example.com` (admin made in the site), `viewer@example.com`, `friend@example.com`, `guest@example.com` (viewers) |
| `/__as/<email>?stale=1` | same, but the last Google sign-in is 1 hour old, so delete forever / empty trash / users changes answer `403 reauth_required` until `POST /api/auth/reauth` |
| `/__reset` | re-seed the fake vault and clear the rate limits (call it between Playwright tests) |
| `/__accounts` | JSON list of the seeded accounts |

Google is replaced on the server: `GET /api/auth/config` then `POST /api/auth/google {"credential": "ok:<email>:<sub>:<24+ padding chars>"}`
signs in (kinds `badnonce`, `badaud`, `unverified`, `badiss`, `expired`, `boom` exercise the failure paths). The page itself must stub
`window.google.accounts.id` (or the real GIS script is blocked offline) and call its callback with such a string. The session cookie is
`__Host-` + Secure; Chromium accepts it on `http://127.0.0.1`. Media: a real 3 s 360x640 mp4 and a poster are generated with ffmpeg if
it exists (otherwise fake, unplayable bytes). Uploads and edits go to memory and vanish on restart or `/__reset`.
