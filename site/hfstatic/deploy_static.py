#!/usr/bin/env python3
"""Build and deploy the static Clip Vault site to a free Hugging Face STATIC Space.

Run it through the credential wrapper so the keys never appear anywhere:
  python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfstatic/deploy_static.py

Environment NAMES read: VAULT_READ_TOKEN, VAULT_PASSPHRASE (build), HF_Token (the account's write token, used only to
create/upload the Space). The admin's dataset WRITE token is never used here: it is pasted in the browser when needed.
Only the files in build_static.DEPLOY_ALLOW are uploaded (never tests, .env, build-info.json or anything else). Prints names only.

Options: --space OWNER/NAME (default Soverellp/clip-vault-site), --dataset, --no-build, --dry-run, --accept-weak-passphrase,
--only PATH [PATH ...]  PATCH deploy: upload only these dist files (js/ and css/ files, e.g. js/moments.js), implies --no-build, never config.json
(the encrypted token / passphrase gate stays exactly as deployed, so no passphrase is needed), nothing is deleted.
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


def verify_config(dist: Path):
    """Decrypt dist/config.json with VAULT_PASSPHRASE in a FRESH process: the read token (and the shortlist token, when the env has one) must
    come back exactly. Prints only ok/fail. Returns True when the same passphrase unlocks the new config."""
    import subprocess
    code = ("import json,os,sys;sys.path.insert(0,sys.argv[1]);import build_static as b;c=json.load(open(sys.argv[2]));pw=os.environ['VAULT_PASSPHRASE'];"
            "ok=b.decrypt_token(c,pw)==os.environ['VAULT_READ_TOKEN'];sl=os.environ.get('VAULT_SHORTLIST_TOKEN','');"
            "ok=ok and (b.decrypt_shortlist_token(c,pw)==sl if sl else 'sl' not in c);sys.exit(0 if ok else 1)")
    r = subprocess.run([sys.executable, "-c", code, str(HERE), str(dist / "config.json")], capture_output=True, env=os.environ.copy())
    return r.returncode == 0


def shortlist_scope(tok, dataset):
    """-> (can_write_dataset, text). Names and roles only, never the token."""
    import json, urllib.request
    try:
        j = json.load(urllib.request.urlopen(urllib.request.Request("https://huggingface.co/api/whoami-v2", headers={"Authorization": "Bearer " + tok}), timeout=30))
    except Exception as e:
        return False, f"whoami failed ({type(e).__name__})"
    a = (j.get("auth") or {}).get("accessToken") or {}
    role = a.get("role")
    if role in ("write", "admin"):
        return True, f"account-wide role {role}"
    sc = [(x["entity"]["name"], x["entity"]["type"], x["permissions"]) for x in (a.get("fineGrained") or {}).get("scoped", [])]
    w = any(n == dataset and "repo.write" in p for n, _, p in sc) or any(t == "user" and "repo.write" in p for n, t, p in sc)
    return w, "fine-grained, scopes: " + "; ".join(f"{t}:{n}[{','.join(p)}]" for n, t, p in sc)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--space", default=DEFAULT_SPACE)
    ap.add_argument("--dataset", default=bs.DEFAULT_DATASET)
    ap.add_argument("--shortlist-dataset", default=None, help="dataset that holds the shortlist file (default: the clip dataset)")
    ap.add_argument("--shortlist-path", default=bs.DEFAULT_SL_PATH)
    ap.add_argument("--dist", default=str(bs.DEFAULT_OUT))
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--accept-weak-passphrase", action="store_true")
    ap.add_argument("--only", nargs="+", metavar="PATH", help="patch deploy: upload only these dist files (js/*.js, css/*.css); implies --no-build; config.json is never touched")
    a = ap.parse_args(argv)
    if not re.fullmatch(r"[\w.\-]+/[\w.\-]+", a.space):
        sys.exit("error: --space must look like OWNER/NAME")
    if a.only:
        a.no_build = True
        for f in a.only:
            if not re.fullmatch(r"(js|css)/[\w.\-]+\.(js|css)", f):
                sys.exit(f"error: --only takes js/*.js or css/*.css paths relative to dist, got {f!r}")
    if not a.no_build:
        bs.build(a.dist, a.dataset, weak=a.accept_weak_passphrase, sl_dataset=a.shortlist_dataset, sl_path=a.shortlist_path)
    dist = Path(a.dist)
    if not a.no_build:
        sl = os.environ.get("VAULT_SHORTLIST_TOKEN", "")
        if sl:
            okw, why = shortlist_scope(sl, a.shortlist_dataset or a.dataset)
            print("shortlist token: " + why + ("" if okw else "  (NO write access to the shortlist dataset)"))
            if not okw:
                sys.exit("error: the shortlist token cannot write the shortlist dataset; nothing uploaded")
        if not verify_config(dist):
            sys.exit("error: the new config.json did NOT decrypt back to the expected tokens with VAULT_PASSPHRASE; nothing uploaded")
        print("verify-decrypt: ok (the passphrase unlocks the new config.json)")
    if not (dist / bs.MARKER).is_file() or not (dist / "index.html").is_file():
        sys.exit(f"error: {dist} is not a build_static.py output (run without --no-build)")
    files = planned_files(dist)
    for need in ("index.html", "README.md", "config.json", "js/hubapi.js"):
        if need not in files:
            sys.exit(f"error: {need} would not be uploaded; refusing")
    if a.only:
        miss = [f for f in a.only if f not in files]
        if miss:
            sys.exit("error: not in the deployable dist files: " + ", ".join(miss))
        files = sorted(a.only)
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
        if a.only:  # patch: only the named files, nothing deleted, config.json untouched
            api.upload_folder(folder_path=str(dist), repo_id=a.space, repo_type="space", allow_patterns=list(a.only), ignore_patterns=IGNORE,
                              commit_message="Patch static Clip Vault: " + ", ".join(a.only))
        else:
            api.upload_folder(folder_path=str(dist), repo_id=a.space, repo_type="space", allow_patterns=bs.DEPLOY_ALLOW,
                              ignore_patterns=IGNORE, delete_patterns=bs.DEPLOY_ALLOW, commit_message="Deploy static Clip Vault")
    except Exception as e:
        sys.exit(f"error: upload failed ({type(e).__name__}); nothing else was changed")
    owner, _, name = a.space.partition("/")
    print(f"deployed: {a.space}\nopen: https://{owner.lower()}-{name.lower()}.static.hf.space (and https://huggingface.co/spaces/{a.space})")


if __name__ == "__main__":
    main()
