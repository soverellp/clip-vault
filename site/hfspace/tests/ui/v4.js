// v4: the Library home (folder cards), stream pages, category chips, moment cards and the variant switch, in SERVER mode against the mock API.
// Fixtures: fixtures_library.js (2 streams, 3 pairs, 1 clip without fields). The mock sends no streams[] (server mode has none), so folders come from clip.stream.
const FX = require('./fixtures_library');
module.exports = function register(X) {
  const { test, mk, done, br, be, reset, L, ok, reqs, sleep } = X;
  const MOM = 'ul.grid.moments > li.card';
  const lib = async (p) => { await be.ctl('library'); await L.visit(p, 'admin'); await p.waitForSelector('.folder-grid .folder'); };
  const chips = async (p) => Object.fromEntries(await p.$$eval('.cats .cat', (e) => e.map((x) => [x.dataset.cat, Number(x.querySelector('.n').textContent)])));

  test('library: folder cards, open a stream, category chips with counts, one card per moment (mock, server mode)', async () => {
    await reset(); const p = await mk(br, be, { viewport: { width: 1280, height: 800 } }); await lib(p);
    ok((await p.$$('.folder-grid .folder')).length === 2 && !(await p.isVisible('ul.grid[aria-label="Clips"]')), 'home: one folder card per stream, no clip cards');
    ok(await p.$$eval('.folder', (e) => e.every((f) => f.querySelector('.f-title') && f.querySelector('.f-n') && f.querySelector('.f-size') && f.querySelector('.f-tab'))), 'folder card has a tab, title, count and size');
    await p.click('.folder[data-stream="' + FX.S1 + '"] a'); await p.waitForSelector(MOM);
    ok(p.url().endsWith('#/stream/' + FX.S1), 'opening a folder goes to #/stream/<id>');
    const c = await chips(p); ok(c.reaction === 1 && c.game === 1 && c.best === 1 && c.all === 2, 'chips with counts ' + JSON.stringify(c));
    await p.click('.cat[data-cat="all"]'); // a stream with a tier A moment opens on Best
    ok((await p.$$(MOM)).length === 2, 'one card per moment (4 clips, 2 cards)');
    await p.click('.cat[data-cat="best"]'); ok((await p.$$(MOM)).length === 1, 'Best = tier A'); await p.click('.cat[data-cat="all"]');
    ok((await p.textContent('li.card[data-key$="a1"] .rx')) === 'Reaction: strong', 'reaction badge');
    await p.click('li.card[data-key$="a1"] .vbtn[data-variant="clean"]'); ok((await p.getAttribute('li.card[data-key$="a1"]', 'data-id')) === 'a1-c', 'variant switch retargets the card');
    await p.click('li.card[data-key$="a1"] a.card-link'); await p.waitForSelector('dialog.drawer[open].shown'); await sleep(900);
    ok(reqs.get(p).some((r) => r.url.pathname === '/api/files/clips/a1-c.mp4') && !reqs.get(p).some((r) => r.url.pathname === '/api/files/clips/a1-w.mp4'), 'the clean file is the one that plays');
    await p.click('.drawer-close'); await p.waitForSelector('dialog.drawer:not([open])', { state: 'attached' });
    ok(p.url().endsWith('#/stream/' + FX.S1), 'closing the clip returns to the stream');
    await p.click('.back-link'); await p.waitForSelector('.folder-grid .folder'); ok(true, 'back link returns to the library home');
    const st = await p.evaluate(() => ({ l: Object.keys(localStorage).length, s: Object.keys(sessionStorage).length }));
    ok(st.l === 0 && st.s === 0, 'nothing in storage'); await done(p);
  });
  test('library: old data (no new fields) is still the flat list; Filter button holds sort/view/group', async () => {
    await reset(); const p = await mk(br, be, {}); await L.visit(p, 'admin');
    ok((await p.$$('.folder')).length === 0 && (await p.$$('ul.grid[aria-label="Clips"] > li.card')).length === 8, 'seed data: flat list of 8, no folders');
    ok(!(await p.isVisible('#sort')) && !(await p.isVisible('#group-btn')), 'sort and group are collapsed behind Filter');
    await L.openFilter(p); ok((await p.isVisible('#sort')) && (await p.isVisible('#group-btn')) && (await p.isVisible('.qseg')), 'Filter shows sort, group and the queue'); await done(p);
  });
  test('library: 360 px phone, no horizontal scroll, large tap targets, tab order', async () => {
    await reset(); const p = await mk(br, be, { viewport: { width: 360, height: 740 }, mobile: true, touch: true }); await lib(p);
    const nos = () => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    ok(await nos(), 'home: no horizontal scroll');
    await p.click('.folder a'); await p.waitForSelector(MOM); ok(await nos(), 'stream: no horizontal scroll');
    ok(await p.$$eval('.cat, .vbtn', (e) => e.every((x) => x.offsetHeight >= 44)), 'chips and pill buttons >= 44 px');
    await L.openFilter(p); ok(await nos(), 'filter menu open: no horizontal scroll'); await L.closeFilter(p);
    await p.focus('#q'); const o = []; for (let i = 0; i < 3; i++) { await p.keyboard.press('Tab'); o.push(await p.evaluate(() => document.activeElement.id || document.activeElement.className.split(' ')[0])); }
    ok(o[0] === 'filter-btn' && o[1] === 'post-mode-btn' && o[2] === 'cat', 'tab order inside a stream: search, Filter, Post mode, first category (' + o + ')'); await done(p);
  });
};
