"""vault_sync.py against a FAKE huggingface_hub (HfApi + hf_hub_download) and FAKE credentials. Nothing touches a network."""
import hashlib, importlib.util, json, os, subprocess, sys, types
from pathlib import Path
import pytest

pytest.importorskip("huggingface_hub")
import huggingface_hub  # noqa: E402
from huggingface_hub.errors import EntryNotFoundError, HfHubHTTPError, LocalEntryNotFoundError, RepositoryNotFoundError  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
WRITE = "hf_" "FAKEWRITETOKENscopedAAAAAAAAAAAA"
ACCT = "hf_" "FAKEACCOUNTWIDEtokenBBBBBBBBBBBB"
READ = "hf_" "FAKEREADTOKENccccccccccccccccccc"
KAGGLE = "FAKEKAGGLEAPITOKENvalue1234567890"
ALL = (WRITE, ACCT, READ, KAGGLE)


def http_error(status, leak=WRITE, cls=HfHubHTTPError):
    e = cls.__new__(cls)
    Exception.__init__(e, f"{status} for https://huggingface.co/api/datasets/x (Authorization: Bearer {leak})")
    e.response = types.SimpleNamespace(status_code=status)
    return e


class Remote:
    """The fake dataset."""
    def __init__(self):
        self.files, self.n, self.commits, self.hook = {}, 1, [], None
        self.fail_commits = []        # exceptions raised by the next create_commit calls, in order
        self.read_errors = {}         # path -> exception for hf_hub_download
        self.tokens = []
        self.head_error = None

    @property
    def rev(self): return f"rev{self.n}"

    def put_index(self, clips, version=2):
        self.files["index.json"] = json.dumps({"version": version, "clips": clips} if version else {"clips": clips}).encode()


@pytest.fixture
def remote(monkeypatch, tmp_path):
    r = Remote()
    dl = tmp_path / "dl"; dl.mkdir()

    class Api:
        def __init__(self, token=None): r.tokens.append(("init", token))
        def dataset_info(self, repo, timeout=None):
            if r.head_error: raise r.head_error
            return types.SimpleNamespace(sha=r.rev)
        def list_repo_tree(self, repo, repo_type=None, recursive=False, revision=None):
            return [types.SimpleNamespace(path=p, size=len(b)) for p, b in sorted(r.files.items())]
        def create_commit(self, repo, ops, commit_message, repo_type, parent_commit):
            if r.hook: h, r.hook = r.hook, None; h(r)
            if r.fail_commits:
                e = r.fail_commits.pop(0)
                if e: raise e
            if parent_commit != r.rev: raise http_error(412)
            files = dict(r.files)
            for o in ops:
                src = o.path_or_fileobj
                files[o.path_in_repo] = Path(src).read_bytes() if isinstance(src, str) else bytes(src)
            r.files = files; r.n += 1
            r.commits.append({"message": commit_message, "paths": sorted(o.path_in_repo for o in ops), "parent": parent_commit})

    def download(repo, path, repo_type=None, revision=None, token=None):
        r.tokens.append(("dl", token))
        if path in r.read_errors: raise r.read_errors[path]
        if path not in r.files: raise EntryNotFoundError("nope")
        p = dl / path.replace("/", "_"); p.write_bytes(r.files[path]); return str(p)
    monkeypatch.setattr(huggingface_hub, "HfApi", Api)
    monkeypatch.setattr(huggingface_hub, "hf_hub_download", download)
    return r


@pytest.fixture
def vs(monkeypatch):
    spec = importlib.util.spec_from_file_location("vault_sync_under_test", HERE / "vault_sync.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    monkeypatch.setattr(m, "sleep", lambda s: None)
    return m


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in ("VAULT_WRITE_TOKEN", "HF_Token", "HF_TOKEN", "VAULT_READ_TOKEN", "KAGGLE_APITOKEN", "KAGGLE_API_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("VAULT_WRITE_TOKEN", WRITE)


def make_repo(tmp_path, specs):
    """specs: [(stream, id, bytes, with_poster)] -> repo root with streams/index.json"""
    repo = tmp_path / "repo"; clips = []
    for stream, cid, data, poster in specs:
        d = repo / "streams" / stream / "clips" / cid; d.mkdir(parents=True, exist_ok=True)
        (d / "youtube-shorts.mp4").write_bytes(data)
        if poster: (d / "poster.jpg").write_bytes(b"JPG" + cid.encode())
        (d / "post.md").write_text(f"post of {cid}")
        clips.append({"stream": stream, "id": cid, "title": f"Local title {cid}", "hook": "local hook", "description": "local desc", "duration": 45.0, "score": 8})
    (repo / "streams").mkdir(parents=True, exist_ok=True)
    (repo / "streams" / "index.json").write_text(json.dumps({"clips": clips}))
    return repo


def run(vs, repo, *args, capsys=None):
    rc = vs.main(["--repo", str(repo), *args])
    out = capsys.readouterr() if capsys else None
    return rc, out


def sha(b): return hashlib.sha256(b).hexdigest()


def remote_index(r): return json.loads(r.files["index.json"])


# ------------------------------------------------------------------ dry run, upload, idempotence

def test_dry_run_writes_nothing_and_prints_table_and_exact_yes_command(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("2026-11-a", "c1", b"V1" * 50, True), ("2026-11-a", "c2", b"V2" * 50, False)])
    rc, out = run(vs, repo, "--stream", "2026-11-a", capsys=capsys)
    assert rc == 0 and remote.commits == [] and "index.json" not in remote.files
    assert "NEW" in out.out and "c1" in out.out and "MB" in out.out and "first upload" in out.out
    assert "python3 site/hfvault/vault_sync.py --stream 2026-11-a --yes" in out.out


def test_yes_uploads_new_clips_with_poster_post_index_v2_and_audit_in_batches(vs, remote, tmp_path, capsys):
    specs = [("2026-11-a", f"c{i}", f"video{i}".encode() * 20, i % 2 == 0) for i in range(7)]
    repo = make_repo(tmp_path, specs)
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 0, out.err
    assert [len([p for p in c["paths"] if p.endswith(".mp4")]) for c in remote.commits] == [3, 3, 1]  # at most 3 videos per commit
    idx = remote_index(remote)
    assert idx["version"] == 2 and sorted(c["id"] for c in idx["clips"]) == [f"c{i}" for i in range(7)]
    c0 = next(c for c in idx["clips"] if c["id"] == "c0")
    assert c0["sha256"] == sha(specs[0][2]) and c0["size"] == len(specs[0][2]) and c0["title"] == "Local title c0"
    assert c0["post"] == "post of c0" and c0["poster"] == "clips/c0.jpg" and c0["video"] == "clips/c0.mp4"
    assert {"tags", "added_at", "updated_at", "width", "height", "fps", "codec", "bitrate", "trashed_at", "purge_after", "dur"} <= set(c0)
    assert remote.files["clips/c0.mp4"] == specs[0][2] and "clips/c1.jpg" not in remote.files
    audit = [json.loads(l) for l in remote.files[next(k for k in remote.files if k.startswith("_audit/"))].decode().splitlines()]
    assert len(audit) == 7 and all(a["actor"] == "vault_sync" and a["action"] == "sync" and a["clip_id"] for a in audit)
    assert all(any(p.startswith("_audit/") and p.endswith(".jsonl") for p in c["paths"]) and "index.json" in c["paths"] for c in remote.commits)
    assert "verify ok: 7" in out.out


def test_second_run_uploads_nothing_and_exits_2(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, True)])
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 0
    n = len(remote.commits)
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 2 and len(remote.commits) == n and "nothing to do" in out.out
    assert run(vs, repo, capsys=capsys)[0] == 2  # dry run too


def test_never_deletes_and_leaves_other_remote_clips_alone(vs, remote, tmp_path, capsys):
    remote.put_index([{"id": "other", "stream": "zzz", "title": "Other", "video": "clips/other.mp4", "sha256": "x"}])
    remote.files["clips/other.mp4"] = b"keep"
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, False)])
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 0
    assert remote.files["clips/other.mp4"] == b"keep" and {c["id"] for c in remote_index(remote)["clips"]} == {"other", "c1"}


# ------------------------------------------------------------------ changed clips keep admin edits

def test_changed_sha_reuploads_files_but_keeps_admin_edited_metadata(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("s", "c1", b"OLD" * 50, True)])
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 0
    idx = remote_index(remote)  # the admin edits the clip in the site
    e = idx["clips"][0]; e.update(title="Admin title", hook="Admin hook", desc="Admin desc", post="Admin post", tags=["fun"], stream="renamed")
    remote.files["index.json"] = json.dumps(idx).encode()
    new = b"NEWER" * 80
    (repo / "streams/s/clips/c1/youtube-shorts.mp4").write_bytes(new)
    rc, out = run(vs, repo, capsys=capsys)
    assert rc == 0 and "CHANGED" in out.out and "sha256 differs" in out.out
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 0
    e = remote_index(remote)["clips"][0]
    assert remote.files["clips/c1.mp4"] == new and e["sha256"] == sha(new) and e["size"] == len(new)
    assert (e["title"], e["hook"], e["desc"], e["post"], e["tags"], e["stream"]) == ("Admin title", "Admin hook", "Admin desc", "Admin post", ["fun"], "renamed")
    assert run(vs, repo, capsys=capsys)[0] == 2


def test_missing_remote_video_file_or_poster_is_repaired(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, True)])
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 0
    del remote.files["clips/c1.jpg"]
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 0 and "poster missing" in out.out and "clips/c1.jpg" in remote.files
    del remote.files["clips/c1.mp4"]
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 0 and "video file missing" in out.out and remote.files["clips/c1.mp4"] == b"A" * 100


# ------------------------------------------------------------------ skips

def test_tombstoned_and_trashed_ids_are_skipped(vs, remote, tmp_path, capsys):
    remote.put_index([{"id": "t1", "stream": "s", "title": "In trash", "video": "clips/t1.mp4", "sha256": "x", "trashed_at": "2026-11-12T10:00:00Z"}])
    remote.files["_config/tombstones.json"] = json.dumps({"version": 1, "ids": [{"id": "gone", "deleted_at": "t", "sha256": "x"}]}).encode()
    repo = make_repo(tmp_path, [("s", "gone", b"G" * 100, True), ("s", "t1", b"T" * 100, True), ("s", "ok", b"O" * 100, False)])
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 0 and "tombstoned" in out.out and "trash" in out.out
    assert "clips/ok.mp4" in remote.files and "clips/gone.mp4" not in remote.files and "clips/t1.mp4" not in remote.files
    assert {c["id"] for c in remote_index(remote)["clips"]} == {"t1", "ok"}


def test_only_skips_means_nothing_to_do(vs, remote, tmp_path, capsys):
    remote.files["_config/tombstones.json"] = json.dumps({"version": 1, "ids": [{"id": "gone"}]}).encode()
    remote.put_index([])
    repo = make_repo(tmp_path, [("s", "gone", b"G" * 100, False)])
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 2 and remote.commits == []


def test_tombstone_added_while_uploading_is_respected_on_the_retry(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, False)])
    def race(r):  # an admin deletes c1 forever between our snapshot and our commit
        r.files["_config/tombstones.json"] = json.dumps({"version": 1, "ids": [{"id": "c1"}]}).encode(); r.n += 1
    remote.hook = race
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 2 and remote.commits == [] and "clips/c1.mp4" not in remote.files


# ------------------------------------------------------------------ remote index handling

def test_v1_remote_index_loads_and_is_backfilled(vs, remote, tmp_path, capsys):
    data = b"A" * 100
    remote.put_index([{"id": "c1", "stream": "s", "title": "V1 title", "video": "clips/c1.mp4", "size": len(data)}], version=None)
    remote.files["clips/c1.mp4"] = data
    repo = make_repo(tmp_path, [("s", "c1", data, False)])
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    e = remote_index(remote)["clips"][0]
    assert rc == 0 and "sha256 backfill" in out.out and e["sha256"] == sha(data) and e["title"] == "V1 title" and remote_index(remote)["version"] == 2
    assert [c["paths"] for c in remote.commits][0].count("clips/c1.mp4") == 0  # no video re-upload
    assert run(vs, repo, capsys=capsys)[0] == 2


@pytest.mark.parametrize("exc", [http_error(404, cls=RepositoryNotFoundError), LocalEntryNotFoundError("offline"), ConnectionError("boom " + WRITE), http_error(500), http_error(401)])
def test_only_not_found_means_first_upload_everything_else_aborts(vs, remote, tmp_path, capsys, exc):
    remote.read_errors["index.json"] = exc
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, False)])
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 1 and remote.commits == [] and "index.json" in out.err and WRITE not in out.err + out.out


def test_corrupt_remote_index_and_corrupt_tombstones_abort(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, False)])
    remote.files["index.json"] = b"{not json"
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 1
    remote.put_index([]); remote.files["_config/tombstones.json"] = b"garbage"
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 1 and "tombstones" in out.err and remote.commits == []


def test_missing_repo_or_head_error_aborts_with_masked_text(vs, remote, tmp_path, capsys):
    remote.head_error = http_error(404)
    rc, out = run(vs, make_repo(tmp_path, [("s", "c1", b"A", False)]), "--yes", capsys=capsys)
    assert rc == 1 and WRITE not in out.err + out.out


# ------------------------------------------------------------------ filters, retries, failures

def test_stream_filter_and_limit(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("2026-11-a", "a1", b"A" * 10, False), ("2026-11-b", "b1", b"B" * 10, False), ("2026-11-b", "b2", b"C" * 10, False)])
    rc, out = run(vs, repo, "--stream", "11-b", "--limit", "1", "--yes", capsys=capsys)
    assert rc == 0 and [c["id"] for c in remote_index(remote)["clips"]] == ["b1"] and "over --limit" in out.out
    assert run(vs, repo, "--stream", "nomatch", capsys=capsys)[0] == 2
    rc, out = run(vs, repo, "--limit", "1", capsys=capsys)
    assert "--limit 1" in out.out


def test_network_errors_are_retried_with_backoff_then_succeed(vs, remote, tmp_path, capsys):
    sleeps = []; vs.sleep = sleeps.append
    remote.fail_commits = [ConnectionError("reset " + WRITE), http_error(503), http_error(429), ConnectionError("x")]  # 4 retries
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, False)])
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 0 and len(remote.commits) == 1 and len(sleeps) == 4 and sleeps == sorted(sleeps)
    assert WRITE not in out.out + out.err


def test_gives_up_after_the_retries_with_exit_1(vs, remote, tmp_path, capsys):
    remote.fail_commits = [ConnectionError("down")] * 10
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, False)])
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 1 and remote.commits == [] and "gave up after 5 attempts" in out.err and len(remote.fail_commits) == 5


def test_permanent_http_error_is_not_retried(vs, remote, tmp_path, capsys):
    remote.fail_commits = [http_error(403)] * 3
    rc, out = run(vs, make_repo(tmp_path, [("s", "c1", b"A", False)]), "--yes", capsys=capsys)
    assert rc == 1 and len(remote.fail_commits) == 2 and WRITE not in out.err


def test_conflict_is_replanned_against_the_new_head(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, False)])
    def race(r):
        r.put_index([{"id": "newcomer", "stream": "s", "title": "Added by the site", "video": "clips/newcomer.mp4", "sha256": "x"}]); r.n += 1
    remote.hook = race
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 0 and "retry 1/4" in out.out and {c["id"] for c in remote_index(remote)["clips"]} == {"newcomer", "c1"}


def test_retry_after_an_unseen_success_does_not_duplicate(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, False)])
    real_commit = None
    def land_then_fail(r):  # the commit lands, but the client sees a timeout
        r.files = dict(r.files); r.fail_commits = []
    orig = vs.Hub.commit
    state = {"n": 0}
    def flaky(self, rev, adds, texts, message):
        orig(self, rev, adds, texts, message)
        state["n"] += 1
        if state["n"] == 1: raise vs.Transient("TimeoutError")
    vs.Hub.commit = flaky
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 2 and len(remote.commits) == 1 and "already in the vault" in out.out
    assert len([c for c in remote_index(remote)["clips"]]) == 1


def test_verify_failure_is_exit_1(vs, remote, tmp_path, capsys, monkeypatch):
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, False)])
    monkeypatch.setattr(vs, "verify", lambda hub, done: ["clips/c1.mp4"])
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 1 and "verify FAILED" in out.err


# ------------------------------------------------------------------ credentials and masking

def test_refuses_read_token_equal_to_write_token(vs, remote, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("VAULT_READ_TOKEN", WRITE)
    rc, out = run(vs, make_repo(tmp_path, [("s", "c1", b"A", False)]), "--yes", capsys=capsys)
    assert rc == 1 and "equals the read token" in out.err and remote.commits == [] and WRITE not in out.err + out.out


def test_account_wide_fallback_prints_the_warning_and_scoped_token_does_not(vs, remote, tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("VAULT_WRITE_TOKEN"); monkeypatch.setenv("HF_Token", ACCT)
    repo = make_repo(tmp_path, [("s", "c1", b"A", False)])
    rc, out = run(vs, repo, capsys=capsys)  # refused without the explicit flag
    assert rc == 1 and "refusing the account-wide HF_Token" in out.err and "--allow-account-token" in out.err
    assert remote.commits == [] and ("init", ACCT) not in remote.tokens and ACCT not in out.out + out.err
    rc, out = run(vs, repo, "--allow-account-token", capsys=capsys)
    assert "WARNING: account-wide token allowed by --allow-account-token" in out.err and ACCT not in out.out + out.err
    monkeypatch.delenv("HF_Token"); monkeypatch.setenv("VAULT_WRITE_TOKEN", WRITE)
    assert "account-wide" not in run(vs, repo, capsys=capsys)[1].err


def test_credential_file_prefers_scoped_key_and_never_downloads_when_env_has_a_token(vs, remote, tmp_path, monkeypatch, capsys):
    wc = vs.wc
    monkeypatch.setattr(wc, "fetch", lambda ds: (_ for _ in ()).throw(AssertionError("kaggle must not be called")))
    repo = make_repo(tmp_path, [("s", "c1", b"A", False)])
    run(vs, repo, capsys=capsys)  # env has VAULT_WRITE_TOKEN
    monkeypatch.delenv("VAULT_WRITE_TOKEN")
    cd = tmp_path / "creds"; cd.mkdir()
    (cd / "c.txt").write_text(f"HF_Tokem={ACCT}\nClip_vault_Write={WRITE}\nClip_vault_HFToken={READ}\n")
    rc, out = run(vs, repo, "--from-dir", str(cd), "--yes", capsys=capsys)
    assert rc == 0 and ("init", WRITE) in remote.tokens and ("init", ACCT) not in remote.tokens and "account-wide" not in out.err
    assert not any(t in out.out + out.err for t in (WRITE, ACCT, READ))


def test_credential_file_with_only_hf_token_refused_without_flag_warns_with_it(vs, remote, tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("VAULT_WRITE_TOKEN")
    cd = tmp_path / "creds"; cd.mkdir(); (cd / "c.txt").write_text(f"HF_Tokem={ACCT}\n")
    repo = make_repo(tmp_path, [("s", "c1", b"A", False)])
    rc, out = run(vs, repo, "--from-dir", str(cd), capsys=capsys)
    assert rc == 1 and "refusing the account-wide HF_Token" in out.err and ("init", ACCT) not in remote.tokens
    rc, out = run(vs, repo, "--from-dir", str(cd), "--allow-account-token", capsys=capsys)
    assert "account-wide token" in out.err and ("init", ACCT) in remote.tokens and ACCT not in out.out + out.err


def test_no_token_anywhere_is_a_clean_error(vs, remote, tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("VAULT_WRITE_TOKEN")
    cd = tmp_path / "creds"; cd.mkdir(); (cd / "c.txt").write_text("nothing=here\n")
    rc, out = run(vs, make_repo(tmp_path, [("s", "c1", b"A", False)]), "--from-dir", str(cd), capsys=capsys)
    assert rc == 1 and "no write token" in out.err


def test_masking_of_exception_text_and_library_output(vs, remote, tmp_path, monkeypatch, capsys):
    import base64, urllib.parse
    class Boom(Exception): pass
    def bad_sizes(self, rev): raise Boom(f"token {WRITE} b64 {base64.b64encode(WRITE.encode()).decode()} q {urllib.parse.quote(WRITE)}")
    monkeypatch.setattr(vs.Hub, "sizes", bad_sizes)
    rc, out = run(vs, make_repo(tmp_path, [("s", "c1", b"A", False)]), "--yes", capsys=capsys)
    blob = out.out + out.err
    assert rc == 1 and WRITE not in blob and base64.b64encode(WRITE.encode()).decode() not in blob
    # even a stray print() from a library is masked
    monkeypatch.setattr(vs.Hub, "sizes", lambda self, rev: (print("leak", WRITE), {})[1])
    out = run(vs, make_repo(tmp_path, [("s", "c1", b"A", False)]), capsys=capsys)[1]
    assert WRITE not in out.out + out.err and "***" in out.out


def test_token_goes_only_to_hfapi_never_env_argv_or_child_processes(vs, remote, tmp_path, monkeypatch, capsys):
    calls = []
    real_run, real_popen = subprocess.run, subprocess.Popen
    def spy_run(cmd, *a, **k):
        calls.append((cmd, k.get("env"))); return real_run(cmd, *a, **k)
    def spy_popen(cmd, *a, **k):
        calls.append((cmd, k.get("env"))); return real_popen(cmd, *a, **k)
    monkeypatch.setattr(subprocess, "run", spy_run); monkeypatch.setattr(subprocess, "Popen", spy_popen)
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, True)])
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 0
    assert os.environ.get("VAULT_WRITE_TOKEN") == WRITE  # the test's own setting is untouched
    assert {k: v for k, v in os.environ.items() if v == WRITE and k != "VAULT_WRITE_TOKEN"} == {}
    for cmd, env in calls:
        assert WRITE not in " ".join(map(str, cmd))
        assert env is None or WRITE not in env.values()
    assert WRITE not in str(sys.argv) and ("init", WRITE) in remote.tokens and any(c[0][0] == "ffprobe" for c in calls)


def test_token_value_not_in_any_file_written_by_the_run(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, True)])
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 0
    for p in tmp_path.rglob("*"):
        if p.is_file(): assert WRITE.encode() not in p.read_bytes(), p
    assert all(WRITE.encode() not in v for v in remote.files.values())


def test_bad_arguments_and_non_hf_token(vs, remote, tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path, [("s", "c1", b"A", False)])
    assert run(vs, repo, "--limit", "0", capsys=capsys)[0] == 1
    monkeypatch.setenv("VAULT_WRITE_TOKEN", "notatoken-1234567890")
    rc, out = run(vs, repo, capsys=capsys)
    assert rc == 1 and "hf_" in out.err and "notatoken-1234567890" not in out.err


def test_masked_stream_restored_after_main(vs, remote, tmp_path, capsys):
    before = sys.stdout, sys.stderr
    run(vs, make_repo(tmp_path, [("s", "c1", b"A", False)]), capsys=capsys)
    assert (sys.stdout, sys.stderr) == before


# ------------------------------------------------------------------ --meta-only and vault_meta.json (D39)

def add_meta(repo, stream, clips, with_thumb=True, streams_info=True):
    """vault_meta.json for `stream` (clips: {id: dict}), a streams[] entry in streams/index.json and a fake thumb.jpg."""
    docs = repo / "streams" / stream / "docs"; docs.mkdir(parents=True, exist_ok=True)
    (docs / "vault_meta.json").write_text(json.dumps({"version": 1, "stream": stream, "clips": clips}))
    if with_thumb: (repo / "streams" / stream / "thumb.jpg").write_bytes(b"\xff\xd8THUMB-" + stream.encode())
    if streams_info:
        ip = repo / "streams/index.json"; d = json.loads(ip.read_text())
        d.setdefault("streams", []).append({"slug": stream, "title": f"Title of {stream}", "channel": "Chan", "url": "https://youtu.be/x", "date_added": "2026-11-18"})
        ip.write_text(json.dumps(d))
        (docs / "info.json").write_text(json.dumps({"upload_date": "20261111"}))


META = {"c1": {"group": "g1", "variant": "with-girl", "reaction": "strong", "reaction_note": "leans in", "tier": "A", "rank": 1, "why": "big moment", "hook": "Meta hook"},
        "c2": {"group": "g1", "variant": "clean", "reaction": "none", "reaction_note": "", "tier": "C", "rank": 2, "why": "game only"}}


def seed_remote(vs, remote, tmp_path, capsys, specs=None):
    repo = make_repo(tmp_path, specs or [("s1", "c1", b"A" * 100, True), ("s1", "c2", b"B" * 100, False)])
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 0   # the clips are in the vault WITHOUT any Library fields
    return repo


def test_new_entries_carry_the_meta_fields_and_the_hint_to_run_meta_only(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("s1", "c1", b"A" * 100, True), ("s1", "c2", b"B" * 100, False)])
    add_meta(repo, "s1", META)
    rc, out = run(vs, repo, "--yes", capsys=capsys)
    assert rc == 0 and "--meta-only" in out.out
    e = {c["id"]: c for c in remote_index(remote)["clips"]}
    assert e["c1"]["group"] == "g1" and e["c1"]["variant"] == "with-girl" and e["c1"]["reaction"] == "strong" and e["c1"]["kind"] == "reaction"
    assert e["c1"]["tier"] == "A" and e["c1"]["rank"] == 1 and e["c1"]["why"] == "big moment" and e["c1"]["stream"] == "s1"
    assert e["c1"]["hook"] == "local hook"          # the index hook was already filled: fill-only
    assert e["c2"]["kind"] == "game" and e["c2"]["reaction"] == "none"


def test_meta_only_dry_run_writes_nothing_and_lists_fields_streams_thumbs(vs, remote, tmp_path, capsys):
    repo = seed_remote(vs, remote, tmp_path, capsys)
    add_meta(repo, "s1", META)
    n, files = len(remote.commits), dict(remote.files)
    rc, out = run(vs, repo, "--meta-only", capsys=capsys)
    assert rc == 0 and len(remote.commits) == n and remote.files == files
    assert "group" in out.out and "stream s1  NEW" in out.out and "streams/s1/thumb.jpg" in out.out and "DRY RUN" in out.out
    assert "--meta-only --yes" in out.out and "summary: 2 clip entries, 1 stream entries, 1 thumbnails" in out.out


def test_meta_only_yes_merges_in_one_commit_keeps_admin_edits_and_verifies(vs, remote, tmp_path, capsys):
    repo = seed_remote(vs, remote, tmp_path, capsys)
    idx = remote_index(remote)  # the admin edits c1 in the site and trashes c2
    for c in idx["clips"]:
        if c["id"] == "c1": c.update(title="ADMIN TITLE", desc="ADMIN DESC", tags=["x"], hook="ADMIN HOOK", post="ADMIN POST")
        if c["id"] == "c2": c.update(trashed_at="2026-11-18T00:00:00Z", purge_after="2026-12-18T00:00:00Z", title="T2")
    remote.files["index.json"] = json.dumps(idx).encode()
    vid_before = {p: remote.files[p] for p in remote.files if p.startswith("clips/")}
    add_meta(repo, "s1", META)
    n = len(remote.commits)
    rc, out = run(vs, repo, "--meta-only", "--yes", capsys=capsys)
    assert rc == 0, out.err
    assert len(remote.commits) == n + 1 and remote.commits[-1]["parent"] == f"rev{remote.n - 1}"
    assert sorted(remote.commits[-1]["paths"]) == sorted(["index.json", "streams/s1/thumb.jpg", next(p for p in remote.files if p.startswith("_audit/"))])
    new = remote_index(remote); e = {c["id"]: c for c in new["clips"]}
    assert e["c1"]["title"] == "ADMIN TITLE" and e["c1"]["desc"] == "ADMIN DESC" and e["c1"]["tags"] == ["x"] and e["c1"]["hook"] == "ADMIN HOOK" and e["c1"]["post"] == "ADMIN POST"
    assert e["c1"]["reaction"] == "strong" and e["c1"]["rank"] == 1 and e["c1"]["group"] == "g1"
    assert e["c2"]["trashed_at"] == "2026-11-18T00:00:00Z" and e["c2"]["title"] == "T2" and e["c2"]["variant"] == "clean"
    assert new["streams"] == [{"id": "s1", "title": "Title of s1", "channel": "Chan", "date": "2026-11-11", "url": "https://youtu.be/x", "lang": "unknown", "lang_name": "Unknown",
                               "thumb": "streams/s1/thumb.jpg", "clip_count": 1}]  # c2 is in the trash: not counted
    assert remote.files["streams/s1/thumb.jpg"].startswith(b"\xff\xd8THUMB")
    assert {p: remote.files[p] for p in vid_before} == vid_before            # no clip file touched
    audit = [json.loads(l) for l in remote.files[next(p for p in remote.files if p.startswith("_audit/"))].decode().splitlines()]
    assert audit[-1]["action"] == "meta" and audit[-1]["actor"] == "vault_sync" and audit[-1]["detail"]["thumbs"] == ["streams/s1/thumb.jpg"]
    assert "verify ok" in out.out
    assert run(vs, repo, "--meta-only", "--yes", capsys=capsys)[0] == 2        # idempotent: nothing left to do
    assert len(remote.commits) == n + 1


def test_meta_only_leaves_clips_not_in_the_vault_and_other_entries_alone(vs, remote, tmp_path, capsys):
    remote.put_index([{"id": "other", "stream": "zzz", "title": "Other", "video": "clips/other.mp4", "sha256": "x", "weird": 1}])
    remote.files["clips/other.mp4"] = b"keep"
    repo = make_repo(tmp_path, [("s1", "c1", b"A" * 100, True)])   # c1 is NOT in the vault
    add_meta(repo, "s1", {"c1": META["c1"]})
    rc, out = run(vs, repo, "--meta-only", "--yes", capsys=capsys)
    assert rc == 2 and "not in the vault yet" in out.out and remote.commits == []
    assert {c["id"] for c in remote_index(remote)["clips"]} == {"other"}


def test_meta_only_keeps_unknown_remote_fields_and_remote_only_streams(vs, remote, tmp_path, capsys):
    repo = seed_remote(vs, remote, tmp_path, capsys)
    idx = remote_index(remote)
    idx["streams"] = [{"id": "old", "title": "Old", "channel": "c", "date": "2026-01-01", "url": "u", "clip_count": 3, "thumb": "streams/old/thumb.jpg"}]
    idx["future_top_level"] = {"a": 1}
    idx["clips"][0]["posted"] = {"yt": True}
    remote.files["index.json"] = json.dumps(idx).encode()
    add_meta(repo, "s1", META)
    assert run(vs, repo, "--meta-only", "--yes", capsys=capsys)[0] == 0
    new = remote_index(remote)
    assert [s["id"] for s in new["streams"]] == ["s1", "old"] and new["future_top_level"] == {"a": 1}
    assert next(s for s in new["streams"] if s["id"] == "old")["clip_count"] == 0   # recounted from the real clips
    assert any(c.get("posted") == {"yt": True} for c in new["clips"])


def test_meta_only_conflict_is_replanned_and_other_commit_survives(vs, remote, tmp_path, capsys):
    repo = seed_remote(vs, remote, tmp_path, capsys)
    add_meta(repo, "s1", META)
    def site_edit(r):   # an admin edit lands between our read and our commit
        idx = json.loads(r.files["index.json"]); idx["clips"][0]["title"] = "EDITED MEANWHILE"
        r.files = {**r.files, "index.json": json.dumps(idx).encode()}; r.n += 1
    remote.hook = site_edit
    assert run(vs, repo, "--meta-only", "--yes", capsys=capsys)[0] == 0
    e = {c["id"]: c for c in remote_index(remote)["clips"]}
    assert e["c1"]["title"] == "EDITED MEANWHILE" and e["c1"]["rank"] == 1


def test_meta_only_verify_failure_is_exit_1(vs, remote, tmp_path, capsys, monkeypatch):
    repo = seed_remote(vs, remote, tmp_path, capsys)
    add_meta(repo, "s1", META)
    monkeypatch.setattr(vs, "verify_meta", lambda *a: ["c1"])
    rc, out = run(vs, repo, "--meta-only", "--yes", capsys=capsys)
    assert rc == 1 and "verify FAILED" in out.err


def test_meta_only_refuses_empty_remote_bad_meta_and_limit(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("s1", "c1", b"A" * 100, False)])
    add_meta(repo, "s1", {"c1": META["c1"]})
    rc, out = run(vs, repo, "--meta-only", capsys=capsys)
    assert rc == 1 and "run a normal sync first" in out.err
    remote.put_index([{"id": "c1", "stream": "s1", "title": "T", "video": "clips/c1.mp4", "sha256": "x"}])
    assert run(vs, repo, "--meta-only", "--limit", "2", capsys=capsys)[0] == 1
    (repo / "streams/s1/docs/vault_meta.json").write_text(json.dumps({"clips": {"c1": {"reaction": "huge"}}}))
    rc, out = run(vs, repo, "--meta-only", capsys=capsys)
    assert rc == 1 and "reaction" in out.err


def test_meta_only_without_any_meta_file_changes_nothing(vs, remote, tmp_path, capsys):
    repo = seed_remote(vs, remote, tmp_path, capsys)
    rc, out = run(vs, repo, "--meta-only", "--yes", capsys=capsys)
    assert rc == 2 and "nothing to do" in out.out


def test_meta_only_token_stays_masked_and_account_token_flag_still_needed(vs, remote, tmp_path, monkeypatch, capsys):
    repo = seed_remote(vs, remote, tmp_path, capsys)
    add_meta(repo, "s1", META)
    monkeypatch.delenv("VAULT_WRITE_TOKEN"); monkeypatch.setenv("HF_Token", ACCT)
    rc, out = run(vs, repo, "--meta-only", "--yes", capsys=capsys)
    assert rc == 1 and "--allow-account-token" in out.err and ACCT not in out.out + out.err
    rc, out = run(vs, repo, "--meta-only", "--yes", "--allow-account-token", capsys=capsys)
    assert rc == 0 and ACCT not in out.out + out.err


# ------------------------------------------------------------------ --refresh-text

def rewrite_kit(repo, stream, cid, suffix="NEW"):
    d = repo / "streams" / stream / "clips" / cid
    (d / "post.md").write_text(f"post {suffix} {cid}")
    (d / "clip.json").write_text(json.dumps({"post": {"youtube": {"tags": [f"tag-{suffix}"]}}}))
    ip = repo / "streams/index.json"; j = json.loads(ip.read_text())
    for c in j["clips"]:
        if c["id"] == cid: c.update(title=f"Title {suffix} {cid}", hook=f"Hook {suffix}", description=f"Desc {suffix}")
    ip.write_text(json.dumps(j))


def test_refresh_text_only_matching_entries_text_fields_change_and_audit_has_names_only(vs, remote, tmp_path, capsys):
    repo = seed_remote(vs, remote, tmp_path, capsys, [("s1", "c1", b"A" * 100, True), ("s2", "c2", b"B" * 100, False)])
    idx = remote_index(remote); idx["clips"][0]["rank"] = 7; idx["clips"][0]["group"] = "g"
    remote.files["index.json"] = json.dumps(idx).encode()
    rewrite_kit(repo, "s1", "c1"); rewrite_kit(repo, "s2", "c2")
    before = remote_index(remote); n = len(remote.commits); files = dict(remote.files)
    rc, out = run(vs, repo, "--refresh-text", "--stream", "s1", "--yes", capsys=capsys)
    assert rc == 0, out.err
    assert len(remote.commits) == n + 1
    after = {c["id"]: c for c in remote_index(remote)["clips"]}; b = {c["id"]: c for c in before["clips"]}
    assert (after["c1"]["title"], after["c1"]["hook"], after["c1"]["desc"], after["c1"]["post"], after["c1"]["tags"]) == ("Title NEW c1", "Hook NEW", "Desc NEW", "post NEW c1", ["tag-NEW"])
    assert {k: v for k, v in after["c1"].items() if k not in bh_text} == {k: v for k, v in b["c1"].items() if k not in bh_text}
    assert after["c2"] == b["c2"]
    assert all(remote.files[k] == v for k, v in files.items() if not k.startswith("_audit") and k != "index.json")
    audit = "".join(v.decode() for k, v in remote.files.items() if k.startswith("_audit"))
    line = json.loads([x for x in audit.splitlines() if "refresh-text" in x][0])
    assert line["action"] == "refresh-text" and line["clip_id"] == "c1" and "Title NEW" not in audit and "post NEW" not in audit
    assert set(line["detail"]["fields"]) == {"title", "hook", "desc", "post", "tags"}


bh_text = ("title", "hook", "desc", "post", "tags")


def test_refresh_text_dry_run_writes_nothing_and_lists_field_names(vs, remote, tmp_path, capsys):
    repo = seed_remote(vs, remote, tmp_path, capsys)
    rewrite_kit(repo, "s1", "c1")
    n, snap = len(remote.commits), dict(remote.files)
    rc, out = run(vs, repo, "--refresh-text", capsys=capsys)
    assert rc == 0 and len(remote.commits) == n and remote.files == snap
    assert "c1" in out.out and "title" in out.out and "DRY RUN" in out.out and "Title NEW" not in out.out


def test_refresh_text_ids_filter_and_identical_text_is_no_change(vs, remote, tmp_path, capsys):
    repo = seed_remote(vs, remote, tmp_path, capsys)
    rewrite_kit(repo, "s1", "c1"); rewrite_kit(repo, "s1", "c2")
    assert run(vs, repo, "--refresh-text", "--ids", "c2", "--yes", capsys=capsys)[0] == 0
    e = {c["id"]: c for c in remote_index(remote)["clips"]}
    assert e["c2"]["title"] == "Title NEW c2" and e["c1"]["title"] == "Local title c1"
    n = len(remote.commits)
    rc, out = run(vs, repo, "--refresh-text", "--ids", "c2", "--yes", capsys=capsys)
    assert rc == 2 and len(remote.commits) == n


def test_refresh_text_skips_tombstoned_and_trashed(vs, remote, tmp_path, capsys):
    repo = seed_remote(vs, remote, tmp_path, capsys)
    idx = remote_index(remote)
    for c in idx["clips"]:
        if c["id"] == "c1": c["trashed_at"] = "2026-11-18T00:00:00Z"
    remote.files["index.json"] = json.dumps(idx).encode()
    remote.files["_config/tombstones.json"] = json.dumps({"ids": ["c2"]}).encode()
    rewrite_kit(repo, "s1", "c1"); rewrite_kit(repo, "s1", "c2")
    n = len(remote.commits)
    rc, out = run(vs, repo, "--refresh-text", "--yes", capsys=capsys)
    assert rc == 2 and len(remote.commits) == n
    assert {c["id"]: c["title"] for c in remote_index(remote)["clips"]}["c1"] == "Local title c1"


def test_refresh_text_combines_with_a_changed_video_upload(vs, remote, tmp_path, capsys):
    repo = seed_remote(vs, remote, tmp_path, capsys)
    rewrite_kit(repo, "s1", "c1")
    (repo / "streams/s1/clips/c1/youtube-shorts.mp4").write_bytes(b"NEWV" * 60)
    rc, out = run(vs, repo, "--refresh-text", "--yes", capsys=capsys)
    assert rc == 0, out.err
    e = {c["id"]: c for c in remote_index(remote)["clips"]}["c1"]
    assert remote.files["clips/c1.mp4"] == b"NEWV" * 60 and e["title"] == "Title NEW c1" and e["sha256"] == sha(b"NEWV" * 60)


def test_refresh_text_bad_flag_combinations(vs, remote, tmp_path, capsys):
    repo = make_repo(tmp_path, [("s1", "c1", b"A" * 100, True)])
    assert run(vs, repo, "--ids", "c1", capsys=capsys)[0] == 1
    assert run(vs, repo, "--refresh-text", "--meta-only", capsys=capsys)[0] == 1


# ------------------------------------------------------------------ shortlist file (_config/shortlist.json) belongs to the site

SHORTLIST_BYTES = b'{"version":1,"ids":[{"id":"s|g1","at":"2026-11-20T10:00:00Z"},{"id":"stale-id","at":"2026-11-20T10:01:00Z"}]}'


def test_sync_never_touches_or_deletes_the_shortlist_file(vs, remote, tmp_path, capsys):
    remote.files["_config/shortlist.json"] = SHORTLIST_BYTES
    remote.put_index([{"id": "other", "stream": "zzz", "title": "Other", "video": "clips/other.mp4", "sha256": "x"}])
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, True)])
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 0
    assert remote.files["_config/shortlist.json"] == SHORTLIST_BYTES
    assert remote.commits and all("_config/shortlist.json" not in c["paths"] for c in remote.commits)


def test_meta_only_and_refresh_text_leave_the_shortlist_alone(vs, remote, tmp_path, capsys):
    remote.files["_config/shortlist.json"] = SHORTLIST_BYTES
    repo = make_repo(tmp_path, [("s", "c1", b"A" * 100, False)])
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 0
    run(vs, repo, "--meta-only", "--yes", capsys=capsys)
    run(vs, repo, "--refresh-text", "--yes", capsys=capsys)
    assert remote.files["_config/shortlist.json"] == SHORTLIST_BYTES
    assert all("_config/shortlist.json" not in c["paths"] for c in remote.commits)


def test_commit_refuses_any_write_under_the_site_owned_config_folder(vs, remote):
    hub = vs.Hub.__new__(vs.Hub)
    with pytest.raises(vs.SyncError, match="site-owned"):
        hub.commit("rev1", [], [("_config/shortlist.json", "{}")], "x")
    with pytest.raises(vs.SyncError, match="site-owned"):
        hub.commit("rev1", [("_config/tombstones.json", "/nope")], [], "x")
    assert vs.SHORTLIST == "_config/shortlist.json" and remote.commits == []


def test_a_stale_shortlist_id_does_not_make_the_sync_skip_or_resurrect_a_clip(vs, remote, tmp_path, capsys):
    remote.files["_config/shortlist.json"] = SHORTLIST_BYTES
    repo = make_repo(tmp_path, [("s", "stale-id", b"B" * 80, False)])
    assert run(vs, repo, "--yes", capsys=capsys)[0] == 0 and any(c["id"] == "stale-id" for c in remote_index(remote)["clips"])
