# clip-vault

The private clip vault: how finished vertical clips reach friends. The clips sit in the private Hugging Face dataset `Soverellp/clip-vault`. This repo holds only source code and docs (no clips, no keys, no passwords). It is generated from the `clipper` repo by `.claude/scripts/sync_vault_repo.sh`; edit the source there, not here.

## What is here
- `site/hfstatic/`: the free static Hugging Face Space (`Soverellp/clip-vault-site`): friends unlock a read-only token with a shared password; admin mode takes a dataset-scoped write token pasted in the browser.
- `site/hfspace/`: the shared UI, the saved Google-sign-in server mode, and the tests.
- `site/hfvault/`: clip upload and credential-injection tools, with tests.
- `clip-vault-project/`: decisions, flow, architecture, API, security, runbook, status, design mockups.
- `migration-setup/CLIP-VAULT.md`: upload, deploy and runbook.

## Build, test, deploy
1. Read `clip-vault-project/README.md` first, then `site/hfstatic/SETUP.md`.
2. Build: `python3 site/hfstatic/build_static.py` (writes `site/hfstatic/dist/`, not committed).
3. Test (Python): `python3 -m pytest site/hfstatic/tests site/hfspace/tests site/hfvault/tests`.
4. Test (browser UI, Node): `node site/hfstatic/tests/test_static.js`.
5. Deploy the Space: `python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfstatic/deploy_static.py` (dry run first with `--dry-run`; see `site/hfstatic/SETUP.md`).
6. Upload clips: `python3 site/hfvault/with_vault_creds.py -- python3 site/hfvault/vault_sync.py ...` (see `site/hfvault/VAULT-SYNC.md`).
7. Tokens and passwords live only in the Claude environment and the private key dataset; never in this repo.
8. Runbook and security notes: `clip-vault-project/RUNBOOK.md`, `clip-vault-project/SECURITY.md`.
