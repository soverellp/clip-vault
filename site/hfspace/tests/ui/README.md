# Clip Vault UI tests (Playwright)

    NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfspace/tests/ui/run.js

Needs ffmpeg (makes a VP9 test video; Chromium has no H.264) and the preinstalled Chromium. About 7 minutes. Screenshots go to
`/tmp/claude-0/hfspace-shots/v3/` (override with `SHOTS=`). `ONLY="regex"` runs the tests whose name matches.

## Mock mode (default)
`mock_server.js` is a small Node implementation of the API contract (clips, trash, audit, users, upload with real multipart parsing,
Range streaming, step-up `reauth_required` after 5 minutes, error injection by magic titles `ERR413/415/429/503/DUP` and `FAIL429`)
that also serves `static/` with the production CSP. Google is faked in the page: `page.route('https://accounts.google.com/gsi/client')`
returns a tiny `google.accounts.id` whose button calls the callback with `window.__cred` (`FAKE-admin`, `FAKE-viewer`, `FAKE-readonly`).
The clock is pinned to 2026-03-10T12:00:00Z so relative and exact local times are checked under Asia/Kolkata and America/Los_Angeles.

## Real backend (BASE_URL)

    python3 site/hfspace/tests/ui_launcher.py 8787 &
    BASE_URL=http://127.0.0.1:8787 \
    UI_CRED_ADMIN='ok:root@example.com:sub-root:pppppppppppppppppppppppp' \
    UI_CRED_VIEWER='ok:viewer@example.com:sub-viewer:pppppppppppppppppppppppp' \
    NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfspace/tests/ui/run.js

The page still uses the fake Google script; the credential string is whatever the launcher's fake verifier accepts. Tests that need
the mock's seed data or error injection print `SKIP (mock only)`; the shared subset (sign-in, library, palette, player requests,
roles, theme, hero modes, storage, CSP, contrast, screenshots) runs against the real routes. `/__reset` is called between tests.
The launcher's H.264 video cannot be decoded by this Chromium, so playback itself is only asserted in mock mode.

## v3 tests (`v3.js`, registered from `run.js`, mock mode only)
| Test | What it proves |
|---|---|
| post mode: opens from the button... | `#post-mode-btn`; no mp4 before opening; only the active clip's mp4 is requested and exactly one `<video>` exists; only the current and next POSTER get a `src`; muted autoplay, tap to unmute / pause / resume; `j` `k` ArrowUp/Down, wheel snap, hash follows the clip (`#/post/<id>`, replaceState); safe-zone toggle (bottom 20%); copy-all YouTube/Instagram, `c` / `i`, per-field copy, counters, `d` and the Download button; mark-posted toggles, `p` / Shift+P; `?` overlay; Esc and browser Back close; nothing in storage |
| post mode: touch swipe on a phone... | real touch swipe (CDP `Input.dispatchTouchEvent`) up and down at 390x844; collapsed docked bar, expanding handle, every tap target >= 44 px, no horizontal scroll |
| post mode: reduced motion... | instant snap, no `--py` parallax, aurora not animated; low power: no aurora animation, no next-poster preload, no parallax |
| post mode: viewer... | viewers get chips but no toggles; deep link `#/post/<id>`; unknown id toast |
| tracker | chips + hover date-time, the four posting filters, drawer toggles (`patchClip(id,{posted})`, player not rebuilt), notes (max 500), a server that rejects (`flags:{rejectPosted}`) or silently drops (`dropPosted`) the fields -> error toast + rollback, viewer view |
| queue views | All / Ready to post / Best clips / New with counts, ordering, live update, Post mode follows the queue, viewer has no Ready queue |
| card quick actions | "..." button, long press, right click, every row, viewer subset |
| stream groups | headers with count and total duration, collapse, Download all queue (no zip), confirm above 3 files, cancel (`ctl addclips`) |
| shortcuts overlay | `?` (not while typing), contents, Esc |
| hero + counters | hero spans the content width at 1440/1280/900/390, canvas width equals hero width, counters settle on real values (immediately under reduced motion) |
| smart cards | score ring, NEW ribbon, waveform, Ken Burns without fetching video, skeleton shimmer, aurora follows the card |
| contrast / storage / first paint | AA for the new chips, new modules free of forbidden APIs, first paint < 2.5 s on throttled 4G |

Mock additions: clips carry `posted` / `notes`; `PATCH` accepts partial bodies (title only validated when present) plus `posted` and `notes` (<= 500);
`/__ctl` actions `flags` (`rejectPosted`, `dropPosted`) and `addclips`. Against a real backend that does not know `posted` yet the UI shows the
"server did not accept" toast and rolls back (that is the intended behaviour, covered by `rejectPosted`).
