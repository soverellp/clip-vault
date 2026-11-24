// D54 "main options visible, the rest in a ... menu" against the static build + the MOCKED Hub, phone 390 and PC 1280. Fake secrets only.
// Run: NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfstatic/tests/test_ui2.js
// Proves the client UI against a mock (header, item, cards, version toggle inside the player, no repeated text); it does NOT prove the real Hub or a real phone.
const { chromium } = require('playwright');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { MockHub } = require('./mockhub');

const READ = 'hf_' + 'FAKEREADTOKEN00000000000000000000', SLT = 'hf_' + 'FAKESHORTLISTTOKEN00000000000000', PASS = 'copper lantern meadow quiver';
const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfui2-')), DIST = path.join(tmp, 'dist');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() - t > ms) return false; await sleep(80); } }
const b = spawnSync('python3', [path.join(ROOT, 'build_static.py'), '--no-info-copy', '--out', DIST], { env: { ...process.env, VAULT_READ_TOKEN: READ, VAULT_PASSPHRASE: PASS, VAULT_SHORTLIST_TOKEN: SLT }, encoding: 'utf8' });
if (b.status !== 0) { console.log(b.stdout, b.stderr); process.exit(1); }
const MP4 = path.join(tmp, 'v.mp4'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x112:d=12:r=10', '-c:v', 'libvpx-vp9', '-b:v', '30k', '-movflags', '+faststart', MP4]);
const JPG = path.join(tmp, 'p.jpg'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=90x160', '-frames:v', '1', JPG]);

const S = '2026-11-20_ui2-stream', iso = d => d + 'T10:00:00Z', PF = '_config/playlists.json';
const mk = (id, g, variant, teaser) => ({ id, stream: S, title: 'Moment ' + g, hook: 'hook ' + g, desc: '', post: '', tags: [], dur: 45, score: 8, size: 2e7, video: `clips/${id}.mp4`, poster: `clips/${id}.jpg`, added_at: iso('2026-11-20'), updated_at: iso('2026-11-20'),
  posted: { youtube: null, instagram: null }, trashed_at: null, purge_after: null, group: g, variant, reaction: 'mild', kind: 'reaction', tier: 'B', rank: 1, ...(teaser === undefined ? {} : { teaser }) });
const index = { clips: [mk('t1-cn', 't1', 'clean', false), mk('t1-ct', 't1', 'clean', true), mk('t1-wn', 't1', 'with-streamer', false), mk('t1-wt', 't1', 'with-streamer', true), mk('n2-c', 'n2', 'clean'), mk('n2-w', 'n2', 'with-streamer')],
  streams: [{ id: S, title: 'UI2 stream', channel: 'X', date: '2026-11-20', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', clip_count: 6 }] };
const K1 = S + '|t1', K2 = S + '|n2';
const SEED = { version: 1, playlists: [{ id: 'seed1', title: 'Test', description: '', platforms: [], status: 'draft', created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z',
  items: [{ moment_id: K1, order: 1, post: { title: 'Boss scream', caption: 'Boss scream', hashtags: ['#boss', '#gta'] }, posted: {} },
    { moment_id: K2, order: 2, post: { title: 'Clutch win', caption: 'Clutch win - he never saw it coming', hashtags: [] }, posted: {} }] }] };
function newHub(seed) {
  const hub = new MockHub({ read: READ, writeOk: 'hf_' + 'FAKEWRITETOKEN0000000000000000000', extra: {}, slOk: SLT });
  hub.put('index.json', JSON.stringify(index));
  for (const c of index.clips) { hub.put(c.video, fs.readFileSync(MP4), true); hub.put(c.poster, fs.readFileSync(JPG)); }
  hub.put('.gitattributes', '*.mp4 filter=lfs');
  if (seed) hub.put(PF, JSON.stringify(seed));
  return hub;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(DIST, p); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
  async function session(hub, width = 390) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: 'dark', timezoneId: 'UTC' });
    await ctx.addInitScript(() => { try { localStorage.setItem('cv.feed', '0'); } catch (e) {} });
    await ctx.route('https://huggingface.co/**', r => hub.handle(r));
    await ctx.route(/^https:\/\/([\w-]+\.)+hf\.co\//, r => hub.handle(r));
    const page = await ctx.newPage(), errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (/content security policy|refused to/i.test(m.text())) errs.push(m.text()); });
    await page.addInitScript(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied.push(t); } }, configurable: true }); });
    await page.goto(base); await page.waitForSelector('#signin:not([hidden]) #pp-input');
    await page.uncheck('#remember-cb'); await page.fill('#pp-input', PASS); await page.click('#signin button[type=submit]');
    await page.waitForSelector('.folder-grid .folder');
    return { ctx, page, errs };
  }
  const go = async (page, hash, sel) => { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForSelector(sel, { timeout: 8000 }); await sleep(250); };
  const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  const pickMenu = async (page, opener, act) => { await page.click(opener); await page.waitForSelector('dialog.sheet[open].shown', { timeout: 6000 }); await page.click(`dialog.sheet[open] [data-act="${act}"]`); await sleep(250); };
  const mp4 = hub => hub.requests.filter(r => /clips\/[\w-]+\.mp4$/.test(r.url)).map(r => r.url.split('/').pop());
  const vstate = (page, sel) => page.$eval(sel, v => ({ t: v.currentTime, paused: v.paused, src: v.src.slice(-8) }));
  try {
    // ================= playlist screen at 390 and 1280
    for (const width of [390, 1280]) {
      const T = `[${width}] `, hub = newHub(SEED), { ctx, page, errs } = await session(hub, width);
      await go(page, '#/playlists/seed1', '.pl-items');
      const head = await page.$$eval('.pl-head .pl-bar > *', e => e.map(x => (x.textContent || '').trim() + '|' + x.tagName + '|' + (x.getAttribute('aria-label') || '')));
      ok(head.length === 3 && head[0].startsWith('Share|') && head[1].startsWith('Apply template|') && /More actions/.test(head[2]), T + 'header: ONLY Share, Apply template and the ... button (' + head.join(' ; ') + ')');
      ok(await page.$$eval('.pl-head .pl-bar > *', e => new Set(e.map(x => Math.round(x.getBoundingClientRect().top))).size === 1), T + 'the three header actions sit on one row');
      ok((await page.textContent('.pl-head .pl-summary')) === '2 clips, 0 of 2 posted' && (await page.textContent('.pl-head .pl-status')) === 'draft' && !(await page.textContent('.pl-head')).includes('No platform'), T + 'header: status pill + one-line summary, no "No platform chosen"');
      ok((await page.$$('.pl-head button, .pl-head a')).length === 5, T + 'header has 5 controls in all (back, rename title, Share, Apply, ...)');
      await page.click('.pl-menu-b'); await page.waitForSelector('dialog.sheet[open].shown');
      ok((await page.$$eval('dialog.sheet[open] [data-act]', e => e.map(x => x.dataset.act).join())) === 'rename,addsl,dup,copyall,csv,delete', T + 'header ... menu: rename, add shortlisted, duplicate, copy all, CSV, delete');
      await page.keyboard.press('Escape'); await sleep(300);
      // items
      const items = await page.$$('.pl-item'); ok(items.length === 2, T + 'two items');
      for (const k of [K1, K2]) {
        const li = `.pl-item[data-k="${k}"]`;
        const n = await page.$eval(li, e => { const own = [...e.querySelectorAll('a[href],button,summary')].filter(x => !x.closest('.vsel,.po-ctl')); return own.length + (e.querySelector('.vsel') ? 1 : 0) + (e.querySelector('.po-ctl') ? 1 : 0); });
        ok(n <= 6, T + `item ${k.slice(-2)}: ${n} controls (poster link, ..., Details, version toggle, posted chips)`);
        ok((await page.$$(`${li} .pl-up, ${li} .pl-down, ${li} .pl-rm, ${li} .pl-edit, ${li} .pl-copy`)).length === 0, T + 'no standalone arrows / trash / edit / copy buttons on the item');
        const tops = await page.$$eval(`${li} .po-chip`, e => e.map(x => Math.round(x.getBoundingClientRect().top)));
        ok(tops.length === 5 && new Set(tops).size === 1, T + 'the five Posted on chips are on ONE row');
        ok(await page.$eval(li, e => { const r = e.getBoundingClientRect(); return [...e.querySelectorAll('.po-chip')].every(c => c.getBoundingClientRect().right <= r.right + 0.5); }), T + 'chips stay inside the item');
        ok((await page.$$eval(`${li} .po-chip`, e => e.map(x => x.textContent + '/' + x.getAttribute('aria-label').split(':')[0]).join())) === 'YT/YouTube,IG/Instagram,TT/TikTok,X/X,+/Other', T + 'chips: abbreviations with full names in aria-label');
      }
      ok((await page.$$(`.pl-item[data-k="${K1}"] .vs-g`)).length === 2 && (await page.$$(`.pl-item[data-k="${K2}"] .vs-g`)).length === 1, T + 'version toggle: version + teaser groups on the 4-version item, one group on the 2-version item');
      ok((await page.textContent(`.pl-item[data-k="${K1}"] .pl-meta1`)).includes('4 versions'), T + 'one muted meta line (duration + versions count)');
      // no repeated description
      const d1 = await page.$$eval(`.pl-item[data-k="${K1}"] .pl-det p`, e => e.map(x => x.className + ':' + x.textContent));
      ok(d1.length === 1 && d1[0].startsWith('pi-tags'), T + 'caption equal to the title is not repeated (only the hashtags are under Details): ' + d1.join('|'));
      const d2 = await page.$$eval(`.pl-item[data-k="${K2}"] .pl-det p`, e => e.map(x => x.textContent));
      ok(d2.length === 1 && d2[0] === 'he never saw it coming', T + 'caption that starts with the title only shows the rest: ' + d2.join('|'));
      ok(await page.$$eval('.pl-item .pl-det', e => e.every(x => !x.open)), T + 'Details is closed by default');
      ok(await page.$$eval('.pl-item-t', e => e.every(x => getComputedStyle(x).webkitLineClamp === '2')), T + 'title clamps to 2 lines');
      // item menu
      await page.click(`.pl-item[data-k="${K1}"] .pl-more`); await page.waitForSelector('dialog.sheet[open].shown');
      ok((await page.$$eval('dialog.sheet[open] [data-act]', e => e.map(x => x.dataset.act).join())) === 'edit,copy,posted,up,down,remove', T + 'item ... menu: edit post text, copy caption, posted details, move up/down, remove');
      await page.keyboard.press('Escape'); await sleep(300);
      ok(await noOverflow(page), T + 'no horizontal scroll');
      // touch targets
      const small = await page.$$eval('.pl-head button, .pl-head a.btn, .pl-item .more-b, .pl-item .vs-b, .pl-item .po-chip, .pl-item summary', els => els.filter(e => e.offsetParent && !e.disabled).filter(e => { const r = e.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; }).length);
      ok(small === 0, T + 'every visible control is at least 44 px');
      // version toggle on an item swaps the thumbnail link and remembers the choice
      const h0 = await page.getAttribute(`.pl-item[data-k="${K1}"] a.pl-thumbw`, 'href');
      await page.click(`.pl-item[data-k="${K1}"] .vs-b[data-axis="v"][data-val="clean"]`); await sleep(250);
      const h1 = await page.getAttribute(`.pl-item[data-k="${K1}"] a.pl-thumbw`, 'href');
      ok(h0 !== h1 && h1.includes('t1-c'), T + 'item version toggle swaps the clip the poster opens (' + h0.slice(-5) + ' -> ' + h1.slice(-5) + ')');
      ok(errs.length === 0, T + 'no console / CSP errors ' + errs.join(';'));
      await ctx.close();
    }
    // ================= version toggle inside the player (clip screen), position and play state kept
    {
      const hub = newHub(SEED), { ctx, page, errs } = await session(hub, 390);
      await go(page, '#/clip/t1-ct', 'dialog.drawer[open] .player .vsel'); await sleep(900);
      ok(await page.isVisible('.player .vsel') && (await page.$$('.player .vs-g')).length === 2 && (await page.$$('.player .vs-b')).length === 4, 'clip screen: the version toggle is INSIDE the player (version + teaser groups)');
      ok(await page.$eval('.player', p => { const r = p.getBoundingClientRect(), v = p.querySelector('.vsel').getBoundingClientRect(); return v.top >= r.top && v.bottom <= r.bottom; }), 'the toggle sits inside the player area');
      ok(await page.$eval('.player .vs-b[data-axis="v"][data-val="clean"]', e => e.getAttribute('aria-pressed') === 'true') && await page.$eval('.player .vs-b[data-axis="t"][data-val="1"]', e => e.getAttribute('aria-pressed') === 'true'), 'it shows the playing version: Clean + Teaser');
      await page.click('.player .bigplay'); await until(async () => (await vstate(page, '.player video')).t > 1.2, 8000);
      const before = await vstate(page, '.player video');
      await page.click('.player .vs-b[data-axis="t"][data-val="0"]');
      await until(async () => mp4(hub).includes('t1-cn.mp4'), 6000); await sleep(1500);
      const after = await vstate(page, '.player video');
      ok(mp4(hub).includes('t1-cn.mp4') && Math.abs(after.t - before.t) < 3.2 && after.t >= before.t - 0.3 && !after.paused, `switching to Without keeps the position (${before.t.toFixed(1)}s -> ${after.t.toFixed(1)}s) and keeps playing`);
      await page.click('.player .vs-b[data-axis="v"][data-val="with-streamer"]'); await sleep(300);
      await page.click('.player .bigplay, .player video', { force: true }).catch(() => {}); await sleep(300);
      const paused = await vstate(page, '.player video');
      await page.click('.player .vs-b[data-axis="t"][data-val="1"]'); await until(async () => mp4(hub).includes('t1-wt.mp4'), 6000); await sleep(1200);
      const p2 = await vstate(page, '.player video');
      ok(p2.paused === paused.paused, 'switching while paused stays paused (' + paused.paused + ' -> ' + p2.paused + ')');
      ok(await page.evaluate(() => (JSON.parse(localStorage.getItem('cv.pl')) || {}).mode) === 'with-streamer|1', 'the choice is remembered per viewer (cv.pl mode)');
      await page.focus('.player .vs-b[data-axis="v"][data-val="clean"]'); await page.keyboard.press('Enter'); await sleep(400);
      ok(await page.$eval('.player .vs-b[data-axis="v"][data-val="clean"]', e => e.getAttribute('aria-pressed') === 'true'), 'keyboard: Enter on a focused toggle button switches the version');
      ok((await page.$$eval('.player .vs-b', e => e.filter(x => x.offsetParent && (x.offsetHeight < 43.5 || x.offsetWidth < 43.5)).length)) === 0 && await noOverflow(page), 'toggle: 44 px targets, no horizontal scroll');
      await page.click('.drawer-close'); await sleep(600);
      ok(errs.length === 0, 'no page errors (clip screen) ' + errs.join(';'));
      await ctx.close();
    }
    // ================= Post mode feed
    {
      const hub = newHub(SEED), { ctx, page, errs } = await session(hub, 390);
      await go(page, '#/post/t1-ct', '.pm-sheet .vsel'); await sleep(1500);
      ok(await page.isVisible('.pm .pm-sheet .vsel') && (await page.$$('.pm-sheet .vs-b')).length === 4, 'Post mode: the version toggle is in the docked bar');
      const before = await vstate(page, '.pm-slide.active video'), id0 = await page.getAttribute('.pm-slide.active', 'data-id');
      await page.click('.pm-sheet .vs-b[data-axis="t"][data-val="0"]'); await until(async () => mp4(hub).includes('t1-cn.mp4'), 6000); await sleep(1500);
      const after = await vstate(page, '.pm-slide.active video'), id1 = await page.getAttribute('.pm-slide.active', 'data-id');
      ok(id0 === 't1-ct' && id1 === 't1-cn' && Math.abs(after.t - before.t) < 3.5 && after.t >= before.t - 0.3 && after.paused === before.paused, `Post mode switch: clip ${id0} -> ${id1}, position ${before.t.toFixed(1)}s -> ${after.t.toFixed(1)}s, play state kept`);
      ok(await page.$eval('.pm-sheet .vs-b[data-axis="t"][data-val="0"]', e => e.getAttribute('aria-pressed') === 'true' && document.activeElement === e), 'the new state is shown and keyboard focus stays on the pressed button');
      ok(await noOverflow(page) && errs.length === 0, 'no overflow / errors in Post mode ' + errs.join(';'));
      await ctx.close();
    }
    // ================= library cards (Post info ON): few controls, no overlap, no repeated text
    for (const width of [390, 1280]) {
      const hub = newHub(SEED), { ctx, page, errs } = await session(hub, width), T = `[${width}] `;
      await page.click('.folder a'); await page.waitForSelector('ul.grid.moments li.card'); await page.click('.cat[data-cat="all"]').catch(() => {}); await sleep(900);
      if ((await page.getAttribute('#pm-toggle', 'aria-pressed')) !== 'true') await page.click('#pm-toggle');
      await sleep(500);
      const card = k => `ul.grid.moments li.card[data-key$="|${k}"]`;
      for (const k of ['t1', 'n2']) {
        const n = await page.$eval(card(k), li => [...li.querySelectorAll('.shl:not([hidden]), .card-more, .vpill:not([hidden]), .tpill:not([hidden]), .po-ctl, .pl-split')].length);
        ok(n <= 6, T + `card ${k}: ${n} control groups besides the poster link (star, ..., version pills, Posted on, Add to playlist)`);
        ok((await page.$(`${card(k)} .pi-copy`)) === null, T + 'card: Copy caption is in the ... menu, not a button');
      }
      const caps = await page.$$eval(`${card('t1')} .pinfo p`, e => e.map(x => x.className + ':' + x.textContent));
      ok(caps.filter(c => c.startsWith('pi-cap')).length === 0, T + 'card: caption equal to the title is not shown twice: ' + caps.join('|'));
      const ov = await page.evaluate(() => {
        const box = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
        const hit = (a, b) => a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1, bad = [];
        const cards = [...document.querySelectorAll('ul.grid.moments li.card:not(.sk)')].filter(c => c.offsetParent);
        for (const c of cards) {
          const all = ['.poster', '.title', '.tpill', '.vpill'].map(q => [q, c.querySelector(q)]).concat([...c.querySelectorAll('.pinfo > *')].map(e => ['pinfo>' + e.className, e])).filter(([, e]) => e && e.offsetParent);
          for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) { const [qa, ea] = all[i], [qb, eb] = all[j]; if (!ea.contains(eb) && !eb.contains(ea) && hit(box(ea), box(eb))) bad.push(qa + ' x ' + qb); }
          const cb = box(c); if ([...c.querySelectorAll('.card-in, .pinfo')].some(k => box(k).b > cb.b + 1)) bad.push('content sticks out');
        }
        for (let i = 0; i + 1 < cards.length; i++) { const a = box(cards[i]), b2 = box(cards[i + 1]); if (hit(a, b2) && Math.abs(a.x - b2.x) < 5) bad.push('card ' + i + ' overlaps card ' + (i + 1)); }
        return [...new Set(bad)];
      });
      ok(ov.length === 0, T + 'card overlap check: nothing overlaps, nothing sticks out ' + ov.join(';'));
      ok(await page.$$eval(`.po-ctl.compact .po-row`, e => e.every(r => new Set([...r.children].map(c => Math.round(c.getBoundingClientRect().top))).size === 1)), T + 'cards: Posted on chips on one row');
      ok(await noOverflow(page) && errs.length === 0, T + 'no horizontal scroll / errors ' + errs.join(';'));
      await ctx.close();
    }
  } catch (e) { fail++; console.log('FAIL exception: ' + e.stack); }
  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
