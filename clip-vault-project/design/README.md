# FRAGBAG clip library: three design directions (mockups only, site/ untouched)

Open `a/index.html`, `b/index.html`, `c/index.html` (add `#stream` for the inside-a-stream screen). Each is `index.html` + `style.css` + `img/` + `fonts/`: zero JS, no inline style or script (CSP `default-src 'none'; img/font/style 'self'`), no network. Tabs, version switch, theme and menus are CSS only (radio inputs + `:has()`, `<details>`). Real data: 3 stream thumbs, 14 moments from `vault_meta.json` (Best default, ranked, Clean swaps to the real clean poster). PNGs: `{a,b,c}-{home,stream}-mobile.png` (390x844 @2x), `recommended-desktop.png` (A, 1280x800). Rebuild: `python3 _build.py`, `node _shot.js abc desk` (needs NODE_PATH and PLAYWRIGHT_BROWSERS_PATH as in the brief).

## Directions
- **A Editorial / poster-forward.** Paper-black, one orange accent, Space Grotesk headlines. Folders = layered sheet stack with a count tab. Stream = text tabs, big posters, "Top pick" lead card; desktop becomes a 4-column poster wall.
  Strength: calmest, fastest to scan, cheapest, cleanest AA. Cost: LOW (about 1 day: re-skin `moments.css`, same markup and JS).
- **B Glass / iOS.** Blurred thumbnail backdrop, translucent cards, 28-32 px radii, folder with tab and thumb peeking out of a glass front, bottom floating segmented control (sliding knob) for categories.
  Strength: most "modern" feel, great one-handed. Cost: MEDIUM (2 days): backdrop-filter perf on cheap phones, per-stream blurred bg, fixed bottom bar, legibility over varying images needs care.
- **C Feed / streaming.** Near-black, orange-gold gradient accent, deck-stack folders with a fan of best posters, hero "Best clip" (Play, version switch), chips + swipeable 9:16 rows per category, "Top picks" across streams on home.
  Strength: most cinematic, best clip is unmissable. Cost: MEDIUM-HIGH (2-3 days): row/grid dual mode, scroll-snap, duplicates across rows, hero needs the best moment chosen; rows hide items off-screen, slower for comparing 14 clips.

## Recommendation: A, borrowing C's "Top picks" idea later
Pain = "trouble finding the correct clip to post": A opens on Best (3), ranks with a star and "Top pick", and shows every card's choosing facts (why, reaction, duration, version) vertically with nothing hidden off-screen. Lowest risk for a static CSS-only build, works at 360 px, and the desktop poster wall is the best of the three. Light theme: the same tokens flip under `#theme:checked` (implemented, toggle in the ... menu); B/C also implemented.

## Tokens (A, dark / light)
- Color: bg `#0f0e0c` / `#f7f2e9`; surface `#181613` / `#ece4d5`; line `#2e2a24` / `#d6cbb7`; ink `#f4efe6` / `#1a150f`; ink2 `#b5ada1` / `#5b5347`; accent `#ff8a2b` / `#a84407`; on-accent `#150f08`. Logo-derived: glow orange `#ff8a2b`, gold `#f6c453` (B/C only).
- Type: Space Grotesk 600 display (56/1 home title, 28/1.1 stream title, 19-22/1.18 card title), Inter 400-600 body (16 base, 14 why, 13 meta, 12 kicker caps +.16em); desktop display 96, stream title 38.
- Radii: 3 px images, 4 px controls, 6 px tab/menu (editorial = nearly square). Spacing: 20 px gutter (40 desktop), 18 card gap, 44 px between cards, 44 px min tap height, header 64 px, poster 148 px wide (lead 172).
- Reaction meter 3 bars (strong 3 / mild 2 / none 0 filled) plus the text "Reaction: x", hidden when unrated; never colour-only.

## Checked
360 px no horizontal scroll, all taps >= 44 px (Playwright), CSP-clean, reduced-motion kills transitions. Not tested: real contrast tool run (palette chosen for AA by calculation), screen readers, real videos (posters only), Safari (`:has()` needs 15.4+).
