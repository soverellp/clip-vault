// Pure-node check of the D53 "Posted on" logic (posted.js): merge of 3 sources, set/unset, removal rules, date and link validation, strict parse.
// Run: node site/hfstatic/tests/test_posted_logic.mjs
import assert from 'node:assert/strict';
import * as Q from '../../hfspace/static/js/posted.js';
import * as P from '../../hfspace/static/js/playlists.js';

let n = 0; const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const K = 's1|a', E = Q.emptyPosted();
const set = (d, o) => Q.applyPostedOp(d, { type: 'set', moment_id: K, date: '2026-11-23', link: '', ...o }).doc;
const unset = (d, o) => Q.applyPostedOp(d, { type: 'unset', moment_id: K, ...o }).doc;
const pl = (posted) => ({ version: 1, playlists: [{ id: 'p1', title: 'One', platforms: [], status: 'draft', items: [{ moment_id: K, order: 1, post: { title: '', caption: '', hashtags: [] }, posted }], created_at: '', updated_at: '' }, { id: 'p2', title: 'Two', platforms: [], status: 'draft', items: [{ moment_id: K, order: 1, post: { title: '', caption: '', hashtags: [] }, posted: {} }], created_at: '', updated_at: '' }] });

t('date validation: real calendar dates only', () => {
  for (const ok of ['2026-11-23', '2024-02-29']) assert.ok(Q.validDate(ok), ok);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '23-11-2026', '', null, undefined, '1999-01-01', '2026-11-23T10:00:00Z', 20261123]) assert.ok(!Q.validDate(bad), String(bad));
});
t('link validation: empty or https only, no spaces, no control chars', () => {
  for (const ok of ['', 'https://youtube.com/shorts/abc', 'https://x.com/a?b=1#c']) assert.ok(Q.validLink(ok), ok);
  for (const bad of ['http://a.com', 'javascript:alert(1)', 'data:text/html,x', 'ftp://a', 'https://', 'https:// a.com', 'https://a.com/\nx', '//a.com', 'a.com', 'https://' + 'a'.repeat(500), null, 5]) assert.ok(!Q.validLink(bad), String(bad).slice(0, 30));
});
t('set: new entry, same entry is no change, update date and link, unknown platform / bad date / bad link throw', () => {
  const r = Q.applyPostedOp(E, { type: 'set', moment_id: K, platform: 'youtube', date: '2026-11-23', link: '' });
  assert.ok(r.changed); assert.deepEqual(r.doc.posted[K].youtube, { date: '2026-11-23', link: '' });
  assert.ok(!Q.applyPostedOp(r.doc, { type: 'set', moment_id: K, platform: 'youtube', date: '2026-11-23', link: '' }).changed);
  const u = set(r.doc, { platform: 'youtube', date: '2026-11-24', link: 'https://y.be/x' }); assert.deepEqual(u.posted[K].youtube, { date: '2026-11-24', link: 'https://y.be/x' });
  for (const bad of [{ platform: 'myspace' }, { platform: 'x', date: '2026-02-31' }, { platform: 'x', link: 'http://a.b' }, { platform: 'x', link: 'javascript:1' }, { platform: 'x', moment_id: '' }, { platform: 'x', moment_id: 'a\u0000b' }])
    assert.throws(() => Q.applyPostedOp(E, { type: 'set', moment_id: K, date: '2026-11-23', link: '', ...bad }), /invalid/);
  assert.throws(() => Q.applyPostedOp(E, { type: 'nope', moment_id: K, platform: 'x' }), /invalid/);
});
t('unset: removes one platform, drops the empty moment, absent = no change, input never mutated', () => {
  const d = set(set(E, { platform: 'youtube' }), { platform: 'x' }), copy = JSON.stringify(d);
  const r = Q.applyPostedOp(d, { type: 'unset', moment_id: K, platform: 'youtube' });
  assert.ok(r.changed && !r.doc.posted[K].youtube && r.doc.posted[K].x); assert.equal(JSON.stringify(d), copy);
  assert.deepEqual(unset(r.doc, { platform: 'x' }).posted, {});
  assert.ok(!Q.applyPostedOp(E, { type: 'unset', moment_id: K, platform: 'x' }).changed);
});
t('toggle on then off returns the document to its start (round trip)', () => {
  const d0 = set(E, { platform: 'tiktok', date: '2026-11-20' }), d1 = unset(set(d0, { platform: 'youtube' }), { platform: 'youtube' });
  assert.equal(Q.serializePosted(d1), Q.serializePosted(d0));
});
t('parse (lenient) skips junk; strict throws on a broken existing file, empty / missing = empty document', () => {
  assert.deepEqual(Q.parsePosted('not json'), E); assert.deepEqual(Q.parsePosted(''), E);
  const d = Q.parsePosted({ version: 1, posted: { [K]: { youtube: { date: '2026-11-23', link: 'javascript:alert(1)' }, x: { date: 'bad' }, nope: { date: '2026-11-23' } }, '': { youtube: { date: '2026-11-23' } }, z: 5 } });
  assert.deepEqual(d.posted, { [K]: { youtube: { date: '2026-11-23', link: '' } } });
  assert.throws(() => Q.parsePostedStrict('{oops'));
  assert.throws(() => Q.parsePostedStrict('[1]')); assert.throws(() => Q.parsePostedStrict('{"version":2,"posted":{}}')); assert.throws(() => Q.parsePostedStrict('{"version":1}'));
  assert.deepEqual(Q.parsePostedStrict(null), E); assert.deepEqual(Q.parsePostedStrict(''), E);
});
t('serialize is stable (sorted, platform order, trailing newline) and re-parses to the same document', () => {
  const d = set(set(E, { platform: 'x' }), { platform: 'youtube', link: 'https://a.b/c' }), s = Q.serializePosted(d);
  assert.ok(s.endsWith('\n')); assert.deepEqual(Q.parsePosted(s), d); assert.ok(s.indexOf('youtube') < s.indexOf('"x"'));
});
t('merge of the 3 sources: any one says posted; sources, date and link come from posted.json first', () => {
  const doc = set(E, { platform: 'youtube', date: '2026-11-22', link: 'https://y.be/1' });
  const m = Q.mergedPosted(K, { indexOn: ['youtube', 'instagram'], doc, playlists: pl({ youtube: { date: '2026-11-01', link: '' }, tiktok: { date: '2026-11-02', link: 'https://t.ok/1' } }) });
  assert.deepEqual(Object.keys(m).sort(), ['instagram', 'tiktok', 'youtube']);
  assert.deepEqual(m.youtube.sources, ['posted', 'playlist', 'index']); assert.equal(m.youtube.date, '2026-11-22'); assert.equal(m.youtube.link, 'https://y.be/1');
  assert.deepEqual(m.instagram.sources, ['index']); assert.equal(m.instagram.date, '');
  assert.deepEqual(m.tiktok.sources, ['playlist']); assert.equal(m.tiktok.date, '2026-11-02');
  assert.deepEqual(Q.mergedPosted(K, {}), {}); assert.deepEqual(Q.mergedPosted('other', { indexOn: [], doc, playlists: pl({ x: { date: '2026-11-01', link: '' } }) }), {});
});
t('postedUnion: posted.json and playlists, per moment', () => {
  const u = Q.postedUnion(set(E, { platform: 'x' }), pl({ youtube: { date: '2026-11-01', link: '' } }));
  assert.deepEqual([...u.get(K)].sort(), ['x', 'youtube']); assert.equal(u.size, 1);
});
t('removal rules: posted.json + playlists removable by anyone, index only by an admin', () => {
  const doc = set(E, { platform: 'youtube' }), plays = pl({ youtube: { date: '2026-11-01', link: '' } });
  const mAll = Q.mergedPosted(K, { indexOn: ['youtube'], doc, playlists: plays });
  const a = Q.removalPlan(mAll, K, 'youtube', plays, { admin: true });
  assert.ok(a.unset && a.full && a.index === 'remove'); assert.deepEqual(a.playlistOps, [{ type: 'unmark_posted', id: 'p1', moment_id: K, platform: 'youtube' }]);
  const u = Q.removalPlan(mAll, K, 'youtube', plays, { admin: false });
  assert.ok(u.unset && !u.full && u.index === 'blocked' && u.playlistOps.length === 1);
  const onlyIdx = Q.removalPlan(Q.mergedPosted(K, { indexOn: ['x'] }), K, 'x', null, { admin: false });
  assert.ok(!onlyIdx.unset && !onlyIdx.playlistOps.length && onlyIdx.index === 'blocked' && !onlyIdx.full);
  const only = Q.removalPlan(Q.mergedPosted(K, { doc }), K, 'youtube', null, { admin: false }); assert.ok(only.unset && only.full && only.index === null);
  assert.deepEqual(Q.removalPlan({}, K, 'youtube', null), { unset: false, playlistOps: [], index: null, full: true });
});
t('playlist unmark ops really remove the legacy mark (existing playlist op) and nothing else', () => {
  const plays = pl({ youtube: { date: '2026-11-01', link: '' }, x: { date: '2026-11-01', link: '' } });
  let d = plays; for (const o of Q.playlistUnmarkOps(plays, K, 'youtube')) d = P.applyPlaylistOp(d, o, '2026-11-23T10:00:00Z').doc;
  assert.ok(!d.playlists[0].items[0].posted.youtube && d.playlists[0].items[0].posted.x);
});
t('playlist progress reads the merged state (itemDone hook), so both views agree', () => {
  const plays = pl({}), p = plays.playlists[0], it = p.items[0];
  assert.equal(P.itemDone({ ...p, platforms: ['youtube'] }, it), false);
  P.postedHook.get = (k, pf) => k === K && pf === 'youtube';
  assert.equal(P.itemDone({ ...p, platforms: ['youtube'] }, it), true); assert.equal(P.itemDone({ ...p, platforms: ['youtube', 'x'] }, it), false); assert.equal(P.itemDone({ ...p, platforms: [] }, it), true);
  P.postedHook.get = null;
});
console.log(`\n${n} passed, 0 failed`);
