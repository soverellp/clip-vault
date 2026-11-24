// "Posted on" control (D53): ONE row of 5 toggle chips per moment (cards in Post info view, clip detail, Post mode, playlist items). No playlist and no admin mode needed.
// Stored in _config/posted.json (see posted.js). One tap toggles at once (optimistic), a non-blocking toast offers Undo; the small details button sets date and link.
// Everything is built with textContent (dom.js h()); user text never becomes HTML.
import { state, emit, on, canWrite } from './state.js';
import { h, icon, btn } from './dom.js';
import * as api from './api.js';
import { createModal, announce } from './a11y.js';
import { toast } from './toast.js';
import { momentKey } from './shortlist.js';
import { titleOf } from './fmt.js';
import { PO_PLATFORMS, PO_LABEL, mergedPosted, applyPostedOp, removalPlan, validDate, validLink, todayYmd } from './posted.js';
import { setPostedDoc } from './data.js';
import { ensureCss, canEditPl, roMsg, errText, plAct } from './plui.js';
import { plToast } from './pladd.js';
import { save as saveClipFields } from './kit.js';

const SRC_LABEL = { index: 'admin details', playlist: 'playlist', posted: 'posted' };
export const mergedFor = c => { const cl = state.clips.find(x => x.id === c?.id) || c; return mergedPosted(momentKey(cl), { indexOn: cl?.posted_on, doc: state.postedDoc, playlists: state.playlists }); };

// ---- the write: optimistic local change, then ONE queued commit of posted.json; a failure reloads the real file
let queue = Promise.resolve(), pending = 0;
// The library redraws its grid on every 'clips' event, which drops keyboard focus: put it back on the chip that had it.
const keepFocus = fn => { const ae = document.activeElement, keep = ae?.closest?.('.po-ctl') ? ae : null; fn(); if (keep?.isConnected && document.activeElement !== keep) keep.focus({ preventScroll: true }); };
export function commitPosted(op) {
  let next; try { next = applyPostedOp(state.postedDoc, op).doc; } catch { toast('That could not be saved.', { kind: 'error' }); return Promise.resolve(false); }
  const prev = state.postedDoc; keepFocus(() => { setPostedDoc(next); emit('clips'); }); pending++;
  const run = queue.then(async () => {
    try { await api.updatePosted(op); state.pdExists = true; return true; }
    catch (e) {
      toast(errText(e), { kind: 'error' }); api.invalidateSnapshot?.();
      try { const r = await api.listPosted(); if (r?.doc) setPostedDoc(r.doc); else setPostedDoc(prev); } catch { setPostedDoc(prev); }
      return false;
    } finally { pending--; keepFocus(() => emit('clips')); }
  });
  queue = run.catch(() => {}); return run;
}

// ---- toggle
export async function togglePosted(c, pk, opener) {
  if (!canEditPl()) { toast(roMsg()); return false; }
  const cur = mergedFor(c)[pk];
  const r = await (cur ? markOff(c, pk, cur) : markOn(c, pk, opener));
  if (opener?.isConnected && document.activeElement === document.body) opener.focus({ preventScroll: true });
  return r;
}
async function markOn(c, pk, opener) {
  const key = momentKey(c), L = PO_LABEL[pk], msg = `Marked posted on ${L}`;
  const p = commitPosted({ type: 'set', moment_id: key, platform: pk, date: todayYmd(), link: '' });
  announce(msg);
  const t = plToast(msg, [{ id: 'undo', label: 'Undo', run: () => commitPosted({ type: 'unset', moment_id: key, platform: pk }) }, { id: 'details', label: 'Details', run: () => openPostedDetails(c, pk, opener) }]);
  if (!(await p)) t?.dismiss();
  return true;
}
async function markOff(c, pk, cur) {
  const key = momentKey(c), L = PO_LABEL[pk], plan = removalPlan(mergedFor(c), key, pk, state.playlists, { admin: canWrite() });
  if (!plan.unset && !plan.playlistOps.length && plan.index !== 'remove') {
    plToast(`${L} was marked posted by an admin in the clip details. Only an admin can remove it.`); return false;
  }
  const jobs = [];
  if (plan.unset) jobs.push(commitPosted({ type: 'unset', moment_id: key, platform: pk }));
  if (plan.playlistOps.length) jobs.push(plAct({ type: 'multi', ops: plan.playlistOps }));
  if (plan.index === 'remove') for (const cl of state.clips) if (momentKey(cl) === key && Array.isArray(cl.posted_on) && cl.posted_on.includes(pk)) jobs.push(saveClipFields(cl, { posted_on: cl.posted_on.filter(x => x !== pk) }, 'the posting status'));
  const msg = plan.full ? `Removed from ${L}` : `Removed what you can. ${L} is still shown as posted: an admin set it in the clip details, only an admin can remove that.`;
  announce(msg);
  const prev = { date: cur.date || todayYmd(), link: cur.link || '' };
  plToast(msg, plan.full ? [{ id: 'undo', label: 'Undo', run: () => commitPosted({ type: 'set', moment_id: key, platform: pk, ...prev }) }] : []);
  await Promise.all(jobs);
  return true;
}

// ---- details: date (default today) and an optional https link
export function openPostedDetails(c, pk, opener) {
  ensureCss();
  if (!canEditPl()) { toast(roMsg()); return null; }
  const key = momentKey(c), L = PO_LABEL[pk], cur = mergedFor(c)[pk];
  const m = createModal({ title: `Posted on ${L}`, desc: titleOf(c), cls: 'pl-modal' });
  const date = h('input', { type: 'date', id: 'po-date', value: cur?.date || todayYmd(), 'aria-label': 'Date posted' });
  const link = h('input', { type: 'text', id: 'po-link', placeholder: 'https:// link to the post (optional)', maxlength: 500, inputmode: 'url', autocomplete: 'off', 'aria-label': 'Link to the post', value: cur?.link || '' });
  const err = h('p', { class: 'field-err', role: 'alert' });
  const go = () => {
    err.textContent = '';
    if (!validDate(date.value)) { err.textContent = 'Pick the date it was posted.'; date.focus(); return; }
    const l = link.value.trim(); if (!validLink(l)) { err.textContent = 'The link must start with https:// and have no spaces.'; link.focus(); return; }
    commitPosted({ type: 'set', moment_id: key, platform: pk, date: date.value, link: l }); announce('Details saved'); plToast('Details saved'); m.close(true);
  };
  m.body.append(h('form', { class: 'pl-form', on: { submit: e => { e.preventDefault(); go(); } } }, h('label', null, h('span', { text: 'Date' }), date), h('label', null, h('span', { text: 'Link' }), link), err));
  m.foot.append(btn('Cancel', { on: () => m.close(false) }), btn('Save', { kind: 'primary', ic: 'check', on: go }));
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(date); return m;
}

// ---- the control
const controls = new Set();
on('clips', () => { for (const x of [...controls]) { if (!x.el.isConnected && controls.size > 40) controls.delete(x); else x.paint(); } });
export function postedControl(c, { cls = '' } = {}) {
  ensureCss();
  const el = h('div', { class: `po-ctl ${cls}`.trim(), role: 'group', 'aria-label': 'Posted on', 'data-k': momentKey(c) });
  const hint = h('p', { class: 'po-else', hidden: true }), row = h('div', { class: 'po-row' }), parts = {};
  for (const k of PO_PLATFORMS) {
    const chip = h('button', { type: 'button', class: 'po-chip', 'data-p': k, 'aria-pressed': 'false' });
    const det = h('button', { type: 'button', class: 'po-det', 'data-p': k, hidden: true }, icon('edit'));
    chip.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); togglePosted(c, k, chip); });
    det.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openPostedDetails(c, k, det); });
    parts[k] = { chip, det }; row.append(h('span', { class: 'po-item', 'data-p': k }, chip, det));
  }
  el.append(row, hint);
  const paint = () => {
    const m = mergedFor(c), ro = !canEditPl(), else_ = [];
    for (const k of PO_PLATFORMS) {
      const { chip, det } = parts[k], L = PO_LABEL[k], v = m[k], on_ = !!v;
      if (chip.getAttribute('aria-pressed') !== String(on_) || !chip.firstChild) chip.replaceChildren(...(on_ ? [icon('check')] : []), h('span', { text: L }));
      chip.setAttribute('aria-pressed', String(on_)); chip.classList.toggle('on', on_); chip.setAttribute('aria-disabled', String(ro));
      chip.setAttribute('aria-label', on_ ? `${L}: posted. Tap to unmark.` : `${L}: not posted. Tap to mark as posted.`);
      chip.title = on_ ? `Posted on ${L}${v.date ? ' on ' + v.date : ''}` : `Mark as posted on ${L}`;
      det.hidden = !on_ || ro; det.setAttribute('aria-label', `${L}: set post date and link`); det.title = 'Post date and link';
      if (on_ && v.sources.some(s => s !== 'posted')) else_.push(`${L} (${v.sources.filter(s => s !== 'posted').map(s => SRC_LABEL[s]).join(', ')})`);
    }
    hint.hidden = !else_.length; hint.textContent = else_.length ? 'Also set elsewhere: ' + else_.join(', ') : '';
  };
  const x = { el, paint }; controls.add(x); paint();
  el.chipBtn = k => parts[k]?.chip;
  return el;
}

// A small popup with the control, for the card "..." menu.
export function openPostedModal(c, opener) {
  ensureCss();
  const m = createModal({ title: 'Posted on', desc: titleOf(c), cls: 'pl-modal' });
  const ctl = postedControl(c); m.body.append(ctl); m.foot.append(btn('Close', { on: () => m.close(true) }));
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(ctl.chipBtn('youtube')); return m;
}
