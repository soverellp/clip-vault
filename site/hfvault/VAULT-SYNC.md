# vault_sync: finished clips -> the private clip vault

GitHub `main` keeps the clips (via `finalise.py`). `vault_sync.py` ALSO copies them to the PRIVATE Hugging Face dataset
`Soverellp/clip-vault` (Option A). One command, no wrapper prefix, credentials built in.

## Usage
```
python3 site/hfvault/vault_sync.py [--stream SUBSTR] [--limit N]         # DRY RUN (default): table + the exact --yes command
python3 site/hfvault/vault_sync.py [--stream SUBSTR] [--limit N] --yes   # upload
```
`finalise.py --yes` prints the dry-run command as its last line. Flags: `--stream` (folder name contains), `--limit N` (at most N
clips; the rest show as DEFERRED), `--hf-dataset OWNER/NAME` (default `Soverellp/clip-vault`), `--dataset USER/NAME` (the KAGGLE
credential dataset, default `arvr7plays/kagglegpu1`), `--from-dir DIR` and `--repo DIR` (tests). Exit codes: 0 ok, 2 nothing to do
(also for a dry run), 1 error (message on stderr).

Table columns: id, stream, MB, action, reason. Actions: NEW (not in the remote index), CHANGED (sha256 differs, remote file
missing, or remote size differs: video and poster are re-uploaded), FIX (no video upload: backfill a missing sha256 of a v1 entry,
upload a missing poster), UNCHANGED (hidden from the table, counted in the summary), SKIP (tombstoned, or in the site's trash).

## `--meta-only`: Library metadata (D39)
```
python3 site/hfvault/vault_sync.py --meta-only [--stream SUBSTR]          # DRY RUN: clips, streams and thumbnails that would change
python3 site/hfvault/vault_sync.py --meta-only [--stream SUBSTR] --yes    # ONE commit (parent revision), audit line, read-back verify
python3 site/hfvault/check_index.py                                       # fetch index.json with the READ token, print counts only
```
Reads `streams/<s>/docs/vault_meta.json` (`{"version":1,"stream":"<id>","clips":{"<clip id>":{group, variant, reaction, reaction_note, kind, tier, rank, why, hook}}}`),
`streams/index.json` `streams[]` (+ `docs/info.json` upload date) and `streams/<id>/thumb.jpg`, and merges them into the EXISTING remote `index.json`:
contract fields always from `vault_meta.json`, except `stream` and `hook` (filled only when empty, admins edit them); `streams[]` merged by id
(remote-only streams kept, `clip_count` recounted without trashed clips); thumbnails uploaded when missing or of another size; other top-level keys and
unknown per-clip fields kept. Never touches title, desc, post, tags, trash state, sha256, size or any clip file; clips not yet in the vault are listed
and left alone; an empty remote index is refused. One commit = thumbnails + `index.json` + one audit line (`action: "meta"`, `clip_id: ""`); a conflict
re-plans against a fresh snapshot (4 retries); then the index is read back at the new revision and every planned field, the untouched entries, `streams[]`
and the thumbnail sizes are compared (`verify FAILED` = exit 1). Exit 2 = nothing to do. `--limit` does not apply. A normal upload writes the same fields
into NEW entries and prints the hint to run `--meta-only` once for `streams[]` and the thumbnail. Validate the file first:
`python3 .claude/skills/clips/scripts/vault_meta.py check`.

## What it does
- Local clips: `streams/index.json`; the video file preference, index v2 fields and ffprobe fields come from
  `build_hfvault.py` (`PREFER`, `enrich_item`, `safe_id`), so both tools write identical entries. sha256 is computed per file.
- Remote state is read at ONE revision: `index.json` (v1 or v2 `{clips:[...]}`), `_config/tombstones.json`, and the file listing
  (names and sizes). Only "file not found" means "first upload"; any other read error aborts before anything is written.
- Existing clips: the site's edits are never overwritten (title, hook, desc, post, tags, stream, trash state). On CHANGED only the
  file-derived fields change: sha256, size, dur, width, height, fps, codec, bitrate, updated_at.
- Upload: at most 3 videos per commit; each commit carries the files, ONE `index.json` write and the audit lines (one per clip,
  `{at, actor:"vault_sync", actor_email:"vault_sync", action:"sync", clip_id, detail}`) appended to `_audit/YYYY-MM.jsonl` in the same
  commit. `parent_commit` = the revision read, so a concurrent site edit gives a conflict. Every attempt re-reads the dataset and
  re-plans (a clip tombstoned or already uploaded in the meantime is dropped). Network errors, 408/429/5xx and conflicts are
  retried 4 times (backoff 2, 5, 15, 30 s); other errors stop the run (batches already committed stay; run again to continue).
- Never deletes anything. After the last commit it lists the dataset and compares sizes of every uploaded file (verify).

## Credential flow
1. `VAULT_WRITE_TOKEN` in the environment (else `HF_Token` / `HF_TOKEN`, only with `--allow-account-token`): used as is, NO Kaggle download.
2. Else `with_vault_creds.load_credentials()` downloads `arvr7plays/kagglegpu1` to a private `/dev/shm` temp folder, parses it in memory
   (PDF via `pdftotext`), deletes the folder (also on Ctrl-C, SIGTERM, SIGHUP). Needs `KAGGLE_USERNAME` + `KAGGLE_APITOKEN` and the
   Kaggle CLI (`~/kvenv/bin/kaggle`). Preferred file keys: `VAULT_WRITE_TOKEN` or `Clip_vault_Write` (dataset-scoped). Fallback
   `HF_Tokem` / `HF_Token` is REFUSED unless `--allow-account-token` is passed (then it prints `WARNING: account-wide token allowed ...`).
3. The token goes only into `HfApi(token=...)` / `hf_hub_download(token=...)` in this process. Never into `os.environ`, argv, a file or
   a child process (the only children are `ffprobe`, and the Kaggle CLI which gets the Kaggle token as the existing `fetch` always did).
4. A write token equal to the read token (`VAULT_READ_TOKEN`) is refused. A token that is not `hf_...` is refused.
5. stdout and stderr are wrapped by a masker for the whole run (raw, base64, URL-quoted, JSON, hex forms of every token and every
   secret-named env value), and every error message goes through it. The CLI `with_vault_creds.py -- python3 SCRIPT` now accepts only four allow-listed scripts (D34).

## Tombstone contract (`_config/tombstones.json`)
```
{"version": 1, "ids": [{"id": "<clip id>", "deleted_at": "2026-11-18T10:00:00Z", "sha256": "<hex or null>"}]}
```
- Meaning: this clip was deleted FOREVER (not just trashed); sync must never upload it again.
- Written by EVERY writer that removes a clip permanently, in the SAME commit as the index/file deletion and the audit line:
  `site/hfspace/store.py` does it for "delete forever", "empty trash" and the automatic trash purge (`Changes.tombstones`, merged by
  `store.merge_tombstones`). The static-mode client (`site/hfstatic`) must do the same: read the file at the parent revision
  (missing = start with `{"version":1,"ids":[]}`), append `{id, deleted_at, sha256}`, drop an older entry with the same id, keep
  the newest 5000, add it as a `CommitOperationAdd`/commit op in the delete commit. If the existing file is unreadable, fail the
  delete instead of overwriting it.
- Ids are the safe id (the stem of `clips/<id>.mp4`). Readers tolerate plain strings in `ids`. `vault_sync` skips tombstoned ids before
  hashing; an unreadable file aborts the sync. Removing an entry by hand (admin) lets the clip be synced again.

## Failure modes
| Message (stderr) | Cause and fix |
|---|---|
| `no write token found` | no env token and the file has none of the key names: add `VAULT_WRITE_TOKEN` to the credential file |
| `equals the read token` | create a separate write token |
| `cannot read dataset ...` | wrong token scope or dataset name: check `--hf-dataset` and the token |
| `cannot read remote index.json (...)` / `tombstones ... unreadable` | network, offline or corrupt file: nothing was written; retry |
| `gave up after 5 attempts` | network or conflicts: earlier commits stay; run again |
| `verify FAILED` | a file is missing or has another size in the dataset: run again (it repairs as CHANGED) |
| `KAGGLE_USERNAME and KAGGLE_APITOKEN must be set` | set them in the environment (or provide `VAULT_WRITE_TOKEN`) |

## Tests
`site/hfvault/tests/test_vault_sync.py` (fake `HfApi`/`hf_hub_download`, fake tokens only), `test_with_vault_creds.py`
(`load_credentials`), `site/hfspace/tests/test_store.py` and `test_clips.py` (tombstones).

## UNTESTED (proven only against fakes)
- Real Hub behaviour: `create_commit` with LFS uploads of real mp4 files, the `parent_commit` conflict status code (assumed 409/412),
  `list_repo_tree` sizes for LFS files, `dataset_info(timeout=...)`, the exact exception classes of a missing file on the real Hub.
- The real Kaggle download and the real credential file layout (PDF text); the dataset-scoped key names `VAULT_WRITE_TOKEN` /
  `Clip_vault_Write` are not yet in the real file.
- Whether the static client (`site/hfstatic`) and the Space show/accept `actor` in audit lines (the Space's audit view reads `actor_email`).
- `finalise.py` printing the last line (a one-line print; its dry run and `--yes` against a real git remote were not re-run).
