// Version selector (compact segmented control): the SAME control in the player (clip screen, Post mode) and on a playlist item.
// combos = keys '<variant>|<0/1 teaser>' (see playlists.js comboOf). Two small groups: version (With streamer / Clean / Face on top) and teaser (Teaser / Without),
// each shown only when the moment really has the choice. Pressing one button keeps the other axis when that combination exists, else falls back to the one that does.
import { h } from './dom.js';
import { ensureCss } from './plui.js';

const VLAB = { 'with-streamer': ['Streamer', 'With streamer'], clean: ['Clean', 'Clean'], 'face-top': ['Face top', 'Face on top'] };
const ORDER = ['with-streamer', 'clean', 'face-top'];
const parse = k => { const [v, t] = String(k).split('|'); return { v, t: +t ? 1 : 0 }; };
export const hasChoice = combos => { const vs = new Set(combos.map(k => parse(k).v)), ts = new Set(combos.map(k => parse(k).t)); return vs.size > 1 || ts.size > 1; };

export function versionSelect({ combos, current, onPick, cls = '', aria = 'Version' }) {
  ensureCss();
  const set = new Set(combos), vars = ORDER.filter(v => combos.some(k => parse(k).v === v)), teaser = new Set(combos.map(k => parse(k).t)).size > 1;
  let cur = set.has(current) ? current : combos[0];
  const target = (axis, val) => {
    const c = parse(cur), want = axis === 'v' ? `${val}|${c.t}` : `${c.v}|${val}`;
    if (set.has(want)) return want;
    return axis === 'v' ? (set.has(`${val}|${1 - c.t}`) ? `${val}|${1 - c.t}` : null) : (combos.find(k => parse(k).t === val) || null);
  };
  const el = h('div', { class: `vsel ${cls}`.trim(), role: 'group', 'aria-label': aria });
  const mk = (axis, val, short, full) => h('button', { type: 'button', class: 'vs-b', 'data-axis': axis, 'data-val': String(val), 'aria-pressed': 'false', 'aria-label': full, title: full, text: short,
    on: { click: e => { e.preventDefault(); e.stopPropagation(); const k = target(axis, val); if (!k || k === cur) return; cur = k; paint(); onPick(k, { axis, val }); } } });
  const g1 = vars.length > 1 ? h('div', { class: 'vs-g', role: 'group', 'aria-label': 'Version' }, ...vars.map(v => mk('v', v, VLAB[v][0], VLAB[v][1]))) : null;
  const g2 = teaser ? h('div', { class: 'vs-g', role: 'group', 'aria-label': 'Teaser' }, mk('t', 1, 'Teaser', 'With teaser'), mk('t', 0, 'Without', 'Without teaser')) : null;
  el.append(...[g1, g2].filter(Boolean));
  function paint() {
    const c = parse(cur);
    for (const b of el.querySelectorAll('.vs-b')) { const on_ = b.dataset.axis === 'v' ? b.dataset.val === c.v : +b.dataset.val === c.t; b.setAttribute('aria-pressed', String(on_)); b.disabled = !target(b.dataset.axis, b.dataset.axis === 'v' ? b.dataset.val : +b.dataset.val) && !on_; }
  }
  paint();
  return { el, set(k) { if (set.has(k)) { cur = k; paint(); } }, get current() { return cur; } };
}
