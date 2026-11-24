# STATUS (written 2026-11-18 about events up to 2026-11-17)

> **TL;DR** Clips are uploaded (18 clips, 517 MB). The CURRENT plan is STATIC mode: the free Static Space `Soverellp/clip-vault-site` exists but is EMPTY; `site/hfstatic` (password gate + in-browser admin mode) is IN PROGRESS. Server mode (`site/hfspace`, Google sign-in) is built and mock-tested but NOT deployed (needs a paid Space, D23). Nothing is security-reviewed except the old HF-OAuth variant. No real-Space, real-browser-commit, real-Google or phone test has happened.

## Proven (real systems)
- Source push (D41, 2026-11-18): `.claude/scripts/sync_vault_repo.sh` mirrors the vault source to `soverellp/clip-vault` main with a secret scan; autosave runs it (non-fatal). Verified once for real, see CHANGELOG. Untested: a fresh-container clone, the rebase-on-rejection path.
- Library metadata (D39, 2026-11-18): the live index has `streams[]` (3 streams, thumbnails fetched back with the read token: HTTP 200) and per-clip group/variant/reaction/kind/why on 46/46 clips, ranks 1-14; `vault_sync.py --meta-only --yes` committed it in one commit and read it back (`verify ok`). NOT proven: the Library UI reading it; an admin edit keeping the fields (the static client and `store.py` drop unknown fields, see D39 consequences); the reactions are the census and the user's list, nobody watched the webcams or listened to the audio.
- 18 clips (517 MB) uploaded to the private dataset `Soverellp/clip-vault`.
- The read token was confirmed READ-ONLY via whoami; it gets `index.json` (200, 18 clips) and a clip at the exact local size (30,861,167 bytes); anonymous gets 401; the read token cannot write (403).
- CORS for the real private dataset from the origin `https://soverellp.github.io` (earlier test; the Static Space origin is not yet tested).
- The Static Space `Soverellp/clip-vault-site` was created empty and public through the API (static creation is allowed with the write token); a Docker Space creation returned HTTP 402 and the user's screenshot says Docker/Gradio need a paid plan (D23, D24).

## Proven with mocks only (server mode, saved option)
| Area | Result | Notes |
|---|---|---|
| `site/hfspace/tests` | 239 pytest passed | fake Google, fake store (same contract as the real one), fake `huggingface_hub` for `store.py` |
| `site/hfvault/tests` | 69 pytest passed | build and wrapper |
| UI | UI launcher with a real backend on seeded fake data exists (`tests/README.md`); the older `test_ui.js` is for the previous launcher | counts for a current Playwright run: not recorded |
Counts are as reported by the coordinator; this note did not re-run them.

## Review fixes applied 2026-11-18 (D34), mock-tested only
Static-site review findings 1-10 are applied (wrapper allow-list, no whoami override, passphrase masking, admin token box, CSP, `delete_patterns`, old-page path check, admin token checks, idle lock, `--allow-account-token`). Tests after the fixes: site/hfvault 128 pytest, site/hfstatic 30 pytest + 106 Playwright assertions, site/hfspace 245 pytest (hfspace UI run skipped, static UI untouched). Not re-reviewed by Opus; not run against the real Hub.

## Added 2026-11-18 (D37), mock-tested only
"Remember on this device" on the static unlock screen (passphrase in localStorage `cv.pass`; Lock forgets; idle drops only the admin token). `site/hfstatic` Playwright and pytest pass against a mocked Hub; not yet tried on the live Space or a phone; the live Space needs a redeploy to get it.

## In progress
- `site/hfstatic`: static page, password gate, admin mode; and its UI. It did not exist in the tree when this note was written: describe it as in progress and link its README once present.

## NOT SECURITY-REVIEWED (D30)
The static client (gate, admin mode, write-token handling) and the server mode v2 (Google sign-in, roles, users, trash, step-up, upload, WebGL UI). Only the earlier HF-OAuth variant was reviewed (0 blocker, 0 high, 5 medium, 12 low, all fixed).

## Untested (still)
1. Real Hub commit, LFS and conflict behaviour from a browser (static admin mode).
2. A real Static Space load of the page, and CORS from the Space origin.
3. Real Google sign-in (server mode only), real Docker (not used).
4. A phone; H.264 playback in a real browser.
5. `X-Forwarded-For` behind the HF proxy (server mode rate-limit key).
6. Streaming speed of clips from the Hub.

## Not built
- In-site "Change password" screen for static mode (planned later).
- Dedicated revocable read token for the gate (reusing `Clip_vault_HFToken` for now).
- Move to GitHub `soverellp/clip-vault` (D20); optional GitHub Actions admin backend and Cloudflare Workers port (D31).

## Accepted risks
- The gate password is a short human password the user chose and accepted the risk for (offline guessing against the public config, D26).
- `HF_Token_backup` (old full-write token) is still not revoked (D19; whether already revoked: UNVERIFIED).

## Open questions
1. Is `HF_Token_backup` revoked? (D19)
2. HF free dataset storage limit for growing clips (UNVERIFIED).
3. Max upload size and commit behaviour from a browser (static admin mode).
4. Which other fields did the user enter on the Google consent screen? (D28, UNVERIFIED)
5. Are Space secrets never exposed to forks of a public Space? (server mode, UNVERIFIED)
6. The Claude environment cannot currently be edited by the user (D29): when will it be possible?

## Next steps (in order)
1. Finish `site/hfstatic` and its UI.
2. Deploy it to the Static Space (RUNBOOK section 2).
3. The user tests the gate and admin mode (checklist in [../migration-setup/VERIFY.md](../migration-setup/VERIFY.md)).
4. Docs pass: replace "design" text with tested facts; request the security review when the user asks (D30).

## Update 2026-11-18 (D35)
- **Deployed:** `site/hfstatic` is live on the Static Space `Soverellp/clip-vault-site` (50 files), via `with_vault_creds.py ... -- python3 site/hfstatic/deploy_static.py --accept-weak-passphrase`. The user chose a short passphrase and accepted the risk (D26). The passphrase was passed for that one command only; it is not in the key dataset and should be stored in the Claude environment for future deploys.
- **Proven (real browser, live Space, 390x844 viewport, Playwright):** unlock with the password works; gallery shows 18 clips / 517 MB; no console errors.
- **Still UNTESTED:** admin mode real commit and LFS upload; playing a clip; a real phone; Firefox.
- **Security review:** Opus review done; fixes in D34.
- **Next:** the user tests on a phone; then move to GitHub repo `soverellp/clip-vault` (D20) once the static site works from clipper.

## Update 2026-11-18 (D38, uploads)
- **Decided:** `vault_sync.py` uploads may pass `--allow-account-token` for ALL future clip uploads (the user chose "Allow for all uploads"). Reason: no dataset-scoped `VAULT_WRITE_TOKEN` exists in the environment yet. Accepted risk: the account-wide token can write to every repo of the account; it stays in the upload process only, masked. Recommended later: a dataset-scoped `VAULT_WRITE_TOKEN`.
- **Proven:** 28 Kai Cenat clips (14 clips x `with-girl` and `clean`, files `youtube-shorts.mp4` and `clean.mp4`, about 400 MB) uploaded to `Soverellp/clip-vault` in 10 commits; `verify` ok (names and sizes only); the live site shows 46 clips / 917 MB; no console errors.
- **Still UNTESTED:** playback of the new clips on a phone; the audio has never been listened to.
