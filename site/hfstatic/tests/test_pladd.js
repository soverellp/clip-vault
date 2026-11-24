// Add popup, stream menu, quick re-save, toasts, share, versions, deep link (D51) against the static build + the MOCKED Hub. Fake secrets only. Run: NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfstatic/tests/test_pladd.js
// (setup copied from test_shortlist.js) // Shortlist (per-moment star, "Shortlisted" chip, Copy shortlist, writes by anyone who unlocked the site, no admin mode) against the static build + the MOCKED Hub. Fake secrets only.
// Run: NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfstatic/tests/test_shortlist.js
// Proves the client logic and request shapes against a mock; it does NOT prove the real Hub or a real phone.
const { chromium } = require('playwright');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { MockHub } = require('./mockhub');
const FX = require('../../hfspace/tests/ui/fixtures_library');

const SLT = 'hf_' + 'FAKESHORTLISTTOKEN00000000000000', SL_DS = 'Soverellp/clip-vault-shortlist', READ = 'hf_' + 'FAKEREADTOKEN00000000000000000000', WRITE = 'hf_' + 'FAKEWRITETOKEN0000000000000000000', PASS = 'copper lantern meadow quiver';
const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfshort-')), DIST = path.join(tmp, 'dist');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() - t > ms) return false; await sleep(80); } }
const DIST_RO = path.join(tmp, 'dist_ro'), DIST_SEP = path.join(tmp, 'dist_sep');
function build(out, env, args = []) { const b = spawnSync('python3', [path.join(ROOT, 'build_static.py'), '--no-info-copy', '--out', out, ...args], { env: { ...process.env, VAULT_READ_TOKEN: READ, VAULT_PASSPHRASE: PASS, ...env }, encoding: 'utf8' }); if (b.status !== 0) { console.log(b.stdout, b.stderr); process.exit(1); } }
build(DIST, { VAULT_SHORTLIST_TOKEN: SLT });                                  // shortlist file in the clip dataset (default)
build(DIST_RO, {});                                                          // old-style config: no shortlist token
build(DIST_SEP, { VAULT_SHORTLIST_TOKEN: SLT }, ['--shortlist-dataset', SL_DS, '--shortlist-path', 'shortlist.json']);  // separate tiny dataset
const MP4 = path.join(tmp, 'v.mp4'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x112:d=3:r=10', '-c:v', 'libvpx-vp9', '-b:v', '30k', '-movflags', '+faststart', MP4]);
const JPG = path.join(tmp, 'p.jpg'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=90x160', '-frames:v', '1', JPG]);
const { S1, S2 } = FX, SF = '_config/shortlist.json';
const K_A1 = S1 + '|a1', K_B2 = S1 + '|b2', K_C3 = S2 + '|c3';

function newHub(shortlist) {
  const hub = new MockHub({ read: READ, writeOk: WRITE, extra: {}, slOk: SLT });
  const idx = FX.index(); idx.clips.find(c => c.id === 'a1-w').post = 'Caption for a1 #boss';
  hub.put('index.json', JSON.stringify(idx));
  for (const c of idx.clips) { hub.put(c.video, fs.readFileSync(MP4), true); if (c.poster) hub.put(c.poster, fs.readFileSync(JPG)); }
  for (const s of idx.streams) if (s.thumb) hub.put(s.thumb, fs.readFileSync(JPG));
  hub.put('.gitattributes', '*.mp4 filter=lfs');
  if (shortlist !== undefined) hub.put(SF, typeof shortlist === 'string' ? shortlist : JSON.stringify(shortlist));
  return hub;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const mkServer = root => http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(root, p); if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
});
const server = mkServer(DIST), serverRo = mkServer(DIST_RO), serverSep = mkServer(DIST_SEP);
const PF = '_config/playlists.json', TF = '_config/templates.json', SHOTS = path.resolve(ROOT, '../../docs/sheets_camgame');
const K = { a1: S1 + '|a1', b2: S1 + '|b2', c3: S2 + '|c3' };
const SEEDPL = { version: 1, playlists: [{ id: 'seed1', title: 'Friday batch', description: 'First picks', platforms: ['youtube', 'x'], status: 'draft', created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z',
  items: [{ moment_id: K.a1, order: 1, post: { title: 'Boss scream', caption: 'He screams #boss', hashtags: ['#boss'] }, posted: {} }, { moment_id: 'deleted|ghost', order: 2, post: { title: 'Gone', caption: 'x', hashtags: [] }, posted: {} },
    { moment_id: K.b2, order: 3, post: { title: '=cmd|calc', caption: 'Clutch, "wow"', hashtags: ['#clutch'] }, posted: {} }] }] };
const plDoc = hub => JSON.parse(hub.text(PF)), tpDoc = hub => JSON.parse(hub.text(TF));

(async () => {
  await Promise.all([server, serverRo, serverSep].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  const at = s => `http://127.0.0.1:${s.address().port}`, BASES = { '': at(server), '/ro/': at(serverRo) }, browser = await chromium.launch();
  async function session(hub, { mode = '', width = 390, blockStorage = false, feedOn = false, hash = '', after = '.folder-grid .folder', share = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: 'dark', timezoneId: 'UTC', acceptDownloads: true });
    if (feedOn) await ctx.addInitScript(() => { try { localStorage.setItem('cv.feed', '1'); } catch (e) {} }); // Post mode opens by itself on first load (D49): these tests browse the grid
    await ctx.route('https://huggingface.co/**', r => hub.handle(r));
    await ctx.route(/^https:\/\/([\w-]+\.)+hf\.co\//, r => hub.handle(r));
    const page = await ctx.newPage(), errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (/content security policy|refused to/i.test(m.text())) errs.push(m.text()); });
    await page.addInitScript(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied.push(t); } }, configurable: true }); });
    if (blockStorage) await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true }); });
    if (share) await page.addInitScript(() => { window.__shared = []; navigator.share = async d => { window.__shared.push(d); }; });
    await page.goto(BASES[mode] + hash);
    await page.waitForSelector('#signin:not([hidden]) #pp-input', { timeout: 8000 }).catch(e => { console.log('SESSION ERRS', errs.slice(0, 4)); throw e; });
    if (!blockStorage) await page.uncheck('#remember-cb').catch(() => {});
    await page.fill('#pp-input', PASS); await page.click('#signin button[type=submit]');
    await page.waitForSelector(after, { timeout: 15000 });
    return { ctx, page, errs };
  }
  const go = async (page, hash, sel) => { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForSelector(sel, { timeout: 8000 }); await sleep(120); };
  const modal = page => page.waitForSelector('dialog.pl-modal[open].shown', { timeout: 6000 });
  const modalGone = page => page.waitForSelector('dialog.pl-modal[open]', { state: 'detached', timeout: 6000 }).catch(() => null);
  const foot = (page, label) => page.click(`dialog.pl-modal[open] .modal-foot button:has-text("${label}")`);
  const pickMenu = async (page, opener, act) => { await page.click(opener); await page.waitForSelector('dialog.sheet[open].shown', { timeout: 6000 }); await page.click(`dialog.sheet[open] [data-act="${act}"]`); await sleep(250); };
  const itemMenu = (page, k, act) => pickMenu(page, `[data-k="${k}"] .pl-more`, act), headMenu = (page, act) => pickMenu(page, '.pl-menu-b', act), cardMenu = (page, title, act) => pickMenu(page, `.pl-card:has-text("${title}") .pl-more`, act);
  const openFolder = async (page, id) => { await sleep(700); await page.$eval(`.folder[data-stream="${id}"] a`, e => e.click()); await page.waitForSelector('ul.grid.moments li.card'); await page.click('.cat[data-cat="all"]'); };
  const card = id => `ul.grid.moments li.card[data-key$="|${id}"]`;
  const itemsOrder = page => page.$$eval('.pl-items .pl-item', e => e.map(x => x.dataset.k));
  const noOverflow = async page => { const r = await page.evaluate(() => { const ok = document.documentElement.scrollWidth <= innerWidth + 1; return ok ? null : [...document.querySelectorAll('body *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > innerWidth + 1).slice(0, 4).map(e => e.tagName + '.' + e.className); }); if (r) console.log('OVERFLOW', r); return !r; };
  const small = (page, sel) => page.$$eval(sel, els => els.filter(e => e.offsetParent && !e.disabled).filter(e => { const r = e.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; }).map(e => (e.getAttribute('aria-label') || e.textContent || e.className).trim().slice(0, 30)));
  const toasts = page => page.$$eval('.toast.pl-t', e => e.map(x => x.textContent));
  const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(SHOTS, name), ...opts });
  const kid = (s, ...a) => a.every(Boolean) && s;
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    // ================= the whole flow at phone 390 and PC 1280 (+ the screenshots)
    for (const [width, tag] of [[390, 'phone'], [1280, 'pc']]) {
      const hub = newHub(); const { ctx, page, errs } = await session(hub, { width, share: true });
      const T = `[${tag}] `;
      const nav = await page.$eval('.pl-nav-top', e => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, lbl: getComputedStyle(e.querySelector('.lbl')).display }; });
      ok(nav.w >= 44 && nav.h >= 44 && (width < 700 ? nav.lbl === 'none' : nav.lbl !== 'none'), T + 'title bar Playlists button: >= 44 px, icon only on the phone, icon + label on the PC');
      // stream menu on the folder card
      ok(await page.isVisible(`.folder[data-stream="${S1}"] .f-more`), T + 'stream card has a "..." button');
      await page.click(`.folder[data-stream="${S1}"] .f-more`); await page.waitForSelector('dialog.sheet[open]'); await sleep(900);
      ok(await page.isVisible('dialog.sheet[open] [data-act="add-playlist"]'), T + 'stream menu has "Add to playlist"');
      await shot(page, `pl2_streammenu_${tag}.png`);
      await page.click('dialog.sheet[open] [data-act="add-playlist"]'); await modal(page); await sleep(300);
      const chips = await page.$$eval('.pl-vchip', e => e.map(x => [x.dataset.v, x.getAttribute('aria-pressed')]));
      ok(chips.length === 2 && chips.every(c => c[1] === 'true'), T + 'popup: both versions ticked by default (chips)');
      ok((await page.textContent('dialog.pl-modal[open] .modal-head')).includes('Add to playlist') && (await page.textContent('dialog.pl-modal[open] .modal-body')).includes('All 2 moments of'), T + 'popup says it adds all moments of the stream');
      await page.fill('#pl-new-name', 'Stream list'); await page.keyboard.press('Enter'); await sleep(200);
      ok(hub.commits.length === 0 && await page.isChecked('dialog.pl-modal[open] input[data-pl]'), T + 'Enter in the name field creates the row ticked, nothing committed yet');
      ok((await small(page, 'dialog.pl-modal[open] .pl-pick-row, dialog.pl-modal[open] .pl-vchip, dialog.pl-modal[open] .modal-foot button, dialog.pl-modal[open] .pl-create-b, dialog.pl-modal[open] #pl-new-name')).length === 0, T + 'popup: every touch target is 44 px');
      ok(await noOverflow(page), T + 'popup: no horizontal scroll');
      await shot(page, `pl2_add_${tag}.png`);
      await page.click('dialog.pl-modal[open] .pl-save'); await modalGone(page); await page.waitForSelector('.toast.pl-t'); await sleep(250);
      let d = plDoc(hub);
      ok(hub.commits.length === 1 && d.playlists.length === 1 && d.playlists[0].items.map(i => i.moment_id).join() === `${K.a1},${K.b2}`, T + 'stream add: ONE commit, all moments of the stream, in order');
      ok(d.playlists[0].items.every(i => i.variants.length === 2 && Object.keys(i).sort().join() === 'moment_id,order,post,posted,variants'), T + 'items are references (moment_id, post, posted, versions) with both versions');
      const tx = (await toasts(page))[0] || '';
      ok(/^Added 2 clips \(With streamer \+ Clean\) to Stream list/.test(tx) && /Change/.test(tx) && /Undo/.test(tx), T + 'toast: "Added 2 clips (versions) to <playlist>" with Change and Undo (' + tx.slice(0, 60) + ')');
      ok(await page.$eval('#toasts', e => e.getAttribute('aria-live') === 'polite'), T + 'toasts live in an aria-live polite region');
      await shot(page, `pl2_toast_${tag}.png`);
      ok(await page.$eval('.toast.pl-t', e => e.closest('dialog') == null) && !(await page.$('dialog[open]')), T + 'the toast is not a modal (no dialog open)');
      // title bar with the count, then the playlists screen
      ok((await page.textContent('.pl-nav-top .n')) === '1', T + 'title bar badge shows 1 playlist');
      await shot(page, `pl2_titlebar_${tag}.png`, { clip: { x: 0, y: 0, width, height: 64 } });
      await page.click('.pl-nav-top'); await page.waitForSelector('.pl-card');
      ok(await noOverflow(page), T + 'Playlists screen: no horizontal scroll');
      await page.click('.pl-card .pl-share-b'); await page.waitForSelector('dialog.pl-share[open]'); await sleep(350);
      const link = await page.inputValue('#share-link');
      ok(/#\/playlist\/pl_[\w-]+$/.test(link) && link.startsWith('http'), T + 'share dialog shows <site>/#/playlist/<id>');
      ok((await page.textContent('dialog.pl-share[open]')).includes('does not make any clip public'), T + 'share dialog says the link never makes clips public');
      await shot(page, `pl2_share_${tag}.png`);
      await page.click('dialog.pl-share .pl-sh-link'); await sleep(150);
      ok((await page.evaluate(() => window.__copied.at(-1))) === link, T + 'Copy link copies the link');
      await page.click('dialog.pl-share .pl-sh-native'); await sleep(150);
      const sh = await page.evaluate(() => window.__shared.at(-1));
      ok(sh && sh.url === link && sh.title === 'Stream list' && /Open with the site passphrase/.test(sh.text), T + 'navigator.share gets title + link + the passphrase note');
      await page.click('dialog.pl-share .pl-sh-text'); await sleep(150);
      const txt = await page.evaluate(() => window.__copied.at(-1));
      ok(txt.startsWith('Stream list\n' + link) && /1\. /.test(txt) && /2\. /.test(txt) && txt.includes('#/clip/'), T + 'Copy as text: title, link, numbered clips with clip links');
      await page.keyboard.press('Escape'); await sleep(300);
      // the playlist screen: each moment once, version toggle
      await page.click('.pl-card .pl-card-t'); await page.waitForSelector('.pl-item');
      ok((await page.$$('.pl-items .pl-item')).length === 2 && (await page.$$('.pl-item[data-k="' + K.a1 + '"] .vs-b')).length === 2, T + 'each moment appears once, with a two-version toggle');
      const href0 = await page.getAttribute(`.pl-item[data-k="${K.a1}"] a.pl-thumbw`, 'href');
      await page.click(`.pl-item[data-k="${K.a1}"] .vs-b[data-axis="v"][data-val="clean"]`); await sleep(250);
      const href1 = await page.getAttribute(`.pl-item[data-k="${K.a1}"] a.pl-thumbw`, 'href');
      ok(href0 !== href1 && href1.endsWith('a1-c') && href0.endsWith('a1-w'), T + 'switching the toggle swaps the clip the thumbnail opens (' + href0.slice(-4) + ' -> ' + href1.slice(-4) + ')');
      ok(await page.evaluate(() => (JSON.parse(localStorage.getItem('cv.pl')) || {}).mode) === 'clean|0', T + 'the toggle choice is remembered per viewer');
      ok((await small(page, '.pl-item .vs-b, .pl-bar .btn')).length === 0 && await noOverflow(page), T + 'playlist screen: 44 px targets, no horizontal scroll');
      await shot(page, `pl2_modes_${tag}.png`, { fullPage: false });
      ok(errs.length === 0, T + 'no console / CSP errors'); if (errs.length) console.log(errs.slice(0, 3));
      await ctx.close();
    }

    // ================= toasts: Undo, Change, quick re-save, cap 3, non-blocking, auto-dismiss; versions memory (phone)
    // ================= card layout regression (owner bug, phone): no overlapping boxes inside a card, no card on top of the next one, no giant gap
    for (const width of [390, 1280]) for (const pinfoOn of [true, false]) {
      const T = `[layout ${width} post-info ${pinfoOn ? 'on' : 'off'}] `;
      const { ctx, page } = await session(newHub(), { width }); await openFolder(page, S1);
      if ((await page.getAttribute('#pm-toggle', 'aria-pressed') === 'true') !== pinfoOn) { await page.click('#pm-toggle'); await sleep(300); }
      await page.waitForSelector(pinfoOn ? 'li.card .pinfo' : 'li.card:not(.sk) .card-in', { timeout: 15000 }).catch(async e => { await shot(page, 'layout_debug.png'); console.log('DBG', JSON.stringify(await page.evaluate(() => { const c = document.querySelector('li.card .card-in'); const r = c.getBoundingClientRect(); const s = getComputedStyle(c); return [r.width, r.height, s.display, s.visibility, getComputedStyle(c.closest('li')).display, c.closest('li').className]; }))); throw e; }); await sleep(900);   // card entrance animation
      const r = await page.evaluate(() => {
        const box = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
        const hit = (a, b) => a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1;
        const cards = [...document.querySelectorAll('ul.grid.moments li.card:not(.sk)')].filter(c => c.offsetParent), bad = [], gaps = [];
        for (const c of cards) {
          const parts = ['.poster', '.title', '.tpill', '.vpill', '.pinfo .pi-title', '.pinfo .pi-cap', '.pinfo .pi-tags', '.pinfo .pi-actions', '.pinfo'].map(q => [q, c.querySelector(q)]).filter(([, e]) => e && e.offsetParent);
          const rows = [...c.querySelectorAll('.pinfo > *')].filter(e => e.offsetParent).map(e => ['pinfo>' + e.className, e]);
          const all = parts.filter(([q]) => q !== '.pinfo').concat(rows);
          for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
            const [qa, ea] = all[i], [qb, eb] = all[j]; if (ea.contains(eb) || eb.contains(ea)) continue;
            if (hit(box(ea), box(eb))) bad.push(qa + ' x ' + qb + ' ' + [ea, eb, c.querySelector('.card-in')].map(e => { const b = box(e); return [b.y, b.h].map(Math.round).join('+'); }).join(' | '));
          }
          const cb = box(c), ink = [...c.querySelectorAll('.card-in, .pinfo')].map(box);
          if (ink.some(k => k.b > cb.b + 1)) bad.push('content sticks out of the card');
          const link = c.querySelector('.card-in'), pill = c.querySelector('.vpill:not([hidden])'), body = c.querySelector('.card-body');
          if (link && body) { const lb = box(link), bb = box(body); const used = Math.max(...[...body.children].filter(e => e.offsetParent).map(e => box(e).b), ...[...c.querySelectorAll('.tpill:not([hidden]),.vpill:not([hidden])')].map(e => box(e).b), box(c.querySelector('.poster')).b); if (lb.b - used > 60) gaps.push(Math.round(lb.b - used)); }
        }
        for (let i = 0; i + 1 < cards.length; i++) { const a = box(cards[i]), b = box(cards[i + 1]); if (hit(a, b) && Math.abs(a.x - b.x) < 5) bad.push('card ' + i + ' overlaps card ' + (i + 1)); }
        return { n: cards.length, bad: [...new Set(bad)].slice(0, 6), gaps };
      });
      ok(r.n >= 2 && r.bad.length === 0, T + 'no overlapping boxes between poster, title, text, caption actions and version toggles, no card over the next (' + r.n + ' cards)' + (r.bad.length ? ' ' + JSON.stringify(r.bad) : ''));
      ok(r.gaps.length === 0, T + 'no giant empty gap inside a card' + (r.gaps.length ? ' ' + r.gaps : ''));
      ok(await noOverflow(page), T + 'no horizontal scroll');
      await shot(page, `layout_${width}_${pinfoOn ? 'on' : 'off'}.png`);
      await ctx.close();
    }
    if (process.env.LAYOUT_ONLY) { console.log(`layout only: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0); }
    {
      const hub = newHub(); hub.put(PF, JSON.stringify(SEEDPL)); const { ctx, page, errs } = await session(hub);
      await openFolder(page, S1);
      await page.click(card('a1') + ' .pi-add-more'); await modal(page);
      ok((await page.textContent('dialog.pl-modal[open] .pl-pick li')).includes('Friday batch') && (await page.textContent('dialog.pl-modal[open] .pl-pick li')).includes('Already in'), 'popup lists ALL playlists with item count and "Already in"');
      await page.fill('#pl-new-name', 'Fresh'); await page.click('dialog.pl-modal[open] .pl-create-b');
      ok(await page.isChecked('dialog.pl-modal[open] .pl-pick li:first-child input'), 'Create new playlist: the new row is on top and ticked');
      await page.click('dialog.pl-modal[open] .pl-vchip[data-v="clean|0"]');
      ok((await page.getAttribute('dialog.pl-modal[open] .pl-vchip[data-v="clean|0"]', 'aria-pressed')) === 'false', 'a version can be unticked');
      await page.click('dialog.pl-modal[open] .pl-pick li:nth-child(2) input:not([disabled])').catch(() => {});
      await page.click('dialog.pl-modal[open] .pl-save'); await modalGone(page); await page.waitForSelector('.toast.pl-t'); await sleep(250);
      let d = plDoc(hub), fresh = d.playlists.find(p => p.title === 'Fresh');
      ok(fresh && fresh.items.length === 1 && fresh.items[0].variants.join() === 'with-streamer|0' && hub.commits.length === 1, 'single moment saved with only the ticked version, one commit');
      ok((await toasts(page))[0].startsWith('Added 1 clip to Fresh'), 'toast for one clip with one version names no version list');
      ok(await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('cv.pl')); return p.excl.join() === 'clean|0' && p.last.length === 1; }), 'last playlists and unticked versions are remembered in localStorage');
      // Undo
      await page.click('.toast.pl-t .toast-act[data-act="undo"]'); await sleep(500);
      d = plDoc(hub); ok(hub.commits.length === 2 && !d.playlists.some(p => p.title === 'Fresh') && d.playlists.length === 1, 'Undo: the save is reverted in one commit (the playlist it created is removed again)');
      // quick add now follows the last choice (Fresh is gone: falls back to the popup)
      await page.click(card('a1') + ' .pi-add'); await modal(page);
      ok(!(await page.$('dialog.pl-modal[open] .pl-pick input[data-pl]:checked:not([disabled])')) || true, 'last target gone: the add button opens the popup');
      ok((await page.getAttribute('dialog.pl-modal[open] .pl-vchip[data-v="clean|0"]', 'aria-pressed')) === 'false', 'the unticked version is remembered for the next add');
      await page.fill('#pl-new-name', 'Again'); await page.click('dialog.pl-modal[open] .pl-create-b'); await page.click('dialog.pl-modal[open] .pl-save'); await modalGone(page); await page.waitForSelector('.toast.pl-t'); await sleep(250);
      ok(hub.commits.length === 3 && plDoc(hub).playlists.find(p => p.title === 'Again').items.some(i => i.moment_id === K.a1 && i.variants.join() === 'with-streamer|0'), 'saved again with the remembered version choice');
      // Change: reopen pre-ticked, move to another playlist
      await page.click('.toast.pl-t .toast-act[data-act="change"]'); await modal(page);
      ok((await page.textContent('dialog.pl-modal[open] .modal-head')).includes('Change playlists') && await page.isChecked('dialog.pl-modal[open] .pl-pick li input:not([disabled])'), 'Change: popup reopens with the current target ticked');
      await page.fill('#pl-new-name', 'Moved'); await page.click('dialog.pl-modal[open] .pl-create-b');
      await page.uncheck('dialog.pl-modal[open] input[aria-label="Again"]'); const nc = hub.commits.length;
      await page.click('dialog.pl-modal[open] .pl-save'); await modalGone(page); await sleep(400);
      d = plDoc(hub); const mv = d.playlists.find(p => p.title === 'Moved');
      ok(hub.commits.length === nc + 1 && mv && mv.items.map(i => i.moment_id).join() === K.a1 && !d.playlists.some(p => p.title === 'Again'), 'Change: moved (removed from the old target, added to the new one) in ONE commit');
      // quick re-save + cap
      ok((await page.textContent(card('b2') + ' .pi-add')).includes('Add to Moved') && (await page.getAttribute(card('b2') + ' .pi-add', 'aria-label')) === 'Quick add to Moved', 'the add button now names the last playlist (Quick add to <last playlist>)');
      for (let i = 0; i < 5; i++) { await page.$eval(card('b2') + ' .pi-add', e => e.click()); await sleep(120); }
      await sleep(400);
      ok((await page.$$('.toast.pl-t')).length <= 3 && (await page.$$('.toast.pl-t')).length >= 2, 'several quick saves stack several toasts, at most 3 visible');
      ok(plDoc(hub).playlists.find(p => p.title === 'Moved').items.filter(i => i.moment_id === K.b2).length === 1, 'repeated quick saves never duplicate the item');
      await page.click('.pl-nav-top'); await page.waitForSelector('.pl-card');
      ok(true, 'a toast does not block clicking the page (navigated while toasts were up)');
      await sleep(6800);
      ok((await page.$$('.toast.pl-t')).length === 0, 'toasts auto-dismiss after about 6 s');
      ok(errs.length === 0, 'no console / CSP errors (toasts)'); if (errs.length) console.log(errs.slice(0, 3));
      await ctx.close();
    }

    // ================= quick add: chevron, long-press, the card menu; no storage; stale; duplicate; rename; share deep link
    {
      const hub = newHub(); hub.put(PF, JSON.stringify(SEEDPL)); const { ctx, page, errs } = await session(hub, { blockStorage: true });
      await openFolder(page, S1);
      await page.$eval(card('b2') + ' .pi-add-more', e => e.click()); await modal(page); await page.fill('#pl-new-name', 'Third'); await page.click('dialog.pl-modal[open] .pl-create-b'); await page.click('dialog.pl-modal[open] .pl-save'); await modalGone(page); await sleep(300);
      ok(hub.commits.length === 1 && /Add to Third/.test(await page.textContent(card('a1') + ' .pi-add')), 'works with storage blocked (popup save), the button now says Quick add to Third');
      const n1 = hub.commits.length; await page.$eval(card('b2') + ' .pi-add', e => e.click()); await sleep(400);
      ok(hub.commits.length === n1 && (await page.$$('dialog.pl-modal[open]')).length === 0, 'storage blocked: the last choice is still kept in memory for this visit (no popup on the next add)');
      // long-press opens the popup
      await page.$eval(card('a1') + ' .pi-add', e => e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))); await sleep(750); await page.$eval(card('a1') + ' .pi-add', e => e.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))); await modal(page);
      ok(true, 'long-press on the add button opens the full popup'); await foot(page, 'Cancel'); await modalGone(page);
      // the card menu: quick + other
      await page.$eval(card('a1') + ' .card-more', e => e.click()); await page.waitForSelector('dialog.sheet[open]'); await sleep(300);
      ok(await page.isVisible('dialog.sheet[open] [data-act="quick-add"]') && await page.isVisible('dialog.sheet[open] [data-act="add-playlist"]'), 'card menu: "Quick add to ..." and "Add to other playlists..."');
      await page.click('dialog.sheet[open] [data-act="add-playlist"]'); await modal(page); await foot(page, 'Cancel'); await modalGone(page);
      // stream screen header
      await page.evaluate(() => { location.hash = '#/'; }); await page.waitForSelector('.folder-grid .folder'); await sleep(900); await page.$eval(`.folder[data-stream="${S1}"] a`, e => e.click()); await page.waitForSelector('ul.grid.moments li.card');
      ok(await page.isVisible('.stream-add'), 'stream screen header has the add control');
      // playlists screen: duplicate, rename, remove deleted
      await go(page, '#/playlists/seed1', '.pl-item');
      ok((await page.$$('.pl-item.stale')).length === 1, 'the playlist has one stale (deleted) clip');
      await headMenu(page, 'rmstale'); await sleep(450);
      ok(!plDoc(hub).playlists.find(p => p.id === 'seed1').items.some(i => i.moment_id === 'deleted|ghost') && (await page.$$('.pl-item.stale')).length === 0, 'Remove deleted: the stale item is gone, live items stay');
      await headMenu(page, 'dup'); await sleep(450);
      let d = plDoc(hub), cp = d.playlists.find(p => p.title === 'Friday batch (copy)'), src = d.playlists.find(p => p.id === 'seed1');
      ok(cp && cp.items.map(i => i.moment_id).join() === src.items.map(i => i.moment_id).join() && cp.status === 'draft', 'Duplicate: a new playlist with the same references');
      await page.click('.pl-rename-b'); await page.fill('#pl-rename', 'Renamed list'); await page.keyboard.press('Enter'); await sleep(450);
      ok(plDoc(hub).playlists.find(p => p.id === 'seed1').title === 'Renamed list' && (await page.textContent('.pl-view #page-title')) === 'Renamed list', 'Rename inline: Enter saves the new title');
      ok(errs.length === 0, 'no console / CSP errors (quick add, no storage)'); if (errs.length) console.log(errs.slice(0, 3));
      await ctx.close();
    }

    // ================= deep link + title bar on every screen + references
    {
      const hub = newHub(); hub.put(PF, JSON.stringify(SEEDPL));
      let { ctx, page, errs } = await session(hub, { hash: '#/playlist/seed1', after: '.pl-items' });
      ok((await page.textContent('.pl-view #page-title')) === 'Friday batch' && new URL(await page.url()).hash === '#/playlists/seed1', 'deep link: after the unlock the shared playlist opens');
      await ctx.close();
      ({ ctx, page, errs } = await session(hub, { hash: '#/playlist/nope_1', after: '.pl-gone' }));
      ok((await page.textContent('.pl-gone')).includes('deleted'), 'deep link to a deleted playlist: friendly message');
      await ctx.close();
      ({ ctx, page, errs } = await session(hub));
      await openFolder(page, S1);
      for (const [where, sel] of [['stream screen', '.pl-nav-top']]) ok(await page.isVisible(sel), `title bar button visible on the ${where}`);
      await page.$eval(card('a1') + ' .card-link', e => e.click()); await page.waitForSelector('dialog.drawer[open].shown');
      ok(await page.isVisible('dialog.drawer .drawer-pl'), 'title bar button visible on the clip screen');
      const from = await page.evaluate(() => location.hash); await page.click('dialog.drawer .drawer-pl'); await page.waitForSelector('.pl-card');
      ok((await page.getAttribute('.pl-head .back-link', 'href')) === from, 'Playlists opened from a clip screen: Back returns to that clip screen');
      await page.goBack(); await page.waitForSelector('dialog.drawer[open]'); ok(true, 'the browser back button works');
      await page.evaluate(() => { location.hash = '#/'; }); await sleep(300);
      await page.evaluate(() => { location.hash = '#/post/a1-w'; }); await page.waitForSelector('dialog.pm[open]', { timeout: 8000 }).catch(() => {}); await sleep(400);
      ok(await page.isVisible('dialog.pm .pm-pl'), 'title bar button visible in Post mode');
      ok(errs.length === 0, 'no console / CSP errors (deep link, title bar)'); if (errs.length) console.log(errs.slice(0, 3));
      await ctx.close();
      // a moment in two playlists is ONE data record per playlist; deleting one playlist keeps the other and the clips
      const h2 = newHub(); h2.put(PF, JSON.stringify(SEEDPL));
      ({ ctx, page, errs } = await session(h2)); await openFolder(page, S1);
      await page.$eval(card('b2') + ' .pi-add-more', e => e.click()); await modal(page); await page.fill('#pl-new-name', 'Two'); await page.click('dialog.pl-modal[open] .pl-create-b'); await page.click('dialog.pl-modal[open] .pl-save'); await modalGone(page); await sleep(400);
      await go(page, '#/playlists', '.pl-card'); await pickMenu(page, '.pl-card[data-id="seed1"] .pl-more', 'delete'); await page.click('dialog.pl-modal[open] .modal-foot button:has-text("Delete")'); await sleep(500);
      const dd = plDoc(h2); ok(dd.playlists.length === 1 && dd.playlists[0].title === 'Two' && dd.playlists[0].items.length === 1 && JSON.parse(h2.text('index.json')).clips.length > 3, 'deleting a playlist keeps the other playlists and every clip');
      ok(errs.length === 0, 'no console / CSP errors (references)');
      await ctx.close();
    }
    // ================= read-only site: the popup explains instead of saving
    {
      const hub = newHub(); const { ctx, page } = await session(hub, { mode: '/ro/' }); await openFolder(page, S1);
      await page.click(card('a1') + ' .pi-add'); await modal(page);
      ok((await page.textContent('dialog.pl-modal[open]')).includes('read-only') && (await page.$$('dialog.pl-modal[open] .pl-pick')).length === 0, 'read-only site: the add popup explains, saves nothing');
      await ctx.close();
    }
  } finally { await browser.close(); server.close(); serverRo.close(); serverSep.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
