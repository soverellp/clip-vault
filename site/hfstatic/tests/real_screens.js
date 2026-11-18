// Screenshots of the library with REAL data shapes (streams/index.json, thumbs, posters, docs/vault_meta.json) through the static build + the MOCK Hub.
// Run: NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfstatic/tests/real_screens.js   -> clip-vault-project/screens/real/*.png
// Fake tokens only. Proves how the UI renders this data; says nothing about the real Hub.
const { chromium } = require('playwright');
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { MockHub } = require('./mockhub');
const READ = 'hf_' + 'FAKEREADTOKEN00000000000000000000', PASS = 'copper lantern meadow quiver';
const ROOT = path.resolve(__dirname, '..'), REPO = path.resolve(ROOT, '../..'), OUT = path.join(REPO, 'clip-vault-project/screens/real');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfreal-')), DIST = path.join(tmp, 'dist');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = spawnSync('python3', [path.join(ROOT, 'build_static.py'), '--no-info-copy', '--out', DIST], { env: { ...process.env, VAULT_READ_TOKEN: READ, VAULT_PASSPHRASE: PASS }, encoding: 'utf8' });
if (b.status !== 0) { console.log(b.stdout, b.stderr); process.exit(1); }

// ---- the index, built the way the vault is: streams[] from streams/index.json, clips with docs/vault_meta.json fields where they exist
const src = JSON.parse(fs.readFileSync(path.join(REPO, 'streams/index.json'), 'utf8'));
const streams = src.streams.map((s) => ({ id: s.slug, title: s.title, channel: s.channel, date: s.date_added, url: s.url, thumb: `streams/${s.slug}/thumb.jpg`, clip_count: s.clips }));
const metaOf = (slug) => { const f = path.join(REPO, 'streams', slug, 'docs/vault_meta.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).clips : {}; };
const metas = Object.fromEntries(src.streams.map((s) => [s.slug, metaOf(s.slug)]));
const clips = src.clips.map((c) => {
  const m = metas[c.stream][c.id] || {};
  const o = { id: c.id, stream: c.stream, title: c.title, hook: c.hook || '', desc: c.description || '', post: '', tags: [], dur: c.duration, score: 8, size: Math.round(c.duration * 600000), width: 1080, height: 1920, fps: 30, codec: 'h264', bitrate: 3000000, sha256: null,
    added_at: (c.created || '2026-11-18') + 'T10:00:00Z', updated_at: (c.created || '2026-11-18') + 'T10:00:00Z', video: `clips/${c.id}.mp4`, poster: `clips/${c.id}.jpg`, posted: { youtube: null, instagram: null }, notes: '', trashed_at: null, purge_after: null };
  for (const k of ['group', 'variant', 'reaction', 'reaction_note', 'kind', 'tier', 'rank', 'why']) if (m[k] != null) o[k] = k === 'variant' && m[k] === 'with-girl' ? 'with-streamer' : m[k];
  if (m.hook) o.hook = m.hook;
  return o;
});
const index = { version: 2, streams, clips };
const hub = new MockHub({ read: READ, writeOk: 'hf_' + 'FAKEWRITETOKEN0000000000000000000', extra: {} });
hub.put('index.json', JSON.stringify(index));
for (const c of src.clips) { hub.put(`clips/${c.id}.mp4`, Buffer.from('x'), true); hub.put(`clips/${c.id}.jpg`, fs.readFileSync(path.join(REPO, c.poster))); }
for (const s of streams) hub.put(s.thumb, fs.readFileSync(path.join(REPO, s.thumb)));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f)); });
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); fs.mkdirSync(OUT, { recursive: true });
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
  const KAI = streams[0].id;
  async function open(o) {
    const ctx = await browser.newContext({ viewport: o.viewport, deviceScaleFactor: 2, colorScheme: o.scheme, hasTouch: !!o.touch });
    await ctx.route('https://huggingface.co/**', (r) => hub.handle(r)); await ctx.route(/^https:\/\/([\w-]+\.)+hf\.co\//, (r) => hub.handle(r));
    const page = await ctx.newPage();
    await page.goto(base); await page.waitForSelector('#signin:not([hidden]) #pp-input');
    await page.uncheck('#remember-cb'); await page.fill('#pp-input', PASS); await page.click('#signin button[type=submit]');
    await page.waitForSelector('.folder-grid .folder');
    await page.waitForFunction(() => document.querySelectorAll('.folder-grid .f-thumb img.loaded').length === 3, null, { timeout: 8000 }).catch(() => {});
    return page;
  }
  const shot = async (page, name, full) => { await sleep(900); await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!full }); console.log('saved', name); };
  const toStream = async (page) => { await page.click(`.folder[data-stream="${KAI}"] a`); await page.waitForSelector('ul.grid.moments li.card'); await page.waitForFunction(() => document.querySelectorAll('ul.grid.moments .poster img.loaded').length >= 2, null, { timeout: 8000 }).catch(() => {}); await page.evaluate(() => window.scrollTo(0, 0)); };
  for (const [tag, scheme, vp] of [['mobile-dark', 'dark', { width: 390, height: 844 }], ['mobile-light', 'light', { width: 390, height: 844 }], ['desktop-dark', 'dark', { width: 1280, height: 800 }]]) {
    const page = await open({ viewport: vp, scheme, touch: vp.width < 600 });
    await shot(page, `${tag}-home`);
    await toStream(page); await shot(page, `${tag}-stream-best`);
    if (tag === 'mobile-dark') {
      await page.click('.cat[data-cat="reaction"]'); await page.evaluate(() => window.scrollTo(0, 0)); await shot(page, 'mobile-dark-stream-reactions');
      await page.click('.cat[data-cat="best"]'); await page.evaluate(() => window.scrollTo(0, 0));
      await page.click('ul.grid.moments li.card:first-child .vbtn[data-variant="clean"]'); await shot(page, 'mobile-dark-card-clean');
      await page.click('ul.grid.moments li.card:first-child .vbtn[data-variant="with-streamer"]');
      await page.click('#filter-btn'); await shot(page, 'mobile-dark-filter-menu');
    }
    await page.context().close();
  }
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
