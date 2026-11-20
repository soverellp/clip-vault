#!/usr/bin/env bash
# One-shot: rebuild the encrypted config.json (read token + shortlist writer) and deploy the site. Nothing secret is stored here.
# Needs ONE env var set by you at run time: VAULT_PASSPHRASE (the real passphrase). Everything else is mapped from existing env names:
#   read token      <- Clip_vault_HFToken   (fine-grained, read-only, clip-vault)
#   shortlist token <- HF_Tokem             (writes the shortlist; wide scope, see migration-setup/CLIP-VAULT.md)
#   Space upload    <- HF_Tokem
# The script verifies in a fresh process that the passphrase decrypts the new config BEFORE anything is uploaded.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${VAULT_PASSPHRASE:?set VAULT_PASSPHRASE first (do not echo it)}"
export VAULT_READ_TOKEN="${VAULT_READ_TOKEN:-${Clip_vault_HFToken:?Clip_vault_HFToken missing}}"
export VAULT_SHORTLIST_TOKEN="${VAULT_SHORTLIST_TOKEN:-${HF_Tokem:?HF_Tokem missing}}"
export HF_Token="${HF_Token:-$HF_Tokem}"
exec python3 site/hfstatic/deploy_static.py "$@"
