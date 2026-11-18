"""Core API properties kept from the Hugging Face OAuth version (headers, Range, limits, config) plus the Google ones."""
import logging
import re
import socket
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import pytest

import app as A
import common
import fakes
from conftest import READ_TOKEN, SECRETS, SESSION_SECRET, WRITE_TOKEN
from helpers import as_user, client, login

ROOT = Path(A.__file__).parent


# ---------------------------------------------------------------- file proxy

def test_files_require_session():
    r = client().get("/api/files/clips/c1.mp4")
    assert r.status_code == 401 and r.json()["error"] == "unauthorized"


@pytest.mark.parametrize("path,status", [
    ("clips/c1.mp4", 200), ("clips/c1.jpg", 200), ("clips/c2.mp4", 200),
    ("index.json", 404), ("users.json", 404), ("_audit/2026-11.jsonl", 404),
    ("clips/missing.mp4", 404), ("clips/t1.mp4", 404), ("trash/clips/t1.mp4", 404),  # viewers: no trash
    ("clips/..%2Findex.json", 404), ("clips%2Fc1.mp4", 404), ("clips/%2e%2e/index.json", 404), ("clips/c1.mp4%00", 404),
    ("clips/c1.txt", 404), ("clips/c1.png", 404), ("other/c1.mp4", 404), ("clips/sub/c1.mp4", 404), ("clips/c1..mp4", 404),
    ("clips/.mp4", 404), ("clips/.hidden.mp4", 404), ("clips/" + "a" * 201 + ".mp4", 404), ("clips/c1.mp4%0a", 404),
])
def test_file_path_rules_for_a_viewer(path, status, env):
    c, _ = as_user("viewer@example.com")
    before = len(env["upstream"])
    r = c.get("/api/files/" + path)
    assert r.status_code == status, (path, r.status_code)
    if status == 404:
        assert len(env["upstream"]) == before  # never even reached the upstream


def test_admin_reads_trash_files_but_only_trashed_ones(env):
    c, _ = as_user("root@example.com")
    assert c.get("/api/files/trash/clips/t1.mp4").status_code == 200
    assert c.get("/api/files/trash/clips/t1.jpg").status_code == 200
    assert c.get("/api/files/trash/clips/c1.mp4").status_code == 404  # active clip is not in the trash
    assert c.get("/api/files/clips/t1.mp4").status_code == 404  # trashed clip is not at the active path
    assert c.get("/api/files/index.json").status_code == 404


def test_poster_less_clip_has_no_jpg(env):
    fakes.seed(env["state"], [fakes.clip("np", poster=None)])
    c, _ = as_user("viewer@example.com")
    assert c.get("/api/files/clips/np.jpg").status_code == 404 and c.get("/api/files/clips/np.mp4").status_code == 200


def test_upstream_errors_do_not_leak(monkeypatch):
    def fetch(cfg, path, rng):
        if path == "clips/c2.mp4":
            return 403, {}, iter([b"upstream says " + READ_TOKEN.encode()]), lambda: None
        return 404, {"x": "secret upstream body"}, iter([b"nope"]), lambda: None
    monkeypatch.setattr(A, "fetch_upstream", fetch)
    c, _ = as_user("viewer@example.com")
    r = c.get("/api/files/clips/c2.mp4")
    assert r.status_code == 502 and r.json()["error"] == "upstream_error" and READ_TOKEN not in r.text
    r = c.get("/api/files/clips/c1.mp4")
    assert r.status_code == 404 and "secret upstream" not in r.text


def test_full_and_range_requests(env):
    c, _ = as_user("viewer@example.com")
    r = c.get("/api/files/clips/c1.mp4")
    assert r.status_code == 200 and r.content == fakes.MP4 and r.headers["content-type"] == "video/mp4"
    assert r.headers["cache-control"] == "no-store" and r.headers["accept-ranges"] == "bytes"
    r = c.get("/api/files/clips/c1.mp4", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206 and r.headers["content-range"].startswith("bytes 0-9/") and len(r.content) == 10
    assert env["upstream"][-1][1] == "bytes=0-9"
    c.get("/api/files/clips/c1.mp4", headers={"Range": "bytes=0-9,20-30; evil"})
    assert env["upstream"][-1][1] == ""  # malformed Range is not forwarded
    p = c.get("/api/files/clips/c1.jpg")
    assert p.headers["content-type"] == "image/jpeg" and p.headers["cache-control"] == "no-store"
    assert all(u[2] == READ_TOKEN for u in env["upstream"])  # the READ token, never the write token


def test_range_is_dropped_on_static_files_but_kept_for_media(env):
    c, _ = as_user("viewer@example.com")
    many = "bytes=" + ",".join(f"{i * 4}-{i * 4 + 1}" for i in range(1000))
    css_file = sorted((ROOT / "static").rglob("*.css"))[0]
    css = css_file.read_bytes()
    r = c.get("/" + css_file.relative_to(ROOT / "static").as_posix(), headers={"Range": many})
    assert r.status_code == 200 and "content-range" not in r.headers and r.content == css
    assert c.get("/", headers={"Range": "bytes=0-5"}).status_code == 200
    r = c.get("/api/files/clips/c1.mp4", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206 and env["upstream"][-1][1] == "bytes=0-9"


class FakeResp:
    def __init__(self, status, headers=None, body=b"x"):
        self.status_code, self.headers, self.body, self.closed = status, headers or {}, body, False

    def iter_content(self, n):
        yield self.body

    def close(self):
        self.closed = True


def test_authorization_redirect_chain(monkeypatch):
    import importlib.util
    spec = importlib.util.spec_from_file_location("app_real", Path(A.__file__))
    real = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(real)
    seen = []
    home = "https://huggingface.co/datasets/Soverellp/clip-vault/resolve/main/"
    chain = {home + "clips/a.mp4": FakeResp(302, {"Location": "https://cdn-lfs.hf.co/abc?sig=1"}),
             "https://cdn-lfs.hf.co/abc?sig=1": FakeResp(307, {"Location": home + "clips/b.mp4"}),
             home + "clips/b.mp4": FakeResp(200, {"Content-Length": "1"})}

    def fake_get(url, headers):
        seen.append((urlparse(url).hostname, dict(headers)))
        return chain[url]
    monkeypatch.setattr(real, "_http_get", fake_get)
    status, hdrs, it, close = real.fetch_upstream({"token": READ_TOKEN, "dataset": "Soverellp/clip-vault"}, "clips/a.mp4", "bytes=0-9")
    assert status == 200 and b"".join(it) == b"x"
    assert [h for h, _ in seen] == ["huggingface.co", "cdn-lfs.hf.co", "huggingface.co"]
    assert seen[0][1]["Authorization"] == f"Bearer {READ_TOKEN}"
    assert "Authorization" not in seen[1][1] and seen[1][1]["Range"] == "bytes=0-9"
    assert seen[2][1]["Authorization"] == f"Bearer {READ_TOKEN}"
    chain2 = {home + "clips/a.mp4": FakeResp(302, {"Location": "http://evil.example/x"})}
    monkeypatch.setattr(real, "_http_get", lambda url, headers: chain2[url])
    with pytest.raises(RuntimeError):
        real.fetch_upstream({"token": READ_TOKEN, "dataset": "Soverellp/clip-vault"}, "clips/a.mp4", "")


# ---------------------------------------------------------------- rate limits (IP buckets)

def test_rate_limits_auth_is_tight_config_loose_api_wide():
    c = client()
    codes = [c.get("/api/auth/config").status_code for _ in range(common.LIMITS["config"][0] + 1)]
    assert codes[:-1] == [200] * common.LIMITS["config"][0] and codes[-1] == 429
    common._hits.clear()
    n = common.LIMITS["auth"][0]
    assert n < common.LIMITS["config"][0]
    codes = [c.post("/api/auth/google", json={"credential": "x"}).status_code for _ in range(n + 1)]
    assert codes[-1] == 429 and 429 not in codes[:-1]
    assert c.get("/api/auth/config").status_code == 200  # the auth bucket does not eat the config bucket
    common._hits.clear()
    c2, _ = as_user("viewer@example.com")
    common._hits.clear()
    codes = [c2.get("/api/me").status_code for _ in range(601)]
    assert codes[-1] == 429 and codes[0] == 200
    r = c2.get("/api/me")
    assert r.status_code == 429 and r.headers["retry-after"] and r.json()["error"] == "rate_limited"


def test_rate_limit_uses_last_xff_and_is_bounded(monkeypatch):
    c = client()
    for _ in range(common.LIMITS["config"][0] + 1):
        r = c.get("/api/auth/config", headers={"X-Forwarded-For": "1.1.1.1, 9.9.9.9"})
    assert r.status_code == 429
    assert c.get("/api/auth/config", headers={"X-Forwarded-For": "1.1.1.1, 8.8.8.8"}).status_code == 200
    monkeypatch.setattr(common, "RATE_MAX_KEYS", 50)
    for i in range(200):
        common._limited(f"10.0.0.{i}", "api")
    assert len(common._hits) <= 50


def test_rate_limiter_is_pruned_on_a_timer_and_bounded(monkeypatch):
    t = [1000.0]
    monkeypatch.setattr(common, "_now", lambda: t[0])
    common._last_prune = t[0]
    for i in range(500):
        common._limited(f"10.1.{i // 250}.{i % 250}", "api")
    assert len(common._hits) == 500
    t[0] += common.RATE_WINDOW - 1
    common._limited("late", "api")
    assert len(common._hits) == 501
    t[0] += 2
    common._limited("later", "api")
    assert set(k[0] for k in common._hits) == {"late", "later"}
    monkeypatch.setattr(common, "RATE_MAX_KEYS", 20)
    for i in range(1000):
        common._limited(f"f{i}", "api")
        assert len(common._hits) <= 20


# ---------------------------------------------------------------- config fails closed

@pytest.mark.parametrize("var", ["VAULT_READ_TOKEN", "GOOGLE_CLIENT_ID", "SESSION_SECRET"])
def test_unset_config_503(monkeypatch, var):
    monkeypatch.delenv(var)
    c = client()
    for p in ("/", "/api/me", "/api/auth/config", "/api/clips", "/api/files/clips/c1.mp4"):
        r = c.get(p)
        assert r.status_code == 503 and r.json()["error"] == "not_configured"
    assert c.post("/api/auth/google", json={"credential": "x" * 30}).status_code == 503


def test_short_session_secret_and_bad_dataset_503(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "x" * 31)
    assert client().get("/api/auth/config").status_code == 503
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    assert client().get("/api/auth/config").status_code == 200
    monkeypatch.setenv("VAULT_DATASET", "a/b/../c")
    assert client().get("/api/auth/config").status_code == 503


def test_security_headers_everywhere_and_exact_csp():
    c, _ = as_user("viewer@example.com")
    for p in ("/", "/nope-static.css", "/api/me", "/api/clips", "/api/files/clips/c1.mp4", "/nope", "/logout", "/api/auth/config"):
        r = c.get(p)
        h = r.headers
        assert h["content-security-policy"] == common.CSP
        assert h["x-content-type-options"] == "nosniff" and h["referrer-policy"] == "no-referrer"
        assert h["x-frame-options"] == "DENY" and h["cross-origin-resource-policy"] == "same-origin"
        assert "strict-transport-security" in h and "access-control-allow-origin" not in h
    csp = common.CSP
    for need in ("script-src 'self' https://accounts.google.com/gsi/client;", "frame-src https://accounts.google.com/gsi/;",
                 "connect-src 'self' https://accounts.google.com/gsi/;", "style-src 'self' https://accounts.google.com/gsi/style;",
                 "img-src 'self' data: blob: https://*.googleusercontent.com;", "media-src 'self' blob:;", "worker-src 'self' blob:;",
                 "frame-ancestors 'none';", "base-uri 'none';", "form-action 'self';", "object-src 'none'", "default-src 'none';"):
        assert need in csp, need
    assert "unsafe-inline" not in csp and "unsafe-eval" not in csp and "*" not in csp.replace("https://*.googleusercontent.com", "")
    for p in ("/api/me", "/api/clips", "/api/auth/config", "/logout"):
        assert c.get(p).headers["cache-control"] == "no-store"
    assert c.post("/logout").headers["cache-control"] == "no-store"


def test_static_page_has_no_inline_scripts_or_styles():
    html = client().get("/").text
    assert not re.search(r"<script(?![^>]*\bsrc=)", html) and "style=" not in html and not re.search(r"\son[a-z]+=", html)
    srcs = re.findall(r"<script[^>]*\bsrc=\"([^\"]+)\"", html)
    assert all(s.startswith("/") or s == "https://accounts.google.com/gsi/client" for s in srcs)


def test_no_secret_in_any_response_or_log(env, caplog):
    caplog.set_level(logging.DEBUG)
    c, hdr = as_user("root@example.com")
    blobs = []
    for r in (c.get("/api/auth/config"), c.get("/api/me"), c.get("/api/clips"), c.get("/api/clips?trash=1"), c.get("/api/audit"),
              c.get("/api/users"), c.get("/api/files/clips/c1.mp4"), c.get("/api/files/x"), c.post("/api/clips/c1/trash", json={}, headers=hdr),
              login("stranger@example.com")[1], login("viewer@example.com", kind="badnonce")[1], c.request("DELETE", "/api/clips/c1", json={"confirm": "no"}, headers=hdr)):
        blobs.append(r.text + str(dict(r.headers)))
    blob = "\n".join(blobs) + caplog.text
    for s in SECRETS:
        assert s not in blob
    for s in (READ_TOKEN, WRITE_TOKEN):
        assert s not in env["state"].files.get("index.json", b"").decode()
    assert not any(s.encode() in b"".join(env["state"].files.values()) for s in SECRETS)  # nor in the dataset or audit log


# ---------------------------------------------------------------- misc kept from before

def test_proxy_shape_logged_once_with_counts_only(capsys):
    A._proxy_logged = False
    c = client()
    c.get("/api/me", headers={"X-Forwarded-For": "203.0.113.7, 198.51.100.9", "X-Real-IP": "192.0.2.55"})
    c.get("/api/me", headers={"X-Forwarded-For": "203.0.113.8"})
    out = capsys.readouterr().out
    assert out.count("proxy-shape:") == 1 and "hops=2" in out and "x-real-ip=yes" in out
    assert not re.search(r"\d+\.\d+\.\d+\.\d+", out)
    A._proxy_logged = False
    client().get("/api/me")
    assert "hops=0 x-real-ip=no" in capsys.readouterr().out


def test_midstream_upstream_error_ends_quietly(monkeypatch, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    closed = []

    def boom():
        yield b"a" * 50
        raise ConnectionError("https://cdn-lfs.hf.co/secret-object?X-Amz-Signature=PRESIGNED")
    monkeypatch.setattr(A, "fetch_upstream", lambda cfg, path, rng: (200, {"Content-Length": "100"}, boom(), lambda: closed.append(1)))
    c, _ = as_user("viewer@example.com")
    r = c.get("/api/files/clips/c1.mp4")
    assert r.status_code == 200 and r.content == b"a" * 50
    blob = caplog.text + capfd.readouterr().err
    assert "PRESIGNED" not in blob and "cdn-lfs" not in blob and "Traceback" not in blob and closed


def test_quiet_generator_passes_chunks_and_swallows_errors():
    done = []
    assert list(A._quiet(iter([b"x", b"y"]), lambda: done.append(1))) == [b"x", b"y"] and done == [1]

    def bad():
        yield b"x"
        raise ValueError("secret-url")
    assert list(A._quiet(bad(), lambda: (_ for _ in ()).throw(RuntimeError("close broke")))) == [b"x"]


def test_midstream_abort_on_a_real_uvicorn_logs_one_line_no_traceback(monkeypatch, capfd):
    import uvicorn
    import requests as rq

    def boom():
        yield b"a" * 50
        raise ConnectionError("https://cdn-lfs.hf.co/secret-object?X-Amz-Signature=PRESIGNED")
    monkeypatch.setattr(A, "fetch_upstream", lambda cfg, path, rng: (200, {"Content-Length": "100"}, boom(), lambda: None))
    with socket.socket() as s0:
        s0.bind(("127.0.0.1", 0))
        port = s0.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(A.app, host="127.0.0.1", port=port, log_level="info", access_log=False))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    try:
        for _ in range(100):
            if srv.started:
                break
            time.sleep(0.05)
        assert srv.started
        now = time.time()
        tok = common.session_cookie_value(common._config(), "viewer@example.com", "s1", "V", None, now, now, now + 3600)
        with pytest.raises(rq.exceptions.RequestException):
            rq.get(f"http://127.0.0.1:{port}/api/files/clips/c1.mp4", cookies={"__Host-cv_session": tok}, timeout=10)
        time.sleep(0.3)
    finally:
        srv.should_exit = True
        th.join(timeout=5)
    err = capfd.readouterr().err
    assert "upstream stream ended early" in err
    assert "Traceback" not in err and "PRESIGNED" not in err and "cdn-lfs" not in err


# ---------------------------------------------------------------- supply chain files

def test_requirements_are_hash_locked_and_include_new_deps():
    txt = (ROOT / "requirements.txt").read_text()
    pins = dict(re.findall(r"^([A-Za-z0-9_.\-]+)==([^\s\\]+)", txt, re.M))
    assert {"fastapi", "starlette", "uvicorn", "requests", "pydantic", "anyio", "h11", "urllib3", "idna", "certifi",
            "google-auth", "huggingface-hub", "python-multipart"} <= set(pins)
    assert tuple(int(x) for x in pins["starlette"].split(".")[:3]) >= (0, 49, 1)
    blocks = re.split(r"\n(?=[A-Za-z0-9_.\-]+==)", txt)
    assert all("--hash=sha256:" in b for b in blocks if re.match(r"[A-Za-z0-9_.\-]+==", b))
    assert not re.search(r"^[A-Za-z0-9_.\-]+\s*(>=|~=|<|>|\*)", txt, re.M)
    rin = (ROOT / "requirements.in").read_text()
    assert all(re.search(rf"^{p}==", rin, re.M) for p in ("google-auth", "huggingface_hub", "python-multipart"))


def test_dockerfile_hashes_digest_and_ffmpeg_before_user():
    d = (ROOT / "Dockerfile").read_text()
    assert "--require-hashes" in d and re.search(r"^FROM python:3\.11-slim@sha256:[0-9a-f]{64}$", d, re.M)
    assert "apt-get install -y --no-install-recommends ffmpeg" in d and "rm -rf /var/lib/apt/lists/*" in d
    assert d.index("ffmpeg") < d.index("USER user")


def test_every_imported_local_module_is_uploaded_by_the_deploy():
    import deploy_space as D
    mods = {p.name for p in ROOT.glob("*.py")} - {"deploy_space.py"}
    assert mods <= set(D.ALLOW)


# ---------------------------------------------------------------- deploy_space.py

class _FakeApi:
    last = None

    def __init__(self, token=None):
        self.calls = []
        _FakeApi.last = self

    def create_repo(self, *a, **k): self.calls.append(("create_repo", a, k))
    def add_space_secret(self, space, key, value): self.calls.append(("secret", key, value))
    def add_space_variable(self, space, key, value): self.calls.append(("variable", key, value))
    def delete_space_variable(self, space, key): self.calls.append(("delete_variable", key))
    def delete_space_secret(self, space, key): self.calls.append(("delete_secret", key))

    def upload_folder(self, **k):
        from huggingface_hub.utils import filter_repo_objects
        root = Path(k["folder_path"])
        files = sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())
        keep = list(filter_repo_objects(files, allow_patterns=k.get("allow_patterns"), ignore_patterns=k.get("ignore_patterns")))
        self.calls.append(("upload", keep, k))


DEPLOY_ENV = {"HF_Token": "hf_" "FAKE_deploy", "VAULT_READ_TOKEN": "hf_" "FAKE_read", "VAULT_WRITE_TOKEN": "hf_" "FAKE_write",
              "SESSION_SECRET": "z" * 40, "ALLOWED_EMAILS": "a@example.com,b@example.com", "ADMIN_EMAILS": "boss@example.com",
              "GOOGLE_CLIENT_ID": "123-abc.apps.googleusercontent.com", "VAULT_DATASET": "me/vault"}


def _run_deploy(monkeypatch, tmp_path, extra_files, envvars=None):
    hub = pytest.importorskip("huggingface_hub")
    import deploy_space as D
    work = tmp_path / "space"
    (work / "static").mkdir(parents=True)
    (work / "tests").mkdir()
    for f in ("Dockerfile", "README.md", "app.py", "auth.py", "store.py", "admin.py", "common.py", "requirements.txt",
              "requirements.in", ".gitignore", "SETUP.md", "deploy_space.py"):
        (work / f).write_text("x")
    for f in ("app.js", "index.html", "style.css"):
        (work / "static" / f).write_text("x")
    (work / "tests" / "test_api.py").write_text("x")
    (work / "__pycache__").mkdir()
    (work / "__pycache__" / "app.cpython-311.pyc").write_text("x")
    for f in extra_files:
        (work / f).parent.mkdir(parents=True, exist_ok=True)
        (work / f).write_text("stray")
    monkeypatch.setattr(D, "HERE", work)
    monkeypatch.setattr(hub, "HfApi", _FakeApi)
    for k in DEPLOY_ENV:
        monkeypatch.delenv(k, raising=False)
    for k, v in (envvars or DEPLOY_ENV).items():
        monkeypatch.setenv(k, v)
    D.main()
    return _FakeApi.last.calls


def test_deploy_uploads_only_allowlisted_files(monkeypatch, tmp_path, capsys):
    stray = ["notes.txt", "x.log", "cookies.txt", "har.har", "shot.png", ".env", "static/cookies.txt", "static/debug.json",
             "static/secret.png", "tmp/x.js", "id_rsa", "token.json", "other.py"]
    calls = _run_deploy(monkeypatch, tmp_path, stray)
    up = [c for c in calls if c[0] == "upload"][0]
    assert sorted(up[1]) == sorted([".gitignore", "Dockerfile", "README.md", "app.py", "auth.py", "store.py", "admin.py", "common.py",
                                    "requirements.txt", "static/app.js", "static/index.html", "static/style.css"])
    assert not any(f in up[1] for f in stray)
    out = capsys.readouterr().out
    for leak in ("hf_" "FAKE", "a@example.com", "boss@", "me/vault", "123-abc"):
        assert leak not in out


def test_deploy_secrets_vs_public_variable(monkeypatch, tmp_path):
    calls = _run_deploy(monkeypatch, tmp_path, [])
    secrets_ = {c[1]: c[2] for c in calls if c[0] == "secret"}
    assert secrets_ == {"VAULT_READ_TOKEN": "hf_" "FAKE_read", "VAULT_WRITE_TOKEN": "hf_" "FAKE_write", "SESSION_SECRET": "z" * 40,
                        "VAULT_DATASET": "me/vault", "ALLOWED_EMAILS": "a@example.com,b@example.com", "ADMIN_EMAILS": "boss@example.com"}
    assert [c[1:] for c in calls if c[0] == "variable"] == [("GOOGLE_CLIENT_ID", "123-abc.apps.googleusercontent.com")]
    assert "hf_" "FAKE_deploy" not in str(calls)  # the broad deploy token is never copied anywhere
    assert ("delete_secret", "ALLOWED_HF_USERS") in calls
    assert {c[1] for c in calls if c[0] == "delete_variable"} >= {"ALLOWED_EMAILS", "ADMIN_EMAILS", "VAULT_DATASET"}


def test_deploy_without_write_token_is_read_only_and_viewers_default_to_admins(monkeypatch, tmp_path, capsys):
    e = {k: v for k, v in DEPLOY_ENV.items() if k not in ("VAULT_WRITE_TOKEN", "ALLOWED_EMAILS")}
    calls = _run_deploy(monkeypatch, tmp_path, [], e)
    secrets_ = {c[1]: c[2] for c in calls if c[0] == "secret"}
    assert "VAULT_WRITE_TOKEN" not in secrets_ and secrets_["ALLOWED_EMAILS"] == "boss@example.com"
    assert "read-only" in capsys.readouterr().out


@pytest.mark.parametrize("bad", [{"VAULT_WRITE_TOKEN": "hf_" "FAKE_read"}, {"VAULT_WRITE_TOKEN": "hf_" "FAKE_deploy"},
                                 {"GOOGLE_CLIENT_ID": "not-a-client-id"}, {"SESSION_SECRET": "short"}])
def test_deploy_refuses_dangerous_or_bad_config(monkeypatch, tmp_path, bad):
    with pytest.raises(SystemExit):
        _run_deploy(monkeypatch, tmp_path, [], {**DEPLOY_ENV, **bad})


@pytest.mark.parametrize("missing", ["GOOGLE_CLIENT_ID", "ADMIN_EMAILS", "VAULT_READ_TOKEN", "HF_Token"])
def test_deploy_requires(monkeypatch, tmp_path, missing):
    with pytest.raises(SystemExit):
        _run_deploy(monkeypatch, tmp_path, [], {k: v for k, v in DEPLOY_ENV.items() if k != missing})


def test_brand_pngs_are_served_publicly_as_images():
    """The FRAGBAG logo in the top bar (/assets/brand/*.png) is part of the public shell: served by the static mount, no session, image type."""
    for name in ("fragbag-96.png", "fragbag-192.png"):
        r = client().get("/assets/brand/" + name)
        assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert client().get("/assets/brand/nope.png").status_code == 404
