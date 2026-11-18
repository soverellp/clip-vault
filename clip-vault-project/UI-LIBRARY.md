# UI-LIBRARY: the calm Library (folders, categories, moment cards)

> **TL;DR** The page opens on a Library home with ONE FOLDER CARD per stream (thumbnail, title, date, moment count, total MB). A folder opens to that stream's MOMENT cards (one card per moment, a "With streamer | Clean" pill switches the clip), with a chip row Streamer reactions / Game moments / Best / All. The SORT control is always visible (D40); view, grouping and the other filters are behind one Filter button. Old data (no new fields) still renders as the old flat list. Written 2026-11-18 by the UI agent; data side and decisions: `DECISIONS.md` D39, `API-CONTRACT.md` section 0.

## What the owner sees
| Screen | Route | Content |
|---|---|---|
| Library home | `#/` | page title, one summary line (streams, moments, size), search, `Filter`, `Post mode`, then folder cards (tab on top, thumbnail, title, date, moment count, MB) |
| A stream | `#/stream/<id>` | back link, stream title, date, channel, size; chips with counts; moment cards, best first |
| Search | typed in the box | moment cards from every stream ("Search results") |
| A clip | `#/clip/<id>` | the same drawer as before; Close returns to the stream it was opened from (`state.libHash`) |
| Post mode | `#/post/<id>` | follows the cards on screen, each with its SELECTED variant |

Moment card: poster, title (2 lines), one-line `why`, `Reaction: strong|mild|none` (hidden when unrated), a star with the rank for tier A (`#1`, or "Top pick" without a rank), duration and size, the variant pill, a "..." menu. The pill only exists when both variants are present. Play, Download, the post kit, the "..." menu, Post mode and mark-posted all act on the selected variant (default "With streamer"). The choice is kept in memory only (`state.variants`).

Categories: `Streamer reactions` = `kind: reaction`, `Game moments` = `kind: game` (a missing kind counts as game), `Best` = `tier: A`, `All`. A moment counts when ANY of its clips matches. Default order in a stream is "Best first" (tier A, B, C, then rank, then score) until a sort is picked.

## D40: order, sort, Filter, language
- Folder order = newest `clipped_at` first (the stream's newest clip); no `clipped_at` (old data): `date`, then title. The folder card and the card of a moment show "Clipped 18 Nov, 14:12" (viewer's local time; day only when the time is unknown); the stream header keeps the YouTube date as secondary ("YouTube 11 Nov 2026") plus a language tag.
- Visible sort control (`#vsort`, outside Filter, 44 px buttons, wraps at 360 px, keeps focus): home `Newest clipped | Oldest | Most clips | Biggest` (default Newest clipped); stream `Best first | Newest clipped | Longest | Biggest` (default Best first). `Newest clipped` inside a stream sorts clips by `clipped_at`.
- Filter button: on home it holds `Has streamer reactions` and `Has best picks` (they hide folders) plus tags and score; inside a stream: posting status (admin), Select, tags and score. The old sort select exists only for the flat old-data library. The button's counter includes the home options. "Clear filters" resets them and the language.
- Language chips (`#langbar`, `All languages | English | Hindi`): home and search only, rendered only when the library has 2 or more known languages (`unknown` is no language); filters folders, the totals and the global search. Inside a stream there are no chips, only a small language tag in the header.
- Tab order: search, Filter, Post mode, the sort buttons, (language chips), then the cards.
- Tests: `site/hfstatic/tests/test_library.js` (fixture `indexClipped()`), `ui/v4.js`.

## Fallbacks (nothing breaks when a field is missing)
- No new fields on any clip and no `streams[]`: the old flat library (hero, grid/list, queues, grouping), only with the controls moved behind Filter.
- `streams[]` missing but clips carry the fields: folders are built from `clip.stream` (title from the folder name, no thumbnail).
- `streams[]` present: titles, dates, channels and thumbnails come from it (never hard-coded). A clip whose stream is not listed gets a folder too; a clip with no stream goes to "Other clips" (`#/stream/~other`).
- Clips without `group`/`variant` are their own moment. Two clips merge only when both have the same `stream`+`group` and different known variants; extra clips stay separate (nothing is hidden).
- `reaction` missing/unknown = unrated (no badge). `tier` outside A/B/C = none.

## Code map
| File | Role |
|---|---|
| `site/hfspace/static/js/moments.js` | pure logic: `buildMoments`, `pick`, `infoOf`, `catHas`, `rankCmp`, `foldersOf`, `folderHref` |
| `site/hfspace/static/js/library.js` | home/stream/search screens, folder and moment cards, Filter panel, chips |
| `site/hfspace/static/css/moments.css` | the calm layout (light and dark tokens at the top) |
| `site/hfspace/static/js/api.js` / `site/hfstatic/src/hubapi.js` | both export `listStreams()` (server mode returns `{streams: []}`) |
| `site/hfspace/static/js/admin.js` | edit form: reaction, category, tier, why, "apply to both versions" (only when `me().capabilities.moments`, static admin mode) |

## Data safety (D39)
`hubapi.js` `normalizeClip`/`normalizeIndex` and `site/hfspace/store.py` pass fields they do not know, and every unknown top-level key (`streams`), through UNCHANGED on every read-modify-write (edit, upload, trash, restore, delete, empty trash). Tests: `site/hfspace/tests/test_clips.py` (3), `site/hfstatic/tests/test_library.js` (admin edit keeps group/variant/kind/rank/hook/streams and unknown fields). The stream thumbnail path is `streams/<id>/thumb.jpg`; `SAFE` in `hubapi.js` and `site/hfvault/app.js` is the same regex.

## Tests
- `NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfstatic/tests/test_library.js` (static build + mocked Hub; `SCREENS=1` rewrites `clip-vault-project/screens/*.png`)
- `site/hfspace/tests/ui/v4.js` (registered from `run.js`): the same screens in server mode against the mock API (`/__ctl library` seeds `fixtures_library.js`)
- Old tests that used the flat controls call `L.openFilter(p)` first (sort, view, group, queue, stream/tag chips, Select, posting status).

## Known limits
- Proven only with Playwright, fixtures and a mocked Hub. NOT tested: the real 46-clip index, real thumbnails, a real phone, Safari.
- The classic flat layout (old data) keeps its decorations (waveform, ribbon, score ring); only the moments screens are calm.
- Server mode has no stream records: no thumbnails, titles come from the folder name.
- "Apply to both versions" makes two commits (one per clip).
- Select mode on a moment card selects both variants (bulk trash moves both).
