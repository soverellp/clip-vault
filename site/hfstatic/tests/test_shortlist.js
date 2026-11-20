// Shortlist (per-moment star, "Shortlisted" chip, Copy shortlist, admin-only writes) against the static build + the MOCKED Hub. Fake secrets only.
// Run: NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfstatic/tests/test_shortlist.js
// Proves the client logic and request shapes against a mock; it does NOT prove the real Hub or a real phone.
const { chromium } = require('playwright');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { MockHub } = require('./mockhub');
const FX = require('../../hfspace/tests/ui/fixtures_library');

const READ = 'hf_' + 'FAKEREADTOKEN00000000000000000000', WRITE = 'hf_' + 'FAKEWRITETOKEN0000000000000000000', PASS = 'copper lantern meadow quiver';
const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfshort-')), DIST = path.join(tmp, 'dist');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() - t > ms) return false; await sleep(80); } }
const b = spawnSync('python3', [path.join(ROOT, 'build_static.py'), '--no-info-copy', '--out', DIST], { env: { ...process.env, VAULT_READ_TOKEN: READ, VAULT_PASSPHRASE: PASS }, encoding: 'utf8' });
if (b.status !== 0) { console.log(b.stdout, b.stderr); process.exit(1); }
const MP4 = path.join(tmp, 'v.mp4'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x112:d=3:r=10', '-c:v', 'libvpx-vp9', '-b:v', '30k', '-movflags', '+faststart', MP4]);
const JPG = path.join(tmp, 'p.jpg'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=90x160', '-frames:v', '1', JPG]);
const { S1, S2 } = FX, SF = '_config/shortlist.json';
const K_A1 = S1 + '|a1', K_B2 = S1 + '|b2', K_C3 = S2 + '|c3';

function newHub(shortlist) {
  const hub = new MockHub({ read: READ, writeOk: WRITE, extra: {} });
  const idx = FX.index(); idx.clips.find(c => c.id === 'a1-w').post = 'Caption for a1 #boss';
  hub.put('index.json', JSON.stringify(idx));
  for (const c of idx.clips) { hub.put(c.video, fs.readFileSync(MP4), true); if (c.poster) hub.put(c.poster, fs.readFileSync(JPG)); }
  for (const s of idx.streams) if (s.thumb) hub.put(s.thumb, fs.readFileSync(JPG));
  hub.put('.gitattributes', '*.mp4 filter=lfs');
  if (shortlist !== undefined) hub.put(SF, typeof shortlist === 'string' ? shortlist : JSON.stringify(shortlist));
  return hub;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(DIST, p); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
});
const SEED = { version: 1, ids: [{ id: K_A1, at: '2026-11-19T10:00:00Z' }, { id: 'x1', at: '2026-11-19T11:00:00Z' }, { id: 'deleted|ghost', at: '2026-11-19T12:00:00Z' }, { id: K_A1, at: '2026-11-19T13:00:00Z' }] };

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
  async function session(hub, { poll = 0 } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', timezoneId: 'UTC' });
    await ctx.route('https://huggingface.co/**', r => hub.handle(r));
    await ctx.route(/^https:\/\/([\w-]+\.)+hf\.co\//, r => hub.handle(r));
    const page = await ctx.newPage(), errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (/content security policy|refused to/i.test(m.text())) errs.push(m.text()); });
    if (poll) await page.addInitScript(p => { globalThis.__clipVaultPollMs = p; }, poll);
    await page.addInitScript(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied.push(t); } }, configurable: true }); });
    await page.goto(base);
    await page.waitForSelector('#signin:not([hidden]) #pp-input');
    await page.uncheck('#remember-cb'); await page.fill('#pp-input', PASS); await page.click('#signin button[type=submit]');
    await page.waitForSelector('.folder-grid .folder', { timeout: 15000 });
    return { ctx, page, errs };
  }
  const admin = async page => { await page.click('#admin-btn'); await page.fill('#admin-token', WRITE); await page.click('#admin-go'); await page.waitForSelector('#upload-btn:not([hidden])', { timeout: 10000 }); await sleep(300); };
  const openFolder = async (page, id) => { await page.click(`.folder[data-stream="${id}"] a`); await page.waitForSelector('ul.grid.moments li.card'); await page.click('.cat[data-cat="all"]'); };
  const titles = page => page.$$eval('ul.grid.moments li.card .title', e => e.map(x => x.textContent.trim()));
  const chipN = page => page.$eval('#shl-chip .n', e => Number(e.textContent)).catch(() => -1);
  const card = id => `ul.grid.moments li.card[data-key$="|${id}"]`;
  const saved = hub => { const t = hub.text(SF); return t ? JSON.parse(t) : null; };
  try {
    // ================= viewer (read-only token): sees the shortlist, cannot change it
    {
      const hub = newHub(SEED); const { ctx, page, errs } = await session(hub);
      ok(await page.isVisible('#shl-chip') && await chipN(page) === 2, 'library home: "Shortlisted" chip shows 2 (stale id ignored, duplicate id counted once)');
      ok(await page.isVisible('#shl-copy') && !(await page.isDisabled('#shl-copy')), 'a "Copy shortlist" button sits next to the chip');
      await openFolder(page, S1);
      ok((await page.getAttribute(card('a1') + ' .shl', 'aria-pressed')) === 'true' && await page.isVisible(card('a1') + ' .shl'), 'viewer: the starred moment shows its star');
      ok(!(await page.isVisible(card('b2') + ' .shl')), 'viewer: unstarred moments show no star (nothing to click)');
      ok(/Admin mode to change/.test(await page.getAttribute(card('a1') + ' .shl', 'title')) && (await page.getAttribute(card('a1') + ' .shl', 'aria-disabled')) === 'true', 'viewer: the star is read-only with the hint "Admin mode to change"');
      await page.click(card('a1') + ' .shl', { force: true }); await sleep(400);
      ok(hub.commits.length === 0 && (await chipN(page)) === 2, 'viewer: clicking the star writes nothing');
      // group sharing: the clean version of the moment is the same star
      await page.click(card('a1') + ' .vbtn[data-variant="clean"]');
      ok((await page.getAttribute(card('a1') + ' .shl', 'aria-pressed')) === 'true' && (await page.getAttribute(card('a1'), 'data-id')) === 'a1-c', 'the clean version of a starred moment is starred too (per moment, not per clip)');
      // filter chip combines with the stream folder and the category chips
      await page.click('#shl-chip');
      ok((await titles(page)).join('|') === 'He screams when the boss dies', 'chip on, inside a stream: only the shortlisted moment of THIS stream (' + (await titles(page)).join('|') + ')');
      await page.click('.cat[data-cat="game"]');
      ok((await titles(page)).length === 0 && await page.isVisible('.empty'), 'chip + category chip combine (Game moments has no shortlisted moment: empty state)');
      await page.click('.cat[data-cat="reaction"]');
      ok((await titles(page)).length === 1, 'chip + category chip: Streamer reactions keeps the shortlisted moment');
      await page.evaluate(() => { location.hash = '#/'; }); await page.waitForSelector('.folder-grid .folder');
      ok((await page.$$('.folder-grid .folder')).length === 2 && (await page.getAttribute('#shl-chip', 'aria-pressed')) === 'true', 'chip on at the library home: streams that have shortlisted moments (2)');
      await page.click('#shl-chip');
      ok((await page.getAttribute('#shl-chip', 'aria-pressed')) === 'false', 'chip toggles off again');
      // copy
      await page.click('#shl-copy'); await sleep(200);
      const txt = await page.evaluate(() => window.__copied[0] || '');
      ok(txt === '1. He screams when the boss dies (night stream ranked grind)\n   Caption for a1 #boss\n2. Old clip without any new field (just chatting qna)', 'Copy shortlist: plain text, title + stream + post caption when present (' + JSON.stringify(txt).slice(0, 160) + ')');
      // drawer: read-only status with the hint
      await openFolder(page, S1); await page.click(card('b2') + ' .card-link'); await page.waitForSelector('dialog.drawer[open].shown');
      ok((await page.getAttribute('#btn-shortlist', 'aria-disabled')) === 'true' && /Not shortlisted\. Admin mode to change/.test(await page.textContent('#shl-hint')), 'clip detail (viewer): read-only "Not shortlisted. Admin mode to change"');
      await page.click('.drawer-close'); await page.waitForSelector('dialog.drawer:not([open])', { state: 'attached' });
      ok(await page.evaluate(() => { try { return localStorage.length === 0 && sessionStorage.length === 0; } catch { return true; } }), 'nothing about the shortlist is stored in the browser');
      ok(errs.length === 0 && hub.violations.length === 0, 'no console/CSP errors, no token to a CDN (' + errs.join(';') + ')');
      await ctx.close();
    }
    // ================= no file at all: no chip for a viewer; admin mode creates the file
    {
      const hub = newHub(); const { ctx, page, errs } = await session(hub);
      ok(!(await page.isVisible('#shl-chip')), 'no shortlist file and no admin mode: no chip, nothing to show');
      await admin(page);
      ok(await page.isVisible('#shl-chip') && (await chipN(page)) === 0 && await page.isDisabled('#shl-copy'), 'admin mode: chip appears (0) and Copy shortlist is disabled while empty');
      await openFolder(page, S1);
      const head0 = hub.head;
      await page.click(card('b2') + ' .shl');
      ok(await until(() => hub.commits.length === 1 && hub.commits[0].ok), 'admin: star click commits');
      const c = hub.commits[0], paths = c.ops.map(o => o.value.path).sort();
      ok(c.parent === head0 && c.message === 'Shortlist moment' && paths.join() === ['_audit/' + new Date().toISOString().slice(0, 7) + '.jsonl', SF].sort().join(), 'ONE commit at the parent revision with the shortlist file and the audit line, nothing else (' + paths.join(',') + ')');
      ok(JSON.stringify(Object.keys(saved(hub))) === '["version","ids"]' && saved(hub).version === 1 && saved(hub).ids.length === 1 && saved(hub).ids[0].id === K_B2 && /^\d{4}-\d\d-\d\dT[\d:]+Z$/.test(saved(hub).ids[0].at), 'file shape: {"version":1,"ids":[{"id": moment key, "at": iso}]} keyed by moment (' + hub.text(SF).replace(/\s+/g, '') + ')');
      const au = hub.auditLines().pop();
      ok(au.action === 'shortlist' && au.detail.id === K_B2 && au.actor === 'admin', 'audit line written in the same commit: shortlist ' + K_B2);
      ok((await page.getAttribute(card('b2') + ' .shl', 'aria-pressed')) === 'true' && (await chipN(page)) === 1, 'the star and the chip count update right away');
      ok(JSON.parse(hub.text('index.json')).clips.length === FX.clips.length && !hub.files.has('config.json'), 'index.json untouched by a shortlist change');
      await page.click(card('b2') + ' .vbtn[data-variant="clean"]');
      ok((await page.getAttribute(card('b2') + ' .shl', 'aria-pressed')) === 'true', 'starring the with-streamer version marked the clean version too');
      // second moment, then toggle the first OFF from the clip detail on the clean version
      await page.click(card('a1') + ' .shl'); await until(() => hub.commits.length === 2 && hub.commits[1].ok);
      ok(saved(hub).ids.map(e => e.id).join() === K_B2 + ',' + K_A1, 'a second star is appended (list order = starring order)');
      await page.click(card('b2') + ' .card-link'); await page.waitForSelector('dialog.drawer[open].shown');
      ok((await page.getAttribute('#btn-shortlist', 'aria-pressed')) === 'true' && (await page.getAttribute('#btn-shortlist', 'aria-disabled')) === 'false', 'clip detail (admin, clean version of the starred moment): Shortlist button is on and enabled');
      await page.click('#btn-shortlist'); await until(() => hub.commits.length === 3 && hub.commits[2].ok);
      ok(saved(hub).ids.map(e => e.id).join() === K_A1 && hub.commits[2].message === 'Remove from shortlist' && hub.auditLines().pop().action === 'unshortlist', 'toggle off in the clip detail removes the moment and logs unshortlist');
      ok((await page.getAttribute('#btn-shortlist', 'aria-pressed')) === 'false', 'the detail button repaints');
      await page.click('.drawer-close'); await page.waitForSelector('dialog.drawer:not([open])', { state: 'attached' });
      ok(errs.length === 0 && hub.violations.length === 0 && hub.requests.filter(r => r.method !== 'GET' && r.auth !== WRITE && r.url.includes('/commit/')).length === 0, 'commits used only the write token; no CSP errors (' + errs.join(';') + ')');
      await ctx.close();
    }
    // ================= a foreign admin changed the file meanwhile: the write re-reads at the parent revision and keeps their entry
    {
      const hub = newHub({ version: 1, ids: [{ id: K_C3, at: '2026-11-19T10:00:00Z', note: 'keep me' }] }); const { ctx, page } = await session(hub);
      await admin(page); await openFolder(page, S1);
      hub.put(SF, JSON.stringify({ version: 1, ids: [{ id: K_C3, at: '2026-11-19T10:00:00Z', note: 'keep me' }, { id: 'x1', at: '2026-11-20T09:00:00Z' }] })); hub.bump();
      await page.click(card('b2') + ' .shl'); await until(() => hub.commits.length >= 1 && hub.commits.at(-1).ok);
      ok(saved(hub).ids.map(e => e.id).join() === [K_C3, 'x1', K_B2].join() && saved(hub).ids[0].note === 'keep me', 'the file is read at the CURRENT head before changing: the other entries and the note survive');
      await ctx.close();
    }
    // ================= conflict: somebody commits first -> re-read and retry, no duplicate
    {
      const hub = newHub({ version: 1, ids: [] }); const { ctx, page } = await session(hub);
      await admin(page); await openFolder(page, S1);
      hub.injectConflict = 1;
      await page.click(card('b2') + ' .shl'); await until(() => hub.commits.length === 2 && hub.commits[1].ok);
      ok(saved(hub).ids.length === 1 && saved(hub).ids[0].id === K_B2 && hub.commits[0].ok === false, 'a conflict (412) is retried on the new head and the id is stored once');
      await ctx.close();
    }
    // ================= unreadable file: the write FAILS instead of overwriting it
    {
      const hub = newHub('{this is not json'); const { ctx, page, errs } = await session(hub);
      ok(!(await page.isVisible('#shl-chip')) || (await chipN(page)) === 0, 'viewer + corrupt file: the page still loads, shortlist reads as empty');
      await admin(page); await openFolder(page, S1);
      await page.click(card('b2') + ' .shl'); await sleep(900);
      ok(hub.commits.length === 0 && hub.text(SF) === '{this is not json', 'corrupt shortlist.json is never overwritten: no commit, file unchanged');
      ok((await page.textContent('#toasts')).trim().length > 0 && (await page.getAttribute(card('b2') + ' .shl', 'aria-pressed')) === 'false', 'the user sees an error and the star stays off');
      await ctx.close();
    }
    // ================= live refresh: a change from elsewhere and a trashed clip show up without a reload; stale ids are ignored
    {
      const hub = newHub({ version: 1, ids: [{ id: K_A1, at: '2026-11-19T10:00:00Z' }] }); const { ctx, page } = await session(hub, { poll: 500 });
      await page.evaluate(() => { window.__marker = 'same'; });
      ok((await chipN(page)) === 1, 'start: 1 shortlisted');
      hub.put(SF, JSON.stringify({ version: 1, ids: [{ id: K_A1, at: '2026-11-19T10:00:00Z' }, { id: 'x1', at: '2026-11-20T09:00:00Z' }, { id: K_C3, at: '2026-11-20T09:01:00Z' }] })); hub.bump();
      ok(await until(async () => (await chipN(page)) === 3, 8000), 'polling picks up a shortlist change made elsewhere (chip 1 -> 3, no reload)');
      const idx = hub.index(); for (const c of idx.clips) if (c.group === 'a1') { c.trashed_at = '2026-11-20T09:05:00Z'; c.purge_after = '2026-12-20T09:05:00Z'; } hub.put('index.json', JSON.stringify(idx)); hub.bump();
      ok(await until(async () => (await chipN(page)) === 2, 8000), 'a trashed moment drops out of the shortlist view (chip 3 -> 2) while its id stays in the file');
      ok(saved(hub).ids.some(e => e.id === K_A1) && (await page.evaluate(() => window.__marker)) === 'same', 'stale id is only ignored, never rewritten; the page was not reloaded');
      await ctx.close();
    }
    // ================= static checks
    {
      const js = fs.readdirSync(path.join(DIST, 'js')); const cfgBefore = fs.readFileSync(path.join(DIST, 'config.json'), 'utf8');
      ok(js.includes('shortlist.js') && !/shortlist/i.test(cfgBefore), 'dist ships js/shortlist.js; config.json (the passphrase gate) knows nothing about it');
    }
  } finally { await browser.close(); server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
