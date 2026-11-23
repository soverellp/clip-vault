// Add to playlist (D51): ONE popup for a clip, a moment, a whole stream or the shortlist; quick re-save to the last playlists; non-blocking toasts with Change and Undo.
// A playlist item is only a reference (moment_id + this playlist's own post text + the version combos picked); one save = ONE commit of playlists.json (op 'multi').
import { state, on } from './state.js';
import { h, btn, icon } from './dom.js';
import { createModal, announce } from './a11y.js';
import { toast } from './toast.js';
import { liveKeys } from './shortlist.js';
import { newId, repClip, planAdd, undoOps, unionCombos, comboLabel, liveTargets, targetsText, versionsText, capQueue, streamKeys, applyPlaylistOp } from './playlists.js';
import { readPlPref, writePlPref } from './viewpref.js';
import { ensureCss, canEditPl, RO_HINT, plAct, newItemPost } from './plui.js';

const TOAST_MS = 6000;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- non-blocking toasts (never a modal, stackable, at most 3 visible, aria-live polite through #toasts)
let live = [];
export function plToast(text, actions = []) {
  const box = document.getElementById('toasts'); if (!box) return null;
  const t = h('div', { class: 'toast success pl-t', role: 'status' });
  let timer; const dismiss = () => { clearTimeout(timer); live = live.filter(x => x !== t); if (!t.isConnected) return; t.classList.add('out'); setTimeout(() => t.remove(), 220); };
  t.append(h('span', { class: 'toast-ic' }, icon('check')), h('span', { class: 'toast-msg', text }));
  for (const a of actions) t.append(h('button', { type: 'button', class: 'toast-act', 'data-act': a.id, text: a.label, on: { click: () => { dismiss(); a.run(); } } }));
  t.append(h('button', { type: 'button', class: 'toast-x', 'aria-label': 'Dismiss', on: { click: dismiss } }, icon('x')));
  const q = capQueue(live, t); for (const old of q.dropped) { clearTimeout(old._timer); old.remove(); }
  live = q.queue; box.append(t);
  const arm = () => { clearTimeout(timer); timer = setTimeout(dismiss, TOAST_MS); t._timer = timer; };
  t.addEventListener('pointerenter', () => clearTimeout(timer)); t.addEventListener('pointerleave', arm);
  t.addEventListener('focusin', () => clearTimeout(timer)); t.addEventListener('focusout', arm);
  arm(); return { dismiss };
}

// ---- the save (one commit)
const postsFor = (p, fresh) => { const o = {}; let n = p ? p.items.length : 0; for (const k of fresh) { n++; const c = repClip(k, state.clips); if (c) o[k] = newItemPost(p, c, n); } return o; };
// opts.replace = { added, created } of the save being changed: it is undone and the new choice applied in the SAME commit.
export async function saveAdd({ keys, targets, excl, replace = null, opener = null }) {
  if (!canEditPl()) { toast(RO_HINT + '.'); return null; }
  const now = new Date().toISOString(), keep = new Set(targets.map(t => t.id));
  const undo = replace ? undoOps(replace.added, (replace.created || []).filter(id => !keep.has(id))) : [];
  let base = state.playlists; for (const o of undo) { try { base = applyPlaylistOp(base, o, now).doc; } catch { /* the server decides */ } }
  const plan = planAdd(base, targets, keys, excl, state.clips, postsFor), ops = [...undo, ...plan.ops];
  const ids = targets.map(t => t.id);
  if (ops.length) { const r = await plAct({ type: 'multi', ops }); if (!r) return null; }
  writePlPref({ last: ids, excl: [...excl] });
  const names = targets.map(t => (t.create ? t.create.title : state.playlists.playlists.find(p => p.id === t.id)?.title) || 'playlist');
  const combos = unionCombos(keys, state.clips).filter(k => !excl.includes(k)), vt = versionsText(combos);
  const msg = plan.total ? `Added ${plural(plan.total, 'clip')}${vt ? ` (${vt})` : ''} to ${names.join(', ')}` : `Already in ${names.join(', ')}`;
  announce(msg);
  const added = plan.added, created = [...(replace?.created || []).filter(id => keep.has(id)), ...plan.created];
  const lastSave = { keys, ids, excl, added, created };
  plToast(msg, [
    { id: 'change', label: 'Change', run: () => openAddToPlaylist(keys, null, opener, { initial: { ids, excl }, replace: { added, created } }) },
    ...(plan.total || created.length ? [{ id: 'undo', label: 'Undo', run: () => undoSave(lastSave) }] : []),
  ]);
  refreshControls();
  return { plan, ...lastSave };
}
async function undoSave(s) {
  const ops = undoOps(s.added, s.created); if (!ops.length) return;
  const r = await plAct({ type: 'multi', ops }); if (r) { plToast('Undone'); announce('Undone'); }
}

// ---- the popup
export function openAddToPlaylist(keys, label, opener, { initial = null, replace = null } = {}) {
  ensureCss();
  keys = [...new Set(keys)]; if (!keys.length) { toast('Nothing to add.'); return null; }
  const pref = readPlPref(), excl = new Set(initial ? initial.excl : pref.excl), ticked = new Set(initial?.ids || []), pending = [];
  const m = createModal({ title: replace ? 'Change playlists' : 'Add to playlist', desc: label || plural(keys.length, 'moment'), cls: 'pl-modal pl-add' });
  const combos = unionCombos(keys, state.clips);
  const baseDoc = () => { let d = state.playlists; if (replace) for (const o of undoOps(replace.added)) { try { d = applyPlaylistOp(d, o, new Date().toISOString()).doc; } catch { /* ignore */ } } return d; };
  const list = h('ul', { class: 'pl-pick', 'aria-label': 'Playlists' }), err = h('p', { class: 'field-err', role: 'alert' });
  const nameIn = h('input', { type: 'text', id: 'pl-new-name', maxlength: 120, placeholder: 'New playlist name', 'aria-label': 'New playlist name' });
  const saveB = btn('Save', { kind: 'primary', cls: 'pl-save', on: () => save() });
  const rowOf = (p, items, isNew) => {
    const have = new Set(items), n = keys.filter(k => have.has(k)).length, allIn = !isNew && n === keys.length;
    const cb = h('input', { type: 'checkbox', checked: allIn || ticked.has(p.id), disabled: allIn, 'data-pl': p.id, 'aria-label': p.title });
    cb.addEventListener('change', () => { if (cb.checked) ticked.add(p.id); else ticked.delete(p.id); sync(); });
    const stat = isNew ? 'New' : allIn ? 'Already in' : n ? `${n} of ${keys.length} already in` : '';
    return h('li', null, h('label', { class: 'pl-pick-row' + (allIn ? ' in' : '') }, cb,
      h('span', { class: 'pl-pick-t' }, h('b', { text: p.title }), h('small', { text: `${plural(isNew ? 0 : p.items.length, 'item')}${stat ? ' · ' + stat : ''}` }))));
  };
  const sync = () => {
    const doc = baseDoc(); list.querySelectorAll('input[data-pl]').forEach(cb => { cb.checked = cb.disabled || ticked.has(cb.dataset.pl); });
    saveB.disabled = !canEditPl() || !(ticked.size && [...ticked].some(id => pending.some(x => x.id === id) || !(keys.every(k => (doc.playlists.find(p => p.id === id)?.items || []).some(i => i.moment_id === k)))));
  };
  const paint = () => {
    const doc = baseDoc();
    list.replaceChildren(...[...pending.map(p => rowOf({ ...p, items: [] }, [], true)), ...doc.playlists.map(p => rowOf(p, p.items.map(i => i.moment_id), false))]);
    if (!list.children.length) list.append(h('li', { class: 'muted', text: 'No playlists yet. Create one above.' }));
    sync();
  };
  const create = () => {
    const title = nameIn.value.trim(); err.textContent = '';
    if (!title) { err.textContent = 'Give the playlist a name.'; nameIn.focus(); return; }
    const p = { id: newId('pl'), title }; pending.unshift(p); ticked.add(p.id); nameIn.value = ''; paint(); announce(`${title} created and ticked`);
    list.querySelector(`input[data-pl="${p.id}"]`)?.focus();
  };
  async function save() {
    if (saveB.disabled) return; saveB.disabled = true; err.textContent = '';
    const targets = [...ticked].map(id => { const pn = pending.find(x => x.id === id); return pn ? { id, create: { title: pn.title } } : { id }; });
    const r = await saveAdd({ keys, targets, excl: [...excl], replace, opener });
    if (r) m.close(true); else sync();
  }
  const createRow = h('form', { class: 'pl-newrow pl-create', 'aria-label': 'Create new playlist', on: { submit: e => { e.preventDefault(); create(); } } },
    h('b', { class: 'pl-create-t', text: 'Create new playlist' }), h('div', { class: 'pl-create-f' }, nameIn, btn('Create', { type: 'submit', kind: 'ghost', cls: 'sm pl-create-b' })));
  const chips = combos.length > 1 ? h('div', { class: 'pl-vers', role: 'group', 'aria-label': 'Versions to add' }, h('span', { class: 'pl-vers-t', text: 'Versions' }),
    ...combos.map(k => { const b = h('button', { type: 'button', class: 'pl-vchip', 'data-v': k, 'aria-pressed': String(!excl.has(k)), text: comboLabel(k, combos.some(x => x.endsWith('|1'))) });
      b.addEventListener('click', () => { const on_ = excl.has(k); if (!on_ && combos.filter(x => !excl.has(x)).length <= 1) { err.textContent = 'Keep at least one version.'; return; } err.textContent = ''; if (on_) excl.delete(k); else excl.add(k); b.setAttribute('aria-pressed', String(on_)); });
      return b; })) : null;
  if (!canEditPl()) m.body.append(h('p', { class: 'pl-ro', text: RO_HINT + '.' }));
  else m.body.append(createRow, list, chips, err);
  paint();
  m.foot.append(btn('Open playlists', { kind: 'ghost', on: () => { m.close(true); location.hash = '#/playlists'; } }), btn('Cancel', { on: () => m.close(false) }), saveB);
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(canEditPl() ? nameIn : undefined);
  return m;
}

// ---- quick re-save: the last chosen playlists (per viewer), one tap
export const lastTargets = () => liveTargets(state.playlists, readPlPref().last);
export function quickAdd(keys, label, opener) {
  const t = lastTargets();
  if (!t.length || !canEditPl()) return openAddToPlaylist(keys, label, opener);
  return saveAdd({ keys, targets: t.map(p => ({ id: p.id })), excl: readPlPref().excl, opener });
}
const controls = new Set();
function refreshControls() { for (const c of controls) { if (!c.el.isConnected) { controls.delete(c); continue; } c.paint(); } }
on('clips', refreshControls);
// A split button: the main part saves to the last playlists (or opens the popup when there are none yet), the chevron / long-press opens the full popup.
export function addControl(getKeys, getLabel, { cls = '', main = 'pi-add', more = 'pi-add-more', short = false } = {}) {
  const mainB = btn('Add to playlist', { ic: 'plus', cls: `sm ${main}` }), moreB = btn('', { ic: 'chevd', cls: `icon ${more}`, aria: 'Add to other playlists...', title: 'Add to other playlists...' });
  const lbl = mainB.querySelector('.lbl');
  const el = h('span', { class: `pl-split ${cls}`, role: 'group', 'aria-label': 'Add to playlist' }, mainB, moreB);
  let timer = null, fired = false;
  const full = () => openAddToPlaylist(getKeys(), getLabel?.(), moreB);
  mainB.addEventListener('pointerdown', () => { fired = false; clearTimeout(timer); timer = setTimeout(() => { fired = true; full(); }, 550); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) mainB.addEventListener(ev, () => clearTimeout(timer));
  mainB.addEventListener('contextmenu', e => e.preventDefault());
  mainB.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (fired) { fired = false; return; } quickAdd(getKeys(), getLabel?.(), mainB); });
  moreB.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); full(); });
  const paint = () => {
    const t = lastTargets(), txt = t.length && canEditPl() ? (short ? 'Add to ' : 'Quick add to ') + targetsText(t) : 'Add to playlist';
    lbl.textContent = txt; mainB.setAttribute('aria-label', t.length && canEditPl() ? `Quick add to ${targetsText(t)}` : 'Add to playlist'); mainB.dataset.quick = t.length ? '1' : '';
  };
  const c = { el, paint }; controls.add(c); paint();
  return el;
}
// Entries for a "..." menu (card sheet, stream menu): same popup everywhere.
export function menuEntries(getKeys, getLabel, opener) {
  const t = lastTargets(), out = [];
  if (t.length && canEditPl()) out.push({ id: 'quick-add', label: `Quick add to ${targetsText(t)}`, run: () => quickAdd(getKeys(), getLabel?.(), opener) });
  out.push({ id: 'add-playlist', label: t.length && canEditPl() ? 'Add to other playlists...' : 'Add to playlist', run: () => openAddToPlaylist(getKeys(), getLabel?.(), opener) });
  return out;
}
export const addShortlistedToPlaylist = opener => openAddToPlaylist([...liveKeys(state.shortlist, state.clips)], 'All shortlisted moments', opener);

// ---- a stream: ALL its moments (filters ignored; trashed and deleted clips are not in state.clips)
export const streamMomentKeys = id => streamKeys(id, state.clips);
export function openStreamMenu(f, opener) {
  ensureCss();
  const keys = () => streamMomentKeys(f.id), label = `All ${plural(keys().length, 'moment')} of ${f.title}`;
  const m = createModal({ title: f.title, cls: 'sheet' }); m.foot.hidden = true;
  const list = h('ul', { class: 'sheet-list' });
  for (const e of menuEntries(keys, () => label, opener)) {
    const b = h('button', { type: 'button', class: 'sheet-act', 'data-act': e.id }, icon('plus'), h('span', { text: e.label }));
    b.addEventListener('click', () => { m.close(true); setTimeout(() => { try { e.run(); } catch (x) { console.error(x); } }, 0); }); list.append(h('li', null, b));
  }
  m.body.append(list);
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(list.querySelector('button')); return m;
}
