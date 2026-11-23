// Pure-node check of the teaser x version selection of a moment (no browser). Run: node site/hfstatic/tests/test_variants_teaser_logic.mjs
import assert from 'node:assert/strict';
import * as M from '../../hfspace/static/js/moments.js';
import * as S from '../../hfspace/static/js/shortlist.js';

let n = 0; const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const c = (id, variant, teaser) => ({ id, group: 'g', stream: 's', variant, ...(teaser === undefined ? {} : { teaser }) });
const all4 = () => M.buildMoments([c('cn', 'clean', false), c('ct', 'clean', true), c('wn', 'with-streamer', false), c('wt', 'with-streamer', true)]);
const id = (m, sel) => M.pick(m, sel).id;

t('one card per moment: 4 clips of one group merge into ONE moment', () => { const ms = all4(); assert.equal(ms.length, 1); assert.equal(ms[0].clips.length, 4); assert.equal(ms[0].hasTeaser, true); });
t('default (no selection) = Clean + With teaser', () => { const m = all4()[0]; assert.equal(id(m, undefined), 'ct'); assert.equal(id(m, { variant: 'clean', teaser: null }), 'ct'); });
t('explicit picks reach every combination', () => {
  const m = all4()[0];
  assert.equal(id(m, { variant: 'clean', teaser: false }), 'cn'); assert.equal(id(m, { variant: 'with-streamer', teaser: true }), 'wt');
  assert.equal(id(m, { variant: 'with-streamer', teaser: false }), 'wn');
});
t('old string selection still works (version only; teaser default)', () => { const m = all4()[0]; assert.equal(id(m, 'with-streamer'), 'wt'); assert.equal(id(m, 'clean'), 'ct'); });
t('no teaser clips: left group off, default Clean, exactly as before', () => {
  const m = M.buildMoments([c('a', 'with-streamer'), c('b', 'clean')])[0];
  assert.equal(m.hasTeaser, false); assert.equal(M.hasTeaserPair(m), false); assert.equal(id(m, undefined), 'b'); assert.equal(id(m, { variant: 'with-streamer', teaser: true }), 'a');   // a teaser pick drops to no teaser
  assert.equal(M.hasPair(m), true);
});
t('fallback keeps the teaser and drops the version first', () => {
  const m = M.buildMoments([c('cn', 'clean', false), c('wn', 'with-streamer', false), c('wt', 'with-streamer', true)])[0];   // no Clean+teaser
  assert.equal(id(m, undefined), 'wt');                                         // default wants Clean+teaser -> keep teaser, version falls back
  assert.equal(id(m, { variant: 'clean', teaser: true }), 'wt');
  assert.equal(id(m, { variant: 'clean', teaser: false }), 'cn');
});
t('fallback drops the teaser only when no version has it', () => {
  const m = M.buildMoments([c('cn', 'clean', false), c('wn', 'with-streamer', false), c('cx', 'clean', true)])[0];
  assert.equal(id(m, { variant: 'with-streamer', teaser: true }), 'cx');       // with-streamer+teaser missing -> clean+teaser
  const m2 = M.buildMoments([c('only', 'clean', true)])[0]; assert.equal(id(m2, { variant: 'clean', teaser: false }), 'only');   // impossible: any clip
});
t('old data (no teaser key, null, "true" string) is no teaser', () => {
  assert.equal(M.teaserOf({}), false); assert.equal(M.teaserOf({ teaser: null }), false); assert.equal(M.teaserOf({ teaser: 'true' }), false); assert.equal(M.teaserOf({ teaser: true }), true);
  const m = M.buildMoments([c('a', 'clean', 'true'), c('b', 'with-streamer')])[0]; assert.equal(m.hasTeaser, false);
});
t('button state: a combination that does not exist disables the button', () => {
  const m = M.buildMoments([c('cn', 'clean', false), c('ct', 'clean', true), c('wn', 'with-streamer', false)])[0];
  const cur = m.byCombo['clean|1'];
  assert.equal(M.comboExists(m, cur, 'variant', 'with-streamer'), false);       // With streamer + teaser does not exist
  assert.equal(M.comboExists(m, cur, 'teaser', false), true);
  const cur2 = m.byCombo['clean|0']; assert.equal(M.comboExists(m, cur2, 'variant', 'with-streamer'), true);
});
t('pressing a button keeps the other axis', () => {
  const m = all4()[0], cur = m.byCombo['clean|1'];
  assert.deepEqual(M.selWith(cur, 'variant', 'with-streamer'), { variant: 'with-streamer', teaser: true });
  assert.deepEqual(M.selWith(cur, 'teaser', false), { variant: 'clean', teaser: false });
  assert.equal(id(m, M.selWith(cur, 'teaser', false)), 'cn');
});
t('two clips in the same (version, teaser) slot stay separate moments; teaser-less duplicates unchanged', () => {
  assert.equal(M.buildMoments([c('a', 'clean', true), c('b', 'clean', true)]).length, 2);
  assert.equal(M.buildMoments([c('a', 'clean'), c('b', 'clean')]).length, 2);
});
t('shortlist: all four clips share ONE moment key', () => { const k = new Set(['cn', 'ct', 'wn', 'wt'].map((i, j) => S.momentKey(c(i, j < 2 ? 'clean' : 'with-streamer', j % 2 === 1)))); assert.equal(k.size, 1); });
console.log(`${n} passed`);
