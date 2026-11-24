// Playlists UI part 2: the Playlists screen (#/playlists), one playlist (#/playlists/<id>) with reorder, the item editor, Apply template, Copy all and CSV.
import { state, on } from './state.js';
import { h, btn, icon } from './dom.js';
import * as api from './api.js';
import { createModal, announce } from './a11y.js';
import { toast } from './toast.js';
import { copyText } from './kit.js';
import { titleOf, dur } from './fmt.js';
import { liveKeys } from './shortlist.js';
import { PL_PLATFORMS, PL_LABEL, PL_STATUS, captionRest, normTags, repClip, isStale, liveItems, progress, suggestStatus, itemDone, captionText, playlistText, playlistCsv, newId, itemModes, pickMode, comboLabel, playlistLinkPath, shareText } from './playlists.js';
import { readPlPref, writePlPref } from './viewpref.js';
import { validatePost, applyTemplateToItems, renderPost } from './templates.js';
import { postedControl, openPostedModal } from './postedui.js';
import { openMenu, moreButton } from './menu.js';
import { versionSelect } from './vsel.js';
import { ensureCss, canEditPl, RO_HINT, roMsg, plAct, streamOf, effectiveTemplates, templateById, addShortlistedToPlaylist, newItemPost } from './plui.js';

let focusAfter = null, dragKey = null, lastEl = null, rename = null;   // rename = { id, text } while a title is being edited inline
const modeMem = new Map();                                              // moment key -> chosen version combo (this visit); the last choice is also remembered per viewer
const siteBase = () => location.origin + location.pathname;
const linkOf = p => siteBase() + playlistLinkPath(p.id);
const clipLink = c => siteBase() + '#/clip/' + encodeURIComponent(c.id);
const modeOf = it => pickMode(itemModes(it, state.clips), modeMem.get(it.moment_id) || readPlPref().mode);
const backTarget = () => state.plFrom || '#/';
const put = (el, ...kids) => el.replaceChildren(...kids.filter(Boolean));
const byId = id => state.playlists.playlists.find(p => p.id === id) || null;
export function confirmDialog({ title, text, ok = 'Delete', danger = true }) {
  return new Promise(res => {
    const m = createModal({ title, desc: text, danger, cls: 'pl-modal' });
    m.foot.append(btn('Cancel', { on: () => m.close(false) }), btn(ok, { kind: danger ? 'danger' : 'primary', on: () => m.close(true) }));
    m.done.then(v => res(v === true)); m.open(m.foot.querySelector('button'));
  });
}
const crumb = (label, href) => h('a', { class: 'back-link', href }, icon('back'), h('span', { text: label }));
const platChips = p => (p.platforms.length ? h('span', { class: 'pl-plats' }, ...p.platforms.map(k => h('span', { class: 'pi-badge', 'data-p': k, text: PL_LABEL[k] }))) : null);
const statusChip = s => h('span', { class: 'pl-status', 'data-s': s, text: s });
function progressBar(p, label = true) {
  const g = progress(p, state.clips);
  return h('div', { class: 'pl-prog' }, h('progress', { max: 100, value: g.pct, 'aria-label': `Posted ${g.done} of ${g.total}` }), label ? h('span', { class: 'pl-prog-t', text: g.total ? `${g.done} of ${g.total} posted` : 'Empty' }) : null);
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const deletePlaylist = async p => { if (await confirmDialog({ title: 'Delete this playlist?', text: `"${p.title}" and its post text and posted marks will be removed for everyone. The clips stay in the library.` })) { const r = await plAct({ type: 'delete', id: p.id }, 'Playlist deleted'); if (r && /^#\/playlists\/./.test(location.hash)) location.hash = '#/playlists'; } };

// ---- create / rename form
function openPlaylistForm(p, opener) {
  const m = createModal({ title: p ? 'Edit playlist' : 'New playlist', cls: 'pl-modal' });
  const title = h('input', { type: 'text', id: 'plf-title', maxlength: 120, value: p?.title || '', 'aria-label': 'Playlist title' }), desc = h('textarea', { id: 'plf-desc', rows: 3, maxlength: 1000, 'aria-label': 'Description', text: p?.description || '' });
  const boxes = PL_PLATFORMS.map(k => { const cb = h('input', { type: 'checkbox', value: k, checked: !!p?.platforms.includes(k) }); return { k, cb, el: h('label', { class: 'pl-check' }, cb, h('span', { text: PL_LABEL[k] })) }; });
  const status = h('select', { id: 'plf-status', 'aria-label': 'Status' }, ...PL_STATUS.map(s => h('option', { value: s, text: s, selected: p?.status === s })));
  const err = h('p', { class: 'field-err', role: 'alert' });
  const go = async () => {
    err.textContent = ''; const t = title.value.trim(); if (!t) { err.textContent = 'Give the playlist a title.'; title.focus(); return; }
    const platforms = boxes.filter(b => b.cb.checked).map(b => b.k);
    const r = p ? await plAct({ type: 'update', id: p.id, patch: { title: t, description: desc.value, platforms, status: status.value } }, 'Saved')
      : await plAct({ type: 'create', id: newId('pl'), title: t, description: desc.value, platforms }, 'Playlist created');
    if (r) m.close(true);
  };
  m.body.append(h('form', { class: 'pl-form', on: { submit: e => { e.preventDefault(); go(); } } }, h('label', null, h('span', { text: 'Title' }), title), h('label', null, h('span', { text: 'Description' }), desc),
    h('fieldset', { class: 'pl-fs' }, h('legend', { text: 'Platforms' }), ...boxes.map(b => b.el)), p ? h('label', null, h('span', { text: 'Status' }), status) : null, err, h('button', { type: 'submit', class: 'sr', tabindex: '-1', text: 'Save' })));
  m.foot.append(btn('Cancel', { on: () => m.close(false) }), btn(p ? 'Save' : 'Create', { kind: 'primary', on: go }));
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(title); return m;
}

// ---- Share (D51): a link that only works for people who can unlock the site; text for chats; CSV stays
function openShareDialog(p, opener) {
  const m = createModal({ title: 'Share playlist', desc: p.title, cls: 'pl-modal pl-share' });
  const link = linkOf(p), field = h('input', { type: 'text', readonly: true, value: link, id: 'share-link', 'aria-label': 'Playlist link' });
  field.addEventListener('focus', () => field.select());
  const note = 'Open with the site passphrase';
  const act = [btn('Copy link', { ic: 'copy', kind: 'primary', cls: 'pl-sh-link', on: e => copyText(link, 'Link copied', e.currentTarget) }),
    typeof navigator.share === 'function' ? btn('Share...', { ic: 'share', cls: 'pl-sh-native', on: async () => { try { await navigator.share({ title: p.title, text: note, url: link }); } catch { /* cancelled */ } } }) : null,
    btn('Copy as text', { ic: 'copy', cls: 'pl-sh-text', on: e => { const t = shareText(p, state.clips, { clipLink, modeClip: it => modeOf(it)?.clip, listLink: link }); copyText(t || p.title, 'Text copied', e.currentTarget); } })].filter(Boolean);
  m.body.append(h('div', { class: 'pl-form' }, h('label', null, h('span', { text: 'Link' }), field), h('div', { class: 'pl-sh-acts' }, ...act),
    h('p', { class: 'muted pl-sh-hint', text: 'The link does not make any clip public. It only opens for people who can unlock the site with the passphrase. The clips stay private.' })));
  m.foot.append(btn('Close', { on: () => m.close(false) }));
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(m.body.querySelector('button')); return m;
}
const dupPlaylist = p => plAct({ type: 'duplicate', id: p.id, new_id: newId('pl'), title: p.title + ' (copy)' }, 'Duplicated');

// ---- the list
function renderList(el) {
  const pls = state.playlists.playlists, ro = !canEditPl();
  const newB = btn('New playlist', { ic: 'plus', kind: 'primary', cls: 'pl-new', on: e => openPlaylistForm(null, e.currentTarget), disabled: ro });
  const head = h('header', { class: 'pl-head' }, crumb(backTarget() === '#/' ? 'Library' : 'Back', backTarget()), h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1', text: 'Playlists' }),
    h('p', { class: 'page-sub', text: 'Plan what to post: ordered moments with post text and a tracker.' }),
    h('div', { class: 'pl-bar' }, newB, h('a', { class: 'btn', href: '#/templates', id: 'pl-to-templates' }, icon('edit'), h('span', { class: 'lbl', text: 'Templates' }))));
  const list = h('ul', { class: 'pl-list', 'aria-label': 'Playlists' });
  for (const p of pls) {
    const g = progress(p, state.clips), stale = p.items.length - liveItems(p, state.clips).length;
    const share = btn('', { ic: 'share', kind: 'ghost', cls: 'icon pl-share-b', aria: `Share ${p.title}`, on: e => openShareDialog(p, e.currentTarget) });
    const more = moreButton(`More actions for ${p.title}`, op => openMenu({ title: p.title, opener: op, entries: [
      { id: 'edit', label: 'Rename and details', ic: 'edit', disabled: ro, run: () => openPlaylistForm(p, op) },
      { id: 'dup', label: 'Duplicate', ic: 'copy', disabled: ro, run: () => dupPlaylist(p) },
      { id: 'delete', label: 'Delete playlist', ic: 'trash', danger: true, disabled: ro, run: () => deletePlaylist(p) }] }), 'pl-more');
    list.append(h('li', { class: 'pl-card', 'data-id': p.id },
      h('div', { class: 'pl-card-main' }, h('a', { class: 'pl-card-t', href: '#/playlists/' + encodeURIComponent(p.id), text: p.title }), statusChip(p.status), p.description ? h('p', { class: 'pl-desc', text: p.description }) : null,
        h('div', { class: 'pl-meta' }, platChips(p), h('span', { class: 'muted', text: `${g.total} moment${g.total === 1 ? '' : 's'}` + (stale ? `, ${stale} no longer in the library` : '') })), progressBar(p)),
      h('div', { class: 'pl-card-act' }, share, more)));
  }
  put(el, head, ro ? h('p', { class: 'pl-ro', text: roMsg() }) : null, pls.length ? list : h('div', { class: 'empty pl-empty' }, h('p', { text: 'No playlists yet.' }), h('p', { class: 'muted', text: 'Create one here, or tap "Add to playlist" on any clip.' })));
}

// ---- item editor (a dialog, so the live refresh never replaces what is being typed)
function openItemEditor(p, it, opener) {
  const c = repClip(it.moment_id, state.clips), tpl = p.template_id ? templateById(p.template_id) : null, pos = [...p.items].findIndex(x => x.moment_id === it.moment_id) + 1;
  const m = createModal({ title: 'Post text', desc: c ? titleOf(c) : 'This clip is no longer in the library', cls: 'pl-modal pl-editor' });
  const title = h('input', { type: 'text', id: 'pie-title', maxlength: 300, value: it.post.title, 'aria-label': 'Post title' });
  const cap = h('textarea', { id: 'pie-caption', rows: 7, maxlength: 5000, 'aria-label': 'Caption', text: it.post.caption });
  const tags = h('input', { type: 'text', id: 'pie-tags', value: it.post.hashtags.join(' '), 'aria-label': 'Hashtags', placeholder: '#one #two' });
  const warn = h('ul', { class: 'pl-warn', 'aria-live': 'polite' }), count = h('p', { class: 'pl-count muted' });
  const cur = () => ({ title: title.value, caption: cap.value, hashtags: normTags(tags.value) });
  const upd = () => { const v = cur(), w = validatePost(v, tpl, { dur: c?.dur }); warn.replaceChildren(...w.map(x => h('li', { text: x }))); count.textContent = `Title ${[...v.title].length}${tpl?.limits.title_max ? '/' + tpl.limits.title_max : ''}, caption ${[...v.caption].length}${tpl?.limits.caption_max ? '/' + tpl.limits.caption_max : ''}, ${v.hashtags.length} hashtags`; };
  for (const x of [title, cap, tags]) x.addEventListener('input', upd);
  const err = h('p', { class: 'field-err', role: 'alert' });
  m.body.append(h('div', { class: 'pl-form' }, h('label', null, h('span', { text: 'Title' }), title), h('label', null, h('span', { text: 'Caption' }), cap), h('label', null, h('span', { text: 'Hashtags' }), tags), count, warn, err,
    tpl ? h('p', { class: 'muted', text: `Checked against the template "${tpl.name}".` }) : null));
  upd();
  const save = async () => { const r = await plAct({ type: 'set_post', id: p.id, moment_id: it.moment_id, post: { ...cur(), edited: true } }, 'Saved'); if (r) m.close(true); };
  const reset = tpl && c ? btn('Reset to template', { kind: 'ghost', on: () => { const v = renderPost(tpl, c, streamOf(c), pos).post; title.value = v.title; cap.value = v.caption; tags.value = v.hashtags.join(' '); upd(); } }) : null;
  m.foot.append(...[btn('Copy caption', { ic: 'copy', kind: 'ghost', on: e => copyText(captionText(cur()) || title.value, 'Caption copied', e.currentTarget) }), reset].filter(Boolean), btn('Cancel', { on: () => m.close(false) }), btn('Save', { kind: 'primary', on: save }));
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(title); return m;
}

// ---- Apply template
function openApplyTemplate(p, opener) {
  const tpls = effectiveTemplates();
  const m = createModal({ title: 'Apply template', desc: `Fills the post title, caption and hashtags of ${liveItems(p, state.clips).length} moments in "${p.title}".`, cls: 'pl-modal' });
  const sel = h('select', { id: 'apt-tpl', 'aria-label': 'Template' }, ...tpls.map(t => h('option', { value: t.id, text: t.name, selected: t.id === p.template_id })));
  const over = h('input', { type: 'checkbox', id: 'apt-over' }), summary = h('ul', { class: 'pl-warn', 'aria-live': 'polite' });
  const edited = p.items.filter(i => i.post.edited).length;
  const sum = () => {
    const t = tpls.find(x => x.id === sel.value); if (!t) return;
    const r = applyTemplateToItems(p.items, t, k => repClip(k, state.clips), streamOf, over.checked), rows = [];
    let n = 0; for (const it of liveItems(p, state.clips)) { n++; const post = r.posts[it.moment_id]; if (!post) continue; const w = validatePost(post, t, { dur: repClip(it.moment_id, state.clips)?.dur, unknown: renderPost(t, repClip(it.moment_id, state.clips), null, n).unknown }); if (w.length) rows.push(h('li', { text: `${n}. ${w[0]}${w.length > 1 ? ` (+${w.length - 1})` : ''}` })); }
    summary.replaceChildren(h('li', { class: 'ok', text: `${Object.keys(r.posts).length} will be filled` + (r.skipped ? `, ${r.skipped} edited by hand will be kept` : '') + '.' }), ...rows);
  };
  sel.addEventListener('change', sum); over.addEventListener('change', sum);
  m.body.append(h('div', { class: 'pl-form' }, h('label', null, h('span', { text: 'Template' }), sel), edited ? h('label', { class: 'pl-check' }, over, h('span', { text: `Overwrite the ${edited} item${edited === 1 ? '' : 's'} I edited` })) : null, summary));
  sum();
  const go = async () => {
    const t = tpls.find(x => x.id === sel.value); if (!t) return;
    const r = applyTemplateToItems(p.items, t, k => repClip(k, state.clips), streamOf, over.checked);
    const res = await plAct({ type: 'set_posts', id: p.id, posts: r.posts, overwrite: over.checked, template_id: t.id }, `Applied ${t.name}`);
    if (res) m.close(true);
  };
  m.foot.append(btn('Cancel', { on: () => m.close(false) }), btn('Apply', { kind: 'primary', on: go, disabled: !tpls.length }));
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(sel); return m;
}

// ---- one playlist
const download = (name, text, type) => { const u = URL.createObjectURL(new Blob([text], { type })); const a = h('a', { href: u, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); };
function itemRow(p, it, i, n, ro) {
  const modes = itemModes(it, state.clips), cur = modeOf(it), c = cur?.clip || repClip(it.moment_id, state.clips), stale = !c, tpl = p.template_id ? templateById(p.template_id) : null;
  const w = stale ? [] : validatePost(it.post, tpl, { dur: c?.dur });
  const img = h('img', { alt: '', class: 'pl-thumb', decoding: 'async', loading: 'lazy' });
  if (c?.poster) { img.addEventListener('error', () => img.remove()); api.loadImage(img, c.poster, {}).catch(() => img.remove()); }
  const move = (to, sel) => { focusAfter = `[data-k="${CSS.escape(it.moment_id)}"] ${sel}`; plAct({ type: 'move', id: p.id, moment_id: it.moment_id, to }); };
  const handle = h('span', { class: 'pl-handle', title: 'Drag to reorder', 'aria-hidden': 'true' }, icon('dots'));
  let li;
  const pick = (k, how) => { modeMem.set(it.moment_id, k); writePlPref({ mode: k }); const nl = itemRow(p, it, i, n, ro); li.replaceWith(nl); nl.querySelector(`.vs-b[data-axis="${how.axis}"][data-val="${how.val}"]`)?.focus(); };
  const vs = !stale && modes.length > 1 ? versionSelect({ combos: modes.map(x => x.key), current: cur?.key, cls: 'vs-item pl-modes', aria: `Version: item ${i + 1}`, onPick: pick }) : null;
  const text = stale ? '' : captionRest(it.post.title || titleOf(c), it.post.caption);
  const tags = !stale && it.post.hashtags.length ? it.post.hashtags.join(' ') : '';
  const more = stale ? moreButton(`More actions: item ${i + 1}`, op => openMenu({ title: `Item ${i + 1}`, opener: op, entries: [
      { id: 'up', label: 'Move up', ic: 'chevu', disabled: ro || i === 0, run: () => move(i - 1, '.pl-more') }, { id: 'down', label: 'Move down', ic: 'chevd', disabled: ro || i === n - 1, run: () => move(i + 1, '.pl-more') },
      { id: 'remove', label: 'Remove from playlist', ic: 'trash', danger: true, disabled: ro, run: () => plAct({ type: 'remove_item', id: p.id, moment_id: it.moment_id }, 'Removed from the playlist') }] }), 'pl-more')
    : moreButton(`More actions: item ${i + 1}`, op => openMenu({ title: it.post.title || titleOf(c), desc: `Item ${i + 1} of ${n}`, opener: op, entries: [
      { id: 'edit', label: 'Edit post text', ic: 'edit', disabled: ro, run: o => openItemEditor(p, it, o) },
      { id: 'copy', label: 'Copy caption', ic: 'copy', run: o => copyText(captionText(it.post) || it.post.title, 'Caption copied', o) },
      { id: 'posted', label: 'Posted date and link...', ic: 'check', run: o => openPostedModal(c, o) },
      { id: 'up', label: 'Move up', ic: 'chevu', disabled: ro || i === 0, run: () => move(i - 1, '.pl-more') }, { id: 'down', label: 'Move down', ic: 'chevd', disabled: ro || i === n - 1, run: () => move(i + 1, '.pl-more') },
      { id: 'remove', label: 'Remove from playlist', ic: 'trash', danger: true, disabled: ro, run: () => plAct({ type: 'remove_item', id: p.id, moment_id: it.moment_id }, 'Removed from the playlist') }] }), 'pl-more');
  li = h('li', { class: 'pl-item' + (stale ? ' stale' : ''), 'data-k': it.moment_id, 'aria-label': stale ? `Item ${i + 1}, no longer in the library` : `Item ${i + 1}, ${titleOf(c)}` });
  if (!ro) {
    handle.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse') li.draggable = true; });
    li.addEventListener('dragstart', e => { dragKey = it.moment_id; e.dataTransfer?.setData('text/plain', it.moment_id); li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { dragKey = null; li.draggable = false; li.classList.remove('dragging'); document.querySelectorAll('.pl-item.over').forEach(x => x.classList.remove('over')); });
    li.addEventListener('dragover', e => { if (dragKey && dragKey !== it.moment_id) { e.preventDefault(); li.classList.add('over'); } });
    li.addEventListener('dragleave', () => li.classList.remove('over'));
    li.addEventListener('drop', e => { e.preventDefault(); li.classList.remove('over'); const k = dragKey; dragKey = null; if (k && k !== it.moment_id) { focusAfter = `[data-k="${CSS.escape(k)}"] .pl-handle`; plAct({ type: 'move', id: p.id, moment_id: k, to: i }); } });
  }
  const meta = stale ? null : [c.dur ? dur(c.dur) : '', modes.length > 1 ? plural(modes.length, 'version') : ''].filter(Boolean).join(' · ');
  const det = !stale && (text || tags) ? h('details', { class: 'pl-det' }, h('summary', { text: 'Details' }), text ? h('p', { class: 'pl-item-cap', text }) : null, tags ? h('p', { class: 'pi-tags', text: tags }) : null) : null;
  li.append(h('div', { class: 'pl-lead' }, handle, h('span', { class: 'pl-n', text: String(i + 1) })),
    stale ? h('div', { class: 'pl-thumbw' }, img) : h('a', { class: 'pl-thumbw', href: '#/clip/' + encodeURIComponent(c.id), 'aria-label': `Open ${cur ? cur.label : 'clip'}: item ${i + 1}` }, img),
    h('div', { class: 'pl-item-main' },
      h('p', { class: 'pl-item-t', text: stale ? 'No longer in the library' : (it.post.title || titleOf(c)) }),
      stale ? h('p', { class: 'muted', text: 'This clip was trashed or deleted. It is ignored in Copy all and CSV.' }) : (meta ? h('p', { class: 'muted pl-meta1', text: meta }) : null)),
    more,
    stale ? null : h('div', { class: 'pl-item-ctl' }, vs?.el, postedControl(c, { compact: true })),
    det, w.length ? h('ul', { class: 'pl-warn small', 'aria-label': 'Warnings' }, ...w.map(x => h('li', { text: x }))) : null);
  return li;
}
function titleBlock(p, ro) {
  if (rename?.id === p.id) {
    const inp = h('input', { type: 'text', id: 'pl-rename', maxlength: 120, value: rename.text, 'aria-label': 'Playlist title' });
    inp.addEventListener('input', () => { rename.text = inp.value; });
    const done = async save => { const t = (rename?.text || '').trim(); rename = null; if (save && t && t !== p.title) await plAct({ type: 'update', id: p.id, patch: { title: t } }, 'Renamed'); else if (lastEl) render(lastEl, location.hash); };
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); done(false); } });
    focusAfter = '#pl-rename';
    return h('form', { class: 'pl-rename', on: { submit: e => { e.preventDefault(); done(true); } } }, inp, btn('Save', { type: 'submit', kind: 'primary', cls: 'sm pl-rename-ok' }), btn('Cancel', { cls: 'sm', on: () => done(false) }));
  }
  const t = h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' });
  if (ro) t.textContent = p.title;
  else t.append(h('button', { type: 'button', class: 'pl-title-b pl-rename-b', title: 'Tap to rename', 'aria-label': `Rename ${p.title}`, on: { click: () => { rename = { id: p.id, text: p.title }; render(lastEl, location.hash); } } }, h('span', { text: p.title }), icon('edit')));
  return h('div', { class: 'pl-titlerow' }, t);
}
function renderOne(el, id) {
  const p = byId(id), ro = !canEditPl();
  if (!p) { put(el, h('header', { class: 'pl-head' }, crumb('Playlists', '#/playlists'), h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1', text: 'Playlist not found' })), h('p', { class: 'muted pl-gone', text: 'This playlist was deleted, or the link is old. Ask whoever shared it for a new link.' })); return; }
  const live = liveItems(p, state.clips), stale = p.items.length - live.length, sug = suggestStatus(p, state.clips), tpl = p.template_id ? templateById(p.template_id) : null, g = progress(p, state.clips);
  const dl = () => download(`${p.title.replace(/[^\w-]+/g, '_').slice(0, 40) || 'playlist'}.csv`, '﻿' + playlistCsv(p, state.clips, { modeOf: it => { const ms = itemModes(it, state.clips), c0 = modeOf(it); return [c0 ? c0.label : '', ms.map(x => x.label).join(' + '), c0 ? clipLink(c0.clip) : '']; } }), 'text/csv;charset=utf-8');
  const addSl = () => { const keys = [...liveKeys(state.shortlist, state.clips)].filter(k => !p.items.some(i => i.moment_id === k)); if (!keys.length) { toast('No new shortlisted moments to add.'); return; }
    plAct({ type: 'add_items', id: p.id, moment_ids: keys, posts: Object.fromEntries(keys.map((k, j) => [k, newItemPost(p, repClip(k, state.clips), p.items.length + j + 1)])) }, `Added ${keys.length} shortlisted`); };
  const more = moreButton('More actions for this playlist', op => openMenu({ title: p.title, opener: op, entries: [
    { id: 'rename', label: 'Rename and details', ic: 'edit', disabled: ro, run: o => openPlaylistForm(p, o) },
    { id: 'addsl', label: 'Add shortlisted', ic: 'star', disabled: ro, run: addSl },
    { id: 'dup', label: 'Duplicate', ic: 'copy', disabled: ro, run: () => dupPlaylist(p) },
    { id: 'copyall', label: 'Copy all (text)', ic: 'copy', disabled: !live.length, run: o => { const t = playlistText(p, state.clips); if (!t) { toast('Nothing to copy yet.'); return; } copyText(t, 'Copied the playlist text', o); } },
    { id: 'csv', label: 'Download CSV', ic: 'download', disabled: !live.length, run: dl },
    stale ? { id: 'rmstale', label: `Remove ${stale} deleted clip${stale === 1 ? '' : 's'}`, ic: 'trash', disabled: ro, run: () => plAct({ type: 'remove_stale', id: p.id, moment_ids: p.items.filter(i => isStale(i, state.clips)).map(i => i.moment_id) }, 'Removed deleted clips') } : null,
    { id: 'delete', label: 'Delete playlist', ic: 'trash', danger: true, disabled: ro, run: () => deletePlaylist(p) }] }), 'pl-menu-b');
  const bar = h('div', { class: 'pl-bar one' }, btn('Share', { ic: 'share', kind: 'primary', cls: 'pl-share-b pl-share', on: e => openShareDialog(p, e.currentTarget) }),
    btn('Apply template', { ic: 'layers', cls: 'pl-apply', on: e => openApplyTemplate(p, e.currentTarget), disabled: ro || !live.length }), more);
  const summary = `${plural(live.length, 'clip')}, ${g.done} of ${g.total} posted` + (stale ? `, ${stale} no longer in the library` : '');
  const head = h('header', { class: 'pl-head' }, crumb('Playlists', '#/playlists'), titleBlock(p, ro), h('div', { class: 'pl-sub1' }, statusChip(p.status), h('span', { class: 'muted pl-summary', text: summary }), platChips(p), tpl ? h('span', { class: 'muted', text: `Template: ${tpl.name}` }) : null),
    p.description ? h('p', { class: 'pl-desc', text: p.description }) : null, progressBar(p, false), bar);
  const sugEl = sug && p.status !== 'posted' ? h('div', { class: 'pl-suggest', role: 'status' }, h('span', { text: 'Every moment is posted.' }), btn('Mark playlist as posted', { cls: 'sm pl-setposted', kind: 'primary', on: () => plAct({ type: 'update', id: p.id, patch: { status: 'posted' } }, 'Playlist marked posted'), disabled: ro })) : null;
  const ol = h('ol', { class: 'pl-items', 'aria-label': 'Items' });
  p.items.forEach((it, i) => ol.append(itemRow(p, it, i, p.items.length, ro)));
  put(el, head, ro ? h('p', { class: 'pl-ro', text: roMsg() }) : null, sugEl, p.items.length ? ol : h('div', { class: 'empty pl-empty' }, h('p', { text: 'This playlist is empty.' }), h('p', { class: 'muted', text: 'Add moments with "Add to playlist" on any clip, or "Add shortlisted" in the ... menu.' })));
}

export function render(el, hash) {
  ensureCss(); el.classList.add('pl-view'); lastEl = el;
  const m = /^#\/playlists\/(.+)$/.exec(hash || '');
  let id = null; if (m) { try { id = decodeURIComponent(m[1]); } catch { id = ''; } }
  const kind = id == null ? 'list' : 'one', before = el.dataset.k, same = before === (kind + ':' + (id || ''));
  el.dataset.k = kind + ':' + (id || '');
  if (id == null) renderList(el); else renderOne(el, id);
  if (focusAfter) { const f = el.querySelector(focusAfter); focusAfter = null; if (f && !f.disabled) f.focus(); }
  else if (!same) { el.querySelector('#page-title')?.focus({ preventScroll: true }); window.scrollTo(0, 0); }
}
