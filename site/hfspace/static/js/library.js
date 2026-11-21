import { state, on, emit, listFor, isAdmin, canWrite } from './state.js';
import { variantOf, buildMoments, hasPair, pick, infoOf, catHas, catCounts, momentRankCmp, rankCmp, hasNewFields, foldersOf, folderHref, dateText, clippedText, langStats, langOfClip, tierOf, VARIANTS, CATS } from './moments.js';
import { h, btn, icon, setIcon } from './dom.js';
import * as api from './api.js';
import { accentFromImage, accentFor, rgbVar, hueFor, setAurora } from './color.js';
import { timeEl, trashLine } from './time.js';
import { dur, human, scoreText, pretty, norm, titleOf, tagsOf, postedByOf } from './fmt.js';
import * as hero from './hero3d.js';
import { announce, haptic } from './a11y.js';
import { openPalette } from './palette.js';
import { chips, postState, openCardSheet, startPost, downloadAll, canShortlist, shortlisted, shortlistCount, toggleShortlist, copyShortlist, SHL_HINT } from './kit.js';
import { keySet, momentKey } from './shortlist.js';
import * as motion from './kit.js';

const DAY = 864e5;
const hasScore = c => c.score != null && Number.isFinite(+c.score);
export const isNew = c => { const t = Date.parse(c.added_at), d = Date.now() - t; return Number.isFinite(t) && d < 2 * DAY && d > -DAY; };
// "Best clips" = the top 25% by score (at least one clip).
export function bestThreshold(list = state.clips) {
  const s = list.filter(hasScore).map(c => +c.score).sort((a, b) => b - a);
  return s.length ? s[Math.max(1, Math.ceil(s.length * 0.25)) - 1] : Infinity;
}
export function queueCounts() {
  const lib = state.clips, thr = bestThreshold(lib);
  return { all: lib.length, ready: lib.filter(c => postState(c) === 'none').length, best: lib.filter(c => hasScore(c) && +c.score >= thr).length, new: lib.filter(isNew).length };
}

const cache = new Map(); // `${view}:${id}` -> li
let refs = {}, io = null, revealN = 0;

// ---- moments mode: on as soon as any clip (or the index) carries the new fields. Without them everything below is the old flat library.
const newData = () => state.folders.length > 0 || state.clips.some(hasNewFields);
export const folderMode = (view = state.view) => view === 'library' && newData();
// 'flat' (old data, or trash) | 'home' (folder cards) | 'folder' (one stream) | 'search' (typed query: moments from every stream)
export function level(view = state.view) { if (!folderMode(view)) return 'flat'; if (state.q.trim()) return 'search'; return state.folder != null ? 'folder' : 'home'; }
// Inside the moments screens the default order is "best first" until the person picks another sort.
const sortKey = view => (folderMode(view) && !state.sortTouched ? 'rank' : state.sort);
const single = c => ({ key: 'c:' + c.id, group: null, stream: c.stream || '', clips: [c], byVariant: {} });
const selOf = m => state.variants.get(m.key) || 'clean';   // Clean is the default version; a viewer's own pick (state.variants) wins, and a moment without Clean falls back inside pick()
export function visible(view = state.view) {
  const q = norm(state.q).split(/\s+/).filter(Boolean);
  const thr = view === 'library' && state.queue === 'best' ? bestThreshold() : 0;
  const langBy = view === 'library' && state.lang && level(view) !== 'folder' ? langStats(state.clips, state.folders).by : null;
  const shl = view === 'library' && state.shortlistOnly ? keySet(state.shortlist) : null;
  let list = listFor(view).filter(c => {
    if (view === 'library') {
      if (shl && !shl.has(momentKey(c))) return false;
      if (langBy && langOfClip(c, langBy) !== state.lang) return false;
      if (state.queue === 'ready' && postState(c) !== 'none') return false;
      if (state.queue === 'best' && !(hasScore(c) && +c.score >= thr)) return false;
      if (state.queue === 'new' && !isNew(c)) return false;
      if (state.post !== 'any' && postState(c) !== state.post) return false;
      if (state.streams.size && !state.streams.has(c.stream ?? '')) return false;
      if (state.postedBy.size && !state.postedBy.has(postedByOf(c))) return false;
      if (state.tags.size && ![...state.tags].every(t => tagsOf(c).includes(t))) return false;
      if (state.minScore > 0 && !(Number(c.score) >= state.minScore)) return false;
    }
    if (q.length) {
      const hay = norm([c.title, c.hook, c.desc, tagsOf(c).join(' '), c.stream].filter(Boolean).join(' '));
      if (!q.every(t => hay.includes(t))) return false;
    }
    return true;
  });
  const ts = c => Date.parse(view === 'trash' ? c.trashed_at : (c.clipped_at || c.added_at || c.updated_at)) || 0; // newest CLIPPED first (D40), older data: when it was added
  const n = x => Number(x) || 0;
  const by = { rank: (a, b) => rankCmp(a, b) || ts(b) - ts(a), newest: (a, b) => ts(b) - ts(a), oldest: (a, b) => (ts(a) || Infinity) - (ts(b) || Infinity), longest: (a, b) => n(b.dur) - n(a.dur), biggest: (a, b) => n(b.size) - n(a.size), score: (a, b) => n(b.score) - n(a.score) };
  const key = view === 'library' && (state.queue === 'ready' || state.queue === 'best') && state.sort === 'newest' ? 'score' : sortKey(view); // queues default to best first
  list = [...list].sort(view === 'trash' ? by.newest : (by[key] || by.newest));
  return list;
}

function makeCard(m, view) {
  const c = pick(m, selOf(m));
  const trash = view === 'trash';
  const li = h('li', { class: 'card pre', data: { id: c.id, view } });
  const poster = h('div', { class: 'poster ph' , vars: { '--ph': hueFor(c.id) } });
  const link = h('a', { class: 'card-link', href: '#/clip/' + encodeURIComponent(c.id), draggable: 'false' });
  const inner = h('div', { class: 'card-in' });
  poster.append(h('span', { class: 'badge dur' }), h('span', { class: 'badge score' }, h('b')), h('span', { class: 'ribbon', text: 'NEW', hidden: true }), h('span', { class: 'star', hidden: true }));
  const body = h('div', { class: 'card-body' }, wave(c), h('p', { class: 'lab', hidden: true }),
    h('h3', { class: 'title', lang: 'hi-Latn' }), h('p', { class: 'why', hidden: true }), h('p', { class: 'hook' }),
    h('div', { class: 'mrow', hidden: true }, h('span', { class: 'rx', hidden: true }), h('span', { class: 'mdur' })),
    h('div', { class: 'pc' }),
    h('div', { class: 'meta' }, h('span', { class: 'pill stream' }), h('span', { class: 'pill by', hidden: true }), h('span', { class: 'size' }), h('span', { class: 'when' })));
  inner.append(poster, body);
  link.append(inner);
  li.append(link);
  const acc = accentFor(c.id); if (acc) li.style.setProperty('--ac-rgb', rgbVar(acc));
  const chk = h('button', { type: 'button', class: 'check', role: 'checkbox', 'aria-checked': 'false', 'aria-label': 'Select clip', on: { click: e => { e.preventDefault(); toggleSel(li); } } }, icon('check'));
  li.append(chk);
  if (!trash) li.append(h('button', { type: 'button', class: 'shl', 'aria-pressed': 'false', hidden: true, on: { click: e => { e.preventDefault(); e.stopPropagation(); toggleShortlist(li._c || c); } } }, icon('star')));
  if (!trash) li.append(h('button', { type: 'button', class: 'card-more', 'aria-haspopup': 'dialog', on: { click: e => { e.preventDefault(); e.stopPropagation(); openCardSheet(li._c || c, { opener: e.currentTarget }); } } }, icon('dots')));
  li.append(h('div', { class: 'vpill', role: 'group', 'aria-label': 'Version', hidden: true }, ...VARIANTS.map(([v, label]) =>
    h('button', { type: 'button', class: 'vbtn', 'data-variant': v, 'aria-pressed': 'false', text: label, on: { click: e => { e.preventDefault(); e.stopPropagation(); setVariant(li, v); } } }))));
  if (trash) {
    li.append(h('div', { class: 'card-actions' }, h('p', { class: 'trashline', 'data-trashline': '', 'data-trashed': c.trashed_at || '', 'data-purge': c.purge_after || '' }),
      h('div', { class: 'row' }, btn('Restore', { ic: 'restore', cls: 'sm', on: () => emit('act', { type: 'restore', ids: [li._c.id] }) }),
        btn('Delete forever', { ic: 'trash', kind: 'danger', cls: 'sm', on: () => emit('act', { type: 'purge', id: li._c.id }) }))));
  }
  fillCard(li, m, c, view);
  return li;
}
// The shortlist star: a button for admin mode, a read-only mark for everyone else (and only on shortlisted moments); hidden in the trash.
function paintShl(li, c, view) {
  const b = li.querySelector('.shl'); if (!b) return;
  const on_ = view === 'library' && shortlisted(c), can = canShortlist();
  b.hidden = view !== 'library' || !(on_ || can);
  b.setAttribute('aria-pressed', String(on_)); b.classList.toggle('on', on_); b.classList.toggle('ro', !can);
  b.setAttribute('aria-disabled', String(!can));
  const t = titleOf(c);
  b.setAttribute('aria-label', can ? (on_ ? `Remove ${t} from the shortlist` : `Add ${t} to the shortlist`) : `${on_ ? 'Shortlisted' : 'Not shortlisted'}: ${t}. ${SHL_HINT}`);
  b.title = can ? (on_ ? 'Shortlisted. Click to remove' : 'Add to the shortlist') : (on_ ? 'Shortlisted. ' : '') + SHL_HINT;
}
// The poster follows the selected variant; it is only fetched again when the file changes.
function setPoster(li, c, trash) {
  const key = (c.poster || '') + '|' + (state.mediaRev.get(c.poster) || 0), poster = li.querySelector('.poster');
  if (li._pk === key) return; li._pk = key;
  poster.querySelector('img')?.remove(); poster.querySelector('.ph-ic')?.remove();
  if (!c.poster) { poster.prepend(h('span', { class: 'ph-ic' }, icon('film'))); return; }
  const img = h('img', { alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('load', () => {
    img.classList.add('loaded');
    const rgb = accentFromImage(img, c.id);
    if (rgb) li.style.setProperty('--ac-rgb', rgbVar(rgb));
  });
  img.addEventListener('error', () => img.remove());
  poster.prepend(img);
  api.loadImage(img, c.poster, { trashed: trash }).catch(() => img.remove());
}
const BARS = { strong: 3, mild: 2, none: 0 }; // reaction meter: filled bars (never colour only: the text "Reaction: x" is always next to it)
const RX_TEXT = { strong: 'Reaction: strong', mild: 'Reaction: mild', none: 'Reaction: none' };
function fillCard(li, m, c, view) {
  const q = s => li.querySelector(s), fm = view === 'library' && fmNow;
  li._m = m; li._c = c; li.dataset.id = c.id;
  setPoster(li, c, view === 'trash');
  q('.card-link').setAttribute('href', '#/clip/' + encodeURIComponent(c.id));
  q('.title').textContent = titleOf(c);
  const hook = q('.hook'); hook.textContent = c.hook || ''; hook.hidden = !c.hook;
  q('.badge.dur').textContent = dur(c.dur);
  const sc = scoreText(c.score), sb = q('.badge.score'); sb.firstChild.textContent = sc; sb.hidden = !sc;
  if (sc) sb.style.setProperty('--pct', String(Math.round(Math.min(100, Number(c.score) <= 10 ? Number(c.score) * 10 : Number(c.score)))));
  q('.ribbon').hidden = !(view === 'library' && isNew(c));
  const pc = q('.pc'); if (pc) { pc.replaceChildren(view === 'library' ? chips(c) : ''); pc.hidden = view !== 'library'; }
  paintShl(li, c, view);
  const mb = li.querySelector('.card-more'); if (mb) mb.setAttribute('aria-label', `More actions for ${titleOf(c)}`);
  { const by = q('.by'), pb = postedByOf(c); by.hidden = !pb; by.textContent = pb ? 'by ' + pb : ''; }
  q('.stream').textContent = pretty(c.stream); q('.size').textContent = human(c.size);
  const when = q('.when');
  if (view === 'library') { const ct = fm ? clippedText(c.clipped_at) : ''; when.replaceChildren(ct ? 'Clipped ' + ct : timeEl(c.added_at || c.updated_at)); } else when.replaceChildren();
  const tl = li.querySelector('.trashline'); if (tl) { tl.textContent = trashLine(c); tl.dataset.trashed = c.trashed_at || ''; tl.dataset.purge = c.purge_after || ''; }
  const sel = m.clips.every(x => state.selected.has(x.id));
  li.classList.toggle('sel', sel); q('.check').setAttribute('aria-checked', String(sel));
  // moment extras (all hidden when the clip has none of the new fields)
  const info = fm ? infoOf(m, c) : null;
  const why = q('.why'); why.textContent = info?.why || ''; why.hidden = !info?.why; if (info?.why) why.title = info.why; else why.removeAttribute('title');
  const rx = q('.rx'); const rxt = info ? RX_TEXT[info.reaction] : ''; rx.hidden = !rxt; rx.dataset.reaction = info?.reaction || '';
  if (rxt) { const n = BARS[info.reaction] || 0; rx.replaceChildren(h('span', { class: 'meter', 'aria-hidden': 'true' }, ...[1, 2, 3].map(i => h('i', { class: i <= n ? 'on' : '' }))), rxt); } else rx.replaceChildren();
  if (info?.note) rx.title = info.note; else rx.removeAttribute('title');
  li._tier = info?.tier || null; setLab(li);
  const star = q('.star'), top = info?.tier === 'A'; star.hidden = !top; star.replaceChildren();
  if (top) { star.append(icon('star'), h('span', { text: info.rank != null ? '#' + info.rank : 'Top pick' })); star.setAttribute('aria-label', info.rank != null ? `Top pick, rank ${info.rank}` : 'Top pick'); star.title = 'Top pick'; }
  q('.mdur').textContent = dur(c.dur) + (Number.isFinite(+c.size) && c.size != null ? ' · ' + human(c.size) : '');
  q('.mrow').hidden = !fm;
  li.classList.toggle('has-pair', fm && hasPair(m));
  const vp = q('.vpill'); vp.hidden = !(fm && hasPair(m));
  for (const b of vp.children) { const on_ = b.dataset.variant === variantOf(c); b.setAttribute('aria-pressed', String(on_)); b.disabled = !m.byVariant[b.dataset.variant]; b.hidden = b.dataset.variant === 'face-top' && !m.byVariant['face-top']; }  // the third version only shows on moments that have it
  vp.classList.toggle('v3', !!m.byVariant['face-top']);
  li.querySelector('.card-link').setAttribute('aria-label', `${titleOf(c)}, ${dur(c.dur)}` + (fm && hasPair(m) && variantOf(c) ? `, ${(VARIANTS.find(x => x[0] === variantOf(c)) || [0, 'with streamer'])[1].toLowerCase()} version` : ''));
}
// The small label above a card title: "Top pick" on the lead card of a ranked list, "Best clip" for any other tier A moment, nothing otherwise.
function setLab(li) { const lab = li.querySelector('.lab'); if (!lab) return; const t = li.classList.contains('lead') ? 'Top pick' : li._tier === 'A' ? 'Best clip' : ''; lab.textContent = t; lab.hidden = !t; }
// "With streamer | Clean | Face on top": the card now stands for the other clip of the moment. Play, download, the post kit and Post mode follow it.
function setVariant(li, v) {
  const m = li._m; if (!m?.byVariant[v] || li._c === m.byVariant[v]) return;
  state.variants.set(m.key, v);
  fillCard(li, m, m.byVariant[v], li.dataset.view);
  syncFeed(); announce(`${VARIANTS.find(x => x[0] === v)[1]} version selected`);
}

// Purely decorative "waveform": bar heights come from the clip id hash and its score. One <path>, no per-bar elements.
function wave(c) {
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), path = document.createElementNS(NS, 'path');
  svg.setAttribute('viewBox', '0 0 48 10'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'wave'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  let x = 7; for (const ch of String(c.id)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  const k = 0.45 + Math.min(1, (Number(c.score) || 5) / 10) * 0.55; let d = '';
  for (let i = 0; i < 16; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; const hh = (0.25 + ((x >>> 8) % 1000) / 1333) * 9 * k; d += `M${i * 3 + 1.5} ${(5 - hh / 2).toFixed(1)}v${hh.toFixed(1)}`; }
  path.setAttribute('d', d); svg.append(path); return svg;
}
function toggleSel(li) {
  const ids = li._m ? li._m.clips.map(c => c.id) : [li.dataset.id];
  if (ids.every(id => state.selected.has(id))) for (const id of ids) state.selected.delete(id); else for (const id of ids) state.selected.add(id);
  emit('selection'); refreshSel();
}
export function refreshSel() {
  for (const li of refs.grid.children) {
    if (!li._m) continue;
    const on_ = li._m.clips.every(c => state.selected.has(c.id)); li.classList.toggle('sel', on_);
    li.querySelector('.check')?.setAttribute('aria-checked', String(on_));
  }
}

let heroOn = null, fmNow = false;
// The feed Post mode walks through: exactly the cards on screen now, each with its selected variant.
const feedOf = ms => ms.map(m => pick(m, selOf(m)).id);
function syncFeed() { if (state.view === 'library' && shownMoments) state.feedIds = feedOf(shownMoments); }
let shownMoments = null;

export function update({ flip = true } = {}) {
  if (!refs.grid) return;
  const view = state.view, list = visible(view);
  const grid = refs.grid;
  const fm = folderMode(view), lv = view === 'library' ? level(view) : 'flat';
  fmNow = fm;
  // ---- model: moments (cards) and, on the home screen, folders
  let moments = [], folders = [], inFolder = [], total = 0;
  const all = fm ? buildMoments(list) : view === 'trash' || !fm ? list.map(single) : [];
  if (fm && sortKey(view) === 'rank') all.sort(momentRankCmp);
  const loading = !(view === 'trash' ? state.trashLoaded : state.loaded);
  if (lv === 'home') { folders = foldersOf(list, state.folders, state.homeSort).filter(homeKeep).map(f => ({ ...f, moments: buildMoments(f.clips) })); total = folders.reduce((n, f) => n + f.moments.length, 0); moments = all; }
  else if (lv === 'folder') {
    inFolder = all.filter(m => m.stream === state.folder);
    // A stream opens on "Best" when it has tier A moments, else on "All" (state.cat 'auto' is set by the router when a stream opens).
    if (state.cat === 'auto' && inFolder.length) state.cat = inFolder.some(m => catHas(m, 'best')) ? 'best' : 'all';
    moments = inFolder.filter(m => catHas(m, state.cat)); total = inFolder.length;
  }
  else moments = all;
  shownMoments = moments;
  const count = lv === 'home' ? folders.length : moments.length;
  grid.dataset.mode = view === 'trash' ? 'list' : fm ? 'moments' : state.mode;
  grid.classList.toggle('moments', fm); grid.classList.toggle('selecting', state.selecting);
  chrome(fm, lv, view, folders, total, inFolder);
  // skeletons / empties
  refs.skel.hidden = !loading || state.loadError; grid.hidden = loading || lv === 'home' || !moments.length; refs.fgrid.hidden = loading || lv !== 'home' || !folders.length;
  refs.empty.replaceChildren(); refs.empty.hidden = true;
  if (!loading) {
    if (state.loadError) emptyState('error', 'Could not load the vault', 'The server did not answer. Check your connection.', btn('Retry', { kind: 'primary', ic: 'restore', on: () => emit('reload') }));
    else if (!count) {
      const totalAll = listFor(view).length;
      if (view === 'trash' && !totalAll) emptyState('trash', 'Trash is empty', 'Deleted clips wait here for 30 days before they are purged.');
      else if (!totalAll) emptyState('library', 'No clips yet', canWrite() ? 'Upload your first clip to start the vault.' : 'Nothing has been added to the vault yet.', canWrite() ? btn('Upload a clip', { kind: 'primary', ic: 'upload', on: () => emit('upload') }) : null);
      else if (lv === 'folder' && !inFolder.length && !hasFilters()) emptyState('library', 'No clips in this stream', 'This stream has no clips yet.', h('a', { class: 'btn primary', href: '#/' }, 'Back to the library'));
      else if (lv === 'folder' && inFolder.length) emptyState('search', 'Nothing in this category', 'Pick another category to see the other moments.', btn('Show all', { kind: 'primary', on: () => { state.cat = 'all'; update(); } }));
      else emptyState('search', 'Nothing matches', 'Try a different word or clear the filters.', btn('Clear filters', { kind: 'primary', on: clearFilters }));
    }
  }
  // FLIP bookkeeping
  const first = new Map();
  if (flip && !state.reduced) for (const li of grid.children) if (li.dataset.key) first.set(li.dataset.key, li.getBoundingClientRect());
  const frag = document.createDocumentFragment(), keep = new Set();
  const newOnes = [];
  // "Top pick": the first card of the Best tab (ranked order) when it is a tier A moment gets the large lead layout.
  const isLead = lv === 'folder' && state.cat === 'best' && sortKey(view) === 'rank' && moments.length > 0 && infoOf(moments[0], pick(moments[0], selOf(moments[0]))).tier === 'A';
  const addCard = (m, show) => {
    const key = `${view}:${m.key}`; keep.add(key);
    let li = cache.get(key);
    const c = pick(m, selOf(m));
    if (!li) { li = makeCard(m, view); li.dataset.key = key; cache.set(key, li); newOnes.push(li); }
    else fillCard(li, m, c, view);
    if (show) frag.append(li);
    const lead = isLead && m === moments[0]; li.classList.toggle('lead', lead); setLab(li);
  };
  const groups = state.group && view === 'library' && !fm ? groupBy(list) : null;
  grid.classList.toggle('grouped', !!groups);
  if (lv === 'home') { /* folders are drawn below; the moments grid stays empty */ }
  else if (groups) { const byId = new Map(moments.map(m => [m.clips[0].id, m])); for (const [s, items] of groups) { frag.append(groupHead(s, items)); const show = !state.collapsed.has(s); for (const c of items) addCard(byId.get(c.id), show); } }
  else for (const m of moments) addCard(m, true);
  if (view === 'library') state.feedIds = lv === 'home' ? feedOf(all) : feedOf(moments); // Post mode follows exactly what the library shows right now
  for (const [k, li] of cache) if (!keep.has(k) && k.startsWith(view + ':')) { cache.delete(k); }
  grid.replaceChildren(frag);
  if (lv === 'home') drawFolders(folders);
  for (const li of newOnes) observe(li);
  for (const li of grid.children) if (!li._obs) observe(li);
  if (flip && !state.reduced && first.size) {
    for (const li of grid.children) {
      if (!li.dataset.key) continue;
      const f = first.get(li.dataset.key); if (!f || !li.classList.contains('in')) continue;
      const l = li.getBoundingClientRect(), dx = f.left - l.left, dy = f.top - l.top;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) li.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }
  // counts
  const totalClips = listFor(view).length;
  refs.count.hidden = fm; refs.count.textContent = loading ? 'Loading clips…' : list.length === totalClips ? `${totalClips} ${totalClips === 1 ? 'clip' : 'clips'}` : `Showing ${list.length} of ${totalClips} clips`;
  updateChips(); updateStats(); updateHeroPosters();
}
// Home filters (folders): D40. A folder stays when ALL ticked options hold for at least one of its clips.
export const HOME_FILTERS = [['reaction', 'Has streamer reactions', c => c.kind === 'reaction'], ['best', 'Has best picks', c => tierOf(c) === 'A']];
const homeKeep = f => [...state.homeFilter].every(k => f.clips.some(HOME_FILTERS.find(x => x[0] === k)?.[2] || (() => true)));
const hasFilters = () => !!(state.shortlistOnly || state.lang || state.homeFilter.size || state.streams.size || state.postedBy.size || state.tags.size || state.minScore || state.post !== 'any' || state.queue !== 'all');
const plural = (n, w) => `${n} ${n === 1 ? w : w + 's'}`;
// Everything that depends on the screen: which controls exist, the page heading, the category row, the Post mode button's place.
function chrome(fm, lv, view, folders, total, inFolder) {
  const lib = view === 'library';
  const showHero = lib && !fm;
  if (heroOn !== showHero) { heroOn = showHero; hero.mount(showHero ? refs.hero : null); }
  refs.hero.hidden = !showHero;
  const slot = fm ? refs.postSlot : refs.heroCta; if (refs.postBtn.parentElement !== slot) slot.prepend(refs.postBtn);
  refs.head.hidden = !(lib && fm); refs.head.dataset.lv = lv; refs.root.dataset.lv = lib && fm ? lv : '';
  refs.cats.hidden = lv !== 'folder';
  refs.postedBy.dataset.ok = lib && (!fm || lv === 'folder') ? '1' : ''; refs.postedBy.hidden = !refs.postedBy.dataset.ok || !refs.postedBy.dataset.has; refs.streams.hidden = !lib || fm; refs.qseg.hidden = !lib || fm; refs.groupB.hidden = !lib || fm; refs.seg.hidden = fm || view === 'trash'; refs.moreF.hidden = !lib;
  refs.postBtn.hidden = !lib;
  refs.sort.value = sortKey(view);
  refs.sortWrap.hidden = fm || view === 'trash';
  refs.selBtn.hidden = !canWrite() || (lib && fm && lv === 'home');
  refs.homeF.hidden = !(lib && fm && lv === 'home');
  for (const b of refs.homeF.children) b.setAttribute('aria-pressed', String(state.homeFilter.has(b.dataset.hf)));
  drawSortBar(lib && fm, lv); drawLangBar(lib && fm && (lv === 'home' || lv === 'search'));
  refs.langTag.hidden = true;
  if (!lib || !fm) return;
  const f = lv === 'folder' ? foldersOf(listFor('library'), state.folders).find(x => x.id === state.folder) : null;
  refs.back.hidden = lv === 'home';
  refs.headTitle.textContent = lv === 'home' ? 'Library' : lv === 'search' ? 'Search results' : (f?.title || pretty(state.folder));
  let sub;
  if (lv === 'home') sub = `${plural(folders.length, 'stream')} · ${plural(total, 'moment')} · ${human(folders.reduce((a, x) => a + x.clips.reduce((b, c) => b + (Number(c.size) || 0), 0), 0))}`;
  else if (lv === 'search') sub = `${plural(shownMomentsCount(), 'moment')} match "${state.q.trim()}"`;
  else sub = [f?.clipped ? 'Clipped ' + clippedText(f.clipped) : dateText(f?.date), f?.clipped && f?.date ? 'YouTube ' + dateText(f.date) : '', f?.channel, plural(total, 'moment'), human(inFolder.reduce((a, m) => a + m.clips.reduce((b, c) => b + (Number(c.size) || 0), 0), 0))].filter(x => x && x !== '—').join(' · ');
  refs.headSub.textContent = sub;
  refs.langTag.textContent = lv === 'folder' && f?.langName ? f.langName : ''; refs.langTag.hidden = !refs.langTag.textContent;
  // the stream thumbnail behind the heading (a stream page only; fetched like any poster: blob URL, token in the header)
  const tk = lv === 'folder' && f?.thumb ? f.thumb + '|' + (state.mediaRev.get(f.thumb) || 0) : '';
  if (refs.headImg._k !== tk) { refs.headImg._k = tk; refs.head.classList.remove('has-img'); refs.headImg.removeAttribute('src'); if (tk) api.loadImage(refs.headImg, f.thumb).catch(() => {}); }
  if (lv === 'folder') {
    const n = catCounts(inFolder);
    const hadFocus = refs.cats.contains(document.activeElement) ? document.activeElement.dataset.cat : null;
    refs.cats.replaceChildren(...CATS.map(([k, label]) => h('button', { type: 'button', class: 'cat', 'data-cat': k, 'aria-pressed': String(state.cat === k), on: { click: () => { state.cat = k; update({ flip: false }); announce(`${label}: ${n[k]} moments`); } } },
      h('span', { class: 'lbl', text: label }), h('span', { class: 'n', text: String(n[k]) }))));
    if (hadFocus) refs.cats.querySelector(`[data-cat="${hadFocus}"]`)?.focus();
  }
}
const HSORT = [['clipped', 'Newest clipped'], ['oldest', 'Oldest'], ['clips', 'Most clips'], ['biggest', 'Biggest']];
const FSORT = [['rank', 'Best first'], ['newest', 'Newest clipped'], ['longest', 'Longest'], ['biggest', 'Biggest']];
// The visible sort control (outside the Filter menu): built once per screen kind, afterwards only aria-pressed changes so keyboard focus stays put.
function drawSortBar(on_, lv) {
  const bar = refs.vsort; bar.hidden = !on_; if (!on_) return;
  const home = lv === 'home', opts = home ? HSORT : FSORT, kind = home ? 'home' : 'stream', cur = home ? state.homeSort : sortKey(state.view);
  if (bar.dataset.kind !== kind) {
    bar.dataset.kind = kind;
    bar.replaceChildren(...opts.map(([k, label]) => h('button', { type: 'button', class: 'sbtn', 'data-sort': k, text: label, on: { click: () => {
      if (kind === 'home') state.homeSort = k; else { state.sort = k; state.sortTouched = true; }
      update({ flip: false }); announce('Sorted: ' + label);
    } } })));
  }
  for (const b of bar.children) b.setAttribute('aria-pressed', String(b.dataset.sort === cur));
}
// Language chips (home and search): only when the library has two or more known languages. Filters folders, totals and search.
function drawLangBar(on_) {
  const bar = refs.langbar, st = langStats(state.clips, state.folders);
  const show = on_ && st.list.length >= 2; bar.hidden = !show;
  if (!show) { if (state.lang && st.list.length < 2) state.lang = ''; return; }
  const had = bar.contains(document.activeElement) ? document.activeElement.dataset.lang : null;
  const mk = (code, label, n) => h('button', { type: 'button', class: 'lbtn', 'data-lang': code, 'aria-pressed': String(state.lang === code), on: { click: () => { state.lang = code; update({ flip: false }); announce(`${label}: ${n} streams`); } } }, h('span', { class: 'lbl', text: label }), h('span', { class: 'n', text: String(n) }));
  bar.replaceChildren(mk('', 'All languages', st.by.size), ...st.list.map(l => mk(l.code, l.name, l.count)));
  if (had != null) bar.querySelector(`[data-lang="${had}"]`)?.focus();
}
const shownMomentsCount = () => (shownMoments ? shownMoments.length : 0);
function drawFolders(folders) {
  refs.fgrid.replaceChildren(...folders.map(f => {
    const secs = f.clips.reduce((a, c) => a + (Number(c.size) || 0), 0), n = f.moments.length;
    const img = h('img', { alt: '', decoding: 'async' });
    const thumb = h('div', { class: 'f-thumb' }, h('span', { class: 'ph-ic' }, icon('film')), img);
    img.addEventListener('load', () => img.classList.add('loaded')); img.addEventListener('error', () => img.remove());
    if (f.thumb) api.loadImage(img, f.thumb).catch(() => img.remove()); else img.remove();
    const date = f.clipped ? 'Clipped ' + clippedText(f.clipped) : dateText(f.date);
    const a = h('a', { class: 'folder-link', href: folderHref(f.id), draggable: 'false', 'aria-label': `${f.title}, ${plural(n, 'moment')}, ${human(secs)}${date ? ', ' + date : ''}` },
      h('span', { class: 'f-tab', 'aria-hidden': 'true', text: plural(f.clips.length, 'clip') }),
      h('span', { class: 'f-stack' }, h('span', { class: 'f-sheet s2', 'aria-hidden': 'true' }), h('span', { class: 'f-sheet s1', 'aria-hidden': 'true' }), thumb),
      h('span', { class: 'f-info' }, f.channel ? h('span', { class: 'f-ch', text: f.channel }) : null, h('span', { class: 'f-title', text: f.title }),
        h('span', { class: 'f-meta' }, date ? h('span', { class: 'f-date', text: date }) : null, h('span', { class: 'f-n', text: plural(n, 'moment') }), h('span', { class: 'f-size', text: human(secs) }), f.langName ? h('span', { class: 'f-lang', text: f.langName }) : null)));
    return h('li', { class: 'folder', 'data-stream': f.id }, a);
  }));
}
function groupBy(list) {
  const m = new Map(); for (const c of list) { const k = c.stream ?? ''; if (!m.has(k)) m.set(k, []); m.get(k).push(c); } return m;
}
const totalText = secs => { secs = Math.round(secs); const hh = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60; return hh ? `${hh} h ${mm} min` : mm ? `${mm} min ${ss} s` : `${ss} s`; };
function groupHead(s, items) {
  const open = !state.collapsed.has(s), secs = items.reduce((a, c) => a + (Number(c.dur) || 0), 0);
  const li = h('li', { class: 'group-head', 'data-stream': s }); li._obs = true;
  const t = h('button', { type: 'button', class: 'gh-toggle', 'aria-expanded': String(open), on: { click: () => {
    if (state.collapsed.has(s)) state.collapsed.delete(s); else state.collapsed.add(s);
    update({ flip: false }); requestAnimationFrame(() => [...refs.grid.querySelectorAll('.group-head')].find(x => x.dataset.stream === s)?.querySelector('.gh-toggle')?.focus());
  } } }, icon(open ? 'chevd' : 'chevu'), h('h3', { text: pretty(s) }), h('span', { class: 'gh-n', text: `${items.length} ${items.length === 1 ? 'clip' : 'clips'}` }), h('span', { class: 'gh-t', text: `· ${totalText(secs)} total` }));
  const dl = btn('Download all', { ic: 'download', cls: 'sm gh-dl', on: () => downloadAll(items, pretty(s)) });
  dl.setAttribute('aria-label', `Download all ${items.length} ${items.length === 1 ? 'clip' : 'clips'} from ${pretty(s)}`);
  li.append(t, dl); return li;
}
function observe(li) {
  li._obs = true;
  if (state.reduced) { li.classList.remove('pre'); li.classList.add('in'); return; }
  io.observe(li);
}
function emptyState(kind, title, text, action) {
  refs.empty.hidden = false;
  refs.empty.append(h('img', { class: 'empty-art', src: `/assets/empty-${kind}.svg`, alt: '', width: 200, height: 160 }), h('h3', { text: title }), h('p', { text }), action);
}
export function clearFilters() { state.shortlistOnly = false; state.lang = ''; state.homeFilter.clear(); state.cat = 'all'; state.streams.clear(); state.postedBy.clear(); state.tags.clear(); state.minScore = 0; state.q = ''; state.queue = 'all'; state.post = 'any'; refs.postF.value = 'any'; refs.q.value = ''; refs.score.value = '0'; refs.scoreVal.textContent = 'Any'; emit('filters'); update(); }

const QUEUES = [['all', 'All'], ['ready', 'Ready to post'], ['best', 'Best clips'], ['new', 'New']];
function updateQueue() {
  const n = queueCounts(), admin = isAdmin();
  refs.qseg.replaceChildren(...QUEUES.filter(([k]) => k !== 'ready' || admin).map(([k, label]) => {
    const b = h('button', { type: 'button', class: 'qbtn', 'data-q': k, 'aria-pressed': String(state.queue === k), on: { click: () => { state.queue = k; update(); announce(`${label}: ${queueCounts()[k]} clips`); } } }, h('span', { class: 'lbl', text: label }), h('span', { class: 'n', text: String(n[k]) }));
    return b;
  }));
  refs.postF.parentElement.hidden = state.view !== 'library' || !admin;
  if (!admin && state.queue === 'ready') state.queue = 'all';
  refs.groupB.setAttribute('aria-pressed', String(state.group));
  const nf = state.homeFilter.size + state.streams.size + state.postedBy.size + state.tags.size + (state.minScore > 0 ? 1 : 0) + (state.post !== 'any' ? 1 : 0) + (state.queue !== 'all' && !fmNow ? 1 : 0);
  refs.filterN.textContent = String(nf); refs.filterN.hidden = !nf; refs.filterBtn.setAttribute('aria-label', nf ? `Filter, ${nf} active` : 'Filter');
}
// "Shortlisted N" filter chip (combines with every other filter) and "Copy shortlist". Shown when something is shortlisted, the filter is on, or admin mode can star.
function updateShortlistBar() {
  const n = shortlistCount(), show = state.view === 'library' && (n > 0 || state.shortlistOnly || canShortlist());
  refs.shlRow.hidden = !show;
  const chip = refs.shlChip; chip.setAttribute('aria-pressed', String(state.shortlistOnly)); chip.classList.toggle('on', state.shortlistOnly);
  chip.querySelector('.n').textContent = String(n); refs.shlCopy.disabled = n === 0;
}
function updateChips() {
  updateQueue(); updateShortlistBar();
  const lib = listFor('library');
  const streams = new Map(), tags = new Map();
  for (const c of lib) { const s = c.stream ?? ''; streams.set(s, (streams.get(s) || 0) + 1); for (const t of tagsOf(c)) tags.set(t, (tags.get(t) || 0) + 1); }
  const mk = (set, val, label, cnt, kind) => {
    const on_ = set.has(val);
    const b = h('button', { type: 'button', class: 'chip' + (on_ ? ' on' : ''), 'aria-pressed': String(on_), on: { click: () => { if (set.has(val)) set.delete(val); else set.add(val); emit('filters'); update(); } } },
      h('span', { class: 'lbl', text: label }), h('span', { class: 'n', text: String(cnt) }));
    b.dataset.kind = kind; return b;
  };
  const all = h('button', { type: 'button', class: 'chip' + (!state.streams.size ? ' on' : ''), 'aria-pressed': String(!state.streams.size), on: { click: () => { state.streams.clear(); emit('filters'); update(); } } }, h('span', { class: 'lbl', text: 'All streams' }), h('span', { class: 'n', text: String(lib.length) }));
  refs.streams.replaceChildren(all, ...[...streams].sort((a, b) => b[1] - a[1]).map(([s, n]) => mk(state.streams, s, pretty(s), n, 'stream')));
  // "Posted by": one chip per distinct value plus Unassigned (multi-select, combines with every other filter); only shown when some clip has a value.
  const pby = new Map(); for (const c of lib) { const p = postedByOf(c); pby.set(p, (pby.get(p) || 0) + 1); }
  for (const v of [...state.postedBy]) if (!pby.has(v)) state.postedBy.delete(v);
  const pbAll = h('button', { type: 'button', class: 'chip' + (!state.postedBy.size ? ' on' : ''), 'aria-pressed': String(!state.postedBy.size), on: { click: () => { state.postedBy.clear(); emit('filters'); update(); } } }, h('span', { class: 'lbl', text: 'Anyone' }), h('span', { class: 'n', text: String(lib.length) }));
  const named = [...pby].filter(([p]) => p).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const chipsBy = named.map(([p, n]) => mk(state.postedBy, p, p, n, 'postedby'));
  if (pby.has('')) chipsBy.push(mk(state.postedBy, '', 'Unassigned', pby.get(''), 'postedby'));
  refs.postedBy.replaceChildren(...(named.length ? [h('span', { class: 'chips-lab', text: 'Posted by' }), pbAll, ...chipsBy] : []));
  refs.postedBy.dataset.has = named.length ? '1' : '';
  refs.postedBy.hidden = !refs.postedBy.dataset.ok || !named.length;   // the chrome step ran first and set dataset.ok (library list or inside a stream; not the stream cards)
  const top = [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24);
  refs.tags.replaceChildren(...top.map(([t, n]) => mk(state.tags, t, '#' + t.replace(/^#/, ''), n, 'tag')));
  const max = Math.max(10, ...lib.map(c => Number(c.score) || 0));
  const top10 = max <= 10 ? 10 : Math.ceil(max / 10) * 10;
  if (refs.score.max !== String(top10)) refs.score.max = String(top10);
  refs.scoreVal.textContent = state.minScore ? '≥ ' + state.minScore : 'Any';
}
let statKey = '';
function updateStats() {
  if (!state.loaded) return; // never animate placeholder zeros
  const lib = listFor('library'), secs = lib.reduce((a, c) => a + (Number(c.dur) || 0), 0), bytes = lib.reduce((a, c) => a + (Number(c.size) || 0), 0);
  const key = `${lib.length}|${secs}|${bytes}|${lib.filter(c => postState(c) === 'none').length}`; if (key === statKey) return; statKey = key;
  countTo(refs.stClips, lib.length, v => String(Math.round(v)));
  countTo(refs.stTime, secs / 60, v => Math.round(v) + ' min');
  countTo(refs.stSize, bytes / 1e6, v => v >= 1000 ? (v / 1000).toFixed(2) + ' GB' : Math.round(v) + ' MB');
  countTo(refs.stReady, lib.filter(c => postState(c) === 'none').length, v => String(Math.round(v)));
}
// Counters ease up to the real value, but they ALWAYS settle on it: a timer writes the final text even if animation frames are starved,
// and reduced motion (or a hidden tab) shows the value at once.
function countTo(el, to, f) {
  clearTimeout(el._t); el._tok = (el._tok || 0) + 1; const tok = el._tok, from = el._v ?? 0, D = 700; el._v = to;
  const fin = () => { if (el._tok === tok) el.textContent = f(to); };
  if (state.reduced || document.hidden || from === to) { fin(); return; }
  const t0 = performance.now();
  const step = () => { if (el._tok !== tok) return; const k = Math.min(1, (performance.now() - t0) / D), e = 1 - Math.pow(1 - k, 3); el.textContent = f(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step); el._t = setTimeout(fin, D + 120);
}
let posterKey = '';
function updateHeroPosters() {
  const urls = listFor('library').map(c => c.poster && api.directMediaUrl(c.poster) ? c.poster : null).filter(Boolean).slice(0, 10);
  const k = urls.join('|'); if (k === posterKey) return; posterKey = k; hero.setPosters(urls);
}

export function build(root) {
  const q = h('input', { type: 'search', id: 'q', class: 'search-in', placeholder: 'Search title, hook, tags…', 'aria-label': 'Search clips', autocomplete: 'off', spellcheck: 'false', on: { input: e => { state.q = e.target.value; update(); } } });
  const sort = h('select', { id: 'sort', 'aria-label': 'Sort clips', on: { change: e => { state.sort = e.target.value; state.sortTouched = true; update(); } } },
    ...[['rank', 'Best first'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['longest', 'Longest'], ['biggest', 'Biggest file'], ['score', 'Top score']].map(([v, l]) => h('option', { value: v, text: l })));
  const modeG = btn('', { ic: 'grid', kind: 'ghost', cls: 'icon', aria: 'Grid view', on: () => setMode('grid') }), modeL = btn('', { ic: 'list', kind: 'ghost', cls: 'icon', aria: 'List view', on: () => setMode('list') });
  modeG.setAttribute('aria-pressed', 'true'); modeL.setAttribute('aria-pressed', 'false');
  const selBtn = btn('Select', { ic: 'select', kind: 'ghost', cls: 'sel-btn', on: () => { state.selecting = !state.selecting; if (!state.selecting) state.selected.clear(); emit('selection'); update({ flip: false }); } });
  selBtn.setAttribute('aria-pressed', 'false');
  const score = h('input', { type: 'range', min: 0, max: 10, step: 1, value: 0, id: 'minscore', 'aria-label': 'Minimum score', on: { input: e => { state.minScore = Number(e.target.value); update(); } } });
  const scoreVal = h('output', { for: 'minscore', text: 'Any' });
  const moreF = h('details', { class: 'more-f' }, h('summary', { text: 'Tags and score' }), h('div', { class: 'chips', id: 'tagchips', role: 'group', 'aria-label': 'Tag filters' }), h('label', { class: 'scoreRow' }, h('span', { text: 'Min score' }), score, scoreVal));
  const stClips = h('b', { text: '–' }), stTime = h('b', { text: '–' }), stSize = h('b', { text: '–' }), stReady = h('b', { text: '–' });
  const postBtn = btn('Post mode', { ic: 'send', kind: 'primary', cls: 'post-btn', on: () => { const ids = state.feedIds.length ? state.feedIds : visible().map(c => c.id); if (!ids.length) { announce('No clips to post'); return; } startPost(ids[0], ids, postBtn); } }); postBtn.id = 'post-mode-btn';
  const heroEl = h('section', { class: 'lib-hero' },
    h('div', { class: 'lib-hero-in' },
      h('div', { class: 'lh-main' },
        h('p', { class: 'eyebrow', text: 'Private vault' }),
        h('h1', { class: 'display' }, 'Every clip, ', h('span', { class: 'grad', text: 'one place' }), '.'),
        h('div', { class: 'stats' }, h('div', null, stClips, h('span', { text: 'clips' })), h('div', { class: 'st-ready' }, stReady, h('span', { text: 'ready to post' })), h('div', null, stTime, h('span', { text: 'of footage' })), h('div', null, stSize, h('span', { text: 'in the vault' })))),
      h('div', { class: 'lh-cta' }, postBtn, h('p', { class: 'lh-sub', text: 'Swipe through clips and copy the post kit.' }))));
  const heroCta = heroEl.querySelector('.lh-cta');
  const qseg = h('div', { class: 'qseg', role: 'group', 'aria-label': 'Queue' });
  const postF = h('select', { id: 'postfilter', 'aria-label': 'Posting status', on: { change: e => { state.post = e.target.value; update(); } } },
    ...[['any', 'Any posting status'], ['none', 'Not posted anywhere'], ['yt', 'Posted on YouTube only'], ['ig', 'Posted on Instagram only'], ['both', 'Posted on both']].map(([v, l]) => h('option', { value: v, text: l })));
  const groupB = btn('Group', { ic: 'layers', kind: 'ghost', cls: 'group-btn', on: () => { state.group = !state.group; update(); announce(state.group ? 'Grouped by stream' : 'Ungrouped'); } }); groupB.id = 'group-btn'; groupB.setAttribute('aria-pressed', 'false');
  const shlChip = h('button', { type: 'button', class: 'chip shl-chip', id: 'shl-chip', 'aria-pressed': 'false', on: { click: () => { state.shortlistOnly = !state.shortlistOnly; update({ flip: false }); announce(`Shortlisted: ${state.shortlistOnly ? 'on' : 'off'}, ${shortlistCount()} moments`); } } }, icon('star'), h('span', { class: 'lbl', text: 'Shortlisted' }), h('span', { class: 'n', text: '0' }));
  const shlCopy = btn('Copy shortlist', { ic: 'copy', kind: 'ghost', cls: 'sm shl-copy', on: e => copyShortlist(e.currentTarget) }); shlCopy.id = 'shl-copy';
  const shlRow = h('div', { class: 'shl-row', role: 'group', 'aria-label': 'Shortlist', hidden: true }, shlChip, shlCopy);
  const tabsEl = h('nav', { class: 'tabs', 'aria-label': 'Sections', hidden: true });
  const filterN = h('span', { class: 'n', hidden: true, 'aria-hidden': 'true' });
  const filterBtn = h('button', { type: 'button', id: 'filter-btn', class: 'btn filter-btn', 'aria-expanded': String(state.filterOpen), 'aria-controls': 'filter-panel', on: { click: () => setFilterOpen(!state.filterOpen) } }, icon('layers'), h('span', { class: 'lbl', text: 'Filter' }), filterN);
  const postSlot = h('div', { class: 'post-slot' });
  const vsort = h('div', { class: 'vsort', id: 'vsort', role: 'group', 'aria-label': 'Sort', hidden: true });
  const langbar = h('div', { class: 'langbar', id: 'langbar', role: 'group', 'aria-label': 'Language', hidden: true });
  const homeF = h('div', { class: 'home-f', role: 'group', 'aria-label': 'Filter streams', hidden: true }, ...HOME_FILTERS.map(([k, label]) => h('button', { type: 'button', class: 'chip hf-chip', 'data-hf': k, 'aria-pressed': 'false', on: { click: e => { if (state.homeFilter.has(k)) state.homeFilter.delete(k); else state.homeFilter.add(k); e.currentTarget.setAttribute('aria-pressed', String(state.homeFilter.has(k))); update({ flip: false }); announce(`${label}: ${state.homeFilter.has(k) ? 'on' : 'off'}`); } } }, h('span', { class: 'lbl', text: label }))));
  const tools = h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search'), q, h('button', { type: 'button', class: 'kbd', 'aria-label': 'Open command palette', on: { click: () => openPalette() } }, h('kbd', { text: /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K' }))),
    h('div', { class: 'tool-actions' }, filterBtn, postSlot));
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, modeG, modeL);
  const sortWrap = h('label', { class: 'sel-wrap' }, h('span', { class: 'sr', text: 'Sort' }), sort);
  const toolRow = h('div', { class: 'tool-row' }, sortWrap, h('label', { class: 'sel-wrap post-wrap' }, h('span', { class: 'sr', text: 'Posting status' }), postF), seg, groupB, selBtn);
  const streams = h('div', { class: 'chips scroll', role: 'group', 'aria-label': 'Stream filters' });
  const postedBy = h('div', { class: 'chips scroll', role: 'group', 'aria-label': 'Posted by filters' });
  const trashBar = h('div', { class: 'trash-bar', hidden: true }, h('p', { class: 'trash-note', text: 'Deleted clips stay here for 30 days, then they are purged for good.' }),
    btn('Empty trash', { kind: 'danger', ic: 'trash', on: () => emit('act', { type: 'empty' }) }));
  const count = h('p', { class: 'count', 'aria-live': 'polite' });
  const skel = h('ul', { class: 'grid skel', 'aria-hidden': 'true' }, ...Array.from({ length: 10 }, () => h('li', { class: 'card sk' }, h('div', { class: 'card-in' }, h('div', { class: 'poster' })))));
  const grid = h('ul', { class: 'grid', 'data-mode': 'grid', 'aria-label': 'Clips' });
  const empty = h('div', { class: 'empty', hidden: true });
  const back = h('a', { class: 'back-link', href: '#/' }, icon('back'), h('span', { text: 'Library' }));
  const headTitle = h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' }), headSub = h('p', { class: 'page-sub', 'aria-live': 'polite' });
  const headImg = h('img', { class: 'ph-img', alt: '', decoding: 'async' });
  headImg.addEventListener('load', () => refs.head.classList.add('has-img')); headImg.addEventListener('error', () => refs.head.classList.remove('has-img'));
  const langTag = h('span', { class: 'lang-tag', hidden: true });
  const head = h('header', { class: 'page-head', hidden: true }, headImg, back, headTitle, headSub, langTag);
  const cats = h('div', { class: 'cats', role: 'group', 'aria-label': 'Categories', hidden: true });
  const fgrid = h('ul', { class: 'folder-grid', 'aria-label': 'Streams', hidden: true });
  const panel = h('section', { class: 'filter-panel', id: 'filter-panel', 'aria-label': 'Filters', hidden: !state.filterOpen }, homeF, toolRow, qseg, streams, postedBy, moreF);
  root.append(heroEl, tabsEl, head, tools, vsort, langbar, shlRow, panel, trashBar, count, cats, skel, fgrid, grid, empty);
  refs = { shlRow, shlChip, shlCopy, vsort, langbar, homeF, sortWrap, langTag, root, headImg, grid, fgrid, cats, head, back, headTitle, headSub, panel, filterBtn, filterN, postBtn, postSlot, heroCta, seg, toolRow, skel, empty, count, q, streams, postedBy, tags: moreF.querySelector('#tagchips'), moreF, score, scoreVal, modeG, modeL, selBtn, tabs: tabsEl, hero: heroEl, tools, trashBar, stClips, stTime, stSize, stReady, sort, qseg, postF, groupB };

  io = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) {
      io.unobserve(e.target); const d = (revealN++ % 10) * 45; e.target.style.setProperty('--d', d + 'ms');
      e.target.classList.add('in'); e.target.classList.remove('pre');
    }
    revealN = Math.max(0, revealN - es.length);
  }, { rootMargin: '0px 0px -4% 0px' });

  // 3D tilt + specular highlight (delegated; touch gets a subtler tilt)
  let tiltRaf = 0, last = null;
  grid.addEventListener('pointermove', e => {
    if (state.reduced || grid.dataset.mode === 'list' || grid.dataset.mode === 'moments') return;
    const li = e.target.closest('.card'); if (!li) return; last = { li, x: e.clientX, y: e.clientY, k: e.pointerType === 'mouse' ? 1 : 0.4 };
    if (tiltRaf) return;
    tiltRaf = requestAnimationFrame(() => {
      tiltRaf = 0; if (!last) return; const r = last.li.getBoundingClientRect(), px = (last.x - r.left) / r.width, py = (last.y - r.top) / r.height;
      last.li.style.setProperty('--rx', ((0.5 - py) * 12 * last.k).toFixed(2) + 'deg'); last.li.style.setProperty('--ry', ((px - 0.5) * 14 * last.k).toFixed(2) + 'deg');
      last.li.style.setProperty('--mx', (px * 100).toFixed(1) + '%'); last.li.style.setProperty('--my', (py * 100).toFixed(1) + '%'); last.li.classList.add('tilt');
    });
  });
  const reset = e => { const li = e.target.closest?.('.card'); if (li) { li.style.setProperty('--rx', '0deg'); li.style.setProperty('--ry', '0deg'); li.classList.remove('tilt'); } };
  grid.addEventListener('pointerout', reset); grid.addEventListener('pointercancel', reset);
  // the hero aurora takes on the colour of the card you are looking at
  let aurLi = null; const aur = e => { const li = e.target.closest?.('.card'); if (!li || li === aurLi) return; aurLi = li; const a = accentFor(li.dataset.id); if (a) setAurora(a); };
  grid.addEventListener('pointerover', aur); grid.addEventListener('focusin', aur);
  // long-press (touch, pen or mouse) or right-click / Android long-press menu opens the quick-action sheet
  let lp = null, lpT = 0, suppress = false;
  const cancelLp = () => { clearTimeout(lpT); lp = null; };
  const quick = (li, why) => { if (!li?._c || li.dataset.view === 'trash' || state.selecting) return; suppress = true; setTimeout(() => { suppress = false; }, 800); haptic(15); openCardSheet(li._c, { opener: li.querySelector('.card-link') }); };
  grid.addEventListener('pointerdown', e => {
    if (e.button !== 0 || state.selecting || e.target.closest('.card-more,.check,.card-actions,.group-head,.vpill,.shl')) return;
    const li = e.target.closest('.card'); if (!li) return;
    lp = { x: e.clientX, y: e.clientY }; clearTimeout(lpT); lpT = setTimeout(() => { if (lp) { lp = null; quick(li); } }, 520);
  });
  grid.addEventListener('pointermove', e => { if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancelLp(); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) grid.addEventListener(ev, cancelLp);
  grid.addEventListener('contextmenu', e => { const li = e.target.closest('.card'); if (!li || li.dataset.view === 'trash') return; e.preventDefault(); cancelLp(); quick(li); });
  grid.addEventListener('click', e => { if (suppress) { suppress = false; e.preventDefault(); e.stopPropagation(); } }, true);
  grid.addEventListener('click', e => { const a = e.target.closest('.card-link'); if (a && !state.selecting && !e.defaultPrevented) motion.markSource(a.closest('.card')?.querySelector('.poster')); });
  // selection mode: clicking a card toggles it
  grid.addEventListener('click', e => {
    if (!state.selecting) return; const li = e.target.closest('.card'); if (!li) return;
    if (e.target.closest('.card-actions')) return;
    if (e.target.closest('.vpill')) return;
    e.preventDefault(); toggleSel(li);
  });
  // keyboard navigation between cards
  grid.addEventListener('keydown', e => {
    const k = e.key; if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(k)) return;
    const link = e.target.closest?.('.card-link'); if (!link) return;
    const items = [...grid.querySelectorAll('.card-link')], i = items.indexOf(link); let j = i;
    const list = grid.dataset.mode === 'list';
    if (k === 'Home') j = 0; else if (k === 'End') j = items.length - 1;
    else if (k === 'ArrowRight' || (list && k === 'ArrowDown')) j = i + 1;
    else if (k === 'ArrowLeft' || (list && k === 'ArrowUp')) j = i - 1;
    else { const r = link.getBoundingClientRect(), dir = k === 'ArrowDown' ? 1 : -1; let best = null, bd = 1e9;
      items.forEach((o, n) => { const b = o.getBoundingClientRect(); if ((b.top - r.top) * dir > 10) { const d = Math.abs(b.top - r.top) * 4 + Math.abs(b.left - r.left); if (d < bd) { bd = d; best = n; } } }); if (best != null) j = best; }
    if (j !== i && items[j]) { e.preventDefault(); items[j].focus(); items[j].scrollIntoView({ block: 'nearest' }); }
  });
  return refs;
}
function setMode(m) {
  state.mode = m; refs.modeG.setAttribute('aria-pressed', String(m === 'grid')); refs.modeL.setAttribute('aria-pressed', String(m === 'list')); update();
}
export function setView(view, me) {
  refs.trashBar.hidden = view !== 'trash';
  refs.postedBy.hidden = view !== 'library' || !refs.postedBy.dataset.has; refs.streams.hidden = view !== 'library'; refs.moreF.hidden = view !== 'library'; refs.qseg.hidden = view !== 'library';
  refs.groupB.hidden = view !== 'library'; refs.panel.querySelector('.post-wrap').hidden = view !== 'library' || !isAdmin();
  refs.selBtn.hidden = !canWrite();
  refs.panel.querySelector('.tool-row .sel-wrap').hidden = view === 'trash';
  refs.selBtn.querySelector('.lbl').textContent = state.selecting ? 'Done' : 'Select';
  refs.selBtn.setAttribute('aria-pressed', String(state.selecting));
  heroOn = null;
  update({ flip: false });
}
export const getRefs = () => refs;
// The Filter button opens one panel with sort, posting status, view, grouping, tags and the admin Select mode.
export function setFilterOpen(open) { state.filterOpen = !!open; refs.panel.hidden = !open; refs.filterBtn.setAttribute('aria-expanded', String(!!open)); }
// Ids of every clip the library is showing now (Select all, Post mode).
export const shownIds = () => (shownMoments && state.view === 'library' && folderMode() ? shownMoments.flatMap(m => m.clips.map(c => c.id)) : visible().map(c => c.id));
// Move keyboard focus to the new page heading (after opening a stream) or back to the stream's folder card.
export function focusHeading() { requestAnimationFrame(() => (refs.head.hidden ? null : refs.headTitle.focus({ preventScroll: true }))); }
export function focusFolder(id) { requestAnimationFrame(() => { const a = [...refs.fgrid.querySelectorAll('.folder')].find(x => x.dataset.stream === id)?.querySelector('a'); if (a) a.focus({ preventScroll: false }); }); }
export function focusFirst() { refs.grid.querySelector('.card-link')?.focus(); }
export function dropCard(id) { for (const [k, li] of [...cache]) if (k.endsWith(':' + id) || li._m?.clips.some(c => c.id === id)) cache.delete(k); }
export function resetCards() { cache.clear(); posterKey = ''; statKey = ''; }
