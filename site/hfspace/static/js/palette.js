import { state, emit, canWrite, isAdmin, on } from './state.js';
import { h, icon } from './dom.js';
import { titleOf, tagsOf, norm, pretty } from './fmt.js';
import { createModal } from './a11y.js';

// Subsequence fuzzy score: higher is better, -1 = no match. Every whitespace token must match.
export function fuzzy(query, text) {
  const toks = norm(query).split(/\s+/).filter(Boolean); if (!toks.length) return 0;
  const t = norm(text); let total = 0;
  for (const tok of toks) {
    const sub = t.indexOf(tok);
    if (sub >= 0) { total += 100 - Math.min(60, sub) + tok.length * 4 + (sub === 0 || t[sub - 1] === ' ' ? 30 : 0); continue; }
    let i = 0, last = -2, run = 0, sc = 0;
    for (const ch of tok) { const j = t.indexOf(ch, i); if (j < 0) return -1; sc += 10 + (j === last + 1 ? 8 + run++ * 3 : (run = 0, 0)) + (j === 0 || t[j - 1] === ' ' ? 12 : 0) - Math.min(8, j - i); last = j; i = j + 1; }
    total += sc;
  }
  return total;
}
let m = null;
export function commands() {
  const c = [
    { id: 'c-grid', label: 'Switch to grid view', run: () => emit('cmd', 'grid'), kw: 'view layout' },
    { id: 'c-list', label: 'Switch to list view', run: () => emit('cmd', 'list'), kw: 'view layout' },
    { id: 'c-theme', label: 'Toggle light / dark theme', run: () => emit('cmd', 'theme'), kw: 'appearance' },
    { id: 'c-power', label: 'Toggle low power mode', run: () => emit('cmd', 'power'), kw: 'animation webgl battery' },
    { id: 'c-post', label: 'Open Post mode', run: () => emit('cmd', 'post'), kw: 'feed swipe reels shorts copy kit' },
    { id: 'c-keys', label: 'Show keyboard shortcuts', run: () => emit('cmd', 'keys'), kw: 'help ?' },
    { id: 'c-group', label: 'Group library by stream', run: () => emit('cmd', 'group'), kw: 'collapse download all' },
    { id: 'c-lib', label: 'Go to Library', run: () => { location.hash = '#/'; }, kw: 'home clips' },
    ...[['newest', 'Newest'], ['oldest', 'Oldest'], ['longest', 'Longest'], ['biggest', 'Biggest file'], ['score', 'Top score']].map(([k, l]) => ({ id: 'c-sort-' + k, label: 'Sort by ' + l, run: () => emit('cmd', 'sort:' + k), kw: 'order' })),
    { id: 'c-out', label: 'Sign out', run: () => emit('cmd', 'signout'), kw: 'logout' },
  ];
  if (canWrite()) c.splice(5, 0, { id: 'c-up', label: 'Upload a clip', run: () => emit('upload'), kw: 'add new' });
  if (isAdmin()) c.splice(5, 0, { id: 'c-trash', label: 'Open Trash', run: () => { location.hash = '#/trash'; }, kw: 'deleted' }, { id: 'c-audit', label: 'Open Audit log', run: () => { location.hash = '#/audit'; }, kw: 'history' }, ...(state.me?.capabilities?.users ? [{ id: 'c-users', label: 'Manage people', run: () => { location.hash = '#/users'; }, kw: 'users access admins viewers' }] : []));
  return c;
}
export function openPalette() {
  if (m?.dialog.open) return;
  m = createModal({ title: 'Command palette', cls: 'palette', sticky: false });
  const dlg = m.dialog; m.closeX.hidden = true; dlg.querySelector('.modal-head').classList.add('sr');
  const input = h('input', { type: 'text', class: 'pal-in', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list', 'aria-label': 'Search clips and commands', placeholder: 'Search clips, tags, commands…', autocomplete: 'off', spellcheck: 'false' });
  const list = h('ul', { id: 'pal-list', class: 'pal-list', role: 'listbox', 'aria-label': 'Results' });
  m.body.append(h('div', { class: 'pal-box' }, icon('search'), input), list, h('p', { class: 'pal-hint', text: 'Up and down to move, Enter to open, Esc to close' }));
  m.foot.hidden = true;
  let items = [], sel = 0;
  const draw = () => {
    const q = input.value.trim();
    const res = [];
    for (const c of state.clips) { const s = fuzzy(q, [titleOf(c), c.hook, tagsOf(c).join(' '), c.stream].join(' ')); if (s >= 0) res.push({ s: s + (q ? 0 : 0), type: 'clip', c }); }
    res.sort((a, b) => b.s - a.s);
    const clips = res.slice(0, 8).map(x => ({ id: 'pc-' + x.c.id, label: titleOf(x.c), sub: pretty(x.c.stream), ic: 'film', run: () => { location.hash = '#/clip/' + encodeURIComponent(x.c.id); } }));
    const cmds = commands().map(c => ({ c, s: fuzzy(q, c.label + ' ' + (c.kw || '')) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, q ? 5 : 8).map(x => ({ id: x.c.id, label: x.c.label, sub: 'Command', ic: 'command', run: x.c.run }));
    items = [...clips, ...cmds]; sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(...(items.length ? items.map((it, i) => {
      const li = h('li', { id: 'po-' + i, class: 'pal-item' + (i === sel ? ' on' : ''), role: 'option', 'aria-selected': String(i === sel), on: { click: () => choose(i), pointermove: () => { if (sel !== i) { sel = i; mark(); } } } }, icon(it.ic), h('span', { class: 'pal-l', lang: 'hi-Latn', text: it.label }), h('small', { text: it.sub }));
      return li;
    }) : [h('li', { class: 'pal-none', role: 'presentation', text: 'No matches' })]));
    input.setAttribute('aria-activedescendant', items.length ? 'po-' + sel : '');
  };
  const mark = () => { [...list.children].forEach((li, i) => { li.classList.toggle('on', i === sel); li.setAttribute('aria-selected', String(i === sel)); }); input.setAttribute('aria-activedescendant', 'po-' + sel); list.children[sel]?.scrollIntoView({ block: 'nearest' }); };
  const choose = i => { const it = items[i]; if (!it) return; m.close(true); setTimeout(() => it.run(), 0); };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(1, items.length); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
  });
  draw(); m.open(input);
}
