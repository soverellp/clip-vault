#!/usr/bin/env python3
"""Build and deploy the static Clip Vault site to a free Hugging Face STATIC Space.

Run it through the credential wrapper so the keys never appear anywhere:
  python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfstatic/deploy_static.py

Environment NAMES read: VAULT_READ_TOKEN, VAULT_PASSPHRASE (build), HF_Token (the account's write token, used only to
create/upload the Space). The admin's dataset WRITE token is never used here: it is pasted in the browser when needed.
Only the files in build_static.DEPLOY_ALLOW are uploaded (never tests, .env, build-info.json or anything else). Prints names only.

Options: --space OWNER/NAME (default Soverellp/clip-vault-site), --dataset, --no-build, --dry-run, --accept-weak-passphrase
"""
import argparse, os, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_static as bs  # noqa: E402

DEFAULT_SPACE = "Soverellp/clip-vault-site"
IGNORE = [".*", "*/.*", "*.env", "*.env.*"]
TOKEN_RE = re.compile(r"hf_[A-Za-z0-9]{20,}|KGAT_[A-Za-z0-9]{20,}")


def planned_files(dist: Path):
    """The dist files that may be uploaded (allow-list), as repo paths."""
    from huggingface_hub.utils import filter_repo_objects
    rel = sorted(str(p.relative_to(dist)) for p in dist.rglob("*") if p.is_file())
    return sorted(filter_repo_objects(rel, allow_patterns=bs.DEPLOY_ALLOW, ignore_patterns=IGNORE))


def scan_for_secrets(dist: Path, files):
    """Refuse to upload if any file contains something that looks like a Hugging Face token. Returns the offending file names."""
    return [f for f in files if TOKEN_RE.search((dist / f).read_text(errors="ignore"))]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--space", default=DEFAULT_SPACE)
    ap.add_argument("--dataset", default=bs.DEFAULT_DATASET)
    ap.add_argument("--dist", default=str(bs.DEFAULT_OUT))
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--accept-weak-passphrase", action="store_true")
    a = ap.parse_args(argv)
    if not re.fullmatch(r"[\w.\-]+/[\w.\-]+", a.space):
        sys.exit("error: --space must look like OWNER/NAME")
    if not a.no_build:
        bs.build(a.dist, a.dataset, weak=a.accept_weak_passphrase)
    dist = Path(a.dist)
    if not (dist / bs.MARKER).is_file() or not (dist / "index.html").is_file():
        sys.exit(f"error: {dist} is not a build_static.py output (run without --no-build)")
    files = planned_files(dist)
    for need in ("index.html", "README.md", "config.json", "js/hubapi.js"):
        if need not in files:
            sys.exit(f"error: {need} would not be uploaded; refusing")
    bad = scan_for_secrets(dist, files)
    if bad:
        sys.exit("error: a Hugging Face token pattern was found in: " + ", ".join(bad) + "; nothing uploaded")
    print(f"{len(files)} files will be uploaded to Space {a.space}:")
    for f in files[:5]:
        print("  " + f)
    if len(files) > 5:
        print(f"  ... and {len(files) - 5} more")
    if a.dry_run:
        print("dry run: nothing uploaded")
        return
    w = os.environ.get("HF_Token") or os.environ.get("HF_TOKEN") or ""
    if not w:
        sys.exit("error: HF_Token (the account write token) is not set; run through site/hfvault/with_vault_creds.py")
    from huggingface_hub import HfApi
    from huggingface_hub.errors import HfHubHTTPError
    api = HfApi(token=w)
    try:
        api.create_repo(a.space, repo_type="space", space_sdk="static", private=False, exist_ok=True)
    except HfHubHTTPError as e:
        code = getattr(getattr(e, "response", None), "status_code", "?")
        sys.exit(f"error: Hugging Face refused to create the Space {a.space} (HTTP {code}). Create it by hand at "
                 "https://huggingface.co/new-space (SDK: Static, name as above, public), then run this script again.")
    except Exception as e:
        sys.exit(f"error: could not reach Hugging Face to create the Space ({type(e).__name__}). Check the network and retry.")
    try:
        # delete_patterns: stale files of an older deploy (a renamed js/*.js, a removed font) are removed in the same commit, but ONLY
        # paths inside the allow-listed set; .gitattributes is always kept by huggingface_hub and anything else in the Space is untouched.
        api.upload_folder(folder_path=str(dist), repo_id=a.space, repo_type="space", allow_patterns=bs.DEPLOY_ALLOW,
                          ignore_patterns=IGNORE, delete_patterns=bs.DEPLOY_ALLOW, commit_message="Deploy static Clip Vault")
    except Exception as e:
        sys.exit(f"error: upload failed ({type(e).__name__}); nothing else was changed")
    owner, _, name = a.space.partition("/")
    print(f"deployed: {a.space}\nopen: https://{owner.lower()}-{name.lower()}.static.hf.space (and https://huggingface.co/spaces/{a.space})")


if __name__ == "__main__":
    main()
