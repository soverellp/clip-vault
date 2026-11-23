# DATA-MODEL

> **TL;DR** Everything is files in the private dataset `Soverellp/clip-vault`. Base = `index.json` + `clips/`. Server mode (saved option) AS BUILT adds `users.json` (dataset root, not `_config/`), `trash/clips/` and `_audit/YYYY-MM.jsonl`; static admin mode (current plan, in progress) is expected to use the same layout so both modes can read one dataset (UNVERIFIED until `site/hfstatic` lands). Times are UTC ISO `...Z` (D15).

## Layout
```
index.json                  clip list (v1 fields; v2 may add fields) + streams[] (Library, D39)
streams/<id>/thumb.jpg      stream thumbnail, 640 px JPEG (Library, D39)
clips/<id>.mp4              the clip (id has "/" replaced by "_")
clips/<id>.jpg              poster (optional)
users.json                  [server mode, as built] site-managed users and roles
trash/clips/<id>.mp4|jpg    [as built] deleted clips, restorable for 30 days
_audit/YYYY-MM.jsonl        [as built] append-only audit lines, one JSON per line
```

## index.json (v1, VERIFIED from `build_hfvault.py`)
`{"clips":[ {...}, ... ]}`, sorted by `stream`, newest first.
| Field | Type | Meaning |
|---|---|---|
| `id` | string | clip id |
| `stream` | string | stream folder name |
| `title` | string | Hinglish title (Roman letters) |
| `hook` | string | hook text (may be empty) |
| `desc` | string | description |
| `dur` | number or null | seconds |
| `score` | number or null | pipeline score |
| `video` | string | `clips/<safe-id>.mp4` |
| `size` | integer | bytes |
| `poster` | string, optional | `clips/<safe-id>.jpg` |
| `post` | string, optional | full `post.md` text (YouTube/Instagram kit, credit, rights) |

Upload merges the remote `index.json` with the local one by `id` (local wins; remote-only clips kept). If the remote index cannot be read, the upload aborts instead of overwriting.

## index.json v2 (as built in `site/hfspace/store.py`; read on 2026-11-17)
Additional per-clip fields: `sha256`, `added_at`, `updated_at`, `trashed_at`, `purge_after` (all UTC `Z` or null), plus ffprobe values (duration, size, fps, codec, bitrate; null when missing) and `tags`. The top-level index also carries `updated_at`. v2 readers accept v1 files (missing fields use defaults). The exact complete field list: read `normalize` in `store.py`; this note does not repeat it.

## Compatibility
- Old v1 indexes still load. `build_hfvault.py` writes the v2 index (sha256, added_at, ffprobe fields); with `--upload` clips already in the remote index keep their trash state and admin edits, and trashed clips are not re-uploaded.
- Server proxy path allow-list: `index.json`, `clips/<name>.(mp4|jpg)` and (admins) `trash/clips/<name>.(mp4|jpg)`, name `[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}`.

## users.json (server mode, as built)
Site-managed users and roles other than root admins. Per user: `email` (lowercase), `role` (`admin` or `viewer`), `added_at`, `added_by`. Root admins come from `ADMIN_EMAILS` (a Space secret) and cannot be changed here. Not used by static mode (no per-person users there, D25).

## trash/ (as built)
A trashed clip's files move to `trash/clips/` in ONE commit with its index entry (`trashed_at`, `purge_after` = 30 days later). Expired trash is purged lazily (next admin list, at startup, or Empty trash).

## _audit/YYYY-MM.jsonl (as built)
One JSON object per line: `at` (UTC), `actor_email`, `action` (edit, upload, trash, restore, purge/delete, user_add, ...), `clip_id`, `detail`. Written in the SAME commit as the change. Tokens and cookies are never logged (code policy, not proven by a test run against the real Hub).

## Library fields (D39, added 2026-11-18)
Top-level `streams: [{id, title, channel, date, clipped_at, lang, lang_name, url, thumb, clip_count}]` (`date` = YouTube upload date, `clipped_at` = newest clip's render time, D40) and per-clip `stream, group, variant, reaction, reaction_note, kind, tier, rank, why, hook, clipped_at, lang`, all optional. The full table, value sets, ownership rules and the "pass unknown fields through" requirement are in [API-CONTRACT.md](API-CONTRACT.md) section 0. Source of truth in the repo: `streams/<s>/docs/vault_meta.json` (keyed by clip folder id) and `streams/<s>/thumb.jpg`; the dataset copy is written by `vault_sync.py` (new clips) and `vault_sync.py --meta-only` (existing clips, streams list, thumbnails). `_audit/` gets one line per meta commit: `action: "meta"`, `clip_id: ""`, `detail: {clips, streams, thumbs, fields}`.
Facts (2026-11-18): the live index has 46 clips, 3 streams (the 18 older clips belong to TWO streams: 15 of `2026-11-16_gta-v-marathon-stream-gamerfleet` and 3 of `2026-11-14_this-is-not-a-game`), 14 ranked moments, reactions 4 strong / 10 mild / 8 none / 24 unrated (counted per clip, both variants).

## Teaser flag (D47, added 2026-11-23)
Per-clip optional boolean `teaser` (default false; absent = false), next to `group` and `variant`; source `vault_meta.json`, written by `vault_sync.py` (new clips) and `--meta-only` (existing clips). Anything but JSON `true` reads as no teaser in the page. A moment (`stream|group`) holds up to one clip per (variant, teaser) slot: Clean / With streamer x without / with teaser. UI rule: left group "Without teaser | With teaser", right group "With streamer | Clean"; default Clean + With teaser; no teaser clip in the moment = left group hidden and default Clean; missing combination = button disabled; fallback keeps the teaser choice and falls back the version, then drops the teaser. Choice kept per moment (`state.variants`).
