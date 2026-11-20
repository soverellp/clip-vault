// Pure-node check of the shortlist logic (no browser, no network). Run: node site/hfstatic/tests/test_shortlist_logic.mjs
import assert from 'node:assert/strict';
import * as S from '../../hfspace/static/js/shortlist.js';

let n = 0; const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const w = (id, variant, o = {}) => ({ id, group: 'g1', stream: 's1', variant, title: 'T ' + id, ...o });

t('momentKey: all variants of one moment share a key (with-girl counts as with-streamer)', () => {
  assert.equal(S.momentKey(w('a', 'with-girl')), 's1|g1');
  assert.equal(S.momentKey(w('b', 'clean')), 's1|g1');
  assert.equal(S.momentKey(w('c', 'face-top')), 's1|g1');
  assert.equal(S.momentKey(w('d', 'with-streamer')), S.momentKey(w('e', 'clean')));
});
t('momentKey: falls back to the clip id (no group, no variant, unknown variant); same group in two streams differs', () => {
  assert.equal(S.momentKey({ id: 'x1', stream: 's' }), 'x1');
  assert.equal(S.momentKey({ id: 'x2', group: 'g', stream: 's' }), 'x2');
  assert.equal(S.momentKey({ id: 'x3', group: 'g', stream: 's', variant: 'weird' }), 'x3');
  assert.notEqual(S.momentKey(w('a', 'clean', { stream: 's2' })), S.momentKey(w('a', 'clean')));
});
t('parse: junk skipped, plain strings tolerated, duplicates merged (later wins and moves to the end)', () => {
  const l = S.parseShortlist({ version: 1, ids: [{ id: 'a', at: '2026-11-20T10:00:00Z' }, 'b', null, 5, { id: '' }, { id: 'a', at: '2026-11-21T10:00:00Z', note: ' hi ' }, { id: 'c\u0001' }] });
  assert.deepEqual(l.map(e => e.id), ['b', 'a']);
  assert.equal(l[1].at, '2026-11-21T10:00:00Z'); assert.equal(l[1].note, 'hi'); assert.equal(l[0].at, null);
});
t('parse: garbage text or wrong shape reads as empty (a read never fails)', () => {
  assert.deepEqual(S.parseShortlist('{nope'), []); assert.deepEqual(S.parseShortlist(''), []); assert.deepEqual(S.parseShortlist({ ids: 'x' }), []); assert.deepEqual(S.parseShortlist(null), []);
});
t('strict parse (used before a write): missing file = empty, unreadable file THROWS instead of being overwritten', () => {
  assert.deepEqual(S.parseShortlistStrict(null), []);
  assert.deepEqual(S.parseShortlistStrict('{"version":1,"ids":[{"id":"a"}]}').map(e => e.id), ['a']);
  for (const bad of ['{nope', '[]', '"x"', '{"ids":"x"}', '{}']) assert.throws(() => S.parseShortlistStrict(bad), /unreadable/);
});
t('toggle: add keeps order, never duplicates, an existing entry keeps its date; remove drops it; removing a missing id is a no-op', () => {
  let l = S.toggleEntry([], 'a', true, '2026-11-20T10:00:00Z');
  l = S.toggleEntry(l, 'b', true, '2026-11-20T11:00:00Z');
  l = S.toggleEntry(l, 'a', true, '2026-11-20T12:00:00Z');
  assert.deepEqual(l.map(e => e.id), ['b', 'a']); assert.equal(l.find(e => e.id === 'a').at, '2026-11-20T10:00:00Z');
  assert.deepEqual(S.toggleEntry(l, 'b', false).map(e => e.id), ['a']);
  assert.deepEqual(S.toggleEntry(l, 'zzz', false), l);
});
t('toggle: an optional note is kept, trimmed and capped at 200 chars; the input list is not mutated', () => {
  const base = [{ id: 'a', at: '2026-11-20T10:00:00Z' }], snap = JSON.stringify(base);
  const l = S.toggleEntry(base, 'a', true, 'x', '  ' + 'n'.repeat(300));
  assert.equal(l[0].note.length, 200); assert.equal(JSON.stringify(base), snap);
});
t('serialize: version 1, ids with id/at (+note only when present), round-trips through parse', () => {
  const l = S.toggleEntry(S.toggleEntry([], 'a', true, '2026-11-20T10:00:00Z', 'nice'), 'b', true, '2026-11-20T10:01:00Z');
  const o = JSON.parse(S.serializeShortlist(l));
  assert.equal(o.version, 1); assert.deepEqual(o.ids, [{ id: 'a', at: '2026-11-20T10:00:00Z', note: 'nice' }, { id: 'b', at: '2026-11-20T10:01:00Z' }]);
  assert.deepEqual(S.parseShortlist(o), l);
});
t('cap: only the newest MAX_SHORTLIST entries are kept', () => {
  let l = []; for (let i = 0; i < S.MAX_SHORTLIST + 5; i++) l = S.toggleEntry(l, 'k' + i, true, '2026-11-20T10:00:00Z');
  assert.equal(l.length, S.MAX_SHORTLIST); assert.equal(l[0].id, 'k5');
});
t('liveKeys: stale ids (deleted or trashed clips) are ignored; a group key stays live while any variant is active', () => {
  const list = [{ id: 's1|g1' }, { id: 'gone' }, { id: 'x1' }, { id: 'old|g9' }];
  const active = [w('a', 'clean'), { id: 'x1', stream: 's' }];
  assert.deepEqual([...S.liveKeys(list, active)].sort(), ['s1|g1', 'x1']);
  assert.deepEqual([...S.liveKeys(list, [])], []);
  assert.deepEqual([...S.liveKeys(list, [w('a', 'clean')])], ['s1|g1']);   // only the clean version is left: still shortlisted
});
t('isShortlisted: starring one version marks the other versions of the moment', () => {
  const list = S.toggleEntry([], S.momentKey(w('a', 'with-girl')), true, '2026-11-20T10:00:00Z');
  assert.ok(S.isShortlisted(list, w('a', 'with-girl'))); assert.ok(S.isShortlisted(list, w('b', 'clean'))); assert.ok(S.isShortlisted(list, w('c', 'face-top')));
  assert.ok(!S.isShortlisted(list, { id: 'other', stream: 's1' }));
});
t('shortlistText: one numbered line per MOMENT (with-streamer version preferred), stream prettified, post caption underneath when present, stale ids skipped', () => {
  const clips = [w('a-c', 'clean', { post: 'clean caption' }), w('a-w', 'with-streamer', { post: 'Line one\n\n  line   two' }), { id: 'x1', stream: 's2', title: 'Solo' }, { id: 'trashed', stream: 's2', title: 'Hidden' }];
  const list = [{ id: 's1|g1' }, { id: 'x1' }, { id: 'ghost' }];
  const txt = S.shortlistText(list, clips.slice(0, 3), { pretty: s => 'pretty ' + s, title: c => c.title });
  assert.equal(txt, '1. T a-w (pretty s1)\n   Line one line two\n2. Solo (pretty s2)');
  assert.equal(S.shortlistText([], clips), '');
});
console.log(`\n${n} passed, 0 failed`);
