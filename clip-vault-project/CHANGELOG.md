# CHANGELOG (newest first)

> **TL;DR** All dates 2026-11-17, times UTC from `git log` for the older entries. Hashes verified with `git log` in the clipper repo. Add new entries at the TOP. The newest entry below has no hashes: it was written without git access and nothing was committed by the author.

## 2026-11-18 (source pushed to clip-vault main, D41)
- NEW `.claude/scripts/sync_vault_repo.sh` + `.claude/scripts/vault_repo_README.md` (generated top-level README of clip-vault; it replaces the old clipboard-vault placeholder). `.claude/scripts/autosave.sh` calls it after each save (non-fatal, skipped mid-merge or when HEAD is unchanged). Secret scan fails closed; fast-forward only; never force.

## 2026-11-18 (calm Library UI: folders, categories, moment cards)
- `site/hfspace/static`: NEW `js/moments.js`, `css/moments.css`; `library.js` rewritten around folder cards (home), stream pages with category chips, one card per moment with the With girl / Clean pill; sort, view, group, queue, tags and Select moved behind one Filter button; routes `#/stream/<id>`; Close returns to the stream; edit form gets reaction/category/tier/why + "apply to both versions" (static admin).
- `site/hfstatic/src/hubapi.js`: `listStreams()` (thumbnails fetched like posters), `SAFE` allows `streams/<id>/thumb.jpg`, enum/text validation for the new editable fields; `normalizeClip`/`normalizeIndex` pass unknown fields and `streams[]` through unchanged. `site/hfspace/store.py` and `api.js` the same / `listStreams` (empty).
- Tests: hfspace pytest 248 (3 new), hfstatic `test_library.js` (new, Playwright + mock Hub), `ui/v4.js` (new), old UI tests call `L.openFilter`. Screens: `clip-vault-project/screens/`. Doc: `UI-LIBRARY.md`. Not deployed, not committed by the UI agent.

## 2026-11-18 (Library metadata in the vault index, D39)
- `site/hfvault/build_hfvault.py`: `normalize_meta`, `load_vault_meta`, `apply_meta`, `stream_records`, `merge_streams`; the builder writes the contract fields and `streams[]` (thumbnails to `streams/<id>/thumb.jpg`).
- `site/hfvault/vault_sync.py`: NEW entries carry the fields; new mode `--meta-only` (dry run default, `--yes` = one commit with parent revision: index.json + thumbnails + one `meta` audit line, then read-back verify). New `site/hfvault/check_index.py` (read-token fetch of index.json, counts only). New `.claude/skills/clips/scripts/vault_meta.py check`.
- Data: `streams/*/docs/vault_meta.json` (28 Kai Cenat clip folders + 15 + 3 older clips), `streams/*/thumb.jpg` (3 YouTube thumbnails, 640 px). Applied to the live vault with `--meta-only --allow-account-token --yes`: 46 clip entries, 3 streams, 3 thumbnails, verify ok.
- Tests: 141 pass in `site/hfvault/tests` (13 new: dry run, merge keeps admin edits and trash, conflict re-plan, verify failure, token masking, helpers).
- Docs: D39, API-CONTRACT section 0, DATA-MODEL, FLOW, STATUS, `migration-setup/CLIP-VAULT.md`, `site/hfvault/VAULT-SYNC.md`, SKILL.md step 10, lesson `vault-meta-streams-groups-reaction`. Not committed by the author.

## 2026-11-18 (vault uploads with the account token, D38)
- `site/hfvault/vault_sync.py`: uploads may use the account-wide `HF_Token` for all future clip uploads when `--allow-account-token` is passed (user's choice "Allow for all uploads"; no dataset-scoped `VAULT_WRITE_TOKEN` exists yet). The token stays in the process only, masked.
- Uploaded 28 Kai Cenat clips (14 x `with-girl` and `clean`, about 400 MB) to `Soverellp/clip-vault` in 10 commits; `verify` ok (names and sizes only); live site shows 46 clips / 917 MB, no console errors. Phone playback and audio not yet checked.
- Docs: D38 (DECISIONS), FLOW, STATUS, `migration-setup/CLIP-VAULT.md`, lesson `vault-upload-account-token-allowed`. Not committed by the author.

## 2026-11-18 (remember on this device, D37)
- `site/hfstatic`: "Remember on this device" checkbox (default on), silent unlock from `localStorage['cv.pass']`, stale entry cleared, Lock forgets, idle drops only the admin token when remembered, `autocomplete=current-password`. `build_static.py` allows exactly the three `PASS_KEY` calls in `hubchrome.js`; every other storage use still fails the build. Tests added in `test_static.js` and `test_build.py`. Docs: D37, SECURITY, FLOW, STATUS, hfstatic README. Not deployed, not committed by the author.

## 2026-11-18 (static site deployed, D35)
- Deployed `site/hfstatic` to the Static Space `Soverellp/clip-vault-site` (50 files) with `deploy_static.py --accept-weak-passphrase`, run through `with_vault_creds.py`. The passphrase was supplied by the user for that command only; it is not stored in the key dataset.
- Browser test on the live Space (Playwright, 390x844): unlock works, 18 clips / 517 MB shown, no console errors. Admin mode, clip playback, phone and Firefox still untested.
- Docs: D35 (DECISIONS), S8 (FLOW), STATUS update, `migration-setup/CLIP-VAULT.md` status. Not committed by the author.

## 2026-11-18 (review fixes, D34)
- `site/hfvault/with_vault_creds.py`: command allow-list (4 scripts + `--check`), fixed whoami URL, `VAULT_PASSPHRASE` always masked. `vault_sync.py`: `--allow-account-token` required for the account-wide token. `site/hfvault/app.js`: path validation (SAFE).
- `site/hfstatic`: admin token input `type=text` + text-security, admin token checks (unknown whoami format and any outside write permission refused), 15 min idle lock, CSP without `img-src data:`, `deploy_static.py` `delete_patterns`, README drift fixed; docs for the read-token scope, headers and old-config rotation.
- Docs: D34, SECURITY, FLOW, STATUS, `migration-setup/CLIP-VAULT.md`. Not committed by the author.

## 2026-11-17 (latest: pivot to static mode)
- Decisions D23-D31 recorded ([DECISIONS.md](DECISIONS.md)): Docker/Gradio Spaces need PRO (HTTP 402) so the user chose STATIC ONLY; static Space `Soverellp/clip-vault-site` created empty and public; static design `site/hfstatic` (shared-password gate, in-browser admin mode) IN PROGRESS; short human password accepted by the user; server mode kept as a saved option; Google config recorded in [GOOGLE-CONFIG.md](GOOGLE-CONFIG.md); secrets policy; working rules; later hosting ideas.
- Facts: 18 clips (517 MB) in the private dataset; read token confirmed read-only via whoami; CORS proven for the real private dataset from `https://soverellp.github.io`; step-up window is 300 s (not 15 minutes); server mode: 239 pytest passed in `site/hfspace` plus 69 in `site/hfvault`.
- Docs rewritten for the new plan: this folder (DECISIONS, FLOW, ARCHITECTURE, API-CONTRACT as built, DATA-MODEL as built, SECURITY, RUNBOOK, STATUS, README, REQUIREMENTS-HISTORY, new GOOGLE-CONFIG), `migration-setup/` (CLIP-VAULT, README, KNOWLEDGE-BASE, VERIFY, TROUBLESHOOTING, REVOKE-AND-SECURITY, BOOTSTRAP-PROMPT, CLAUDE-ACCOUNT-SETUP), `docs/site/` banners, root `CLAUDE.md` vault lines. Hashes: none yet (not committed). MANIFEST regeneration still to do.
- Still UNTESTED: real Hub commit/LFS/conflict from a browser, a real Static Space load, real Google, phone, H.264 playback, real Docker (not used).

## 2026-11-17 (later)
- 21:29 `7d84149` wip: fonts for the v2 UI under `site/hfspace/static/` (clip-vault-project notes were mentioned in this commit message; the folder itself was created afterwards).
- 21:28 `8be86ec` wip: Space v2 (Google login, admin CRUD, trash) and modern UI in progress.
- 21:26 `c884ddd` site/hfspace: security review fixes applied (hash-locked deps, immutable id allow-list, `__Host-` cookies, POST logout, secrets).
- 21:21-21:25 `06570d0`, `ec3c505`, `b91d482`, `072b897` wip security fixes (Space and credentials wrapper; `ec3c505` and `072b897` also touch `site/hfvault`).
- 21:14 `4d6db2b` site/hfspace: Sign in with Hugging Face; Space proxies clips (D8, D9).
- 21:10 `dfb89c1` wip: HF login rebuild and docs.
- 21:08 `0ffef2b` docs: clip vault Space docs update.
- 21:07 `c70c4be` docs: clip vault docs for HF Space with Google login.
- 21:06 `672472c` deploy script and setup guide; `ec90af7` Google-login Space (D7).
- 21:03-21:04 `1de55e1`, `46a5882` migration-setup audit fixes.
- This folder `clip-vault-project/` created (uncommitted at the time of writing).

## 2026-11-17 (earlier)
- 20:57 `543da8f` migration-setup: vault CORS and read-only rights proven against the real private dataset.
- 20:53 `3d4a7bb` migration-setup: exact vault credential facts, wrapper usage, upload status.
- 20:47 `7ba9838` site/hfvault: `with_vault_creds.py` (D17).
- 20:45 `03195e8` docs: vault runbook, page prompt, old site prompt superseded; index merge on upload.
- 20:42 `1f15f04` site/hfvault: private dataset gallery, passphrase-locked token (D4); `294f5b1` migration-setup: clip vault docs.
- 20:03 `847625e` site/vault public gallery (D3, rejected).
- 19:45 `4176e70` site/share encrypted gallery (D2, rejected).

Per-area commits: `site/hfspace` (ec90af7, 672472c, c70c4be, 4d6db2b, 06570d0, b91d482, c884ddd, 8be86ec, 7d84149 and the wip commits above), `site/hfvault` (1f15f04, 7ba9838, 3d4a7bb, 03195e8, ec3c505, 072b897), `migration-setup` (294f5b1, 3d4a7bb, 543da8f, 1de55e1, 46a5882, 0ffef2b, dfb89c1, plus MANIFEST regenerations 4567b55, 5bd687b, 097e3bd).
