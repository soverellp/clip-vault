// Live refresh (no reload) against the static build + the MOCKED Hub. Fake secrets only; nothing here proves the real Hub.
// Run: NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfstatic/tests/test_refresh.js
const { chromium } = require('playwright');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { MockHub } = require('./mockhub');
const FX = require('../../hfspace/tests/ui/fixtures_library');

const READ = 'hf_' + 'FAKEREADTOKEN00000000000000000000', WRITE = 'hf_' + 'FAKEWRITETOKEN0000000000000000000', PASS = 'copper lantern meadow quiver';
const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfrefresh-')), DIST = path.join(tmp, 'dist');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() - t > ms) return false; await sleep(80); } }

const b = spawnSync('python3', [path.join(ROOT, 'build_static.py'), '--no-info-copy', '--out', DIST], { env: { ...process.env, VAULT_READ_TOKEN: READ, VAULT_PASSPHRASE: PASS }, encoding: 'utf8' });
if (b.status !== 0) { console.log(b.stdout, b.stderr); process.exit(1); }
const MP4 = path.join(tmp, 'v.mp4'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x112:d=30:r=10', '-c:v', 'libvpx-vp9', '-b:v', '30k', '-movflags', '+faststart', MP4]);
const mkjpg = (n, col, s) => { const f = path.join(tmp, n + '.jpg'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${col}:s=${s}`, '-frames:v', '1', f]); return fs.readFileSync(f); };
const POSTER = mkjpg('p', 'red', '90x160'), POSTER2 = mkjpg('p2', 'green', '90x160'), THUMB = mkjpg('t', 'teal', '320x180');
const S1 = FX.S1;

function newHub() {
  const hub = new MockHub({ read: READ, writeOk: WRITE, extra: {} });
  const idx = FX.index(); hub.put('index.json', JSON.stringify(idx));
  for (const c of idx.clips) { hub.put(c.video, fs.readFileSync(MP4), true); if (c.poster) hub.put(c.poster, POSTER); }
  for (const s of idx.streams || []) if (s.thumb) hub.put(s.thumb, THUMB);
  hub.put('.gitattributes', '*.mp4 filter=lfs');
  return hub;
}
const edit = (hub, fn) => { const i = hub.index(); fn(i); i.updated_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z'); hub.put('index.json', JSON.stringify(i)); hub.bump(); };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(DIST, p); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
  async function session(hub, { poll = 600, viewport = { width: 360, height: 800 } } = {}) {
    const ctx = await browser.newContext({ viewport, colorScheme: 'dark', timezoneId: 'UTC' });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
    await ctx.route('https://huggingface.co/**', r => hub.handle(r));
    await ctx.route(/^https:\/\/([\w-]+\.)+hf\.co\//, r => hub.handle(r));
    const page = await ctx.newPage(), errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (/content security policy|refused to/i.test(m.text())) errs.push(m.text()); });
    await page.addInitScript(p => { globalThis.__clipVaultPollMs = p; }, poll);
    await page.goto(base);
    await page.waitForSelector('#signin:not([hidden]) #pp-input');
    await page.uncheck('#remember-cb'); await page.fill('#pp-input', PASS); await page.click('#signin button[type=submit]');
    await page.waitForSelector('.folder-grid .folder', { timeout: 15000 });
    return { ctx, page, errs };
  }
  const titles = page => page.$$eval('ul.grid.moments li.card .title', e => e.map(x => x.textContent.trim()));
  const noH = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const heads = hub => hub.requests.filter(r => /\/revision\/main$/.test(r.url)).length;
  try {
    // ============ new clip, changed title, changed post text; state kept; no reload
    {
      const hub = newHub(); const { ctx, page, errs } = await session(hub);
      await page.evaluate(() => { window.__marker = 'same-page'; });
      await page.click(`.folder[data-stream="${S1}"] a`); await page.waitForSelector('ul.grid.moments li.card');
      await page.selectOption('#sort', 'title').catch(() => {});
      const sortBefore = await page.$eval('#sort', e => e.value), hashBefore = await page.evaluate(() => location.hash);
      const before = await titles(page);
      await page.evaluate(() => window.scrollTo(0, 40));
      edit(hub, i => {
        const c0 = i.clips.find(c => c.id === 'a1-w'); c0.title = 'Brand new title'; c0.updated_at = '2026-11-19T12:00:00Z';
        c0.desc = 'FRESH POST TEXT for a1'; c0.post = 'raw post text v2';
        const n = { ...i.clips.find(c => c.id === 'a1-w'), id: 'n9-w', group: 'n9', title: 'Newly added moment', video: 'clips/n9-w.mp4', poster: 'clips/n9-w.jpg', variant: 'with-streamer' };
        const n2 = { ...n, id: 'n9-c', variant: 'clean', video: 'clips/n9-c.mp4', poster: 'clips/n9-c.jpg' };
        i.clips.push(n, n2);
      });
      hub.put('clips/n9-w.mp4', fs.readFileSync(MP4), true); hub.put('clips/n9-c.mp4', fs.readFileSync(MP4), true); hub.put('clips/n9-w.jpg', POSTER); hub.put('clips/n9-c.jpg', POSTER);
      ok(await until(async () => (await titles(page)).includes('Newly added moment')), 'a new clip appears without a reload');
      ok(await until(async () => (await titles(page)).includes('Brand new title')), 'a changed title appears without a reload');
      ok(await page.evaluate(() => window.__marker) === 'same-page', 'the page was not reloaded');
      ok(await until(() => page.$eval('#upd-flash', e => e.classList.contains('show') && e.textContent === 'Updated'), 4000), 'the tiny "Updated" flash shows');
      ok((await page.$eval('#sort', e => e.value)) === sortBefore && (await page.evaluate(() => location.hash)) === hashBefore, 'folder and sort are kept (' + sortBefore + ')');
      ok(Math.abs(await page.evaluate(() => window.scrollY) - 40) <= 3 || await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 40), 'scroll position is kept');
      // the copy button gives the NEW text
      await page.evaluate(() => navigator.clipboard.writeText('x')).catch(() => {});
            const card = page.locator('li.card', { hasText: 'Brand new title' }).first();
      await card.locator('.card-more').click(); await page.waitForSelector('dialog[open] [data-act="copy-yt"]');
      await page.click('[data-act="copy-yt"]');
      await until(async () => (await page.evaluate(() => navigator.clipboard.readText()).catch(() => 'x')) !== 'x', 4000);
      const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
      ok(/FRESH POST TEXT for a1/.test(clip), 'copy button copies the latest post text (' + JSON.stringify(clip.slice(0, 40)) + ')');
      await page.keyboard.press('Escape');
      ok(await noH(page), 'no horizontal scroll at 360 px after an update');
      ok(errs.length === 0, 'no page or CSP errors (' + errs.join('|').slice(0, 120) + ')');
      // poster of a changed entry is reloaded, others kept
      const imgSrc = async id => page.$eval(`li.card[data-id="${id}"] img`, e => e.src).catch(() => null);
      const a0 = await imgSrc('a1-w'); const n0 = await imgSrc('n9-w');
      hub.put('clips/n9-w.jpg', POSTER2);
      edit(hub, i => { const c = i.clips.find(x => x.id === 'n9-w'); c.sha256 = 'f'.repeat(64); c.updated_at = '2026-11-19T13:00:00Z'; });
      ok(await until(async () => { const s = await imgSrc('n9-w'); return s && s !== n0; }, 6000), 'the changed clip poster is fetched again (new blob)');
      ok((await imgSrc('a1-w')) === a0, 'an unchanged poster keeps its blob');
      await ctx.close();
    }
    // ============ no update while a video plays or a clip view is open; applied after it closes
    {
      const hub = newHub(); const { ctx, page } = await session(hub);
      await page.click(`.folder[data-stream="${S1}"] a`); await page.waitForSelector('ul.grid.moments li.card');
      await page.evaluate(() => { location.hash = '#/clip/a1-w'; });
      await page.waitForSelector('dialog.drawer[open] video', { timeout: 10000 });
      await page.evaluate(() => { const v = document.querySelector('dialog.drawer video'); v.muted = true; return v.play(); }).catch(() => {});
      const t0 = hub.requests.filter(r => /index\.json/.test(r.url)).length;
      edit(hub, i => { i.clips.find(c => c.id === 'a1-w').title = 'Changed while open'; });
      await sleep(3500);
      ok(hub.requests.filter(r => /index\.json/.test(r.url)).length === t0, 'while a clip view is open the index is not re-read (nothing applied)');
      ok(!(await page.textContent('dialog.drawer')).includes('Changed while open'), 'the open clip view keeps its text');
      ok(await page.evaluate(() => { const v = document.querySelector('dialog.drawer video'); return !v.paused || v.currentTime > 0; }), 'the video was not interrupted');
      await page.click('.drawer-close');
      ok(await until(async () => (await titles(page)).includes('Changed while open'), 8000), 'the change is applied after the clip view closes');
      await ctx.close();
    }
    // ============ hidden tab, locked, backoff, cap
    {
      const hub = newHub(); const { ctx, page } = await session(hub);
      await sleep(900);
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      await sleep(300); const h0 = heads(hub); await sleep(2500);
      ok(heads(hub) === h0, 'polling stops while the tab is hidden');
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
      ok(await until(() => heads(hub) > h0, 3000), 'polling resumes at once when the tab is visible again');
      // cap: a burst of focus events makes at most one extra check
      await sleep(900); const h1 = heads(hub);
      await page.evaluate(() => { for (let i = 0; i < 12; i++) window.dispatchEvent(new Event('focus')); });
      await sleep(120); ok(heads(hub) - h1 <= 1, 'a burst of focus events does not hammer the Hub (' + (heads(hub) - h1) + ' checks)');
      // backoff
      hub.failHead = true; await sleep(300); const f0 = heads(hub);
      await sleep(4200); const fails = heads(hub) - f0;
      ok(fails >= 1 && fails <= 3, 'errors back off (' + fails + ' checks in 4.2 s at a 0.6 s base)');
      hub.failHead = false;
      edit(hub, i => { i.clips.find(c => c.id === 'a1-w').title = 'After recovery'; });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.click(`.folder[data-stream="${S1}"] a`).catch(() => {});
      ok(await until(async () => (await titles(page)).includes('After recovery'), 8000), 'recovers after the Hub answers again');
      // locked: no polling
      await page.click('#signout-btn'); await page.waitForSelector('#signin:not([hidden]) #pp-input');
      await sleep(400); const l0 = heads(hub); await sleep(2200);
      ok(heads(hub) === l0, 'no polling while locked');
      await ctx.close();
    }
    // ============ an admin edit is not raced by the poller
    {
      const hub = newHub(); const { ctx, page, errs } = await session(hub, { poll: 300 });
      await page.click('#admin-btn'); await page.fill('#admin-token', WRITE); await page.click('#admin-go');
      await page.waitForFunction(() => /Exit admin/.test(document.querySelector('#admin-btn').textContent), null, { timeout: 8000 });
      await page.click(`.folder[data-stream="${S1}"] a`); await page.waitForSelector('ul.grid.moments li.card');
      await page.evaluate(() => { location.hash = '#/clip/a1-w'; });
      await page.waitForSelector('dialog.drawer[open] #btn-edit', { timeout: 10000 });
      await page.click('#btn-edit'); await page.fill('#ef-title', 'Admin edited'); 
      const c0 = hub.commits.length;
      await sleep(1200);   // several poll ticks while the form is open
      await page.click('#ef-save');
      ok(await until(() => hub.commits.length > c0 && hub.commits.at(-1).ok, 8000), 'the admin commit succeeds with the poller running');
      const last = hub.commits.at(-1);
      ok(hub.commits.slice(c0).every(c => c.ok) && last.parent === last.headBefore, 'the commit parent is the head that was read (no conflict)');
      ok(hub.index().clips.find(c => c.id === 'a1-w').title === 'Admin edited', 'the edit is in the dataset');
      await sleep(1500);
      ok(errs.length === 0 && hub.violations.length === 0, 'no errors, no token to a CDN host');
      await ctx.close();
    }
  } catch (e) { fail++; console.log('FAIL exception: ' + (e.stack || e)); }
  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
