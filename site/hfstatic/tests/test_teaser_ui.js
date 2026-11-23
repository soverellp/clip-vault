// Teaser x version switch (ONE card per moment, up to 4 variations) against the static build + the MOCKED Hub, at 390 px.
// Run: NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfstatic/tests/test_teaser_ui.js   (SCREENS=1 also writes a PNG to clip-vault-project/screens/). Fake secrets only.
const { chromium } = require('playwright');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { MockHub } = require('./mockhub');

const READ = 'hf_' + 'FAKEREADTOKEN00000000000000000000', PASS = 'copper lantern meadow quiver';
const ROOT = path.resolve(__dirname, '..'), REPO = path.resolve(ROOT, '../..');
const SHOT_DIR = path.join(REPO, 'clip-vault-project/screens');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hftz-')), DIST = path.join(tmp, 'dist');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = spawnSync('python3', [path.join(ROOT, 'build_static.py'), '--no-info-copy', '--out', DIST], { env: { ...process.env, VAULT_READ_TOKEN: READ, VAULT_PASSPHRASE: PASS }, encoding: 'utf8' });
if (b.status !== 0) { console.log(b.stdout, b.stderr); process.exit(1); }
const MP4 = path.join(tmp, 'v.mp4'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x112:d=2:r=10', '-c:v', 'libvpx-vp9', '-b:v', '50k', MP4]);
const JPG = path.join(tmp, 'p.jpg'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=90x160', '-frames:v', '1', JPG]);

const S = '2026-11-20_teaser-stream', iso = (d) => d + 'T10:00:00Z';
const mk = (id, g, variant, teaser) => ({ id, stream: S, title: 'Moment ' + g, hook: 'hook ' + g, desc: '', post: '', tags: [], dur: 45, score: 8, size: 2e7, video: `clips/${id}.mp4`, poster: `clips/${id}.jpg`,
  added_at: iso('2026-11-20'), updated_at: iso('2026-11-20'), posted: { youtube: null, instagram: null }, trashed_at: null, purge_after: null, group: g, variant, reaction: 'mild', kind: 'reaction', tier: 'B', rank: 1,
  ...(teaser === undefined ? {} : { teaser }) });
const index = { clips: [mk('t1-cn', 't1', 'clean', false), mk('t1-ct', 't1', 'clean', true), mk('t1-wn', 't1', 'with-streamer', false), mk('t1-wt', 't1', 'with-streamer', true), mk('n2-c', 'n2', 'clean'), mk('n2-w', 'n2', 'with-streamer')],
  streams: [{ id: S, title: 'Teaser stream', channel: 'X', date: '2026-11-20', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', clip_count: 6 }] };
const hub = new MockHub({ read: READ, writeOk: 'hf_' + 'FAKEWRITETOKEN0000000000000000000', extra: {} });
hub.put('index.json', JSON.stringify(index));
for (const c of index.clips) { hub.put(c.video, fs.readFileSync(MP4), true); hub.put(c.poster, fs.readFileSync(JPG)); }
hub.put('.gitattributes', '*.mp4 filter=lfs');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(DIST, p); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', timezoneId: 'UTC' });
    await ctx.route('https://huggingface.co/**', (r) => hub.handle(r));
    await ctx.route(/^https:\/\/([\w-]+\.)+hf\.co\//, (r) => hub.handle(r));
    const page = await ctx.newPage(), errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(base); await page.waitForSelector('#signin:not([hidden]) #pp-input');
    await page.uncheck('#remember-cb'); await page.fill('#pp-input', PASS); await page.click('#signin button[type=submit]');
    await page.waitForSelector('.folder-grid .folder'); await page.click('.folder a'); await page.waitForSelector('ul.grid.moments li.card');
    await page.click('.cat[data-cat="all"]');
    const T = 'ul.grid.moments li.card[data-key$="|t1"]', N = 'ul.grid.moments li.card[data-key$="|n2"]';
    const id = (s) => page.getAttribute(s, 'data-id'), pr = (s, sel) => page.getAttribute(`${s} ${sel}`, 'aria-pressed');
    const mp4 = () => hub.requests.filter((r) => /clips\/[\w-]+\.mp4$/.test(r.url)).map((r) => r.url.split('/').pop());
    ok((await page.$$('ul.grid.moments > li.card')).length === 2, 'two cards: 4 clips of moment t1 and 2 of n2 give ONE card each');
    ok((await id(T)) === 't1-ct' && (await pr(T, '.tpill [data-teaser="1"]')) === 'true' && (await pr(T, '.vbtn[data-variant="clean"]')) === 'true', 'default = Clean + With teaser');
    ok((await page.$$eval(`${T} .tpill .vbtn`, (e) => e.map((x) => x.textContent))).join('|') === 'Without teaser|With teaser' && (await page.$$eval(`${T} .vpill .vbtn:not([hidden])`, (e) => e.map((x) => x.textContent))).join('|') === 'With streamer|Clean', 'left group "Without teaser | With teaser", right group "With streamer | Clean"');
    ok(!(await page.isVisible(`${N} .tpill`)) && (await id(N)) === 'n2-c' && (await page.isVisible(`${N} .vpill`)), 'moment without teaser clips: left group hidden, default Clean');
    await page.click(`${T} .card-link`, { position: { x: 20, y: 20 } }); await page.waitForSelector('dialog.drawer[open].shown'); await sleep(900);
    ok(mp4().includes('t1-ct.mp4') && !mp4().includes('t1-cn.mp4'), 'the drawer plays the default (clean + teaser) file');
    await page.click('.drawer-close'); await page.waitForSelector('dialog.drawer:not([open])', { state: 'attached' });
    await page.click(`${T} .tpill [data-teaser="0"]`);
    ok((await id(T)) === 't1-cn' && (await pr(T, '.tpill [data-teaser="0"]')) === 'true' && (await pr(T, '.vbtn[data-variant="clean"]')) === 'true', 'Without teaser: same card now points at the clean clip without teaser');
    await page.click(`${T} .vpill .vbtn[data-variant="with-streamer"]`);
    ok((await id(T)) === 't1-wn', 'With streamer keeps the teaser choice (without): t1-wn');
    await page.click(`${T} .tpill [data-teaser="1"]`);
    ok((await id(T)) === 't1-wt', 'With teaser keeps the version: t1-wt');
    await page.click(`${T} .card-link`, { position: { x: 20, y: 20 } }); await page.waitForSelector('dialog.drawer[open].shown'); await sleep(900);
    ok(mp4().includes('t1-wt.mp4'), 'the played video follows the selected combination (t1-wt.mp4 fetched)');
    await page.click('.drawer-close'); await page.waitForSelector('dialog.drawer:not([open])', { state: 'attached' });
    await page.click(`${T} .card-more`); await page.waitForSelector('dialog.sheet[open]'); await page.click('.sheet-act[data-act="download"]'); await sleep(1200);
    ok(mp4().filter((n) => n === 't1-wt.mp4').length >= 1, 'download from the "..." menu uses the selected combination');
    await page.keyboard.press('Escape').catch(() => {}); await sleep(300);
    ok((await page.$$eval(`${T} .vbtn`, (e) => e.every((x) => !x.offsetParent || x.offsetHeight >= 44))), 'buttons are at least 44 px tall');
    ok(await page.$$eval('.tpill, .vpill', (e) => e.every((x) => { if (!x.offsetParent) return true; const c = x.closest('.card').getBoundingClientRect(), r = x.getBoundingClientRect(); return r.right <= c.right && r.bottom <= c.bottom && r.left >= c.left; })), '390 px: both pills stay inside the card');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '390 px: no horizontal scroll');
    if (process.env.SCREENS) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await sleep(500); await page.screenshot({ path: path.join(SHOT_DIR, 'mobile-dark-card-teaser.png') }); }
    ok(errs.length === 0, 'no page errors ' + errs.join(';'));
    await ctx.close();
  } catch (e) { fail++; console.log('FAIL exception: ' + e.stack); }
  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
