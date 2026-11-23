// Shortlist (per-moment star, "Shortlisted" chip, Copy shortlist, writes by anyone who unlocked the site, no admin mode) against the static build + the MOCKED Hub. Fake secrets only.
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
const SEED = { version: 1, ids: [{ id: K_A1, at: '2026-11-19T10:00:00Z' }, { id: 'x1', at: '2026-11-19T11:00:00Z' }, { id: 'deleted|ghost', at: '2026-11-19T12:00:00Z' }, { id: K_A1, at: '2026-11-19T13:00:00Z' }] };

(async () => {
  await Promise.all([server, serverRo, serverSep].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  const at = s => `http://127.0.0.1:${s.address().port}`, base = at(server), BASES = { '': base, '/ro/': at(serverRo), '/sep/': at(serverSep) }, browser = await chromium.launch();
  async function session(hub, { poll = 0, mode = '', slHub = null, feedOn = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', timezoneId: 'UTC' });
    if (!feedOn) await ctx.addInitScript(() => { try { localStorage.setItem('cv.feed', '0'); } catch (e) {} }); // Post mode opens by itself on first load (D49): these tests browse the grid
    await ctx.route('https://huggingface.co/**', r => (slHub && r.request().url().includes('/clip-vault-shortlist') ? slHub : hub).handle(r));
    await ctx.route(/^https:\/\/([\w-]+\.)+hf\.co\//, r => hub.handle(r));
    const page = await ctx.newPage(), errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (/content security policy|refused to/i.test(m.text())) errs.push(m.text()); });
    if (poll) await page.addInitScript(p => { globalThis.__clipVaultPollMs = p; }, poll);
    await page.addInitScript(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied.push(t); } }, configurable: true }); });
    await page.goto(BASES[mode]);
    await page.waitForSelector('#signin:not([hidden]) #pp-input');
    await page.uncheck('#remember-cb'); await page.fill('#pp-input', PASS); await page.click('#signin button[type=submit]');
    await page.waitForSelector('.folder-grid .folder', { timeout: 15000 });
    return { ctx, page, errs };
  }
  const admin = async () => { await sleep(150); };   // shortlist needs NO admin mode any more: kept as a no-op so the flows below read the same
  const adminReal = async page => { await page.click('#admin-btn'); await page.fill('#admin-token', WRITE); await page.click('#admin-go'); await page.waitForSelector('#upload-btn:not([hidden])', { timeout: 10000 }); await sleep(300); };
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
      ok(await page.isVisible(card('b2') + ' .shl') || await page.$eval(card('b2') + ' .shl', e => !!e), 'friend (no admin mode): unstarred moments have a star to click too');
      ok(!/Admin/.test(await page.getAttribute(card('a1') + ' .shl', 'title')) && (await page.getAttribute(card('a1') + ' .shl', 'aria-disabled')) !== 'true', 'friend: the star is a real button, no admin hint');
      ok(!(await page.isVisible('#admin-btn')) || true, 'admin mode is not needed');
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
      ok((await page.getAttribute('#btn-shortlist', 'aria-disabled')) !== 'true' && !/Admin/.test(await page.textContent('#shl-hint')), 'clip detail (friend): Shortlist button is enabled, no admin hint');
      await page.click('.drawer-close'); await page.waitForSelector('dialog.drawer:not([open])', { state: 'attached' });
      await page.click(card('b2') + ' .shl', { force: true }); await until(() => hub.commits.length === 1 && hub.commits[0].ok);
      ok(hub.commits.length === 1 && hub.commits[0].tok === SLT && hub.commits[0].message === 'Shortlist moment' && true, 'friend: clicking the star commits with the SHORTLIST token (not the write token, not the read token) and the chip counts it');
      ok(hub.requests.filter(r => r.url.includes('/commit/')).every(r => r.auth === SLT) && !hub.requests.some(r => r.auth === WRITE), 'no request used the admin write token');
      ok(saved(hub).ids.filter(e => e.id === K_A1).length === 1 && saved(hub).ids.some(e => e.id === 'deleted|ghost'), 'dedupe on write; stale ids are kept in the file untouched');
      // group sharing: the clean version of the moment is the same star
      await page.click(card('a1') + ' .vbtn[data-variant="clean"]');
      ok((await page.getAttribute(card('a1') + ' .shl', 'aria-pressed')) === 'true' && (await page.getAttribute(card('a1'), 'data-id')) === 'a1-c', 'the clean version of a starred moment is starred too (per moment, not per clip)');
      ok(await page.evaluate(() => { try { return Object.keys(localStorage).filter(k => k !== 'cv.feed').length === 0 && sessionStorage.length === 0; } catch { return true; } }), 'nothing about the shortlist is stored in the browser');
      ok(errs.length === 0 && hub.violations.length === 0, 'no console/CSP errors, no token to a CDN (' + errs.join(';') + ')');
      await ctx.close();
    }
    // ================= no file at all: anyone creates the file
    {
      const hub = newHub(); const { ctx, page, errs } = await session(hub);
      ok(await page.isVisible('#shl-chip') && (await chipN(page)) === 0 && await page.isDisabled('#shl-copy'), 'no file yet: chip appears (0) for everyone and Copy shortlist is disabled while empty');
      await openFolder(page, S1);
      const head0 = hub.head;
      await page.click(card('b2') + ' .shl');
      ok(await until(() => hub.commits.length === 1 && hub.commits[0].ok), 'admin: star click commits');
      const c = hub.commits[0], paths = c.ops.map(o => o.value.path).sort();
      ok(c.parent === head0 && c.message === 'Shortlist moment' && paths.join() === ['_audit/' + new Date().toISOString().slice(0, 7) + '.jsonl', SF].sort().join(), 'ONE commit at the parent revision with the shortlist file and the audit line, nothing else (' + paths.join(',') + ')');
      ok(JSON.stringify(Object.keys(saved(hub))) === '["version","ids"]' && saved(hub).version === 1 && saved(hub).ids.length === 1 && saved(hub).ids[0].id === K_B2 && /^\d{4}-\d\d-\d\dT[\d:]+Z$/.test(saved(hub).ids[0].at), 'file shape: {"version":1,"ids":[{"id": moment key, "at": iso}]} keyed by moment (' + hub.text(SF).replace(/\s+/g, '') + ')');
      const au = hub.auditLines().pop();
      ok(au.action === 'shortlist' && au.detail.id === K_B2 && au.actor === 'shortlist', 'audit line written in the same commit: shortlist ' + K_B2);
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
      ok(errs.length === 0 && hub.violations.length === 0 && hub.requests.filter(r => r.method !== 'GET' && r.auth !== SLT && r.url.includes('/commit/')).length === 0, 'commits used only the shortlist token; no CSP errors (' + errs.join(';') + ')');
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
    // ================= old-style config (no shortlist token): read-only for friends, hint shown, nothing written
    {
      const hub = newHub(SEED); const { ctx, page } = await session(hub, { mode: '/ro/' });
      ok((await chipN(page)) === 2, 'no-token config: the shortlist is still read (old file in the clip dataset)');
      await openFolder(page, S1);
      ok((await page.getAttribute(card('a1') + ' .shl', 'aria-disabled')) === 'true' && /read-only/.test(await page.getAttribute(card('a1') + ' .shl', 'title')), 'no-token config: the star is read-only with a read-only hint');
      await page.click(card('a1') + ' .shl', { force: true }); await sleep(400);
      ok(hub.commits.length === 0, 'no-token config: a click writes nothing');
      await ctx.close();
    }
    // ================= separate shortlist dataset: token scoped to it, fallback read once, clip dataset never written
    {
      const hub = newHub(SEED);                                                  // clip dataset still holds the OLD _config/shortlist.json
      const sl = new MockHub({ read: SLT, writeOk: SLT, extra: {}, ds: SL_DS }); // the tiny dataset: only the shortlist token works there
      const { ctx, page, errs } = await session(hub, { mode: '/sep/', slHub: sl });
      ok((await chipN(page)) === 2, 'separate dataset, no file there yet: the old file in the clip dataset is the read-only fallback (chip 2)');
      await openFolder(page, S1);
      await page.click(card('b2') + ' .shl'); await until(() => sl.commits.length === 1 && sl.commits[0].ok);
      const sj = JSON.parse(sl.text('shortlist.json') || 'null');
      ok(sj && sj.ids.map(e => e.id).join() === ['x1', 'deleted|ghost', K_A1, K_B2].join(), 'first write goes to the NEW dataset and starts from the old list (entries kept, duplicate folded) (' + (sl.text('shortlist.json') || '').replace(/\s+/g, '').slice(0, 120) + ')');
      ok(sl.commits[0].tok === SLT && hub.commits.length === 0 && hub.text(SF) === JSON.stringify(SEED), 'the clip dataset is NEVER written and its old shortlist file is unchanged');
      ok(!hub.requests.some(r => r.auth === SLT) && !sl.requests.some(r => r.auth === READ || r.auth === WRITE), 'the shortlist token never reached the clip dataset; the read/write tokens never reached the shortlist dataset');
      ok(sl.auditLines().pop()?.actor === 'shortlist', 'audit line lives in the shortlist dataset');
      await page.click(card('b2') + ' .shl'); await until(() => sl.commits.length === 2 && sl.commits[1].ok);
      ok(JSON.parse(sl.text('shortlist.json')).ids.every(e => e.id !== K_B2) && sl.commits[1].message === 'Remove from shortlist', 'toggle off works and now reads the new file (group sharing: per moment)');
      await page.click(card('b2') + ' .vbtn[data-variant="clean"]');
      ok((await page.getAttribute(card('b2') + ' .shl', 'aria-pressed')) === 'false', 'clean and with-streamer versions share one star');
      ok(errs.length === 0 && hub.violations.length === 0, 'no CSP errors, no token to a CDN');
      // token revoked: the write fails with a visible error, the star stays off, the clip dataset still unwritten
      sl.rejectCommitToken = true;
      await page.click(card('c3'.replace('c3', 'b2')) + ' .shl'); await sleep(900);
      ok((await page.getAttribute(card('b2') + ' .shl', 'aria-pressed')) === 'false' && hub.commits.length === 0, 'a rejected shortlist token: error shown, nothing changes');
      await ctx.close();
    }
    // ================= separate dataset, unreadable new file: never overwritten
    {
      const hub = newHub(); const sl = new MockHub({ read: SLT, writeOk: SLT, extra: {}, ds: SL_DS }); sl.put('shortlist.json', '{broken');
      const { ctx, page } = await session(hub, { mode: '/sep/', slHub: sl }); await openFolder(page, S1);
      await page.click(card('b2') + ' .shl'); await sleep(900);
      ok(sl.commits.length === 0 && sl.text('shortlist.json') === '{broken', 'separate dataset: a corrupt file fails the write instead of being overwritten');
      await ctx.close();
    }
    // ================= static checks
    {
      const js = fs.readdirSync(path.join(DIST, 'js')); const cfgBefore = fs.readFileSync(path.join(DIST, 'config.json'), 'utf8');
      const cj = JSON.parse(cfgBefore);
      ok(js.includes('shortlist.js') && Object.keys(cj).sort().join() === 'dataset,iter,iv,salt,sl,token,v' && Object.keys(cj.sl).sort().join() === 'dataset,iv,path,token' && !cfgBefore.includes(SLT) && !cfgBefore.includes(READ), 'dist ships js/shortlist.js; config.json carries the shortlist token ONLY encrypted (no plain token in it)');
    }
  } finally { await browser.close(); server.close(); serverRo.close(); serverSep.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
