// Run: NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node site/hfspace/tests/test_ui.js
// Needs ffmpeg and the python deps of requirements.txt. Fake secrets only; the real app runs with two functions faked.
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');

const READ_TOKEN = 'hf_' + 'FAKE_read_token_0000', CLIENT_SECRET = 'FAKE_client_secret_0000', SESSION_SECRET = 'u'.repeat(48);
const SHOTS = '/tmp/claude-0/hfspace-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfspace-ui-'));
const MP4 = path.join(tmp, 'c.mp4'), JPG = path.join(tmp, 'p.jpg'), IDX = path.join(tmp, 'index.json');
// VP9-in-mp4 (the preinstalled Chromium has no H.264); 2 s so a Range request is meaningful
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x112:d=2:r=10', '-c:v', 'libvpx-vp9', '-b:v', '50k', '-movflags', '+faststart', MP4]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x112:d=1', '-frames:v', '1', JPG]);
const mk = (id, stream, title, dur) => ({ id, stream, title, hook: 'h', desc: 'd', dur, score: 9, video: `clips/${id}.mp4`, poster: `clips/${id}.jpg`, size: fs.statSync(MP4).size, post: 'Post text ' + id });
fs.writeFileSync(IDX, JSON.stringify({ clips: [mk('a1', '2026-01-01_alpha-stream', 'Clip A', 45), mk('b2', '2026-01-01_alpha-stream', 'Clip B', 50), mk('c3', '2026-02-02_beta-stream', 'Clip C', 41)] }));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function waitUp(port) { for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/me`); if (r.status === 401) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error('server did not start'); }

(async () => {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, VAULT_READ_TOKEN: READ_TOKEN, OAUTH_CLIENT_SECRET: CLIENT_SECRET, OAUTH_CLIENT_ID: 'fake-id',
    SESSION_SECRET, SPACE_HOST: `127.0.0.1:${port}`, OPENID_PROVIDER_URL: base, ALLOWED_HF_USERS: 'soverellp' };
  const srv = spawn('python3', [path.join(__dirname, 'ui_launcher.py'), String(port), MP4, JPG, IDX], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  const browser = await chromium.launch();
  const who = n => fetch(`${base}/__who/${n}`);
  async function fresh() {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage(), viol = [], reqs = [];
    await page.addInitScript(() => { window.__v = []; document.addEventListener('securitypolicyviolation', e => window.__v.push(e.violatedDirective + ' ' + e.blockedURI)); });
    page.on('console', m => { if (/content security policy|refused to/i.test(m.text())) viol.push('console: ' + m.text()); });
    page.on('pageerror', e => viol.push('pageerror: ' + e.message));
    page.on('request', r => reqs.push({ url: new URL(r.url()), range: r.headers()['range'] || '' }));
    return { ctx, page, viol, reqs };
  }
  try {
    await waitUp(port);

    // --- signed out
    let { ctx, page, viol, reqs } = await fresh();
    await page.goto(base + '/');
    await page.waitForSelector('#signin:visible');
    ok((await page.textContent('#signin')) === 'Sign in with Hugging Face' && (await page.getAttribute('#signin', 'href')) === '/login', 'signed-out page shows the sign-in link to /login');
    ok(await page.isHidden('#app'), 'no gallery when signed out');
    const apiReqs = reqs.filter(r => r.url.pathname.startsWith('/api/')).map(r => r.url.pathname);
    ok(JSON.stringify(apiReqs) === '["/api/me"]', 'signed-out page requests only /api/me (' + apiReqs + ')');
    ok(reqs.every(r => r.url.origin === base), 'no cross-origin request when signed out');
    await page.screenshot({ path: `${SHOTS}/1-signed-out.png` });

    // --- sign in (fake HF authorize bounces straight back)
    await page.click('#signin');
    await page.waitForSelector('.c');
    ok((await page.$$('.c')).length === 3, 'after login: 3 cards');
    ok((await page.$$('#flt button')).length === 3, 'stream filter chips: All + 2 streams');
    await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
    ok(true, 'lazy posters loaded through /api/files');
    ok(reqs.filter(r => r.url.pathname.endsWith('.mp4')).length === 0, 'no .mp4 request before a tap');
    ok(await page.evaluate(() => [...document.images].every(i => i.loading === 'lazy' && i.getAttribute('src').startsWith('/api/files/clips/'))), 'posters are loading=lazy same-origin');
    await page.screenshot({ path: `${SHOTS}/2-gallery.png` });
    await page.click('#flt button:nth-child(3)');
    ok((await page.$$('.c')).length === 1, 'filter chip narrows to 1 card');
    await page.click('#flt button:nth-child(1)');

    // --- tap a card: progressive playback via Range
    await page.click('.c >> nth=0');
    await page.waitForSelector('#dlg[open]');
    await page.waitForFunction(() => document.getElementById('v').readyState >= 3, null, { timeout: 15000 });
    const mp4r = reqs.filter(r => r.url.pathname === '/api/files/clips/a1.mp4');
    ok(mp4r.length > 0 && mp4r.some(r => r.range.startsWith('bytes=')), 'tap requests the mp4 with a Range header');
    ok(await page.evaluate(() => { const v = document.getElementById('v'); return v.readyState >= 3 && v.videoWidth > 0; }), 'video can play (readyState>=3)');
    ok((await page.getAttribute('#dl', 'href')) === '/api/files/clips/a1.mp4' && (await page.getAttribute('#dl', 'download')) !== null, 'Download link is same-origin with download attribute');
    ok(await page.isVisible('#cp'), 'Copy post text button shown');
    await page.click('#sz');
    const safe = await page.evaluate(() => { const s = document.getElementById('safe'), v = document.getElementById('v'); const a = s.getBoundingClientRect(), b = v.getBoundingClientRect(); return { hidden: s.hidden, sameBox: Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2 }; });
    ok(!safe.hidden && safe.sameBox, 'safe-zone overlay toggles on over the video frame');
    await page.screenshot({ path: `${SHOTS}/3-player-safezone.png` });
    await page.click('#x');

    // --- storage and cookies
    ok(!(await page.evaluate(() => document.cookie)).includes('cv_'), 'document.cookie shows no session cookie (HttpOnly)');
    const st = await page.evaluate(async () => ({ l: localStorage.length, s: sessionStorage.length, db: (await indexedDB.databases()).length }));
    ok(st.l === 0 && st.s === 0 && st.db === 0, 'localStorage, sessionStorage, IndexedDB empty');
    const ck = (await ctx.cookies()).find(c => c.name === '__Host-cv_session');
    ok(ck && ck.httpOnly && ck.secure && ck.sameSite === 'Lax' && ck.path === '/' && !ck.domain.startsWith('.'), 'session cookie is __Host-, HttpOnly + Secure + SameSite=Lax + Path=/');
    const g = await fetch(`${base}/logout`, { redirect: 'manual' });
    ok(g.status === 405, 'GET /logout is 405');
    ok(await page.isVisible('form[action="/logout"][method="post"] #out'), 'Sign out is a POST form');
    const me = await page.evaluate(async () => (await fetch('/api/me')).json());
    ok(me.user === 'Soverellp' && me.sub === 'fake-sub-soverellp', '/api/me returns user and sub');
    const html = await page.content();
    ok(![READ_TOKEN, CLIENT_SECRET, SESSION_SECRET].some(s => html.includes(s)) && reqs.every(r => !r.url.href.includes(READ_TOKEN)), 'no secret in the DOM or any URL');
    const cspv = await page.evaluate(() => window.__v);
    ok(cspv.length === 0 && viol.length === 0, 'zero CSP violations / page errors (' + viol.concat(cspv) + ')');
    ok(reqs.every(r => r.url.origin === base), 'every request stayed on the app origin');

    // --- sign out
    await page.click('#out');
    await page.waitForSelector('#signin:visible');
    ok(await page.isHidden('#app'), 'sign out returns to the sign-in link');
    ok(!(await ctx.cookies()).some(c => c.name === '__Host-cv_session'), 'session cookie cleared');
    await ctx.close();

    // --- not-listed user
    await who('Stranger');
    ({ ctx, page, viol, reqs } = await fresh());
    await page.goto(base + '/login');
    await page.waitForLoadState('load');
    const body = await page.textContent('body');
    ok(body.includes('This Hugging Face account is not on the list') && !body.includes('Stranger'), 'not-listed user sees the generic message (no name echoed)');
    ok(await page.isVisible('form[action="/logout"][method="post"] button'), 'denial page offers a POST Sign out button');
    ok(!(await ctx.cookies()).some(c => c.name === '__Host-cv_session'), 'no session cookie for a not-listed user');
    await page.screenshot({ path: `${SHOTS}/4-denied.png` });
    ok(viol.length === 0, 'no CSP violations on the denial page');
    await ctx.close();
    await who('Soverellp');
  } catch (e) { fail++; console.log('FAIL exception: ' + e.stack); }
  await browser.close();
  srv.kill();
  console.log(`\n${pass} passed, ${fail} failed; screenshots in ${SHOTS}`);
  process.exit(fail ? 1 : 0);
})();
