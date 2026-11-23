// Pure-node check of playlists.js and templates.js (no browser, no network). Run: node site/hfstatic/tests/test_playlists_logic.mjs
import assert from 'node:assert/strict';
import * as P from '../../hfspace/static/js/playlists.js';
import * as T from '../../hfspace/static/js/templates.js';

let n = 0; const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const NOW = '2026-11-23T10:00:00Z';
const clips = [{ id: 'a-w', group: 'a', stream: 's1', variant: 'with-streamer', title: 'A', dur: 45 }, { id: 'a-c', group: 'a', stream: 's1', variant: 'clean', title: 'A', dur: 45 }, { id: 'b', title: 'B', dur: 30 }];
const op = (d, o) => P.applyPlaylistOp(d, o, NOW).doc;
const base = () => op(op(P.emptyDoc(), { type: 'create', id: 'pl1', title: ' Mine ', description: 'd', platforms: ['x', 'bogus', 'youtube'] }), { type: 'add_items', id: 'pl1', moment_ids: ['s1|a', 'b', 's1|a', 'gone'] });

t('create: sanitised, platforms filtered to the known list in fixed order', () => {
  const p = base().playlists[0];
  assert.equal(p.title, 'Mine'); assert.deepEqual(p.platforms, ['youtube', 'x']); assert.equal(p.status, 'draft'); assert.equal(p.created_at, NOW);
});
t('add_items: deduped, ordered 1..n, a second add of the same ids changes nothing', () => {
  const d = base(), p = d.playlists[0];
  assert.deepEqual(p.items.map(i => [i.moment_id, i.order]), [['s1|a', 1], ['b', 2], ['gone', 3]]);
  assert.equal(P.applyPlaylistOp(d, { type: 'add_items', id: 'pl1', moment_ids: ['b'] }, NOW).changed, false);
});
t('reorder: move up/down clamps, reorder by list keeps unknown ids last', () => {
  let d = op(base(), { type: 'move', id: 'pl1', moment_id: 'gone', to: 0 });
  assert.deepEqual(d.playlists[0].items.map(i => i.moment_id), ['gone', 's1|a', 'b']);
  d = op(d, { type: 'move', id: 'pl1', moment_id: 'gone', to: 99 });
  assert.deepEqual(d.playlists[0].items.map(i => i.moment_id), ['s1|a', 'b', 'gone']);
  d = op(d, { type: 'reorder', id: 'pl1', order: ['b', 's1|a'] });
  assert.deepEqual(d.playlists[0].items.map(i => [i.moment_id, i.order]), [['b', 1], ['s1|a', 2], ['gone', 3]]);
  assert.equal(P.applyPlaylistOp(base(), { type: 'move', id: 'pl1', moment_id: 'b', to: 1 }, NOW).changed, false);
});
t('remove, delete, unknown ids fail instead of guessing', () => {
  assert.equal(op(base(), { type: 'remove_item', id: 'pl1', moment_id: 'b' }).playlists[0].items.length, 2);
  assert.equal(op(base(), { type: 'delete', id: 'pl1' }).playlists.length, 0);
  assert.throws(() => op(base(), { type: 'remove_item', id: 'pl1', moment_id: 'zzz' }), /notfound/);
  assert.throws(() => op(base(), { type: 'delete', id: 'nope' }), /notfound/);
  assert.throws(() => op(base(), { type: 'create', id: 'pl1', title: 'dup' }), /invalid/);
  assert.throws(() => op(base(), { type: 'wat' }), /invalid/);
});
t('strict parse: a damaged existing file is an error, a missing one is empty, junk entries are skipped', () => {
  assert.throws(() => P.parsePlaylistsStrict('{nope'), /unreadable/); assert.throws(() => P.parsePlaylistsStrict('[]'), /unreadable/);
  assert.deepEqual(P.parsePlaylistsStrict(null), P.emptyDoc());
  const d = P.parsePlaylists({ playlists: [{ id: 'ok', title: 'x', items: [{ moment_id: 'm1' }, { moment_id: 'm1' }, { moment_id: 5 }] }, { id: 'bad id!' }, null] });
  assert.equal(d.playlists.length, 1); assert.equal(d.playlists[0].items.length, 1);
  const again = P.parsePlaylists(P.serializePlaylists(base())); assert.deepEqual(again, base());
});
t('set_post marks the item edited; set_posts never overwrites edited items unless overwrite', () => {
  let d = op(base(), { type: 'set_post', id: 'pl1', moment_id: 'b', post: { title: 'Mine', caption: 'hand written', hashtags: 'x y' } });
  assert.equal(d.playlists[0].items[1].post.edited, true); assert.deepEqual(d.playlists[0].items[1].post.hashtags, ['#x', '#y']);
  const posts = { 'b': { title: 'T', caption: 'C', hashtags: [] }, 's1|a': { title: 'TA', caption: 'CA', hashtags: ['#a'] } };
  let r = P.applyPlaylistOp(d, { type: 'set_posts', id: 'pl1', posts, template_id: 'tpl_x' }, NOW).doc;
  assert.equal(r.playlists[0].items[1].post.caption, 'hand written'); assert.equal(r.playlists[0].items[0].post.title, 'TA'); assert.equal(r.playlists[0].template_id, 'tpl_x');
  r = P.applyPlaylistOp(d, { type: 'set_posts', id: 'pl1', posts, overwrite: true }, NOW).doc;
  assert.equal(r.playlists[0].items[1].post.caption, 'C'); assert.equal(r.playlists[0].items[1].post.edited, undefined);
});
t('stale ids: repClip prefers Clean, a trashed/deleted moment is stale, export and progress ignore it', () => {
  assert.equal(P.repClip('s1|a', clips).id, 'a-c'); assert.equal(P.repClip('gone', clips), null);
  const p = base().playlists[0];
  assert.deepEqual(P.liveItems(p, clips).map(i => i.moment_id), ['s1|a', 'b']);
  assert.deepEqual(P.liveItems(p, clips.filter(c => c.id !== 'b')).map(i => i.moment_id), ['s1|a']);
  assert.deepEqual(P.progress(p, clips), { done: 0, total: 2, pct: 0 });
});
t('tracker: mark/unmark posted, done needs every playlist platform, status suggestion, postedMap for the Library filter', () => {
  let d = base; d = base();
  d = op(d, { type: 'mark_posted', id: 'pl1', moment_id: 'b', platform: 'youtube', date: '2026-11-23', link: 'https://y.example/1' });
  let p = d.playlists[0]; assert.equal(P.itemDone(p, p.items[1]), false);
  d = op(d, { type: 'mark_posted', id: 'pl1', moment_id: 'b', platform: 'x', date: '2026-11-23T08:00:00Z', link: 'not a link' });
  p = d.playlists[0]; assert.equal(P.itemDone(p, p.items[1]), true); assert.equal(p.items[1].posted.x.link, ''); assert.equal(p.items[1].posted.x.date, '2026-11-23');
  assert.equal(P.suggestStatus(p, clips), null);
  for (const k of ['youtube', 'x']) d = op(d, { type: 'mark_posted', id: 'pl1', moment_id: 's1|a', platform: k, date: '2026-11-23' });
  assert.equal(P.suggestStatus(d.playlists[0], clips), 'posted'); assert.equal(P.progress(d.playlists[0], clips).pct, 100);
  const pm = P.postedMap(d); assert.deepEqual([...pm.get('b')].sort(), ['x', 'youtube']);
  assert.throws(() => op(d, { type: 'mark_posted', id: 'pl1', moment_id: 'b', platform: 'myspace', date: '2026-11-23' }), /invalid/);
  assert.throws(() => op(d, { type: 'mark_posted', id: 'pl1', moment_id: 'b', platform: 'x', date: 'yesterday' }), /invalid/);
  assert.equal(op(d, { type: 'unmark_posted', id: 'pl1', moment_id: 'b', platform: 'x' }).playlists[0].items[1].posted.x, undefined);
});
t('CSV: quoting, formula neutralising (= + - @), CRLF rows, one row per live item and platform, stale skipped', () => {
  assert.equal(P.csvCell('=1+1'), "'=1+1"); assert.equal(P.csvCell('+49'), "'+49"); assert.equal(P.csvCell('-x'), "'-x"); assert.equal(P.csvCell('@sum'), "'@sum");
  assert.equal(P.csvCell('a,b'), '"a,b"'); assert.equal(P.csvCell('say "hi"'), '"say ""hi"""'); assert.equal(P.csvCell('l1\nl2'), '"l1\nl2"'); assert.equal(P.csvCell('=A,B'), '"\'=A,B"');
  assert.equal(P.csvCell(null), ''); assert.equal(P.csvCell('plain'), 'plain');
  let d = op(base(), { type: 'set_post', id: 'pl1', moment_id: 'b', post: { title: '=HYPERLINK("x")', caption: 'c, d', hashtags: ['#k'] } });
  d = op(d, { type: 'mark_posted', id: 'pl1', moment_id: 'b', platform: 'x', date: '2026-11-23', link: 'https://x.example/1' });
  const lines = P.playlistCsv(d.playlists[0], clips).split('\r\n');
  assert.equal(lines[0], 'title,caption,hashtags,platform,status,link'); assert.equal(lines.length, 2 * 2 + 2);   // header + 2 live items x 2 platforms + trailing ''
  assert.ok(lines.includes('"\'=HYPERLINK(""x"")","c, d",#k,X,posted,https://x.example/1'));
  assert.ok(lines.some(l => l.endsWith(',YouTube,not posted,')));
  assert.ok(!P.playlistCsv(d.playlists[0], clips).includes('gone'));
});
t('copy text: caption keeps hashtags it does not contain yet; playlist text numbers live items only', () => {
  assert.equal(P.captionText({ caption: 'Wow #a', hashtags: ['#a', '#b'] }), 'Wow #a\n\n#b'); assert.equal(P.captionText({ caption: '', hashtags: [] }), '');
  const d = op(base(), { type: 'set_post', id: 'pl1', moment_id: 'b', post: { title: 'Bt', caption: 'Bc', hashtags: [] } });
  assert.equal(P.playlistText(d.playlists[0], clips), '1. (no text yet)\n\n2. Bt\nBc');
});
t('normTags: hash added, junk removed, deduped case-insensitively, string or list', () => {
  assert.deepEqual(P.normTags('#One two, ##THREE !x One'), ['#One', '#two', '#THREE', '#x']); assert.deepEqual(P.normTags(['a b', '#a']), ['#ab', '#a']); assert.deepEqual(P.normTags(null), []);
});

// ---- templates
const ST = { channel: 'Kai Cenat', date: '2026-11-18', game: 'GTA 6' };
t('render: all variables, unknown stays visible and is reported, a known empty variable renders empty and is reported', () => {
  const r = T.renderTemplate('{hook} | {title} | {streamer} | {game} | {date} | {n} | {hashtags} | {nope}', T.buildVars({ hook: 'H', title: 'T' }, ST, 3, ['#a']));
  assert.equal(r.text, 'H | T | Kai Cenat | GTA 6 | 2026-11-18 | 3 | #a | {nope}'); assert.deepEqual(r.unknown, ['nope']);
  const e = T.renderTemplate('x{game}y', T.buildVars({}, null, 1, [])); assert.equal(e.text, 'xy'); assert.deepEqual(e.empty, ['game']);
});
t('render is plain text: markup stays markup text, no variable inside a value is expanded again', () => {
  const r = T.renderTemplate('{hook}', { hook: '<img src=x onerror=alert(1)> {title}', title: 'NO' }); assert.equal(r.text, '<img src=x onerror=alert(1)> {title}');
});
t('presets: five built-ins with the documented limits and the required campaign hashtag', () => {
  const by = Object.fromEntries(T.PRESETS.map(p => [p.name, p]));
  assert.equal(by['YouTube Shorts'].limits.title_max, 100); assert.equal(by['Instagram Reels'].limits.caption_max, 2200); assert.equal(by['Instagram Reels'].limits.hashtags_max, 30);
  assert.equal(by['TikTok'].limits.caption_max, 2200); assert.equal(by['X'].limits.total_max, 280);
  assert.deepEqual(by['Content Rewards Kai Cenat'].required_hashtags, ['#KaiCenat']); assert.equal(by['Content Rewards Kai Cenat'].limits.dur_min, 20); assert.equal(by['Content Rewards Kai Cenat'].limits.dur_max, 50);
  for (const p of T.PRESETS) assert.deepEqual(T.cleanTemplate(p), p);
});
t('renderPost: required hashtag first, template tags, then up to 5 clip tags, deduped; caption has no blank-line pile-up', () => {
  const kai = T.PRESETS.find(p => p.id === 'tpl_contentrewards_kai'), r = T.renderPost(kai, { hook: 'Big', title: 'T', tags: ['gta', '#kaicenat', 'a', 'b', 'c', 'd', 'e'] }, ST, 1);
  assert.deepEqual(r.post.hashtags.slice(0, 2), ['#KaiCenat', '#gta']); assert.equal(r.post.hashtags.length, 5); assert.ok(r.post.caption.startsWith('Big #KaiCenat'));
  const yt = T.renderPost(T.PRESETS[0], { hook: 'Big', title: 'T' }, ST, 1); assert.equal(yt.post.title, 'Big'); assert.ok(!/\n{3}/.test(yt.post.caption));
});
t('validate: empty, title/caption/total/hashtag limits, missing required hashtag, clip length, unknown variable', () => {
  const [yt, ig, , x, kai] = T.PRESETS;
  assert.deepEqual(T.validatePost({ title: '', caption: '', hashtags: [] }, yt), ['Empty: no title and no caption']);
  assert.ok(T.validatePost({ title: 'a'.repeat(101), caption: 'c', hashtags: [] }, yt)[0].includes('limit 100'));
  assert.equal(T.validatePost({ title: 'a'.repeat(100), caption: 'c', hashtags: [] }, yt).length, 0);
  assert.ok(T.validatePost({ title: '', caption: 'c'.repeat(2201), hashtags: [] }, ig).some(w => w.includes('2200')));
  assert.ok(T.validatePost({ title: '', caption: 'ok', hashtags: Array.from({ length: 31 }, (_, i) => '#t' + i) }, ig).some(w => w.includes('31 hashtags')));
  assert.ok(T.validatePost({ title: '', caption: 'c'.repeat(281), hashtags: [] }, x).some(w => w.includes('limit 280')));
  assert.equal(T.validatePost({ title: '', caption: 'c'.repeat(280), hashtags: [] }, x).length, 0);
  assert.ok(T.validatePost({ title: 't', caption: 'c', hashtags: [] }, kai).includes('Missing required hashtag #KaiCenat'));
  assert.equal(T.validatePost({ title: 't', caption: 'I love #kaicenat', hashtags: [] }, kai).length, 0);
  assert.ok(T.validatePost({ title: 't', caption: 'c #KaiCenat', hashtags: [] }, kai, { dur: 55 }).some(w => w.includes('maximum 50')));
  assert.ok(T.validatePost({ title: 't', caption: 'c #KaiCenat', hashtags: [] }, kai, { dur: 15 }).some(w => w.includes('minimum 20')));
  assert.ok(T.validatePost({ title: 't', caption: 'c' }, yt, { unknown: ['foo'] }).includes('Unknown variable {foo}'));
});
t('template ops: upsert/duplicate/delete, seed adds only missing ids, bad input rejected, strict parse', () => {
  let d = T.emptyTemplates();
  d = T.applyTemplateOp(d, { type: 'seed', templates: T.PRESETS }).doc; assert.equal(d.templates.length, 5);
  assert.equal(T.applyTemplateOp(d, { type: 'seed', templates: T.PRESETS }).changed, false);
  d = T.applyTemplateOp(d, { type: 'upsert', template: { ...d.templates[0], name: 'Edited', limits: { title_max: '60', junk: 5 } } }).doc;
  assert.equal(d.templates[0].name, 'Edited'); assert.deepEqual(d.templates[0].limits, { title_max: 60 });
  d = T.applyTemplateOp(d, { type: 'upsert', template: { ...d.templates[0], id: 'tpl_copy', name: 'Copy' } }).doc; assert.equal(d.templates.length, 6);
  d = T.applyTemplateOp(d, { type: 'delete', id: 'tpl_copy' }).doc; assert.equal(d.templates.length, 5);
  assert.throws(() => T.applyTemplateOp(d, { type: 'delete', id: 'zz' }), /notfound/); assert.throws(() => T.applyTemplateOp(d, { type: 'upsert', template: { id: 'bad id' } }), /invalid/);
  assert.throws(() => T.parseTemplatesStrict('oops'), /unreadable/); assert.deepEqual(T.parseTemplatesStrict(null), T.emptyTemplates());
});
t('applyTemplateToItems: fills live items, keeps edited ones unless overwrite, skips stale', () => {
  const items = [{ moment_id: 'm1', post: { edited: true, title: 'mine', caption: '', hashtags: [] } }, { moment_id: 'm2', post: { title: '', caption: '', hashtags: [] } }, { moment_id: 'old', post: {} }];
  const clipOf = k => (k === 'old' ? null : { hook: 'H ' + k, title: k }), kai = T.PRESETS[4];
  let r = T.applyTemplateToItems(items, kai, clipOf, () => ST, false); assert.deepEqual(Object.keys(r.posts), ['m2']); assert.equal(r.skipped, 1); assert.ok(r.posts.m2.caption.includes('#KaiCenat'));
  r = T.applyTemplateToItems(items, kai, clipOf, () => ST, true); assert.deepEqual(Object.keys(r.posts), ['m1', 'm2']); assert.equal(r.skipped, 0);
});
console.log(`\n${n} passed, 0 failed`);
