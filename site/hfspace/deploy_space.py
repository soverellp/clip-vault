"""Create/update the Hugging Face Space Soverellp/clip-vault-site (docker, free CPU) and set its config.

Needs in the environment (values are never printed):
  HF_Token           token that can create/write the Space (a BROAD token: it is never copied into the Space)
  VAULT_READ_TOKEN   read-only dataset token                       -> Space secret
  GOOGLE_CLIENT_ID   public OAuth client id (xxx.apps.googleusercontent.com) -> Space VARIABLE (public by design)
  ADMIN_EMAILS       comma separated `email` or `email:sub`        -> Space SECRET (the root admins)
Optional:
  VAULT_WRITE_TOKEN  fine-grained token, write access to the dataset ONLY -> Space secret. Must differ from
                     VAULT_READ_TOKEN and from HF_Token. Unset = the site is read-only (the existing secret, if any, is kept)
  ALLOWED_EMAILS     viewers (default: the ADMIN_EMAILS list; admins are implicitly viewers) -> Space SECRET
  SESSION_SECRET     >= 32 chars -> Space secret; if unset a random one is generated (and never shown)
  VAULT_DATASET      default Soverellp/clip-vault -> Space SECRET
  SPACE_ID           default Soverellp/clip-vault-site

Usage (with_bw_creds injects the Bitwarden items; export the rest first):
  python3 site/hfvault/with_bw_creds.py -- python3 site/hfspace/deploy_space.py
A generated SESSION_SECRET is created per run, which signs everybody out (fine). The Space is public (friends open the
page); it holds no clips and no Google secret. Prints only names and OK/ERROR.
"""
import os
import re
import secrets
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
HAND = ("Create the Space by hand (huggingface.co/new-space, SDK Docker, template Blank, public, name clip-vault-site) "
        "and give the token write access to it, then run this script again.")
# ALLOWLIST: the Space repo is PUBLIC, so only these files are ever uploaded; any stray file (notes.txt, x.log,
# cookies.txt, screenshots, HAR dumps) stays local. requirements.in, SETUP.md, README of tests, tests/ and this script are not uploaded.
ALLOW = ["Dockerfile", "README.md", "app.py", "auth.py", "store.py", "admin.py", "common.py", "requirements.txt",
         "static/*.js", "static/*.html", "static/*.css", ".gitignore"]


def need(name):
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"ERROR: environment variable {name} is not set (set it in the environment, never in chat).")
    return v


def main():
    token, read_tok = need("HF_Token"), need("VAULT_READ_TOKEN")
    if read_tok == token:
        sys.exit("ERROR: VAULT_READ_TOKEN must differ from the deploy token HF_Token.")
    write_tok = os.environ.get("VAULT_WRITE_TOKEN", "").strip()
    if write_tok and write_tok in (read_tok, token):
        sys.exit("ERROR: VAULT_WRITE_TOKEN must differ from VAULT_READ_TOKEN and from HF_Token (a broad token must never become a Space secret).")
    client_id = need("GOOGLE_CLIENT_ID")
    if not re.fullmatch(r"[A-Za-z0-9\-]{1,120}\.apps\.googleusercontent\.com", client_id):
        sys.exit("ERROR: GOOGLE_CLIENT_ID does not look like xxx.apps.googleusercontent.com.")
    admins = need("ADMIN_EMAILS")
    viewers = os.environ.get("ALLOWED_EMAILS", "").strip() or admins
    session_secret = os.environ.get("SESSION_SECRET", "").strip() or secrets.token_urlsafe(48)
    if len(session_secret) < 32:
        sys.exit("ERROR: SESSION_SECRET must be at least 32 characters.")
    dataset = os.environ.get("VAULT_DATASET", "").strip() or "Soverellp/clip-vault"
    space = os.environ.get("SPACE_ID", "Soverellp/clip-vault-site")
    try:
        from huggingface_hub import HfApi
    except ImportError:
        sys.exit("ERROR: pip install huggingface_hub")
    api = HfApi(token=token)

    def step(label, fn, hand=False):
        try:
            fn()
            print(f"OK    {label}")
        except Exception as e:  # print only the class name and status, never the message
            status = getattr(getattr(e, "response", None), "status_code", "")
            print(f"ERROR {label}: {type(e).__name__} {status}")
            if hand or status in (401, 403):
                print(HAND)
            sys.exit(1)

    step(f"create Space {space} (docker, public)",
         lambda: api.create_repo(space, repo_type="space", space_sdk="docker", private=False, exist_ok=True), hand=True)
    step("upload allowlisted files only",
         lambda: api.upload_folder(folder_path=str(HERE), repo_id=space, repo_type="space", allow_patterns=ALLOW))
    step("secret VAULT_READ_TOKEN", lambda: api.add_space_secret(space, "VAULT_READ_TOKEN", read_tok))
    if write_tok:
        step("secret VAULT_WRITE_TOKEN", lambda: api.add_space_secret(space, "VAULT_WRITE_TOKEN", write_tok))
    else:
        print("OK    VAULT_WRITE_TOKEN not set: an existing Space secret is kept; without one the site is read-only")
    step("secret SESSION_SECRET", lambda: api.add_space_secret(space, "SESSION_SECRET", session_secret))
    step("secret VAULT_DATASET", lambda: api.add_space_secret(space, "VAULT_DATASET", dataset))
    step("secret ALLOWED_EMAILS", lambda: api.add_space_secret(space, "ALLOWED_EMAILS", viewers))
    step("secret ADMIN_EMAILS", lambda: api.add_space_secret(space, "ADMIN_EMAILS", admins))
    step("variable GOOGLE_CLIENT_ID (public)", lambda: api.add_space_variable(space, "GOOGLE_CLIENT_ID", client_id))
    for old in ("VAULT_DATASET", "ALLOWED_HF_USERS", "ALLOWED_EMAILS", "ADMIN_EMAILS"):  # earlier deploys: public variables
        try:
            api.delete_space_variable(space, old)
            print(f"OK    removed old public variable {old}")
        except Exception:
            print(f"OK    no old public variable {old} to remove")
    try:  # the Hugging Face login is gone: its allowlist secret is dead weight
        api.delete_space_secret(space, "ALLOWED_HF_USERS")
        print("OK    removed old secret ALLOWED_HF_USERS")
    except Exception:
        print("OK    no old secret ALLOWED_HF_USERS to remove")
    print(f"DONE. Page: https://{space.replace('/', '-').lower()}.hf.space (first build takes about 2-3 minutes)")


if __name__ == "__main__":
    main()
