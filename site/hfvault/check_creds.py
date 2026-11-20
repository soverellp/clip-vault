#!/usr/bin/env python3
"""Credential health check. Prints ONLY name + ok/fail + a short reason, never a value.

Run it through the wrapper (the credentials only exist in the child environment):
  python3 site/hfvault/with_bw_creds.py -- python3 site/hfvault/check_creds.py
Checks every credential that is present: HF_Token / VAULT_READ_TOKEN / HF_Token_Backup (Hugging Face whoami-v2: role,
fine-grained yes/no, can it write to dataset Soverellp/clip-vault; VAULT_READ_TOKEN must NOT be able to write),
Kaggle account 1 (KAGGLE_USERNAME + KAGGLE_APITOKEN) and account 2 (...2) via the kaggle CLI, VAULT_PASSPHRASE
(20+ characters and 4+ words; yes/no only). Exit 1 when any check fails; absent credentials are reported as "absent"."""
import json, os, re, shutil, subprocess, sys, urllib.request

WHOAMI_URL = "https://huggingface.co/api/whoami-v2"  # fixed on purpose: a token must never go to an overridable URL
DATASET = "Soverellp/clip-vault"
WRITEY = re.compile(r"write|create|delete|manage|admin|edit", re.I)

def whoami(tok):
    try:
        req = urllib.request.Request(WHOAMI_URL, headers={"Authorization": "Bearer " + tok})
        return json.load(urllib.request.urlopen(req, timeout=15)), None
    except Exception as e:
        return None, str(getattr(e, "code", type(e).__name__))

def analyse(data):
    """-> dict(role, fine, can_write_dataset, user). Derived from the whoami response only."""
    acc = ((data or {}).get("auth") or {}).get("accessToken") or {}
    role = acc.get("role") or "unknown"
    fine = role == "fineGrained"
    if role in ("write", "admin"): can = True
    elif role == "read": can = False
    elif fine:
        fg = acc.get("fineGrained") or {}
        can = any(isinstance(p, str) and WRITEY.search(p) for p in (fg.get("global") or []))
        for sc in fg.get("scoped") or []:
            ent = (sc or {}).get("entity") or {}
            hit = ent.get("type") in ("dataset", "user", "org") and ent.get("name") in (DATASET, DATASET.split("/")[0], None, "")
            if hit and any(isinstance(p, str) and WRITEY.search(p) for p in (sc.get("permissions") or [])): can = True
    else: can = None
    return {"role": role, "fine": fine, "can_write_dataset": can, "user": (data or {}).get("name")}

def check_hf(name, tok, must_be_readonly=False):
    data, err = whoami(tok)
    if data is None: return name, False, f"whoami failed ({err})"
    a = analyse(data)
    desc = f"role {a['role']}, fineGrained {'yes' if a['fine'] else 'no'}, can write {DATASET}: " + \
           {True: "yes", False: "no", None: "unknown"}[a["can_write_dataset"]]
    if must_be_readonly and a["can_write_dataset"] is not False:
        return name, False, "must be read-only but " + desc
    return name, True, desc

def check_kaggle(label, user, token):
    if not shutil.which("kaggle"): return label, False, "kaggle CLI missing: pip install kaggle"
    env = {k: v for k, v in os.environ.items() if not k.startswith("KAGGLE_")}
    env.update(KAGGLE_USERNAME=user, KAGGLE_API_TOKEN=token, KAGGLE_KEY=token)
    try:
        r = subprocess.run(["kaggle", "kernels", "list", "--mine", "--page-size", "1"], capture_output=True, text=True, env=env, timeout=60)
    except subprocess.TimeoutExpired: return label, False, "kaggle timed out"
    except OSError as e: return label, False, "kaggle could not run (" + type(e).__name__ + ")"
    if r.returncode == 0: return label, True, "login ok"
    low = ((r.stderr or "") + (r.stdout or "")).lower()
    why = "unauthorized (wrong user or token)" if ("401" in low or "unauthorized" in low or "forbidden" in low or "403" in low) else f"kaggle exit {r.returncode}"
    return label, False, why

def check_passphrase(p):
    words = len([w for w in re.split(r"\s+", p.strip()) if w])
    ok = len(p) >= 20 and words >= 4
    return "VAULT_PASSPHRASE", ok, f"strong enough: {'yes' if ok else 'no'} (needs 20+ characters and 4+ words)"

def run(env):
    out = []
    for n in ("HF_Token", "VAULT_READ_TOKEN", "HF_Token_Backup"):
        if env.get(n): 
            r = check_hf(n, env[n], must_be_readonly=(n == "VAULT_READ_TOKEN"))
            if n == "HF_Token_Backup": r = (r[0], r[1], r[2] + " (OLD account: revoke it)")
            out.append(r)
        else: out.append((n, None, "absent"))
    for lab, u, t in (("Kaggle account 1", "KAGGLE_USERNAME", "KAGGLE_APITOKEN"), ("Kaggle account 2", "KAGGLE_USERNAME2", "KAGGLE_APITOKEN2")):
        if env.get(u) and env.get(t): out.append(check_kaggle(lab, env[u], env[t]))
        else: out.append((lab, None, "absent (" + ", ".join(x for x in (u, t) if not env.get(x)) + " missing)"))
    out.append(check_passphrase(env["VAULT_PASSPHRASE"]) if env.get("VAULT_PASSPHRASE") else ("VAULT_PASSPHRASE", None, "absent"))
    return out

def main():
    res = run(os.environ)
    for n, ok, why in res:
        print(f"{'ok' if ok else 'absent' if ok is None else 'FAIL':6} {n}: {why}")
    return 1 if any(ok is False for _, ok, _ in res) else 0

if __name__ == "__main__":
    sys.exit(main())
