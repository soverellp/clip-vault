import { state, on, emit, canWrite, isAdmin, findClip, replaceClip, removeClip } from './state.js';
import { h, btn, icon } from './dom.js';
import * as api from './api.js';
import { toast } from './toast.js';
import { createModal, haptic, shake, announce } from './a11y.js';
import { titleOf, norm, postedOnOf, PLATFORMS } from './fmt.js';
import { exact, timeEl } from './time.js';
import { loadAll } from './data.js';

let draft = null;
export const peekDraft = id => (draft && draft.id === id ? draft : null);
export const takeDraft = id => { const d = draft && draft.id === id ? draft : null; if (d) draft = null; return d; };

function fail(err, what) { if (err.status === 401) return; toast(api.errorText(err, what), { kind: 'error' }); }

// ---------- confirmation dialog (accessible: aria-modal, Esc cancels, focus starts on Cancel) ----------
export function confirmDialog({ title, desc, thumb, name, bullets, confirmLabel, danger = true, typed, check, run }) {
  const m = createModal({ title, desc, danger, cls: 'confirm' });
  if (thumb !== undefined || name) {
    const t = h('div', { class: 'conf-clip' }, thumb ? h('img', { src: thumb, alt: '' }) : h('span', { class: 'ph-ic' }, icon('film')), h('strong', { lang: 'hi-Latn', text: name || '' }));
    m.body.append(t);
  }
  if (bullets) m.body.append(h('ul', { class: 'conf-list' }, ...bullets.map(b => h('li', { text: b }))));
  let input = null, chk = null;
  const err = h('p', { class: 'form-err', role: 'alert' });
  if (check) { chk = h('input', { type: 'checkbox', id: 'cx' + Math.random().toString(36).slice(2, 6), checked: check.checked }); m.body.append(h('label', { class: 'check-row' }, chk, h('span', { text: check.label }))); }
  if (typed) {
    input = h('input', { type: 'text', class: 'typed', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': typed.label, 'aria-describedby': 'typedhint' });
    m.body.append(h('label', { class: 'typed-l' }, h('span', { id: 'typedhint', text: typed.label }), h('code', { class: 'expect', text: typed.expected }), input));
  }
  m.body.append(err);
  const cancel = btn('Cancel', { kind: 'ghost', on: () => m.close(false) }); cancel.id = 'confirm-cancel';
  const ok = btn(confirmLabel, { kind: danger ? 'danger' : 'primary', disabled: !!typed }); ok.id = 'confirm-ok';
  const okWrap = h('span', { class: 'ok-wrap' }, ok);
  m.foot.append(cancel, okWrap);
  const match = () => !typed || input.value === typed.expected;
  if (typed) {
    input.addEventListener('input', () => {
      const good = match(); ok.disabled = !good; input.setAttribute('aria-invalid', String(!good && input.value.length > 0));
      if (!good && input.value.length >= typed.expected.length) shake(m.dialog);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (match()) ok.click(); else shake(m.dialog); } });
    okWrap.addEventListener('click', () => { if (ok.disabled) shake(m.dialog); });
  }
  let busy = false;
  ok.addEventListener('click', async () => {
    if (busy || !match()) return;
    busy = true; ok.disabled = true; cancel.disabled = true; err.textContent = ''; m.dialog.classList.add('busy');
    haptic(danger ? [30, 40, 30] : 20);
    try { await run({ all: chk?.checked }); m.close(true); }
    catch (e) {
      busy = false; ok.disabled = !match(); cancel.disabled = false; m.dialog.classList.remove('busy');
      if (e.status === 401) { m.close(false); return; }
      err.textContent = api.errorText(e, 'That clip');
    }
  });
  m.open(cancel);
  return m.done.then(r => r === true);
}

const thumbOf = (c, trashed) => (c?.poster ? api.directMediaUrl(c.poster, { trashed }) : null);

// ---------- actions ----------
async function trashIds(ids, from) {
  const clips = ids.map(findClip).filter(Boolean); if (!clips.length) return;
  const one = clips.length === 1 ? clips[0] : null;
  const done = []; 
  const ok = await confirmDialog({
    title: one ? 'Move this clip to Trash?' : `Move ${clips.length} clips to Trash?`,
    desc: 'Nothing is erased yet.',
    thumb: one ? thumbOf(one) : undefined, name: one ? titleOf(one) : `${clips.length} selected clips`,
    bullets: ['The clip disappears from the library.', 'Restorable for 30 days, then it is purged for good.'],
    confirmLabel: one ? 'Move to Trash' : `Move ${clips.length} to Trash`, danger: false,
    run: async () => { for (const c of clips) { await api.trashClip(c.id); done.push(c.id); } },
  }).catch(() => false);
  if (done.length) {
    if (state.selecting) { state.selecting = false; state.selected.clear(); emit('selection'); }
    if (from === 'drawer' || location.hash.includes('/clip/')) location.hash = '#/';
    await loadAll();
    toast(done.length === 1 ? 'Moved to Trash.' : `Moved ${done.length} clips to Trash.`, { kind: 'success', action: { label: 'Undo', run: () => restoreIds(done, 'undo') } });
    announce(`${done.length} moved to trash`);
  }
}
async function restoreIds(ids, from) {
  const run = async () => { let n = 0; for (const id of ids) { await api.restoreClip(id); n++; } return n; };
  try {
    if (ids.length > 1) {
      const ok = await confirmDialog({ title: `Restore ${ids.length} clips?`, desc: 'They go back to the library.', name: `${ids.length} selected clips`, confirmLabel: `Restore ${ids.length}`, danger: false, run });
      if (!ok) return;
    } else await run();
    if (state.selecting) { state.selecting = false; state.selected.clear(); emit('selection'); }
    if (from === 'drawer' && location.hash.includes('/clip/')) location.hash = '#/trash';
    await loadAll();
    toast(ids.length === 1 ? 'Restored to the library.' : `Restored ${ids.length} clips.`, { kind: 'success' }); haptic(15);
  } catch (e) { fail(e, 'That clip'); await loadAll(); }
}
async function purgeOne(id, from) {
  const c = findClip(id); if (!c) return;
  const title = titleOf(c);
  const ok = await confirmDialog({
    title: 'Delete forever?', desc: 'This cannot be undone. The video file and its poster are erased.', thumb: thumbOf(c, true), name: title,
    confirmLabel: 'Delete forever', typed: { label: 'Type the exact clip title to confirm:', expected: title },
    run: () => api.deleteClip(id, title),
  });
  if (ok) { removeClip(id); if (from === 'drawer' || location.hash.includes('/clip/')) location.hash = '#/trash'; await loadAll(); toast('Deleted forever.', { kind: 'success' }); haptic([30, 40, 30]); }
}
async function emptyTrash() {
  const n = state.trash.length;
  const ok = await confirmDialog({
    title: 'Empty the trash?', desc: n ? `${n} ${n === 1 ? 'clip is' : 'clips are'} in the trash. This cannot be undone.` : 'The trash has nothing in it right now.',
    bullets: ['Videos and posters are erased for good.'], confirmLabel: 'Empty trash',
    check: { label: 'Also delete clips that are still inside their 30-day window', checked: true },
    typed: { label: 'Type EMPTY TRASH to confirm:', expected: 'EMPTY TRASH' },
    run: ({ all }) => api.emptyTrash({ all }),
  });
  if (ok) { await loadAll(); toast('Trash emptied.', { kind: 'success' }); haptic([30, 40, 30]); }
}
export function initActions() {
  on('act', a => {
    if (!canWrite()) { toast('The vault is read-only for your account right now.', { kind: 'error' }); return; }
    if (a.type === 'trash') trashIds(a.ids, a.from); else if (a.type === 'restore') restoreIds(a.ids, a.from);
    else if (a.type === 'purge') purgeOne(a.id, a.from); else if (a.type === 'empty') emptyTrash();
  });
}

// ---------- bulk bar ----------
let bar;
export function initBulkBar() {
  const label = h('span', { class: 'bulk-n', 'aria-live': 'polite' });
  const all = btn('Select all', { kind: 'ghost', cls: 'sm', on: () => { import('./library.js').then(L => { for (const id of (state.view === 'library' ? L.shownIds() : L.visible().map(c => c.id))) state.selected.add(id); emit('selection'); L.refreshSel(); }); } });
  const go = btn('', { kind: 'danger', cls: 'sm' }); go.id = 'bulk-go';
  const x = btn('Cancel', { kind: 'ghost', cls: 'sm', on: () => { state.selecting = false; state.selected.clear(); emit('selection'); emit('clips'); } });
  go.addEventListener('click', () => { const ids = [...state.selected]; if (!ids.length) return; emit('act', { type: state.view === 'trash' ? 'restore' : 'trash', ids }); });
  bar = h('div', { class: 'bulkbar', hidden: true, role: 'region', 'aria-label': 'Bulk actions' }, label, all, go, x);
  document.body.append(bar);
  const upd = () => {
    const show = state.selecting && canWrite() && state.view !== 'audit';
    bar.hidden = !show; if (!show) return;
    const n = state.selected.size; label.textContent = `${n} selected`;
    const trash = state.view === 'trash';
    go.disabled = !n; go.querySelector('.lbl') ? (go.querySelector('.lbl').textContent = trash ? 'Restore' : 'Move to Trash') : go.append(h('span', { class: 'lbl', text: trash ? 'Restore' : 'Move to Trash' }));
    go.classList.toggle('danger', !trash); go.classList.toggle('primary', trash);
  };
  on('selection', upd); on('view', upd);
}

// ---------- edit form with dirty tracking and optimistic save ----------
const splitTags = s => s.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean);
export function editForm(clip, { close }) {
  const d = draft && draft.id === clip.id ? draft : null; draft = null;
  const init = { title: clip.title || '', hook: clip.hook || '', desc: clip.desc || '', post: clip.post || '', stream: clip.stream || '', tags: (clip.tags || []).join(', ') };
  // Library fields (reaction, kind, tier, why): only offered when the backend can store them (static mode, me().capabilities.moments).
  const moments = state.me?.capabilities?.moments === true;
  const MKEYS = ['reaction', 'kind', 'tier', 'why'];
  if (moments) { for (const k of MKEYS) init[k] = clip[k] == null ? '' : String(clip[k]); init.posted_on = postedOnOf(clip).join(','); }
  const sibling = moments && clip.group ? state.clips.find(x => x.id !== clip.id && x.group === clip.group && (x.stream || '') === (clip.stream || '')) : null;
  const cur = { ...init, ...(d?.vals || {}) };
  const mk = (key, label, type, opts = {}) => {
    const id = 'ef-' + key;
    const el = type === 'select' ? h('select', { id }, ...opts.options.map(([v, l]) => h('option', { value: v, text: l }))) : type === 'textarea' ? h('textarea', { id, rows: opts.rows || 3, maxlength: opts.max }) : h('input', { id, type: 'text', maxlength: opts.max, list: opts.list, autocomplete: 'off' });
    el.value = cur[key]; el.dataset.key = key;
    const e = h('p', { class: 'field-err', id: id + '-e', role: 'alert' });
    el.setAttribute('aria-describedby', id + '-e');
    return { el, e, wrap: h('div', { class: 'field' }, h('label', { for: id, text: label }), el, e) };
  };
  const streams = [...new Set(state.clips.map(c => c.stream).filter(Boolean))];
  const dl = h('datalist', { id: 'stream-list' }, ...streams.map(s => h('option', { value: s })));
  const F = { title: mk('title', 'Title', 'input', { max: 200 }), hook: mk('hook', 'Hook', 'input', { max: 300 }), desc: mk('desc', 'Description', 'textarea', { max: 5000 }), post: mk('post', 'Post kit text', 'textarea', { rows: 6, max: 20000 }), stream: mk('stream', 'Stream', 'input', { max: 120, list: 'stream-list' }), tags: mk('tags', 'Tags (comma separated)', 'input', { max: 600 }) };
  if (moments) {
    const sel = (key, label, vals) => mk(key, label, 'select', { options: [['', 'Not set'], ...vals.map(v => [v, v])] });
    F.reaction = sel('reaction', 'Streamer reaction', ['strong', 'mild', 'none', 'unrated']); F.kind = sel('kind', 'Category', ['reaction', 'game']); F.tier = sel('tier', 'Tier (A = best)', ['A', 'B', 'C']);
    F.why = mk('why', 'Why (one line)', 'input', { max: 300 });
    // Posted on: one checkbox per platform; the field's value is the comma list of checked keys, so the dirty check and draft restore work like the text fields.
    const boxes = PLATFORMS.map(([k, l]) => { const cb = h('input', { type: 'checkbox', id: 'ef-po-' + k, value: k }); return { k, cb, lab: h('label', { class: 'check-row', for: 'ef-po-' + k }, cb, h('span', { text: l })) }; });
    const grp = h('div', { id: 'ef-posted_on', class: 'po-checks', role: 'group', 'aria-label': 'Posted on' }, ...boxes.map(b => b.lab));
    Object.defineProperty(grp, 'value', { get: () => boxes.filter(b => b.cb.checked).map(b => b.k).join(','), set: v => { const on = String(v || '').split(','); for (const b of boxes) b.cb.checked = on.includes(b.k); } });
    grp.value = cur.posted_on; grp.dataset.key = 'posted_on';
    const pe = h('p', { class: 'field-err', id: 'ef-posted_on-e', role: 'alert' });
    F.posted_on = { el: grp, e: pe, wrap: h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Posted on' }), grp, pe) };
  }
  const both = sibling ? h('input', { type: 'checkbox', id: 'ef-both', checked: true }) : null;
  const form = h('form', { class: 'edit', novalidate: '', 'aria-label': 'Edit clip' }, dl, ...Object.values(F).map(f => f.wrap), both ? h('label', { class: 'check-row' }, both, h('span', { text: 'Apply reaction, category, tier, why and posted on to both versions' })) : null);
  const status = h('p', { class: 'form-err', role: 'alert' }), dirtyNote = h('span', { class: 'dirty', text: '' });
  if (d?.error) status.textContent = d.error;
  const save = btn('Save changes', { kind: 'primary', type: 'submit' }), cancel = btn('Cancel', { kind: 'ghost', on: () => { if (dirty()) discard(); else close(); } });
  save.id = 'ef-save'; cancel.id = 'ef-cancel';
  form.append(status, h('div', { class: 'row end' }, dirtyNote, cancel, save));
  const vals = () => Object.fromEntries(Object.entries(F).map(([k, f]) => [k, f.el.value]));
  const dirty = () => { const v = vals(); return Object.keys(init).some(k => v[k] !== init[k]); };
  const validate = () => {
    const v = vals(); const errs = {};
    if (!v.title.trim()) errs.title = 'A title is required.';
    const t = splitTags(v.tags); if (t.length > 30) errs.tags = 'At most 30 tags.'; else if (t.some(x => x.length > 40)) errs.tags = 'Each tag must be 40 characters or fewer.';
    for (const [k, f] of Object.entries(F)) { f.e.textContent = errs[k] || ''; f.el.setAttribute('aria-invalid', String(!!errs[k])); }
    return Object.keys(errs).length === 0;
  };
  const sync = () => { const dd = dirty(); validate(); save.disabled = !dd; dirtyNote.textContent = dd ? 'Unsaved changes' : ''; form.classList.toggle('dirty', dd); };
  form.addEventListener('input', sync); sync();
  function discard() {
    const m = confirmDialog({ title: 'Discard changes?', desc: 'Your edits to this clip have not been saved.', confirmLabel: 'Discard', danger: true, run: async () => {} });
    m.then(ok => { if (ok) { for (const [k, f] of Object.entries(F)) f.el.value = init[k]; sync(); close(); } });
  }
  form.addEventListener('keydown', e => { if (e.key === 'Escape' && dirty()) { e.stopPropagation(); } });
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (!validate() || !dirty()) return;
    const v = vals(), body = { title: v.title.trim(), hook: v.hook.trim(), desc: v.desc, post: v.post, stream: v.stream.trim(), tags: splitTags(v.tags) };
    const mbody = {}; if (moments) { for (const k of MKEYS) if (v[k] !== init[k]) mbody[k] = v[k]; if (v.posted_on !== init.posted_on) mbody.posted_on = v.posted_on ? v.posted_on.split(',') : []; }
    Object.assign(body, mbody);
    const before = clip, next = { ...clip, ...body };
    replaceClip(next); emit('clips'); draft = null;   // optimistic
    toast('Saving…', { timeout: 1200 });
    try {
      const res = await api.patchClip(clip.id, body);
      if (sibling && both?.checked && Object.keys(mbody).length) { const r2 = await api.patchClip(sibling.id, mbody); if (r2?.clip) replaceClip(r2.clip); }
      if (res?.clip) { replaceClip(res.clip); } else { replaceClip({ ...next, updated_at: new Date().toISOString() }); }
      emit('clips'); toast('Saved.', { kind: 'success' }); haptic(12);
    } catch (err) {
      replaceClip(before); draft = { id: clip.id, vals: v, error: api.errorText(err, 'That clip') }; emit('clips');
      fail(err, 'That clip');
    }
  });
  return form;
}

// ---------- audit log ----------
export async function renderAudit(root) {
  root.replaceChildren(h('div', { class: 'view-head' }, h('h2', { text: 'Audit log' }), h('p', { class: 'muted', text: 'Who changed what, newest first. Times are in your timezone.' })), h('div', { class: 'skel-lines' }, h('i'), h('i'), h('i')));
  let r;
  try { r = await api.audit(); } catch (e) { root.querySelector('.skel-lines')?.remove(); root.append(h('p', { class: 'form-err', role: 'alert', text: api.errorText(e) })); return; }
  const rows = [...(r?.entries || [])].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  root.querySelector('.skel-lines')?.remove();
  if (!rows.length) { root.append(h('div', { class: 'empty' }, h('img', { class: 'empty-art', src: '/assets/empty-log.svg', alt: '', width: 200, height: 160 }), h('h3', { text: 'No activity yet' }))); return; }
  const det = d => d == null ? '' : typeof d === 'string' ? d : JSON.stringify(d);
  const tbl = h('table', { class: 'audit' }, h('thead', null, h('tr', null, ...['When', 'Who', 'Action', 'Clip', 'Detail'].map(x => h('th', { scope: 'col', text: x })))),
    h('tbody', null, ...rows.map(en => h('tr', null, h('td', { class: 'when', 'data-label': 'When' }, timeEl(en.at)), h('td', { 'data-label': 'Who', text: en.actor_email || '—' }), h('td', { 'data-label': 'Action' }, h('span', { class: 'pill act-' + String(en.action || '').split('_')[0], text: String(en.action || '—') })), h('td', { 'data-label': 'Clip' }, en.clip_id ? h('code', { text: String(en.clip_id) }) : '—'), h('td', { 'data-label': 'Detail', class: 'det', text: det(en.detail) })))));
  root.append(h('div', { class: 'table-wrap' }, tbl));
}
