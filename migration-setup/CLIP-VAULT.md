# CLIP-VAULT: how friends view and download the clips

Back to [README.md](README.md). Added 2026-11-17, redesigned twice the same day (Google server design, then the static design below). Goal: friends open one link, unlock it, then watch and download the final clips. Clips are never public. The full decision log, flow, security notes and status live in [../clip-vault-project/README.md](../clip-vault-project/README.md); this file is the runbook for a NEW Claude session.

## Status 2026-11-18 (D41, source on GitHub)
- The vault source (`site/hfstatic`, `site/hfspace`, `site/hfvault`, `clip-vault-project/`, this file) is mirrored to `soverellp/clip-vault` main by `bash .claude/scripts/sync_vault_repo.sh` (also run by every autosave; `--dry-run` shows the scan only). Fast-forward only, never force, secret scan first (fails closed), nothing under `streams/`. Edit in clipper, never in clip-vault.

## Status 2026-11-18 (D39, Library metadata)
- The index carries the Library data: top-level `streams[]` and per-clip `stream, group, variant, reaction, reaction_note, kind, tier, rank, why, hook` (contract: `clip-vault-project/API-CONTRACT.md` section 0). Every stream needs `streams/<s>/docs/vault_meta.json` and `streams/<s>/thumb.jpg` before `vault_sync` (SKILL.md step 10; check with `python3 .claude/skills/clips/scripts/vault_meta.py check`). New clips get the fields at upload; for clips already in the vault, and for `streams[]` and thumbnails: `python3 site/hfvault/vault_sync.py --meta-only` (dry run), then `... --meta-only --allow-account-token --yes` detached with a log ending in `EXIT`. It changes only the contract fields (admin-edited `hook`/`stream` are kept), never title, desc, tags, trash state or files. Check the result with `python3 site/hfvault/check_index.py` (read token, counts only). Warning for the UI: a client that rewrites `index.json` must keep unknown fields and `streams`.

## Status 2026-11-18 (D38, uploads)
- Clip uploads may use the account-wide token: `python3 site/hfvault/vault_sync.py --allow-account-token` (dry run first, then `--yes`, detached with a log). The user chose this for ALL future uploads because no dataset-scoped `VAULT_WRITE_TOKEN` exists yet. Accepted risk: the account token can write to every repo of the account; it is never printed, put in the environment, on the command line or in a file.
- Recommended later: create a dataset-scoped `VAULT_WRITE_TOKEN` (write on `Soverellp/clip-vault` only); then the flag is not needed.
- Uploaded so far: 28 Kai Cenat clips (14 x `with-girl` and `clean`, about 400 MB) in 10 commits; live site 46 clips / 917 MB, no console errors. NOT proven: phone playback of the new clips; the audio has not been listened to.

## Update 2026-11-20: shortlist (D43)
- Star on every card and in the clip detail (D44: anyone who unlocked the site toggles it, no admin mode), chip "Shortlisted N", button "Copy shortlist". Per moment. File `_config/shortlist.json` in the dataset, never touched by sync or build scripts. Code: `site/hfspace/static/js/shortlist.js` (pure), `kit.js`, `library.js`, `drawer.js`, `site/hfstatic/src/hubapi.js`; tests: `site/hfstatic/tests/test_shortlist_logic.mjs`, `test_shortlist.js`, `test_vault_sync.py`.

## Update 2026-11-20: third version "Face on top" (`variant: face-top`)
- The Library card has a version pill with up to three buttons: With streamer, Clean, Face on top (the third shows only on moments that have it). Code: `site/hfspace/static/js/moments.js` (VARIANTS), `library.js`, `css/moments.css` (`.vpill.v3`), `site/hfstatic/src/hubapi.js` (ENUMS), `site/hfvault/build_hfvault.py` (VARIANTS); test: `node site/hfspace/tests/test_moments_variants.mjs`.
- Clips: `facetop.mp4` of the `<start>-<end>s_facetop-<slug>` folders (clips skill, SKILL.md 7e); vault_meta entries use `variant: face-top` with the same `group` as the other two.
- Site update WITHOUT the passphrase (a full rebuild re-encrypts config.json and needs the real passphrase; it is not in the key dataset): patch deploy of only the changed files, config.json untouched: `python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfstatic/deploy_static.py --only js/moments.js js/library.js js/hubapi.js css/moments.css` (copy the changed `hfspace/static` files into `hfstatic/dist/` first, hubapi.js from `hfstatic/src/`).

## Status 2026-11-18 (D35)
- **DEPLOYED:** the static page is live at https://soverellp-clip-vault-site.hf.space (Static Space `Soverellp/clip-vault-site`, 50 files), deployed with `python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfstatic/deploy_static.py --accept-weak-passphrase`. The user chose a short passphrase and accepted the risk (D26). The passphrase was given in chat for that one command only; it is not in the key dataset. The user should add it to the Claude environment for future deploys (value never written in any file).
- **PROVEN in a real browser (Playwright, live Space, 390x844):** unlock with the password works; the gallery shows 18 clips / 517 MB; no console errors.
- **UNTESTED:** admin mode (real commit and LFS upload), playing a clip, a real phone, Firefox.
- **Next:** the user tests on a phone; then move to GitHub repo `soverellp/clip-vault` (D20) once the static site works from clipper.

## Design: CURRENT plan = STATIC mode (decided 2026-11-17; D23-D26 in the project folder)
- **Why static:** Hugging Face Docker and Gradio Spaces need the PRO plan on this account ("Gradio and Docker Spaces require a paid plan; Static Spaces stay free"; creating a Docker Space from the API gave HTTP 402). The user chose STATIC ONLY, NO SERVER for now.
- **Storage:** a PRIVATE Hugging Face dataset `Soverellp/clip-vault` (18 clips, 517 MB, uploaded and verified). Clips are 20-43 MB each.
- **Site:** the free Static Space `Soverellp/clip-vault-site` (created empty and public through the API), URL https://soverellp-clip-vault-site.hf.space. Pure static page, no server, no Google.
- **Gate:** friends type a SHARED PASSWORD. It decrypts a read-only dataset token (PBKDF2 + AES-GCM, from a PUBLIC config on the Space) in browser memory; the page then reads the private dataset directly from the Hub. Nothing is stored in the browser. The user chose a short human password and accepted the risk that it can be brute-forced offline from the public config; the build refuses weak passwords unless the explicit flag `--accept-weak-passphrase` is passed (off by default). The password is never written in any file or chat.
- **Admin mode:** the admin pastes a fine-grained WRITE token (scoped to the dataset, kept in memory only) to edit details, upload, trash, restore, delete forever and empty trash through the Hub API from the browser. Delete forever and empty trash require typing the title and re-entering the password. Audit lines go in the same commit.
- **No per-person control:** no Google login and no user list in this mode; one shared password is the access control. Rotate = rebuild the config with a new read token and password (an in-site "Change password" screen is planned later).
- **Code:** `site/hfstatic/` (IN PROGRESS; when `site/hfstatic/README.md` exists, follow it). `site/hfvault/` is still used to UPLOAD clips (`build_hfvault.py --upload`) and to inject credentials (`with_vault_creds.py`). Not used: the old passphrase page in `site/hfvault/` (index.html, app.js, style.css), `site/vault/`, `site/share/`.
- **SAVED OPTION (D27): server mode** in `site/hfspace/`: FastAPI with Google sign-in, viewer/admin roles, site-managed users, trash, typed-title delete, streaming upload, audit, CSRF, step-up (300 s), a file proxy so the read token never reaches browsers, hash-locked dependencies, and a modern UI. Built and mock-tested (239 pytest in `site/hfspace`, 69 in `site/hfvault`), NOT deployed: it needs a paid HF Space or another Python host (a free Cloudflare Worker port is an idea). Google config kept for it: [../clip-vault-project/GOOGLE-CONFIG.md](../clip-vault-project/GOOGLE-CONFIG.md).
- **Why not a token for the private clipper repo:** a token that reads the clips also reads everything else in `clipper` (AI reference images, chat history, account names).
- **NOT security-reviewed:** the static client and the server mode v2. Only the earlier HF-OAuth variant was reviewed (0 blocker, 0 high, 5 medium, 12 low, all fixed).

## Names that matter (NAMES only; values never in chat, files or commits)
| Name | Rights / kind | Used by | Lives in |
|---|---|---|---|
| `HF_Token` | WRITE, fine-grained, the clip-vault dataset (may lack rights to create a Docker Space; static creation worked) | `build_hfvault.py --upload`, static deploy | Claude environment variable, or injected by `with_vault_creds.py`. The user keeps a copy in `Kagglegpu1.pdf` (dataset `arvr7plays/kagglegpu1`) as the line `HF_Tokem` (typo, kept) |
| `VAULT_READ_TOKEN` (line name in the PDF: `Clip_vault_HFToken`) | READ only, the clip-vault dataset only (confirmed read-only via whoami) | encrypted into the public config by the static build | Claude environment variable, or injected by `with_vault_creds.py`. Reused for now; a dedicated revocable read token is planned |
| gate password | a short human password the user chose and accepted the risk for | static build and the page | the user's head and password manager; NEVER in a file or chat |
| admin write token | fine-grained, ONE dataset, write | pasted into the page in admin mode | memory only; the user makes it on Hugging Face; Claude never needs it |
| `VAULT_PASSPHRASE` | the wrapper's own check; whether the static build reads the gate password from it: UNVERIFIED | `with_vault_creds.py` | a throw-away value satisfies the wrapper |
| old HF token backup | OLD account, full write | nothing | the line `HF_Token_backup` in `Kagglegpu1.pdf`: REVOKE and DELETE it (REVOKE-AND-SECURITY.md step 3) |
| SERVER MODE ONLY: `VAULT_WRITE_TOKEN`, `SESSION_SECRET`, `ADMIN_EMAILS`, `ALLOWED_EMAILS`, `VAULT_DATASET`, `GOOGLE_CLIENT_ID` | Space secrets (write-only) and one public Space variable | `site/hfspace/deploy_space.py` | not needed for static mode; the user enters the write token directly in the Space settings (D29) |

Rules: the write token never goes in the page source, the config or the repo; Space secrets are write-only (server mode only); Claude/deploy credentials stay in the Claude environment (the user cannot currently edit it) or, until retired, the Kaggle dataset read through the wrapper. A password manager is the recommended master copy. Agents never read the key datasets (CLAUDE.md rule 1); credentials reach a session as environment variables (loaded at session start: add them, then start a NEW session) or through `site/hfvault/with_vault_creds.py`.

## Runbook (a new Claude session can do most of it; about 40 minutes in total)
1. **Upload clips (about 10 minutes, Claude does it).** Prerequisites: credentials (variables, or `with_vault_creds.py`); `python3 -m pip install huggingface_hub cryptography`. Run:
   `python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfvault/build_hfvault.py <scratchpad>/vault Soverellp/clip-vault --upload`
   Only `<scratchpad>/vault/data` matters (it goes to the private dataset); ignore `<scratchpad>/vault/page`. Verify names and sizes only: `python3 -c "import os;from huggingface_hub import HfApi;[print(f.path,f.size) for f in HfApi(token=os.environ['HF_Token']).list_repo_tree('Soverellp/clip-vault',repo_type='dataset',path_in_repo='clips')]"`. Expect one `.mp4` and one `.jpg` per clip. DONE for the first 18 clips.
   Later clips: re-run the same command; `index.json` is merged with the dataset's (matched by clip id). `--stream <date>` filters a batch. Upload times out: retry up to 4 times (uploaded files are skipped), then upload by stream, then STOP and tell the user (rule 4); never lower quality.
2. **Choose the gate password (2 minutes, the USER).** A short human password is accepted by the user (D26); the build needs `--accept-weak-passphrase`. Do not type it in chat: it goes into the build only through the environment or a prompt as the `site/hfstatic` README says.
3. **Build and deploy the static page (about 10 minutes) [DONE 2026-11-18, D35; redeploy with the command in the Status section above].** The build encrypts the read token with the password into a public config; upload ONLY the page and that config to the Static Space `Soverellp/clip-vault-site` (already exists, empty, public).
4. **Test (about 10 minutes, with the user):** the VERIFY.md vault checklist: Space URL opens, a wrong password is rejected, the right one shows the grid, a clip plays and downloads, times are local, admin mode accepts a pasted write token, delete asks for the typed title, nothing is in browser storage.
5. **Admin write token (about 3 minutes, the USER):** huggingface.co > Settings > Access Tokens > Fine-grained > repository permission ONLY `datasets/Soverellp/clip-vault` with write; paste it into the page's Admin screen each session.
6. **Change who has access:** there is no per-person list. To cut someone off: new read token, new password, rebuild and redeploy, revoke the old token (REVOKE-AND-SECURITY.md).

Tests that exist: server mode `python3 -m pytest -q -p no:cacheprovider` in `site/hfspace/tests` and in `site/hfvault/tests`; the UI launcher is described in `site/hfspace/tests/README.md`. Static-mode tests: see the `site/hfstatic` README when it exists.

## Credentials without looking at them: `site/hfvault/with_vault_creds.py`
**Where the credentials are (verified 2026-11-17, names only).** Kaggle dataset `arvr7plays/kagglegpu1` (https://www.kaggle.com/datasets/arvr7plays/kagglegpu1/, private, account `ARVR7Plays`). It holds ONE file, `Kagglegpu1.pdf` (33 KB), whose text has 5 `NAME=value` lines:

| Key in the file | Meaning | Script maps it to |
|---|---|---|
| `HF_Tokem` (typo of HF_Token, kept) | NEW Hugging Face account (`Soverellp`) WRITE token | `HF_Token` |
| `HF_Token_backup` | OLD Hugging Face token (account `Arvr7`), backup only | never used; revoke and delete (REVOKE-AND-SECURITY.md) |
| `Clip_vault_HFToken` | READ-only token for the clip-vault dataset (valid, user `Soverellp`) | `VAULT_READ_TOKEN` |
| `KAGGLE_APITOKEN`, `KAGGLE_USERNAME` (`ARVR7Plays`) | Kaggle account 1 | not used by the script (the environment already has them) |

There is NO passphrase line in the file. `VAULT_PASSPHRASE` is only the wrapper's own check (it was for the older passphrase page); whether the static build reads the gate password from it: UNVERIFIED until `site/hfstatic` lands. A throw-away value (`VAULT_PASSPHRASE='x' python3 ...`) satisfies the wrapper. Never put a real one in the file, the repo or chat.

**What the script does.** `site/hfvault/with_vault_creds.py` (STILL USED) downloads that dataset with the Kaggle CLI into a private temp folder, extracts the PDF text IN MEMORY (`pdftotext`, the same way `kaggle.py` reads `kagglegpu2.pdf`), deletes the folder, and runs your command with `HF_Token`, `VAULT_READ_TOKEN` and `VAULT_PASSPHRASE` in the CHILD environment only. It prints only counts and recognisable key names, masks every secret value in the child's output, and refuses when the read and write tokens are equal or not `hf_` tokens. Odd-looking keys are never echoed (in PDF text they can be fragments of a secret).
- Machine setup it needs (each is a gotcha seen on 2026-11-17): the `kaggle` CLI in `~/kvenv` (`python3 -m venv ~/kvenv && ~/kvenv/bin/pip install kaggle six python-slugify`; the CLI fails to start without `six`), `pdftotext` (`apt-get install -y poppler-utils`), `pip install huggingface_hub cryptography`. The script maps `KAGGLE_APITOKEN` to `KAGGLE_API_TOKEN`, the name the official CLI reads.
- Kaggle dataset slugs are lower case: use `arvr7plays/kagglegpu1` (the default `$KAGGLE_USERNAME/kagglegpu1` also works if Kaggle accepts the mixed case; pass `--dataset` to be safe). The session's Kaggle login must be the account that owns the dataset (`ARVR7Plays`); a 403 means a different login or a wrong path.
- List files only (no content): `python3 site/hfvault/with_vault_creds.py --list --dataset arvr7plays/kagglegpu1`
- Check keys and tokens (names, validity, HF user name only): `python3 site/hfvault/with_vault_creds.py --check --dataset arvr7plays/kagglegpu1` (add `VAULT_PASSPHRASE=...` in front, or it reports the passphrase MISSING).
- Upload or any other command: `python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfvault/build_hfvault.py <scratchpad>/vault Soverellp/clip-vault --upload`
- The wrapper runs ONLY `python3 SCRIPT` for `site/hfstatic/deploy_static.py`, `site/hfstatic/build_static.py`, `site/hfvault/build_hfvault.py`, `site/hfvault/vault_sync.py`, plus `--check` (D34); anything else is refused. `vault_sync.py` needs `--allow-account-token` to use the account-wide `HF_Token`. To lock someone out, rotate the password AND the read token (an old public `config.json` stays decryptable with the old password). The read token can read the whole dataset (trash, `_audit`); never put `users.json` there. The static page locks itself after 15 minutes idle.
- Deploy the SERVER-mode Space (saved option, needs a paid Space; `deploy_space.py` is NOT on the wrapper allow-list, add it to `ALLOWED_SCRIPTS` deliberately first): `python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfspace/deploy_space.py` (needs `GOOGLE_CLIENT_ID` and `ADMIN_EMAILS` in the environment). The static deploy command will be in the `site/hfstatic` README when it exists.
- Rules: agent sessions only RUN this script; they never open the dataset or the PDF by hand. CLAUDE.md rule 1 says agents never read key files or key datasets, and Kaggle only through `scripts/download/kaggle.py`; running this script is the exception the user approved on 2026-11-17 (it is now written in CLAUDE.md rule 1).

## Status of the vault data and the site (2026-11-17)
- UPLOADED and verified: 18 clips (517 MB) in the private dataset `Soverellp/clip-vault` (https://huggingface.co/datasets/Soverellp/clip-vault). The read token gets `index.json` (200, 18 clips) and a clip's `content-length` equals the local size (30,861,167 bytes); an anonymous request gets 401; the read token cannot write (403) and was confirmed read-only via whoami.
- The Static Space `Soverellp/clip-vault-site` is public and DEPLOYED (2026-11-18, D35); the browser unlock and gallery test passed. Admin mode is untested.
- Server mode code is written and mock-tested but not deployed and needs a paid Space.

### PROVEN
- Real dataset, earlier (origin https://soverellp.github.io): CORS preflight allows `authorization`, the CDN answers a ranged GET with 206 and `access-control-allow-origin: *`; read-only rights confirmed.
- Server mode with fakes: 239 pytest passed in `site/hfspace`, 69 in `site/hfvault` (fake Google, fake store, fake `huggingface_hub`).

### UNTESTED (do these first after deploying the static page)
1. Real Hub commit, LFS upload and conflict behaviour from a browser (admin mode).
2. A real Static Space load; CORS from the Space origin (proven only from the GitHub Pages origin).
3. A phone; H.264 playback in a real browser (tests used VP9).
4. Real Google sign-in (server mode only) and real Docker (not used).

### Risks (accepted or open, recorded)
- The gate password is a short human password in a PUBLIC config: offline guessing is possible (accepted by the user, D26). Mitigations: a revocable read-only one-dataset token; the write token is never in the page.
- Everyone with the password has the read token and can share it. Removing one friend means rotating for everyone.
- The admin write token is pasted into a browser: a malicious extension or XSS could take it. It is fine-grained, dataset-only and held in memory only.
- NOT security-reviewed: the static client and the server mode v2.
- Removing access cannot take back clips already downloaded.

## Security measures (design, static mode; not yet verified in deployed code)
- Shortlist token (D44): `config.json` also holds a WRITE token, encrypted with the same passphrase (field `sl`). It is `HF_Tokem`: fine-grained but with `repo.write` on the whole `Soverellp` namespace, so it is effectively account-wide write. It CAN: commit anything to the clip dataset and the owner's other repos/spaces. The page only ever uses it for the shortlist file and its audit line. It CANNOT be narrowed without a new token: for a safe setup create a fine-grained token with write on ONLY a small dataset `Soverellp/clip-vault-shortlist`, build with `--shortlist-dataset Soverellp/clip-vault-shortlist --shortlist-path shortlist.json` (the old file is then a read-only fallback). Anyone who has the passphrase can recover the token from the public config.json; keep the passphrase to friends you trust. Rebuild the config without `VAULT_SHORTLIST_TOKEN` to turn friends' writes off.
- Fine-grained read-only token, one dataset; PBKDF2-SHA256 + AES-GCM config; token only in memory (no localStorage, cookies or IndexedDB); strict CSP; no analytics; admin write token never in a file, env var or the page source; delete forever and empty trash need the typed title and the password again; audit line in the same commit.
- Server mode measures (CSRF, step-up 300 s, rate limits, token proxy, hash-locked dependencies): see [../clip-vault-project/SECURITY.md](../clip-vault-project/SECURITY.md).

## Unlock options (how friends get in)
1. **CURRENT: static Space + shared password gate + in-browser admin mode** (free; one password for everyone; D25).
2. **SAVED OPTION: server mode, Space or Worker + Google sign-in + roles** (per-person control; needs a paid HF Space, D23, or a Cloudflare Worker port, D31). Built, not deployed.
3. Older, NOT in use: the `site/hfvault/` passphrase page on GitHub Pages (replaced by `site/hfstatic`).
4. Not built: Sign in with Hugging Face on a static Space (friends need HF accounts); GitHub Actions as an admin backend (D31).

## Later
- Optional, NOT built: keep the code in the GitHub repo `soverellp/clip-vault` and deploy with a GitHub Action (Claude sessions cannot see `clip-vault` yet: the Claude GitHub App needs "All repositories" at https://github.com/settings/installations, and a NEW session). A GitHub Action as the admin backend would keep the write token out of browsers (10-40 s latency).
- In-site "Change password" screen; a dedicated read token for the gate.

## Files (checked with `ls` on 2026-11-17)
| File | What it is |
|---|---|
| `site/hfstatic/` | CURRENT plan: static page, gate, admin mode. IN PROGRESS (did not exist yet when this table was written) |
| `site/hfvault/build_hfvault.py` | STILL USED: builds `data/` (clips, posters, v2 `index.json`) and `--upload`s it to the private dataset |
| `site/hfvault/with_vault_creds.py` | STILL USED: runs a command with `HF_Token`, `VAULT_READ_TOKEN`, `VAULT_PASSPHRASE` injected from `arvr7plays/kagglegpu1`, masked |
| `site/hfvault/index.html`, `app.js`, `style.css` | the OLD passphrase page template; not in use |
| `site/hfspace/` | SAVED OPTION (server mode): `app.py`, `admin.py`, `auth.py`, `store.py`, `common.py`, `static/` (modern UI), `Dockerfile`, `requirements.txt`, `deploy_space.py`, `README.md`, `SETUP.md`, `tests/` |
| `site/vault/`, `site/share/` | older rejected alternatives; not in use |
| `docs/site/CLIP-VAULT-PAGE-PROMPT.md`, `SITE-PROMPT.md` | SUPERSEDED prompts |
| `../clip-vault-project/` | decisions, flow, architecture, API, data model, security, runbook, status, changelog, Google config |

## Known gaps
- Nothing of the static design is deployed yet; see UNTESTED above.
- The line name `Clip_vault_HFToken` in `Kagglegpu1.pdf` maps to `VAULT_READ_TOKEN`. The Hugging Face name of that token is not recorded here.
