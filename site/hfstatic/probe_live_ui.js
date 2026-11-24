// Live-site UI probe (Playwright). Reads VAULT_PASSPHRASE from env, prints only ok/FAIL, console errors and screenshot paths. Never prints secrets.
// Run: python3 site/hfvault/with_bw_creds.py -- python3 site/hfstatic/probe_live_ui.py [load|qa|roundtrip|diag]
//   LIVE_URL=http://localhost:8081/ points it at a local copy of dist; PROBE_OUT=dir for the screenshots; QA_PREFIX=qa_ for the file names.
//   load      unlock, folders render, Playlists button works
//   qa        phone 390 + PC 1280 x Post info ON/OFF: library, folder cards (no overlapping rects), clip detail, Post mode feed, Playlists, templates, share, add popup;
//             console/page errors, 404s, horizontal scroll, broken images
//   posted    'Posted on' chips (D53): toggle YouTube ON on a real moment (phone width), check it persists after a reload and shows in the
//             Library 'Posted on' filter, toggle it OFF again and check it is gone after another reload; screenshots posted_*.png
//   playlistui D54: throwaway playlist 'zz ui' with 2 real clips; phone screenshots of the playlist screen, the header ... menu, an item menu, the player with the version toggle (switched once), a Post info card;
//             header/item/chips/no-repeat checks; the playlist is removed at the end (PROBE_SCHEME=light for the light theme)
//   roundtrip add a clip to a throwaway playlist 'zz probe', remove it, DELETE the playlist again (needs the saving key in config.json)
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const URL_ = process.env.LIVE_URL || 'https://soverellp-clip-vault-site.static.hf.space/';
const MODE = process.argv[2] || 'diag', PASS = process.env.VAULT_PASSPHRASE, PFX = process.env.QA_PREFIX || '';
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'probe_live'); fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s).replace(/hf_[A-Za-z0-9]+/g, 'hf_***').split(PASS || '\u0000').join('***').slice(0, 300);
let bad = 0; const say = (c, m) => { if (!c) bad++; console.log((c ? 'ok ' : 'FAIL ') + m); };
(async () => {
  if (!PASS) { console.log('FAIL no VAULT_PASSPHRASE in env'); process.exit(1); }
  const browser = await chromium.launch();
  const errs = [], notFound = [];
  async function open(width, height) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: process.env.PROBE_SCHEME || 'dark' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('pageerror ' + clean(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console ' + clean(m.text())); });
    page.on('response', r => { if (r.status() === 404 && !/_config\/(playlists|templates|shortlist|posted)\.json/.test(r.url())) notFound.push(clean(r.url().replace(/\?.*/, '')).replace(/^https?:\/\/[^/]+/, '')); });
    await page.goto(URL_);
    await page.waitForSelector('#signin:not([hidden]) #pp-input', { timeout: 20000 });
    await page.uncheck('#remember-cb').catch(() => {});
    await page.fill('#pp-input', PASS); await page.click('#signin button[type=submit]');
    await page.waitForSelector('.folder', { timeout: 40000 });
    return { ctx, page };
  }
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, PFX + name + '.png') });
  const toasts = page => page.$$eval('.toast', e => e.map(x => x.textContent)).then(a => a.map(clean));
  const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  const brokenImgs = page => page.$$eval('img', is => is.filter(i => i.offsetParent && i.complete && i.naturalWidth === 0 && i.currentSrc).length);
  const modal = page => page.waitForSelector('dialog.pl-modal[open].shown', { timeout: 8000 });
  const modalGone = page => page.waitForSelector('dialog.pl-modal[open]', { state: 'detached', timeout: 8000 }).catch(() => null);
  const go = async (page, hash, sel) => { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForSelector(sel, { timeout: 12000 }); await sleep(500); };
  const openFolder = async page => { await sleep(600); await page.$eval('.folder a', e => e.click()); await page.waitForSelector('ul.grid.moments li.card:not(.sk)', { timeout: 30000 }); await page.click('.cat[data-cat="all"]').catch(() => {}); await sleep(1200); };
  async function setPostInfo(page, on) { if ((await page.getAttribute('#pm-toggle', 'aria-pressed') === 'true') !== on) { await page.click('#pm-toggle'); await sleep(500); } }
  const overlaps = page => page.evaluate(() => {
    const box = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    const hit = (a, b) => a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1;
    const cards = [...document.querySelectorAll('ul.grid.moments li.card:not(.sk)')].filter(c => c.offsetParent), bad = [];
    for (const c of cards) {
      const all = ['.poster', '.title', '.tpill', '.vpill'].map(q => [q, c.querySelector(q)]).concat([...c.querySelectorAll('.pinfo > *')].map(e => ['pinfo>' + e.className, e])).concat([...c.querySelectorAll('.po-item')].map(e => ['po-item', e])).filter(([, e]) => e && e.offsetParent);
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) { const [qa, ea] = all[i], [qb, eb] = all[j]; if (!ea.contains(eb) && !eb.contains(ea) && hit(box(ea), box(eb))) bad.push(qa + ' x ' + qb); }
      const cb = box(c); if ([...c.querySelectorAll('.card-in, .pinfo')].some(k => box(k).b > cb.b + 1)) bad.push('content sticks out of the card');
    }
    for (let i = 0; i + 1 < cards.length; i++) { const a = box(cards[i]), b = box(cards[i + 1]); if (hit(a, b) && Math.abs(a.x - b.x) < 5) bad.push('card ' + i + ' overlaps card ' + (i + 1)); }
    return { n: cards.length, bad: [...new Set(bad)].slice(0, 5) };
  });
  try {
    if (MODE === 'load') {
      const { page } = await open(1280, 800); say(true, 'unlocked, folders=' + (await page.$$('.folder')).length);
      await page.click('.pl-nav-top'); await page.waitForSelector('[class*="pl-"]', { timeout: 8000 }); say(true, 'Playlists button works');
    } else if (MODE === 'qa') {
      for (const [w, h, tag] of [[390, 844, 'phone'], [1280, 800, 'pc']]) {
        const { ctx, page } = await open(w, h); const T = `[${tag}] `;
        say(await noOverflow(page), T + 'library: no horizontal scroll'); await shot(page, `library_${tag}`);
        await openFolder(page);
        for (const on of [true, false]) {
          await setPostInfo(page, on); await sleep(900); const S = T + `folder, Post info ${on ? 'ON' : 'OFF'}: `;
          const o = await overlaps(page);
          say(o.n >= 2 && o.bad.length === 0, S + `${o.n} cards, no overlapping rects` + (o.bad.length ? ' ' + JSON.stringify(o.bad) : ''));
          say(await noOverflow(page), S + 'no horizontal scroll'); say((await brokenImgs(page)) === 0, S + 'images load');
          await page.evaluate(() => document.querySelector('ul.grid.moments li.card:not(.sk)').scrollIntoView()); await sleep(500);
          await shot(page, `cards_${on ? 'on' : 'off'}_${tag}`);
        }
        await setPostInfo(page, true);
        const key = await page.$eval('ul.grid.moments li.card:not(.sk)', li => li.dataset.id);
        await go(page, '#/clip/' + encodeURIComponent(key), 'dialog[open], .drawer, #drawer:not([hidden]), .panel'); say(await noOverflow(page), T + 'clip detail: no horizontal scroll'); await shot(page, `clip_${tag}`);
        await go(page, '#/post/' + encodeURIComponent(key), '.pm-feed'); say(await noOverflow(page), T + 'Post mode feed: no horizontal scroll'); await shot(page, `postmode_${tag}`);
        await go(page, '#/playlists', '.pl-bar, .pl-head'); say(await noOverflow(page), T + 'Playlists landing: no horizontal scroll'); await shot(page, `playlists_${tag}`);
        await go(page, '#/templates', '.tpl-card, .pl-head'); say(await noOverflow(page), T + 'templates: no horizontal scroll'); await shot(page, `templates_${tag}`);
        await go(page, '#/', 'ul.grid.moments li.card:not(.sk), .folder').catch(() => {});
        await page.evaluate(() => { location.hash = '#/'; }); await sleep(800);
        if (!(await page.$('ul.grid.moments li.card:not(.sk)'))) await openFolder(page);
        await page.click('li.card:not(.sk) .pi-add').catch(async () => { await page.click('li.card:not(.sk) .pi-add-more'); });
        await modal(page); await sleep(900); say(await noOverflow(page), T + 'add popup: no horizontal scroll'); await shot(page, `addpopup_${tag}`);
        const msg = await page.textContent('dialog.pl-modal[open] .modal-body'); say(true, T + 'add popup text: ' + clean(msg.replace(/\s+/g, ' ')).slice(0, 160));
        await page.click('dialog.pl-modal[open] .modal-foot button:has-text("Cancel")'); await modalGone(page);
        await ctx.close();
      }
    } else if (MODE === 'posted') {
      const chipSel = (key, p) => `ul.grid.moments li.card[data-key="${key}"] .po-chip[data-p="${p}"]`;
      const pick = async page => {   // first card with all 5 chips off: a real moment the dataset does not mark yet
        await page.waitForSelector('ul.grid.moments li.card:not(.sk) .po-chip', { timeout: 20000 }); await sleep(900);
        return page.$$eval('ul.grid.moments li.card:not(.sk)', lis => { for (const li of lis) { const c = [...li.querySelectorAll('.po-chip')]; if (c.length === 5 && c.every(x => x.getAttribute('aria-pressed') === 'false')) return li.dataset.key; } return null; });
      };
      let { ctx, page } = await open(390, 844); await openFolder(page); await setPostInfo(page, true);
      const key = await pick(page); say(!!key, 'found a real moment with no posted mark'); if (!key) throw new Error('no free moment');
      const card = `ul.grid.moments li.card[data-key="${key}"]`, chip = chipSel(key, 'youtube');
      say((await page.$$(card + ' .po-chip')).length === 5 && !(await page.$(card + ' .pi-mark')), 'card has 5 Posted on chips, old Mark posted button gone');
      const sm = await page.$$eval(card + ' .po-chip, ' + card + ' .po-det', els => els.filter(e => e.offsetParent && (e.getBoundingClientRect().height < 43.5 || e.getBoundingClientRect().width < 43.5)).length); say(sm === 0, 'chips are >= 44 px');
      const o = await overlaps(page); say(o.bad.length === 0, `${o.n} cards, no overlapping rects` + (o.bad.length ? ' ' + JSON.stringify(o.bad) : ''));
      await page.evaluate(k => document.querySelector(`li.card[data-key="${k}"]`).scrollIntoView({ block: 'center' }), key); await sleep(400);
      await page.click(chip); say((await page.getAttribute(chip, 'aria-pressed')) === 'true', 'tap YouTube: chip on at once');
      await page.waitForSelector('.toast [data-act="undo"]', { timeout: 10000 }); say(true, 'toast with Undo: ' + (await toasts(page)).join(' | ').slice(0, 100));
      await sleep(5000); await shot(page, 'posted_on');
      await page.screenshot({ path: path.join(OUT, PFX + 'posted_card.png'), clip: await page.$eval(card, e => { const r = e.getBoundingClientRect(); return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, innerWidth), height: Math.min(r.height, innerHeight - Math.max(0, r.y)) }; }) });
      await ctx.close();
      ({ ctx, page } = await open(390, 844)); await openFolder(page); await setPostInfo(page, true); await page.waitForSelector(chip, { timeout: 20000 }); await sleep(900);
      say((await page.getAttribute(chip, 'aria-pressed')) === 'true', 'after a fresh load (new session): YouTube is still on = persisted in the dataset');
      await page.click('#filter-btn'); await sleep(300);
      await page.click('.chip[data-kind="postedon"]:has(.lbl:text-is("YouTube"))'); await sleep(600);
      say(!!(await page.$(card)), 'Library "Posted on: YouTube" filter shows the moment'); await page.click('.chip[data-kind="postedon"]:has(.lbl:text-is("YouTube"))'); await sleep(300);
      await page.evaluate(k => document.querySelector(`li.card[data-key="${k}"]`).scrollIntoView({ block: 'center' }), key); await sleep(400);
      await page.click(chip); say((await page.getAttribute(chip, 'aria-pressed')) === 'false', 'tap YouTube again: chip off at once');
      await sleep(6000); await ctx.close();
      ({ ctx, page } = await open(390, 844)); await openFolder(page); await setPostInfo(page, true); await page.waitForSelector(chip, { timeout: 20000 }); await sleep(900);
      say((await page.getAttribute(chip, 'aria-pressed')) === 'false', 'after another fresh load: YouTube is off again = dataset back to how it began');
      await shot(page, 'posted_off'); await ctx.close();
    } else if (MODE === 'cleanup') {
      const { ctx, page } = await open(1280, 800); await go(page, '#/playlists', '.pl-bar'); await sleep(1500);
      for (let i = 0; i < 5; i++) { const card = '.pl-card:has-text("zz probe")'; if (!(await page.$(card))) break;
        await page.click(card + ' .pl-more'); await page.waitForSelector('dialog.sheet[open].shown'); await page.click('dialog.sheet[open] [data-act="delete"]'); await modal(page); await page.click('dialog.pl-modal[open] .modal-foot button:has-text("Delete")'); await modalGone(page); await sleep(2500); }
      say(!(await page.$('.pl-card:has-text("zz probe")')), 'no "zz probe" playlist left'); await ctx.close();
    } else if (MODE === 'playlistui') {
      const { page } = await open(390, 844); await openFolder(page); await setPostInfo(page, true);
      const NAME = 'zz ui', pl = '.pl-card:has-text("' + NAME + '")';
      const menuOf = async (opener, act) => { await page.click(opener); await page.waitForSelector('dialog.sheet[open].shown'); if (act) { await page.click(`dialog.sheet[open] [data-act="${act}"]`); await sleep(400); } };
      try {
        // a Post info card first (the library is on screen)
        const o = await overlaps(page); say(o.bad.length === 0, `${o.n} cards, no overlapping rects` + (o.bad.length ? ' ' + JSON.stringify(o.bad) : ''));
        const nctl = await page.$$eval('ul.grid.moments li.card:not(.sk)', cs => cs.slice(0, 8).map(li => li.querySelectorAll('.shl:not([hidden]), .card-more, .vpill:not([hidden]), .tpill:not([hidden]), .po-ctl, .pl-split').length)); say(nctl.every(n => n <= 6), 'cards show at most 6 control groups ' + nctl.join(','));
        await page.evaluate(() => document.querySelector('ul.grid.moments li.card:not(.sk)').scrollIntoView({ block: 'start' })); await sleep(500); await shot(page, 'ui2_card_postinfo');
        // create the playlist with the first two moments
        await page.click('li.card:not(.sk) .pi-add-more'); await modal(page);
        say(!/read-only/i.test(await page.textContent('dialog.pl-modal[open] .modal-body')), 'add popup is not read-only');
        await page.fill('#pl-new-name', NAME); await page.click('dialog.pl-modal[open] .pl-create-b'); await sleep(400); await page.click('dialog.pl-modal[open] .pl-save'); await modalGone(page); await sleep(1500);
        await page.evaluate(() => document.querySelectorAll('ul.grid.moments li.card:not(.sk)')[1].scrollIntoView({ block: 'center' })); await sleep(300);
        await page.click('ul.grid.moments li.card:not(.sk):nth-of-type(2) .pi-add'); await sleep(2500);
        await go(page, '#/playlists', '.pl-card'); await shot(page, 'ui2_playlists_list');
        await page.click(pl + ' a.pl-card-t'); await page.waitForSelector('.pl-items .pl-item', { timeout: 10000 }); await sleep(1500);
        const n = (await page.$$('.pl-items .pl-item')).length; say(n === 2, 'playlist "' + NAME + '" has 2 items (' + n + ')');
        const head = await page.$$eval('.pl-head .pl-bar > *', e => e.map(x => (x.textContent || '').trim() || x.getAttribute('aria-label'))); say(head.length === 3 && head[0] === 'Share' && head[1] === 'Apply template', 'header actions: ' + head.join(' | '));
        say(await noOverflow(page), 'no horizontal scroll on the playlist screen');
        for (const li of await page.$$('.pl-item:not(.stale)')) {
          const r = await li.evaluate(e => ({ chips: new Set([...e.querySelectorAll('.po-chip')].map(c => Math.round(c.getBoundingClientRect().top))).size, nchip: e.querySelectorAll('.po-chip').length, grp: e.querySelectorAll('.vs-g').length, ctl: [...e.querySelectorAll('a[href],button,summary')].filter(x => !x.closest('.vsel,.po-ctl')).length + (e.querySelector('.vsel') ? 1 : 0) + 1, inside: [...e.querySelectorAll('.po-chip')].every(c => c.getBoundingClientRect().right <= e.getBoundingClientRect().right + 0.5), tit: e.querySelector('.pl-item-t').textContent, cap: [...e.querySelectorAll('.pl-det .pl-item-cap')].map(x => x.textContent) }));
          say(r.nchip === 5 && r.chips === 1 && r.inside, `item chips on one row (${r.nchip} chips, ${r.chips} row)`); say(r.ctl <= 6, `item controls: ${r.ctl}, version groups: ${r.grp}`);
          say(!r.cap.some(c => c.trim().toLowerCase().startsWith(r.tit.trim().toLowerCase())), 'description does not start with the title');
        }
        await shot(page, 'ui2_playlist'); await page.screenshot({ path: path.join(OUT, PFX + 'ui2_playlist_full.png'), fullPage: true });
        await menuOf('.pl-menu-b'); await shot(page, 'ui2_headmenu'); await page.keyboard.press('Escape'); await sleep(400);
        await menuOf('.pl-item .pl-more'); await shot(page, 'ui2_itemmenu'); await page.keyboard.press('Escape'); await sleep(400);
        const det = await page.$('.pl-item .pl-det summary'); if (det) { await det.click(); await sleep(300); await page.evaluate(() => document.querySelector('.pl-item .pl-det').scrollIntoView({ block: 'center' })); await shot(page, 'ui2_item_details'); await det.click(); }
        // the player with the version toggle
        await page.evaluate(() => document.querySelector('.pl-item a.pl-thumbw').click()); await page.waitForSelector('dialog.drawer[open] .player', { timeout: 15000 }); await sleep(2500);
        const has = await page.$('.player .vsel');
        if (has) {
          const nb = (await page.$$('.player .vs-b')).length; say(nb >= 2, 'player has the version toggle (' + nb + ' buttons)');
          await page.click('.player .bigplay').catch(() => {}); await sleep(2500);
          const t0 = await page.$eval('.player video', v => v.currentTime);
          const off = await page.$('.player .vs-b[aria-pressed="false"]:not([disabled])');
          if (off) { const lab = await off.getAttribute('aria-label'); await off.click(); await sleep(6000); say((await page.getAttribute('.player .vs-b[aria-label="' + lab + '"]', 'aria-pressed')) === 'true', 'switched to "' + lab + '" in the player'); const t1 = await page.$eval('.player video', v => v.currentTime); say(t1 >= t0 - 0.5, `position kept ${t0.toFixed(1)}s -> ${t1.toFixed(1)}s`); }
          await shot(page, 'ui2_player'); say(await noOverflow(page), 'no horizontal scroll in the clip screen');
        } else say(false, 'player has no version toggle (clip has one version only?)');
        await page.click('.drawer-close').catch(() => {}); await sleep(600);
      } finally {
        await go(page, '#/playlists', '.pl-card').catch(() => {});
        for (let i = 0; i < 3; i++) { if (!(await page.$(pl))) break; await menuOf(pl + ' .pl-more', 'delete'); await modal(page); await page.click('dialog.pl-modal[open] .modal-foot button:has-text("Delete")'); await modalGone(page); await sleep(3000); }
        say(!(await page.$(pl)), 'throwaway playlist removed again (dataset ends as it began)');
      }
    } else if (MODE === 'roundtrip') {
      const { ctx, page } = await open(390, 844); await openFolder(page);
      const NAME = 'zz probe';
      await page.click('li.card:not(.sk) .pi-add-more').catch(() => page.click('li.card:not(.sk) .pi-add'));
      await modal(page);
      const ro = /read-only/i.test(await page.textContent('dialog.pl-modal[open] .modal-body'));
      say(!ro, 'add popup shows no read-only message'); if (ro) throw new Error('read-only');
      await page.fill('#pl-new-name', NAME); await page.click('dialog.pl-modal[open] .pl-create-b'); await sleep(500);
      await page.click('dialog.pl-modal[open] .pl-save'); await modalGone(page);
      await page.waitForSelector('.toast', { timeout: 15000 }); const t = await toasts(page); say(!t.some(x => /read-only|could not|refused/i.test(x)), 'saved, toast: ' + t.join(' | ').slice(0, 120));
      await go(page, '#/playlists', '.pl-card'); const card = `.pl-card:has-text("${NAME}")`;
      say(!!(await page.$(card)), 'playlist "zz probe" exists on the Playlists screen');
      await page.click(card + ' a.pl-card-t'); await page.waitForSelector('.pl-items .pl-item', { timeout: 10000 }); say(true, 'playlist has the added clip');
      await page.click('.pl-items .pl-item .pl-more'); await page.waitForSelector('dialog.sheet[open].shown'); await page.click('dialog.sheet[open] [data-act="remove"]'); await sleep(1500);
      say(!(await page.$('.pl-items .pl-item')), 'clip removed from the playlist');
      await go(page, '#/playlists', '.pl-card'); await page.click(card + ' .pl-more'); await page.waitForSelector('dialog.sheet[open].shown'); await page.click('dialog.sheet[open] [data-act="delete"]'); await modal(page);
      await page.click('dialog.pl-modal[open] .modal-foot button:has-text("Delete")'); await modalGone(page); await sleep(3000);
      say(!(await page.$(card)), 'throwaway playlist deleted again');
      await ctx.close();
    } else {
      const { page } = await open(390, 844); await openFolder(page);
      console.log('caps', await page.evaluate(async () => { const m = await import('/js/state.js'); return JSON.stringify(m.state.me?.capabilities) + ' ' + m.state.me?.shortlist_state; }));
      await page.click('li.card:not(.sk) .pi-add').catch(() => {}); await sleep(800);
      console.log('modal', clean(await page.evaluate(() => document.querySelector('dialog[open]')?.textContent || '')));
    }
  } catch (e) { say(false, 'probe crashed: ' + clean(e.message).split('\n')[0]); }
  say(errs.length === 0, 'console/page errors: ' + errs.length); for (const e of errs.slice(0, 8)) console.log('  ' + e);
  say(notFound.length === 0, '404s: ' + notFound.length + (notFound.length ? ' ' + [...new Set(notFound)].slice(0, 5).join(', ') : ''));
  console.log('screens in', OUT);
  await browser.close(); process.exit(bad ? 1 : 0);
})();
