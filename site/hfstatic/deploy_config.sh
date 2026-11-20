#!/usr/bin/env bash
# One-shot: rebuild the encrypted config.json (read token + shortlist writer) and deploy the site. Nothing secret is stored here.
# Needs ONE env var set by you at run time: VAULT_PASSPHRASE (the real passphrase). Everything else is mapped from existing env names:
# Run it through the Bitwarden wrapper (new names): python3 site/hfvault/with_bw_creds.py -- python3 site/hfstatic/deploy_static.py
# (or export the names yourself). Names used:
#   read token      <- VAULT_READ_TOKEN     (fine-grained, read-only, clip-vault)
#   shortlist token <- HF_Token             (writes the shortlist; wide scope, see migration-setup/CLIP-VAULT.md)
#   Space upload    <- HF_Token
# The script verifies in a fresh process that the passphrase decrypts the new config BEFORE anything is uploaded.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${VAULT_PASSPHRASE:?set VAULT_PASSPHRASE first (do not echo it)}"
: "${VAULT_READ_TOKEN:?VAULT_READ_TOKEN missing}"
: "${HF_Token:?HF_Token missing}"
export VAULT_SHORTLIST_TOKEN="${VAULT_SHORTLIST_TOKEN:-$HF_Token}"
exec python3 site/hfstatic/deploy_static.py "$@"
