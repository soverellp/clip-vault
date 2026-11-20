# DECISIONS (ADR log, newest first)

> **TL;DR** 39 decisions, made on 2026-11-17 and 2026-11-18 with the user. CURRENT plan (D23-D26, D35): a pure STATIC Hugging Face Space (`Soverellp/clip-vault-site`, DEPLOYED 2026-11-18, D35; live test partly done) with a shared-password gate that decrypts a read-only token in the browser, plus an admin mode that uses a pasted write token held only in memory. The Google/roles/trash FastAPI server design (D9, D11-D16, D18, D22) is KEPT AS A SAVED OPTION (D27), built and mock-tested but NOT deployed, because Docker/Gradio Spaces need the HF PRO plan (D23). Append new entries at the TOP of the list; never rewrite old ones (mark them superseded).

Status values: Accepted, Superseded, Rejected, Open, In progress.
Order below: D41 first (D40 is not used) (latest), D1 last.
Reading guide after D23: D9, D11-D16, D18 and D22 describe the SERVER MODE (saved option, D27). They stay accurate for that mode but are not the current plan. Everything is "not security-reviewed" except the earlier HF-OAuth variant (D10), see D30.

---

## D44. Shortlist changeable by anyone who unlocks the site (no admin mode): shortlist token inside the passphrase-encrypted config
- **Date:** 2026-11-20
- **Decision:** `config.json` carries a second secret `sl` (shortlist writer token, same PBKDF2 key, own random iv, plus `dataset` and `path` in the clear). After unlocking, any friend stars or unstars a moment: one commit at the parent revision to the shortlist file plus an audit line (`actor: shortlist`). Clip reads keep the read-only token; admin mode is unchanged. Supersedes the "admin-only" part of D43.
- **Options:** (a) separate tiny dataset `Soverellp/clip-vault-shortlist` with a token scoped to ONLY it (the safe design; supported by `--shortlist-dataset`, tested with a mock, NOT created: no such token exists); (b) keep `_config/shortlist.json` in the clip dataset (chosen).
- **Why:** owner: no new token, "I am not concerned about that security". The environment has `Clip_vault_HFToken` (fine-grained READ-only on the clip dataset: cannot write), `HF_Tokem` (fine-grained, `repo.write` on `Soverellp/clip-vault` AND on the whole user namespace, i.e. effectively account-wide write) and `HF_Token_backup` (account write). Only `HF_Tokem` can write, so it is the shortlist token.
- **Consequences:** anyone with the passphrase who decrypts config.json can also read that token and write ANY of the owner's repos (clips, other datasets, spaces). The passphrase now guards write access, not just reading. Reversible: rebuild the config without `VAULT_SHORTLIST_TOKEN` (shortlist goes read-only), rotate the token, or move to option (a) later. Tests: site/hfstatic/tests/test_shortlist.js (55 checks, mock Hub), test_build.py. NOT proven on the real Hub or a real browser. The real config is NOT rebuilt yet: run `bash site/hfstatic/deploy_config.sh` with `VAULT_PASSPHRASE` set (verifies decrypt before upload).
- **Status:** Accepted (code ready, config deploy pending the passphrase).

## D43. Shortlist: admin-only star per moment, `_config/shortlist.json`, visible to every friend
- **Date:** 2026-11-20
- **Status:** Accepted, built in the static site, tested with the MOCKED Hub only (node pure 12, browser 40, pytest +8); deploy as a `--only` patch; NOT yet run on the live vault or a real phone.
- **Decision:** the owner can shortlist the clips he likes and wants to post. A star on every card and in the clip detail, a "Shortlisted N" filter chip (combines with the stream, category and version filters) and a "Copy shortlist" button (plain text: title, stream, post caption). The shortlist is per MOMENT: key `<stream>|<group>` for a clip with group and variant (so with-streamer, clean and face-top share one star), else the clip id. Stored in the dataset as `_config/shortlist.json` `{"version":1,"ids":[{"id","at","note?"}]}`; the read-only friends SEE it (star read-only, hint "Admin mode to change"); only admin mode (pasted write token) toggles it.
- **How it is written:** same commit engine as every admin edit (`setShortlist` in `site/hfstatic/src/hubapi.js`): read the file at the parent revision, change it, commit it with the audit line (`shortlist` / `unshortlist`) in ONE commit, retry on a conflict; an existing file that cannot be parsed FAILS the toggle instead of being overwritten; ids stay deduped (newest 2000 kept). Nothing goes to localStorage; the write token stays in memory.
- **Stale ids:** ids of deleted or trashed clips stay in the file but are ignored everywhere (chip count, view, copy). Auto-refresh (60 s poll) re-reads the file with the index, so a star set elsewhere shows up without a reload.
- **Never touched by:** `vault_sync.py` (its `commit` now refuses any path under `_config/`; test), `build_hfvault.py` and `finalise.py` (no write to it; test), `deploy_static.py` (it deploys the Space, not the dataset; `config.json` and the passphrase gate are unchanged).
- **Scope freeze:** no notes UI (the `note` field exists in the file only), no export, no ordering; new ideas go to the backlog in `PLAN.md`.

## D42. `vault_sync.py --refresh-text`: the owner's rewritten post kits reach existing vault entries
- **Date:** 2026-11-19
- **Status:** Accepted, built, tested with the fake store (6 new tests, hfvault pytest 149); NOT yet run on the live vault.
- **Decision:** existing remote entries never got new text because title/hook/desc/post/tags are remote-wins (admin edits). The explicit flag `--refresh-text [--stream S] [--ids a,b]` (dry run unless `--yes`) overwrites exactly those five fields from the local clip, skips trashed/tombstoned/absent clips, writes one commit with an audit line `refresh-text` (field names only), and verifies by read-back. Default sync behaviour is unchanged.
- **Consequence:** it overwrites admin edits of those fields for the matched clips, so use `--stream`/`--ids` and read the dry run first.

## D41. Source code is pushed to the main branch of BOTH repos automatically (clipper and clip-vault), with a secret scan
- **Date:** 2026-11-18
- **Status:** Accepted (owner: "keep pushing the source code to the GitHub repos main branch"); first push done, see CHANGELOG
- **Decision:** (1) Every `bash .claude/scripts/autosave.sh` also runs `.claude/scripts/sync_vault_repo.sh`, which mirrors the clip-vault file set into `soverellp/clip-vault` and pushes to its `main`. (2) clipper `main` gets the non-stream files from `finalise.py --sync-docs` (unchanged); streams/ is never pushed by either route. (3) No force-push; fast-forward only; on a rejected push one normal rebase onto `origin/main`, then retry (4 tries with backoff). (4) A secret scan runs on the staged diff before every commit and fails closed (prints file names only): `hf_`/`KGAT_` tokens of 20+ characters, private-key headers, `AKIA` keys, the known retired owner password string, password-like string assignments in scripts. (5) A failure of the sync is only a warning; autosave is unaffected.
- **What goes where:** clip-vault gets `site/hfstatic`, `site/hfspace`, `site/hfvault`, `clip-vault-project/`, `migration-setup/CLIP-VAULT.md` and a generated top-level `README.md` (template `.claude/scripts/vault_repo_README.md`). Left out: `dist/`, `build-info.json`, `node_modules`, `__pycache__`, `*.pyc`, `.env*`, logs and scratch output, key/credential files, any file over 5 MB. clipper `main` gets everything outside `streams/`.
- **Why:** the owner wants the source safe on GitHub without manual steps, and the vault code reviewable as its own repo.
- **Consequences:** edits made directly in `clip-vault` are overwritten by the next sync (edit in clipper). The scan is pattern-based and does not prove the absence of secrets; docs are the likeliest place for a slip.

## D40. Library order = newest CLIPPED first; visible sort; working Filter; language chips (`clipped_at`, `lang`)
- Date: 2026-11-18
- **Decision:** the owner means "newest clipped" (when the clip was rendered), not the YouTube upload date. Each clip entry gets `clipped_at` (UTC ISO with time, `vault_meta.json`) and `lang`; each `streams[]` entry gets `clipped_at` (= its newest non-trashed clip), `lang` and `lang_name`. Folders sort by `clipped_at`, falling back to `date` for old data. A visible sort control sits outside Filter on both screens; the Filter button filters folders on the home screen (has reactions, has best picks) and the clips inside a stream; a language chip row shows on home only when 2 or more languages exist.
- **How `clipped_at` is set** (`vault_meta.py stamp`): the FIRST git commit that contains the clip's video (autosave runs seconds after a render; a later re-render is a later commit, so this is the original render, e.g. 13259 was re-rendered at 14:09 but is stamped 13:39). Both variants of a moment get the main (with-streamer) clip's time. The 18 older clips were bulk-imported in one commit, so they get their `created` day at 00:00:00Z (DAY ONLY, the time of day is unknown; the UI shows the day without a time). `lang` is copied from the stream's `language` (`stream.json`/`index.json`); never guessed, `unknown` when absent.
- **Consequences:** the live index was updated with `vault_sync.py --meta-only` (one commit, only these fields). Both older streams are `hi` in `stream.json`; "THIS IS NOT A GAME" was not checked for English speech.
- Status: done (UI proven with Playwright fixtures + mocked Hub only).

## D39. Library metadata in the vault index: `streams[]`, per-clip group/variant/reaction/tier/rank/why, stream thumbnails (`vault_sync.py --meta-only`)
- **Date:** 2026-11-18
- **Status:** Accepted; applied to the live vault (46 clips, 3 streams, 3 thumbnails); the Library UI that reads it is built by another agent and NOT yet checked against it
- **Decision:** (1) The index carries what the new Library UI needs: top-level `streams` and per-clip `stream, group, variant, reaction, reaction_note, kind, tier, rank, why, hook`. All fields are OPTIONAL so old clients keep working; the exact contract is [API-CONTRACT.md](API-CONTRACT.md) section 0. (2) Source of truth in the repo: `streams/<s>/docs/vault_meta.json` (keyed by clip folder id, written by the census/render steps, SKILL.md step 10) and `streams/<s>/thumb.jpg` (the stream's public YouTube thumbnail, scaled to 640 px wide). (3) `build_hfvault.py` and `vault_sync.py` write these fields into NEW entries; the new mode `vault_sync.py --meta-only` merges them into the EXISTING remote index in ONE commit with `parent_commit`, uploads `streams/<id>/thumb.jpg`, writes one audit line (`action: "meta"`) and reads the index back to verify. (4) Ownership: the contract fields always come from `vault_meta.json`, except `stream` and `hook`, which admins edit in the site: those are filled only when empty. Title, desc, post, tags, trash state, sha256, size and files are never touched; clips that are not in the vault are left alone; nothing is ever deleted. (5) Honesty rules for the data: `reaction` is `unrated` when nobody could judge it (old streams, webcam too small), `rank` and `tier` are `null` when unknown and are never invented; the Kai Cenat ranks follow the Opus review (c26 1, c40 2, c7 3, c21 4, c4 5, c364 6, c347 7, c344 8, c355 9, c318 10, c346 11, then c381, c373, c394) and the reactions follow the user's list (strong c21, c40; mild c4, c7, c26, c347, c373; the rest none or unrated). (6) The 18 older clips are rated `unrated`, each is its own `group`, `variant` is `with-girl` (all have the girl facecam).
- **Why:** the Library UI groups clips by stream and moment, shows the two versions together, sorts by rank and filters reaction clips; the data had to exist in the index, not only in the repo docs.
- **Facts (2026-11-18):** the 18 older clips are from TWO streams (15 gamerfleet, 3 `this-is-not-a-game`), so `streams[]` has 3 entries, not 2. Thumbnails came from `https://i.ytimg.com/vi/<video id>/maxresdefault.jpg` fetched directly from this machine (HTTP 200 for all three), scaled to 640 px with ffmpeg (49-56 KB each); no Kaggle route and no clip poster fallback were needed. The live run used `--allow-account-token` (D38): one commit, 46 clip entries, 3 stream entries, 3 thumbnails, 1 audit line; `verify ok`; `site/hfvault/check_index.py` (read-token route, counts only) shows 46/46 clips with stream, group, variant, reaction, kind, why, ranks 1-14, thumbnails HTTP 200. Tests: 141 hfvault tests pass (128 old + 13 new).
- **Consequences:** (a) RISK: a client that rewrites `index.json` and rebuilds each clip from a fixed field list drops the new fields and `streams`. `site/hfstatic/src/hubapi.js` (`normalizeClip`, `normalizeIndex`) and `site/hfspace/store.py` (`normalize_clip`, `normalize_index`) both did when read on 2026-11-18; the first admin edit would erase the Library data until `--meta-only` is run again. The UI owner must pass unknown fields and `streams` through. (b) Every new stream needs `vault_meta.json` before `vault_sync` (SKILL.md step 10; lesson `vault-meta-streams-groups-reaction`; `vault_meta.py check` validates it). (c) After a normal upload of a new stream run `vault_sync.py --meta-only` once for `streams[]` and the thumbnail. (d) Not tested: the Library UI reading this data, an admin edit after the meta commit, playback on a phone.

## D38. Account-wide token allowed for ALL future vault uploads (`vault_sync.py --allow-account-token`; relaxes the D34 item 10 refusal for vault_sync only, at the user's request)
- **Date:** 2026-11-18
- **Status:** Accepted (the first use is done; see the fact below)
- **Decision:** (1) The user answered "Allow for all uploads" (option 1): `vault_sync.py` uploads may use the account-wide HF token (`HF_Token`) for ALL future clip uploads, with `--allow-account-token` passed on the command. (2) Reason: no dataset-scoped `VAULT_WRITE_TOKEN` exists in the environment yet, so without this flag every upload is refused. (3) Accepted risk: the account-wide token can write to every repo of the account, not only the vault. It stays inside the upload process only: it is masked, never put in the environment, on the command line or in any file. (4) Recommended later: create a dataset-scoped `VAULT_WRITE_TOKEN` (write on `Soverellp/clip-vault` only) and store it in the Claude environment; then the flag is no longer needed. (5) This relaxes the D34 refusal for `vault_sync.py` only. `with_vault_creds.py`, the admin mode and the read token are unchanged.
- **Why:** the user wants uploads to run without a new token step each time; the account-wide token is already in the environment, and the user owns the risk.
- **Consequences:** a leaked `HF_Token` can change any repo of the account, not only the vault. The lesson `vault-upload-account-token-allowed` records the rule for future sessions (dry run first, then `--yes` detached with a log). Fact (2026-11-18): 28 Kai Cenat clips (14 clips, each with the `with-girl` and `clean` versions, files `youtube-shorts.mp4` and `clean.mp4`, about 400 MB) were uploaded to `Soverellp/clip-vault` in 10 commits; `verify` reported ok (names and sizes only); the live site shows 46 clips / 917 MB and no console errors. NOT yet proven: playback of the new clips on a phone; the audio has never been listened to.

## D37. "Remember on this device": the shared passphrase may be kept in localStorage (owner's request; relaxes the "nothing stored" rule of D25/D34)
- **Date:** 2026-11-18
- **Status:** Accepted (Playwright-tested against a mocked Hub; not yet tried on the live Space or a phone)
- **Decision:** (1) The unlock screen has a "Remember on this device" checkbox, checked by default. When ticked and the unlock succeeds, ONLY the passphrase is stored, in `localStorage` under the single key `cv.pass`. (2) On load a stored passphrase unlocks silently; if it fails (rotated passphrase or config) the key is removed and the normal screen shows the generic message. (3) The explicit Lock button (and the palette Lock command) removes the key. (4) The 15 min idle timer no longer locks when a passphrase is remembered (it would defeat the feature); it only drops the admin write token. Without a remembered passphrase the idle lock is unchanged. (5) The admin write token and the read token are NEVER stored; they are still wiped on Lock, reload and idle. (6) The unlock input has `autocomplete="current-password"` so password managers also work. (7) All storage code lives in `site/hfstatic/src/hubchrome.js` only; `build_static.py` allows exactly `localStorage.getItem/setItem/removeItem(PASS_KEY)` there (with `const PASS_KEY = 'cv.pass'` declared once) and fails the build on any other storage use or any use in another file. Server mode (`site/hfspace/static`) is untouched.
- **Why:** the owner asked that friends should not retype the passphrase on every visit.
- **Risk (accepted by the owner):** anyone who can use the unlocked device (or read its browser profile) and any XSS on the Space origin can read the passphrase, and the passphrase decrypts the read token, so it exposes every clip. Mitigations: CSP `script-src 'self'` with no third-party scripts, Lock forgets, the box can be unticked (shared or public computers), per-device only. If a device is lost or shared, rotate the passphrase and the read token (SECURITY.md, Rotation steps).
- **Consequences:** a remembered tab stays unlocked until Lock; after a failed silent unlock the usual 1 s attempt delay applies to the next manual try. Tests: `site/hfstatic/tests/test_static.js` (remember on/off, auto-unlock, stale passphrase cleared, Lock forgets, write token never stored, idle with remembered passphrase, storage blocked) and `test_build.py` (storage check).

## D36. Admin token: write permission outside the dataset now WARNS instead of refusing (relaxes D34 item 9)
- **Date:** 2026-11-18
- **Status:** Accepted (mock-tested only; not yet tried with the user's real token)
- **Decision:** (1) A fine-grained token that can write to the dataset and ALSO has write-type permissions on other scopes (user, org, model, ...) or global permissions is no longer refused. The admin box shows a warning naming each scope as `type/name: permission, permission` (global ones as `account-wide/global: ...`) and the button becomes "Continue anyway". (2) Still refused: role `write`/`admin` (account-wide), role `read`, the read token, an unknown whoami shape, and a token with no write on the dataset. (3) The dataset scope is found case-insensitively (Hub names may differ in case). (4) The "cannot write to <dataset>" refusal lists the token's scopes (`type/name` only, no values) so it can be diagnosed. (5) The warning is tied to the token it was shown for; a different pasted token is warned afresh.
- **Why:** the user's fine-grained write token was refused with "can also write to something other than ..." and he could not tell why. He asked for a warning instead; he owns the risk.
- **Consequences:** a leaked write token can then also change those other scopes, not only the vault. Prefer a token limited to the dataset. Tests: mock tokens for extra write scope (warn + continue), case-different dataset name, account-wide still refused.

## D35. Static site deployed to the Static Space; browser test passed on the basics; admin mode still untested
- **Date:** 2026-11-18
- **Status:** Accepted (deployment done; admin mode, phone and Firefox still open)
- **Decision:** (1) The static page is deployed to the free Static Space `Soverellp/clip-vault-site` with `python3 with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfstatic/deploy_static.py --accept-weak-passphrase` (50 files). The user chose a short human passphrase and accepted the risk (D26). The passphrase was supplied by the user in chat and passed to that one command as an environment variable; it was NOT taken from the key dataset, and the key dataset has no passphrase entry. The user should add the passphrase to the Claude environment (or the key dataset) so future deploys do not need it in chat. The value is recorded nowhere in this repo. (2) A real-browser test (Playwright) against the live Space at a 390x844 phone-sized viewport: unlock with the password works, the gallery shows 18 clips / 517 MB, and there are no console errors. (3) Still UNTESTED: admin mode real commit and LFS upload, playing a clip, a real phone, Firefox. (4) The security review (Opus) is done; its fixes are in D34. (5) Next: the user tests on a phone; then move the code to the GitHub repo `soverellp/clip-vault` (D20) once the static site works from clipper.
- **Why:** the static design (D25) was the only free route that works on this account (D23); the deploy and the first browser test show that the page loads, unlocks and lists the clips.
- **Consequences:** the gate is still a short shared password in a PUBLIC config, so offline guessing is possible (accepted, D26). Future deploys need the passphrase again until it is stored (point 1). The admin mode's real Hub commit, LFS upload and conflict behaviour remain unproven. Tests: the Playwright run covered unlock and gallery only; it is not a full VERIFY.md pass.

## D34. Review fixes for the static site and the credential wrapper (Opus review findings applied)
- **Date:** 2026-11-18
- **Status:** Accepted
- **Decision:** (1) `with_vault_creds.py` runs only `python3 <allow-listed script>` after `--` (deploy_static, build_static, build_hfvault, vault_sync) or `--check`; shells, `-c/-e/-m` and everything else are refused with the list named, before credentials are read; `--from-dir` (fake test creds) is the only escape. (2) The `VAULTCREDS_WHOAMI_URL` override is removed (fixed https://huggingface.co URL). (3) The read token reading the whole dataset (trash, `_audit`, tombstones) is documented, not changed; no `users.json` may exist in the dataset. (4) `VAULT_PASSPHRASE` is always masked, any length. (5) Admin token input is `type=text` + `-webkit-text-security`, `autocomplete=one-time-code`. (6) `img-src data:` dropped from the CSP (unused); Static Spaces cannot set headers (documented). (7) `deploy_static.py` passes `delete_patterns` = the allow-list; docs say rotate the read token too, not only the password. (8) The old page `site/hfvault/app.js` validates poster/video paths with the same SAFE regex as `hubapi.js`. (9) Admin tokens with an unknown whoami format, or any write permission outside the dataset, are refused. (10) 15-minute idle lock in the static client; `vault_sync.py` refuses the account-wide `HF_Token` unless `--allow-account-token`; README doc drift fixed (no weak-password note in the public README).
- **Why:** one HIGH (a wrapper that ran any command with the real keys), two MEDIUM and several LOW findings from the review ordered in D32.
- **Consequences:** `site/hfspace/deploy_space.py` (saved server mode) is NOT on the allow-list and is refused by the wrapper until someone adds it deliberately when server mode is deployed. The read-token scope and old-config problems stay accepted risks (SECURITY.md). Tests: see STATUS.md.

## D33. Kaggle keys are NOT rotated (accepted risk)
- **Date:** 2026-11-18
- **Status:** Accepted
- **Decision:** The user decided not to rotate the Kaggle API keys (account 1 `ARVR7Plays` and account 2). The old HF token was already left unrevoked (D19/D30 area, user's choice).
- **Why:** the user's call; rotation was only a recommendation in migration-setup/REVOKE-AND-SECURITY.md (account 2's key was displayed once in an old tool output).
- **Consequences:** anyone who saw those keys (old transcripts) can use the Kaggle accounts' GPU quota and read private Kaggle datasets, including `arvr7plays/kagglegpu1` (which holds the HF write token). Mitigation: keep the Kaggle datasets private; revisit if the old transcripts or the plain-text key dataset are ever shared. The README checklist item is marked 'declined by the user'.

## D32. Security review order: static site first, server mode later (Opus approved)
- **Date:** 2026-11-18
- **Status:** Accepted
- **Decision:** The user approved a complete security analysis and left the model choice to the lead. Order: (1) the STATIC site (`site/hfstatic`, the UI it reuses from `site/hfspace/static`, and the clip upload/credential tools in `site/hfvault`: `with_vault_creds.py`, `build_hfvault.py`, `vault_sync.py`) is reviewed FIRST, by one Opus reviewer (read-only, adversarial) because it handles an admin write token pasted into a browser, the password-gated read token and the accepted weak-password risk; findings are fixed by Sonnet agents and re-checked. (2) The SERVER MODE (`site/hfspace` backend: Google sign-in, roles, users, trash, step-up) is NOT reviewed now: its review is a gate that MUST happen before it is ever deployed (D27), written down here so it cannot be forgotten.
- **Why:** the static site is what will go live next; the server code is not deployed and a review of undeployed code can go stale. The earlier Opus review covered only the superseded Hugging Face login variant.
- **Consequences:** `SECURITY.md` and `STATUS.md` keep the label 'not security-reviewed' for server mode; after the static review they list its findings and fixes. D30's 'no Opus without approval' rule stays in force for all other work; this approval covers this one review only.

## D31. Optional later hosting ideas (not decided, not built)
- **Date:** 2026-11-17
- **Decision:** record two ways to get a real backend later without a paid Space: (a) GitHub Actions as an admin backend, (b) Cloudflare Workers for full server mode. Nothing is built or chosen.
- **Options:** (a) a workflow in the GitHub repo `soverellp/clip-vault` that performs admin actions with the write token stored as a GitHub secret, so the write token never reaches a browser; (b) a free Cloudflare Worker port of `site/hfspace` (needs a Cloudflare account); (c) a paid HF Space (PRO plan, D23); (d) stay static.
- **Why:** the static admin mode (D25) puts a write token in the admin's browser memory; these ideas would remove that.
- **Consequences:** (a) adds 10-40 s latency per action and needs the `clip-vault` GitHub repo to be visible to Claude sessions (Claude GitHub App with "All repositories", then a NEW session, D20). (b) needs a port of the Python code to Worker JavaScript. Both UNTESTED. Process note: two builder agent ids were mixed up once during this work and corrected; no code or doc was lost.
- **Status:** Open (ideas).

## D30. Working rules for this phase: no Opus agents, security review deferred
- **Date:** 2026-11-17
- **Decision:** no Opus agents without the user's approval; the security review is DEFERRED until the user asks. Everything below is therefore marked NOT SECURITY-REVIEWED: the static client (`site/hfstatic`, gate, admin mode), the server mode v2 (Google sign-in, roles, users, trash, step-up, upload). Only the earlier HF-OAuth variant of `site/hfspace` was reviewed by Opus (0 blocker, 0 high, 5 medium, 12 low, all fixed; D10).
- **Options:** run an Opus review now; defer.
- **Why:** user's working rule for cost and scope.
- **Consequences:** [SECURITY.md](SECURITY.md) and [STATUS.md](STATUS.md) carry a "not security-reviewed" marker; a review is required before the vault holds anything sensitive beyond the user's accepted risk (D26).
- **Status:** Accepted.

## D29. Secrets policy: where each credential lives
- **Date:** 2026-11-17
- **Decision:** (1) Space secrets are WRITE-ONLY, so they are only for a server app's own runtime values (server mode). (2) Claude/deploy credentials stay in the Claude environment variables (the user cannot currently edit the Claude environment) or, until retired, in the Kaggle dataset `arvr7plays/kagglegpu1` read through `site/hfvault/with_vault_creds.py`. (3) The write token for a server-mode Space is entered by the user directly in the Space settings; Claude never sees it. (4) A password manager is the recommended master copy of every token.
- **Options:** keep all credentials in Space secrets; Claude environment only; Kaggle dataset only.
- **Why:** a write-only store cannot be a master copy; the user must stay the only person who handles the high-value write token.
- **Consequences:** refines D22 (which stays valid for server mode). In static mode (D25) there are no Space secrets at all: the config is public and holds only the encrypted read token. The admin write token is pasted per session and never stored.
- **Status:** Accepted.

## D28. Google configuration kept for later (public values only)
- **Date:** 2026-11-17
- **Decision:** keep the Google Cloud setup, created for server mode, as a recorded option in [GOOGLE-CONFIG.md](GOOGLE-CONFIG.md): project `clip-vault`, consent screen External in Testing mode, test user `soverellp@gmail.com`, one OAuth web client, one authorized JavaScript origin. Public values only; no client secret exists or is needed.
- **Options:** delete the Google project now; keep it.
- **Why:** server mode (D27) may be deployed later; recreating it costs about 10 minutes.
- **Consequences:** static mode does not use Google. Which other consent-screen fields the user entered is UNVERIFIED. GOOGLE-CONFIG.md also lists how to recreate or delete it (also in [../migration-setup/REVOKE-AND-SECURITY.md](../migration-setup/REVOKE-AND-SECURITY.md)).
- **Status:** Accepted (parked).

## D27. SERVER MODE KEPT AS A SAVED OPTION (not deployed)
- **Date:** 2026-11-17
- **Decision:** keep `site/hfspace` as built, but do not deploy it. It is a FastAPI backend with Google sign-in plus nonce; roles viewer/admin with `ADMIN_EMAILS` root admins and site-managed users in `_config/users.json` (as built the file is `users.json`, see [DATA-MODEL.md](DATA-MODEL.md)); `ALLOWED_EMAILS` extra viewers; trash with 30-day restore; delete forever with the typed title; upload with streaming and ffprobe metadata; audit line in the same commit; step-up re-authentication window 300 s; CSRF token; rate limits; a file proxy so the read token never reaches browsers; hash-locked dependencies. Tests: 239 pytest passed in `site/hfspace` plus 69 in `site/hfvault`. It has a modern UI in `site/hfspace/static` (library grid/list, search, command palette, details drawer, player with safe-zone overlay, post kit, admin screens, users screen, WebGL poster wall with fallbacks, local-timezone times).
- **Options:** delete it; keep it; deploy now on a paid Space.
- **Why:** it is the better product (per-person access, no shared password, token never in a browser), but it needs a host that runs a Python server: a paid HF Space (D23) or a free Cloudflare Worker port (D31).
- **Consequences:** NOT deployed, NOT security-reviewed (D30), never run against real Google, a real Space or real Docker. Its documented design lives in [ARCHITECTURE.md](ARCHITECTURE.md), [API-CONTRACT.md](API-CONTRACT.md) ("as built") and [DATA-MODEL.md](DATA-MODEL.md). Step-up is 300 s, not the 15 minutes first planned (D14 amended below).
- **Status:** Saved option.

## D26. The user chose a short human password for the gate and accepted the risk
- **Date:** 2026-11-17
- **Decision:** the gate password is a short human password the user chose and accepted the risk for. It is never written in any file or chat. The static build refuses weak passphrases unless the explicit flag `--accept-weak-passphrase` is passed (off by default); passing it records the acceptance.
- **Options:** a random 4+ word passphrase (recommended, D21); a short human password with the risk accepted.
- **Why:** user preference for something friends can remember; the user was told the config is public, so anyone can try passwords offline against it (PBKDF2 slows but does not stop this).
- **Consequences:** mitigations: a dedicated, revocable, read-only token (for now `Clip_vault_HFToken` is reused; make a dedicated one later), and the admin write token never in the page. If the password leaks or is cracked, the read token is exposed: rotate (new token plus new password, rebuild the config). Residual risk: accepted by the user.
- **Status:** Accepted risk.

## D25. STATIC MODE design (`site/hfstatic`, in progress)
- **Date:** 2026-11-17
- **Decision:** a pure static page on the Static Space `Soverellp/clip-vault-site`. Viewers unlock with a shared password that decrypts a read-only token in browser memory and then read the private dataset directly from the Hub. ADMIN MODE: the admin pastes a fine-grained write token (scoped to the dataset, kept in memory only, never in storage) to edit, upload, trash, restore, delete forever and empty trash through the Hub API from the browser. Delete forever and empty trash require typing the title and re-entering the password. Audit lines go in the same commit. No Google login and no per-person user list in this mode: access control is ONE shared password. Rotate = rebuild the config with a new token and password; planned later: an in-site "Change password" screen.
- **Options:** (a) static gate plus in-browser admin (chosen); (b) server mode on a paid Space (D27); (c) static viewer only, no admin.
- **Why:** it is free and needs no server (D23); the user wants to manage clips from the page.
- **Consequences:** anyone with the password can read the token from browser tools and pass it on (known limit of D4); the admin write token is typed into a browser, so a malicious extension or XSS on the page could steal it (mitigation: fine-grained, dataset-only, revocable). Real Hub commit, LFS and conflict behaviour from a browser is UNTESTED. NOT security-reviewed (D30). Supersedes D9, D11 and D5 as the current plan (they remain as the saved option, D27).
- **Status:** In progress.

## D24. Static Space created empty and public
- **Date:** 2026-11-17
- **Decision:** the free Static Space `Soverellp/clip-vault-site` was created EMPTY and PUBLIC through the API. Static creation is allowed with the write token.
- **Options:** create it by hand in the web UI; create it through the API.
- **Why:** the API route needed no click work and proved the token can create static Spaces.
- **Consequences:** the Space URL https://soverellp-clip-vault-site.hf.space exists but shows nothing until `site/hfstatic` is deployed. Any earlier statement that the Space is a Docker Space is outdated (D6 changed). The Space repo is public: only the built page and its public config may be uploaded.
- **Status:** Accepted.

## D23. Docker and Gradio Spaces need the PRO plan; static only, no server for now
- **Date:** 2026-11-17
- **Decision:** the user's screenshot of huggingface.co/new-space says "Gradio and Docker Spaces require a paid plan; Static Spaces stay free". This explains the HTTP 402 when creating a Docker Space from the API. The user chose STATIC ONLY, NO SERVER for now.
- **Options:** buy the HF PRO plan and deploy server mode; static only; another host (D31).
- **Why:** hosting must be free (requirement 2).
- **Consequences:** D6 (Docker Space) is superseded for hosting; D5 ("a server is needed") is accepted as a fact but not acted on: the gate is a shared password (D25, D26), a weaker control than per-person login. `deploy_space.py` (Docker) cannot create the Space on this account.
- **Status:** Accepted.

---

## D22. Runtime secrets live as Hugging Face Space secrets (SERVER MODE ONLY)
- **Date:** 2026-11-17
- **Decision:** the app's runtime secrets (`VAULT_READ_TOKEN`, `VAULT_WRITE_TOKEN`, `SESSION_SECRET`, `ADMIN_EMAILS`, optional `ALLOWED_EMAILS`, `VAULT_DATASET`) are Hugging Face SPACE SECRETS, edited in Space > Settings > Variables and secrets or set by `deploy_space.py`. Only public values (`GOOGLE_CLIENT_ID`) are Space variables.
- **Options:** Space variables (public on a public Space); secrets in the dataset; secrets in the repo (never).
- **Why:** variables of a public Space are visible to everyone; secrets are not.
- **Consequences:**
  - Space secrets are WRITE-ONLY (cannot be read back in the UI or API), so there is no master copy there. To rotate: create a new token and set it again. Losing one is harmless because tokens can be reissued.
  - Users and roles other than the `ADMIN_EMAILS` root admins live in the dataset file `_config/users.json`, not in secrets.
  - Credentials that Claude sessions and the deploy need (the HF write token `HF_Token` for deploy, Kaggle keys) are NOT Space secrets: they stay in Claude environment variables (preferred) or, until retired, in the Kaggle dataset `arvr7plays/kagglegpu1` read by `with_vault_creds.py` (D17).
  - Recommended extra: a password manager as the human master copy of every token.
  - The `Kagglegpu1.pdf` credential file is to be retired after the move; do NOT delete it while the wrapper still needs it.
  - UNVERIFIED: that Space secrets are never exposed to forks or duplicates of a public Space (HF docs say secrets are not copied; verify).
- **Status:** Accepted.

---

## D21. Passphrase chosen by the user was weak (a sentence)
- **Date:** 2026-11-17
- **Decision:** advise the user to use random words (4+ distinct, 20+ characters) for `VAULT_PASSPHRASE`.
- **Options:** accept the sentence; enforce a strict check; drop passphrases entirely.
- **Why:** the passphrase protects an encrypted token in a PUBLIC `config.json`, so anyone can guess offline; the build check only counted length and parts (security review M5).
- **Consequences:** moot while Google login was the plan (D11); RELEVANT AGAIN in static mode (D25), where the user chose a short human password anyway and accepted the risk (D26).
- **Status:** Accepted; the advice was not followed for the gate (D26).

## D20. Code location: stays in clipper for now, move to GitHub later
- **Date:** 2026-11-17
- **Decision:** the Space code stays in the clipper repo (`site/hfspace`) and this folder; both are to be moved to GitHub `soverellp/clip-vault` later. The Space is itself a git repo, so its code can be cloned and imported to GitHub.
- **Options:** build in `soverellp/clip-vault` now; keep in clipper.
- **Why:** Claude sessions currently cannot see `soverellp/clip-vault` (the Claude GitHub App needs "All repositories" at github.com/settings/installations, and a NEW session because repos are fixed at session start).
- **Consequences:** this folder must stay self-contained and link-relative. An optional GitHub Action deploy to the Space is NOT built and NOT tested.
- **Status:** Accepted; the move is Open.

## D19. Old Hugging Face token stays unrevoked (user's choice)
- **Date:** 2026-11-17
- **Decision:** `HF_Token_backup` (old account `Arvr7`, full write) is not revoked for now.
- **Options:** revoke and delete now (recommended in migration-setup/REVOKE-AND-SECURITY.md); keep as backup.
- **Why:** user's choice.
- **Consequences:** it is the most valuable secret in the system while it stays in the credential file; whether it is already revoked is UNVERIFIED. Risk recorded in [SECURITY.md](SECURITY.md).
- **Status:** Accepted risk; Open.

## D18. Separate write token for the Space (`VAULT_WRITE_TOKEN`)
- **Date:** 2026-11-17
- **Decision:** admin upload/edit/trash from the Space uses a separate fine-grained token scoped to the dataset only. It lives only as a Space secret, never in the page, never in the Claude environment for this purpose.
- **Options:** reuse `HF_Token` (the account write token); reuse the read token; use the personal write token.
- **Why:** least privilege; the Space then cannot touch anything but the dataset; it must differ from the read token and from `HF_Token`.
- **Consequences:** a Space compromise gives write access to the dataset (see [SECURITY.md](SECURITY.md)). Name and exact scope in code: UNVERIFIED until v2 lands.
- **Status:** Accepted; implementation in progress.

## D17. Credentials route: Kaggle dataset + masking wrapper
- **Date:** 2026-11-17
- **Decision:** credentials sit as `NAME=value` text in `Kagglegpu1.pdf` in the private Kaggle dataset `arvr7plays/kagglegpu1`. Agents read them ONLY through `site/hfvault/with_vault_creds.py`, which fetches in memory and masks secrets. The user explicitly allowed this route; CLAUDE.md rule 1 was amended for it.
- **Options:** environment variables only; paste in chat (rejected); the wrapper.
- **Why:** the user keeps keys in that dataset; the wrapper keeps values out of chat and logs.
- **Consequences:** masking is best-effort (security review C1, C4); the child can still read its own environment. The CLAUDE.md amendment: UNVERIFIED in the repo text (migration-setup/CLIP-VAULT.md said the exception "is not written in CLAUDE.md").
- **Status:** Accepted.

## D16. UI direction: modern premium look with a WebGL poster wall
- **Date:** 2026-11-17
- **Decision:** modern premium look; WebGL poster wall (three.js vendored, served by the Space); 3D-tilt cards; accent colours taken from posters; reduced-motion and low-power fallbacks; NO third-party scripts except Google Identity Services.
- **Options:** plain grid (v1); heavy 3D graph/galaxy ideas from the old site prompt.
- **Why:** user asked for a "modern crazy" UI.
- **Consequences:** vendored font and three.js files are in `site/hfspace/static/` (untracked/in progress); strict CSP must allow only Google's sign-in origins.
- **Status:** In progress.

## D15. All times shown in the viewer's local timezone
- **Date:** 2026-11-17
- **Decision:** the API emits UTC ISO strings ending in `Z`; the page formats them in the viewer's timezone.
- **Options:** server-side timezone; fixed IST.
- **Why:** friends may be elsewhere; one canonical stored format.
- **Consequences:** every stored timestamp must be UTC `Z`.
- **Status:** Accepted.

## D14. Step-up re-authentication for destructive and privilege actions (server mode)
- **Date:** 2026-11-17
- **Decision:** destructive and privilege actions (delete forever, empty trash, add/remove user, change role) require a Google sign-in that is at most 300 seconds old (AS BUILT; first planned as 15 minutes); otherwise the page asks the user to sign in again.
- **Options:** none; confirm dialog only; second factor.
- **Why:** limits damage from a stolen or left-open session.
- **Consequences:** needs a "sign in again" path and a session issue time (`iat`). Exact endpoint behaviour: verify against `app.py`.
- **Status:** Accepted; implementation in progress.

## D13. Delete = Trash first, delete forever needs the exact title
- **Date:** 2026-11-17
- **Decision:** delete moves a clip to `trash/` (restorable for 30 days). "Delete forever" needs the exact clip title typed, plus step-up (D14).
- **Options:** hard delete with a confirm; soft delete only.
- **Why:** user wanted delete from the UI with confirmation; protects against slips.
- **Consequences:** a purge of expired trash (30 days) is needed; who runs it (scheduled job vs on request): UNVERIFIED.
- **Status:** Accepted; implementation in progress.

## D12. Roles: admins and viewers, root admins from the environment
- **Date:** 2026-11-17
- **Decision:** admins (Gmail-based) see and control everything, including adding and removing users from the UI. `ADMIN_EMAILS` (environment) lists root admins, who cannot be removed from the UI. Other users are stored in `_config/users.json` (see [DATA-MODEL.md](DATA-MODEL.md)).
- **Options:** one fixed allow-list in an environment variable (v1/D11 start); a separate admin page.
- **Why:** user wanted "one allowed email first, then admin-managed users" and no redeploy to add a friend.
- **Consequences:** the user list is data in the dataset, so a dataset write token is needed (D18).
- **Status:** Accepted; implementation in progress.

## D11. Final login: Google, on the proxy design
- **Date:** 2026-11-17
- **Decision:** friends sign in with Google; the Space stays a proxy (D9). The user already had a Google OAuth client (a public client id exists; the consent screen is in Testing mode) and preferred Google SSO.
- **Options:** Hugging Face OAuth (D8/D9, built); Google ID token released to browser (D7, rejected by D9); Cloudflare Worker.
- **Why:** user preference and an existing client; no HF account needed for friends.
- **Consequences:** Testing mode = only listed test users can sign in and consent may expire (about 7 days) until the app is published to Production. The client id is public (not a secret). Identity key should be the immutable Google `sub`, not only the email (UNVERIFIED whether v2 does this).
- **Status:** Accepted for server mode (saved option D27); NOT the current plan (D23, D25). Supersedes D8 for login.

## D10. Independent security review and fixes
- **Date:** 2026-11-17
- **Decision:** an independent Opus review of `site/hfspace` and `site/hfvault` ran; result 0 blocker, 0 high, 5 medium, 12 low. All fixes were applied: hash-locked dependencies, immutable account id pinning (`name:sub`), `__Host-` cookies, POST logout, secrets instead of public variables, allow-list upload, a stronger masking wrapper.
- **Options:** ship unreviewed; review.
- **Why:** user said security is a huge concern.
- **Consequences:** the review covered the HF-OAuth working tree, not Google login; v2 needs a fresh review (see [STATUS.md](STATUS.md)). Fixes re-tested with mocks only.
- **Status:** Accepted for v1; v2 review Open.

## D9. The Space becomes a proxy
- **Date:** 2026-11-17
- **Decision:** the read token stays in the Space; browsers get a signed HttpOnly session cookie and fetch clips through `/api/files/...`.
- **Options:** token released to the browser (D7/A1); proxy.
- **Why:** a token in a browser can be exfiltrated by any friend, XSS or extension and is not revoked when a friend is removed.
- **Consequences:** clips stream through the Space (HF free-tier bandwidth; speed not verified). The guarantee holds only while the token is truly read-only and the Space has no RCE bug.
- **Status:** Accepted.

## D8. Switch from Google to Hugging Face OAuth (later reversed by D11)
- **Date:** 2026-11-17
- **Decision:** the user did not want Google Cloud billing concerns, so login moved to "Sign in with Hugging Face" (`hf_oauth: true`, Space-injected client).
- **Options:** keep Google; HF OAuth.
- **Why:** no Google Cloud setup, no billing worry; friends need a free HF account.
- **Consequences:** built as commit 4d6db2b. Superseded for login by D11 once the user said they already had a Google client.
- **Status:** Superseded by D11.

## D7. First Google login: ID-token verification, read token released to browser
- **Date:** 2026-11-17
- **Decision:** first Space version verified the Google ID token (signature, audience, expiry, `email_verified`) and returned the read token to the browser if the email was allowed.
- **Options:** HF OAuth; Google.
- **Why:** simplest server (no cookies).
- **Consequences:** review found the token handed to browsers is the main weakness; allow-list variable was public. Built as commits ec90af7/672472c.
- **Status:** Superseded by D9.

## D6. Host server and page on a free Hugging Face Space (Docker part SUPERSEDED by D23/D24)
- **Date:** 2026-11-17
- **Decision:** public Docker Space `Soverellp/clip-vault-site` (free CPU), URL https://soverellp-clip-vault-site.hf.space. It sleeps after about 48 hours without visits.
- **Options:** Cloudflare Worker with Google login (rejected for now: another account to manage); other free hosts.
- **Why:** same account as the dataset; free; Space is a git repo.
- **Consequences:** about 1 minute cold start; the Space repo is public, so only an allow-list of files is uploaded.
- **Status:** Accepted.

## D5. A server is needed for Google/GitHub login
- **Date:** 2026-11-17
- **Decision:** accept that per-friend login needs a small server; there is no server-free way to gate access.
- **Options:** static page + passphrase (D4); server.
- **Why:** a static page cannot keep a secret or enforce per-user access.
- **Consequences:** leads to D6.
- **Status:** Accepted.

## D4. Passphrase-locked read token page (built as site/hfvault)
- **Date:** 2026-11-17
- **Decision:** built a static page whose `config.json` holds the read token encrypted with a passphrase (PBKDF2-SHA256 600,000 rounds, AES-256-GCM); friends type the passphrase.
- **Options:** passphrase page; server login (D5).
- **Why:** needs no server.
- **Consequences:** weak human passphrases, offline guessing against the public `config.json`, token in the browser, no per-friend control. Code kept (commit 1f15f04) but not in use. Only `build_hfvault.py` (upload) and `with_vault_creds.py` are still used.
- **Status:** Superseded by D5/D6, then REVIVED in improved form as the static gate of D25 (after D23 ruled out a server). The `site/hfvault` page itself is still not used; `site/hfstatic` replaces it.

## D3. Reject an unencrypted public vault repo
- **Date:** 2026-11-17
- **Decision:** rejected a public GitHub repo with unencrypted clips (built as `site/vault`, commit 847625e).
- **Why:** public to everyone.
- **Status:** Rejected.

## D2. Reject encrypted files on public GitHub Pages
- **Date:** 2026-11-17
- **Decision:** rejected clips encrypted client-side on GitHub Pages (built as `site/share`, commit 4176e70).
- **Why:** the user wanted no encryption of the clips and a common account.
- **Status:** Rejected.

## D1. Private Hugging Face dataset for clips, not GitHub
- **Date:** 2026-11-17
- **Decision:** clips live in the private dataset `Soverellp/clip-vault`.
- **Options:** GitHub Pages (1 GB site limit); a private GitHub repo (a token that reads it reads everything else in `clipper`: AI reference images, chat history, account names).
- **Why:** size (18 clips = 517 MB, growing), isolation of a single-dataset token.
- **Consequences:** 18 clips uploaded and verified; HF free storage limits: UNVERIFIED.
- **Status:** Accepted.

---
## Template for new entries
```
## D<n>. Title
- Date: YYYY-MM-DD
- Decision / Options / Why / Consequences / Status
```
