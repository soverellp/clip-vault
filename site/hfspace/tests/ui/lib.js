// Shared harness: fixtures, browser, fake Google, helpers.
const { chromium } = require('playwright');
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { createMock, ANCHOR } = require('./mock_server');

const STATIC = process.env.STATIC_DIR || path.resolve(__dirname, '../../static');
const SHOTS = process.env.SHOTS || '/tmp/claude-0/hfspace-shots/v3';
const FX = path.join(os.tmpdir(), 'cv-fixtures');
const BASE_URL = process.env.BASE_URL || '';
// With BASE_URL the suite talks to a real backend; fake credentials come from env (see README.md).
const CRED = { admin: process.env.UI_CRED_ADMIN || 'FAKE-admin', viewer: process.env.UI_CRED_VIEWER || 'FAKE-viewer', readonly: process.env.UI_CRED_READONLY || 'FAKE-readonly', admin2: 'FAKE-admin2', stranger: 'FAKE-stranger' };

function fixtures() {
  fs.mkdirSync(FX, { recursive: true });
  if (!fs.existsSync(path.join(FX, 'v.mp4'))) {
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', '-movflags', '+faststart', path.join(FX, 'v.mp4')]);
    if (r.status) throw new Error('ffmpeg failed');
    const cols = ['0xd0206a', '0x2a6fdb', '0x18a058', '0xe0a020'];
    cols.forEach((c, i) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=540x960`, '-frames:v', '1', '-q:v', '5', path.join(FX, `p${i}.jpg`)]));
  }
  return { mp4: fs.readFileSync(path.join(FX, 'v.mp4')), jpgs: [0, 1, 2, 3].map((i) => fs.readFileSync(path.join(FX, `p${i}.jpg`))) };
}

const FAKE_GSI = `(function(){var cfg=null;window.google={accounts:{id:{
initialize:function(c){cfg=c;window.__gsiInit=(window.__gsiInit||0)+1;window.__gsiNonce=c.nonce;},
renderButton:function(el){var b=document.createElement('button');b.type='button';b.className='fake-google';b.textContent='Sign in with Google (fake)';
b.addEventListener('click',function(){cfg.callback({credential:window.__cred||'FAKE-admin'});});el.appendChild(b);},
disableAutoSelect:function(){window.__gsiDisabled=(window.__gsiDisabled||0)+1;},prompt:function(){}}}};})();`;

async function startBackend() {
  const fx = fixtures();
  if (BASE_URL) return { url: BASE_URL, ctl: async (a) => { if (a === 'reset') await fetch(BASE_URL + '/__reset').catch(() => {}); return {}; }, close: async () => {}, real: true };
  const m = await createMock({ staticDir: STATIC, ...fx });
  const ctl = async (action, extra = {}) => (await fetch(m.url + '/__ctl', { method: 'POST', body: JSON.stringify({ action, ...extra }) })).json();
  return { url: m.url, ctl, close: () => new Promise((r) => m.server.close(r)), real: false, S: m.S };
}

async function launch() {
  return chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}

// Context + page with CSP/violation recording, fake Google, a pinned clock and (optional) device overrides.
async function newPage(browser, base, o = {}) {
  const ctx = await browser.newContext({ viewport: o.viewport || { width: 1280, height: 800 }, timezoneId: o.tz || 'Asia/Kolkata', locale: o.locale || 'en-IN', reducedMotion: o.reduced ? 'reduce' : 'no-preference', colorScheme: o.scheme || 'dark', acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'], hasTouch: !!o.touch, isMobile: !!o.mobile, deviceScaleFactor: o.dpr || 1 });
  const page = await ctx.newPage();
  page.cv = { csp: [], console: [], errors: [] };
  await page.addInitScript(({ cores }) => {
    window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    window.__cred = 'FAKE-admin';
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => cores });
    if (cores >= 8) Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  }, { cores: o.cores || 8 });
  await page.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_GSI }));
  page.on('console', (m) => { const t = m.text(); page.cv.console.push(t); if (/Content Security Policy|Refused to/i.test(t)) page.cv.csp.push(t); });
  page.on('pageerror', (e) => page.cv.errors.push(String(e)));
  if (o.clock !== false) await page.clock.setFixedTime(ANCHOR);
  page.base = base;
  return page;
}
async function login(page, who = 'admin') {
  const cred = CRED[who] || who;
  await page.waitForSelector('#gbtn .fake-google');
  await page.evaluate((c) => { window.__cred = c; }, cred);
  await page.click('#gbtn .fake-google');
  await page.waitForSelector('#shell:not([hidden])');
  await page.waitForSelector('.grid:not(.skel):not([hidden]) .card, .folder-grid:not([hidden]) .folder, .empty:not([hidden])');
}
async function visit(page, who = 'admin') { await page.goto(page.base + '/'); await login(page, who); }
// Sort, view, grouping, queue, stream/tag filters and Select now live behind the one Filter button; open it (idempotent) before using them.
async function openFilter(page) { if ((await page.getAttribute('#filter-btn', 'aria-expanded')) !== 'true') await page.click('#filter-btn'); await page.waitForSelector('#filter-panel:not([hidden])'); }
async function closeFilter(page) { if ((await page.getAttribute('#filter-btn', 'aria-expanded')) === 'true') await page.click('#filter-btn'); }
async function csp(page) { return [...page.cv.csp, ...(await page.evaluate(() => window.__csp).catch(() => []))]; }

let pass = 0, fail = 0; const fails = [];
function ok(c, msg) { if (c) { pass++; console.log('  PASS ' + msg); } else { fail++; fails.push(msg); console.log('  FAIL ' + msg); } }
const counts = () => ({ pass, fail, fails });
module.exports = { launch, newPage, login, visit, csp, openFilter, closeFilter, startBackend, ok, counts, STATIC, SHOTS, CRED, ANCHOR, BASE_URL };
