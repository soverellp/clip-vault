"""The REAL VaultStore against a fake huggingface_hub: ops, parent_commit, conflict mapping, token use, error hygiene."""
import json
import types

import pytest

huggingface_hub = pytest.importorskip("huggingface_hub")
from huggingface_hub.errors import EntryNotFoundError, HfHubHTTPError  # noqa: E402

import store  # noqa: E402

from conftest import REAL_VAULTSTORE as REAL  # noqa: E402

READ, WRITE = "hf_" "FAKE_read_token_0000", "hf_" "FAKE_write_token_1111"


def http_error(status):
    e = HfHubHTTPError.__new__(HfHubHTTPError)
    Exception.__init__(e, f"{status} for https://huggingface.co/api/datasets/x?token={WRITE}")
    e.response = types.SimpleNamespace(status_code=status)
    return e


class FakeHub:
    def __init__(self):
        self.commits, self.tokens, self.downloads = [], [], []
        self.files = {"_audit/2026-11.jsonl": b'{"a":1}\n'}
        self.raise_on_commit = None
        self.head_sha = "a" * 40


@pytest.fixture
def hub(monkeypatch, tmp_path):
    h = FakeHub()

    class Api:
        def dataset_info(self, repo, token=None, timeout=None):
            h.tokens.append(("info", token))
            if token is None:
                raise AssertionError
            return types.SimpleNamespace(sha=h.head_sha)

        def create_commit(self, repo, ops, commit_message, repo_type, token, parent_commit):
            h.tokens.append(("commit", token))
            if h.raise_on_commit:
                raise h.raise_on_commit
            h.commits.append({"ops": ops, "parent": parent_commit, "repo_type": repo_type, "message": commit_message})

    def download(repo, path, repo_type=None, revision=None, token=None):
        h.tokens.append(("download", token))
        h.downloads.append((path, revision))
        if path not in h.files:
            raise EntryNotFoundError("nope")
        p = tmp_path / path.replace("/", "_")
        p.write_bytes(h.files[path])
        return str(p)
    monkeypatch.setattr(huggingface_hub, "HfApi", Api)
    monkeypatch.setattr(huggingface_hub, "hf_hub_download", download)
    return h


def make_changes(tmp_path):
    ch = store.Changes()
    ch.index = {"version": 2, "clips": []}
    ch.users = {"version": 1, "users": []}
    f = tmp_path / "v.mp4"
    f.write_bytes(b"x")
    ch.add_files = [("clips/n.mp4", str(f))]
    ch.copies = [("clips/a.mp4", "trash/clips/a.mp4")]
    ch.deletes = ["clips/a.mp4"]
    ch.audit = [{"at": "t", "actor_email": "a@example.com", "action": "x", "clip_id": None, "detail": {}}]
    ch.message = "m"
    return ch


def test_commit_is_one_atomic_commit_with_parent_and_audit_read_at_the_same_revision(hub, tmp_path):
    s = REAL("o/d", READ, WRITE)
    s.commit("b" * 40, make_changes(tmp_path), "2026-11")
    assert len(hub.commits) == 1 and hub.commits[0]["parent"] == "b" * 40 and hub.commits[0]["repo_type"] == "dataset"
    kinds = [(type(o).__name__, getattr(o, "path_in_repo", None)) for o in hub.commits[0]["ops"]]
    assert ("CommitOperationAdd", "index.json") in kinds and ("CommitOperationAdd", "users.json") in kinds
    assert ("CommitOperationAdd", "clips/n.mp4") in kinds and ("CommitOperationCopy", "trash/clips/a.mp4") in kinds
    assert ("CommitOperationDelete", "clips/a.mp4") in kinds and ("CommitOperationAdd", "_audit/2026-11.jsonl") in kinds
    assert ("_audit/2026-11.jsonl", "b" * 40) in hub.downloads  # the month file is read at the parent revision
    audit = [o for o in hub.commits[0]["ops"] if getattr(o, "path_in_repo", "") == "_audit/2026-11.jsonl"][0]
    text = audit.path_or_fileobj.decode() if isinstance(audit.path_or_fileobj, bytes) else audit.path_or_fileobj.read().decode()
    assert text.startswith('{"a":1}\n') and text.count("\n") == 2  # appended, never replaced
    big = [o for o in hub.commits[0]["ops"] if getattr(o, "path_in_repo", "") == "clips/n.mp4"][0]
    assert isinstance(big.path_or_fileobj, str)  # a path on disk, not bytes in RAM


def test_write_token_is_used_only_for_commits(hub, tmp_path):
    s = REAL("o/d", READ, WRITE)
    s.head()
    s.read_json("index.json", "c" * 40)
    s.commit("b" * 40, make_changes(tmp_path), "2026-11")
    assert {t for k, t in hub.tokens if k != "commit"} == {READ} and {t for k, t in hub.tokens if k == "commit"} == {WRITE}


@pytest.mark.parametrize("status", [409, 412])
def test_parent_mismatch_maps_to_conflict(hub, tmp_path, status):
    hub.raise_on_commit = http_error(status)
    with pytest.raises(store.Conflict):
        REAL("o/d", READ, WRITE).commit("b" * 40, make_changes(tmp_path), "2026-11")


@pytest.mark.parametrize("exc", [http_error(500), http_error(403), RuntimeError(f"boom {WRITE}"), ConnectionError(WRITE)])
def test_other_failures_become_a_fixed_store_error_without_upstream_text(hub, tmp_path, exc):
    hub.raise_on_commit = exc
    with pytest.raises(store.StoreError) as e:
        REAL("o/d", READ, WRITE).commit("b" * 40, make_changes(tmp_path), "2026-11")
    assert WRITE not in str(e.value) and WRITE not in repr(e.value) and e.value.__cause__ is None and e.value.__suppress_context__


def test_snapshot_reads_index_and_users_at_one_revision_and_missing_files_are_empty(hub):
    hub.files["index.json"] = json.dumps({"clips": [{"id": "x/y", "video": "clips/x_y.mp4"}]}).encode()
    snap = REAL("o/d", READ, WRITE).snapshot()
    assert snap.rev == "a" * 40 and snap.index["clips"][0]["id"] == "x_y" and snap.users["users"] == []
    assert {rev for _, rev in hub.downloads} == {"a" * 40}


def test_read_errors_are_fixed_store_errors(hub, monkeypatch):
    def bad(*a, **k):
        raise RuntimeError(f"secret {READ}")
    monkeypatch.setattr(huggingface_hub, "hf_hub_download", bad)
    with pytest.raises(store.StoreError) as e:
        REAL("o/d", READ, WRITE).read_json("index.json", "c" * 40)
    assert READ not in str(e.value)


def test_audit_tail_reads_this_and_last_month(hub):
    from datetime import datetime, timezone
    s = REAL("o/d", READ, WRITE)
    now = datetime.now(timezone.utc)
    hub.files[f"_audit/{now.strftime('%Y-%m')}.jsonl"] = b'{"action":"b","at":"2","actor_email":"x"}\n'
    prev = (now.replace(day=1) - __import__("datetime").timedelta(days=1)).strftime("%Y-%m")
    hub.files[f"_audit/{prev}.jsonl"] = b'{"action":"a","at":"1","actor_email":"x"}\n'
    assert [e["action"] for e in s.audit_tail("a" * 40)] == ["b", "a"]


def test_can_write_follows_the_token():
    assert REAL("o/d", READ, WRITE).can_write and not REAL("o/d", READ, "").can_write


def test_normalizers_are_total():
    for raw in (None, 5, "x", [], {}, {"clips": [None, 1, {}, {"id": ""}, {"id": "a", "video": 5, "tags": "no", "dur": "x", "trashed_at": "garbage"}]}):
        out = store.normalize_index(raw)
        assert out["version"] == 2 and isinstance(out["clips"], list)
    c = store.normalize_index({"clips": [{"id": "a", "video": 5, "tags": "no", "dur": "x", "trashed_at": "garbage", "title": 5}]})["clips"][0]
    assert c["tags"] == [] and c["dur"] is None and c["trashed_at"] is None and c["title"] == "a" and c["video"] == "clips/a.mp4"
    for raw in (None, 5, {"users": "x"}, {"users": [None]}):
        assert store.normalize_users(raw)["users"] == []


# ---------------------------------------------------------------- tombstones (_config/tombstones.json)

def _tomb_op(hub):
    ops = [o for o in hub.commits[-1]["ops"] if getattr(o, "path_in_repo", "") == "_config/tombstones.json"]
    return json.loads(ops[0].path_or_fileobj) if ops else None


def test_commit_with_tombstones_creates_the_file_in_the_same_commit_when_missing(hub, tmp_path):
    ch = store.Changes()
    ch.tombstones = [{"id": "c1", "deleted_at": "2026-11-18T10:00:00Z", "sha256": "abc"}]
    REAL("o/d", READ, WRITE).commit("b" * 40, ch, "2026-11")
    assert len(hub.commits) == 1
    assert _tomb_op(hub) == {"version": 1, "ids": [{"id": "c1", "deleted_at": "2026-11-18T10:00:00Z", "sha256": "abc"}]}
    assert ("_config/tombstones.json", "b" * 40) in hub.downloads  # existing list is read at the parent revision


def test_commit_appends_to_an_existing_tombstone_file_and_dedupes(hub):
    hub.files["_config/tombstones.json"] = json.dumps({"version": 1, "ids": [{"id": "old", "deleted_at": "t", "sha256": None}, {"id": "c1", "deleted_at": "t0", "sha256": "x"}]}).encode()
    ch = store.Changes()
    ch.tombstones = [{"id": "c1", "deleted_at": "t1", "sha256": "y"}, {"id": "new", "deleted_at": "t1", "sha256": None}]
    REAL("o/d", READ, WRITE).commit("b" * 40, ch, "2026-11")
    ids = _tomb_op(hub)["ids"]
    assert [t["id"] for t in ids] == ["old", "c1", "new"] and ids[1]["sha256"] == "y"


def test_unreadable_tombstone_file_fails_the_commit_instead_of_overwriting(hub, monkeypatch):
    hub.files["_config/tombstones.json"] = b"{not json"
    ch = store.Changes()
    ch.tombstones = [{"id": "c1", "deleted_at": "t", "sha256": None}]
    with pytest.raises(store.StoreError):
        REAL("o/d", READ, WRITE).commit("b" * 40, ch, "2026-11")
    assert hub.commits == []


def test_merge_tombstones_is_bounded_total_and_ignores_junk():
    new = [{"id": f"i{n}", "deleted_at": "t", "sha256": None} for n in range(store.MAX_TOMBSTONES + 10)]
    out = store.merge_tombstones({"ids": ["strings-ok", 5, {"no": "id"}]}, new)
    assert len(out["ids"]) == store.MAX_TOMBSTONES and out["ids"][-1]["id"] == f"i{store.MAX_TOMBSTONES + 9}" and out["version"] == 1
    assert store.merge_tombstones("junk", [])["ids"] == [] and store.merge_tombstones(None, [])["version"] == 1


def test_purge_changes_records_a_tombstone_with_the_sha():
    idx = store.normalize_index({"clips": [{"id": "a", "video": "clips/a.mp4", "sha256": "s1", "trashed_at": "2026-11-01T00:00:00Z"}]})
    ch = store.purge_changes(idx, idx["clips"], "x@example.com")
    assert [(t["id"], t["sha256"]) for t in ch.tombstones] == [("a", "s1")] and ch.tombstones[0]["deleted_at"]
