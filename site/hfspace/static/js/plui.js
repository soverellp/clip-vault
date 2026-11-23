// Playlists UI part 1 (small, loaded with the library): store actions, "Add to playlist", "Mark posted", and the post-ready info block on cards and in the detail.
// Everything is built with textContent (dom.js h()); user text never becomes HTML.
import { state, emit } from './state.js';
import { h, btn } from './dom.js';
import * as api from './api.js';
import { createModal, announce } from './a11y.js';
import { toast } from './toast.js';
import { copyText } from './kit.js';
import { titleOf } from './fmt.js';
import { momentKey, liveKeys } from './shortlist.js';
import { parsePost } from './post.js';
import { PL_PLATFORMS, PL_LABEL, normTags, repClip, playlistsOf, captionText, newId, postedPlatforms } from './playlists.js';
import { PRESETS, renderPost } from './templates.js';
import { setPlaylistsDoc } from './data.js';

let cssDone = false;
export function ensureCss() {
  if (cssDone) return; cssDone = true;
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/css/playlists.css'; document.head.append(l);
}
export const canEditPl = () => state.me?.capabilities?.shortlist === true;
export const RO_HINT = 'Playlists and templates are read-only on this site';
export const streamOf = c => state.folders.find(f => f.id === c?.stream) || null;
export const effectiveTemplates = () => (state.tplExists === false && !state.templates.templates.length ? PRESETS : state.templates.templates);
export const templateById = id => effectiveTemplates().find(t => t.id === id) || null;
const errText = e => (e?.status === 409 ? 'Someone else saved at the same time. Try again.' : e?.status === 404 ? (e.message || 'That item was changed or removed by someone else.') : e?.status === 403 ? RO_HINT + '.' : e?.status === 502 ? 'The saved file could not be read, so nothing was changed.' : 'Could not save. Check the connection and try again.');

// One change to playlists.json (read at the parent revision, committed with an audit line: see hubapi.js). -> { ok, doc } or null (a toast says why)
export async function plAct(op, okMsg) {
  if (!canEditPl()) { toast(RO_HINT + '.'); return null; }
  try {
    const r = await api.updatePlaylists(op);
    if (r?.doc) { setPlaylistsDoc(r.doc); state.plExists = true; }
    emit('clips'); if (okMsg) { toast(okMsg, { kind: 'success', timeout: 1800 }); announce(okMsg); }
    return r;
  } catch (e) { toast(errText(e), { kind: 'error' }); return null; }
}
export async function tplAct(op, okMsg) {
  if (!canEditPl()) { toast(RO_HINT + '.'); return null; }
  try {
    if (state.tplExists === false && op.type !== 'seed') { const s = await api.updateTemplates({ type: 'seed', templates: PRESETS }); if (s?.doc) state.templates = s.doc; state.tplExists = true; }
    const r = await api.updateTemplates(op);
    if (r?.doc) { state.templates = r.doc; state.tplExists = true; }
    emit('clips'); if (okMsg) { toast(okMsg, { kind: 'success', timeout: 1800 }); announce(okMsg); }
    return r;
  } catch (e) { toast(errText(e), { kind: 'error' }); return null; }
}

// ---- the clip's own post text (from the vault index `post` field), used when a moment is in no playlist
export function clipPostInfo(c0) {
  // the card shows one variant; the post text may sit on another variant of the same moment
  const key = momentKey(c0), c = (c0 && c0.post) ? c0 : (state.clips.find(x => x.post && momentKey(x) === key) || c0);
  const secs = parsePost(c?.post).sections, yt = secs.find(s => s.kind === 'yt'), ig = secs.find(s => s.kind === 'ig');
  const val = (s, k) => s?.fields.find(f => f.key === k)?.value || '';
  const title = val(yt, 'title') || String(c?.title || '');
  const caption = val(ig, 'caption') || val(yt, 'description') || secs.map(s => s.fields.find(f => f.key === 'text')?.value).find(Boolean) || String(c?.hook || '');
  return { title: title.slice(0, 300), caption: caption.slice(0, 5000), hashtags: normTags(val(ig, 'hashtags') || (Array.isArray(c?.tags) ? c.tags : [])) };
}
// What a card shows for a moment: the first playlist item with text, else the clip's own post text. -> { post, source, platforms:Set, posted:Set }
export function momentPost(c) {
  const key = momentKey(c), pls = playlistsOf(state.playlists, key), plats = new Set(), posted = new Set();
  let post = null, src = 'clip';
  for (const p of pls) {
    p.platforms.forEach(k => plats.add(k));
    const it = p.items.find(i => i.moment_id === key); if (!it) continue;
    postedPlatforms(it).forEach(k => posted.add(k));
    if (!post && (it.post.title || it.post.caption)) { post = it.post; src = 'playlist'; }
  }
  return { post: post || clipPostInfo(c), source: src, platforms: plats, posted, playlists: pls };
}
// The post text a NEW playlist item starts with: the playlist's template when it has one, else the clip's own text.
export function newItemPost(playlist, c, n) {
  const t = playlist?.template_id ? templateById(playlist.template_id) : null;
  return t ? renderPost(t, c, streamOf(c), n).post : clipPostInfo(c);
}

// ---- Add to playlist (keys = moment keys)
export function openAddToPlaylist(keys, label, opener) {
  ensureCss();
  keys = [...new Set(keys)]; if (!keys.length) { toast('Nothing to add.'); return null; }
  const m = createModal({ title: 'Add to playlist', desc: label || `${keys.length} moment${keys.length === 1 ? '' : 's'}`, cls: 'pl-modal' });
  const list = h('ul', { class: 'pl-pick' }), nameIn = h('input', { type: 'text', id: 'pl-new-name', maxlength: 120, placeholder: 'New playlist name', 'aria-label': 'New playlist name' });
  const err = h('p', { class: 'field-err', role: 'alert' });
  const paint = () => {
    list.replaceChildren(...(state.playlists.playlists.length ? state.playlists.playlists.map(p => {
      const have = new Set(p.items.map(i => i.moment_id)), allIn = keys.every(k => have.has(k)), n = keys.filter(k => !have.has(k)).length;
      const b = btn(allIn ? 'Already in' : n === keys.length ? 'Add' : `Add ${n}`, { cls: 'sm', kind: allIn ? 'ghost' : 'primary', disabled: allIn, on: () => add(p.id, b) });
      b.setAttribute('aria-label', `${allIn ? 'Already in' : 'Add to'} ${p.title}`); b.dataset.pl = p.id;
      return h('li', null, h('span', { class: 'pl-pick-t' }, h('b', { text: p.title }), h('small', { text: `${p.items.length} item${p.items.length === 1 ? '' : 's'}` })), b);
    }) : [h('li', { class: 'muted', text: 'No playlists yet. Create one below.' })]));
  };
  const posts = (p, ks) => { const o = {}; let n = p ? p.items.length : 0; for (const k of ks) { const c = repClip(k, state.clips); n++; if (c) o[k] = newItemPost(p, c, n); } return o; };
  async function add(id, b) {
    const p = state.playlists.playlists.find(x => x.id === id); if (!p) return;
    b.disabled = true;
    const r = await plAct({ type: 'add_items', id, moment_ids: keys, posts: posts(p, keys.filter(k => !p.items.some(i => i.moment_id === k))) }, `Added to ${p.title}`);
    if (r) { paint(); m.close(true); } else b.disabled = false;
  }
  const create = async () => {
    const title = nameIn.value.trim(); err.textContent = '';
    if (!title) { err.textContent = 'Give the playlist a name.'; nameIn.focus(); return; }
    const id = newId('pl'), c1 = await plAct({ type: 'create', id, title, description: '', platforms: [] });
    if (!c1) return;
    const r = await plAct({ type: 'add_items', id, moment_ids: keys, posts: posts(null, keys) }, `Added to ${title}`);
    if (r) m.close(true);
  };
  const form = h('form', { class: 'pl-newrow', on: { submit: e => { e.preventDefault(); create(); } } }, nameIn, btn('Create and add', { type: 'submit', kind: 'primary', cls: 'sm' }));
  if (!canEditPl()) m.body.append(h('p', { class: 'pl-ro', text: RO_HINT + '.' }));
  else m.body.append(list, h('h3', { class: 'pl-sub', text: 'New playlist' }), form, err);
  paint();
  m.foot.append(btn('Open playlists', { kind: 'ghost', on: () => { m.close(true); location.hash = '#/playlists'; } }), btn('Close', { on: () => m.close(false) }));
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(canEditPl() ? list.querySelector('button:not([disabled])') || nameIn : undefined);
  return m;
}
export const addShortlistedToPlaylist = opener => openAddToPlaylist([...liveKeys(state.shortlist, state.clips)], 'All shortlisted moments', opener);

// ---- Mark posted: platform + date + optional link, on the moment's item in every playlist that holds it (stored in playlists.json; the Library filter reads it)
export function openMarkPosted(c, opener, { only } = {}) {
  ensureCss();
  const key = momentKey(c), pls = only ? [only] : playlistsOf(state.playlists, key);
  const m = createModal({ title: 'Mark posted', desc: titleOf(c), cls: 'pl-modal' });
  if (!canEditPl()) { m.body.append(h('p', { class: 'pl-ro', text: RO_HINT + '.' })); m.foot.append(btn('Close', { on: () => m.close(false) })); m.open(); return m; }
  if (!pls.length) {
    m.body.append(h('p', { text: 'Posting is tracked inside a playlist. Add this moment to a playlist first.' }));
    m.foot.append(btn('Add to playlist', { kind: 'primary', on: () => { m.close(true); setTimeout(() => openAddToPlaylist([key], titleOf(c), opener), 0); } }), btn('Close', { on: () => m.close(false) }));
    m.open(); return m;
  }
  const first = pls[0], plat = h('select', { id: 'mp-platform', 'aria-label': 'Platform' }, ...PL_PLATFORMS.map(k => h('option', { value: k, text: PL_LABEL[k], selected: first.platforms[0] === k })));
  const today = new Date(); const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const date = h('input', { type: 'date', id: 'mp-date', value: ymd, 'aria-label': 'Date posted' }), link = h('input', { type: 'text', id: 'mp-link', placeholder: 'Link to the post (optional)', maxlength: 500, 'aria-label': 'Link to the post' });
  const err = h('p', { class: 'field-err', role: 'alert' });
  const go = async () => {
    err.textContent = '';
    if (!/^\d{4}-\d\d-\d\d$/.test(date.value)) { err.textContent = 'Pick the date it was posted.'; return; }
    const l = link.value.trim(); if (l && (/\s/.test(l) || !/^https?:\/\//i.test(l))) { err.textContent = 'The link must start with http:// or https:// and have no spaces.'; return; }
    let ok = true;
    for (const p of pls) { const r = await plAct({ type: 'mark_posted', id: p.id, moment_id: key, platform: plat.value, date: date.value, link: l }); if (!r) { ok = false; break; } }
    if (ok) { toast(`Marked posted on ${PL_LABEL[plat.value]}`, { kind: 'success', timeout: 1800 }); announce('Marked posted'); m.close(true); }
  };
  m.body.append(h('div', { class: 'pl-form' }, h('label', null, h('span', { text: 'Platform' }), plat), h('label', null, h('span', { text: 'Date' }), date), h('label', null, h('span', { text: 'Link' }), link), err,
    pls.length > 1 ? h('p', { class: 'muted', text: `Applies to this moment in ${pls.length} playlists.` }) : null));
  m.foot.append(btn('Cancel', { on: () => m.close(false) }), btn('Mark posted', { kind: 'primary', ic: 'check', on: go }));
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(plat); return m;
}

// ---- the post-ready block (Post info switch ON): post title, caption, hashtags, platform badges, Copy caption, Mark posted, Add to playlist
export function postInfoBlock(c) {
  const info = momentPost(c), p = info.post;
  const badges = [...new Set([...info.platforms, ...info.posted])].map(k => h('span', { class: 'pi-badge' + (info.posted.has(k) ? ' on' : ''), 'data-p': k, title: info.posted.has(k) ? `Posted on ${PL_LABEL[k]}` : `Planned for ${PL_LABEL[k]}`, text: (info.posted.has(k) ? '✓ ' : '') + PL_LABEL[k] }));
  const copyB = btn('Copy caption', { ic: 'copy', cls: 'sm pi-copy', on: e => { e.preventDefault(); e.stopPropagation(); const t = captionText(p) || p.title; if (!t) { toast('No caption yet.'); return; } copyText(t, 'Caption copied', e.currentTarget); } });
  const markB = btn('Mark posted', { ic: 'check', cls: 'sm pi-mark', on: e => { e.preventDefault(); e.stopPropagation(); openMarkPosted(c, e.currentTarget); } });
  const addB = btn('Add to playlist', { ic: 'plus', cls: 'sm pi-add', on: e => { e.preventDefault(); e.stopPropagation(); openAddToPlaylist([momentKey(c)], titleOf(c), e.currentTarget); } });
  return h('div', { class: 'pinfo', 'data-source': info.source },
    h('p', { class: 'pi-title', text: p.title || '(no post title)' }),
    h('p', { class: 'pi-cap', text: p.caption || '(no caption yet)' }),
    p.hashtags.length ? h('p', { class: 'pi-tags', text: p.hashtags.join(' ') }) : null,
    badges.length ? h('div', { class: 'pi-badges', 'aria-label': 'Platforms' }, ...badges) : null,
    h('div', { class: 'pi-actions' }, copyB, markB, addB));
}
// Card: keep ONE .pinfo block under the card link; rebuilt when its content changes, removed when the switch is off or in the trash.
export function paintPostInfo(li, c, view) {
  const old = li.querySelector(':scope > .pinfo');
  if (view !== 'library' || !state.postMode) { old?.remove(); li.classList.remove('has-pinfo'); return; }
  const sig = JSON.stringify([c.id, momentPost(c).post, [...momentPost(c).posted], [...momentPost(c).platforms]]);
  if (old && old.dataset.sig === sig) return;
  const nw = postInfoBlock(c); nw.dataset.sig = sig;
  if (old) old.replaceWith(nw); else li.append(nw);
  li.classList.add('has-pinfo');
}
