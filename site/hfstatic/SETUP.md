# SETUP: static Clip Vault (about 15 minutes, once)

Nobody gives Claude the dataset WRITE token. The admin pastes it in the browser when needed.

1. Create the Space by hand (2 min): https://huggingface.co/new-space -> owner `Soverellp`, name `clip-vault-site`, SDK **Static**, **Public**.
   (`deploy_static.py` also tries to create it; if Hugging Face refuses, this manual step is the fallback.)
2. Check the two environment values (names only; never paste them in chat): `VAULT_READ_TOKEN` (read-only, this dataset only),
   `VAULT_PASSPHRASE` (at least 4 DISTINCT random words, 20+ characters). `HF_Token` is the account token used only to upload the Space.
3. Dry run (1 min, uploads nothing):
   `python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfstatic/deploy_static.py --dry-run`
4. Deploy (2 min):
   `python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfstatic/deploy_static.py`
5. Open `https://soverellp-clip-vault-site.static.hf.space` (the direct address; the huggingface.co Space page shows it framed, and the
   page then asks you to open it directly). Type the passphrase.
6. Admin (only when you must change something): click Admin, paste a fine-grained token that can write to `Soverellp/clip-vault` ONLY
   (https://huggingface.co/settings/tokens -> Fine-grained -> repository permissions: that dataset, Write). Close with Exit admin or Lock;
   revoke the token afterwards if it was meant for one job.

Rotate (someone left, passphrase leaked): create a new read token, set a new `VAULT_PASSPHRASE`, run step 4, revoke the old read token.
There are no per-person accounts: access control is ONE shared passphrase.

## Accepted risks

- **Weak passphrase (owner decision 2026-11-17).** The owner prefers a short human password and accepts that `config.json` is public
  and can be brute-forced offline. The strict default stays (4 distinct words, 20+ characters, no well-known phrases). To override
  knowingly: add `--accept-weak-passphrase` to the build or deploy command. It skips ONLY the strength rules (an empty passphrase, a bad
  token, a read token equal to the write token and the output-folder safety checks still apply), prints a multi-line warning to stderr
  (never the passphrase), writes `WEAK PASSPHRASE ACCEPTED BY OWNER on <date>` into `dist/README.md` and `dist/build-info.json`, and
  refreshes `site/hfstatic/build-info.json` (no secrets) for `clip-vault-project/DECISIONS.md` to reference. The unlock screen keeps its
  in-memory attempt delay either way, but that delay does not slow an offline attack. If the short password is found, the read token
  (every clip) is exposed until you revoke it. Mitigation: keep the token read-only, one dataset, and rotate on any doubt.
- One shared passphrase, no per-person revocation.
- Trash is hidden, not secret, for people holding the passphrase.
- The admin write token is typed into a browser. Use a fine-grained, single-dataset token.
