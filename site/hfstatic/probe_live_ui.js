// Live-site UI probe. Reads VAULT_PASSPHRASE from env, prints only ok/FAIL, console errors and screenshot paths. Never prints secrets.
// Run: python3 site/hfvault/with_bw_creds.py -- python3 site/hfstatic/probe_live_ui.py [diag|layout|playlist|load]
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const URL_ = process.env.LIVE_URL || 'https://soverellp-clip-vault-site.static.hf.space/';
const MODE = process.argv[2] || 'diag', PASS = process.env.VAULT_PASSPHRASE;
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'probe_live'); fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s).replace(/hf_[A-Za-z0-9]+/g, 'hf_***').split(PASS || '\u0000').join('***').slice(0, 300);
let bad = 0; const say = (c, m) => { if (!c) bad++; console.log((c ? 'ok ' : 'FAIL ') + m); };
(async () => {
  if (!PASS) { console.log('FAIL no VAULT_PASSPHRASE in env'); process.exit(1); }
  const browser = await chromium.launch();
  const errs = [];
  async function open(width, height) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('pageerror ' + clean(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console ' + clean(m.text())); });
    await page.goto(URL_);
    await page.waitForSelector('#signin:not([hidden]) #pp-input', { timeout: 20000 });
    await page.uncheck('#remember-cb').catch(() => {});
    await page.fill('#pp-input', PASS); await page.click('#signin button[type=submit]');
    await page.waitForSelector('.folder', { timeout: 40000 });
    return { ctx, page };
  }
  const toasts = page => page.$$eval('.toast', e => e.map(x => clean(x.textContent)));
  try {
    if (MODE === 'load') {
      const { page } = await open(1280, 800); say(true, 'unlocked, folders=' + (await page.$$('.folder')).length);
      await page.click('.pl-nav-top'); await page.waitForSelector('[class*="pl-"]', { timeout: 8000 }); say(true, 'Playlists button works');
    } else {
      const { page } = await open(390, 844);
      await page.screenshot({ path: path.join(OUT, 'folders.png') });
      await page.$eval('.folder a', e => e.click()); await page.waitForSelector('ul.grid.moments li.card', { timeout: 20000 });
      await sleep(500);
      const caps = await page.evaluate(async () => { try { const m = await import('/js/state.js'); return JSON.stringify(m.state.me?.capabilities); } catch (e) { return 'noimport ' + e.message; } });
      console.log('caps', caps);
      await page.screenshot({ path: path.join(OUT, 'list.png') });
      if (MODE === 'layout') {
        const info = await page.evaluate(() => { const c = document.querySelector('ul.grid.moments li.card'); const tree = (e, d) => d > 4 ? [] : [...e.children].map(k => { const r = k.getBoundingClientRect(); return { c: (k.tagName + '.' + k.className).slice(0, 40), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), pos: getComputedStyle(k).position, kids: tree(k, d + 1) }; }); c.scrollIntoView(); return JSON.stringify({ grid: document.querySelector('ul.grid.moments').dataset.mode, tree: tree(c, 0) }); });
        console.log(info);
        await page.evaluate(() => document.querySelector('ul.grid.moments li.card').scrollIntoView()); await sleep(600);
        await page.screenshot({ path: path.join(OUT, 'cards.png') });
      }
      if (MODE === 'diag') {
        await page.click('li.card .pi-add').catch(e => console.log('no .pi-add', e.message.slice(0, 80)));
        await sleep(800); console.log('toasts', JSON.stringify(await toasts(page)));
        console.log('modal', clean(await page.evaluate(() => document.querySelector('dialog[open]')?.textContent || '').catch(() => '')));
      }
    }
  } catch (e) { say(false, 'probe crashed: ' + clean(e.message)); }
  console.log('console/page errors:', errs.length); for (const e of errs.slice(0, 8)) console.log('  ' + e);
  console.log('screens in', OUT);
  await browser.close(); process.exit(bad ? 1 : 0);
})();
