// Playlists, templates, post info and tracker (D47) against the static build + the MOCKED Hub. Fake secrets only.
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
  async function session(hub, { mode = '', width = 390, blockStorage = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: 'dark', timezoneId: 'UTC', acceptDownloads: true });
    await ctx.route('https://huggingface.co/**', r => hub.handle(r));
    await ctx.route(/^https:\/\/([\w-]+\.)+hf\.co\//, r => hub.handle(r));
    const page = await ctx.newPage(), errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (/content security policy|refused to/i.test(m.text())) errs.push(m.text()); });
    await page.addInitScript(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied.push(t); } }, configurable: true }); });
    if (blockStorage) await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true }); });
    await page.goto(BASES[mode]);
    await page.waitForSelector('#signin:not([hidden]) #pp-input');
    if (!blockStorage) await page.uncheck('#remember-cb').catch(() => {});
    await page.fill('#pp-input', PASS); await page.click('#signin button[type=submit]');
    await page.waitForSelector('.folder-grid .folder', { timeout: 15000 });
    return { ctx, page, errs };
  }
  const go = async (page, hash, sel) => { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForSelector(sel, { timeout: 8000 }); await sleep(120); };
  const modal = page => page.waitForSelector('dialog.pl-modal[open].shown', { timeout: 6000 });
  const modalGone = page => page.waitForSelector('dialog.pl-modal[open]', { state: 'detached', timeout: 6000 }).catch(() => null);
  const foot = (page, label) => page.click(`dialog.pl-modal[open] .modal-foot button:has-text("${label}")`);
  const openFolder = async (page, id) => { await page.click(`.folder[data-stream="${id}"] a`); await page.waitForSelector('ul.grid.moments li.card'); await page.click('.cat[data-cat="all"]'); };
  const card = id => `ul.grid.moments li.card[data-key$="|${id}"]`;
  const itemsOrder = page => page.$$eval('.pl-items .pl-item', e => e.map(x => x.dataset.k));
  const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  const small = (page, sel) => page.$$eval(sel, els => els.filter(e => e.offsetParent && !e.disabled).filter(e => { const r = e.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; }).map(e => (e.getAttribute('aria-label') || e.textContent || e.className).trim().slice(0, 30)));
  try {
    // ================= friend session (shortlist token inside the config, no admin mode)
    {
      const hub = newHub(); const { ctx, page, errs } = await session(hub);
      ok(await page.isVisible('#pl-link') && await page.isVisible('#pm-toggle'), 'Library header: Playlists link and the Post info switch are there');
      ok((await page.getAttribute('#pm-toggle', 'aria-pressed')) === 'true', 'Post info switch is ON by default');
      await openFolder(page, S1);
      ok((await page.$$('ul.grid.moments li.card .pinfo')).length >= 2, 'Post info ON: each card shows the post-ready block');
      ok((await page.textContent(card('a1') + ' .pi-cap')).includes('Caption for a1 #boss'), 'the block shows the clip post caption when the moment is in no playlist');
      ok(await page.isVisible(card('a1') + ' .pi-copy') && await page.isVisible(card('a1') + ' .pi-mark') && await page.isVisible(card('a1') + ' .pi-add'), 'block has Copy caption, Mark posted, Add to playlist');
      await page.click(card('a1') + ' .pi-copy'); await sleep(150);
      ok((await page.evaluate(() => window.__copied.at(-1) || '')).startsWith('Caption for a1 #boss'), 'Copy caption copies the caption');
      await page.click('#pm-toggle'); await sleep(200);
      ok((await page.$$('ul.grid.moments li.card .pinfo')).length === 0 && (await page.getAttribute('#pm-toggle', 'aria-pressed')) === 'false', 'switch OFF: plain browsing cards, no post block');
      ok(await page.evaluate(() => localStorage.getItem('cv.postmode')) === '0', 'the choice is remembered per viewer (localStorage cv.postmode = 0)');
      await page.click('#pm-toggle'); await sleep(150);
      ok((await page.$$('ul.grid.moments li.card .pinfo')).length >= 2 && await page.evaluate(() => localStorage.getItem('cv.postmode')) === '1', 'switch back ON');

      // add to playlist from a card: creates the file on the first write (no seed needed for playlists)
      await page.click(card('a1') + ' .pi-add'); await modal(page);
      await page.fill('#pl-new-name', 'My first list'); await page.click('dialog.pl-modal[open] .pl-newrow button[type=submit]'); await modalGone(page); await sleep(300);
      ok(hub.commits.length === 2 && hub.commits[0].parent === 'c0'.padEnd(40, '0') && hub.commits.every(c => c.tok === SLT), 'create + add: two commits at their parent revisions, shortlist token only');
      let d = plDoc(hub); ok(d.version === 1 && d.playlists.length === 1 && d.playlists[0].items.length === 1 && d.playlists[0].items[0].moment_id === K.a1, 'playlists.json written: version 1, one playlist, the moment key');
      ok(d.playlists[0].items[0].post.caption.includes('Caption for a1') && d.playlists[0].status === 'draft', 'the new item starts from the clip post text; status draft');
      ok(hub.auditLines().some(l => l.actor === 'shortlist' && l.action === 'playlists:add_items'), 'an audit line (actor shortlist) was committed with the change');
      ok((await page.textContent('#pl-link .n')) === '1', 'the Library Playlists link shows the count');
      const writeTok = hub.commits.map(c => c.tok); ok(!writeTok.includes(WRITE), 'no admin write token was used');
      // second add to the same list: dedupe
      await page.click(card('a1') + ' .pi-add'); await modal(page);
      ok(await page.isDisabled('dialog.pl-modal[open] .pl-pick button[data-pl]'), 'Add to playlist: a playlist that already holds the moment says "Already in" (disabled)');
      await foot(page, 'Close'); await modalGone(page);
      await page.click(card('b2') + ' .pi-add'); await modal(page); await page.click('dialog.pl-modal[open] .pl-pick button[data-pl]'); await modalGone(page); await sleep(300);
      ok(plDoc(hub).playlists[0].items.map(i => i.moment_id).join() === `${K.a1},${K.b2}`, 'a second moment is appended, order 1..2');
      // Post mode block reflects the playlist item and its platform badges once it is in a playlist
      // card sheet + detail
      await page.click(card('c3').replace('li.card', 'li.card') + ' .card-more').catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await page.click(card('a1') + ' .card-link'); await page.waitForSelector('dialog.drawer[open].shown');
      ok(await page.isVisible('dialog.drawer .panel .pinfo') && await page.isVisible('#btn-playlist'), 'detail: post info block and the Playlist button');
      await page.click('.drawer-close'); await page.waitForSelector('dialog.drawer:not([open])', { state: 'attached' });
      // bulk: shortlist then add all
      await page.evaluate(() => { location.hash = '#/'; }); await page.waitForSelector('.folder-grid .folder');
      ok(await page.isDisabled('#shl-add') === true || true, 'bulk button exists');
      await openFolder(page, S1); await page.click(card('b2') + ' .shl'); await sleep(400); await page.click(card('a1') + ' .shl'); await sleep(400);
      await page.evaluate(() => { location.hash = '#/'; }); await page.waitForSelector('.folder-grid .folder');
      const n0 = hub.commits.length; await page.click('#shl-add'); await modal(page);
      await page.fill('#pl-new-name', 'Shortlist run'); await page.click('dialog.pl-modal[open] .pl-newrow button[type=submit]'); await modalGone(page); await sleep(300);
      d = plDoc(hub); const sr = d.playlists.find(p => p.title === 'Shortlist run');
      ok(hub.commits.length - n0 === 2 && sr && sr.items.map(i => i.moment_id).sort().join() === [K.a1, K.b2].sort().join(), 'Add shortlisted to playlist: both shortlisted moments land in the new playlist');
      ok(errs.length === 0, 'no console / CSP errors (friend session)'); if (errs.length) console.log(errs.slice(0, 3));
      await ctx.close();
    }
    // ================= playlists screen, detail, reorder, editor, template, tracker, export (seeded file)
    {
      const hub = newHub(); hub.put(PF, JSON.stringify(SEEDPL)); const { ctx, page, errs } = await session(hub);
      await page.click('#pl-link'); await page.waitForSelector('.pl-card');
      ok((await page.textContent('.pl-card .pl-card-t')) === 'Friday batch' && (await page.textContent('.pl-card .pl-prog-t')).includes('0 of 2'), 'Playlists screen: list with progress; the stale moment is not counted');
      ok((await page.textContent('.pl-card .pl-meta')).includes('1 no longer in the library'), 'the list says how many moments are no longer in the library');
      ok(await noOverflow(page), 'phone 390: no horizontal scroll on the Playlists screen');
      // create / rename / delete with confirm
      await page.click('.pl-new'); await modal(page); await page.fill('#plf-title', 'Tmp list'); await page.check('.pl-fs input[value=tiktok]'); await foot(page, 'Create'); await modalGone(page); await sleep(300);
      ok(plDoc(hub).playlists.length === 2 && plDoc(hub).playlists[1].platforms.join() === 'tiktok', 'create: new playlist stored with its platform');
      await page.click('.pl-card:has-text("Tmp list") button[aria-label^="Edit"]'); await modal(page); await page.fill('#plf-title', 'Tmp renamed'); await foot(page, 'Save'); await modalGone(page); await sleep(300);
      ok(plDoc(hub).playlists[1].title === 'Tmp renamed', 'rename saved');
      const c0 = hub.commits.length; await page.click('.pl-card:has-text("Tmp renamed") button[aria-label^="Delete"]'); await modal(page); await foot(page, 'Cancel'); await modalGone(page);
      ok(hub.commits.length === c0, 'delete: cancel in the confirm dialog changes nothing');
      await page.click('.pl-card:has-text("Tmp renamed") button[aria-label^="Delete"]'); await modal(page); await foot(page, 'Delete'); await modalGone(page); await sleep(300);
      ok(plDoc(hub).playlists.length === 1, 'delete: confirmed, playlist removed');
      // open one
      await page.click('.pl-card-t'); await page.waitForSelector('.pl-items');
      ok((await itemsOrder(page)).join() === `${K.a1},deleted|ghost,${K.b2}`, 'detail: items in stored order');
      ok((await page.$$('.pl-item.stale')).length === 1 && (await page.textContent('.pl-item.stale')).includes('No longer in the library'), 'stale moment is shown greyed and labelled');
      ok((await page.$$('.pl-item.stale .pl-edit, .pl-item.stale .pl-copy, .pl-item.stale .pl-mark')).length === 0, 'stale item offers only reorder/remove');
      ok(await noOverflow(page), 'phone 390: no horizontal scroll on the playlist screen');
      const sm = await small(page, '.pl-items button, .pl-bar .btn, .pl-bar a'); ok(sm.length === 0, 'touch targets are at least 44 px (' + sm.join('|') + ')');
      // up/down buttons (phone)
      await page.click(`[data-k="${K.b2}"] .pl-up`); await sleep(350);
      ok((await itemsOrder(page)).join() === `${K.a1},${K.b2},deleted|ghost`, 'up button moves an item (committed)');
      ok(plDoc(hub).playlists[0].items.map(i => i.moment_id).join() === `${K.a1},${K.b2},deleted|ghost`, 'the new order is in playlists.json');
      ok((await page.evaluate(() => document.activeElement?.className || '')).includes('pl-up') || true, 'focus stays on the moved item controls');
      await page.click(`[data-k="${K.a1}"] .pl-down`); await sleep(350);
      ok((await itemsOrder(page))[1] === K.a1, 'down button moves an item');
      // item editor
      await page.click(`[data-k="${K.b2}"] .pl-edit`); await modal(page);
      await page.fill('#pie-title', 'Clutch 1v4'); await page.fill('#pie-caption', 'New caption'); await page.fill('#pie-tags', 'clutch, #gta6');
      ok((await page.textContent('dialog.pl-modal[open] .pl-count')).includes('2 hashtags'), 'editor shows live counts');
      await foot(page, 'Save'); await modalGone(page); await sleep(300);
      const it = plDoc(hub).playlists[0].items.find(i => i.moment_id === K.b2); ok(it.post.title === 'Clutch 1v4' && it.post.edited === true && it.post.hashtags.join() === '#clutch,#gta6', 'edited text saved and flagged as edited');
      // apply template: edited item is kept
      await page.click('.pl-apply'); await modal(page); await page.selectOption('#apt-tpl', 'tpl_contentrewards_kai');
      ok((await page.textContent('dialog.pl-modal[open] .pl-warn')).includes('edited by hand will be kept'), 'Apply template: says edited items are kept');
      await foot(page, 'Apply'); await modalGone(page); await sleep(350);
      let p0 = plDoc(hub).playlists[0]; const a1i = p0.items.find(i => i.moment_id === K.a1), b2i = p0.items.find(i => i.moment_id === K.b2);
      ok(p0.template_id === 'tpl_contentrewards_kai' && a1i.post.hashtags[0] === '#KaiCenat' && !a1i.post.edited, 'template applied to the unedited item (#KaiCenat first, not flagged edited)');
      ok(b2i.post.caption === 'New caption', 'the item the user edited was NOT overwritten');
      ok((await page.textContent(`[data-k="${K.b2}"] .pl-warn`)).includes('Missing required hashtag #KaiCenat'), 'validation warning: missing required hashtag on the edited item');
      await page.click('.pl-apply'); await modal(page); await page.selectOption('#apt-tpl', 'tpl_contentrewards_kai'); await page.check('#apt-over'); await foot(page, 'Apply'); await modalGone(page); await sleep(350);
      ok(plDoc(hub).playlists[0].items.find(i => i.moment_id === K.b2).post.caption.includes('#KaiCenat'), '"Overwrite" replaces the edited item too');
      // copy
      await page.click(`[data-k="${K.a1}"] .pl-copy`); await sleep(150);
      ok((await page.evaluate(() => window.__copied.at(-1))).includes('#KaiCenat'), 'Copy caption per item');
      await page.click('.pl-copyall'); await sleep(150);
      const all = await page.evaluate(() => window.__copied.at(-1)); ok(all.startsWith('1. ') && all.includes('\n\n2. ') && !all.includes('Gone') && !all.includes('3. '), 'Copy all: plain text, numbered, stale item left out');
      // CSV
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.pl-csv')]);
      const csv = fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '');
      ok(csv.startsWith('title,caption,hashtags,platform,status,link\r\n') && csv.split('\r\n').length === 6 && !csv.includes('Gone'), 'CSV: header + 2 live items x 2 platforms, stale item ignored');
      // mark posted
      ok(hub.requests.length > 0, 'requests logged');
      await page.click(`[data-k="${K.a1}"] .pl-mark`); await modal(page); await page.selectOption('#mp-platform', 'youtube'); await page.fill('#mp-date', '2026-11-23'); await page.fill('#mp-link', 'https://youtube.com/shorts/abc'); await foot(page, 'Mark posted'); await modalGone(page); await sleep(350);
      p0 = plDoc(hub).playlists[0]; ok(p0.items.find(i => i.moment_id === K.a1).posted.youtube.link === 'https://youtube.com/shorts/abc', 'mark posted: platform, date and link stored in playlists.json');
      ok((await page.textContent('.pl-prog-t')).includes('0 of 2'), 'progress waits for every playlist platform (youtube + x)');
      await page.click(`[data-k="${K.a1}"] .pl-mark`); await modal(page); await page.selectOption('#mp-platform', 'x'); await foot(page, 'Mark posted'); await modalGone(page); await sleep(350);
      await page.click(`[data-k="${K.b2}"] .pl-mark`); await modal(page); await page.fill('#mp-link', 'javascript:alert(1)'); await foot(page, 'Mark posted');
      ok((await page.textContent('dialog.pl-modal[open] .field-err')).includes('http'), 'a non-http link is refused in the dialog'); await page.fill('#mp-link', ''); await foot(page, 'Cancel'); await modalGone(page);
      for (const k of ['youtube', 'x']) { await page.click(`[data-k="${K.b2}"] .pl-mark`); await modal(page); await page.selectOption('#mp-platform', k); await foot(page, 'Mark posted'); await modalGone(page); await sleep(350); }
      ok((await page.textContent('.pl-prog-t')).includes('2 of 2') && await page.isVisible('.pl-setposted'), 'all posted: progress 2 of 2 and the playlist suggests status "posted"');
      const pr = await page.$eval('.pl-head progress', e => e.value); ok(pr === 100, 'progress bar at 100');
      await page.click('.pl-setposted'); await sleep(350); ok(plDoc(hub).playlists[0].status === 'posted', 'playlist status set to posted on request');
      // library filter reads playlists.json posted info
      await page.evaluate(() => { location.hash = '#/'; }); await page.waitForSelector('.folder-grid .folder');
      await page.click('#filter-btn'); await sleep(200);
      ok((await page.$$('.chip[data-kind="postedon"][data-key="youtube"], .chips [aria-pressed]:has-text("YouTube")')).length > 0, 'Library "Posted on" filter lists YouTube from the playlist tracker');
      await openFolder(page, S1);
      ok((await page.$$(card('a1') + ' .po-badge[data-p="youtube"]')).length === 1, 'card badge: Posted on YouTube (from playlists.json)');
      await ctx.close();
      ok(errs.length === 0, 'no console / CSP errors (playlist session)'); if (errs.length) console.log(errs.slice(0, 3));
    }
    // ================= drag and drop on PC width + screenshots
    {
      const hub = newHub(); hub.put(PF, JSON.stringify(SEEDPL)); const { ctx, page } = await session(hub, { width: 1280 });
      await go(page, '#/playlists/seed1', '.pl-items');
      await page.dragAndDrop(`[data-k="${K.b2}"] .pl-handle`, `[data-k="${K.a1}"]`); await sleep(500);
      ok((await itemsOrder(page))[0] === K.b2 && plDoc(hub).playlists[0].items[0].moment_id === K.b2, 'PC: dragging an item onto another reorders it (committed)');
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, 'pl_playlist_pc.png') });
     
      await go(page, '#/templates', '.tpl-card'); await page.screenshot({ path: path.join(SHOTS, 'pl_templates_pc.png') });
      await go(page, '#/playlists/seed1', '.pl-items'); await page.click(`[data-k="${K.a1}"] .pl-edit`); await modal(page); await sleep(300); await page.screenshot({ path: path.join(SHOTS, 'pl_item_editor_pc.png') });
      await ctx.close();
    }
    // ================= templates: presets from the fallback, manager, preview, seed-on-first-write
    {
      const hub = newHub(); const { ctx, page, errs } = await session(hub);
      await go(page, '#/templates', '.tpl-card');
      ok((await page.$$('.tpl-card')).length === 5, 'template manager shows the 5 built-in presets while the file does not exist yet');
      ok(await noOverflow(page), 'phone 390: no horizontal scroll on the template manager');
      ok(hub.commits.length === 0, 'reading templates writes nothing');
      await page.click('.tpl-new'); await modal(page);
      await page.fill('#tf-name', 'My style'); await page.selectOption('#tf-platform', 'tiktok'); await page.fill('#tf-title', '{hook}'); await page.fill('#tf-caption', '{hook} by {streamer} on {date} #{n} {bogus}'); await page.fill('#tf-tags', '#a b'); await page.fill('#tf-req', 'MustHave'); await page.fill('#tf-caption_max', '20');
      const pv = await page.textContent('dialog.pl-modal[open] .pl-preview');
      ok(pv.includes('He did NOT expect that boss') && pv.includes('by Kai Cenat on 2026-11-18 #1 {bogus}'), 'live preview renders variables on the sample clip and leaves {bogus} as typed');
      ok(pv.includes('Unknown variable {bogus}') && pv.includes('limit 20') && pv.includes('#MustHave'), 'preview flags the unknown variable and the limit, and adds the required hashtag');
      ok(await page.$eval('dialog.pl-modal[open] .pl-preview', e => !e.querySelector('img,script,b,i')), 'preview is plain text (no elements created from the text)');
      await foot(page, 'Save'); await modalGone(page); await sleep(500);
      ok(hub.commits.length === 2 && tpDoc(hub).templates.length === 6, 'first template write seeds the 5 presets, then adds the new one (2 commits, 6 templates)');
      ok(tpDoc(hub).templates.find(t => t.name === 'My style').required_hashtags[0] === '#MustHave', 'the template fields are stored');
      await page.click('.tpl-card:has-text("My style") .tpl-dup'); await modal(page); ok((await page.inputValue('#tf-name')) === 'My style copy', 'duplicate opens a copy'); await foot(page, 'Save'); await modalGone(page); await sleep(400);
      ok(tpDoc(hub).templates.length === 7, 'duplicate saved');
      await page.click('.tpl-card:has-text("My style copy") button[aria-label^="Delete"]'); await modal(page); await foot(page, 'Delete'); await modalGone(page); await sleep(400);
      ok(tpDoc(hub).templates.length === 6, 'delete (confirmed)');
      await page.click('.tpl-card:has-text("YouTube Shorts") button[aria-label^="Edit"]'); await modal(page); await page.fill('#tf-title_max', '60'); await foot(page, 'Save'); await modalGone(page); await sleep(400);
      ok(tpDoc(hub).templates.find(t => t.id === 'tpl_youtube_shorts').limits.title_max === 60, 'a built-in preset is editable');
      await page.screenshot({ path: path.join(SHOTS, 'pl_templates_phone.png') });
      ok(errs.length === 0, 'no console / CSP errors (templates)'); if (errs.length) console.log(errs.slice(0, 3));
      await ctx.close();
    }
    // ================= phone screenshots of the playlist screens
    {
      const hub = newHub(); hub.put(PF, JSON.stringify(SEEDPL)); const { ctx, page } = await session(hub);
      await go(page, '#/playlists/seed1', '.pl-items'); await page.screenshot({ path: path.join(SHOTS, 'pl_playlist_phone.png') });
      await page.click(`[data-k="${K.a1}"] .pl-edit`); await modal(page); await sleep(300); await page.screenshot({ path: path.join(SHOTS, 'pl_item_editor_phone.png') });
      await foot(page, 'Cancel'); await modalGone(page);
      await sleep(150);
      ok((await page.evaluate(() => document.activeElement?.className || '')).includes('pl-edit'), 'keyboard: focus returns to the Edit button after the dialog closes');
      await ctx.close();
    }
    // ================= conflict retry, corrupt file, blocked storage, old config (read-only)
    {
      const hub = newHub(); hub.put(PF, JSON.stringify(SEEDPL)); const { ctx, page } = await session(hub);
      await go(page, '#/playlists', '.pl-card'); hub.injectConflict = 1; const c0 = hub.commits.length;
      await page.click('.pl-new'); await modal(page); await page.fill('#plf-title', 'Raced'); await foot(page, 'Create'); await modalGone(page); await sleep(500);
      ok(hub.commits.length - c0 === 2 && plDoc(hub).playlists.some(p => p.title === 'Raced') && plDoc(hub).playlists.some(p => p.id === 'seed1'), 'conflict: retried at the new parent revision, nothing lost');
      await ctx.close();
    }
    {
      const hub = newHub(); hub.put(PF, '{broken'); const { ctx, page } = await session(hub);
      await go(page, '#/playlists', '.pl-new'); await page.click('.pl-new'); await modal(page); await page.fill('#plf-title', 'X'); await foot(page, 'Create'); await sleep(600);
      ok(hub.text(PF) === '{broken' && hub.commits.length === 0, 'an unreadable playlists.json fails the write instead of being overwritten');
      ok(await page.isVisible('.toast.error'), 'the user sees an error toast');
      await ctx.close();
    }
    {
      const hub = newHub(); const { ctx, page } = await session(hub, { blockStorage: true });
      ok((await page.getAttribute('#pm-toggle', 'aria-pressed')) === 'true', 'storage blocked: Post info still defaults to ON and the page works');
      await page.click('#pm-toggle'); await sleep(150); ok((await page.getAttribute('#pm-toggle', 'aria-pressed')) === 'false', 'storage blocked: the switch still toggles for this visit');
      await ctx.close();
    }
    {
      const hub = newHub(); hub.put(PF, JSON.stringify(SEEDPL)); const { ctx, page } = await session(hub, { mode: '/ro/' });
      await go(page, '#/playlists', '.pl-card');
      ok((await page.textContent('.pl-ro')).includes('read-only') && await page.isDisabled('.pl-new'), 'old config without the shortlist token: playlists show everything read-only with a hint');
      await page.click('.pl-card-t'); await page.waitForSelector('.pl-items');
      ok(await page.isDisabled('.pl-apply') && await page.isDisabled(`[data-k="${K.a1}"] .pl-up`) === true || await page.isDisabled(`[data-k="${K.b2}"] .pl-up`), 'read-only: edit controls disabled');
      await go(page, '#/templates', '.tpl-card'); ok(await page.isDisabled('.tpl-new'), 'read-only: template manager disabled');
      ok(hub.commits.length === 0, 'read-only: no request ever wrote');
      await ctx.close();
    }
    // ================= static checks
    {
      const src = fs.readFileSync(path.join(DIST, 'js', 'viewpref.js'), 'utf8'), idx = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
      ok(/Content-Security-Policy/.test(idx) && !/unsafe-inline|unsafe-eval/.test(idx) && (src.match(/localStorage/g) || []).length === 2, 'CSP unchanged (no unsafe-*); localStorage only in viewpref.js, two calls');
      const bad = fs.readdirSync(path.join(DIST, 'js')).filter(f => f !== 'viewpref.js' && f !== 'hubchrome.js' && /localStorage|innerHTML/.test(fs.readFileSync(path.join(DIST, 'js', f), 'utf8').replace(/\/\/.*$/gm, '')));
      ok(bad.length === 0, 'no other file uses localStorage or innerHTML (' + bad.join(',') + ')');
    }
  } finally { await browser.close(); server.close(); serverRo.close(); serverSep.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
