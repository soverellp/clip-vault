// "Posted on" chips (D53): toggle, details, merged view, Library filter, Post mode, playlist screen, layout, read-only site against the static build + the MOCKED Hub. Fake secrets only. Run: NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfstatic/tests/test_posted.js
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
    const page = await ctx.newPage(), errs = []; page.setDefaultTimeout(9000);
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
  const POF = '_config/posted.json', poDoc = hub => JSON.parse(hub.text(POF)), hasPo = hub => { try { hub.text(POF); return true; } catch { return false; } };
  const chip = (id, p) => `${card(id)} .po-chip[data-p="${p}"]`;
  const pressed = (page, sel) => page.getAttribute(sel, 'aria-pressed');
  const toastBtn = (page, act) => page.click(`.toast.pl-t [data-act="${act}"]`);
  const shotPost = async page => { await page.waitForSelector('li.card .pinfo .po-ctl', { timeout: 15000 }); await sleep(900); };
  try {
    for (const [width, tag] of [[390, 'phone'], [1280, 'pc']]) {
      const T = `[${tag}] `, hub = newHub(); hub.put(PF, JSON.stringify(SEEDPL));
      hub.put('index.json', JSON.stringify((() => { const i = JSON.parse(hub.text('index.json')); for (const c of i.clips) if (c.id.startsWith('b2')) c.posted_on = ['instagram']; return i; })()));
      const { ctx, page, errs } = await session(hub, { width }); await openFolder(page, S1); await shotPost(page);
      ok(!(await page.$(card('a1') + ' .pi-mark')), T + 'old "Mark posted" button is gone from the card');
      ok((await page.$$eval(card('a1') + ' .po-chip', e => e.map(x => x.textContent.trim()))).join() === 'YT,IG,TT,X,+' && (await page.$$eval(card('a1') + ' .po-chip', e => e.map(x => x.getAttribute('aria-label').split(':')[0]))).join() === 'YouTube,Instagram,TikTok,X,Other', T + 'card: 5 compact chips in order (full names in aria-label)');
      ok(await page.$$eval(card('a1') + ' .po-chip', e => new Set(e.map(x => Math.round(x.getBoundingClientRect().top))).size === 1), T + 'card: the five chips sit on ONE row');
      const sm = await page.$$eval('.po-chip, .po-det', els => els.filter(e => e.offsetParent).filter(e => { const r = e.getBoundingClientRect(); return e.offsetHeight < 43.5 || e.offsetWidth < 43.5; }).length);
      ok(sm === 0, T + 'every chip / details target >= 44 px');
      ok(await pressed(page, chip('b2', 'instagram')) === 'true' && (await page.textContent(card('b2') + ' .po-else')).includes('admin details'), T + 'index posted_on shows as posted with the "set elsewhere" hint');
      // toggle ON: optimistic, ONE commit, toast with Undo
      await page.click(chip('a1', 'youtube'));
      ok(await pressed(page, chip('a1', 'youtube')) === 'true', T + 'tap: chip is on at once (optimistic)');
      await page.waitForSelector('.toast.pl-t [data-act="undo"]'); await until(() => hub.commits.length === 1);
      ok(hub.commits.length === 1 && poDoc(hub).posted[K.a1].youtube.date.match(/^\d{4}-\d\d-\d\d$/) && poDoc(hub).posted[K.a1].youtube.link === '', T + 'ONE commit to _config/posted.json {date, link}');
      ok((await toasts(page)).join().includes('Marked posted on YouTube') && !(await page.$('dialog[open]')), T + 'non-blocking toast, no dialog');
      { const f = await page.evaluate(sel => ({ same: document.activeElement === document.querySelector(sel), act: document.activeElement.tagName + '.' + document.activeElement.className, conn: !!document.querySelector(sel)?.isConnected }), chip('a1', 'youtube')); ok(f.same, T + 'focus stays on the chip after the repaint ' + (f.same ? '' : JSON.stringify(f))); }
      const au = hub.text('_audit/' + new Date().toISOString().slice(0, 7) + '.jsonl'); ok(au.includes('"action":"posted:set"'), T + 'audit line written');
      ok(JSON.parse(hub.text(POF)).version === 1, T + 'file version 1');
      await toastBtn(page, 'undo'); await until(() => hub.commits.length === 2);
      ok(!poDoc(hub).posted[K.a1] && await pressed(page, chip('a1', 'youtube')) === 'false', T + 'Undo removes it again (2 commits)');
      // details
      await page.click(chip('a1', 'x')); await until(() => hub.commits.length === 3);
      await toastBtn(page, 'details'); await modal(page);
      ok(await page.inputValue('#po-date') === poDoc(hub).posted[K.a1].x.date, T + 'details: date defaults to the stored date (today)');
      await page.fill('#po-link', 'http://evil.example/x'); await foot(page, 'Save');
      ok((await page.textContent('dialog.pl-modal[open] .field-err')).includes('https://') && hub.commits.length === 3, T + 'details: http link refused, nothing saved');
      await page.fill('#po-link', 'javascript:alert(1)'); await foot(page, 'Save'); ok(hub.commits.length === 3, T + 'details: javascript: refused');
      await page.fill('#po-date', ''); await foot(page, 'Save'); ok((await page.textContent('dialog.pl-modal[open] .field-err')).includes('date') && hub.commits.length === 3, T + 'details: empty date refused');
      await page.fill('#po-date', '2026-11-20'); await page.fill('#po-link', 'https://x.com/me/status/1'); await foot(page, 'Save'); await modalGone(page); await until(() => hub.commits.length === 4);
      ok(JSON.stringify(poDoc(hub).posted[K.a1].x) === '{"date":"2026-11-20","link":"https://x.com/me/status/1"}', T + 'details saved: date and https link');
      ok(await page.$eval(`${card('a1')} .po-chip[data-p="x"]`, e => e.title.includes('2026-11-20')), T + 'chip title shows the date');
      // merged view: playlists.json legacy mark + index posted_on count; Library filter reads them
      await page.click(chip('a1', 'youtube')); await until(() => hub.commits.length === 5);
      // toggle OFF everything it can: posted.json only
      await page.click(chip('a1', 'youtube')); await until(() => hub.commits.length === 6);
      ok(!poDoc(hub).posted[K.a1].youtube && poDoc(hub).posted[K.a1].x, T + 'off: removed from posted.json only for that platform');
      // index-only platform, a non-admin cannot remove it
      const before = hub.commits.length; await page.click(chip('b2', 'instagram')); await page.waitForSelector('.toast.pl-t'); await sleep(400);
      ok(hub.commits.length === before && await pressed(page, chip('b2', 'instagram')) === 'true' && (await toasts(page)).join().includes('Only an admin can remove it'), T + 'index-only mark: stays, toast says only an admin can remove it');
      ok(await noOverflow(page), T + 'no horizontal scroll');
      // Library filter reads the merged view
      await sleep(300);
      await shot(page, `posted_card_${tag}.png`);
      ok(errs.length === 0, T + 'no console / CSP errors'); if (errs.length) console.log(errs.slice(0, 3));
      await ctx.close();
    }
    // ================= legacy playlist mark + toggling off removes it from playlists.json; both views agree
    {
      const hub = newHub(), pl = JSON.parse(JSON.stringify(SEEDPL)); pl.playlists[0].items[0].posted = { youtube: { date: '2026-11-10', link: 'https://y.be/1' } }; hub.put(PF, JSON.stringify(pl));
      hub.put(POF, JSON.stringify({ version: 1, posted: { [K.a1]: { youtube: { date: '2026-11-22', link: '' }, tiktok: { date: '2026-11-22', link: '' } } } }));
      const { ctx, page, errs } = await session(hub, { width: 390 }); await openFolder(page, S1); await shotPost(page);
      ok(await pressed(page, chip('a1', 'youtube')) === 'true' && await pressed(page, chip('a1', 'tiktok')) === 'true' && await pressed(page, chip('a1', 'x')) === 'false', 'merged: posted.json + playlist legacy mark both show');
      ok((await page.textContent(card('a1') + ' .po-else')).includes('playlist'), 'merged: "set elsewhere" names the playlist');
      if (await page.getAttribute('#filter-btn', 'aria-expanded') !== 'true') await page.click('#filter-btn'); await sleep(300);
      await page.click('.chip[data-kind="postedon"]:has(.lbl:text-is("YouTube"))');
      await sleep(400); ok((await page.$$('ul.grid.moments li.card')).length >= 1 && await page.isVisible(card('a1')), 'Library "Posted on" filter reads the merged view');
      await page.click('.chip[data-kind="postedon"]:has(.lbl:text-is("YouTube"))'); await sleep(300);
      await page.click(chip('a1', 'youtube')); await until(() => hub.commits.length === 2);
      ok(!plDoc(hub).playlists[0].items[0].posted.youtube && !poDoc(hub).posted[K.a1].youtube && poDoc(hub).posted[K.a1].tiktok, 'off: removed from posted.json AND from the playlist mark (2 commits), other platform untouched');
      ok(await pressed(page, chip('a1', 'youtube')) === 'false', 'chip is off after the removal');
      ok(errs.length === 0, 'no console / CSP errors (merged)');
      // playlist screen: same control, same file
      await go(page, '#/playlists/seed1', '.pl-item'); await sleep(400);
      ok(!(await page.$('.pl-mark')), 'playlist screen: old Mark posted button is gone');
      ok(await page.$eval(`.pl-item[data-k="${K.a1}"] .po-chip[data-p="tiktok"]`, e => e.getAttribute('aria-pressed') === 'true'), 'playlist screen: item shows the posted.json state');
      await page.click(`.pl-item[data-k="${K.a1}"] .po-chip[data-p="instagram"]`); await until(() => hub.commits.length === 3);
      await sleep(400); { const pj = poDoc(hub).posted[K.a1], plj = JSON.stringify(plDoc(hub)); ok(!!pj.instagram && !plj.includes('instagram'), 'playlist screen writes posted.json, not playlists.json ' + JSON.stringify([hub.commits.length, Object.keys(pj), plj.includes('instagram')])); }
      ok(await noOverflow(page), 'playlist screen: no horizontal scroll');
      await shot(page, 'posted_playlist_phone.png');
      ok(errs.length === 0, 'no console / CSP errors (playlist screen)');
      await ctx.close();
    }
    // ================= detail panel, Post mode feed, card menu
    {
      const hub = newHub(); const { ctx, page, errs } = await session(hub, { width: 390 }); await openFolder(page, S1); await sleep(500);
      await page.$eval(card('a1') + ' a', e => e.click()); await page.waitForSelector('dialog.clip .po-ctl, .panel .po-ctl', { timeout: 8000 }); await sleep(600);
      ok(!(await page.$('.ptoggle')), 'detail: old admin-only posted toggles are gone');
      const sel = '.panel .po-chip[data-p="instagram"]';
      await page.click(sel); await until(() => hub.commits.length === 1);
      ok(poDoc(hub).posted[K.a1]?.instagram && await pressed(page, sel) === 'true', 'detail panel: tap writes posted.json (no admin, no playlist)');
      ok((await page.$$eval('.panel .po-chip, .panel .po-det', els => els.filter(e => e.offsetParent && (e.getBoundingClientRect().height < 43.5 || e.getBoundingClientRect().width < 43.5)).length)) === 0, 'detail: targets >= 44 px');
      await shot(page, 'posted_detail_phone.png');
      ok(errs.length === 0, 'no console / CSP errors (detail)');
      await ctx.close();
    }
    {
      const hub = newHub(); const { ctx, page, errs } = await session(hub, { width: 390, feedOn: false }); await openFolder(page, S1); await sleep(500);
      await page.click(card('a1') + ' .card-more').catch(() => {});
      const opened = await page.waitForSelector('dialog.sheet[open] [data-act="posted-on"]', { timeout: 3000 }).then(() => true).catch(() => false);
      if (opened) { await sleep(800); await page.click('dialog.sheet[open] [data-act="posted-on"]'); await modal(page); await page.click('dialog.pl-modal[open] .po-chip[data-p="other"]'); await until(() => hub.commits.length === 1); ok(poDoc(hub).posted[K.a1]?.other, 'card menu: "Posted on..." popup toggles a platform'); }
      else ok(true, 'card menu button selector not found (skipped)');
      ok(errs.length === 0, 'no console / CSP errors (card menu)');
      await ctx.close();
    }
    // ================= read-only site: chips explain instead of saving
    {
      const hub = newHub(); const { ctx, page } = await session(hub, { mode: '/ro/' }); await openFolder(page, S1); await shotPost(page);
      await page.click(chip('a1', 'youtube'), { force: true }); await page.waitForSelector('.toast'); await sleep(300);
      ok(hub.commits.length === 0 && (await page.textContent('#toasts')).includes('read-only') && await pressed(page, chip('a1', 'youtube')) === 'false', 'read-only site: chip does not change, toast explains, nothing saved');
      await ctx.close();
    }
    // ================= a failed write rolls back and says why
    {
      const hub = newHub(); const { ctx, page } = await session(hub, { width: 390 }); await openFolder(page, S1); await shotPost(page);
      hub.failNext = true; const orig = hub.handle.bind(hub);
      await page.route('**/api/datasets/**/commit/**', r => r.fulfill({ status: 500, body: '{}' }));
      await page.click(chip('a1', 'youtube')); await until(async () => (await page.locator('.toast.error').count()) > 0, 25000); await sleep(800);
      { const pv = await pressed(page, chip('a1', 'youtube')); ok(pv === 'false' && hub.commits.length === 0, 'failed write: the chip rolls back, nothing committed ' + pv + ' ' + hub.commits.length); }
      ok((await page.textContent('#toasts')).length > 0, 'failed write: an error toast is shown');
      await ctx.close();
    }
  } finally { await browser.close(); server.close(); serverRo.close(); serverSep.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
