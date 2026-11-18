# RUNBOOK

> **TL;DR** Do-this-now steps. CURRENT plan = static mode (sections 1-8); server mode steps are in the SAVED OPTION part at the end. Commands run from the clipper repo root (paths in [ARCHITECTURE.md](ARCHITECTURE.md) "Code locations"). Never paste a token value or the gate password. `site/hfstatic` is IN PROGRESS: steps that depend on it are marked and will name exact commands once its README exists.

Secrets policy (D29): Claude/deploy credentials stay in Claude environment variables (preferred) or, until retired, `arvr7plays/kagglegpu1` via the wrapper. Static mode has no Space secrets. Keep a password-manager master copy of every token and the gate password.

## 1. Upload clips (about 10 min; same in both modes)
1. Prereqs: `kaggle` CLI in `~/kvenv` (with `six`, `python-slugify`), `pdftotext` (`apt-get install -y poppler-utils`), `pip install huggingface_hub cryptography`.
2. `python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfvault/build_hfvault.py <scratch>/vault Soverellp/clip-vault --upload` (`--stream <date>` filters).
3. Verify names/sizes only: list `clips/` in the dataset; expect one `.mp4` and one `.jpg` per clip.
4. Timeout: retry up to 4 times (uploaded files are skipped), then by stream, then STOP and tell the user; never lower quality.

## 2. Deploy the static page (about 10 minutes) [needs `site/hfstatic`, IN PROGRESS]
1. Prepare (the user): the gate password (short human password the user chose and accepted the risk for; never typed into chat) and a read token. For now the existing read token (line `Clip_vault_HFToken` in the credential file, variable `VAULT_READ_TOKEN`) is reused; a dedicated revocable read-only token for this dataset only is better (D26).
2. Build the public config and page with the builder in `site/hfstatic` (command and flags: see its README when present). A short human password needs the explicit flag `--accept-weak-passphrase`, which is off by default and records the acceptance.
3. Upload the built files to the Static Space `Soverellp/clip-vault-site` (already created empty and public, D24) with the HF write token (`HF_Token`, via the wrapper). Upload ONLY the page and its public config; the Space repo is public.
4. Test per [../migration-setup/VERIFY.md](../migration-setup/VERIFY.md) (clip vault checklist): Space URL opens, wrong password rejected, right one shows the grid, clip plays and downloads, times local, nothing in browser storage, admin paste works, delete asks the typed title.

## 3. Admin mode (about 5 minutes per session)
1. Create a fine-grained write token on Hugging Face: Settings > Access Tokens > Fine-grained, repositories permission ONLY `datasets/Soverellp/clip-vault` with write; nothing else. Name it for admin use.
2. Open the page, unlock with the password, open Admin, paste the write token. It stays in memory only; closing the tab drops it. A token that is too broad is refused by the page (see TROUBLESHOOTING).
3. Delete forever and Empty trash: type the exact title and re-enter the password.
4. After the session revoke the token if you do not want it to linger (a fresh one is 2 minutes).

## 4. Who gets in; rotate the password or tokens (about 10 minutes)
- There is no per-person list: everyone with the password has the read token. To drop one friend, rotate for everyone.
- Rotate: 1) create a new read token (read, this dataset only); 2) choose a new password; 3) rebuild the config and redeploy the Static Space (section 2); 4) test the gate; 5) revoke the old read token; 6) tell friends the new password in a separate channel; 7) update the password manager. Planned later: an in-site "Change password" screen (not built).
- Rotate the admin write token: revoke it on Hugging Face and make a new one (section 3); nothing else holds it.

## 5. Restore from Trash
Admin mode > Trash > Restore (within 30 days, once the static UI implements it; the layout is `trash/clips/` as in server mode, UNVERIFIED for static). If the page is down, restore by moving files back from `trash/clips/` in the dataset with a write token.

## 6. The Static Space is down or empty
Check https://huggingface.co/spaces/Soverellp/clip-vault-site > Files and Logs. A static Space has no container to sleep; if the page is blank the files were not uploaded or the build config is wrong. Re-upload (section 2).

## 7. Disaster recovery
| Loss | Recovery |
|---|---|
| Space deleted | recreate a Static Space (free, allowed with the write token) and re-upload the built page; the dataset is untouched |
| Dataset deleted | re-upload from the clipper repo with section 1 (clips reach `main` via `finalise.py`); `users.json` and `_audit/` (admin/server data) would need recreating (no backup: open item) |
| Gate password forgotten | rebuild with a new password and redeploy (section 4); the dataset is untouched |
| Read token leaked | rotate (section 4), revoke the old one |
| Write token leaked | revoke it on Hugging Face at once; review `_audit/` and the dataset commit history |
| Credential PDF lost | recreate tokens; the PDF is to be retired anyway after the move |

---
# SAVED OPTION: server mode (needs a paid HF Space or another Python host, D23/D27)
Not deployed. Everything below is as written for the server design and was never run against real Google or a real Space.

## S2. Deploy the Space (about 5 min + 3 min build)
0. On this account a Docker Space cannot be created without the PRO plan (HTTP 402, D23).
1. Google client (already made, see [GOOGLE-CONFIG.md](GOOGLE-CONFIG.md); steps to recreate): console.cloud.google.com > OAuth consent screen > Credentials > Web client > authorized JavaScript origin `https://soverellp-clip-vault-site.hf.space`. Client id is public.
2. Environment names to set (values never in chat): `HF_Token`, `VAULT_READ_TOKEN`, `VAULT_WRITE_TOKEN`, `ADMIN_EMAILS`, `GOOGLE_CLIENT_ID`, optional `ALLOWED_EMAILS`, `SESSION_SECRET`. Start a NEW session after changing the environment.
3. `python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfspace/deploy_space.py` (sets `VAULT_READ_TOKEN`, `VAULT_WRITE_TOKEN` if exported, `SESSION_SECRET`, `VAULT_DATASET`, `ALLOWED_EMAILS`, `ADMIN_EMAILS` and the variable `GOOGLE_CLIENT_ID`; per `site/hfspace/SETUP.md`).
4. Permission error: create the Space by hand (Docker, Blank, public, `clip-vault-site`), give the token write access, rerun.
5. Test: URL opens; listed account signs in; unlisted refused; clip plays and downloads; no token in browser storage; after first request read the log line `proxy-shape: ...` and adjust `_ip()` if needed.

## S3. Add or remove friends and admins
- Admin: open Users in the page, add the Gmail address (step-up: sign in again if the session is older than 5 minutes (300 s)). Root admins (`ADMIN_EMAILS`) cannot be removed in the UI: edit the Space secret.
- Google Testing mode: also add the person under Test users in the Google console (until published to Production).
- To pin a person to the immutable Google id: add the plain email, let them sign in once, open `/api/me`, copy `sub`, then use the entry `email:sub`.

## S4. Rotate tokens (about 10 min)
1. Create a new token on Hugging Face (read: one dataset, read-only; write: one dataset).
2. Set it again as the Space secret (Space > Settings > Variables and secrets, or rerun the deploy). It cannot be read back, so this is also how you "change" it.
3. Check sign-in and one clip.
4. Revoke the old token. Update the password manager (and the Kaggle credential line if still used).
5. Drop all sessions: set `SESSIONS_NOT_BEFORE` to `date +%s` .

## S5. Restore from Trash
Admin > Trash > Restore (within 30 days). After 30 days the item may be purged (lazy purge: next admin list, startup, or Empty trash). If the UI is down, restore by moving files back from `trash/` in the dataset with the write token.

## S6. The Docker Space is asleep
Free Spaces sleep after about 48 h. Open the direct URL and wait about 1 minute. Do not use the huggingface.co iframe (blocked by `frame-ancestors 'none'`). If it stays down: Space > Logs; then Space > Settings > Factory reboot.

## S7. Disaster recovery
| Loss | Recovery |
|---|---|
| Space deleted | rerun the deploy (code is in git); secrets must be re-entered (no read-back); dataset untouched |
| Dataset deleted | re-upload from the clipper repo with section 1 (clips reach `main` via `finalise.py`); `_config/users.json` and `_audit/` would need recreating (no backup exists: open item) |
| Token lost | harmless: issue a new one and set it again (D22) |
| Token leaked | rotate (section 4), revoke the old one, set `SESSIONS_NOT_BEFORE` |
| Google client removed | create a new one, update `GOOGLE_CLIENT_ID` variable |
| Credential PDF lost | recreate tokens; the PDF is to be retired anyway after the move |
