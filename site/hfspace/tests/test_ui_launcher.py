"""Smoke test: the Playwright launcher boots the real app on fake data (subprocess, own port, own env)."""
import socket
import subprocess
import sys
import time
from pathlib import Path

import requests

LAUNCHER = Path(__file__).resolve().parent / "ui_launcher.py"


def test_launcher_serves_real_backend_with_seeded_clips_and_switchable_logins():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    p = subprocess.Popen([sys.executable, str(LAUNCHER), str(port)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        base = f"http://127.0.0.1:{port}"
        for _ in range(100):
            try:
                requests.get(base + "/__accounts", timeout=1)
                break
            except requests.RequestException:
                time.sleep(0.1)
        assert requests.get(base + "/api/me").status_code == 401
        a = requests.Session()
        a.get(base + "/__as/root@example.com", allow_redirects=False)
        # the launcher cookie is Secure (__Host-): requests will not replay it over http, so pass it by hand
        raw = a.cookies.get("__Host-cv_session") or [c for c in a.cookies][0].value
        ck = {"__Host-cv_session": raw}
        me = requests.get(base + "/api/me", cookies=ck).json()
        assert me["role"] == "admin" and me["root"] is True and me["can_write"] is True
        d = requests.get(base + "/api/clips?trash=1", cookies=ck).json()
        assert d["counts"] == {"active": 3, "trash": 1} and len(d["clips"]) == 1
        v = requests.Session()
        v.get(base + "/__as/viewer@example.com", allow_redirects=False)
        vc = {"__Host-cv_session": v.cookies.get("__Host-cv_session") or [c for c in v.cookies][0].value}
        assert requests.get(base + "/api/me", cookies=vc).json()["role"] == "viewer"
        assert requests.get(base + "/api/audit", cookies=vc).status_code == 403
        first = requests.get(base + "/api/clips", cookies=vc).json()["clips"][0]
        assert requests.get(base + "/api/files/" + first["video"], cookies=vc).status_code == 200
    finally:
        p.terminate()
        p.wait(timeout=10)
