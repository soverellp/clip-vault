// Card quick actions: a bottom sheet (long-press or the "..." button on a card).
import { state, canWrite, emit, findClip } from './state.js';
import { h, icon } from './dom.js';
import { createModal } from './a11y.js';
import { titleOf } from './fmt.js';
import { momentKey } from './shortlist.js';
import { openAddToPlaylist } from './plui.js';
import { kitOf, joinKit, copyText, downloadClip, shareClip, PLATFORMS, postedOf, setPosted, startPost } from './kit.js';

export function openCardSheet(c0, { opener } = {}) {
  if (document.querySelector('dialog.sheet[open]')) return null;
  const c = findClip(c0.id) || c0, trashed = !!c.trashed_at;
  const m = createModal({ title: titleOf(c), cls: 'sheet' });
  m.dialog.setAttribute('data-clip', c.id); m.foot.hidden = true;
  const kit = kitOf(c), list = h('ul', { class: 'sheet-list' });
  const add = (label, ic, run, { danger = false, id } = {}) => {
    const b = h('button', { type: 'button', class: 'sheet-act' + (danger ? ' danger' : ''), 'data-act': id }, icon(ic), h('span', { text: label }));
    b.addEventListener('click', () => { m.close(true); setTimeout(() => { try { run(); } catch (e) { console.error(e); } }, 0); });
    list.append(h('li', null, b));
  };
  const titleField = kit.yt.fields.find(f => f.key === 'title');
  add('Copy title', 'copy', () => copyText(titleField ? titleField.value : titleOf(c), 'Title copied'), { id: 'copy-title' });
  add('Copy YouTube kit', 'copy', () => copyText(joinKit(kit.yt), 'YouTube kit copied'), { id: 'copy-yt' });
  add('Copy Instagram kit', 'copy', () => copyText(joinKit(kit.ig), 'Instagram kit copied'), { id: 'copy-ig' });
  if (c.video) add('Download', 'download', () => downloadClip(c), { id: 'download' });
  if (!trashed) add('Add to playlist', 'plus', () => openAddToPlaylist([momentKey(c)], titleOf(c), opener), { id: 'add-playlist' });
  if (!trashed) add('Open in Post mode', 'send', () => startPost(c.id, state.feedIds?.length ? state.feedIds : null, opener), { id: 'post' });
  if (canWrite() && !trashed) for (const pl of PLATFORMS) {
    const on = !!postedOf(c)[pl.key];
    add(on ? `Unmark posted on ${pl.name}` : `Mark posted on ${pl.name}`, 'check', () => setPosted(c, pl.key, !on), { id: 'mark-' + pl.cls });
  }
  if (typeof navigator.share === 'function') add('Share', 'share', () => shareClip(c), { id: 'share' });
  if (canWrite() && !trashed) add('Move to Trash', 'trash', () => emit('act', { type: 'trash', ids: [c.id] }), { danger: true, id: 'trash' });
  m.body.append(list);
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(list.querySelector('button'));
  return m;
}
