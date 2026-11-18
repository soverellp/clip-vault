# site/hfstatic: Clip Vault, static mode (no server)

Hugging Face gives this account only free STATIC Spaces, so there is no backend. This folder builds a pure static site
(HTML, JS, CSS, no third-party scripts) that talks to the Hugging Face Hub straight from the browser, against the PRIVATE
dataset `Soverellp/clip-vault` (`index.json`, `clips/<id>.mp4|jpg`, `trash/clips/...`, `_audit/YYYY-MM.jsonl`).

The screens are NOT forked. `build_static.py` COPIES `site/hfspace/static/` into `dist/` and adds:

| File | What it is |
|---|---|
| `src/hubapi.js` | the same interface as the server's `api.js` (`MODE = 'static'`), implemented over the Hub HTTP API |
| `src/hubchrome.js` | runtime chrome: passphrase wording, the Admin button (paste a write token), Lock label |
| `src/framebust.js`, `src/static-mode.css` | frame-buster (meta CSP cannot set `frame-ancestors`), small CSS |
| `build_static.py` | builds `dist/` (+ encrypted `config.json`, `README.md` with Space front matter `sdk: static`) |
| `deploy_static.py` | creates the Static Space and uploads ONLY the allow-listed dist files |
| `tests/` | pytest for the build scripts, Playwright + a mock Hub for the site |

`dist/js/api.js` is one line (`export * from './hubapi.js'`). The build fails loudly if the server `api.js` gains an export that
`hubapi.js` lacks, if the UI starts using a forbidden browser API (storage, cookies, `eval`, `innerHTML`...), or if `index.html`
gets an inline script or style (the CSP would block it).

## How it works

Viewer (everyone with the passphrase)
1. `config.json` (public) holds the READ-ONLY token encrypted: PBKDF2-SHA256 600k + AES-256-GCM.
2. The passphrase is typed; WebCrypto decrypts the token into a JS closure variable (never storage, never the DOM).
3. `GET https://huggingface.co/datasets/Soverellp/clip-vault/resolve/main/index.json` with `Authorization: Bearer`.
4. Posters are fetched (4 at a time) into blob URLs. An mp4 is fetched only after a tap (opening a clip), with progress, then played
   and downloaded from the blob. `resolve` answers 302 to a `*.hf.co` CDN; the browser drops `Authorization` on that cross-origin hop.
5. Wrong passphrase: one generic message plus an in-memory delay (1 s, 2 s, 4 s ... 5 min). Lock wipes the tokens, revokes every blob URL,
   clears the caches and reloads.

Admin (the owner, when needed): the Admin button asks for a fine-grained WRITE token (`hf_...`, this dataset only). It is held in
memory only, masked, never in a URL, storage, DOM attribute or log. It is checked with `GET /api/whoami-v2` and refused when it is the
read token, account-wide (role `write`/`admin`), has no write on the dataset, or has an unexpected answer shape. A token that can also
write to other scopes is allowed after a warning that names each one (`type/name: permission`) and a "Continue anyway" click (D36). The dataset name is matched case-insensitively. Then, over the Hub HTTP API:

| Action | Wire operations (one commit each, `parentCommit` = the head that was read, audit line in the SAME commit) |
|---|---|
| edit metadata | `file index.json` + `file _audit/YYYY-MM.jsonl` |
| upload (mp4 up to 150 MB, optional jpg up to 3 MB) | `POST preupload` -> regular `file` or LFS (`POST ...git/info/lfs/objects/batch`, PUT single or multipart, verify) -> `lfsFile`; index + audit |
| trash / restore | copy (`lfsFile` with the source oid, or `file` for regular files) to / from `trash/` + `deletedFile`; `purge_after` = +30 days |
| delete forever / empty trash | `deletedFile` on the trash files + index + audit; asks for the passphrase again first (step-up, 5 min) |

A commit that loses a race (HTTP 409/412) is rebuilt from a fresh read and retried up to 3 times. Audit lines use
`{at, actor_email: "admin", action, clip_id, detail}` (no identity exists here).

## Known deviations and limits

- No `copyFile` operation exists in the Hub commit API (the brief assumed one): a copy is an `lfsFile` with the source oid, or a re-added `file`.
- No automatic purge: the server version purges expired trash whenever an admin lists clips. Here nothing is purged until the admin
  uses Empty trash (the "30 days" is a mark, `purge_after`, not a timer). Empty trash without the checkbox removes only expired clips.
- Uploads hold the file in memory (the SHA-256 buffer, then one ArrayBuffer per PUT): up to about 150 MB on top of the file. Phones may struggle near the limit.
- The unlock screen delay and admin step-up are in-page guards only. A reload resets the delay.
- `build_static.py --accept-weak-passphrase` does NOT put any weak-password note in the PUBLIC Space `README.md` or in the uploaded
  files (it would tell an attacker the passphrase is guessable; `readme_text()` and the public `build-info.json` omit it). The note
  exists only in the repo-local `site/hfstatic/build-info.json`, which is never uploaded.
- Deploys remove stale files: `deploy_static.py` passes `delete_patterns` equal to the upload allow-list, so an old renamed `js/*.js`
  or removed font disappears from the Space in the same commit; files outside that list (and `.gitattributes`) are never touched.
- The admin token box is `type=text` with CSS `-webkit-text-security: disc` (shown as dots), `autocomplete=one-time-code`, so password
  managers and the browser's save-password prompt leave the write token alone. A browser without text-security support would show it in clear.
- The admin token check refuses a token whose `whoami-v2` answer has an unknown format or that cannot write to the dataset; a write-type
  permission outside the dataset (account-wide role is still refused) only warns, naming the scope (D36).
- Shared-UI bug seen (not fixed here, belongs to `site/hfspace/static`): `main.js` calls `tabs.replaceChildren(..., null)` when the People tab is not offered, which prints the text "null". `hubchrome.js` removes it as a workaround.
- The Playwright tests use UI element ids (`#btn-edit`, `#up-go`, ...). A UI id change breaks them, not the site.

## Library UI (folders, categories, moment cards)
The shared UI opens on folder cards (one per stream, thumbnails from `streams/<id>/thumb.jpg`, fetched like posters: blob URL, token in the header only) and shows one card per moment with a With streamer / Clean pill. Details, fallbacks and tests: `clip-vault-project/UI-LIBRARY.md`. `hubapi.js` exports `listStreams()` (the build still checks it matches `api.js`), keeps unknown clip fields and `streams[]` unchanged on every write (D39), and lets the admin edit `reaction`, `kind`, `tier`, `why`, `reaction_note`. Test: `node site/hfstatic/tests/test_library.js`.

## Capabilities

`me()` returns `{role: 'viewer'|'admin', capabilities: {users: false, trash, audit, upload, delete}, can_write}`. The People screen stays
hidden (`/api/users` answers 404 `no_users`). **Access control is ONE shared passphrase.** There are no per-person users. To rotate:
rebuild `config.json` with a new token and a new passphrase and redeploy.

## Build and deploy

See `SETUP.md`. Short version:
`python3 site/hfvault/with_vault_creds.py --dataset arvr7plays/kagglegpu1 -- python3 site/hfstatic/deploy_static.py`

Tests (see STATUS.md for the latest counts; 106+ Playwright assertions): `python3 -m pytest site/hfstatic/tests/test_build.py` and
`NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfstatic/tests/test_static.js`
(screenshots at 390x844 go to `/tmp/claude-0/hfspace-shots/static/`).

## Threat model (honest)

- One shared passphrase protects everything. Anyone who has it can read every clip and cannot be told apart from anyone else. Anyone
  who leaves keeps what they downloaded; rotate to cut them off.
- `config.json` is PUBLIC. Anyone can copy it and guess passphrases offline at full speed. PBKDF2 (600k) slows each guess; the in-page
  delay does NOT limit that attack at all. The passphrase must therefore be random words (the build enforces 4+ distinct words,
  20+ characters; the owner can knowingly override with `--accept-weak-passphrase`, which is recorded only in the repo-local `site/hfstatic/build-info.json`).
- If the passphrase is found, the read token is exposed (read-only, one dataset). Revoke it on Hugging Face and rebuild.
- The read token sits in browser memory while the vault is open. A malicious browser extension or XSS would see it. The CSP
  (`script-src 'self'`, no inline script, no third-party script, `connect-src` limited to huggingface.co and *.hf.co) and the
  forbidden-API checks reduce XSS risk; they do not remove it.
- The admin write token is pasted into a browser tab and lives in memory until reload, Lock or Exit admin. The same extension/XSS caveat
  applies, and it can write to the dataset. Use a fine-grained token limited to the one dataset, with a short expiry if possible, and
  revoke it afterwards. The write token is never given to Claude, a script or a file.
- **The read token can read the WHOLE dataset, not only what the page lists** (a Hub token cannot be limited to a folder). Every
  password holder can therefore also read `trash/` (clips "deleted" but not yet purged), `_audit/*.jsonl` (the admin action log) and
  `_config/tombstones.json`, by calling the Hub directly with the token from the browser tools. Treat trash as "not shown", not
  "secret", and keep anything private out of this dataset. In particular NO `users.json` (or any file with emails or personal data)
  may exist in the dataset: the server-mode user list lives only in the server-mode store, never here.
- Rotating the PASSWORD alone does not lock out someone who saved an older `config.json` (it is public, and also sits in the Space's
  git history): they decrypt it with the old password and still get the OLD read token. To cut someone off, rotate the read token
  too (new token on Hugging Face, rebuild, redeploy, revoke the old token). Deleting the old file from the Space does not help.
- Remember on this device (D37): a checkbox on the unlock screen, ticked by default. When ticked and the unlock works, ONLY the passphrase is stored in `localStorage['cv.pass']` (all in `src/hubchrome.js`); the next visit unlocks silently, a failed silent unlock deletes it and shows the normal screen, Lock deletes it. The admin write token and read token are never stored. Anyone with the unlocked device or any XSS can read the passphrase: untick the box on shared computers, and rotate if a device is lost.
- Idle lock: after 15 minutes without a click, key, touch or scroll (and no video playing) the page runs the same Lock as the button
  (both tokens forgotten, blob URLs revoked, reload). If a passphrase is remembered, the idle timer only drops the admin write token.
- Security headers: a Static Space cannot set HTTP response headers, so the CSP is a `<meta http-equiv>` tag (it cannot carry
  `frame-ancestors`, `report-uri` or `sandbox`; see Framing below). `img-src` allows only `'self'` and `blob:` (no `data:`).
- Client-side checks (admin gating, step-up) are UX guards, not security: the real gate is the Hub's own token permission.
- Framing: a meta CSP cannot set `frame-ancestors`; a JS frame-buster hides the app when framed and offers an "open directly" link.
  Hugging Face shows Static Spaces in an iframe on the Space page; open the direct `*.static.hf.space` address for the real thing.
- No service worker, no Cache Storage, no sessionStorage/IndexedDB/cookies. localStorage is used for the one remembered-passphrase key `cv.pass` only (build_static.py fails the build on any other storage use); with the box unticked a closed tab leaves nothing behind.

## PROVEN vs UNTESTED

| Item | Status |
|---|---|
| CORS preflight (OPTIONS) from `https://soverellp-clip-vault-site.static.hf.space` for `commit/main`, `whoami-v2`, `preupload/main`, `paths-info`, `revision`, `...git/info/lfs/objects/batch` (headers `authorization,content-type,accept`), and for the viewer's GETs `resolve/main/index.json` and `revision/main` (`authorization`) | PROVEN with curl, no token (all 200 with `access-control-allow-origin` echoing the origin) |
| A private `resolve` GET with a fake token answers 401 WITH `access-control-allow-origin` + `x-error-message` (a wrong/revoked token is readable from a browser); the `/api/resolve-cache/...` hop of a 307 also carries `access-control-allow-origin` | PROVEN with curl, fake token / public file |
| POST with a fake token to `commit/main`, LFS batch, `whoami-v2` answers 401 WITH `access-control-allow-origin` (errors are readable from a browser) | PROVEN with curl, fake token only |
| `X-Repo-Commit` and `ETag` are exposed to browsers; `resolve` of a public repo answers 307 same-origin (small file) or 302 to `us.aws.cdn.hf.co` (large file) | PROVEN with curl on a public dataset |
| CDN `*.hf.co` answers `access-control-allow-origin: *`, Range 206, and exposes headers | PROVEN with curl (public file) |
| Static Space host pattern `https://<owner>-<name>.static.hf.space` | PROVEN (public Space API) |
| Wire format of the commit/LFS/preupload/paths-info calls | READ from the installed `huggingface_hub` 2.4.0 source and mirrored; there is NO `copyFile` operation (a copy is an `lfsFile` with the source oid, or a re-added `file`) |
| Authorization is dropped on a cross-origin redirect (the `resolve` 302 to `*.hf.co`) | PROVEN in real Chromium with two local servers. The mock Hub itself serves the mp4 directly, because Playwright cannot intercept the follow-up request of a fulfilled 302 |
| Passphrase flow, no mp4 before tap, playback, Lock, storage emptiness, CSP, admin refusals, edit/upload/trash/restore/delete/empty/audit commit shapes, conflict retry, step-up | tested against a MOCK Hub (`page.route`). The mock does not apply CORS or CSP of the real network, so it proves the client logic and request shapes only |
| Real Hub accepting these commits (incl. `lfsFile` copy without size, JSON body for `paths-info`) | UNTESTED (needs a real write token, which is never given to Claude) |
| Real LFS upload from a browser (the batch answer's upload `href` may be S3 outside `*.hf.co`, which the required CSP blocks; multipart needs the host to expose `ETag`) | UNTESTED. The page names the host and refuses; the Python uploader remains the fallback |
| `whoami-v2` answer shape: `auth.accessToken.role` and `displayName` are READ in the installed `huggingface_hub` (`_login.py`) | PROVEN in the library source only |
| `whoami-v2` fine-grained details: `fineGrained.scoped[].entity.{type,name}`, `permissions` such as `repo.write`, `global` | UNTESTED (the library source does not show them; written from memory; an unexpected shape only produces a warning) |
| Real Static Space, real phone | UNTESTED. Desktop Chromium at 390x844 only |
