// Contextual "..." menu: a bottom sheet (same look as the card sheet) holding the secondary actions of a card, a playlist or a playlist item.
// entries: [{ id, label, ic, run, danger, disabled }] (null entries are skipped). Everything is built with textContent (dom.js h()).
import { h, icon } from './dom.js';
import { createModal } from './a11y.js';

export function openMenu({ title, desc, entries, opener, cls = '' }) {
  if (document.querySelector('dialog.sheet[open]')) return null;
  const m = createModal({ title, desc, cls: `sheet pl-menu ${cls}`.trim() }); m.foot.hidden = true;
  const list = h('ul', { class: 'sheet-list' });
  for (const e of entries.filter(Boolean)) {
    const b = h('button', { type: 'button', class: 'sheet-act' + (e.danger ? ' danger' : ''), 'data-act': e.id, disabled: !!e.disabled }, icon(e.ic || 'dots'), h('span', { text: e.label }));
    b.addEventListener('click', () => { m.close(true); setTimeout(() => { try { e.run?.(opener); } catch (x) { console.error(x); } }, 0); });
    list.append(h('li', null, b));
  }
  m.body.append(list);
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(list.querySelector('button:not([disabled])'));
  return m;
}
// The "..." button itself (44 px, aria-haspopup).
export function moreButton(label, onOpen, cls = '') {
  const b = h('button', { type: 'button', class: `btn ghost icon more-b ${cls}`.trim(), 'aria-label': label, title: label, 'aria-haspopup': 'dialog' }, icon('dots'));
  b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onOpen(b); });
  return b;
}
