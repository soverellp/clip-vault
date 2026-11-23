// Run: NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfstatic/tests/test_static.js
// Needs ffmpeg + python deps (cryptography). Fake secrets only. The Hub is MOCKED with page.route: CORS, real LFS targets and the real
// commit API are NOT exercised here (see README PROVEN vs UNTESTED).
const { chromium } = require('playwright');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { MockHub, sha, DS } = require('./mockhub');

const READ = 'hf_' + 'FAKEREADTOKEN00000000000000000000', WRITE = 'hf_' + 'FAKEWRITETOKEN0000000000000000000', WIDE = 'hf_' + 'FAKEWIDETOKEN000000000000000000000';
const OTHER = 'hf_' + 'FAKEOTHERDATASET0000000000000000000', UNKNOWN = 'hf_' + 'FAKEUNKNOWNSHAPE000000000000000000', GLOBALW = 'hf_' + 'FAKEGLOBALWRITE00000000000000000000', OTHERW = 'hf_' + 'FAKEOTHERWRITEPERM0000000000000000', READOTHER = 'hf_' + 'FAKEREADOTHERREPO000000000000000000', READONLY = 'hf_' + 'FAKEROTOKEN00000000000000000000000', CASEDS = 'hf_' + 'FAKECASEDATASET000000000000000000', NOWRITE = 'hf_' + 'FAKENOWRITEDATASET00000000000000000';
const PASS = 'copper lantern meadow quiver';
const SHOTS = '/tmp/claude-0/hfspace-shots/static';
fs.mkdirSync(SHOTS, { recursive: true });
const HERE = __dirname, ROOT = path.resolve(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfstatic-'));
const DIST = path.join(tmp, 'dist');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, what = '') { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() - t > ms) { console.log('  (timeout waiting for ' + what + ')'); return false; } await sleep(60); } }

// ---------------- build the real dist with fake secrets (proves Python encrypt -> JS decrypt)
const b = spawnSync('python3', [path.join(ROOT, 'build_static.py'), '--no-info-copy', '--out', DIST], { env: { ...process.env, VAULT_READ_TOKEN: READ, VAULT_PASSPHRASE: PASS }, encoding: 'utf8' });
if (b.status !== 0) { console.log(b.stdout, b.stderr); process.exit(1); }
const mk = (name, color) => { const f = path.join(tmp, name + '.mp4'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=64x112:d=2:r=10`, '-c:v', 'libvpx-vp9', '-b:v', '50k', '-movflags', '+faststart', f]); return f; };
const JPG = path.join(tmp, 'p.jpg'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x112:d=1', '-frames:v', '1', JPG]);
const VID = { a1: mk('a1', 'blue'), b2: mk('b2', 'green'), c3: mk('c3', 'purple'), up1: mk('up1', 'yellow'), up2: mk('up2', 'orange'), up3: mk('up3', 'pink') };
const JUNK = path.join(tmp, 'junk.mp4'); fs.writeFileSync(JUNK, Buffer.from('this is definitely not an mp4 file'));

function newHub(extra = {}) {
  const hub = new MockHub({ read: READ, writeOk: WRITE, extra: {
    [WIDE]: { name: 'x', auth: { accessToken: { role: 'write' } } },
    [READONLY]: { name: 'x', auth: { accessToken: { role: 'read' } } },
    [OTHER]: { name: 'x', auth: { accessToken: { role: 'fineGrained', fineGrained: { global: [], scoped: [{ entity: { type: 'dataset', name: DS }, permissions: ['repo.write'] }, { entity: { type: 'model', name: 'Soverellp/other' }, permissions: ['repo.write'] }] } } } },
    [UNKNOWN]: { name: 'x', weird: true },
    [GLOBALW]: { name: 'x', auth: { accessToken: { role: 'fineGrained', fineGrained: { global: ['discussion.write'], scoped: [{ entity: { type: 'dataset', name: DS }, permissions: ['repo.write'] }] } } } },
    [OTHERW]: { name: 'x', auth: { accessToken: { role: 'fineGrained', fineGrained: { global: [], scoped: [{ entity: { type: 'dataset', name: DS }, permissions: ['repo.write'] }, { entity: { type: 'model', name: 'Soverellp/other' }, permissions: ['inference.endpoints.write'] }] } } } },
    [CASEDS]: { name: 'x', auth: { accessToken: { role: 'fineGrained', fineGrained: { global: [], scoped: [{ entity: { type: 'dataset', name: DS.toUpperCase() }, permissions: ['repo.write'] }] } } } },
    [NOWRITE]: { name: 'x', auth: { accessToken: { role: 'fineGrained', fineGrained: { global: [], scoped: [{ entity: { type: 'dataset', name: DS }, permissions: ['repo.content.read'] }, { entity: { type: 'model', name: 'Soverellp/other' }, permissions: ['repo.write'] }] } } } },
    [READOTHER]: { name: 'x', auth: { accessToken: { role: 'fineGrained', fineGrained: { global: [], scoped: [{ entity: { type: 'dataset', name: DS }, permissions: ['repo.write'] }, { entity: { type: 'model', name: 'Soverellp/other' }, permissions: ['repo.content.read'] }] } } } },
    ...extra } });
  const mkc = (id, stream, title, dur) => ({ id, stream, title, hook: 'h ' + id, desc: 'd', dur, score: 9, video: `clips/${id}.mp4`, poster: `clips/${id}.jpg`, size: fs.statSync(VID[id]).size, post: 'Post ' + id });
  hub.put('index.json', JSON.stringify({ clips: [mkc('a1', '2026-01-01_alpha', 'Clip A', 45), mkc('b2', '2026-01-01_alpha', 'Clip B', 50), mkc('c3', '2026-02-02_beta', 'Clip C', 41)] }));
  for (const id of ['a1', 'b2', 'c3']) { hub.put(`clips/${id}.mp4`, fs.readFileSync(VID[id]), true); hub.put(`clips/${id}.jpg`, fs.readFileSync(JPG)); }
  hub.put('.gitattributes', '*.mp4 filter=lfs');
  hub.put('_config/tombstones.json', JSON.stringify({ version: 1, ids: ['old1'] }));
  return hub;
}

// ---------------- static server for dist (the Space)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(DIST, p); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('nf'); return; }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  async function session(hub, o = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    if (!o.feedOn) await ctx.addInitScript(() => { try { localStorage.setItem('cv.feed', '0'); } catch (e) {} }); // Post mode opens by itself on first load (D49): these tests browse the grid
    await ctx.route('https://huggingface.co/**', r => hub.handle(r));
    await ctx.route(/^https:\/\/([\w-]+\.)+hf\.co\//, r => hub.handle(r));
    const page = await ctx.newPage(), viol = [], logs = [], revoked = [];
    await page.exposeFunction('__rev', u => revoked.push(u));
    await page.addInitScript(() => {
      window.__v = []; document.addEventListener('securitypolicyviolation', e => window.__v.push(e.violatedDirective + ' ' + e.blockedURI));
      const rv = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = u => { try { window.__rev(u); } catch { /* ignore */ } rv(u); };
    });
    page.on('console', m => { logs.push(m.text()); if (process.env.DBG) console.log('  [console] ' + m.text()); if (/content security policy|refused to/i.test(m.text())) viol.push('console: ' + m.text()); });
    page.on('pageerror', e => viol.push('pageerror: ' + e.message));
    return { ctx, page, viol, logs, revoked, hub };
  }
  const shot = async (page, n) => { await sleep(900); return page.screenshot({ path: path.join(SHOTS, n + '.png') }); };
  async function unlock(page, pw = PASS) {
    await page.waitForSelector('#signin:not([hidden]) #pp-input');
    await page.fill('#signin #pp-input', pw); await page.click('#signin button[type=submit]');
  }
  async function toLibrary(page, remember = false) { await page.waitForSelector('#signin:not([hidden]) #remember-cb'); if (!remember) await page.uncheck('#remember-cb'); await unlock(page); await page.waitForSelector('li.card .card-link', { timeout: 15000 }); }
  const clean = async p => { for (let i = 0; i < 4; i++) { await p.evaluate(() => { location.hash = '#/'; }); await sleep(900); if (!(await p.$('dialog.drawer[open]'))) return; } };
  const cardCount = page => page.$$eval('li.card[data-id]', e => e.length);

  try {
    // ============================ VIEWER
    {
      const hub = newHub(); const { ctx, page, viol, logs, revoked } = await session(hub);
      await page.goto(base + '/');
      await page.waitForSelector('#signin:not([hidden]) #pp-input');
      ok((await page.textContent('#signin')).toLowerCase().includes('passphrase') && !(await page.textContent('#signin')).includes('Google'), 'unlock screen asks for the passphrase (no Google wording)');
      ok(hub.requests.length === 0, 'no request to the Hub before unlocking');
      await shot(page, '01-unlock');
      await unlock(page, 'wrong wrong wrong wrong');
      await until(async () => /did not work/.test(await page.textContent('#signin-status')), 15000, 'wrong-passphrase message');
      const wrongMsg = await page.textContent('#signin-status');
      ok(wrongMsg === 'That passphrase did not work', 'wrong passphrase: one generic message (' + wrongMsg + ')');
      ok(hub.requests.length === 0, 'wrong passphrase makes no Hub request');
      await page.waitForSelector('#signin #pp-input:visible'); await page.fill('#signin #pp-input', PASS); await page.click('#signin button[type=submit]');
      await until(async () => /Wait/.test(await page.textContent('#signin-status')), 5000, 'delay message');
      ok(/Wait \d+ s/.test(await page.textContent('#signin-status')) && hub.requests.length === 0, 'attempt delay: an immediate retry is refused in memory, with no Hub request');
      await sleep(1500);
      await shot(page, '02-wrong-passphrase');
      await page.waitForSelector('#signin #pp-input:visible'); await page.fill('#signin #pp-input', PASS); await page.click('#signin button[type=submit]');
      await page.waitForSelector('li.card .card-link', { timeout: 15000 });
      ok(await cardCount(page) === 3, 'right passphrase: 3 clips listed');
      const idxReq = hub.requests.find(r => r.url.endsWith('/datasets/' + DS + '/resolve/main/index.json'));
      ok(idxReq && idxReq.auth === READ, 'index.json fetched from resolve/main with Authorization Bearer <read token>');
      await until(() => hub.requests.filter(r => r.url.endsWith('.jpg')).length >= 3, 6000, 'posters');
      ok(hub.requests.filter(r => r.url.endsWith('.jpg')).every(r => r.auth === READ), 'posters fetched with the read token');
      ok(hub.requests.filter(r => /\.mp4/.test(r.url)).length === 0, 'NO mp4 request before a tap');
      await page.waitForSelector('li.card img.loaded', { timeout: 8000 }).catch(() => {});
      ok((await page.$$eval('li.card img', i => i.map(x => x.src))).every(s => s.startsWith('blob:')), 'card posters are blob: URLs');
      ok(await page.$('#upload-btn:not([hidden])') === null && await page.$('#tabs:not([hidden])') === null, 'viewer sees no Upload button and no admin tabs (Trash/Audit/People)');
      await sleep(400); await shot(page, '03-library-viewer');
      // the player and the Download button share one in-flight download
      const dd = await page.evaluate(async () => { const a = await import('/js/api.js'); const [x, y] = await Promise.all([a.fetchMedia('clips/c3.mp4'), a.fetchMedia('clips/c3.mp4')]); return [x.url.startsWith('blob:'), y.url.startsWith('blob:'), x.url !== y.url]; });
      ok(dd[0] && dd[1] && dd[2] && hub.requests.filter(r => /c3\.mp4/.test(r.url)).length === 1, 'two parallel requests for the same mp4 share ONE download (no abort, one Hub request)');
      // tap a clip
      await page.click('li.card[data-id=a1] .card-link');
      await page.waitForSelector('dialog.drawer[open] video');
      await until(() => hub.requests.some(r => /a1\.mp4/.test(r.url)), 6000, 'mp4 request');
      const mp4 = hub.requests.find(r => /resolve\/main\/clips\/a1\.mp4/.test(r.url));
      ok(mp4 && mp4.auth === READ, 'after the tap the mp4 is fetched with the read token');
      await until(async () => (await page.$eval('dialog.drawer video', v => v.src)).startsWith('blob:'), 8000, 'video blob src');
      ok(await page.$eval('dialog.drawer video', v => v.src.startsWith('blob:')), 'video plays from a blob: URL');
      ok(await until(() => page.$eval('dialog.drawer video', v => v.readyState >= 1 && v.duration > 1), 8000, 'metadata'), 'video metadata loads (duration > 1 s)');
      await page.$eval('dialog.drawer video', v => { v.muted = true; return v.play(); });
      ok(await until(() => page.$eval('dialog.drawer video', v => v.currentTime > 0.2), 6000, 'playback'), 'playback advances');
      await shot(page, '04-drawer-viewer');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#dl')]);
      ok(dl.suggestedFilename() === 'a1.mp4', 'Download saves the clip from the blob (' + dl.suggestedFilename() + ')');
      const dlBytes = fs.readFileSync(await dl.path());
      ok(sha(dlBytes) === sha(fs.readFileSync(VID.a1)), 'downloaded bytes equal the stored clip');
      // nothing persisted anywhere
      const store = await page.evaluate(async () => ({ keys: Object.keys(localStorage).filter(k => k !== 'cv.feed'), val: localStorage.getItem('cv.pass'), ls: Object.keys(localStorage).filter(k => k !== 'cv.feed').length, ss: sessionStorage.length, ck: document.cookie, idb: (await indexedDB.databases?.())?.length ?? 0, caches: (await caches.keys()).length, sw: (await navigator.serviceWorker.getRegistrations()).length }));
      ok(store.ls === 1 && store.keys[0] === 'cv.pass' && store.val === PASS && store.ss === 0 && store.ck === '' && store.idb === 0 && store.caches === 0 && store.sw === 0, 'only the remembered passphrase (key cv.pass) is in localStorage; nothing in sessionStorage/cookies/IndexedDB/Cache Storage/service workers ' + JSON.stringify(store));
      ok((await ctx.cookies()).length === 0, 'no cookies in the browser context');
      const html = await page.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll('input,textarea')].map(i => i.value).join('|') + location.href);
      ok(!html.includes(READ) && !html.includes(PASS) && !logs.join('\n').includes(READ) && !logs.join('\n').includes(PASS), 'read token and passphrase appear nowhere in DOM, URL or console');
      ok((await ctx.cookies()).length === 0 && !hub.requests.some(r => r.url.includes(READ)), 'token never in a URL');
      // Lock
      const vurl = await page.$eval('dialog.drawer video', v => v.src);
      await page.keyboard.press('Escape'); await until(async () => !(await page.$('dialog.drawer[open]')), 3000, 'drawer closed');
      await page.click('#signout-btn');
      await page.waitForSelector('#signin:not([hidden]) #pp-input', { timeout: 8000 });
      ok(revoked.includes(vurl) || revoked.length >= 3, 'Lock revoked the blob URLs (' + revoked.length + ' revoked)');
      ok(await cardCount(page) === 0 && !(await page.content()).includes(READ), 'after Lock the library is gone and the token is not in the page');
      ok(viol.length === 0 && (await page.evaluate(() => window.__v)).length === 0, 'zero CSP violations / page errors in the viewer session ' + JSON.stringify(viol));
      await ctx.close();
    }
    // browser behaviour the Hub flow relies on: Authorization is dropped on a cross-origin redirect (real Chromium, two local servers)
    {
      const seen = [];
      const mkS = (h) => new Promise(r => { const sv = http.createServer(h); sv.listen(0, '0.0.0.0', () => r(sv)); });
      const B = await mkS((q, r) => { seen.push({ auth: q.headers.authorization || null, origin: q.headers.origin }); r.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' }); r.end('cdn-bytes'); });
      const A = await mkS((q, r) => { if (q.url === '/') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html></html>'); return; } const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization' }; if (q.method === 'OPTIONS') { r.writeHead(204, h); r.end(); return; } seen.push({ hop: 'A', auth: q.headers.authorization || null }); r.writeHead(302, { ...h, location: `http://127.0.0.2:${B.address().port}/blob` }); r.end(); });
      const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${A.address().port}/`);
      const body = await page.evaluate(async u => (await (await fetch(u, { headers: { Authorization: 'Bearer SECRET' }, credentials: 'omit' })).text()), `http://127.0.0.1:${A.address().port}/x`);
      ok(body === 'cdn-bytes' && seen[0].hop === 'A' && seen[0].auth === 'Bearer SECRET' && seen.at(-1).auth === null, 'a real browser drops Authorization on the cross-origin redirect hop (origin A saw it, redirect target did not)');
      await ctx.close(); A.close(); B.close();
    }
    // frame buster (the embedding page is a local server on another loopback address, so no Private Network Access block)
    {
      const mkE = body => new Promise(r => { const sv = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(body); }); sv.listen(0, '0.0.0.0', () => r(sv)); });
      const E1 = await mkE(`<iframe sandbox="allow-scripts allow-same-origin" src="${base}/" width=390 height=800></iframe>`);
      const { ctx, page } = await session(newHub());
      await page.goto(`http://127.0.0.2:${E1.address().port}/`);
      await until(() => page.frames().some(f => f.url().startsWith(base)), 10000, 'iframe');
      const fr = page.frames().find(f => f.url().startsWith(base));
      await fr.waitForSelector('.framed-msg', { state: 'attached', timeout: 10000 }).catch(() => {});
      ok(await fr.evaluate(() => document.documentElement.dataset.framed === '1' && getComputedStyle(document.getElementById('app')).display === 'none' && !!document.querySelector('.framed-msg a')), 'framed (top navigation blocked): the app is hidden and an "open directly" link is shown');
      await ctx.close(); E1.close();
    }

    // ============================ IDLE LOCK
    {
      const hub = newHub(); const { ctx, page } = await session(hub);
      await page.addInitScript(() => { globalThis.__clipVaultIdleMs = 2500; });
      await page.goto(base + '/'); await toLibrary(page);
      for (let i = 0; i < 3; i++) { await sleep(1200); await page.mouse.click(5, 5); }   // activity keeps it unlocked (3.6 s > 2.5 s)
      ok(await page.isVisible('li.card .card-link'), 'idle lock: activity resets the timer (still unlocked after 3.6 s)');
      await page.waitForSelector('#signin:not([hidden]) #pp-input', { timeout: 8000 });
      ok(!(await page.isVisible('li.card .card-link')), 'idle lock: after the idle time the page locks itself (token wiped, unlock screen back)');
      const n = hub.requests.length; await sleep(500); ok(hub.requests.length === n, 'idle lock: nothing talks to the Hub after the lock');
      await ctx.close();
    }

    // ============================ ADMIN
    {
      const hub = newHub(); const { ctx, page, viol, logs } = await session(hub);
      await page.goto(base + '/'); await toLibrary(page);
      await page.click('#admin-btn'); await page.waitForSelector('#admin-token');
      ok(await page.getAttribute('#admin-token', 'type') === 'text' && await page.getAttribute('#admin-token', 'autocomplete') === 'one-time-code' && await page.getAttribute('#admin-token', 'spellcheck') === 'false' && await page.getAttribute('#admin-token', 'autocapitalize') === 'off', 'admin token input: type=text, autocomplete=one-time-code, spellcheck/autocapitalize off');
      ok(await page.$eval('#admin-token', el => getComputedStyle(el).webkitTextSecurity) === 'disc', 'admin token input is still masked (-webkit-text-security: disc)');
      await shot(page, '05-admin-modal');
      const tryTok = async t => { await page.fill('#admin-token', t); await page.click('#admin-go'); await until(async () => (await page.textContent('#admin-status')).length > 0 || (await page.textContent('#admin-warn')).length > 0, 5000, 'verdict'); return [await page.textContent('#admin-status'), await page.textContent('#admin-warn')]; };
      let [s] = await tryTok(READ); ok(/read-only token/.test(s), 'refuses the read token: ' + s);
      ok(!hub.whoamiCalls.includes(READ), 'the read token is refused locally (never sent to whoami)');
      [s] = await tryTok('not-a-token'); ok(/does not look like/.test(s), 'refuses text that is not hf_...');
      [s] = await tryTok('hf_' + 'FAKEBADTOKEN0000000000000000000000'); ok(/did not accept/.test(s), 'refuses a token Hugging Face rejects (401)');
      [s] = await tryTok(WIDE); ok(/account-wide/.test(s), 'refuses a role=write token as account-wide: ' + s);
      [s] = await tryTok(READONLY); ok(/read-only/.test(s), 'refuses a role=read token');
      [s] = await tryTok(NOWRITE); ok(/cannot write to/.test(s) && /dataset\/Soverellp\/clip-vault/i.test(s) && /model\/Soverellp\/other/.test(s), 'no write on the dataset: refused and lists the token scopes: ' + s);
      ok((await page.inputValue('#admin-token')) === '', 'a refused token is cleared from the input');
      [s] = await tryTok(UNKNOWN); ok(/Could not tell how wide/.test(s) && /refused/.test(s) && /Admin$/.test((await page.textContent('#admin-btn')).trim()), 'undeterminable whoami shape: REFUSED (' + s + ')');
      let [, w0] = await tryTok(OTHERW); ok(/model\/Soverellp\/other: inference\.endpoints\.write/.test(w0) && !(await page.textContent('#admin-status')) && /Continue anyway/.test(await page.textContent('#admin-go')), 'write permission on another entity: WARNS naming type/name: perm (' + w0 + ')');
      [, w0] = await tryTok(OTHER); ok(/model\/Soverellp\/other: repo\.write/.test(w0), 'write on another repo: warning names the scope');
      [, w0] = await tryTok(GLOBALW); ok(/global: discussion\.write/.test(w0), 'account-wide global write permission: warning names it');
      await page.click('#admin-go'); await until(async () => /Exit admin/.test(await page.textContent('#admin-btn')), 6000, 'admin on (extra write scope)');
      ok(/Exit admin/.test(await page.textContent('#admin-btn')), 'Continue anyway accepts a token with an extra write scope');
      await page.click('#admin-btn'); await until(async () => /Admin$/.test((await page.textContent('#admin-btn')).trim()), 4000, 'admin off (extra)');
      await page.click('#admin-btn'); await page.fill('#admin-token', CASEDS); await page.click('#admin-go');
      await until(async () => /Exit admin/.test(await page.textContent('#admin-btn')), 6000, 'admin on (case)');
      ok(/Exit admin/.test(await page.textContent('#admin-btn')), 'dataset name with different case is accepted');
      await page.click('#admin-btn'); await until(async () => /Admin$/.test((await page.textContent('#admin-btn')).trim()), 4000, 'admin off (case)');
      await page.click('#admin-btn'); await page.waitForSelector('#admin-token');
      [s] = await tryTok(WIDE); ok(/account-wide/.test(s), 'account-wide role still refused after the relaxation');
      const [, w] = await tryTok(READOTHER); ok(/read access to 1 other/.test(w) && !(await page.textContent('#admin-status')), 'extra read access elsewhere: warns but allows');
      ok(await page.isVisible('#admin-go') && /Continue anyway/.test(await page.textContent('#admin-go')), '... and asks to confirm');
      await page.click('#admin-go'); await until(async () => /Exit admin/.test(await page.textContent('#admin-btn')), 6000, 'admin on');
      ok(/Exit admin/.test(await page.textContent('#admin-btn')), 'token with extra read-only access accepted after the warning');
      await page.click('#admin-btn'); await until(async () => /Admin$/.test((await page.textContent('#admin-btn')).trim()), 4000, 'admin off');
      // proper token
      await page.click('#admin-btn'); await page.fill('#admin-token', WRITE); await page.click('#admin-go');
      await until(async () => /Exit admin/.test(await page.textContent('#admin-btn')), 8000, 'admin on 2');
      ok(hub.whoamiCalls.includes(WRITE), 'token verified through whoami-v2 with the pasted token');
      const dom = await page.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll('input')].map(i => i.value + i.getAttribute('value')).join('|') + location.href);
      ok(!dom.includes(WRITE) && !logs.join('\n').includes(WRITE), 'write token is not in DOM, attributes, URL or console');
      const st = await page.evaluate(async () => ({ ls: Object.keys(localStorage).filter(k => k !== 'cv.feed').length, ss: sessionStorage.length, ck: document.cookie, idb: (await indexedDB.databases?.())?.length ?? 0 }));
      ok(st.ls === 0 && st.ss === 0 && st.ck === '' && st.idb === 0, 'write token not persisted in any storage');
      ok(await page.$('#upload-btn:not([hidden])') !== null && await page.$('a.tab[data-view=trash]') !== null && await page.$('a.tab[data-view=audit]') !== null && await page.$('a.tab[data-view=users]') === null, 'admin sees Upload, Trash, Audit; the People tab stays hidden');
      const me = await page.evaluate(() => import('/js/api.js').then(a => a.me()));
      ok(me.role === 'admin' && me.capabilities.users === false && me.capabilities.upload === true && me.capabilities.delete === true && me.capabilities.audit === true, 'me(): role admin, capabilities {users:false, upload, delete, audit}');
      ok(!(await page.textContent('#tabs')).includes('null'), 'no stray "null" text in the tab bar');
      await shot(page, '06-library-admin');

      // ---- edit metadata
      const headBefore = hub.head; const nc = hub.commits.length;
      await page.click('li.card[data-id=b2] .card-link'); await page.waitForSelector('#btn-edit'); await page.click('#btn-edit');
      await page.fill('#ef-title', 'Clip B renamed'); await page.fill('#ef-tags', 'one, two'); await page.click('#ef-save');
      await until(() => hub.commits.length > nc && hub.commits.at(-1).ok, 8000, 'edit commit');
      let c = hub.commits.at(-1);
      ok(c.parent === headBefore && c.message === 'Edit clip metadata', 'edit: ONE commit with parentCommit = the head that was read');
      ok(c.ops.map(o => o.key + ':' + o.value.path).join(',').startsWith('file:index.json,file:_audit/'), 'edit: operations are index.json + the audit file, in the same commit');
      let idx = hub.index(); const cb = idx.clips.find(x => x.id === 'b2');
      ok(idx.version === 2 && cb.title === 'Clip B renamed' && JSON.stringify(cb.tags) === '["one","two"]' && cb.updated_at, 'edit: index.json is v2 with the new title and tags (v1 file upgraded)');
      let au = hub.auditLines().at(-1); ok(au.action === 'edit' && au.clip_id === 'b2' && au.actor_email === 'admin' && /^\d{4}-\d\d-\d\dT.*Z$/.test(au.at) && au.detail.fields.includes('title'), 'edit: audit line has at/actor "admin"/action/clip id ' + JSON.stringify(au));
      ok(Object.keys(idx.clips[0]).includes('video') && idx.clips.length === 3, 'edit: other clips untouched');
      // ---- posting tracker fields: posted + notes
      let pb2; const nP = hub.commits.length;
      const pr = await page.evaluate(async () => { const a = await import('/js/api.js'); const r = await a.patchClip('b2', { posted: { youtube: '2026-11-18T10:00:00.000Z' }, notes: 'hello\u0007 world\nline2' }); const l = await a.listClips(); return { r, l: l.clips.find(c => c.id === 'b2') }; });
      c = hub.commits.at(-1); idx = hub.index(); const pb = idx.clips.find(x => x.id === 'b2');
      ok(hub.commits.length === nP + 1 && JSON.stringify(pb.posted) === '{"youtube":"2026-11-18T10:00:00Z","instagram":null}' && pb.notes === 'hello world\nline2', 'posted + notes: saved in ONE index.json commit (ISO normalised, other platform kept null, control characters stripped)');
      ok(pr.l.posted.youtube === '2026-11-18T10:00:00Z' && pr.l.notes === 'hello world\nline2' && pr.r.clip.posted.instagram === null, 'posted + notes: returned by patchClip and listClips');
      au = hub.auditLines().at(-1); ok(au.action === 'edit' && au.detail.fields.join() === 'notes,posted' && au.actor === 'admin' && au.actor_email === 'admin', 'posted + notes: audit line has actor and actor_email ' + JSON.stringify(au.detail));
      await page.evaluate(async () => { const a = await import('/js/api.js'); await a.patchClip('b2', { posted: { instagram: '2026-11-19T08:30:00Z' } }); });
      pb2 = hub.index().clips.find(x => x.id === 'b2'); ok(pb2.posted.youtube === '2026-11-18T10:00:00Z' && pb2.posted.instagram === '2026-11-19T08:30:00Z', 'posted: a partial update merges with the stored value');
      await page.evaluate(async () => { const a = await import('/js/api.js'); await a.patchClip('b2', { posted: { youtube: null } }); });
      ok(hub.index().clips.find(x => x.id === 'b2').posted.youtube === null, 'posted: null clears a platform');
      const nQ = hub.commits.length;
      const bad = await page.evaluate(async () => { const a = await import('/js/api.js'); const t = async f => { try { await f(); return 'ok'; } catch (e) { return e.status + ':' + e.code; } };
        return [await t(() => a.patchClip('b2', { posted: { youtube: 'yesterday' } })), await t(() => a.patchClip('b2', { posted: { tiktok: null } })), await t(() => a.patchClip('b2', { notes: 'x'.repeat(501) })), await t(() => a.patchClip('b2', { notes: 5 }))]; });
      ok(bad.every(x => x === '422:invalid') && hub.commits.length === nQ, 'posted/notes validation: bad timestamp, unknown platform, 501-char notes, non-string notes are refused (422) with no commit ' + JSON.stringify(bad));
      await page.keyboard.press('Escape'); await page.evaluate(() => { location.hash = '#/'; }); await sleep(300);

      // ---- trash
      let n0 = hub.commits.length;
      await page.click('li.card[data-id=a1] .card-link'); await page.waitForSelector('#btn-trash'); await page.click('#btn-trash'); await page.waitForSelector('#confirm-ok'); await page.click('#confirm-ok');
      await until(() => hub.commits.length > n0 && hub.commits.at(-1).ok, 8000, 'trash commit');
      c = hub.commits.at(-1); const keys = c.ops.map(o => o.key + ':' + o.value.path);
      const a1sha = sha(fs.readFileSync(VID.a1));
      ok(c.message === 'Trash clip' && keys.includes('lfsFile:trash/clips/a1.mp4') && keys.includes('file:trash/clips/a1.jpg') && keys.includes('deletedFile:clips/a1.mp4') && keys.includes('deletedFile:clips/a1.jpg'), 'trash: ONE commit copies mp4 (lfsFile) + poster (file) to trash/ and deletes the originals: ' + keys.join(' '));
      const lf = c.ops.find(o => o.key === 'lfsFile'); ok(lf.value.oid === a1sha && lf.value.algo === 'sha256' && !('size' in lf.value), 'trash: lfsFile copy uses the source LFS oid (no re-upload)');
      idx = hub.index(); const ca = idx.clips.find(x => x.id === 'a1');
      ok(ca.trashed_at && Math.abs(Date.parse(ca.purge_after) - Date.parse(ca.trashed_at) - 30 * 86400000) < 2000, 'trash: trashed_at set and purge_after = +30 days');
      ok(hub.files.has('trash/clips/a1.mp4') && !hub.files.has('clips/a1.mp4'), 'trash: files moved in the (mock) dataset');
      ok(hub.auditLines().at(-1).action === 'trash', 'trash: audit line in the same commit');
      await until(async () => (await cardCount(page)) === 2, 5000, 'library 2');
      // ---- trash view, restore
      await page.click('a.tab[data-view=trash]'); await page.waitForSelector('li.card[data-id=a1]'); await shot(page, '07-trash');
      n0 = hub.commits.length;
      await page.click('li.card[data-id=a1] .card-link'); await page.waitForSelector('#btn-restore'); await page.click('#btn-restore');
      await until(() => hub.commits.length > n0 && hub.commits.at(-1).ok, 8000, 'restore commit');
      c = hub.commits.at(-1); ok(c.message === 'Restore clip' && c.ops.some(o => o.key === 'lfsFile' && o.value.path === 'clips/a1.mp4') && c.ops.some(o => o.key === 'deletedFile' && o.value.path === 'trash/clips/a1.mp4'), 'restore: copies back and deletes the trash copies');
      ok(hub.index().clips.find(x => x.id === 'a1').trashed_at === null && hub.files.has('clips/a1.mp4') && hub.auditLines().at(-1).action === 'restore', 'restore: index and audit updated');
      // ---- delete forever needs step-up
      await page.evaluate(() => { location.hash = '#/'; }); await page.waitForSelector('li.card[data-id=a1]');
      n0 = hub.commits.length;
      await page.click('li.card[data-id=a1] .card-link'); await page.click('#btn-trash'); await page.click('#confirm-ok'); await until(() => hub.commits.length > n0 && hub.commits.at(-1).ok, 8000, 'retrash');
      await page.click('a.tab[data-view=trash]'); await page.waitForSelector('li.card[data-id=a1]');
      await page.click('li.card[data-id=a1] .card-link'); await page.waitForSelector('#btn-purge'); await page.click('#btn-purge');
      await page.waitForSelector('input.typed'); await page.fill('input.typed', 'Clip A'); n0 = hub.commits.length; await page.click('#confirm-ok');
      await page.waitForSelector('dialog.reauth[open] #pp-input', { timeout: 8000 });
      ok(hub.commits.length === n0, 'delete forever: the passphrase prompt (step-up) comes BEFORE any commit');
      await shot(page, '08-stepup');
      await page.fill('dialog.reauth[open] #pp-input', 'wrong wrong wrong wrong'); await page.click('dialog.reauth[open] button[type=submit]');
      await until(async () => /did not work/.test(await page.textContent('dialog.reauth[open] .form-err')), 6000, 'stepup wrong');
      ok(/did not work/.test(await page.textContent('dialog.reauth[open] .form-err')) && hub.commits.length === n0, 'step-up: a wrong passphrase is refused and nothing is deleted');
      await sleep(1300);
      await page.fill('dialog.reauth[open] #pp-input', PASS); await page.click('dialog.reauth[open] button[type=submit]');
      await until(() => hub.commits.length > n0 && hub.commits.at(-1).ok, 10000, 'purge commit');
      c = hub.commits.at(-1);
      ok(c.message === 'Delete clip forever' && c.ops.filter(o => o.key === 'deletedFile').map(o => o.value.path).sort().join() === 'trash/clips/a1.jpg,trash/clips/a1.mp4', 'delete forever: deletes exactly the trash files');
      ok(!hub.index().clips.some(x => x.id === 'a1') && hub.auditLines().at(-1).action === 'delete_forever' && hub.auditLines().at(-1).detail.title === 'Clip A', 'delete forever: index entry gone, audit has the title');
      { const tj = JSON.parse(hub.text('_config/tombstones.json')); ok(c.ops.some(o => o.key === 'file' && o.value.path === '_config/tombstones.json') && tj.version === 1 && tj.ids.length === 2 && tj.ids[0].id === 'old1' && tj.ids[1].id === 'a1' && /^\d{4}-\d\d-\d\dT.*Z$/.test(tj.ids[1].deleted_at) && 'sha256' in tj.ids[1], 'delete forever: tombstone appended to _config/tombstones.json in the SAME commit (older plain-string entry kept)'); }
      // ---- empty trash: step-up again only after re-entering admin
      await page.evaluate(() => { location.hash = '#/'; }); await sleep(300);
      for (const id of ['b2', 'c3']) { n0 = hub.commits.length; await page.waitForSelector(`li.card[data-id=${id}]`, { timeout: 20000 }).catch(async e => { console.log('  DEBUG url=' + page.url() + ' cards=' + JSON.stringify(await page.$$eval('li.card[data-id]', l => l.map(x => x.dataset.id + ':' + x.dataset.view))) + ' view=' + await page.evaluate(() => document.title) + ' mock=' + JSON.stringify(hub.index().clips.map(c => c.id + ':' + !!c.trashed_at))); await shot(page, 'debug-fail'); throw e; }); await page.click(`li.card[data-id=${id}] .card-link`); await page.click('#btn-trash'); await page.click('#confirm-ok'); await until(() => hub.commits.length > n0 && hub.commits.at(-1).ok, 8000, 'trash ' + id); await sleep(300); }
      await page.click('#admin-btn'); await until(async () => /Admin$/.test((await page.textContent('#admin-btn')).trim()), 5000, 'exit admin');
      await page.click('#admin-btn'); await page.fill('#admin-token', WRITE); await page.click('#admin-go'); await until(async () => /Exit admin/.test(await page.textContent('#admin-btn')), 8000, 'admin re-entered');
      await page.click('a.tab[data-view=trash]'); await page.waitForSelector('button:has-text("Empty trash")'); await page.click('button:has-text("Empty trash")');
      await page.waitForSelector('input.typed'); await page.fill('input.typed', 'EMPTY TRASH'); n0 = hub.commits.length; await page.click('#confirm-ok');
      await page.waitForSelector('dialog.reauth[open] #pp-input', { timeout: 8000 });
      ok(hub.commits.length === n0, 'empty trash: re-entering admin mode requires the passphrase again before the commit');
      await page.fill('dialog.reauth[open] #pp-input', PASS); await page.click('dialog.reauth[open] button[type=submit]');
      await until(() => hub.commits.length > n0 && hub.commits.at(-1).ok, 10000, 'empty commit');
      c = hub.commits.at(-1);
      ok(c.message.startsWith('Purge 2 clip') && c.ops.filter(o => o.key === 'deletedFile').length === 4 && hub.index().clips.length === 0, 'empty trash: all trash files deleted and the index emptied in one commit');
      ok(hub.auditLines().filter(a => a.action === 'empty_trash').length === 2, 'empty trash: one audit line per clip');
      { const tj = JSON.parse(hub.text('_config/tombstones.json')); ok(tj.ids.map(x => x.id).join() === 'old1,a1,b2,c3', 'empty trash: tombstones for every purged clip in the same commit (' + tj.ids.map(x => x.id).join() + ')'); }
      // put clips back for the next steps
      for (const id of ['a1', 'b2', 'c3']) { hub.put(`clips/${id}.mp4`, fs.readFileSync(VID[id]), true); hub.put(`clips/${id}.jpg`, fs.readFileSync(JPG)); }
      const idx2 = { version: 2, clips: ['a1', 'b2', 'c3'].map(id => ({ id, stream: 's', title: 'T ' + id, hook: '', desc: '', video: `clips/${id}.mp4`, poster: `clips/${id}.jpg`, size: 1, dur: 2 })) }; hub.put('index.json', JSON.stringify(idx2)); hub.bump();
      await sleep(2400); await page.evaluate(() => { location.hash = '#/'; }); await page.evaluate(() => import('/js/state.js').then(s => s.emit('reload'))); await until(async () => (await cardCount(page)) === 3, 8000, 'reload 3');

      // ---- upload (single LFS PUT)
      await clean(page); await page.click('#upload-btn'); await page.waitForSelector('#up-video', { state: 'attached' });
      await page.setInputFiles('#up-video', VID.up1); await page.setInputFiles('#up-poster', JPG); await page.fill('#up-title', 'Brand new clip'); await page.fill('#up-tags', 'x, y');
      await shot(page, '09-upload-form'); n0 = hub.commits.length;
      await page.click('#up-go');
      await until(() => hub.commits.length > n0 && hub.commits.at(-1).ok, 15000, 'upload commit');
      c = hub.commits.at(-1); const up1sha = sha(fs.readFileSync(VID.up1));
      ok(hub.preuploads.length === 1 && hub.preuploads.at(-1).some(f => f.path.endsWith('.mp4') && f.size === fs.statSync(VID.up1).size && f.sample) , 'upload: preupload asked about each file (path, size, sample)');
      ok(hub.lfsBatches.at(-1).objects[0].oid === up1sha && hub.lfsBatches.at(-1).hash_algo === 'sha256', 'upload: LFS batch with the SHA-256 computed in the browser');
      ok(hub.puts.some(p => p.oid === up1sha && p.size === fs.statSync(VID.up1).size) && hub.verifies.some(v => v.oid === up1sha), 'upload: file PUT to the LFS target and verified');
      const ck = c.ops.map(o => o.key + ':' + o.value.path);
      ok(ck.some(k => /^lfsFile:clips\/brand-new-clip-\d{8}-\d{6}\.mp4$/.test(k)) && ck.some(k => /^file:clips\/brand-new-clip-.*\.jpg$/.test(k)) && ck.includes('file:index.json'), 'upload: commit = lfsFile mp4 + regular poster + index.json + audit: ' + ck.join(' '));
      idx = hub.index(); const nw = idx.clips[0];
      ok(nw.title === 'Brand new clip' && nw.sha256 === up1sha && nw.dur > 1 && nw.width === 64 && nw.height === 112 && nw.size === fs.statSync(VID.up1).size && nw.poster && JSON.stringify(nw.tags) === '["x","y"]', 'upload: index entry has sha256, size, duration/width/height read from the <video> element ' + JSON.stringify({ d: nw.dur, w: nw.width, h: nw.height }));
      ok(hub.auditLines().at(-1).action === 'upload' && hub.auditLines().at(-1).detail.sha256 === up1sha, 'upload: audit line');
      ok(hub.violations.length === 0, 'upload: the LFS PUT carried no Authorization header');
      await until(async () => (await cardCount(page)) === 4, 6000, 'card 4'); await sleep(500); await shot(page, '10-after-upload');
      // duplicate (index sha256)
      await page.evaluate(() => { location.hash = '#/'; }); await clean(page); await page.click('#upload-btn'); await page.setInputFiles('#up-video', VID.up1); await page.fill('#up-title', 'Same again'); n0 = hub.commits.length; await page.click('#up-go');
      await until(async () => /already in the vault/.test(await page.textContent('#up-err')), 8000, 'duplicate'); ok(/already in the vault/.test(await page.textContent('#up-err')) && hub.commits.length === n0, 'duplicate upload (known sha256) is refused with no commit');
      ok(await page.isVisible('text=Open the existing clip'), 'duplicate: offers to open the existing clip');
      await page.click('#up-cancel');
      // duplicate of a v1 clip with no sha256 (matched by the Hub LFS oid)
      await sleep(300); await clean(page); await page.click('#upload-btn'); await page.setInputFiles('#up-video', VID.a1); await page.fill('#up-title', 'Old one'); n0 = hub.commits.length; await page.click('#up-go');
      await until(async () => /already in the vault/.test(await page.textContent('#up-err')), 8000, 'duplicate v1');
      ok(/already in the vault/.test(await page.textContent('#up-err')) && hub.commits.length === n0, 'duplicate of an older clip (no sha256 in index) found through paths-info LFS oid');
      await page.click('#up-cancel');
      // magic bytes
      await sleep(300); await clean(page); await page.click('#upload-btn'); await page.setInputFiles('#up-video', JUNK); await page.fill('#up-title', 'Junk'); n0 = hub.commits.length; await page.click('#up-go');
      await until(async () => (await page.textContent('#up-err')).length > 0, 6000, 'junk');
      ok((await page.textContent('#up-err')).length > 0 && hub.commits.length === n0 && hub.lfsBatches.length === 1, 'a file that is not an mp4 (magic bytes) is refused before any upload');
      await page.click('#up-cancel');
      // multipart
      hub.multipart = true; hub.chunk = 500; await page.evaluate(() => { location.hash = '#/'; }); await sleep(300); await clean(page); await page.click('#upload-btn'); await page.setInputFiles('#up-video', VID.up2); await page.fill('#up-title', 'Multi part clip'); n0 = hub.commits.length; await page.click('#up-go');
      await until(() => hub.commits.length > n0 && hub.commits.at(-1).ok, 15000, 'multipart commit'); const up2 = sha(fs.readFileSync(VID.up2));
      const parts = hub.puts.filter(p => p.oid === up2 && p.part);
      ok(parts.length >= 2 && hub.completions.at(-1).oid === up2 && hub.completions.at(-1).parts.length === parts.length && hub.completions.at(-1).parts[0].etag === '"etag-1"', 'multipart LFS: parts PUT in order, ETags collected, completion posted (' + parts.length + ' parts)');
      ok(hub.commits.at(-1).ops.some(o => o.key === 'lfsFile' && o.value.oid === up2), 'multipart: commit references the object');
      hub.multipart = false;
      // blocked host (S3) is refused clearly with no commit
      hub.badHost = true; await page.evaluate(() => { location.hash = '#/'; }); await sleep(500); await clean(page); await page.click('#upload-btn'); await page.setInputFiles('#up-video', VID.up3); await page.fill('#up-title', 'Blocked'); n0 = hub.commits.length; await page.click('#up-go');
      await until(async () => /amazonaws/.test(await page.textContent('#up-err')), 8000, 'blocked host');
      ok(/bucket\.s3\.amazonaws\.com/.test(await page.textContent('#up-err')) && hub.commits.length === n0, 'an upload target outside huggingface.co / *.hf.co is refused with a clear message naming the host');
      hub.badHost = false; await page.click('#up-cancel');

      // ---- concurrency conflict
      await page.evaluate(() => { location.hash = '#/'; }); await sleep(300);
      const id0 = hub.index().clips.at(-1).id; hub.injectConflict = 1; n0 = hub.commits.length;
      await page.click(`li.card[data-id="${hub.index().clips[0].id}"] .card-link`); await page.click('#btn-edit'); await page.fill('#ef-title', 'Edited under conflict'); await page.click('#ef-save');
      await until(() => hub.commits.length >= n0 + 2 && hub.commits.at(-1).ok, 10000, 'retry commit');
      const [first, second] = hub.commits.slice(n0);
      ok(!first.ok && first.parent !== second.parent && second.ok && first.parent === first.headBefore && second.parent === hub.lastForeignHead && second.parent !== first.parent, 'conflict: first commit rejected (412), the retry used the NEW head as parentCommit');
      idx = hub.index(); ok(idx.clips.find(x => x.title === 'Edited under conflict') && idx.clips.at(-1).hook === 'foreign edit', 'conflict: retry rebuilt from the fresh index, so the other writer\'s change survived');
      await page.keyboard.press('Escape');
      // ---- audit view
      await page.click('a.tab[data-view=audit]'); await page.waitForSelector('table.audit tbody tr');
      const rows = await page.$$eval('table.audit tbody tr', r => r.map(x => x.innerText));
      ok(rows.length >= 8 && rows.every(r => /admin/.test(r)) && rows.some(r => /upload/.test(r)) && rows.some(r => /delete_forever/.test(r)) && rows.some(r => /empty_trash/.test(r)), 'audit view lists the entries (newest first, actor "admin"): ' + rows.length + ' rows');
      await shot(page, '11-audit');
      // ---- admin token revoked mid-session
      hub.rejectCommitToken = true; await page.evaluate(() => { location.hash = '#/'; }); await sleep(300);
      await page.click(`li.card[data-id="${hub.index().clips[0].id}"] .card-link`); await page.click('#btn-edit'); await page.fill('#ef-title', 'Will fail'); await page.click('#ef-save');
      await until(async () => /Admin$/.test((await page.textContent('#admin-btn')).trim()), 8000, 'drops to viewer');
      ok(/Admin$/.test((await page.textContent('#admin-btn')).trim()) && await page.$('#upload-btn:not([hidden])') === null, 'a rejected admin token drops back to viewer mode');
      ok(hub.violations.length === 0, 'no Authorization header ever reached a CDN/upload host');
      ok(!hub.requests.some(r => r.auth === WRITE && r.host !== 'huggingface.co'), 'the write token was only ever sent to huggingface.co');
      ok(!hub.requests.some(r => r.url.includes('hf_' + 'FAKE')), 'no token in any URL');
      ok(viol.length === 0 && (await page.evaluate(() => window.__v)).length === 0, 'zero CSP violations / page errors in the admin session ' + JSON.stringify(viol));
      ok(!logs.join('\n').includes(WRITE) && !logs.join('\n').includes(READ), 'tokens never logged');
      await ctx.close();
    }

    // ============================ REMEMBER ON THIS DEVICE
    {
      const stor = p => p.evaluate(() => ({ keys: Object.keys(localStorage).filter(k => k !== 'cv.feed'), v: localStorage.getItem('cv.pass'), ss: sessionStorage.length }));
      // remember ON (default): stored after a successful unlock only
      let hub = newHub(); let S = await session(hub); let page = S.page;
      await page.goto(base + '/'); await page.waitForSelector('#signin:not([hidden]) #remember-cb');
      ok(await page.isChecked('#remember-cb') && /Remember on this device/.test(await page.textContent('#signin')), 'remember: checkbox is on the unlock screen, checked by default');
      ok(await page.getAttribute('#pp-input', 'autocomplete') === 'current-password', 'unlock input has autocomplete=current-password');
      await unlock(page, 'wrong wrong wrong wrong'); await until(async () => /did not work/.test(await page.textContent('#signin-status')), 15000, 'wrong');
      ok((await stor(page)).v === null, 'remember: a WRONG passphrase is never stored');
      await sleep(1200); await page.waitForSelector('#signin #pp-input:visible'); ok(await page.isChecked('#remember-cb'), 'remember: the checkbox state survives the failed attempt');
      await page.fill('#signin #pp-input', PASS); await page.click('#signin button[type=submit]'); await page.waitForSelector('li.card .card-link', { timeout: 15000 });
      let st = await stor(page); ok(st.keys.length === 1 && st.keys[0] === 'cv.pass' && st.v === PASS && st.ss === 0, 'remember on: only key cv.pass holds the passphrase');
      ok(!JSON.stringify(st).includes(READ), 'remember on: the read token is not stored');
      // reload: silent unlock, no typing
      await page.reload(); await page.waitForSelector('li.card .card-link', { timeout: 15000 });
      ok(await cardCount(page) === 3 && (await page.evaluate(() => !document.querySelector('#signin') || document.querySelector('#signin').hidden)), 'reload: unlocked automatically from the stored passphrase');
      ok((await page.evaluate(() => [...document.querySelectorAll('input,textarea')].filter(i => i.value.includes('copper')).length)) === 0 && (await stor(page)).v === PASS, 'reload: no passphrase left in an input; still remembered');
      // admin: write token never stored
      await page.click('#admin-btn'); await page.fill('#admin-token', WRITE); await page.click('#admin-go');
      await until(async () => /Exit admin/.test(await page.textContent('#admin-btn')), 8000, 'admin on');
      st = await stor(page); const all = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage)) + document.cookie);
      ok(/Exit admin/.test(await page.textContent('#admin-btn')) && !all.includes(WRITE) && st.keys.length === 1 && st.keys[0] === 'cv.pass', 'admin mode: the write token is never in any storage');
      await page.reload(); await page.waitForSelector('li.card .card-link', { timeout: 15000 });
      ok(/Admin$/.test((await page.textContent('#admin-btn')).trim()) && await page.$('#upload-btn:not([hidden])') === null, 'reload: auto-unlock gives viewer mode; the admin token is gone');
      // Lock forgets
      await page.click('#signout-btn'); await page.waitForSelector('#signin:not([hidden]) #pp-input', { timeout: 8000 }); await sleep(600);
      ok((await stor(page)).v === null && await cardCount(page) === 0, 'Lock clears the stored passphrase and shows the unlock screen (no auto-unlock)');
      ok(S.viol.length === 0, 'remember: no page errors / CSP violations ' + JSON.stringify(S.viol));
      await S.ctx.close();
      // remember OFF: nothing stored, reload asks again
      hub = newHub(); S = await session(hub); page = S.page;
      await page.goto(base + '/'); await page.waitForSelector('#signin:not([hidden]) #remember-cb'); await page.uncheck('#remember-cb');
      await unlock(page); await page.waitForSelector('li.card .card-link', { timeout: 15000 });
      st = await stor(page); ok(st.keys.length === 0 && st.ss === 0, 'remember off: nothing stored in localStorage');
      await page.reload(); await page.waitForSelector('#signin:not([hidden]) #pp-input', { timeout: 8000 }); await sleep(500);
      ok(await page.isVisible('#signin') && await cardCount(page) === 0, 'remember off: after reload the unlock screen asks again');
      await S.ctx.close();
      // wrong stored passphrase (rotated): cleared, normal screen with the generic message
      hub = newHub(); S = await session(hub); page = S.page;
      await page.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('cv.pass', 'old rotated passphrase here'); sessionStorage.setItem('seeded', '1'); } } catch { /* ignore */ } });
      await page.goto(base + '/'); await until(async () => /did not work/.test(await page.textContent('#signin-status')), 15000, 'stale msg');
      ok(await page.textContent('#signin-status') === 'That passphrase did not work' && (await stor(page)).v === null && await page.isVisible('#pp-input'), 'stale stored passphrase: generic message, entry cleared, unlock screen shown');
      ok(hub.requests.length === 0, 'stale stored passphrase: no Hub request');
      await sleep(1300); await page.fill('#signin #pp-input', PASS); await page.click('#signin button[type=submit]'); await page.waitForSelector('li.card .card-link', { timeout: 15000 });
      ok((await stor(page)).v === PASS, 'after a stale entry, typing the right passphrase remembers it again');
      await S.ctx.close();
      // storage blocked: page still works
      hub = newHub(); S = await session(hub); page = S.page;
      await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); });
      await page.goto(base + '/'); await toLibrary(page, true);
      ok(await cardCount(page) === 3, 'storage blocked: unlock still works without storage');
      await S.ctx.close();
      // idle with a remembered passphrase: no Lock, admin token dropped
      hub = newHub(); S = await session(hub); page = S.page;
      await page.addInitScript(() => { globalThis.__clipVaultIdleMs = 2500; });
      await page.goto(base + '/'); await toLibrary(page, true);
      await page.click('#admin-btn'); await page.fill('#admin-token', WRITE); await page.click('#admin-go');
      await until(async () => /Exit admin/.test(await page.textContent('#admin-btn')), 8000, 'admin on idle');
      await until(async () => /Admin$/.test((await page.textContent('#admin-btn')).trim()), 9000, 'admin dropped by idle');
      ok(/Admin$/.test((await page.textContent('#admin-btn')).trim()) && await page.isVisible('li.card .card-link') && (await stor(page)).v === PASS, 'idle with remembered passphrase: library stays unlocked, admin token dropped, passphrase kept');
      await S.ctx.close();
    }
    // ============================ source greps
    {
      const dist = fs.readdirSync(path.join(DIST, 'js')).map(f => [f, fs.readFileSync(path.join(DIST, 'js', f), 'utf8')]);
      const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w'"`])\/\/.*$/gm, '$1');
      const rm = s => s.replace(/localStorage\.(getItem\(PASS_KEY\)|setItem\(PASS_KEY, v\)|removeItem\(PASS_KEY\))/g, '');
      const rmPm = s => s.replace(/localStorage\.(getItem\((PM_KEY|FEED_KEY)\)|setItem\((PM_KEY|FEED_KEY), on \? '1' : '0'\))/g, '');   // D47: the Post info switch, viewpref.js only
      const bad = /localStorage|sessionStorage|indexedDB|document\.cookie|\beval\s*\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write|serviceWorker|setAttribute\(\s*['"]style['"]|cssText/;
      ok(dist.every(([f, s]) => !bad.test(strip(f === 'hubchrome.js' ? rm(s) : f === 'viewpref.js' ? rmPm(s) : s))), 'forbidden DOM/storage APIs: none in any dist js file except the three cv.pass calls in hubchrome.js and the two cv.postmode calls in viewpref.js (' + dist.length + ' files)');
      const mine = ['hubapi.js', 'framebust.js'].map(f => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')).join('\n');
      const chrome = rm(fs.readFileSync(path.join(ROOT, 'src', 'hubchrome.js'), 'utf8'));
      ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|document\.write|serviceWorker/.test(chrome.replace(/\/\/.*$/gm, '')) && (fs.readFileSync(path.join(ROOT, 'src', 'hubchrome.js'), 'utf8').match(/localStorage/g) || []).length === 3, 'hubchrome.js: localStorage appears exactly 3 times (get/set/remove of PASS_KEY), no other storage API');
      ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|\beval\s*\(|innerHTML|document\.write|serviceWorker/.test(mine), 'forbidden APIs: none in the new modules (raw source, comments included)');
      ok(!/<script(?![^>]*src=)/.test(fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')), 'no inline script in index.html');
      ok(!/hf_[A-Za-z0-9]{12,}/.test(dist.map(d => d[1]).join('') + fs.readFileSync(path.join(DIST, 'config.json'), 'utf8')), 'no token-looking string in dist');
    }
  } catch (e) { fail++; console.log('FAIL exception: ' + (e.stack || e)); }
  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
