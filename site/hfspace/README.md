---
title: Clip Vault
emoji: 🎬
colorFrom: purple
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Clip Vault site

A small page to watch, download and manage clips stored in a private Hugging Face dataset. People sign in with
Google (Google Identity Services; the server verifies the ID token and its nonce). Two roles: **viewers** (watch and
download) and **admins** (edit metadata, upload, trash and restore, delete forever, manage users, read the audit log).
Lists come from the `ALLOWED_EMAILS` and `ADMIN_EMAILS` Space secrets (entries `email` or `email:sub`) plus a `users.json`
file in the dataset that admins edit in the site. The Space is a proxy: the code keeps the dataset tokens inside the
Space and never sends them to a browser (this assumes the read token is read-only, the write token is scoped to the dataset
only, and the dependencies are sound; see SETUP.md).

- `app.py`: wiring, security headers, sign-in routes, `/api/me`, file proxy, static hosting.
- `auth.py`: the only module that talks to Google (`verify_google_credential`).
- `store.py`: the only module that writes to the dataset (`VaultStore`, one commit per change, optimistic concurrency).
- `admin.py`: clip and user endpoints. `common.py`: config, cookies, sessions, rate limits.
- `static/`: the page. All times are shown in the viewer's local timezone; the server only sends UTC ISO-8601 with `Z`.
- Configuration: secrets `VAULT_READ_TOKEN`, `VAULT_WRITE_TOKEN` (optional), `SESSION_SECRET`, `VAULT_DATASET`,
  `ALLOWED_EMAILS`, `ADMIN_EMAILS`; variable `GOOGLE_CLIENT_ID` (public); optional `SESSIONS_NOT_BEFORE`.
- Dependencies are pinned with hashes (`requirements.in` -> `requirements.txt`); the deploy uploads an allowlist of files only.

Setup steps: see `SETUP.md` in the repository (site/hfspace). Tests: `tests/README.md`.
