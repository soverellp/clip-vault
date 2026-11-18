# API-CONTRACT

> **TL;DR** The STATIC mode (current plan, D25) has no API of its own: the page talks to the Hugging Face Hub directly (section 1). The table in section 2 is the SERVER mode API (saved option, D27) "as built", summarised on 2026-11-17 from `site/hfspace/SETUP.md`, `site/hfspace/tests/README.md` and a read of the route decorators in `app.py` and `admin.py`. Response bodies were not exhaustively checked: confirm against the code before relying on a field. NOT security-reviewed (D30); never run against real Google or a real Space.

## 0. The Library data contract in `index.json` (D39; written by `vault_sync.py`, read by the Library UI)
All fields are OPTIONAL: old clients ignore them and old entries simply lack them. A reader must treat a missing field as "unknown" (`reaction` missing = `unrated`, `kind` missing = `game`, `streams` missing = group by `clip.stream`).

**Top level** gets `streams` (array, newest `date` first):
| Field | Type | Meaning |
|---|---|---|
| `id` | string | the stream folder name, e.g. `2026-11-18_kai-cenat-playing-every-gta-until-i-beat-it`; equals `clip.stream` |
| `title` | string | the YouTube title (may contain emoji) |
| `channel` | string | channel name |
| `date` | `YYYY-MM-DD` | the stream's upload date (`docs/info.json` `upload_date`; else the date it was added) |
| `url` | string | the YouTube link |
| `thumb` | string, optional | `streams/<id>/thumb.jpg` in the dataset (640 px wide JPEG, the stream's YouTube thumbnail); fetch it like a poster with the read token |
| `clip_count` | int | clips of this stream in the index that are NOT in the trash (recomputed on every `--meta-only`) |

**Every clip entry** gets (all from `streams/<s>/docs/vault_meta.json`, keyed by the clip folder id):
| Field | Values | Meaning |
|---|---|---|
| `stream` | string | the stream id (same as `streams[].id`; already present on old entries) |
| `group` | string | the moment id shared by the `with-girl` and `clean` versions of one moment, e.g. `30092-30120s`; for old clips = the clip id (each is its own group) |
| `variant` | `with-girl` or `clean` | `with-girl` = the render with the girl-watching facecam; `clean` = no facecam, static title |
| `reaction` | `strong`, `mild`, `none`, `unrated` | how visibly the streamer reacts; `unrated` = nobody judged it (old streams, or the webcam was too small) |
| `reaction_note` | string, at most 80 chars | what the streamer does, or why it could not be judged ("webcam too small to judge ...") |
| `kind` | `reaction` or `game` | `reaction` when `reaction` is strong or mild, or the moment is streamer talk / a big cam; else `game` |
| `tier` | `A`, `B`, `C` or `null` | the Opus review confidence of the moment; `null` = never ranked |
| `rank` | int >= 1 or `null` | position inside its stream, 1 = best; both variants of a moment share the rank; `null` = unknown (never invented) |
| `why` | string, at most 110 chars | one line: what happens |
| `hook` | string | the on-screen hook text (an existing field; admins can edit it in the site) |

**Who owns what.** `vault_sync.py --meta-only` always sets the contract fields from `vault_meta.json` (the pipeline's data) EXCEPT `stream` and `hook`, which admins edit in the site: those are only filled when empty. It never touches `title`, `desc`, `post`, `tags`, `trashed_at`, `purge_after`, `sha256`, `size` or any file. **Any client that rewrites `index.json` (the static admin mode, the server store) MUST pass unknown fields and the top-level `streams` through unchanged**, otherwise the first admin edit wipes them (`vault_sync.py --meta-only` restores them).

**Reading it with the read token** (same route as the site): `GET https://huggingface.co/datasets/Soverellp/clip-vault/resolve/main/index.json` and `.../streams/<id>/thumb.jpg`, header `Authorization: Bearer <read token>`. Check script: `python3 site/hfvault/check_index.py` (counts only, no token printed).

**`vault_meta.json`** (`streams/<s>/docs/vault_meta.json`): `{"version":1,"stream":"<id>","clips":{"<clip folder id>":{group, variant, reaction, reaction_note, kind, tier, rank, why, hook}}}`; extra keys (e.g. `moment`) are ignored. Validate with `python3 .claude/skills/clips/scripts/vault_meta.py check`.

## 1. Static mode: what the page calls (design; `site/hfstatic` is in progress)
| What | Call | Token |
|---|---|---|
| Read `index.json`, posters, clips | GET `https://huggingface.co/datasets/Soverellp/clip-vault/resolve/main/<path>` with `Authorization: Bearer <read token>` (CORS from a browser origin was proven earlier for this dataset from `https://soverellp.github.io`, NOT yet from the Space origin) | read token, decrypted in memory |
| Admin commit (edit, upload, trash, restore, delete) | the Hub commit API from the browser (one commit per change, audit line in the same commit) | pasted write token, memory only |
Real Hub commit, LFS upload and conflict behaviour from a browser: UNTESTED. Delete forever and empty trash: typed title plus password again (D25). The exact calls will be listed here once `site/hfstatic` lands.

## 2. Server mode API, as built (saved option)
### Global behaviour
- Same-origin only (no CORS headers). Strict CSP (`default-src 'none'`, scripts from self plus Google's sign-in script), `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, HSTS. All responses `Cache-Control: no-store`.
- Errors: JSON `{"error": "<code>", "message": "<fixed text>"}`. Codes seen in `common.py`: `unauthorized` (401), `forbidden` (403), `not_found`, `method_not_allowed`, `conflict` (409), `too_large`, `unsupported_media_type`, `invalid` (422), `rate_limited` (429, `Retry-After`), `read_only` (503), `not_configured` (503), `upstream_error` (502), `confirm_mismatch` (400), `reauth_required` (403), `root_admin`, `self`, `duplicate`, `exists`, `in_trash`, `not_in_trash`, `managed_by_secret`, `bad_request`, `server_error`.
- Auth: signed HttpOnly cookie `__Host-cv_session` (8 h). State-changing calls need the header `X-CSRF-Token` equal to the `csrf` value from `GET /api/me`. Check order: 401, CSRF 403, role 403, read-only 503, rate limit 429.
- Step-up: delete forever, empty trash and all user changes need a Google sign-in at most 300 seconds old (`REAUTH_WINDOW`; the first plan was 15 minutes); otherwise `403 reauth_required`, then `POST /api/auth/reauth`.
- Rate limits (count per 60 s unless noted; keyed by IP or by user): auth 10, config 120, api 600 per IP; admin mutations 30 per user; uploads 5 per 600 s per user. The IP key is the last X-Forwarded-For entry: UNVERIFIED behind the HF proxy (one `proxy-shape` log line settles it).

### Endpoints
| Method, path | Role | Notes |
|---|---|---|
| GET `/api/auth/config` | anyone | client id; sets a signed nonce cookie (300 s) |
| POST `/api/auth/google` `{credential}` | anyone listed | verifies signature, audience, issuer, expiry, verified email, nonce; sets the session; 403 `forbidden` for an unlisted email (generic), 502 on Google failure, 429 when 8 verifications run at once |
| POST `/api/auth/reauth` | signed-in, CSRF | fresh Google credential refreshes the step-up clock |
| POST `/logout` (GET gives 405) | signed-in | clears the cookie |
| GET `/api/me` | signed-in | email, name, picture, role, `csrf` and related fields |
| GET `/api/files/<path>` | signed-in | only `index`-listed `clips/<id>.mp4|jpg` (admins also `trash/clips/...`); single Range supported; no query or `%`; 404 for anything else |
| GET `/api/clips` (`?trash=1` admin only) | viewer, admin | `{clips, counts, updated_at, can_write}`; admins also trigger lazy purge of expired trash |
| PATCH `/api/clips/{id}` | admin, CSRF, write | editable: title, hook, desc, post, stream, tags; 409 `in_trash` |
| POST `/api/clips` (multipart) | admin, CSRF, write | mp4 up to 150 MB (checked by `ftyp`), poster jpg up to 3 MB; sha256 duplicate refused (`duplicate`); ffprobe fills duration, size, fps, codec, bitrate |
| POST `/api/clips/{id}/trash`, `/restore` | admin, CSRF, write | trash restorable for 30 days (files move to `trash/clips/` in one commit) |
| DELETE `/api/clips/{id}` | admin, CSRF, write, step-up | exact title typed (`confirm_mismatch` otherwise); only from trash |
| POST `/api/trash/empty` | admin, CSRF, write, step-up | body `confirm: "EMPTY TRASH"`, optional `all: true` (everything, else only expired) |
| GET `/api/audit` | admin | last 100 lines |
| GET `/api/users`; POST `/api/users`; PATCH/DELETE `/api/users/{email}` | admin (changes: CSRF, write, step-up) | root admins from `ADMIN_EMAILS` cannot be changed (`root_admin`); you cannot change your own access (`self`); at most 200 users |
| GET `/` and static | public | page assets only, no clips |

### Deviations from the first design (all D11-D16 items)
- Step-up is 300 s, not 15 minutes. Users file is `users.json` at the dataset root, not `_config/users.json`. Trash lives under `trash/clips/`. Audit line fields: `at`, `actor_email`, `action`, `clip_id`, `detail`. Without a write token the whole site is read-only (`503 read_only`).
- Concurrency: one commit per change with `parent_commit`; on conflict re-planned up to 3 times, then `409 conflict`. `upload_folder` (the builder) has no parent check; hard-deleted clips leave no tombstone, so a rerun of the builder re-adds them.
- Remaining UNVERIFIED: exact JSON field names of `/api/me` and clip objects (read `public_clip` in `admin.py`); behaviour against the real Hub, real Google and the real HF proxy.
