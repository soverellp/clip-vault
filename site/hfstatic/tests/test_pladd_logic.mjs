// Pure-node check of the D51 helpers (add popup, quick re-save, references, versions, share, toast cap, deep link). Run: node site/hfstatic/tests/test_pladd_logic.mjs
import assert from 'node:assert/strict';
import * as P from '../../hfspace/static/js/playlists.js';

let n = 0; const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const NOW = '2026-11-23T10:00:00Z';
const clips = [
  { id: 'a-w', group: 'a', stream: 's1', variant: 'with-streamer', title: 'A' }, { id: 'a-c', group: 'a', stream: 's1', variant: 'clean', title: 'A' }, { id: 'a-ct', group: 'a', stream: 's1', variant: 'clean', teaser: true, title: 'A' },
  { id: 'b-c', group: 'b', stream: 's1', variant: 'clean', title: 'B' }, { id: 'c1', stream: 's1', title: 'C solo' }, { id: 'x-c', group: 'x', stream: 's2', variant: 'clean', title: 'X' },
  { id: 'gone', group: 'g', stream: 's1', variant: 'clean', trashed_at: '2026-11-22T00:00:00Z' },
];
const op = (d, o) => P.applyPlaylistOp(d, o, NOW).doc;
const withPl = () => op(op(P.emptyDoc(), { type: 'create', id: 'p1', title: 'One', platforms: [] }), { type: 'create', id: 'p2', title: 'Two', platforms: [] });

t('stream expansion: every moment once, filters and trashed clips ignored, other streams skipped', () => {
  assert.deepEqual(P.streamKeys('s1', clips), ['s1|a', 's1|b', 'c1']);
  assert.deepEqual(P.streamKeys('s2', clips), ['s2|x']); assert.deepEqual(P.streamKeys('nope', clips), []);
});
t('versions: combos of a moment, picked set minus unticked ones, unknown types ignored', () => {
  assert.deepEqual([...P.combosOf('s1|a', clips).keys()], ['with-streamer|0', 'clean|0', 'clean|1']);
  assert.deepEqual(P.pickCombos('s1|a', ['clean|1'], clips), ['with-streamer|0', 'clean|0']);
  assert.deepEqual(P.pickCombos('s1|b', ['with-streamer|0'], clips), ['clean|0']);            // a version the moment lacks is ignored
  assert.deepEqual(P.pickCombos('s1|b', ['clean|0'], clips), ['clean|0']);                    // nothing left: keep the moment's own
  assert.equal(P.versionsText(['clean|0', 'with-streamer|0']), 'Clean + With streamer'); assert.equal(P.versionsText(['clean|0']), '');
  assert.deepEqual(P.unionCombos(['s1|a', 's1|b'], clips), ['with-streamer|0', 'clean|0', 'clean|1']);
});
t('multi-playlist save: ONE multi op creates + adds to several playlists, dedupes, items are references only', () => {
  let d = withPl(); d = op(d, { type: 'add_items', id: 'p1', moment_ids: ['s1|a'] });
  const plan = P.planAdd(d, [{ id: 'p1' }, { id: 'p2' }, { id: 'pn', create: { title: 'Fresh' } }], ['s1|a', 's1|b'], [], clips);
  assert.equal(plan.total, 2); assert.deepEqual(plan.added, { p1: ['s1|b'], p2: ['s1|a', 's1|b'], pn: ['s1|a', 's1|b'] }); assert.deepEqual(plan.created, ['pn']);
  const r = P.applyPlaylistOp(d, { type: 'multi', ops: plan.ops }, NOW); assert.equal(r.changed, true);
  const ids = r.doc.playlists.map(p => p.id); assert.deepEqual(ids, ['p1', 'p2', 'pn']);
  assert.deepEqual(r.doc.playlists.map(p => p.items.map(i => i.moment_id)), [['s1|a', 's1|b'], ['s1|a', 's1|b'], ['s1|a', 's1|b']]);
  for (const it of r.doc.playlists.flatMap(p => p.items).filter(i => i.variants)) assert.deepEqual(Object.keys(it).sort(), ['moment_id', 'order', 'post', 'posted', 'variants']);   // a reference: no clip data
  assert.deepEqual(r.doc.playlists[1].items[0].variants, ['with-streamer|0', 'clean|0', 'clean|1']);
  assert.equal(P.applyPlaylistOp(r.doc, { type: 'multi', ops: plan.ops.filter(o => o.type === 'add_items') }, NOW).changed, false);   // a repeat changes nothing
});
t('multi: all or nothing, no nesting, empty refused', () => {
  const d = withPl();
  assert.throws(() => P.applyPlaylistOp(d, { type: 'multi', ops: [{ type: 'add_items', id: 'p1', moment_ids: ['k'] }, { type: 'add_items', id: 'missing', moment_ids: ['k'] }] }, NOW), /notfound/);
  assert.throws(() => P.applyPlaylistOp(d, { type: 'multi', ops: [] }, NOW), /invalid/); assert.throws(() => P.applyPlaylistOp(d, { type: 'multi', ops: [{ type: 'multi', ops: [] }] }, NOW), /invalid/);
});
t('references: delete playlist keeps the others, remove from one does not touch another, old items migrate to all versions', () => {
  let d = withPl(); d = op(d, { type: 'add_items', id: 'p1', moment_ids: ['m'] }); d = op(d, { type: 'add_items', id: 'p2', moment_ids: ['m'], variants: { m: ['clean|0'] } });
  d = op(d, { type: 'set_post', id: 'p1', moment_id: 'm', post: { title: 'Mine' } });
  d = op(d, { type: 'remove_item', id: 'p1', moment_id: 'm' }); assert.equal(d.playlists[1].items[0].moment_id, 'm'); assert.deepEqual(d.playlists[1].items[0].variants, ['clean|0']);
  d = op(d, { type: 'delete', id: 'p1' }); assert.equal(d.playlists.length, 1); assert.equal(d.playlists[0].items[0].post.title, '');
  const old = P.parsePlaylists({ version: 1, playlists: [{ id: 'o', title: 'Old', items: [{ moment_id: 'k', order: 1, post: {}, posted: {} }] }] });
  assert.equal('variants' in old.playlists[0].items[0], false); assert.deepEqual(P.itemModes(old.playlists[0].items[0], [{ id: 'k', stream: '', title: 'k' }]).map(m => m.key), ['clean|0']);
  assert.deepEqual(P.itemModes({ moment_id: 's1|a', variants: ['clean|0', 'face-top|0', 'junk'] }, clips).map(m => m.key), ['clean|0']);
});
t('undo / change: removes exactly what a save added; created playlists go only when empty', () => {
  let d = withPl(); const plan = P.planAdd(d, [{ id: 'p1' }, { id: 'pn', create: { title: 'N' } }], ['s1|a'], [], clips);
  d = op(d, { type: 'multi', ops: plan.ops }); d = op(d, { type: 'add_items', id: 'pn', moment_ids: ['other'] });
  d = op(d, { type: 'multi', ops: P.undoOps(plan.added, plan.created) });
  assert.deepEqual(d.playlists.map(p => [p.id, p.items.length]), [['p1', 0], ['p2', 0], ['pn', 1]]);
});
t('duplicate copies references and post text, not posted marks; remove_stale and set_variants', () => {
  let d = withPl(); d = op(d, { type: 'add_items', id: 'p1', moment_ids: ['a', 'b'], posts: { a: { title: 'TA' } } }); d = op(d, { type: 'mark_posted', id: 'p1', moment_id: 'a', platform: 'x', date: '2026-11-22', link: '' });
  d = op(d, { type: 'duplicate', id: 'p1', new_id: 'p9', title: 'One (copy)' }); const c = d.playlists.at(-1);
  assert.deepEqual([c.id, c.title, c.status, c.items.map(i => i.moment_id), c.items[0].post.title, c.items[0].posted], ['p9', 'One (copy)', 'draft', ['a', 'b'], 'TA', {}]);
  assert.equal(d.playlists[0].items[0].posted.x.date, '2026-11-22'); assert.throws(() => op(d, { type: 'duplicate', id: 'p1', new_id: 'p9' }), /invalid/);
  d = op(d, { type: 'remove_stale', id: 'p1', moment_ids: ['b', 'zzz'] }); assert.deepEqual(d.playlists[0].items.map(i => i.moment_id), ['a']);
  d = op(d, { type: 'set_variants', id: 'p1', moment_id: 'a', variants: ['clean|0'] }); assert.deepEqual(d.playlists[0].items[0].variants, ['clean|0']);
});
t('quick-add memory: parse is safe, keeps last targets and unticked versions, drops junk', () => {
  assert.deepEqual(P.parsePref('not json'), { last: [], excl: [], mode: '' });
  const p = P.parsePref(JSON.stringify({ last: ['p1', 5, 'p2'], excl: ['clean|1', 'bad'], mode: 'clean|0' })); assert.deepEqual(p, { last: ['p1', 'p2'], excl: ['clean|1'], mode: 'clean|0' });
  assert.deepEqual(P.parsePref(P.prefText(p)), p);
  const d = withPl(); assert.deepEqual(P.liveTargets(d, ['p2', 'gone', 'p1']).map(x => x.id), ['p2', 'p1']);                 // a deleted target is skipped
  assert.equal(P.targetsText(d.playlists), 'One, Two'); assert.equal(P.targetsText([...d.playlists, { title: 'T3' }]), 'One, Two +1');
});
t('toast queue: at most 3 visible, the oldest is dropped first', () => {
  let q = []; const dropped = []; for (const i of [1, 2, 3, 4, 5]) { const r = P.capQueue(q, i); q = r.queue; dropped.push(...r.dropped); }
  assert.deepEqual(q, [3, 4, 5]); assert.deepEqual(dropped, [1, 2]); assert.equal(P.TOAST_CAP, 3);
});
t('deep link: #/playlist/<id> parses, junk and other hashes do not', () => {
  assert.equal(P.parsePlaylistHash('#/playlist/pl_abc12'), 'pl_abc12'); assert.equal(P.parsePlaylistHash('#/playlists/pl_abc12'), 'pl_abc12');
  for (const bad of ['#/playlists', '#/playlist/', '#/playlist/a/b', '#/playlist/%E0%A4', '#/playlist/a b', '', null, '#/clip/x']) assert.equal(P.parsePlaylistHash(bad), null, String(bad));
  assert.equal(P.playlistLinkPath('pl_1'), '#/playlist/pl_1');
});
t('share text: title, link, numbered clips with clip links, stale skipped; csv adds version columns only on request', () => {
  let d = withPl(); d = op(d, { type: 'add_items', id: 'p1', moment_ids: ['s1|a', 'dead', 's1|b'], posts: { 's1|a': { title: 'Post A' } } }); const p = d.playlists[0];
  const txt = P.shareText(p, clips, { listLink: 'https://x/#/playlist/p1', clipLink: c => 'https://x/#/clip/' + c.id });
  assert.equal(txt, 'One\nhttps://x/#/playlist/p1\n\n1. Post A\nhttps://x/#/clip/a-c\n2. B\nhttps://x/#/clip/b-c');
  const plain = P.playlistCsv(p, clips).split('\r\n')[0]; assert.equal(plain, 'title,caption,hashtags,platform,status,link');
  const withM = P.playlistCsv(p, clips, { modeOf: () => ['Clean', 'Clean + With streamer', 'https://x/#/clip/a-c'] }).split('\r\n'); assert.ok(withM[0].endsWith(',version,versions,clip_link')); assert.ok(withM[1].endsWith('Clean,Clean + With streamer,https://x/#/clip/a-c'));
});
console.log(`\n${n} passed, 0 failed`);
