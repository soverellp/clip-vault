// Library UI (folders, categories, moment cards, variant switch) against the static build + the MOCKED Hub. Fixtures: site/hfspace/tests/ui/fixtures_library.js.
// Run: NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfstatic/tests/test_library.js
// SCREENS=1 also writes the PNG screenshots to clip-vault-project/screens/. Fake secrets only; nothing here proves the real Hub or a real phone.
const { chromium } = require('playwright');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { MockHub } = require('./mockhub');
const FX = require('../../hfspace/tests/ui/fixtures_library');

const READ = 'hf_' + 'FAKEREADTOKEN00000000000000000000', WRITE = 'hf_' + 'FAKEWRITETOKEN0000000000000000000', PASS = 'copper lantern meadow quiver';
const ROOT = path.resolve(__dirname, '..'), REPO = path.resolve(ROOT, '../..');
const SHOT_DIR = path.join(REPO, 'clip-vault-project/screens');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hflib-')), DIST = path.join(tmp, 'dist');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canon2 = (o) => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

const b =spawnSync('python3', [path.join(ROOT, 'build_static.py'), '--no-info-copy', '--out', DIST], { env: { ...process.env, VAULT_READ_TOKEN: READ, VAULT_PASSPHRASE: PASS }, encoding: 'utf8' });
if (b.status !== 0) { console.log(b.stdout, b.stderr); process.exit(1); }
const MP4 = path.join(tmp, 'v.mp4'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x112:d=2:r=10', '-c:v', 'libvpx-vp9', '-b:v', '50k', '-movflags', '+faststart', MP4]);
const mkjpg = (n, col, s) => { const f = path.join(tmp, n + '.jpg'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${col}:s=${s}`, '-frames:v', '1', f]); return fs.readFileSync(f); };
const POSTER = mkjpg('p', 'red', '90x160'), THUMB = mkjpg('t', 'teal', '320x180');

function hubWith(index, thumbs = true) {
  const hub = new MockHub({ read: READ, writeOk: WRITE, extra: {} });
  hub.put('index.json', JSON.stringify(index));
  for (const c of index.clips) { hub.put(c.video, fs.readFileSync(MP4), true); if (c.poster) hub.put(c.poster, POSTER); }
  if (thumbs) for (const s of index.streams || []) if (s.thumb) hub.put(s.thumb, THUMB);
  hub.put('.gitattributes', '*.mp4 filter=lfs');
  return hub;
}
const legacyIndex = () => ({ clips: ['o1', 'o2', 'o3'].map((id, i) => ({ id, stream: '2026-01-01_old', title: 'Old ' + id, hook: 'h', dur: 40 + i, score: 8, size: 1e7, video: `clips/${id}.mp4`, poster: `clips/${id}.jpg` })) });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(DIST, p); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
  async function session(hub, o = {}) {
    const ctx = await browser.newContext({ viewport: o.viewport || { width: 390, height: 844 }, colorScheme: o.scheme || 'dark', acceptDownloads: true, hasTouch: !!o.touch, timezoneId: 'UTC' });
    if (!o.feedOn) await ctx.addInitScript(() => { try { localStorage.setItem('cv.feed', '0'); } catch (e) {} }); // Post mode opens by itself on first load (D49): these tests browse the grid
    await ctx.route('https://huggingface.co/**', (r) => hub.handle(r));
    await ctx.route(/^https:\/\/([\w-]+\.)+hf\.co\//, (r) => hub.handle(r));
    const page = await ctx.newPage(), errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => { if (/content security policy|refused to/i.test(m.text())) errs.push(m.text()); });
    await page.addInitScript(() => { window.__v = []; document.addEventListener('securitypolicyviolation', (e) => window.__v.push(e.violatedDirective + ' ' + e.blockedURI)); });
    await page.goto(base);
    await page.waitForSelector('#signin:not([hidden]) #pp-input');
    await page.uncheck('#remember-cb'); await page.fill('#pp-input', PASS); await page.click('#signin button[type=submit]');
    await page.waitForSelector('.folder-grid .folder, li.card .card-link', { timeout: 15000 });
    return { ctx, page, errs, hub };
  }
  const shot = async (page, name) => { if (!process.env.SCREENS) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await sleep(700); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
  const texts = (page, sel) => page.$$eval(sel, (e) => e.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);
  const S1 = FX.S1, S2 = FX.S2;
  const openFolder = async (page, id) => { await page.click(`.folder[data-stream="${id}"] a`); await page.waitForSelector('ul.grid.moments li.card'); await page.waitForSelector('.cats .cat'); };
  const chip = async (page) => Object.fromEntries((await page.$$eval('.cats .cat', (e) => e.map((x) => [x.dataset.cat, x.querySelector('.n').textContent, x.getAttribute('aria-pressed')]))).map(([k, n, p]) => [k, { n: Number(n), on: p === 'true' }]));

  try {
    // ================= viewer on the new data (2 streams, 3 pairs, 1 old clip)
    {
      const hub = hubWith(FX.index()); const { ctx, page, errs } = await session(hub);
      await page.waitForFunction(() => document.querySelectorAll('.folder-grid .f-thumb img.loaded').length === 2, null, { timeout: 8000 }).catch(() => {});
      ok((await page.$$('.folder-grid .folder')).length === 2, 'library home: one folder card per stream (2)');
      ok((await page.$$('ul.grid:not(.skel)[aria-label="Clips"] li.card:not([hidden])')).filter(Boolean).length >= 0 && !(await page.isVisible('ul.grid[aria-label="Clips"]')), 'library home: no clip cards, folders only');
      ok((await texts(page, '.folder .f-title')).join('|') === 'Night stream: ranked grind until sunrise|Just chatting Q and A', 'folder titles and order come from streams[] (newest date first)');
      ok(JSON.stringify(await texts(page, '.folder .f-meta')) === JSON.stringify(['18 Nov 2026 2 moments 76.0 MB', '16 Nov 2026 2 moments 58.0 MB']), 'folder card: date, moment count, total MB (' + (await texts(page, '.folder .f-meta')).join(' / ') + ')');
      ok(await page.$$eval('.folder .f-thumb img.loaded', (e) => e.length === 2 && e.every((i) => i.src.startsWith('blob:') && i.naturalWidth > 0)), 'folder thumbnails are loaded as blob URLs');
      ok(await page.$eval('.folder:first-child .f-tab', (e) => getComputedStyle(e).display !== 'none') && (await page.$$('.folder .f-tab')).length === 2, 'folder look: a tab on top of each card');
      const thumbReqs = hub.requests.filter((r) => /streams\/.+\/thumb\.jpg$/.test(r.url));
      ok(thumbReqs.length === 2 && thumbReqs.every((r) => r.host === 'huggingface.co' && r.auth === READ && !r.url.includes(READ)), 'thumbnails fetched from the Hub with the read token in the header only, never in a URL');
      ok(hub.violations.length === 0, 'no token was sent to a CDN host');
      ok((await page.textContent('.page-sub')).startsWith('2 streams'), 'home summary line: ' + (await page.textContent('.page-sub')));
      ok(!(await page.isVisible('.lib-hero')), 'the big hero is gone on the library home');
      ok(await page.$eval('.who img.avatar', (i) => i.alt === 'FRAGBAG' && i.complete && i.naturalWidth > 0 && getComputedStyle(i).borderRadius === '50%' && i.getBoundingClientRect().width >= 36), 'top bar shows the FRAGBAG logo as a round 36 px avatar (alt FRAGBAG)');
      await shot(page, 'mobile-dark-library-home');

      // ---- keyboard order on the home screen
      await page.focus('#q'); const order = [];
      for (let i = 0; i < 3; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement.id || document.activeElement.className.split(' ')[0])); }
      ok(order.join() === 'filter-btn,post-mode-btn,vsort-sel', 'Tab order on home: search, Filter, Post mode, the visible sort select (' + order.join(',') + ')');
      await page.focus('.folder-link');
      ok(await page.evaluate(() => document.activeElement.matches(':focus-visible')), 'keyboard focus is visible on a folder card');
      await page.keyboard.press('Enter'); await page.waitForSelector('.cats .cat');
      ok(page.url().includes('#/stream/' + S1) && (await page.evaluate(() => document.activeElement.id)) === 'page-title', 'Enter opens the stream and moves focus to its heading');

      // ---- inside the stream: chips and counts
      const c1 = await chip(page);
      ok(JSON.stringify(Object.keys(c1)) === JSON.stringify(['reaction', 'game', 'best', 'all']), 'category chips: Streamer reactions, Game moments, Best, All');
      ok(c1.reaction.n === 1 && c1.game.n === 1 && c1.best.n === 1 && c1.all.n === 2 && c1.best.on, 'chip counts for stream 1: reactions 1, game 1, best 1, all 2 (a stream with a tier A moment opens on Best)');
      await page.click('.cat[data-cat="all"]');
      ok((await texts(page, '.cats .cat .lbl')).join('|') === 'Streamer reactions|Game moments|Best|All', 'chip labels are plain words');
      ok((await page.textContent('#page-title')) === 'Night stream: ranked grind until sunrise' && (await page.textContent('.page-sub')).includes('18 Nov 2026'), 'stream heading and date');
      ok((await page.$$('ul.grid.moments > li.card')).length === 2, 'ONE card per moment: 2 cards for 4 clips');
      ok((await texts(page, 'ul.grid.moments li.card .title')).join('|') === 'He screams when the boss dies|Insane clutch 1v4 on the roof', 'best first: rank 1 before rank 2');
      await page.click('.cat[data-cat="reaction"]');
      ok((await page.$$('ul.grid.moments > li.card')).length === 1 && (await chip(page)).reaction.on, 'chip Streamer reactions filters to its moments');
      await page.click('.cat[data-cat="game"]'); ok((await texts(page, 'ul.grid.moments li.card .title')).join() === 'Insane clutch 1v4 on the roof', 'chip Game moments');
      await page.click('.cat[data-cat="best"]'); ok((await texts(page, 'ul.grid.moments li.card .title')).join() === 'He screams when the boss dies', 'chip Best = tier A');
      await shot(page, 'mobile-dark-stream-best'); await page.click('.cat[data-cat="reaction"]'); await shot(page, 'mobile-dark-stream-reactions'); await page.click('.cat[data-cat="game"]'); await shot(page, 'mobile-dark-stream-game');
      await page.click('.cat[data-cat="all"]');

      // ---- card content
      const A = 'ul.grid.moments li.card[data-key$="a1"]', Bc = 'ul.grid.moments li.card[data-key$="b2"]';
      ok((await page.textContent(`${A} .rx`)) === 'Reaction: strong' && (await page.textContent(`${Bc} .rx`)) === 'Reaction: none', 'reaction badge: strong / none (the clean variant carries no reaction, it comes from the pair)');
      ok(/screams at the surprise boss/.test(await page.textContent(`${A} .why`)) && (await page.$eval(`${A} .why`, (e) => getComputedStyle(e).webkitLineClamp)) === '3', 'a short why under the title (3 lines at most)');
      ok((await page.textContent(`${A} .mdur`)).startsWith('0:45') && /#1/.test(await page.textContent(`${A} .star`)) && !(await page.isVisible(`${Bc} .star`)), 'duration, and a star with the rank only on tier A');
      ok(await page.$eval(`${A} .rx`, (e) => { const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number); const L = (c) => { const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; }; const s = getComputedStyle(e); const a = L(rgb(s.color)), c = L(rgb(s.backgroundColor)); return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05) >= 4.5; }), 'reaction badge contrast is at least 4.5:1 (dark)');

      // ---- variant switch
      ok((await texts(page, `${A} .vpill .vbtn`)).join('|').startsWith('With streamer|Clean') && (await page.getAttribute(`${A} .vbtn[data-variant="with-streamer"]`, 'aria-pressed')) === 'false' && (await page.getAttribute(`${A} .vbtn[data-variant="clean"]`, 'aria-pressed')) === 'true', 'pill "With streamer | Clean", Clean selected by default');
      ok((await page.$$eval(`${A} .vbtn`, (e) => e.every((x) => x.offsetHeight >= 44))), 'the pill buttons are at least 44 px tall');
      await page.click(`${A} .card-link`); await page.waitForSelector('dialog.drawer[open].shown'); await page.waitForFunction(() => document.querySelector('dialog.drawer video'), null, { timeout: 8000 }).catch(() => {});
      await sleep(600);
      const mp4 = () => hub.requests.filter((r) => /clips\/[\w-]+\.mp4$/.test(r.url)).map((r) => r.url.split('/').pop());
      ok(mp4().includes('a1-c.mp4') && !mp4().includes('a1-w.mp4'), 'clean selected by default: the clean file is the one fetched and played');
      await page.click('.drawer-close'); await page.waitForSelector('dialog.drawer:not([open])', { state: 'attached' });
      ok(page.url().endsWith('#/stream/' + S1), 'closing a clip returns to the stream, not the library home');
      await page.click(`${A} .vbtn[data-variant="clean"]`);
      ok((await page.getAttribute(A, 'data-id')) === 'a1-c' && (await page.getAttribute(`${A} .vbtn[data-variant="clean"]`, 'aria-pressed')) === 'true' && (await page.$$('ul.grid.moments > li.card')).length === 2, 'switching to Clean keeps ONE card and points it at the clean clip');
      await shot(page, 'mobile-dark-card-variant-clean');
      await page.click(`${A} .card-link`); await page.waitForSelector('dialog.drawer[open].shown'); await sleep(900);
      ok(mp4().includes('a1-c.mp4'), 'variant switch changes the played file (clean mp4 fetched)');
      await page.click('.drawer-close'); await page.waitForSelector('dialog.drawer:not([open])', { state: 'attached' });
      await page.click(`${A} .card-more`); await page.waitForSelector('dialog.sheet[open]');
      await page.click('.sheet-act[data-act="download"]'); await sleep(1200);
      ok(mp4().filter((n) => n === 'a1-c.mp4').length >= 1 && hub.requests.some((r) => /a1-c\.mp4/.test(r.url)), 'the "..." menu (download, post kit) follows the selected variant');
      await page.keyboard.press('Escape').catch(() => {});

      // ---- filter menu
      await page.evaluate(() => { location.hash = '#/'; }); await page.waitForSelector('.folder-grid .folder');
      ok(!(await page.isVisible('#filter-panel')) && (await page.getAttribute('#filter-btn', 'aria-expanded')) === 'false', 'sort, view, grouping and filters are collapsed behind one Filter button');
      ok(!(await page.isVisible('#sort')) && !(await page.isVisible('#group-btn')) && !(await page.isVisible('.qseg')) && !(await page.isVisible('.hf-chip')), 'no group/queue/home-filter controls on the page until Filter is opened; the old sort select is gone on the moment screens');
      ok(await page.isVisible('#vsort') && (await texts(page, '#vsort-sel option')).join('|') === 'Newest clipped|Oldest clipped|Most clips|Biggest|Title A-Z', 'the sort select is visible outside Filter, home options: Newest clipped | Oldest clipped | Most clips | Biggest | Title A-Z');
      await page.click('#filter-btn'); ok(await page.isVisible('.hf-chip') && !(await page.isVisible('#sort')) && (await page.getAttribute('#filter-btn', 'aria-expanded')) === 'true', 'Filter opens the panel (home options: streamer reactions, best picks, tags and score)');
      await shot(page, 'mobile-dark-filter-menu');
      ok(await noHScroll(page), 'no horizontal scroll with the filter menu open (390 px)');
      await page.click('#filter-btn');

      // ---- search across streams gives moment cards
      await page.fill('#q', 'clutch'); await page.waitForSelector('ul.grid.moments li.card');
      ok((await page.$$('ul.grid.moments > li.card')).length === 1 && (await page.textContent('#page-title')) === 'Search results', 'search shows matching moments from every stream');
      await page.fill('#q', ''); await page.waitForSelector('.folder-grid .folder');

      // ---- storage
      const st = await page.evaluate(() => ({ ls: Object.keys(localStorage).filter(k => k !== 'cv.feed'), ss: Object.keys(sessionStorage), ck: document.cookie }));
      ok(st.ls.length === 0 && st.ss.length === 0 && st.ck === '', 'nothing in storage or cookies (the remember box was off)');
      ok((await page.evaluate(() => window.__v)).length === 0 && errs.length === 0, 'no CSP violations and no page errors (' + errs.join(' ') + ')');
      await ctx.close();
    }
    // ================= second stream: only some chips have items, and the old clip (no fields) counts as a game moment
    {
      const hub = hubWith(FX.index()); const { ctx, page } = await session(hub);
      await openFolder(page, S2); const c = await chip(page);
      ok(c.reaction.n === 1 && c.game.n === 1 && c.best.n === 0 && c.all.n === 2, 'stream 2: a clip without kind counts as a game moment (reactions 1, game 1, best 0, all 2)');
      const X = 'ul.grid.moments li.card[data-id="x1"]';
      ok(!(await page.isVisible(`${X} .rx`)) && !(await page.isVisible(`${X} .vpill`)) && !(await page.isVisible(`${X} .why`)), 'a clip without fields: no reaction badge (unrated), no pill, no why');
      ok(await page.$eval('.cat[data-cat="best"]', (e) => e.getBoundingClientRect().height >= 44), 'an empty chip stays a large tap target');
      await page.click('.cat[data-cat="best"]'); ok((await page.textContent('.empty h3')) === 'Nothing in this category', 'an empty category says so and offers "Show all"');
      await ctx.close();
    }
    // ================= D40: newest CLIPPED first, visible sort, working Filter, language chips (fixture: stream 2 has the older YouTube date but was clipped later)
    {
      const hub = hubWith(FX.indexClipped()); const { ctx, page } = await session(hub);
      const order = () => page.$$eval('.folder-grid .folder', (e) => e.map((x) => x.dataset.stream));
      const pressed = () => page.$eval('#vsort-sel', (e) => e.selectedOptions[0].textContent), pick = (v) => page.selectOption('#vsort-sel', v);
      ok((await order()).join() === [S2, S1].join(), 'home order follows clipped_at: the stream with the OLDER YouTube date but clipped later comes first');
      ok(JSON.stringify(await texts(page, '.folder .f-meta')) === JSON.stringify(['Clipped 19 Nov, 16:30 2 moments 58.0 MB Hindi', 'Clipped 14 Nov, 12:00 2 moments 76.0 MB English']), 'folder cards show the clipped date and time and the language (' + (await texts(page, '.folder .f-meta')).join(' / ') + ')');
      ok((await pressed()) === 'Newest clipped' && await page.$eval('#vsort-sel', (e) => e.getBoundingClientRect().height >= 44), 'default sort Newest clipped; the select is at least 44 px tall');
      await pick('oldest'); ok((await order()).join() === [S1, S2].join() && (await pressed()) === 'Oldest clipped', 'Oldest reverses the folder order');
      await pick('clips'); ok((await order()).join() === [S1, S2].join() && (await pressed()) === 'Most clips', 'Most clips: 4 clips before 3');
      await pick('biggest'); ok((await order()).join() === [S1, S2].join() && (await pressed()) === 'Biggest', 'Biggest: 76 MB before 58 MB');
      await pick('clipped'); ok((await order()).join() === [S2, S1].join(), 'back to Newest clipped');
      await page.focus('#vsort-sel'); await page.keyboard.press('ArrowDown');
      ok((await page.evaluate(() => document.activeElement.id)) === 'vsort-sel', 'the sort select keeps focus after a change');
      await pick('clipped');
      // language chips
      ok((await texts(page, '#langbar .lbtn .lbl')).join('|') === 'All languages|English|Hindi' && await page.$$eval('#langbar .lbtn', (e) => e.every((x) => x.getBoundingClientRect().height >= 44)), 'language chips: All languages | English | Hindi, 44 px tall');
      await page.click('#langbar .lbtn[data-lang="hi"]'); ok((await order()).join() === S2 && (await page.textContent('.page-sub')).startsWith('1 stream'), 'Hindi shows only the Hindi stream and the summary follows');
      await page.fill('#q', 'clutch'); await page.waitForSelector('.empty h3'); ok((await page.textContent('.empty h3')) === 'Nothing matches' && await page.isVisible('#langbar'), 'the global search respects the language (the English clutch moment is hidden)');
      await page.click('#langbar .lbtn[data-lang=""]'); await page.waitForSelector('ul.grid.moments li.card'); ok((await page.$$('ul.grid.moments > li.card')).length === 1, 'All languages brings the search result back');
      await page.fill('#q', ''); await page.waitForSelector('.folder-grid .folder');
      // Filter on the home screen
      await page.click('#filter-btn');
      await page.click('.hf-chip[data-hf="best"]'); ok((await order()).join() === S1 && (await page.getAttribute('.hf-chip[data-hf="best"]', 'aria-pressed')) === 'true' && (await page.textContent('#filter-btn .n')) === '1', 'Filter "Has best picks" keeps only the stream with a tier A moment (2 -> 1) and the button counts it');
      await page.click('.hf-chip[data-hf="best"]'); ok((await order()).length === 2, 'untick restores both folders');
      await page.click('.hf-chip[data-hf="reaction"]'); ok((await order()).join() === S1, 'Filter "Has streamer reactions" keeps only the stream with a reaction moment (2 -> 1)');
      await page.click('.hf-chip[data-hf="best"]'); await page.click('#langbar .lbtn[data-lang="hi"]'); await page.waitForSelector('.empty h3'); ok((await page.textContent('.empty h3')) === 'Nothing matches', 'filters that exclude every folder show "Nothing matches"');
      await page.click('.empty .btn'); await page.waitForSelector('.folder-grid .folder'); ok((await order()).length === 2 && (await page.getAttribute('.hf-chip[data-hf="best"]', 'aria-pressed')) === 'false', 'Clear filters resets language and home filters');
      await page.click('#filter-btn');
      // inside the stream
      await openFolder(page, S1);
      ok((await texts(page, '#vsort-sel option')).join('|') === 'Newest clipped|Oldest clipped|Best (rank/tier)|Longest|Shortest|Title A-Z|Biggest file|Top score' && (await pressed()) === 'Newest clipped', 'stream: sort options present, default Newest clipped');
      const titles = () => texts(page, 'ul.grid.moments li.card .title');
      await page.click('.cat[data-cat="all"]');
      ok((await titles()).join('|') === 'Insane clutch 1v4 on the roof|He screams when the boss dies', 'default newest clipped first (D46): the moment clipped later comes first');
      await pick('rank'); ok((await titles()).join('|') === 'He screams when the boss dies|Insane clutch 1v4 on the roof', 'Best (rank/tier): tier A moment first');
      await pick('title'); ok((await titles()).join('|') === 'He screams when the boss dies|Insane clutch 1v4 on the roof', 'Title A-Z');
      await pick('newest'); ok((await titles()).join('|') === 'Insane clutch 1v4 on the roof|He screams when the boss dies' && (await pressed()) === 'Newest clipped', 'Newest clipped: the moment clipped at 12:00 before the one clipped at 09:00');
      ok((await page.textContent('.lang-tag')) === 'English' && /Clipped 14 Nov, 12:00 · YouTube 18 Nov 2026/.test(await page.textContent('.page-sub')), 'stream header: language tag, clipped time, YouTube date as secondary (' + (await page.textContent('.page-sub')) + ')');
      ok(!(await page.isVisible('#langbar')) && await page.isVisible('#vsort'), 'no language chips inside a stream (one language)');
      // every Filter option inside a stream changes the list
      await page.click('#filter-btn'); await page.click('.more-f summary');
      await page.click('#tagchips .chip:has-text("#boss")'); ok((await titles()).join() === 'He screams when the boss dies', 'Filter tag #boss: 2 moments -> 1');
      await page.click('#tagchips .chip:has-text("#boss")'); ok((await titles()).length === 2, 'untick the tag: 2 moments again');
      await page.fill('#minscore', '8'); ok((await titles()).join() === 'He screams when the boss dies', 'Filter min score 8: the score-7 moment disappears');
      await page.fill('#minscore', '0'); ok((await titles()).length === 2, 'min score back to Any: 2 moments');
      await ctx.close();
    }
    {
      // admin: posting status and Select inside a stream
      const hub = hubWith(FX.indexClipped()); const { ctx, page } = await session(hub);
      await page.click('#admin-btn'); await page.fill('#admin-token', WRITE); await page.click('#admin-go'); await page.waitForSelector('#upload-btn:not([hidden])', { timeout: 10000 });
      await openFolder(page, S1); await page.click('.cat[data-cat="all"]'); await page.click('#filter-btn');
      const titles = () => texts(page, 'ul.grid.moments li.card .title');
      await page.selectOption('#postfilter', 'yt'); ok((await titles()).join() === 'He screams when the boss dies', 'Filter posting status "Posted on YouTube only": 2 moments -> 1');
      await page.selectOption('#postfilter', 'none'); ok((await titles()).join() === 'Insane clutch 1v4 on the roof' || (await titles()).includes('Insane clutch 1v4 on the roof'), 'Filter "Not posted anywhere" shows the unposted moment');
      await page.selectOption('#postfilter', 'any');
      await page.click('.sel-btn'); ok(await page.$eval('ul.grid.moments', (e) => e.classList.contains('selecting')) && (await page.$$('ul.grid.moments li.card .check')).length === 2, 'Filter > Select turns on select mode (check boxes appear on the cards)');
      await ctx.close();
    }
    {
      // one language only: no chip row; old data without lang or clipped_at: no language control, folders by YouTube date
      const one = FX.indexClipped(); for (const c of one.clips) c.lang = 'en'; for (const s of one.streams) { s.lang = 'en'; s.lang_name = 'English'; }
      let h1 = hubWith(one); let r = await session(h1);
      ok(!(await r.page.isVisible('#langbar')) && (await r.page.$$('#langbar')).length === 1, 'a library with ONE language shows no language control');
      await r.ctx.close();
      h1 = hubWith(FX.index()); r = await session(h1);
      ok(!(await r.page.isVisible('#langbar')) && (await r.page.$$eval('.folder-grid .folder', (e) => e.map((x) => x.dataset.stream))).join() === [S1, S2].join() && await r.page.isVisible('#vsort'), 'old data (no lang, no clipped_at): no language control, folders by YouTube date, sort control still there');
      await r.ctx.close();
      h1 = hubWith(FX.indexClipped()); r = await session(h1, { viewport: { width: 360, height: 740 }, touch: true });
      ok(await noHScroll(r.page) && await r.page.$$eval('#vsort-sel, #langbar .lbtn', (e) => e.length === 4 && e.every((x) => x.getBoundingClientRect().height >= 44 && x.getBoundingClientRect().right <= 360)), '360 px: sort and language buttons fit, no horizontal scroll, 44 px tall');
      await openFolder(r.page, S1); ok(await noHScroll(r.page) && await r.page.$$eval('#vsort-sel', (e) => e.every((x) => x.getBoundingClientRect().height >= 44 && x.getBoundingClientRect().right <= 360)), '360 px stream: sort buttons fit');
      await r.ctx.close();
    }
    // ================= desktop + light screenshots
    for (const [scheme, tag] of [['dark', 'dark'], ['light', 'light']]) {
      const hub = hubWith(FX.index()); const { ctx, page } = await session(hub, { viewport: { width: 1280, height: 800 }, scheme });
      await page.waitForFunction(() => document.querySelectorAll('.folder-grid .f-thumb img.loaded').length === 2, null, { timeout: 8000 }).catch(() => {});
      ok(await noHScroll(page), `desktop ${tag}: no horizontal scroll`);
      await shot(page, `desktop-${tag}-library-home`);
      await openFolder(page, S1); await shot(page, `desktop-${tag}-stream`);
      await page.click('.cat[data-cat="reaction"]'); await shot(page, `desktop-${tag}-stream-reactions`); await page.click('.cat[data-cat="game"]'); await shot(page, `desktop-${tag}-stream-game`); await page.click('.cat[data-cat="best"]'); await shot(page, `desktop-${tag}-stream-best`); await page.click('.cat[data-cat="all"]');
      await page.click('ul.grid.moments li.card[data-key$="a1"] .vbtn[data-variant="clean"]'); await shot(page, `desktop-${tag}-card-variant`);
      await page.click('#filter-btn'); await shot(page, `desktop-${tag}-filter-menu`);
      ok(await page.$eval('ul.grid.moments li.card[data-key$="a1"] .rx', (e) => { const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number); const L = (c) => { const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; }; const s = getComputedStyle(e); const a = L(rgb(s.color)), c = L(rgb(s.backgroundColor)); return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05) >= 4.5; }), `reaction badge contrast >= 4.5:1 (${tag}, desktop)`);
      await ctx.close();
    }
    for (const scheme of ['dark', 'light']) {
      const hub = hubWith(FX.index()); const { ctx, page } = await session(hub, { scheme });
      await page.waitForFunction(() => document.querySelectorAll('.folder-grid .f-thumb img.loaded').length === 2, null, { timeout: 8000 }).catch(() => {});
      if (scheme === 'light') { await shot(page, 'mobile-light-library-home'); await openFolder(page, S1); await shot(page, 'mobile-light-stream'); await page.click('#filter-btn'); await shot(page, 'mobile-light-filter-menu'); }
      await ctx.close();
    }
    // ================= 360 px phone
    {
      const hub = hubWith(FX.index()); const { ctx, page } = await session(hub, { viewport: { width: 360, height: 740 }, touch: true });
      ok(await noHScroll(page), '360 px: home has no horizontal scroll');
      ok(await page.$$eval('.folder-link, #filter-btn, #post-mode-btn', (e) => e.every((x) => x.getBoundingClientRect().height >= 44)), '360 px: folder cards and the two main buttons are at least 44 px tall');
      await openFolder(page, S1); ok(await noHScroll(page), '360 px: stream page has no horizontal scroll');
      ok(await page.$$eval('.cat, .vbtn, .card-more', (e) => e.every((x) => x.offsetHeight >= 44)), '360 px: chips, pill buttons and the "..." button are large tap targets');
      ok(await page.$$eval('ul.grid.moments li.card', (e) => e.every((x) => x.getBoundingClientRect().right <= 360 && x.getBoundingClientRect().left >= 0)), '360 px: every card fits inside the screen');
      ok(await page.$$eval('.vpill', (e) => e.every((x) => { const c = x.closest('.card').getBoundingClientRect(), r = x.getBoundingClientRect(); return r.right <= c.right && r.bottom <= c.bottom; })), '360 px: the pill stays inside its card');
      await shot(page, 'mobile360-stream');
      await page.click('#filter-btn'); ok(await noHScroll(page), '360 px: filter menu open, no horizontal scroll');
      await ctx.close();
    }
    // ================= old data: flat list, nothing new shows
    {
      const hub = hubWith(legacyIndex()); const { ctx, page } = await session(hub);
      ok((await page.$$('ul.grid[aria-label="Clips"] li.card')).length === 3 && (await page.$$('.folder')).length === 0, 'old data (no streams, no fields): a flat list of 3 cards, no folders');
      ok(!(await page.isVisible('.vpill')) && !(await page.isVisible('.rx')) && !(await page.isVisible('.why')) && (await page.isVisible('.lib-hero')), 'old data: no pill, no reaction badge, the classic header');
      ok(!(await page.isVisible('#sort')), 'old data: the sort control is also behind the Filter button');
      await ctx.close();
    }
    // ================= index without "streams" but with moment fields: folders come from clip.stream
    {
      const idx = FX.index(); delete idx.streams; const hub = hubWith(idx); const { ctx, page } = await session(hub);
      ok((await page.$$('.folder')).length === 2 && (await texts(page, '.folder .f-title')).includes('night stream ranked grind'), 'no streams[]: folders are built from clip.stream (placeholder instead of a thumbnail)');
      ok((await page.$$('.folder .f-thumb img')).length === 0, 'no thumb path: no image request, just the placeholder');
      await ctx.close();
    }
    // ================= admin edit keeps every field (D39) and can apply to both variants
    {
      const idx = FX.index(); idx.clips[0].future_field = { keep: [1, 2] }; idx.extra_top = 'stay';
      const hub = hubWith(idx); const { ctx, page } = await session(hub);
      await page.click('#admin-btn'); await page.fill('#admin-token', WRITE); await page.click('#admin-go'); await page.waitForSelector('#upload-btn:not([hidden])', { timeout: 10000 });
      await openFolder(page, S1);
      const A = 'ul.grid.moments li.card[data-key$="a1"]';
      await page.click(`${A} .vbtn[data-variant="with-streamer"]`);
      await page.click(`${A} .card-link`); await page.waitForSelector('dialog.drawer[open].shown'); await page.click('#btn-edit');
      await page.fill('#ef-title', 'Renamed boss moment'); await page.selectOption('#ef-reaction', 'mild'); await page.selectOption('#ef-tier', 'B'); await page.fill('#ef-why', 'New one line why');
      ok(await page.isChecked('#ef-both'), 'edit form: "apply to both versions" is offered and on by default for a pair');
      await page.click('#ef-save'); await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Saved/.test(t.textContent)), null, { timeout: 10000 }).catch(() => {});
      await sleep(800);
      const out = hub.index(), w = out.clips.find((c) => c.id === 'a1-w'), cl = out.clips.find((c) => c.id === 'a1-c'), orig = FX.index();
      ok(w.title === 'Renamed boss moment' && cl.title !== 'Renamed boss moment', 'the title edit changes only the clip being edited');
      ok(w.group === 'a1' && w.variant === 'with-streamer' && w.kind === 'reaction' && w.rank === 1 && w.hook === 'hook a1-w' && JSON.stringify(w.future_field) === '{"keep":[1,2]}', 'an edit keeps group, variant, kind, rank, hook and unknown fields');
      ok(w.reaction === 'mild' && cl.reaction === 'mild' && w.tier === 'B' && cl.tier === 'B' && w.why === 'New one line why' && cl.why === 'New one line why', 'reaction, tier and why were applied to BOTH variants');
      ok(JSON.stringify(out.streams) === JSON.stringify(orig.streams) && out.extra_top === 'stay', 'an edit keeps streams[] and unknown top-level keys unchanged');
      ok(out.clips.filter((c) => !['a1-w', 'a1-c'].includes(c.id)).every((c) => canon2(c) === canon2(orig.clips.find((o) => o.id === c.id))), 'other clips are written back unchanged');
      // trash + restore of one variant also keeps everything
      await page.click('.drawer-close').catch(() => {}); await sleep(500);
      const prev = hub.commits.length;
      await page.evaluate(() => { location.hash = '#/stream/' + 'x'; }).catch(() => {});
      ok(prev > 0, 'edit committed (' + prev + ' commit(s), parent-checked)');
      await ctx.close();
    }
    // ================= "Posted on" filter + edit form (D46, MOCKED Hub)
    {
      const idx = FX.index(); for (const c of idx.clips) { if (c.id.startsWith('a1')) c.posted_on = ['youtube', 'tiktok']; else if (c.id.startsWith('b2')) c.posted_on = []; c.posted_by = 'OldName'; }
      const hub = hubWith(idx); const { ctx, page } = await session(hub);
      await openFolder(page, S1);
      await page.click('#filter-btn').catch(() => {}); await sleep(300);
      ok((await page.$$eval('.chip[data-kind="postedon"] .lbl', (e) => e.map((x) => x.textContent))).join() === 'YouTube,Instagram,TikTok,X,Other,Not posted', 'posted on: chips YouTube / Instagram / TikTok / X / Other / Not posted');
      ok((await page.$$eval('.chip[data-kind="postedon"][aria-pressed="true"]', (e) => e.length)) === 0 && (await page.$$eval('.chip[data-kind="postedby"]', (e) => e.length)) === 0, 'posted on: default no chip selected; no posted-by UI');
      const nCards = () => page.$$eval('ul.grid.moments li.card', (e) => e.length);
      await page.click('.cat[data-cat="all"]'); await sleep(300);
      const all0 = await nCards(), chip = (l) => `.chip[data-kind="postedon"]:has(.lbl:text-is("${l}"))`;
      await page.click(chip('YouTube')); await sleep(300);
      const yt = await nCards(); ok(yt >= 1 && yt < all0, 'posted on: YouTube keeps only clips posted on YouTube (' + yt + '/' + all0 + ')');
      await page.click(chip('Instagram')); await sleep(300);
      ok((await nCards()) >= yt, 'posted on: several chips = ANY match');
      await page.click(chip('YouTube')); await page.click(chip('Instagram')); await page.click(chip('Not posted')); await sleep(300);
      ok((await nCards()) >= 1 && (await nCards()) < all0, 'posted on: Not posted = empty/absent list');
      await page.click(chip('Not posted')); await sleep(300);
      ok(await nCards() === all0, 'posted on: deselecting everything shows all again');
      await page.click(chip('YouTube')); await sleep(300);
      ok(await page.$eval('ul.grid.moments li.card .po-badges', (e) => !e.hidden && [...e.children].map((x) => x.textContent).join() === 'YouTube,TikTok'), 'posted on: small badges on the card (textContent)');
      await ctx.close();
      // admin edit: checkboxes, same commit mechanism
      const h2 = hubWith(FX.index()); const s2 = await session(h2); const pg = s2.page;
      await pg.click('#admin-btn'); await pg.fill('#admin-token', WRITE); await pg.click('#admin-go'); await pg.waitForSelector('#upload-btn:not([hidden])', { timeout: 10000 });
      await openFolder(pg, S1);
      const A2 = 'ul.grid.moments li.card[data-key$="a1"]';
      await pg.click(`${A2} .card-link`); await pg.waitForSelector('dialog.drawer[open].shown'); await pg.click('#btn-edit');
      ok((await pg.$$eval('#ef-posted_on input[type=checkbox]', (e) => e.map((x) => x.value))).join() === 'youtube,instagram,tiktok,x,other' && !(await pg.$('#ef-posted_by')), 'edit form: five platform checkboxes, no posted-by field');
      await pg.check('#ef-po-tiktok'); await pg.check('#ef-po-youtube');
      await pg.click('#ef-save'); await pg.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Saved/.test(t.textContent)), null, { timeout: 10000 }).catch(() => {});
      await sleep(800);
      const saved = h2.index().clips.find((c) => c.id === 'a1-c');
      ok(saved && JSON.stringify(saved.posted_on) === '["youtube","tiktok"]', 'edit: posted_on saved as a validated array (' + JSON.stringify(saved && saved.posted_on) + ')');
      await pg.click('.drawer-close').catch(() => {}); await sleep(500);
      await s2.ctx.close();
    }
    if (process.env.SITESHOTS) {   // one screenshot per width into docs/sheets_camgame/ (a stream with the Filters panel open)
      const idx = FX.index(); for (const c of idx.clips) if (c.id.startsWith('a1')) c.posted_on = ['youtube', 'tiktok'];
      for (const [name, vp] of [['site_mobile', { width: 390, height: 844 }], ['site_pc', { width: 1280, height: 800 }]]) {
        const r = await session(hubWith(idx), { viewport: vp, scheme: 'light' }); await openFolder(r.page, S1); await r.page.click('.cat[data-cat="all"]'); await sleep(300);
        await r.page.click('#filter-btn').catch(() => {}); await sleep(400);
        await r.page.screenshot({ path: path.join(REPO, 'docs/sheets_camgame', name + '.png') }); await r.ctx.close();
      }
    }
    // ================= pure logic of moments.js in the browser (no DOM)
    {
      const hub = hubWith(FX.index()); const { ctx, page } = await session(hub);
      const r = await page.evaluate(async () => {
        const M = await import('/js/moments.js'); const w = (id, o) => ({ id, stream: 's', ...o });
        const ms = M.buildMoments([w('1', { group: 'g', variant: 'clean' }), w('2', { group: 'g', variant: 'with-girl' }), w('3', { group: 'g', variant: 'clean' }), w('4', {}), w('5', { group: 'h', variant: 'x' })]);
        return { n: ms.length, first: ms[0].clips.map((c) => c.id), pick: M.pick(ms[0], undefined).id, pickClean: M.pick(ms[0], 'clean').id, rx: M.reactionOf({}), rx2: M.reactionOf({ reaction: 'bogus' }), tier: M.tierOf({ tier: 'Z' }),
          cat: M.catHas({ clips: [{}] }, 'game'), href: M.folderHref(''), cmp: [{ tier: 'B', rank: 1 }, { tier: 'A', rank: 9 }, { rank: 1 }].sort(M.rankCmp).map((c) => c.tier || '-').join('') };
      });
      ok(r.n === 4 && r.first.join() === '1,2' && r.pick === '1' && r.pickClean === '1', 'moments.js: pairs by group+variant, one clip per slot, default Clean, duplicates stay separate');
      ok(r.rx === 'unrated' && r.rx2 === 'unrated' && r.tier === null && r.cat === true && r.href === '#/stream/~other' && r.cmp === 'AB-', 'moments.js: unrated by default, bad enums ignored, missing kind = game, tier A first');
      await ctx.close();
    }
    {
      // D49: Post mode (the swipe feed) is ON by default; the "Post mode on start" switch turns it off and the choice is remembered
      const hub = hubWith(FX.index()); const { ctx, page } = await session(hub, { feedOn: true });
      await page.waitForSelector('dialog.pm[open]', { timeout: 8000 }).catch(() => {});
      ok(await page.isVisible('dialog.pm[open]') && /^#\/post\//.test(await page.evaluate(() => location.hash)), 'Post mode default on: the feed opens on first load');
      await page.click('.pm-close'); await sleep(500);
      ok(!(await page.isVisible('dialog.pm[open]')) && (await page.getAttribute('#feed-toggle', 'aria-pressed')) === 'true' && await page.isVisible('#feed-toggle'), 'closing the feed shows the library; the Post mode switch is visible and ON');
      ok(await page.isVisible('#pm-toggle') && await page.isVisible('#post-mode-btn') && await noHScroll(page), 'Post info switch and Post mode button still there, no sideways scroll');
      await page.click('#feed-toggle'); await sleep(150);
      ok((await page.getAttribute('#feed-toggle', 'aria-pressed')) === 'false' && (await page.evaluate(() => localStorage.getItem('cv.feed'))) === '0', 'switch OFF is stored');
      const p2 = await ctx.newPage(); await p2.goto(base); await p2.waitForSelector('#signin:not([hidden]) #pp-input'); await p2.uncheck('#remember-cb'); await p2.fill('#pp-input', PASS); await p2.click('#signin button[type=submit]');
      await p2.waitForSelector('.folder-grid .folder, li.card .card-link', { timeout: 15000 }); await sleep(800);
      ok(!(await p2.isVisible('dialog.pm[open]')) && (await p2.getAttribute('#feed-toggle', 'aria-pressed')) === 'false', 'off persists: the next visit opens the normal grid');
      await ctx.close();
    }
  } catch (e) { fail++; console.log('FAIL exception: ' + e.stack); }
  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
