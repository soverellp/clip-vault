// Pure-node check of the three version slots of a moment (with-streamer / clean / face-top). Run: node site/hfspace/tests/test_moments_variants.mjs
import assert from 'node:assert/strict';
import * as M from '../static/js/moments.js';

const w = (id, variant) => ({ id, group: 'g', stream: 's', variant });
const ms = M.buildMoments([w('a', 'with-girl'), w('b', 'clean'), w('c', 'face-top'), w('d', 'face-top')]);
assert.equal(ms.length, 2);                                         // a second face-top clip of the same group is its own moment
assert.deepEqual(Object.keys(ms[0].byVariant), ['with-streamer', 'clean', 'face-top']);
assert.equal(M.pick(ms[0], 'face-top').id, 'c');
assert.equal(M.pick(ms[0], undefined).id, 'b');                     // the default is "Clean"
assert.equal(M.pick(M.buildMoments([w('s', 'with-streamer')])[0], undefined).id, 's');   // no Clean: With streamer
assert.equal(M.pick(M.buildMoments([w('x', 'face-top')])[0], undefined).id, 'x');
assert.equal(M.variantOf({ variant: 'face-top' }), 'face-top');
assert.equal(M.variantOf({ variant: 'with-girl' }), 'with-streamer');
assert.deepEqual(M.VARIANTS.map(v => v[0]), ['with-streamer', 'clean', 'face-top']);
assert.equal(M.VARIANTS[2][1], 'Face on top');
console.log('ok: variants');
