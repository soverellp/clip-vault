# Clip Vault project

> **STATUS BANNER (2026-11-24): the text below was written on 2026-11-18 and is HISTORY. The static Space is LIVE and the vault holds about 134 clips in 5 stream folders; the current state, deploy and verify steps are the section `CURRENT STATE` of `migration-setup/CLIP-VAULT.md`, the decisions are D43-D54 in DECISIONS.md.**

> **TL;DR** CURRENT plan: a free STATIC Hugging Face Space (`Soverellp/clip-vault-site`) where friends type a shared password; the page decrypts a read-only token in the browser and reads the clips from a PRIVATE Hugging Face dataset. An admin mode lets the admin paste a dataset-scoped write token (memory only) to edit, upload, trash and delete. A Google-sign-in server mode is built but SAVED as an option (it needs a paid Space). This folder holds every decision, flow and doc, and is written to be moved to GitHub `soverellp/clip-vault`.

Last updated: 2026-11-18 (events of 2026-11-17).

## What and why
- **What:** a private place where about 3 friends open one link, type the shared password, then watch and download the final clips (1080x1920, 20-43 MB each, 40-55 s). The admin also manages clips from the page (admin mode). Per-person Google login and user management exist only in the saved server mode.
- **Why:** the clips must not be public, hosting must be free, no encrypted clip files. Per-friend login was wanted, but Docker Spaces need the PRO plan (D23), so for now one shared password is the gate (D25, D26): the user accepted that trade-off.

## Status in 10 lines (details: [STATUS.md](STATUS.md))
1. 18 clips (517 MB) are uploaded and verified in the private dataset `Soverellp/clip-vault`; the read token was confirmed read-only.
2. The Static Space `Soverellp/clip-vault-site` exists, is public and EMPTY (D24).
3. `site/hfstatic` (password gate, admin mode, UI) is IN PROGRESS; it is not deployed.
4. The user chose a short human gate password and accepted the offline-guessing risk (D26).
5. Server mode (`site/hfspace`: Google sign-in, roles, trash, upload, audit, modern UI) is built, 239 + 69 pytest passed with fakes, NOT deployed (D27); Google config kept in [GOOGLE-CONFIG.md](GOOGLE-CONFIG.md).
6. NOT security-reviewed: the static client and server mode v2 (D30). Only the old HF-OAuth variant was reviewed.
7. Untested: real Hub commit/LFS/conflict from a browser, a real Static Space load, real Google, phone, H.264, real Docker.
8. The old Hugging Face token `HF_Token_backup` is still NOT revoked (the user's choice).
9. Code stays in clipper for now (D20).
10. Next: finish `site/hfstatic`, deploy, the user tests gate and admin mode, then a docs pass ([STATUS.md](STATUS.md)).

## Index of this folder
| File | Read it when |
|---|---|
| [DECISIONS.md](DECISIONS.md) | you ask "why did we do it this way" (ADR log D1-D31, newest first) |
| [FLOW.md](FLOW.md) | you want the end-to-end picture (Mermaid + numbered steps) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | components, trust boundaries, secrets list by NAME, code locations |
| [DATA-MODEL.md](DATA-MODEL.md) | `index.json`, `users.json`, `trash/clips/`, `_audit/` |
| [API-CONTRACT.md](API-CONTRACT.md) | static-mode Hub calls (design) and the server-mode API as built |
| [GOOGLE-CONFIG.md](GOOGLE-CONFIG.md) | the Google Cloud setup kept for server mode (public values only) |
| [SECURITY.md](SECURITY.md) | threat model, guaranteed vs policy-only, residual risks, rotation |
| [REQUIREMENTS-HISTORY.md](REQUIREMENTS-HISTORY.md) | what the user asked for, in order |
| [RUNBOOK.md](RUNBOOK.md) | do-this-now steps (deploy, users, tokens, upload, restore, disaster) |
| [STATUS.md](STATUS.md) | proven vs untested vs not built, open questions, next steps |
| [CHANGELOG.md](CHANGELOG.md) | dated history with commit hashes |

## How to continue (a new session, about 2 minutes to orient)
1. Read [STATUS.md](STATUS.md), then the newest 3 entries of [DECISIONS.md](DECISIONS.md).
2. Read the "Code locations" table in [ARCHITECTURE.md](ARCHITECTURE.md) and open the code there.
3. Verify against the real code before trusting [API-CONTRACT.md](API-CONTRACT.md): `site/hfstatic` (current plan, README there when present) and, for server mode, `site/hfspace/app.py` and `admin.py`.
4. Never print, paste or commit a secret value; names only (see [SECURITY.md](SECURITY.md)).

## Maintenance rule (mandatory)
Every future decision or flow change MUST be appended to [DECISIONS.md](DECISIONS.md) and [FLOW.md](FLOW.md) **in the same change**, newest first, with the date. Also add a line to [CHANGELOG.md](CHANGELOG.md) and update [STATUS.md](STATUS.md). A change that touches only code and not these files is incomplete.

## Moving this folder to GitHub
The folder uses relative links only. Copy it to the root of `soverellp/clip-vault` (or keep it as `docs/`). The only clipper paths appear in the "Code locations" table in [ARCHITECTURE.md](ARCHITECTURE.md); update that table when code moves.
