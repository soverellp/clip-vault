# Clip Vault Space: setup (about 20 minutes, once)

Result: https://soverellp-clip-vault-site.hf.space with Sign in with Google. Clips stay in the private dataset
Soverellp/clip-vault; the Space streams them to signed-in people and lets admins manage them. Roles: **viewers** (watch,
download) and **admins** (also edit metadata, upload, trash, restore, delete forever, manage users, read the audit log).
All times in the page are shown in each viewer's local timezone (the server only sends UTC ISO-8601 with `Z`).

## 1. Google Cloud (about 8 minutes, no secret needed)
1. console.cloud.google.com > APIs and Services > Credentials > Create credentials > **OAuth client ID** > type **Web application**
   (first time: configure the consent screen, user type External, add your own address as a test user or publish it).
2. **Authorized JavaScript origins**: `https://soverellp-clip-vault-site.hf.space` (add `http://localhost:8787` only if you test locally).
   Leave "Authorized redirect URIs" empty (Google Identity Services needs none) and do NOT create or download a client secret: the site never uses one.
3. Copy the **Client ID** (`123-abc.apps.googleusercontent.com`). It is public by design (it is a Space *variable*).

## 2. Two Hugging Face tokens for the dataset (about 5 minutes)
- **Read token** (`VAULT_READ_TOKEN`): fine-grained, read access to the dataset `Soverellp/clip-vault` ONLY.
- **Write token** (`VAULT_WRITE_TOKEN`, optional): huggingface.co > Settings > Access Tokens > Create new token > **Fine-grained**;
  under "Repositories permissions" add ONLY `datasets/Soverellp/clip-vault` with **Write access to contents/settings of selected repos**; give no other
  permission (no user, org or inference scopes). It must be a DIFFERENT token from the read token and from the deploy token `HF_Token`.
  Without it the site is read-only (everything works except edits; mutation endpoints answer `503 read_only`). The code refuses a write token equal to the read token, and `deploy_space.py` refuses one equal to `HF_Token`.

## 3. Deploy (about 3 minutes plus 2-3 minutes build)
`site/hfvault/with_vault_creds.py` injects ONLY `HF_Token`, `VAULT_READ_TOKEN` and `VAULT_PASSPHRASE` (unused here; any throw-away value satisfies it).
The write token, the client id and the e-mail lists are NOT injected: export them in the shell first (or type them inline) so they never appear in chat:

    export GOOGLE_CLIENT_ID=123-abc.apps.googleusercontent.com
    export ADMIN_EMAILS=you@gmail.com
    export ALLOWED_EMAILS=friend1@gmail.com,friend2@gmail.com      # optional; admins are viewers too
    export VAULT_WRITE_TOKEN=...                                    # optional; paste it in your own terminal, never in chat
    python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfspace/deploy_space.py

The script creates the public Docker Space if missing and uploads ONLY an allowlist (`Dockerfile, README.md, app.py, auth.py, store.py, admin.py, common.py,
requirements.txt, .gitignore, static/*.js|html|css`; a stray file is never uploaded, the Space repo is public; if the UI later needs images or fonts, extend `ALLOW`).
It sets Space **secrets** `VAULT_READ_TOKEN`, `VAULT_WRITE_TOKEN` (only if set), `SESSION_SECRET` (random, never printed), `VAULT_DATASET`, `ALLOWED_EMAILS` (default: the admin list), `ADMIN_EMAILS`,
and the public **variable** `GOOGLE_CLIENT_ID`. It deletes old public variables and the old `ALLOWED_HF_USERS` secret. It prints only names and OK/ERROR.
*Proposal, not done:* `with_vault_creds.py` could also inject `VAULT_WRITE_TOKEN` (one more line in its credential list). That file is outside this change; until then export the variable yourself as above.
Open the direct URL (not huggingface.co/spaces/...): the page sets `frame-ancestors 'none'`.

## 4. Who may sign in (no redeploy)
- **Easiest: inside the site.** Admin > Users: add an e-mail as viewer or admin, change a role, remove (type the e-mail to confirm). Stored in `users.json` in the dataset; effective within about 5 seconds.
  Adding, changing and removing users needs a recent Google sign-in (`403 reauth_required` then "Confirm it's you").
- **Root admins and secret viewers: Space > Settings > Variables and secrets.** `ADMIN_EMAILS` (root admins: cannot be changed or removed from the site) and `ALLOWED_EMAILS` (viewers). Comma separated, case-insensitive, entry `email` or `email:sub`
  (`sub` = Google's immutable account id; when given it MUST match. To learn it: add the plain e-mail, let the person sign in once, open `/api/me`, then change the entry). An entry `email:` is ignored. Empty lists deny everybody.
  Changes apply on the next request (the Space restarts about 1 minute). Roles are computed at request time, so demoting or removing someone takes effect on their next click; what they already downloaded cannot be taken back.
- **Revoke all sessions at once:** secret/variable `SESSIONS_NOT_BEFORE` = `date +%s`. Sessions last 8 hours.

## 5. Trash, delete, audit
- **Delete = move to Trash**, restorable for **30 days** (files move to `trash/clips/` in ONE commit with the index change). Trash is visible to admins only.
- **Delete forever** needs the exact clip title typed; **Empty trash** needs `EMPTY TRASH` (optionally everything, not only expired). Both need a recent Google sign-in (step-up, 5 minutes).
- Expired trash is purged lazily (next admin list request, at startup, or via Empty trash).
- Every change appends one JSON line `{at, actor_email, action, clip_id, detail}` to `_audit/YYYY-MM.jsonl` in the SAME commit; Admin > Audit shows the last 100. Tokens and cookies are never logged.
- Upload: mp4 up to 150 MB (checked by the `ftyp` bytes), poster jpg up to 3 MB; duplicates (same sha256) are refused with the existing clip id. ffprobe (installed in the image) fills duration, size, fps, codec, bitrate; missing values are null.
- Existing dataset: `site/hfvault/build_hfvault.py` writes the v2 index (sha256, added_at, ffprobe fields). Old v1 indexes still load. With `--upload`, clips already in the remote index keep their trash state and admin edits, and trashed clips are not re-uploaded.

## 6. Honest limits
- Free Spaces sleep after about 48 h without visits (first visit takes about a minute). Clips stream through the Space: bandwidth is Hugging Face's free tier (not measured).
- The code never sends either dataset token to a browser (the read token goes only to huggingface.co, redirects followed by hand without it; the write token exists only inside `store.py`). This holds while the tokens are scoped as above and no dependency has a code-execution bug.
  Nothing in the code checks a token's scope: create them as described. To rotate: new token, set the secret, re-run the deploy.
- The write token can change or delete everything in the dataset: that is the cost of having admin editing. History in the dataset repo is the backup (a deleted clip stays in git history; only the site's index forgets it).
- Concurrency: one commit per change with `parent_commit`; on a conflict the change is re-planned up to 3 times, then `409 conflict`. A second writer (for example `build_hfvault.py --upload` at the same moment) is safe; but `upload_folder` has no parent check, and hard-deleted clips leave no tombstone, so a re-run of the builder re-adds them.
- Google sign-in: the server verifies the ID token (signature, audience, issuer, expiry, `email_verified`, and a nonce that must equal a short-lived signed cookie, so a replayed token fails). Google's certificates are cached 10 minutes; a Google outage blocks NEW sign-ins only (existing sessions keep working for up to 8 hours).
  Verification runs in a worker thread with a hard 8 s limit and at most 8 at once (more get `429`).
- Rate limits: per IP (sign-in 10/min, config 120/min, API 600/min) and per user (admin changes 30/min, uploads 5 per 10 minutes). The IP key uses the last X-Forwarded-For entry, **unverified behind the Hugging Face proxy**: after the first deploy read the one log line `proxy-shape: x-forwarded-for hops=N x-real-ip=yes|no` and adjust `client_ip()` in `common.py` if needed.
- A listed viewer can download clips and share them; removal cannot take back what they saved. A static page cannot hide anything from its viewers: only the files and API are protected.
- Secrets vs logs: the app logs only the `proxy-shape` line and fixed one-line notices; uvicorn access logs are off. Nothing proves no other component prints a URL.
- Dependencies are pinned with hashes: `requirements.in` lists the direct pins; regenerate the lock with
  `uv pip compile requirements.in --generate-hashes --python-version 3.11 --exclude-newer 2026-11-03T00:00:00Z -o requirements.txt` (cutoff = two weeks before the update), re-run the tests. The Docker build with ffmpeg was NOT run here.
- Base image: `FROM python:3.11-slim@sha256:07d4...b535` (digest read 2026-11-17); it gets no security updates by itself: re-resolve it when you update dependencies. ffmpeg comes from Debian's repository at build time (not pinned).

## Tests
`cd site/hfspace/tests && python3 -m pytest -q -p no:cacheprovider` (and `site/hfvault/tests`). Fakes only: real Google, the real Hub (commit conflicts, LFS copies), the real HF proxy headers, the real Space build and real browsers are exercised only after deploy. UI launcher for Playwright: `tests/README.md`.
