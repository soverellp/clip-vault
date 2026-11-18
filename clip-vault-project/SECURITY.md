# SECURITY

> **TL;DR** Security is a huge concern for the user. **NOT SECURITY-REVIEWED (D30): the static client (`site/hfstatic`, gate, admin mode) and the server mode v2 (Google, roles, users, trash, step-up, upload).** Only the earlier HF-OAuth variant was reviewed (Opus, 0 blocker, 0 high, 5 medium, 12 low, all fixed). CURRENT plan = static mode: one shared password protects a read token in a PUBLIC config; the user chose a short human password and accepted the offline-guessing risk (D26). Never write a secret value anywhere; names only.

## Static mode (current plan, D25, in progress) NOT SECURITY-REVIEWED
| Asset | Threat | Mitigation | Residual |
|---|---|---|---|
| Read token | offline guessing of the gate password against the PUBLIC config | PBKDF2-SHA256 + AES-GCM; dedicated revocable read-only one-dataset token; `--accept-weak-passphrase` build flag (off by default) records the accepted weak password | a short human password can be brute-forced; accepted by the user (D26). Rotate = new token + new password + rebuild |
| Read token | a friend reads it in browser tools and shares it | cannot be prevented; it reads only this dataset | revoke and rotate |
| Read token scope (D34) | the token reads the WHOLE dataset, not just what the page lists: `trash/` clips, `_audit/*.jsonl` (admin action log with timestamps) and `_config/tombstones.json` are visible to EVERY password holder who calls the Hub directly | architecture unchanged on purpose; the page hides them, the Hub does not | accepted. NO `users.json` or any file with emails/personal data may ever exist in the dataset (server-mode users live only in the server store). Keep nothing private in this dataset |
| Old `config.json` | someone saved an older public `config.json` (git history of the Space keeps it) | none possible | rotating the password ALONE does not lock them out: they decrypt the old file with the old password and get the old read token. Rotate the READ TOKEN as well (new token, rebuild, redeploy, revoke the old one) |
| Idle browser | an unlocked tab left open | idle lock after 15 min without activity (D34): both tokens forgotten, same as Lock. With "Remember on this device" ticked (D37) the idle timer only drops the admin write token | a tab in active use stays open; a remembered device stays unlocked until Lock |
| Remembered passphrase (D37) | anyone with the unlocked device, its browser profile, or any XSS on the Space origin reads `localStorage['cv.pass']` and so can decrypt the read token | owner's choice; only the passphrase is stored (never the read or write token); one key only, build check bans all other storage; CSP `script-src 'self'`, no third-party scripts; Lock forgets; checkbox can be unticked; autocomplete=current-password lets a password manager do it instead | rotate the passphrase and read token if a device is lost or shared |
| Headers | a Static Space cannot set HTTP headers (no `frame-ancestors`, no `X-Frame-Options`) | CSP via `<meta>`, JS frame-buster, `img-src 'self' blob:` (no `data:`) | clickjacking is reduced, not removed |
| Write token | stolen from the admin's browser (XSS, extension, paste into the wrong page) | fine-grained, dataset only, memory only (never storage), pasted per session, never in the page or config | whoever gets it can change or delete the dataset (history in the dataset repo is the backup) |
| Destructive actions | slip or hijacked tab | trash first; delete forever and empty trash need the typed title and the password again; audit line in the same commit | untested in a real browser |
| Per-person control | none: no user list, no Google | - | removing one friend means rotating the password for everyone |
| Space repo | stray files published | the Space is public: upload only the built page and the public config | policy |
Static-mode claims that are NOT proven: real Hub commit/LFS/conflict behaviour from a browser, CORS from the Space origin, a real Static Space load, phones, H.264 playback.

## Server mode (saved option, D27) NOT SECURITY-REVIEWED (except the older v1 base)

## Threat model
| Asset | Threat | Mitigation |
|---|---|---|
| Clips | stranger gets them | private dataset; every `/api/files` request needs a session of a listed user |
| Read token | stolen from a browser | proxy design D9: never sent to a browser |
| Write token (D18, v2) | Space compromise gives dataset write | separate token scoped to the dataset only; Space secret; step-up on destructive actions |
| Sessions | theft / replay | HttpOnly `__Host-` cookie, HMAC-signed, 8 h, `SESSIONS_NOT_BEFORE` revocation (v1) |
| Friend removed | keeps access | list re-read on every request; cannot take back saved files |
| Space public repo | stray files published | upload allow-list |
| Credential file | leak of every key | wrapper keeps values out of chat; file still holds the OLD full-write token (D19) |

## Where secrets live (D22)
- SERVER MODE ONLY: app runtime secrets are Hugging Face Space secrets (static mode has none): `VAULT_READ_TOKEN`, `VAULT_WRITE_TOKEN`, `SESSION_SECRET`, `ADMIN_EMAILS`, optional `ALLOWED_EMAILS`, `VAULT_DATASET`. Public value as variable: `GOOGLE_CLIENT_ID`.
- Space secrets are WRITE-ONLY (no read-back in UI or API): there is no master copy in the Space. Rotate = create a new token and set it again; losing one is harmless because tokens can be reissued.
- Recommended: a password manager as the human master copy of every token.
- Claude/deploy credentials (`HF_Token`, Kaggle keys) are NOT Space secrets: Claude environment variables (preferred), or until retired the Kaggle dataset `arvr7plays/kagglegpu1` via `with_vault_creds.py`. Retire the PDF after the move; do not delete while the wrapper needs it.
- UNVERIFIED: that Space secrets are never exposed to forks or duplicates of a public Space (HF docs say not copied; verify).
- Roles other than root admins live in the dataset (`_config/users.json`), not in secrets.

## Guaranteed in code (v1, verified by reading `app.py`; tested with mocks only)
- Token goes only to `huggingface.co`; redirects followed by hand without the token to other hosts; https only.
- Auth checked before path validation (no existence oracle); path allow-list; no `%` or `..`; single `bytes=a-b` Range; content type fixed by extension.
- OAuth: PKCE S256, signed state cookie, immutable-id pinning `name:sub`; session MAC verified before JSON parsing; secret >= 32 chars or the app fails closed.
- Fails closed when config is missing (503). POST-only logout.
- Range header stripped on non-media static paths; `starlette>=0.49.1` (CVE-2025-62727 fix).
- Hash-locked dependencies, digest-pinned base image, non-root container, `--no-access-log`.
- Frontend of v1 had no `innerHTML`, `eval`, storage or third-party script; the v2 UI adds Google's sign-in script and a vendored three.js and was not reviewed.

## Only by policy (NOT guaranteed by code)
- `VAULT_READ_TOKEN` really is read-only and one-dataset (nothing checks the role or scope).
- No remote-code-execution bug in a dependency (it would expose the token).
- Agents only RUN `with_vault_creds.py` and never open the dataset/PDF (CLAUDE.md rule 1 with the user's exception, D17).
- Masking in the wrapper is best-effort (exact/encoded forms; not a guarantee).
- Friends do not re-share clips; removal cannot recall downloads.

## Claim corrections from the review (the docs must not say these)
| Old claim | Correct statement |
|---|---|
| "The scripts mask tokens" | the wrapper masks injected values, env values by name pattern and found Hugging Face and Kaggle-style tokens in several encodings; still best-effort |
| "Kaggle only through kaggle.py; agents never read key datasets" | the wrapper itself downloads and parses the key dataset; the user approved this exception |
| "A private Kaggle dataset is only a transfer copy" | `arvr7plays/kagglegpu1` is the working credential store |
| "Parsed in memory, nothing written outside" | the PDF is on disk in a temp folder (RAM `/dev/shm` when available) for the run; now swept/cleaned on SIGTERM |
| "Read-only, one dataset token" / passphrase minimum | not checked in code; passphrase check was weak (M5) |
| "Removed friend loses access on next click" | true for new requests; clips are now `no-store`; saved files stay |
| "ALLOWED list is a Variable" | variables of a public Space are public; use secrets |
| "Read token never leaves the Space" | true in code, only while the token is read-only and no RCE |

## Review result (D10) and review status (D30)
0 blocker, 0 high, 5 medium, 12 low (HF-OAuth tree only). Fixed: M1 id pinning, M2 (rate-limit key: still UNVERIFIED), M3 allow-list upload, M4 wrapper masking, M5 (passphrase strength: the old page is unused, but the static gate brings the same issue back, see D26). NOT reviewed: the static client, Google login, write token, admin actions, trash, step-up, users, upload, three.js UI. The user deferred further reviews until asked; no Opus agents without approval (D30).

## Credential wrapper and tokens (D34)
`with_vault_creds.py` runs only `python3 SCRIPT` for four allow-listed scripts (deploy_static, build_static, build_hfvault, vault_sync) or `--check`; shells, `-c/-e/-m`, `env` and every other command are refused BEFORE any credential is read (only the `--from-dir` test path runs anything). The whoami URL is fixed to https://huggingface.co (no override). `VAULT_PASSPHRASE` is masked at any length. `vault_sync.py` refuses the account-wide `HF_Token` unless `--allow-account-token`. The admin box refuses unknown-format tokens, account-wide roles, the read token and tokens without write on the dataset. Write permission outside the dataset only WARNS (D36, relaxes D34 item 9; the user owns the risk): each scope is named as `type/name: permission`, then "Continue anyway".

## Residual risks
0. Static gate: short human password, public config (D26, accepted by the user).
1. `HF_Token_backup` (old full-write token) unrevoked (D19).
2. Rate-limit key behind the HF proxy unverified.
3. Google consent screen in Testing mode: test users only, consent may expire in about 7 days.
4. Write token in the Space (v2) widens the blast radius of a Space bug.
5. Free Space sleeps after about 48 h; cold start about 1 minute.
6. Space bandwidth/speed (free tier) unverified.

## Rotation steps
STATIC mode: make a new read token and a new password, rebuild the config, redeploy the Static Space, test the gate, then revoke the old token (see [RUNBOOK.md](RUNBOOK.md) section 4). Admin write token: revoke it on Hugging Face after each admin session if in doubt; it is never stored.
SERVER mode:
1. Make a new token (read: one dataset, read-only; write: one dataset).
2. Set it again as the Space secret (Space > Settings > Variables and secrets, or `deploy_space.py`); the Space restarts.
3. Verify sign-in and a clip play.
4. Revoke the old token on Hugging Face.
5. Update the master copy (password manager; Kaggle credential line if still used).
6. Optional: set `SESSIONS_NOT_BEFORE` to the current unix time to drop all sessions (v1 name).
Never paste values in chat; never commit them.
