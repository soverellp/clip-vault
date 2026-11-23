import { state, on, emit, findClip, isAdmin, canWrite, backHash } from './state.js';
import { h, btn, icon } from './dom.js';
import * as api from './api.js';
import { createPlayer } from './player.js';
import { accentFor, accentFromImage, rgbVar, setAurora } from './color.js';
import { timeEl, exact, trashLine, tzName } from './time.js';
import { human, dur, bitrate, scoreText, pretty, titleOf, tagsOf, postedOnOf, platformLabel } from './fmt.js';
import { parsePost, countOf, copyAll } from './post.js';
import { toast } from './toast.js';
import { announce, trapFocus, haptic } from './a11y.js';
import { postInfoBlock, openAddToPlaylist, ensureCss } from './plui.js';
import { momentKey } from './shortlist.js';
import { copyText, shareClip, chips, postedOf, toggleBtn, setNotes, PLATFORMS, NOTES_MAX, startPost, canShortlist, shortlisted, toggleShortlist, SHL_HINT } from './kit.js';
import * as motion from './kit.js';
import { editForm, peekDraft, peekDraft as takeDraftPeek } from './admin.js';

let shlBtn = null, shlClip = null, shlHint = null;
let dlg = null, player = null, clipId = null, closing = false, livePost = null, opening = null;
const BASE = new Set(['posted', 'notes', 'updated_at']);
// Same clip apart from posting fields? Then repaint just those (the video keeps playing, scroll position stays).
const sameBase = (a, b) => !!a && [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => BASE.has(k) || JSON.stringify(a[k]) === JSON.stringify(b[k]));

function row(label, val, extra) {
  return h('div', { class: 'kv' }, h('dt', { text: label }), h('dd', null, val, extra));
}
function copyBtn(get, label) {
  return h('button', { type: 'button', class: 'btn icon ghost sm copy', 'aria-label': label, title: label, on: { click: e => copyText(get(), 'Copied', e.currentTarget) } }, icon('copy'));
}
function whenCell(iso) {
  if (!iso) return '—';
  return h('span', { class: 'when2' }, timeEl(iso), h('small', { class: 'exact', text: exact(iso) }));
}

function details(c, trashed) {
  const sha = c.sha256 ? String(c.sha256) : null;
  const res = c.width && c.height ? `${c.width}x${c.height}` : '—';
  const L = h('dl', { class: 'kvs' });
  L.append(
    row('Title', titleOf(c)), row('ID', h('code', { text: c.id })), row('Stream', pretty(c.stream)), row('Posted on', postedOnOf(c).length ? h('span', { class: 'po-badges' }, ...postedOnOf(c).map(k => h('span', { class: 'po-badge', 'data-p': k, text: platformLabel(k) }))) : 'Not posted'),
    row('Added', whenCell(c.added_at)), row('Updated', whenCell(c.updated_at)));
  if (trashed) L.append(row('Deleted', h('span', { 'data-trashline': '', 'data-trashed': c.trashed_at || '', 'data-purge': c.purge_after || '', text: trashLine(c) })));
  L.append(
    row('Duration', c.dur != null ? `${dur(c.dur)} (${Math.round(c.dur)} s)` : '—'), row('Size', human(c.size)), row('Resolution', res),
    row('Frame rate', c.fps ? `${Math.round(c.fps * 100) / 100} fps` : '—'), row('Codec', c.codec || '—'), row('Bitrate', bitrate(c.bitrate)),
    row('SHA-256', sha ? h('span', { class: 'sha' }, h('code', { title: sha, text: sha.length > 20 ? sha.slice(0, 10) + '…' + sha.slice(-8) : sha }), copyBtn(() => sha, 'Copy SHA-256')) : '—'),
    row('Path in vault', c.video ? h('span', { class: 'sha' }, h('code', { text: c.video }), copyBtn(() => c.video, 'Copy path')) : '—'),
    row('Score', scoreText(c.score) || '—'));
  return h('section', { class: 'card-sec' }, h('h3', { text: 'File details' }), h('p', { class: 'tz', text: 'Times shown in your timezone (' + (tzName() || 'local') + ')' }), L);
}

// Posting tracker: per-platform status (local date-time), optional private notes for admins.
function postingSec(c, trashed) {
  const sec = h('section', { class: 'card-sec posting' }, h('h3', { text: 'Posting' }));
  const rows = h('ul', { class: 'ps-list' });
  let ta = null, save = null, cnt = null, base = '';
  sec.append(rows);
  if (isAdmin() && !trashed) {
    ta = h('textarea', { id: 'notes', class: 'notes-ta', rows: 2, maxlength: NOTES_MAX, spellcheck: 'false', placeholder: 'Private notes (where it went, what to fix)…', 'aria-label': 'Notes' }); ta.readOnly = !canWrite();
    cnt = h('span', { class: 'cnt' }); save = btn('Save notes', { cls: 'sm', kind: 'ghost' }); save.id = 'notes-save'; save.hidden = !canWrite();
    const sync = () => { cnt.textContent = `${ta.value.length} / ${NOTES_MAX}`; save.disabled = ta.value === base; };
    ta.addEventListener('input', sync);
    save.addEventListener('click', async () => { save.disabled = true; const v = ta.value, ok = await setNotes(findClip(c.id) || c, v); if (ok) base = v; sync(); });
    sec.append(h('div', { class: 'pk-field' }, h('div', { class: 'pk-lab' }, h('label', { for: 'notes', text: 'Notes' }), cnt), ta, h('div', { class: 'row end' }, save)));
    ta._sync = sync;
  }
  const update = cl => {
    const p = postedOf(cl);
    rows.replaceChildren(...PLATFORMS.map(pl => h('li', { class: 'ps-row', 'data-platform': pl.key, 'data-posted': p[pl.key] ? '1' : '0' }, h('span', { class: 'pchip ' + pl.cls + (p[pl.key] ? ' on' : '') }, p[pl.key] ? icon('check') : null, h('b', { text: pl.short })), h('span', { class: 'ps-n', text: pl.name }), h('span', { class: 'ps-w', text: p[pl.key] ? 'Posted ' + exact(p[pl.key]) : 'Not posted' }))));
    if (ta && document.activeElement !== ta && ta.value === base) { base = cl.notes || ''; ta.value = base; ta._sync(); }
  };
  if (ta) { base = c.notes || ''; ta.value = base; ta._sync(); }
  update(c);
  return { el: sec, update };
}

// The Shortlist button of the open clip: toggles in admin mode, a read-only status (with the hint) for everyone else. Repainted by refresh().
function paintShl() {
  if (!shlBtn || !shlClip) return;
  const on_ = shortlisted(shlClip), can = canShortlist();
  shlBtn.setAttribute('aria-pressed', String(on_)); shlBtn.classList.toggle('on', on_); shlBtn.setAttribute('aria-disabled', String(!can));
  shlBtn.querySelector('.lbl').textContent = on_ ? 'Shortlisted' : 'Shortlist';
  if (shlHint) shlHint.textContent = can ? '' : (on_ ? 'Shortlisted. ' : 'Not shortlisted. ') + SHL_HINT;
}

function postKit(c) {
  const sec = h('section', { class: 'card-sec postkit' }, h('h3', { text: 'Post kit' }));
  const P = parsePost(c.post || ''), values = new Map();
  if (!P.sections.length) {
    const txt = c.post || c.desc || '';
    if (!txt) { sec.append(h('p', { class: 'muted', text: 'No post text for this clip yet.' })); return sec; }
    P.sections = [{ name: 'Post text', kind: 'other', fields: [{ key: 'text', label: 'Text', value: txt, limit: null }] }];
  }
  for (const s of P.sections) {
    const box = h('div', { class: 'pk-sec', 'data-kind': s.kind }, h('div', { class: 'pk-head' }, h('h4', { text: s.name })));
    for (const f of s.fields) {
      values.set(f, f.value);
      const id = 'pf' + Math.random().toString(36).slice(2, 8);
      const ta = h('textarea', { id, class: 'pk-ta', rows: 2, spellcheck: 'false' }); ta.value = f.value;
      const cnt = h('span', { class: 'cnt', 'aria-live': 'off' });
      const upd = () => {
        values.set(f, ta.value); ta.style.setProperty('--rows', String(Math.min(12, Math.max(2, ta.value.split('\n').length + Math.floor(ta.value.length / 60)))));
        ta.rows = Math.min(12, Math.max(2, ta.value.split('\n').length + Math.floor(ta.value.length / 70)));
        if (!f.limit) { cnt.textContent = `${[...ta.value].length} chars`; cnt.className = 'cnt'; return; }
        const n = countOf(f, ta.value), L = f.limit, unit = L.unit === 'tags' ? 'tags' : 'chars';
        cnt.textContent = `${n} / ${L.max} ${unit}` + (L.soft ? ` (aim for ${L.soft})` : '');
        cnt.className = 'cnt ' + (n > L.max ? 'over' : L.soft && n > L.soft ? 'warn' : 'ok');
        ta.setAttribute('aria-invalid', String(n > L.max));
      };
      ta.addEventListener('input', upd); upd();
      box.append(h('div', { class: 'pk-field' }, h('div', { class: 'pk-lab' }, h('label', { for: id, text: f.label }), cnt, copyBtn(() => ta.value, 'Copy ' + f.label)), ta));
    }
    if (s.kind === 'yt' || s.kind === 'ig') {
      const name = s.kind === 'yt' ? 'YouTube' : 'Instagram';
      box.querySelector('.pk-head').append(btn(`Copy all for ${name}`, { ic: 'copy', cls: 'sm', kind: 'ghost', on: e => copyText(copyAll(s, values), `Copied ${name} post`, e.currentTarget) }));
    }
    sec.append(box);
  }
  return sec;
}

function render(c) {
  rendered = c;
  const trashed = !!c.trashed_at || state.view === 'trash';
  const body = dlg.querySelector('.drawer-body'); body.replaceChildren();
  if (player) { player.destroy(); player = null; }
  const acc = accentFor(c.id); dlg.style.setProperty('--ac-rgb', acc ? rgbVar(acc) : '139 123 255'); if (acc) setAurora(acc);
  if (!acc && c.poster) { const im = new Image(); im.onload = () => { const r = accentFromImage(im, c.id); if (r && clipId === c.id) { dlg.style.setProperty('--ac-rgb', rgbVar(r)); setAurora(r); } }; api.fetchMedia(c.poster, { trashed }).then(m => { im.src = m.url; }).catch(() => {}); }
  player = createPlayer(c, { trashed });
  const url = c.video ? api.directMediaUrl(c.video, { trashed }) : null;
  const dl = h('a', { class: 'btn primary', id: 'dl', href: url || (c.video ? '#' : undefined), download: String(c.id || 'clip').replace(/[^\w.\-]/g, '_') + '.mp4', 'aria-disabled': c.video ? undefined : 'true' }, icon('download'), h('span', { class: 'lbl', text: 'Download' })); dl.setAttribute('aria-label', 'Download clip');
  if (!url && c.video) dl.addEventListener('click', async e => {
    e.preventDefault(); const t = toast('Preparing download…', { timeout: 0 });
    try { const m = await api.fetchMedia(c.video, { trashed }); const a = h('a', { href: m.url, download: dl.download }); document.body.append(a); a.click(); a.remove(); setTimeout(() => m.revoke(), 30000); }
    catch (err) { toast(api.errorText(err), { kind: 'error' }); } t.dismiss();
  });
  const actions = h('div', { class: 'actions' });
  if (navigator.share) actions.append(btn('Share', { ic: 'share', on: () => shareClip(c) }));
  // sticky bottom action bar (one thumb): download, post mode and, for admins, the posted toggles
  const posting = postingSec(c, trashed), toggles = [];
  const dbar = h('div', { class: 'dbar glass', role: 'toolbar', 'aria-label': 'Quick actions' }, dl);
  let plRow = null;
  if (!trashed) {
    dbar.append(btn('Post mode', { ic: 'send', cls: 'mag', on: e => startPost(c.id, state.feedIds, e.currentTarget) }));
    { ensureCss(); const pb = btn('Playlist', { ic: 'plus', cls: 'pl-add-d', on: e => openAddToPlaylist([momentKey(c)], titleOf(c), e.currentTarget) }); pb.id = 'btn-playlist'; plRow = h('div', { class: 'pl-d-row' }, pb); }
    shlClip = c; shlBtn = btn('Shortlist', { ic: 'star', cls: 'shl-btn', on: () => { if (shlBtn?.getAttribute('aria-disabled') !== 'true') toggleShortlist(shlClip); else toast(SHL_HINT + '.'); } }); shlBtn.id = 'btn-shortlist';
    shlHint = h('span', { class: 'shl-hint', id: 'shl-hint' }); dbar.append(shlBtn, shlHint); paintShl();
    if (canWrite()) for (const pl of PLATFORMS) { const t = toggleBtn(c, pl, { cls: 'sm' }); toggles.push(t); dbar.append(t); }
  }
  livePost = cl => { posting.update(cl); for (const t of toggles) t.update(cl); const old = info.querySelector('.pchips'); if (old) old.replaceWith(chips(cl)); };
  const tags = tagsOf(c);
  const head = h('div', { class: 'dhead' });
  const info = h('div', { class: 'info-main' });
  const fillInfo = () => {
    info.replaceChildren(...[
      h('h2', { class: 'dtitle', id: 'drawer-title', lang: 'hi-Latn', text: titleOf(c) }),
      c.hook ? h('p', { class: 'dhook', text: c.hook }) : null,
      c.desc ? h('p', { class: 'ddesc', text: c.desc }) : null,
      trashed ? null : chips(c),
      tags.length ? h('ul', { class: 'tagrow', 'aria-label': 'Tags' }, ...tags.map(t => h('li', { text: '#' + t.replace(/^#/, '') }))) : null].filter(Boolean));
  };
  fillInfo();
  if (trashed) info.prepend(h('p', { class: 'trashed-flag' }, icon('trash'), h('span', { 'data-trashline': '', 'data-trashed': c.trashed_at || '', 'data-purge': c.purge_after || '', text: trashLine(c) })));
  if (canWrite()) {
    if (!trashed) {
      const ed = btn('Edit', { ic: 'edit', id: 'edit', on: () => { form.hidden = false; info.hidden = true; actions.hidden = true; form.firstElementChild.querySelector('input')?.focus(); } });
      ed.id = 'btn-edit';
      const tr = btn('Move to Trash', { ic: 'trash', kind: 'danger-ghost', on: () => emit('act', { type: 'trash', ids: [c.id], from: 'drawer' }) }); tr.id = 'btn-trash';
      actions.append(ed, tr);
    } else {
      const rs = btn('Restore', { ic: 'restore', on: () => emit('act', { type: 'restore', ids: [c.id], from: 'drawer' }) }); rs.id = 'btn-restore';
      const pg = btn('Delete forever', { ic: 'trash', kind: 'danger', on: () => emit('act', { type: 'purge', id: c.id, from: 'drawer' }) }); pg.id = 'btn-purge';
      actions.append(rs, pg);
    }
  }
  const form = h('div', { class: 'edit-wrap', hidden: true });
  if (canWrite() && !trashed) {
    const hadDraft = !!takeDraftPeek(c.id);
    form.append(editForm(c, { close: () => { form.hidden = true; info.hidden = false; actions.hidden = false; } }));
    if (hadDraft) { form.hidden = false; info.hidden = true; actions.hidden = true; }
  }
  actions.hidden = !actions.children.length; head.append(info, form, actions);
  const panel = h('div', { class: 'panel' }, head, ...(plRow ? [plRow] : []), ...(trashed || !state.postMode ? [] : [postInfoBlock(c)]), ...(trashed ? [] : [posting.el]), details(c, trashed), postKit(c));
  body.append(h('div', { class: 'drawer-grid' }, h('div', { class: 'stage' }, player.el), panel), dbar);
  dlg.querySelector('.drawer-scroll').scrollTop = 0;
}

export function open(id) {
  const c = findClip(id);
  if (!c) { toast('That clip was not found.', { kind: 'error' }); location.hash = backHash(); return false; }
  if (!dlg) build();
  if (dlg.open && clipId === id && rendered === c && !closing) return true;
  if (opening === id) return true;
  const show = vt => {
    opening = null; clipId = id; closing = false;
    render(c);
    if (!dlg.open) {
      dlg.classList.toggle('vt', !!vt); dlg.showModal(); document.body.classList.add('locked');
      if (vt) { dlg.classList.add('shown'); setTimeout(() => dlg.classList.remove('vt'), 900); } else requestAnimationFrame(() => dlg.classList.add('shown'));
    }
    dlg.querySelector('.drawer-close').focus();
    announce('Opened ' + titleOf(c));
  };
  if (dlg.open) show(false); else { opening = id; motion.transition(show, () => dlg.querySelector('.phone')); }
  return true;
}
let rendered = null;
export function refresh() {
  if (dlg?.open && clipId) {
    paintShl();
    const c = findClip(clipId);
    if (!c) close();
    else if (c !== rendered || peekDraft(c.id)) { if (!peekDraft(c.id) && sameBase(rendered, c) && livePost) { rendered = c; livePost(c); } else render(c); }
  }
}
export const currentId = () => (dlg?.open ? clipId : null);

export function close(immediate = false) {
  if (!dlg?.open || closing) return;
  closing = true;
  const fin = () => { if (player) { player.destroy(); player = null; } dlg.querySelector('.drawer-body').replaceChildren(); rendered = null; dlg.close(); dlg.classList.remove('shown'); closing = false; clipId = null; if (!document.querySelector('dialog[open]')) document.body.classList.remove('locked'); };
  if (state.reduced || immediate) { fin(); return; }
  dlg.classList.remove('shown');
  setTimeout(fin, 260);
}
function build() {
  dlg = h('dialog', { class: 'drawer', 'aria-modal': 'true', 'aria-labelledby': 'drawer-title' },
    h('div', { class: 'drawer-bg', 'aria-hidden': 'true' }),
    h('button', { type: 'button', class: 'btn icon glass drawer-close', 'aria-label': 'Close details' }, icon('x')),
    h('div', { class: 'drawer-scroll' }, h('div', { class: 'drawer-body' })));
  document.getElementById('dialogs').append(dlg);
  trapFocus(dlg);
  dlg.querySelector('.drawer-close').addEventListener('click', () => { location.hash = backHash(); });
  dlg.addEventListener('cancel', e => { e.preventDefault(); location.hash = backHash(); });
  dlg.addEventListener('click', e => { if (e.target === dlg) location.hash = backHash(); });
  dlg.addEventListener('keydown', e => { if (player && !e.target.closest?.('.modal') ) player.key(e); });
}
