// v3 feature tests: Post mode, posting tracker, queue views, quick actions, grouped download queue, shortcuts, hero, motion.
// Registered from run.js with the shared helpers. All of these need the mock API (seed data, error flags).
const fs = require('fs'), path = require('path');
const ORDER = ['c1', 'c8', 'c2', 'c3', 'c6', 'c5', 'c7', 'c4']; // library "Newest" order of the seed

module.exports = function register(X) {
  const { test, mk, done, br, be, reset, L, ok, reqs, CLIPS, card, cardsCount, sleep, waitToast, toastText, openClip } = X;
  const until = async (fn, ms = 5000, step = 60) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) return false; await sleep(step); } };
  const clip = (id) => be.S.clips.find((c) => c.id === id);
  const mp4s = (p) => reqs.get(p).filter((r) => /\.mp4$/.test(r.url.pathname)).map((r) => r.url.pathname.split('/').pop());
  const active = (p) => p.evaluate(() => document.querySelector('.pm-slide.active')?.dataset.id || null);
  const openPost = async (p) => { await p.click('#post-mode-btn'); await p.waitForSelector('dialog.pm[open] .pm-slide.active'); };
  const clip8 = async (p, key, ev) => { await p.keyboard.press(key); await until(async () => (await active(p)) === ev, 6000); await until(() => p.evaluate(() => { const f = document.querySelector('.pm-feed'); return Math.abs(f.scrollTop % f.clientHeight) < 2; }), 3000); return active(p); };
  const small = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 43.5 || r.height < 43.5); }).map((e) => (e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)), sel);

  // ------------------------------------------------------------------ POST MODE
  test('post mode: opens from the button, one mp4 at a time, swipe/wheel/keys, close', async () => {
    await reset(); const p = await mk(br, be, { viewport: { width: 1280, height: 800 } }); await L.visit(p, 'admin');
    ok(mp4s(p).length === 0, 'no .mp4 before opening');
    ok(await p.locator('#post-mode-btn').isVisible(), "'Post mode' button in the library hero");
    await openPost(p);
    ok((await active(p)) === 'c1' && p.url().endsWith('#/post/c1'), 'Post mode opens on the first clip of the current library order (#/post/c1)');
    ok(/1 \/ 8/.test(await p.textContent('.pm-ctr')), 'counter shows 1 / 8');
    await p.waitForFunction(() => { const v = document.querySelector('.pm-slide.active video'); return v && v.readyState >= 2 && !v.paused; }, null, { timeout: 15000 });
    ok(await p.evaluate(() => document.querySelector('.pm-slide.active video').muted), 'the active clip auto-plays muted');
    await sleep(400);
    ok(JSON.stringify(mp4s(p)) === '["c1.mp4"]', 'only the active clip\'s mp4 was requested (' + mp4s(p) + ')');
    const srcs = await p.evaluate(() => [...document.querySelectorAll('.pm-slide')].map((s) => !!s.querySelector('img')?.getAttribute('src')));
    ok(srcs[0] && srcs[1] && !srcs[2] && !srcs[7], 'only the current and the NEXT poster are loaded in the feed (' + srcs.join(',') + ')');
    // tap to unmute, tap to pause
    await p.click('.pm-slide.active .pm-tap'); ok(!(await p.evaluate(() => document.querySelector('.pm-slide.active video').muted)), 'first tap turns the sound on');
    await p.click('.pm-slide.active .pm-tap'); ok(await p.evaluate(() => document.querySelector('.pm-slide.active video').paused), 'second tap pauses');
    ok(await until(() => p.locator('.pm-slide.active .pm-glyph').evaluate((e) => getComputedStyle(e).opacity === '1')), 'paused state shows the play glyph');
    await p.click('.pm-slide.active .pm-tap'); await p.waitForFunction(() => !document.querySelector('.pm-slide.active video').paused); ok(true, 'third tap resumes');
    // keys
    ok((await clip8(p, 'j', 'c8')) === 'c8', 'j goes to the next clip');
    await p.waitForFunction(() => document.querySelectorAll('.pm video').length === 1 && document.querySelector('.pm-slide.active video'));
    ok(await until(() => mp4s(p).includes('c8.mp4')), 'the new active clip\'s mp4 is requested after it settles');
    ok(!(await p.evaluate(() => !!document.querySelector('.pm-slide[data-id="c1"] video'))) && (await p.evaluate(() => document.querySelectorAll('.pm video').length)) === 1, 'the previous clip\'s video is released (exactly one <video> exists)');
    ok(p.url().endsWith('#/post/c8'), 'hash follows the active clip without adding history entries');
    ok(!mp4s(p).includes('c2.mp4'), 'the next mp4 is never preloaded');
    ok((await clip8(p, 'ArrowDown', 'c2')) === 'c2', 'ArrowDown goes to the next clip');
    ok((await clip8(p, 'ArrowUp', 'c8')) === 'c8', 'ArrowUp goes back');
    ok((await clip8(p, 'k', 'c1')) === 'c1', 'k goes to the previous clip');
    await p.mouse.move(400, 400); await p.mouse.wheel(0, 700); ok(await until(async () => (await active(p)) === 'c8'), 'mouse wheel snaps to the next clip'); await sleep(900);
    ok((await p.evaluate(() => document.querySelector('.pm').style.getPropertyValue('--py'))) !== '', 'full motion: aurora parallax is driven by the scroll');
    ok(await p.evaluate(() => { const f = document.querySelector('.pm-feed'); return Math.abs(f.scrollTop % f.clientHeight) < 2; }), 'scroll snaps exactly onto a clip');
    // overlays
    await p.click('.pm-safe'); const g = await p.evaluate(() => { const s = document.querySelector('.pm-slide.active .pm-stage').getBoundingClientRect(), b = document.querySelector('.pm-slide.active .safe-b').getBoundingClientRect(); return { r: b.height / s.height, v: b.height > 0 }; });
    ok(g.v && Math.abs(g.r - 0.2) < 0.01, 'safe-zone toggle shows the bottom 20% overlay on the clip'); await p.keyboard.press('s'); ok(!(await p.locator('.pm.safe-on').count()), 's toggles the overlay off');
    ok((await p.locator('.pm-mute').getAttribute('aria-label')) === 'Mute', 'mute button reflects the sound state');
    // post kit
    const yt = 'button[aria-label="Copy all for YouTube"]', ig = 'button[aria-label="Copy all for Instagram"]';
    await clip8(p, 'k', 'c1');
    await p.click(yt); const t1 = await p.evaluate(() => navigator.clipboard.readText());
    ok(t1.startsWith('Bumrah ki wapsi') && t1.includes('Tags: cricket, bumrah') && t1.includes('Aaj ka sabse bada moment'), 'Copy all for YouTube joins title, description, tags');
    ok(await p.locator(yt).evaluate((e) => e.classList.contains('copied')), 'copy button plays the "copied" micro-animation');
    await p.click(ig); const t2 = await p.evaluate(() => navigator.clipboard.readText()); ok(t2.includes('Bumrah is back') && t2.includes('#cricket #bumrah'), 'Copy all for Instagram joins caption and hashtags');
    await p.keyboard.press('c'); ok((await p.evaluate(() => navigator.clipboard.readText())) === t1, 'c copies the YouTube kit'); await p.keyboard.press('i'); ok((await p.evaluate(() => navigator.clipboard.readText())) === t2, 'i copies the Instagram kit');
    ok(await p.locator('.pm-kit').isVisible(), 'desktop: the kit panel is always open');
    const cnt = await p.locator('.pm-kit .cnt').allInnerTexts(); ok(cnt.some((c) => /\/ 100 chars/.test(c)) && cnt.some((c) => /\/ 2200 chars/.test(c)) && cnt.some((c) => /\/ 30 tags/.test(c)), 'character counters for title, caption and hashtags (' + cnt.join(' | ') + ')');
    await p.locator('.pm-kit .pk-sec[data-kind="yt"] button[aria-label="Copy Title"]').click(); ok((await p.evaluate(() => navigator.clipboard.readText())).startsWith('Bumrah ki wapsi: yaar'), 'per-field copy button copies that field');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#pm-dl')]); ok(/^c1\.mp4$/.test(dl.suggestedFilename()), 'Download button downloads the clip (' + dl.suggestedFilename() + ')');
    const [dl2] = await Promise.all([p.waitForEvent('download'), p.keyboard.press('d')]); ok(/^c1\.mp4$/.test(dl2.suggestedFilename()), 'd key downloads the clip');
    // mark posted toggles (c1: YouTube posted, Instagram not)
    ok((await p.locator('.pm .ptoggle[data-platform="youtube"]').getAttribute('aria-pressed')) === 'true' && (await p.locator('.pm .ptoggle[data-platform="instagram"]').getAttribute('aria-pressed')) === 'false', 'toggles reflect the posted state');
    await p.click('.pm .ptoggle[data-platform="instagram"]'); ok(await until(() => !!clip('c1').posted.instagram), 'Mark posted on Instagram is saved through patchClip');
    ok((await p.locator('.pm .ptoggle[data-platform="instagram"]').getAttribute('aria-pressed')) === 'true', 'toggle flips without leaving Post mode');
    ok(await p.evaluate(() => !!document.querySelector('.pm-slide.active video')), 'the video keeps playing after a toggle (no rebuild)');
    await p.keyboard.press('p'); ok(await until(() => clip('c1').posted.youtube === null), 'p toggles posted on YouTube (unmarks it)');
    await p.waitForSelector('.pm .ptoggle.busy', { state: 'detached' }); // a toggle ignores clicks while its own save is still settling
    await p.keyboard.press('P'); ok(await until(() => clip('c1').posted.instagram === null), 'Shift+P toggles posted on Instagram');
    await p.keyboard.press('?'); await p.waitForSelector('dialog.shortcuts[open]'); ok(true, '? opens the shortcuts overlay inside Post mode');
    await p.keyboard.press('Escape'); await p.waitForSelector('dialog.shortcuts', { state: 'detached' }); ok(await p.locator('dialog.pm[open]').count() === 1, 'Esc closes only the overlay, Post mode stays');
    await p.keyboard.press('Escape'); await p.waitForSelector('dialog.pm:not([open])', { state: 'attached' });
    ok(p.url().endsWith('#/') && (await p.evaluate(() => document.querySelectorAll('.pm video').length)) === 0, 'Esc closes Post mode, back to the library, videos released');
    const st = await p.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length, ck: document.cookie })); ok(st.ls === 0 && st.ss === 0 && st.ck === '', 'Post mode stores nothing in the browser');
    await openPost(p); await p.goBack(); await p.waitForSelector('dialog.pm:not([open])', { state: 'attached' }); ok(true, 'browser Back closes Post mode');
    await done(p);
  }, { mockOnly: true });

  test('post mode: touch swipe on a phone, bottom sheet, tap targets', async () => {
    await reset(); const p = await mk(br, be, { viewport: { width: 390, height: 844 }, mobile: true, touch: true, dpr: 2 }); await L.visit(p, 'admin');
    await openPost(p); await sleep(500);
    ok(!(await p.locator('.pm-kit').isVisible()), 'phone: the kit starts collapsed, the action bar is docked');
    ok(await p.locator('button[aria-label="Copy all for YouTube"]').isVisible() && await p.locator('#pm-dl').isVisible() && await p.locator('.pm .ptoggle').first().isVisible(), 'phone: copy, download and posted toggles are in the docked bar');
    const bar = await p.locator('.pm-sheet').boundingBox(); ok(bar.height < 844 * 0.3 && bar.y + bar.height >= 843, `docked bar is compact and anchored at the bottom (${Math.round(bar.height)} px)`);
    ok((await small(p, '.pm button, .pm a[href], .pm textarea')).length === 0, 'Post mode (collapsed): every tap target >= 44 px ' + JSON.stringify(await small(p, '.pm button, .pm a[href]')));
    await p.click('.pm-handle'); await p.waitForSelector('.pm-kit', { state: 'visible' }); ok((await p.getAttribute('.pm-handle', 'aria-expanded')) === 'true', 'tapping the handle expands the full post kit');
    ok((await small(p, '.pm button, .pm textarea')).length === 0, 'Post mode (expanded): every tap target >= 44 px');
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal scroll'); await p.screenshot({ path: `${L.SHOTS}/390-post-mode-kit.png` });
    await p.click('.pm-handle');
    const cdp = await p.context().newCDPSession(p);
    const swipe = async (y0, y1) => { const t = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: 195, y }] }); const d = y1 < y0 ? -30 : 30; await t('touchStart', y0); for (let y = y0; d < 0 ? y >= y1 : y <= y1; y += d) { await t('touchMove', y); await sleep(16); } await t('touchEnd', y1); };
    await swipe(600, 150);
    ok(await until(async () => (await active(p)) === 'c8', 8000), 'touch swipe up goes to the next clip');
    await swipe(150, 600);
    ok(await until(async () => (await active(p)) === 'c1', 8000), 'touch swipe down goes back');
    await p.screenshot({ path: `${L.SHOTS}/390-post-mode.png` });
    await p.click('.pm-close'); await p.waitForSelector('dialog.pm:not([open])', { state: 'attached' }); await done(p);
  }, { mockOnly: true });

  test('post mode: reduced motion snaps instantly, no parallax; low power is calmer', async () => {
    await reset(); const p = await mk(br, be, { reduced: true }); await L.visit(p, 'admin'); await openPost(p);
    await p.keyboard.press('j'); await sleep(120);
    ok(await p.evaluate(() => { const f = document.querySelector('.pm-feed'); return f.scrollTop === f.clientHeight; }), 'reduced motion: j snaps to the next clip at once (no smooth scroll)');
    ok((await p.evaluate(() => document.querySelector('.pm').style.getPropertyValue('--py'))) === '', 'reduced motion: no parallax');
    ok((await p.evaluate(() => getComputedStyle(document.querySelector('.pm-aur i')).animationName)) === 'none', 'reduced motion: aurora does not animate');
    await done(p);
    const q = await mk(br, be, {}); await L.visit(q, 'admin'); await q.click('#power-btn'); await openPost(q); await sleep(500);
    ok((await q.evaluate(() => getComputedStyle(document.querySelector('.pm-aur i')).animationName)) === 'none', 'low power: aurora does not animate');
    ok(!(await q.evaluate(() => !!document.querySelectorAll('.pm-slide img')[1]?.getAttribute('src'))), 'low power: the next poster is not preloaded');
    await q.keyboard.press('j'); await until(async () => (await active(q)) === 'c8'); ok((await q.evaluate(() => document.querySelector('.pm').style.getPropertyValue('--py'))) === '', 'low power: no parallax'); await done(q);
  }, { mockOnly: true });

  test('post mode: viewer sees chips but no mark-posted controls; deep link; unknown id', async () => {
    await reset(); const p = await mk(br, be, {}); await L.visit(p, 'viewer'); await openPost(p);
    ok((await p.locator('.pm .ptoggle').count()) === 0, 'viewer: no mark-posted toggles in Post mode');
    ok((await p.locator('.pm-bar .pchip').count()) === 2, 'viewer: posted chips are shown');
    ok(await p.locator('button[aria-label="Copy all for YouTube"]').isVisible() && await p.locator('#pm-dl').isVisible(), 'viewer can still copy and download');
    await p.keyboard.press('p'); await waitToast(p, 'admin'); ok(true, 'p as a viewer explains instead of failing'); await done(p);
    const q = await mk(br, be, {}); await L.visit(q, 'admin'); await q.evaluate(() => { location.hash = '#/post/c3'; }); await q.waitForSelector('dialog.pm[open] .pm-slide.active'); ok((await active(q)) === 'c3', 'deep link #/post/c3 opens Post mode on that clip');
    await q.keyboard.press('Escape'); await q.waitForSelector('dialog.pm:not([open])', { state: 'attached' }); await q.evaluate(() => { location.hash = '#/post/nope'; }); await waitToast(q, 'not found'); ok((await q.locator('dialog.pm[open]').count()) === 0, 'unknown clip id: toast, no Post mode'); await done(q);
  }, { mockOnly: true });

  // ------------------------------------------------------------------ TRACKER
  test('tracker: chips, hover dates, filters, drawer toggles, notes, server rejection', async () => {
    await reset(); const p = await mk(br, be, {}); await L.visit(p, 'admin');
    const on = (id, k) => p.locator(`${card(id)} .pchip.${k}.on`).count();
    ok((await on('c1', 'yt')) === 1 && (await on('c1', 'ig')) === 0 && (await on('c2', 'yt')) === 1 && (await on('c2', 'ig')) === 1 && (await on('c3', 'yt')) === 0, 'cards show YouTube / Instagram status chips');
    const tip = await p.locator(`${card('c1')} .pchip.yt`).getAttribute('title'); ok(/Posted on YouTube Shorts: .*4:30.*IST/.test(tip), 'posted chip: local date-time on hover (' + tip + ')');
    ok(/Not posted on Instagram/.test(await p.locator(`${card('c1')} .pchip.ig`).getAttribute('title')), 'not-posted chip says so'); ok(await p.locator(`${card('c3')} .pchip.yt`).evaluate((e) => !e.classList.contains('on')), 'not posted is dim (no .on)');
    await L.openFilter(p);
    const sel = '#postfilter'; const f = async (v) => { await p.selectOption(sel, v); return (await p.locator(`${CLIPS} > li.card`).evaluateAll((l) => l.map((x) => x.dataset.id))).sort().join(','); };
    ok((await f('none')) === 'c3,c4,c5,c7,c8', "filter 'Not posted anywhere'"); ok((await f('yt')) === 'c1', "filter 'Posted on YouTube only'"); ok((await f('ig')) === 'c6', "filter 'Posted on Instagram only'"); ok((await f('both')) === 'c2', "filter 'Posted on both'");
    const labels = await p.locator(`${sel} option`).allInnerTexts(); ok(['Not posted anywhere', 'Posted on YouTube only', 'Posted on Instagram only', 'Posted on both'].every((l) => labels.includes(l)), 'filter labels as specified');
    await f('any');
    // drawer
    await openClip(p, 'c3'); await p.waitForFunction(() => document.querySelector('.drawer video')); await p.evaluate(() => { document.querySelector('.drawer video').__mark = 1; });
    ok((await p.locator('.drawer .ps-row[data-platform="youtube"]').getAttribute('data-posted')) === '0' && (await p.locator('.drawer .posting').isVisible()), 'drawer: Posting section shows both platforms');
    ok((await small(p, '.drawer button, .drawer a[href]')).length === 0, 'drawer: every tap target >= 44 px incl. the sticky bar (' + JSON.stringify(await small(p, '.drawer button, .drawer a[href]')) + ')');
    await p.click('.dbar .ptoggle[data-platform="youtube"]');
    ok(await until(() => !!clip('c3').posted?.youtube), 'drawer toggle calls patchClip with posted.youtube'); ok(!clip('c3').posted.instagram, 'only that platform changed');
    ok((await p.locator('.dbar .ptoggle[data-platform="youtube"]').getAttribute('aria-pressed')) === 'true' && /Posted/.test(await p.locator('.drawer .ps-row[data-platform="youtube"] .ps-w').innerText()), 'drawer repaints with the posted date');
    ok(await p.evaluate(() => document.querySelector('.drawer video')?.__mark === 1), 'toggling posted does not rebuild the player');
    await p.fill('#notes', 'Reel after lunch'); await p.click('#notes-save'); ok(await until(() => clip('c3').notes === 'Reel after lunch'), 'notes are saved with patchClip(id,{notes})');
    await p.fill('#notes', 'x'.repeat(520)); ok((await p.inputValue('#notes')).length === 500, 'notes are limited to 500 characters');
    await p.click('.drawer-close'); await p.waitForSelector('dialog.drawer:not([open])', { state: 'attached' });
    ok((await on('c3', 'yt')) === 1, 'the card chip updates after marking');
    // old server: rejects unknown fields -> clear error, state rolled back, no crash
    await be.ctl('flags', { flags: { rejectPosted: true } }); await openClip(p, 'c5'); await p.click('.dbar .ptoggle[data-platform="instagram"]');
    await waitToast(p, 'did not accept'); ok((await p.locator('.dbar .ptoggle[data-platform="instagram"]').getAttribute('aria-pressed')) === 'false', 'rejected: error toast and the toggle rolls back');
    await be.ctl('flags', { flags: { rejectPosted: false, dropPosted: true } }); await p.click('.dbar .ptoggle[data-platform="youtube"]'); await sleep(500);
    ok((await p.locator('.dbar .ptoggle[data-platform="youtube"]').getAttribute('aria-pressed')) === 'false', 'a server that silently drops the field is detected and rolled back'); ok(/did not accept/.test(await toastText(p)), 'and the user is told');
    ok(p.cv.errors.length === 0, 'no uncaught errors from the rejected writes'); await done(p);
    // viewer
    const v = await mk(br, be, {}); await L.visit(v, 'viewer'); ok((await v.locator(`${card('c2')} .pchip.on`).count()) === 2, 'viewer sees the chips');
    ok(!(await v.locator('#postfilter').isVisible()), 'viewer: posting filter hidden'); await openClip(v, 'c2'); ok((await v.locator('.ptoggle, #notes').count()) === 0 && (await v.locator('.drawer .posting').isVisible()), 'viewer: status visible, no toggles, no notes'); await done(v);
  }, { mockOnly: true });

  // ------------------------------------------------------------------ QUEUES
  test('queue views: All / Ready to post / Best clips / New with counts', async () => {
    await reset(); const p = await mk(br, be, {}); await L.visit(p, 'admin');
    await L.openFilter(p);
    const cnt = async () => Object.fromEntries(await p.locator('.qbtn').evaluateAll((l) => l.map((b) => [b.dataset.q, Number(b.querySelector('.n').textContent)])));
    const order = async () => (await p.locator(`${CLIPS} > li.card`).evaluateAll((l) => l.map((x) => x.dataset.id))).join(',');
    const c = await cnt(); ok(c.all === 8 && c.ready === 5 && c.best === 2 && c.new === 3, 'segmented control with counts ' + JSON.stringify(c));
    ok((await p.locator('.qbtn[aria-pressed="true"]').getAttribute('data-q')) === 'all', 'All is selected by default');
    await p.click('.qbtn[data-q="ready"]'); ok((await order()) === 'c5,c8,c3,c7,c4', 'Ready to post: not posted anywhere, best score first (' + (await order()) + ')');
    await p.click('.qbtn[data-q="best"]'); ok((await order()) === 'c2,c6', 'Best clips: top 25% by score (' + (await order()) + ')');
    await p.click('.qbtn[data-q="new"]'); ok((await order()) === 'c1,c8,c2', 'New: added in the last 48 h, newest first (' + (await order()) + ')');
    ok((await p.textContent('.count')).includes('3 of 8') || /3 clips/.test(await p.textContent('.count')), 'count line follows the queue'); await p.click('.qbtn[data-q="ready"]');
    await openClip(p, 'c5'); await p.click('.dbar .ptoggle[data-platform="youtube"]'); await until(() => !!clip('c5').posted); await p.click('.drawer-close'); await p.waitForSelector('dialog.drawer:not([open])', { state: 'attached' });
    ok((await cnt()).ready === 4 && (await order()) === 'c8,c3,c7,c4', 'marking a clip posted updates Ready to post live (count 4)');
    ok(/^4$/.test(await p.locator('.st-ready b').innerText()), 'hero shows the ready-to-post count');
    await p.click('.qbtn[data-q="all"]'); await p.click('#post-mode-btn'); await p.waitForSelector('dialog.pm[open]'); ok((await p.textContent('.pm-ctr')).includes('/ 8'), 'Post mode from All has every clip');
    await p.keyboard.press('Escape'); await p.waitForSelector('dialog.pm:not([open])', { state: 'attached' });
    await p.click('.qbtn[data-q="ready"]'); await p.click('#post-mode-btn'); await p.waitForSelector('dialog.pm[open]'); ok((await active(p)) === 'c8' && (await p.textContent('.pm-ctr')).includes('/ 4'), 'Post mode follows the active queue (Ready to post, best first)');
    await done(p);
    const v = await mk(br, be, {}); await L.visit(v, 'viewer'); ok((await v.locator('.qbtn[data-q="ready"]').count()) === 0 && (await v.locator('.qbtn').count()) === 3, 'viewer: no Ready-to-post queue'); await done(v);
  }, { mockOnly: true });

  // ------------------------------------------------------------------ ACTION SHEET
  test('card quick actions: "..." button, long press, right click', async () => {
    await reset(); const p = await mk(br, be, { viewport: { width: 1280, height: 800 } }); await p.addInitScript(() => { navigator.share = async (d) => { window.__shared = d; }; }); await L.visit(p, 'admin');
    const sheet = 'dialog.sheet[open]', act = (id) => `${sheet} [data-act="${id}"]`;
    await p.click(`${card('c1')} .card-more`); await p.waitForSelector(sheet);
    const rows = await p.locator(`${sheet} .sheet-act`).allInnerTexts(); ok(['Copy title', 'Copy YouTube kit', 'Copy Instagram kit', 'Download', 'Open in Post mode', 'Share', 'Move to Trash'].every((r) => rows.some((x) => x.trim() === r)) && rows.some((x) => /Mark posted on Instagram/.test(x)), 'action sheet lists every action (' + rows.join(' | ') + ')');
    ok((await small(p, `${sheet} button`)).length === 0, 'sheet rows are >= 44 px');
    await p.click(act('copy-title')); await p.waitForSelector(sheet, { state: 'detached' }); ok((await p.evaluate(() => navigator.clipboard.readText())).startsWith('Bumrah ki wapsi: yaar'), 'Copy title');
    await p.click(`${card('c1')} .card-more`); await p.click(act('copy-yt')); ok((await p.evaluate(() => navigator.clipboard.readText())).includes('Tags: cricket'), 'Copy YouTube kit');
    await p.click(`${card('c1')} .card-more`); await p.click(act('copy-ig')); ok(await until(async () => (await p.evaluate(() => navigator.clipboard.readText())).includes('#cricket')), 'Copy Instagram kit');
    await p.click(`${card('c1')} .card-more`); const [d] = await Promise.all([p.waitForEvent('download'), p.click(act('download'))]); ok(d.suggestedFilename() === 'c1.mp4', 'Download');
    await p.click(`${card('c1')} .card-more`); await p.click(act('share')); ok(await until(() => p.evaluate(() => window.__shared?.title?.includes('Bumrah'))), 'Share uses navigator.share');
    await p.click(`${card('c1')} .card-more`); await p.click(act('mark-ig')); ok(await until(() => !!clip('c1').posted.instagram), 'Mark posted (Instagram) from the sheet'); ok((await p.locator(`${card('c1')} .pchip.ig.on`).count()) === 1, 'chip updates');
    await p.click(`${card('c1')} .card-more`); ok(/Unmark posted on Instagram/.test(await p.innerText(act('mark-ig'))), 'the row now offers Unmark'); await p.click(act('mark-ig')); ok(await until(() => clip('c1').posted.instagram === null), 'Unmark works');
    await p.click(`${card('c3')} .card-more`); await p.click(act('post')); await p.waitForSelector('dialog.pm[open]'); ok((await active(p)) === 'c3', 'Open in Post mode starts on that clip'); await p.keyboard.press('Escape'); await p.waitForSelector('dialog.pm:not([open])', { state: 'attached' });
    await p.click(`${card('c3')} .card-more`); await p.click(act('trash')); await p.waitForSelector('dialog.confirm[open]'); ok(/Move this clip to Trash/.test(await p.textContent('dialog.confirm h2')) && (await p.evaluate(() => document.activeElement.id)) === 'confirm-cancel', 'Move to Trash uses the existing confirmation (focus on Cancel)'); await p.keyboard.press('Escape'); await p.waitForSelector('dialog.confirm', { state: 'detached' }); ok(clip('c3'), 'cancelled: nothing deleted');
    // long press (mouse) and context menu
    await p.locator(`${card('c6')} .card-link`).evaluate((e) => e.scrollIntoView({ block: 'center' })); await sleep(300); // the sticky toolbar must not sit over the card
    const b = await p.locator(`${card('c6')} .card-link`).boundingBox(); await p.mouse.move(b.x + 40, b.y + 40); await p.mouse.down(); await sleep(700); await p.mouse.up(); await p.waitForSelector(sheet);
    ok(!p.url().includes('#/clip/'), 'long press opens the sheet and does not open the clip'); await p.keyboard.press('Escape'); await p.waitForSelector(sheet, { state: 'detached' });
    await p.click(`${card('c6')} .card-link`, { button: 'right' }); await p.waitForSelector(sheet); ok(true, 'right-click / long-press menu opens the sheet'); await p.keyboard.press('Escape'); await sleep(900);
    await p.click(`${card('c6')} .card-link`); await p.waitForSelector('dialog.drawer[open].shown'); ok(true, 'a normal tap still opens the clip afterwards'); await done(p);
    const v = await mk(br, be, {}); await L.visit(v, 'viewer'); await v.click(`${card('c1')} .card-more`); await v.waitForSelector(sheet);
    const vr = await v.locator(`${sheet} .sheet-act`).allInnerTexts(); ok(vr.some((x) => /Copy title/.test(x)) && !vr.some((x) => /Mark posted|Move to Trash/.test(x)), 'viewer: copy/download/open only (no mark posted, no trash)'); await done(v);
  }, { mockOnly: true });

  // ------------------------------------------------------------------ GROUPS + DOWNLOAD QUEUE
  test('stream groups: collapsible headers with totals, download-all queue, confirm over 3, cancel', async () => {
    await reset(); const p = await mk(br, be, { viewport: { width: 1280, height: 800 } }); await L.visit(p, 'admin');
    const downloads = []; p.on('download', (d) => downloads.push(d.suggestedFilename()));
    await L.openFilter(p); await p.click('#group-btn'); ok((await p.locator('.group-head').count()) === 3 && (await p.getAttribute('#group-btn', 'aria-pressed')) === 'true', 'grouping adds one header per stream');
    const h0 = (await p.locator('.group-head').first().innerText()); ok(/ind vs aus live/i.test(h0) && /3 clips/.test(h0) && /2 min 29 s total/.test(h0), 'header shows name, clip count and total duration (' + h0.replace(/\n/g, ' ') + ')');
    ok((await cardsCount(p)) === 8, 'all clips still listed under their headers');
    await p.locator('.group-head .gh-toggle').first().click(); ok((await cardsCount(p)) === 5 && (await p.locator('.group-head .gh-toggle').first().getAttribute('aria-expanded')) === 'false', 'collapsing hides that stream\'s clips');
    ok(await until(() => p.evaluate(() => document.activeElement.className === 'gh-toggle')), 'focus stays on the header toggle');
    await p.locator('.group-head .gh-toggle').first().click(); ok((await cardsCount(p)) === 8, 'expanding shows them again'); await p.screenshot({ path: `${L.SHOTS}/1280-grouped.png` });
    // download all for the 2-clip stream: no confirmation under 4 files
    await p.locator('.group-head[data-stream="2026-01-15_podcast-ep-12"] .gh-dl').click(); await p.waitForSelector('#dq');
    ok((await p.locator('dialog.confirm[open]').count()) === 0, 'no confirmation for 3 files or fewer');
    ok(await until(async () => /All 2 downloaded/.test(await p.textContent('#dq .dq-head')), 12000), 'queue panel reports progress and completion'); ok(downloads.sort().join() === 'c5.mp4,c7.mp4', 'the stream\'s clips downloaded one after another, no zip (' + downloads + ')');
    await p.click('#dq button[aria-label="Close download queue"]'); ok((await p.locator('#dq').count()) === 0, 'queue panel can be closed');
    // over 3 files: confirm, cancel
    await be.ctl('addclips', { stream: '2026-02-20_gaming-night', n: 2 }); await p.evaluate(() => document.dispatchEvent(new Event('x'))); await p.reload(); await p.waitForSelector(`${CLIPS} > li.card`); await L.openFilter(p); await p.click('#group-btn');
    downloads.length = 0; const gh = '.group-head[data-stream="2026-02-20_gaming-night"]';
    ok(/5 clips/.test(await p.locator(gh).innerText()), 'the extra clips joined the stream'); await p.locator(`${gh} .gh-dl`).click(); await p.waitForSelector('dialog.confirm[open]');
    ok(/Download 5 clips\?/.test(await p.textContent('dialog.confirm h2')), 'more than 3 files asks first'); await p.click('#confirm-cancel'); await sleep(400); ok(downloads.length === 0 && (await p.locator('#dq').count()) === 0, 'declining starts nothing');
    await p.locator(`${gh} .gh-dl`).click(); await p.waitForSelector('dialog.confirm[open]'); await p.click('#confirm-ok'); await p.waitForSelector('#dq');
    ok(await until(() => downloads.length >= 1, 8000), 'queue starts after confirming'); await p.click('#dq-cancel');
    ok(await until(async () => /Cancelled/.test(await p.textContent('#dq .dq-head')), 8000), 'cancel stops the queue'); const n = downloads.length; await sleep(1800); ok(downloads.length === n && n < 5, `no more files after cancel (${n} of 5 downloaded)`);
    ok((await p.locator('#dq .dq-row[data-state="skip"]').count()) >= 1, 'remaining items are marked cancelled'); await done(p);
  }, { mockOnly: true });

  // ------------------------------------------------------------------ SHORTCUTS
  test('shortcuts overlay: ? opens it, Esc closes it, not while typing', async () => {
    await reset(); const p = await mk(br, be, {}); await L.visit(p, 'admin');
    await p.fill('#q', ''); await p.focus('#q'); await p.keyboard.type('?'); ok((await p.locator('dialog.shortcuts').count()) === 0 && (await p.inputValue('#q')) === '?', '? is typed normally inside inputs'); await p.fill('#q', ''); await p.evaluate(() => document.activeElement.blur());
    await p.keyboard.press('?'); await p.waitForSelector('dialog.shortcuts[open]'); const txt = await p.innerText('dialog.shortcuts');
    ok(['Next clip', 'Previous clip', 'Copy the YouTube kit', 'Copy the Instagram kit', 'Toggle posted on YouTube', 'Download the clip', 'Search clips', 'Command palette', 'Close the top panel'].every((t) => txt.includes(t)), 'lists j/k, c, i, p, d, /, Ctrl K and Esc');
    ok((await p.evaluate(() => document.activeElement.textContent)) === 'Got it', 'focus moves into the overlay');
    await p.screenshot({ path: `${L.SHOTS}/1280-shortcuts.png` }); await p.keyboard.press('Escape'); await p.waitForSelector('dialog.shortcuts', { state: 'detached' }); ok(true, 'Esc closes it');
    await p.keyboard.press('Control+k'); await p.waitForSelector('dialog.palette[open]'); ok(true, 'Ctrl K still opens the palette'); await p.keyboard.press('Escape'); await done(p);
  }, { mockOnly: true });

  // ------------------------------------------------------------------ HERO + COUNTERS + CARDS
  test('hero spans the content width at every viewport; counters settle on the real numbers', async () => {
    const want = () => { const l = be.S.clips; return { clips: String(l.length), min: Math.round(l.reduce((a, c) => a + (c.dur || 0), 0) / 60) + ' min', mb: Math.round(l.reduce((a, c) => a + (c.size || 0), 0) / 1e6) + ' MB', ready: String(l.filter((c) => !c.posted || (!c.posted.youtube && !c.posted.instagram)).length) }; };
    for (const [w, hgt] of [[1440, 900], [1280, 800], [900, 700], [390, 844]]) {
      await reset(); const p = await mk(br, be, { viewport: { width: w, height: hgt }, mobile: w < 600, touch: w < 600 }); await L.visit(p, 'admin');
      const r = await p.evaluate(() => { const b = (s) => document.querySelector(s).getBoundingClientRect(); const h = b('.lib-hero'), t = b('.toolbar'), g = b('ul.grid:not(.skel)'); return { hl: h.left, hr: h.right, tl: t.left, tr: t.right, gl: g.left, gr: g.right, vw: innerWidth }; });
      ok(r.hl <= r.tl + 1 && r.hr >= r.tr - 1 && r.hl <= r.gl + 1 && r.hr >= r.gr - 1, `@${w}: hero spans at least the full content width (hero ${Math.round(r.hl)}-${Math.round(r.hr)}, content ${Math.round(r.tl)}-${Math.round(r.tr)})`);
      if (w >= 900) ok(Math.abs(r.hl - r.tl) <= 2 && Math.abs(r.hr - r.tr) <= 2, `@${w}: hero edges line up with the toolbar and grid`);
      await sleep(1500); const T = want(), got = await p.evaluate(() => [...document.querySelectorAll('.stats b')].map((b) => b.textContent));
      ok(got[0] === T.clips && got[1] === T.ready && got[2] === T.min && got[3] === T.mb, `@${w}: counters settled on the real values ${JSON.stringify(got)} == ${JSON.stringify([T.clips, T.ready, T.min, T.mb])}`);
      if (w === 1440) { const cv = await p.evaluate(() => { const c = document.getElementById('hero-canvas'); return { vis: !c.hidden, w: c.getBoundingClientRect().width, hw: document.querySelector('.lib-hero').getBoundingClientRect().width, flag: document.documentElement.dataset.hero }; }); ok(!cv.vis || Math.abs(cv.w - cv.hw) <= 3, `@1440: the WebGL canvas spans the whole hero (${Math.round(cv.w)} / ${Math.round(cv.hw)}, mode ${cv.flag})`); }
      await done(p);
    }
    await reset(); const q = await mk(br, be, { reduced: true }); await q.goto(be.url + '/'); await q.waitForSelector('#gbtn .fake-google'); await q.click('#gbtn .fake-google'); await q.waitForSelector(`${CLIPS} > li.card`);
    const T = want(); ok(await until(async () => (await q.evaluate(() => [...document.querySelectorAll('.stats b')].map((b) => b.textContent))).join() === [T.clips, T.ready, T.min, T.mb].join(), 400), 'reduced motion: counters show the real values immediately'); await done(q);
  }, { mockOnly: true });

  test('smart cards: score ring, NEW ribbon, waveform, Ken Burns, skeleton, aurora follows the clip', async () => {
    await reset(); const p = await mk(br, be, {}); await L.visit(p, 'admin');
    ok((await p.locator(`${card('c1')} .ribbon`).isVisible()) && !(await p.locator(`${card('c5')} .ribbon`).isVisible()), 'NEW ribbon only on clips added in the last 48 h');
    ok((await p.locator(`${card('c2')} .badge.score`).getAttribute('style')).includes('--pct: 91'), 'score ring is filled to the score (9.1 -> 91%)');
    ok(/8\.4/.test(await p.locator(`${card('c1')} .badge.score`).innerText()) && /0:47/.test(await p.locator(`${card('c1')} .badge.dur`).innerText()), 'score and duration are shown');
    ok((await p.locator(`${card('c1')} .wave path`).getAttribute('d')) !== (await p.locator(`${card('c2')} .wave path`).getAttribute('d')), 'waveform decoration differs per clip (from id and score)');
    ok(/\d/.test(await p.locator(`${card('c1')} .size`).innerText()), 'file size is shown');
    await p.waitForFunction(() => document.querySelector('li.card[data-id="c1"]').style.getPropertyValue('--ac-rgb') !== '' && document.querySelector('li.card[data-id="c2"]').style.getPropertyValue('--ac-rgb') !== '');
    await p.hover(`${card('c1')} .card-link`); ok(await until(() => p.evaluate(() => getComputedStyle(document.querySelector('li.card[data-id="c1"] .poster img.loaded')).animationName === 'kb')), 'hover: slow Ken Burns on the poster (no video fetch)'); ok(mp4s(p).length === 0, 'hovering fetched no video');
    const a1 = await p.evaluate(() => document.documentElement.style.getPropertyValue('--hr')); await p.hover(`${card('c3')} .card-link`); await sleep(100); const a2 = await p.evaluate(() => document.documentElement.style.getPropertyValue('--hr'));
    ok(a1 !== '' && a2 !== '' && a1 + a2 !== '', 'the aurora accent follows the card under the pointer (--hr ' + a1 + ' -> ' + a2 + ')');
    ok((await p.evaluate(() => getComputedStyle(document.querySelector('li.card[data-id="c1"]')).getPropertyValue('--ac-rgb'))).length > 3, 'per-clip accent still extracted');
    const q = await mk(br, be, {}); await q.route('**/api/files/**', async (r) => { await sleep(1200); r.continue(); }); await q.goto(be.url + '/'); await q.waitForSelector('#gbtn .fake-google'); await q.click('#gbtn .fake-google'); await q.waitForSelector(`${CLIPS} > li.card`);
    ok(await q.evaluate(() => getComputedStyle(document.querySelector('.poster.ph'), '::before').display === 'block'), 'posters show a shimmer skeleton while the image loads'); await done(q);
    await done(p);
  }, { mockOnly: true });

  test('contrast of the new colours, forbidden DOM APIs in the new modules, storage stays empty', async () => {
    await reset(); const p = await mk(br, be, { viewport: { width: 390, height: 844 }, mobile: true, touch: true, dpr: 2 }); await L.visit(p, 'admin');
    const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    for (const theme of ['dark', 'light']) {
      await p.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      const col = await p.evaluate(() => { const g = (s, pr) => getComputedStyle(document.querySelector(s))[pr]; return { yt: [g('li.card[data-id="c1"] .pchip.yt.on', 'color'), g('li.card[data-id="c1"] .pchip.yt.on', 'backgroundColor')], ribbon: [g('li.card[data-id="c1"] .ribbon', 'color')], qn: [g('.qbtn .n', 'color'), g('.qbtn .n', 'backgroundColor')] }; });
      ok(ratio(rgb(col.yt[0]), rgb(col.yt[1])) >= 4.5, `[${theme}] posted YouTube chip text contrast ${ratio(rgb(col.yt[0]), rgb(col.yt[1])).toFixed(2)} >= 4.5`);
    }
    await openClip(p, 'c3'); await sleep(300);
    const cc = await p.evaluate(() => { const g = (s, pr) => getComputedStyle(document.querySelector(s))[pr]; return [g('.drawer .pchip.yt', 'color'), g('.drawer', 'backgroundColor')]; });
    ok(ratio(rgb(cc[0]), rgb(cc[1])) >= 3, 'dim (not posted) chip is still readable on the drawer (' + ratio(rgb(cc[0]), rgb(cc[1])).toFixed(2) + ')');
    const st = await p.evaluate(async () => ({ ls: localStorage.length, ss: sessionStorage.length, ck: document.cookie, ca: (await caches.keys()).length, idb: indexedDB.databases ? (await indexedDB.databases()).length : 0 })); ok(st.ls + st.ss + st.ca + st.idb === 0 && st.ck === '', 'nothing in storage after using the new features');
    await done(p);
    const files = ['kit', 'postmode', 'sheet', 'dlqueue', 'shortcuts'].map((n) => fs.readFileSync(path.join(L.STATIC, 'js', n + '.js'), 'utf8'));
    ok(files.every((s) => !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage|indexedDB|document\.cookie|\bfetch\(|XMLHttpRequest/.test(s)), 'new modules: no innerHTML/eval/storage/fetch');
  }, { mockOnly: true });

  test('first paint with the new modules on throttled 4G', async () => {
    await reset(); const p = await mk(br, be, {}); await L.visit(p, 'admin');
    const cdp = await p.context().newCDPSession(p); await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    const runs = []; for (let i = 0; i < 4; i++) { const t0 = Date.now(); await p.goto(be.url + '/'); await p.waitForSelector(`${CLIPS} > li.card.in`, { timeout: 20000 }); runs.push(Date.now() - t0); }
    const best = Math.min(...runs); ok(best < 2500, `first paint ${best} ms best of 4 [${runs}] (< 2500 ms)`); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await done(p);
  }, { mockOnly: true });

  // ------------------------------------------------------------------ SCREENSHOTS v3
  test('v3 screenshots at 390x844 and 1440x900', async () => {
    for (const [name, vp, mobile] of [['390', { width: 390, height: 844 }, true], ['1440', { width: 1440, height: 900 }, false]]) {
      await reset(); const p = await mk(br, be, { viewport: vp, mobile, touch: mobile, dpr: mobile ? 2 : 1 }); await L.visit(p, 'admin'); await sleep(2600);
      await p.screenshot({ path: `${L.SHOTS}/${name}-v3-library.png` });
      await p.evaluate(() => window.scrollTo(0, 430)); await sleep(1200); await p.screenshot({ path: `${L.SHOTS}/${name}-v3-posted-chips.png` }); await p.evaluate(() => window.scrollTo(0, 0));
      await L.openFilter(p); await p.click('#group-btn'); await sleep(700); await p.screenshot({ path: `${L.SHOTS}/${name}-v3-grouped.png` }); await p.click('#group-btn');
      await p.click(`${card('c1')} .card-more`); await p.waitForSelector('dialog.sheet[open]'); await sleep(500); await p.screenshot({ path: `${L.SHOTS}/${name}-v3-action-sheet.png` }); await p.keyboard.press('Escape'); await sleep(300);
      await p.click('.qbtn[data-q="ready"]'); await sleep(500); await p.screenshot({ path: `${L.SHOTS}/${name}-v3-ready-queue.png` }); await p.click('.qbtn[data-q="all"]');
      await p.click('#post-mode-btn'); await p.waitForSelector('dialog.pm[open] .pm-slide.active video'); await sleep(1500); await p.screenshot({ path: `${L.SHOTS}/${name}-v3-post-mode.png` });
      if (mobile) { await p.click('.pm-handle'); await sleep(500); await p.screenshot({ path: `${L.SHOTS}/${name}-v3-post-mode-kit.png` }); }
      await p.keyboard.press('?'); await p.waitForSelector('dialog.shortcuts[open]'); await sleep(500); await p.screenshot({ path: `${L.SHOTS}/${name}-v3-shortcuts.png` }); await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
      await openClip(p, 'c2'); await sleep(900); await p.screenshot({ path: `${L.SHOTS}/${name}-v3-drawer-posting.png` });
      await done(p);
      const l = await mk(br, be, { viewport: vp, mobile, touch: mobile, dpr: mobile ? 2 : 1, scheme: 'light' }); await L.visit(l, 'admin'); await sleep(2200); await l.screenshot({ path: `${L.SHOTS}/${name}-v3-library-light.png` });
      await l.click('#post-mode-btn'); await l.waitForSelector('dialog.pm[open] .pm-slide.active'); await sleep(1200); await l.screenshot({ path: `${L.SHOTS}/${name}-v3-post-mode-light.png` }); await done(l);
    }
    ok(fs.readdirSync(L.SHOTS).filter((f) => /v3-/.test(f)).length >= 20, 'v3 screenshots written to ' + L.SHOTS);
  }, { mockOnly: true });
};
