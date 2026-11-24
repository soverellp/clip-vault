// POST MODE: a full-screen vertical feed (swipe / wheel / keys) with a docked post kit. One <video> at a time; only the next poster is preloaded.
import { state, on, findClip, canWrite, backHash } from './state.js';
import { h, btn, icon, setIcon } from './dom.js';
import * as api from './api.js';
import { accentFor, accentFromImage, rgbVar, setAurora } from './color.js';
import { announce, trapFocus, isTyping } from './a11y.js';
import { toast } from './toast.js';
import { titleOf, dur } from './fmt.js';
import { postedControl } from './postedui.js';
import { kitOf, joinKit, copyText, downloadClip, chips, toggleBtn, PLATFORMS } from './kit.js';
import { countOf } from './post.js';
import * as motion from './kit.js';
import { openShortcuts } from './shortcuts.js';
import { playlistsNav } from './plui.js';
import { momentKey } from './shortlist.js';
import { combosOf, comboOf } from './playlists.js';
import { versionSelect } from './vsel.js';
import { writePlPref } from './viewpref.js';

let dlg, feed, ctr, bMute, bSafe, sheet, handle, bar, kitEl;
let ids = [], S = [], idx = -1, muted = true, safeOn = false, sheetOpen = false, playTimer = 0, raf = 0, opener = null, pendingIds = null, opening = false;
let vals = new Map(), toggles = [], kit = null, curChips = null;
const back = () => (location.hash = backHash());

// Called by cards, the drawer and the action sheet. `list` = ids in feed order (defaults to the library as filtered right now).
export function startPost(id, list, srcEl) {
  pendingIds = Array.isArray(list) && list.includes(id) ? list.slice() : null;
  opener = srcEl?.closest?.('a,button') || srcEl || null;
  const poster = srcEl?.closest?.('.card')?.querySelector('.poster') || srcEl?.closest?.('.drawer')?.querySelector('.phone');
  if (poster) motion.markSource(poster);
  location.hash = '#/post/' + encodeURIComponent(id);
}
export const isOpen = () => !!dlg?.open;
export const currentId = () => (dlg?.open ? ids[idx] : null);

function build() {
  const close = btn('', { ic: 'x', cls: 'icon glass pm-close', aria: 'Close post mode', on: () => back() });
  ctr = h('span', { class: 'pm-ctr glass', 'aria-hidden': 'true' });
  bMute = btn('', { ic: 'mute', cls: 'icon glass pm-mute', aria: 'Unmute', on: () => setMuted(!muted) }); bMute.setAttribute('aria-pressed', 'false');
  bSafe = btn('', { ic: 'shield', cls: 'icon glass pm-safe', aria: 'Safe zone overlay', title: 'Safe zone (S)', on: () => setSafe(!safeOn) }); bSafe.setAttribute('aria-pressed', 'false');
  const help = btn('', { ic: 'help', cls: 'icon glass', aria: 'Keyboard shortcuts', on: () => openShortcuts() });
  feed = h('div', { class: 'pm-feed', role: 'list', 'aria-label': 'Clips' });
  handle = h('button', { type: 'button', class: 'pm-handle', 'aria-expanded': 'false', 'aria-controls': 'pm-kit', 'aria-label': 'Show the full post kit' }, h('i'));
  bar = h('div', { class: 'pm-bar' });
  kitEl = h('div', { class: 'pm-kit', id: 'pm-kit' });
  sheet = h('aside', { class: 'pm-sheet', 'data-open': 'false', 'aria-label': 'Post kit' }, handle, bar, kitEl);
  dlg = h('dialog', { class: 'pm', tabindex: '-1', 'aria-label': 'Post mode', 'aria-modal': 'true' },
    h('div', { class: 'pm-aur', 'aria-hidden': 'true' }, h('i'), h('i')),
    h('div', { class: 'pm-top' }, close, h('span', { class: 'grow' }), ctr, playlistsNav('glass pm-pl'), bSafe, bMute, help), feed, sheet);
  document.getElementById('dialogs').append(dlg);
  trapFocus(dlg);
  dlg.addEventListener('cancel', e => { e.preventDefault(); back(); });
  dlg.addEventListener('keydown', onKey);
  let y0 = null, dragged = false;
  handle.addEventListener('pointerdown', e => { y0 = e.clientY; dragged = false; });
  handle.addEventListener('pointerup', e => { if (y0 == null) return; const dy = e.clientY - y0; y0 = null; if (Math.abs(dy) > 28) { dragged = true; setSheet(dy < 0); } });
  handle.addEventListener('click', () => { if (dragged) { dragged = false; return; } setSheet(!sheetOpen); });
  feed.addEventListener('scroll', onScroll, { passive: true });
  let lastH = 0; new ResizeObserver(() => { const H = feed.clientHeight; if (dlg.open && idx >= 0 && H && H !== lastH) { if (lastH) feed.scrollTop = idx * H; lastH = H; } }).observe(feed);
  document.addEventListener('visibilitychange', () => { const v = S[idx]?.video; if (!v) return; if (document.hidden) v.pause(); else if (!S[idx].userPaused) v.play().catch(() => {}); });
  on('clips', onClips);
  on('lowpower', () => { if (dlg.open && !state.lowPower) ensurePoster(idx + 1); });
}

export function open(id, before) {
  if (opening) return;
  if (!dlg) build();
  if (dlg.open) { const i = ids.indexOf(id); if (i >= 0 && i !== idx) go(i, true); return; }
  ids = pendingIds && pendingIds.includes(id) ? pendingIds : (state.feedIds?.includes(id) ? state.feedIds.slice() : state.clips.map(c => c.id));
  pendingIds = null; ids = ids.filter(x => findClip(x));
  const i0 = ids.indexOf(id); if (i0 < 0) return;
  opening = true;
  motion.transition(vt => {
    before?.(); mount(i0); dlg.classList.toggle('vt', vt); if (vt) setTimeout(() => dlg.classList.remove('vt'), 900);
    dlg.showModal(); document.body.classList.add('locked');
    feed.scrollTop = i0 * feed.clientHeight; activate(i0, true);
    opening = false;
  }, () => S[idx]?.stage);
  setTimeout(() => { opening = false; }, 2000);
}
export function close() {
  if (!dlg?.open) return;
  clearTimeout(playTimer); S.forEach((_, i) => detach(i)); S = []; idx = -1; ids = [];
  feed.replaceChildren(); dlg.close();
  if (!document.querySelector('dialog[open]')) document.body.classList.remove('locked');
  setAurora(null); dlg.style.removeProperty('--py');
  if (opener?.isConnected) opener.focus?.(); opener = null;
}

function mount(start) {
  S = ids.map((id, i) => {
    const c = findClip(id);
    const stage = h('div', { class: 'pm-stage' }), el = h('div', { class: 'pm-slide', role: 'listitem', 'aria-label': `Clip ${i + 1} of ${ids.length}: ${titleOf(c)}`, 'data-id': id, 'data-i': i }, stage);
    el.inert = true; return { c, el, stage, done: false };
  });
  feed.replaceChildren(...S.map(s => s.el));
  dlg.dataset.n = String(ids.length);
  muted = true; setMuted(true, true); idx = start;
}
function hydrate(i) {
  const s = S[i]; if (!s || s.done) return; s.done = true;
  const c = s.c;
  s.img = h('img', { class: 'pm-poster', alt: '', decoding: 'async', draggable: 'false' });
  s.img.addEventListener('load', () => {
    s.el.classList.add('ready');
    const rgb = accentFor(c.id) || accentFromImage(s.img, c.id);
    if (rgb) { s.el.style.setProperty('--ac-rgb', rgbVar(rgb)); if (i === idx) paint(); }
  });
  s.img.addEventListener('error', () => s.el.classList.add('ready', 'noimg'));
  s.prog = h('i', { class: 'pm-prog' }); s.msg = h('p', { class: 'pm-msg', role: 'status', hidden: true });
  const tap = h('button', { type: 'button', class: 'pm-tap', 'aria-label': 'Play, pause or turn the sound on', on: { click: () => tapped(i) } });
  s.stage.append(s.img, h('div', { class: 'safe', 'aria-hidden': 'true' }, h('i', { class: 'safe-b' }, h('b', { text: 'Bottom 20%: app UI' })), h('i', { class: 'safe-r' }, h('b', { text: 'Right 15%' }))),
    tap, h('span', { class: 'pm-glyph', 'aria-hidden': 'true' }, icon('play')), h('span', { class: 'pm-hint', 'aria-hidden': 'true', text: 'Tap for sound' }), s.msg, s.prog);
  if (!c.poster) s.el.classList.add('ready', 'noimg');
}
function ensurePoster(i) {
  const s = S[i]; if (!s) return; hydrate(i);
  if (s.posterLoaded || !s.c.poster) return; s.posterLoaded = true;
  api.loadImage(s.img, s.c.poster).catch(() => s.el.classList.add('ready', 'noimg'));
}

function activate(i, first) {
  clearTimeout(playTimer);
  if (idx !== i || first) { const prev = idx; idx = i; if (prev >= 0 && prev !== i) detach(prev); }
  S.forEach((s, k) => { s.el.inert = k !== i; s.el.classList.toggle('active', k === i); });
  if (document.activeElement?.closest?.('.pm-slide') || document.activeElement === document.body) dlg.focus({ preventScroll: true }); // focus must not be lost inside a slide that just became inert
  for (const k of [i - 1, i, i + 1]) hydrate(k);
  ensurePoster(i); if (!state.lowPower) ensurePoster(i + 1); // only the next POSTER is preloaded, never the next mp4
  const c = S[i].c;
  ctr.textContent = `${i + 1} / ${ids.length}`;
  renderSheet(c); paint();
  try { history.replaceState(null, '', '#/post/' + encodeURIComponent(c.id)); } catch { /* ignore */ }
  document.title = titleOf(c) + ' - Post mode';
  announce(`Clip ${i + 1} of ${ids.length}: ${titleOf(c)}`);
  playTimer = setTimeout(() => attach(i), state.reduced ? 0 : 220);
}
function paint() {
  const s = S[idx]; if (!s) return;
  const rgb = accentFor(s.c.id); if (rgb) { dlg.style.setProperty('--ac-rgb', rgbVar(rgb)); setAurora(rgb); }
  dlg.style.setProperty('--ph', String([...s.c.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7)));
}
function onScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0; const H = feed.clientHeight || 1, f = feed.scrollTop / H, i = Math.round(f);
    if (!state.reduced && !state.lowPower) dlg.style.setProperty('--py', (f - idx).toFixed(3)); // parallax of the aurora; off for reduced motion / low power
    if (i !== idx && i >= 0 && i < ids.length) activate(i);
  });
}
// Rapid key presses stack: each one counts from the clip we are already scrolling to, not from the one still on screen.
let want = null, wantT = 0;
const step = d => go((want ?? idx) + d);
function go(n, instant) {
  const t = Math.min(ids.length - 1, Math.max(0, n)); if (t === (want ?? idx) && !instant) return;
  want = t; clearTimeout(wantT); wantT = setTimeout(() => { want = null; }, state.reduced || instant ? 0 : 800);
  feed.scrollTo({ top: t * feed.clientHeight, behavior: state.reduced || instant ? 'instant' : 'smooth' });
}

// ---- video: exactly one element, created for the active slide only -----------------------------------
function attach(i) {
  const s = S[i]; if (!s || i !== idx || s.video) return;
  if (!s.c.video) { s.msg.hidden = false; s.msg.textContent = 'This clip has no video file.'; return; }
  const v = h('video', { playsinline: '', loop: '', preload: 'metadata', 'aria-label': 'Clip video' }); v.muted = muted; s.video = v; s.userPaused = false;
  s.stage.insertBefore(v, s.img.nextSibling);
  v.addEventListener('playing', () => { s.el.classList.add('playing'); s.el.classList.remove('paused'); });
  v.addEventListener('pause', () => { if (!v.ended) s.el.classList.add('paused'); });
  v.addEventListener('timeupdate', () => { if (v.duration) s.prog.style.setProperty('--p', (v.currentTime / v.duration).toFixed(4)); });
  v.addEventListener('error', () => { s.msg.hidden = false; s.msg.textContent = "This video can't be played here. You can still download it."; });
  api.fetchMedia(s.c.video).then(m => { if (s.video !== v) { m.revoke(); return; } s.media = m; v.src = m.url; v.play().catch(() => s.el.classList.add('paused')); })
    .catch(e => { s.msg.hidden = false; s.msg.textContent = api.errorText(e); });
}
function detach(i) {
  const s = S[i]; if (!s || !s.video) return;
  const v = s.video; s.video = null;
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
  v.remove(); s.media?.revoke(); s.media = null; s.el.classList.remove('playing', 'paused'); s.prog?.style.setProperty('--p', '0');
}
function tapped(i) {
  const s = S[i], v = s?.video; if (!v) return;
  if (muted) { setMuted(false); return; }
  if (v.paused) { s.userPaused = false; v.play().catch(() => {}); } else { s.userPaused = true; v.pause(); }
}
function setMuted(m, quiet) {
  muted = m; dlg.classList.toggle('muted', m);
  for (const s of S) if (s.video) s.video.muted = m;
  setIcon(bMute, m ? 'mute' : 'volume'); bMute.setAttribute('aria-label', m ? 'Unmute' : 'Mute'); bMute.setAttribute('aria-pressed', String(!m));
  if (!quiet) announce(m ? 'Muted' : 'Sound on');
}
function setSafe(v) { safeOn = v; dlg.classList.toggle('safe-on', v); bSafe.setAttribute('aria-pressed', String(v)); }
function setSheet(v) { sheetOpen = v; sheet.dataset.open = String(v); handle.setAttribute('aria-expanded', String(v)); handle.setAttribute('aria-label', v ? 'Hide the full post kit' : 'Show the full post kit'); }

// ---- the docked post kit -------------------------------------------------------------------------------
function renderSheet(c) {
  kit = kitOf(c); vals = new Map(); toggles = [];
  const get = f => vals.get(f) ?? f.value;
  const copyAll = (sec, name) => btn(`Copy ${name}`, { ic: 'copy', cls: 'sm mag', aria: `Copy all for ${name}`, title: `Copy all for ${name}`, on: e => copyText(joinKit(sec, get), `${name} kit copied`, e.currentTarget) });
  const dl = btn('', { ic: 'download', cls: 'sm icon', aria: 'Download clip', title: 'Download (D)', on: () => downloadClip(findClip(c.id) || c) }); dl.id = 'pm-dl';
  const row1 = h('div', { class: 'pm-row' }, copyAll(kit.yt, 'YouTube'), copyAll(kit.ig, 'Instagram'), dl);
  curChips = chips(c);
  const row2 = h('div', { class: 'pm-row pm-posted' });
  { const ctl = postedControl(c, { cls: 'pm-po' }); toggles = [ctl.chipBtn('youtube'), ctl.chipBtn('instagram')]; row2.append(ctl); }
  const vm = combosOf(momentKey(c), state.clips);
  const vsel = vm.size > 1 ? versionSelect({ combos: [...vm.keys()], current: comboOf(c), cls: 'vs-pm', aria: 'Version of this clip', onPick: (k, how) => swapVersion(vm.get(k), k, how) }) : null;
  bar.replaceChildren(h('div', { class: 'pm-meta' }, h('h2', { class: 'pm-title', lang: 'hi-Latn', text: titleOf(c) }), h('span', { class: 'pm-sub', text: `${dur(c.dur)}${c.score != null ? ' · score ' + c.score : ''}` }), canWrite() ? curChips : null), ...(vsel ? [vsel.el] : []), row1, row2);
  const secs = [kit.yt, kit.ig].filter(s => s.fields.length).map(sec => h('section', { class: 'pk-sec', 'data-kind': sec.kind }, h('h3', { text: sec.name === 'YouTube' ? 'YouTube Shorts' : 'Instagram Reels' }), ...sec.fields.map(f => field(f))));
  kitEl.replaceChildren(...(secs.length ? secs : [h('p', { class: 'muted', text: 'No post text for this clip yet.' })]));
  kitEl.scrollTop = 0;
}
// Version toggle of the feed: the slide stands for the other clip of the same moment; the playback position and the play/pause state stay.
function swapVersion(nc, k, how) {
  const s = S[idx]; if (!s || !nc || nc === s.c) return;
  const v = s.video; s.c = nc; ids[idx] = nc.id; s.el.dataset.id = nc.id;
  const [va, t] = k.split('|'); state.variants.set(momentKey(nc), { variant: va, teaser: t === '1' }); writePlPref({ mode: k });
  if (nc.poster && s.img) api.loadImage(s.img, nc.poster).catch(() => {});
  if (v && nc.video) {
    const t0 = v.currentTime || 0, was = !v.paused;
    api.fetchMedia(nc.video).then(m => {
      if (s.video !== v) { m.revoke(); return; }
      const old = s.media; s.media = m; v.src = m.url; old?.revoke();
      v.addEventListener('loadedmetadata', () => { try { v.currentTime = Math.min(t0, Math.max(0, (v.duration || t0) - 0.05)); } catch { /* ignore */ } if (was && !s.userPaused) v.play().catch(() => s.el.classList.add('paused')); }, { once: true });
    }).catch(e => { s.msg.hidden = false; s.msg.textContent = api.errorText(e); });
  }
  renderSheet(nc);
  bar.querySelector(`.vs-b[data-axis="${how.axis}"][data-val="${how.val}"]`)?.focus({ preventScroll: true });
  try { history.replaceState(null, '', '#/post/' + encodeURIComponent(nc.id)); } catch { /* ignore */ }
  announce(`${t === '1' ? 'Teaser' : 'No teaser'}, ${va.replace('-', ' ')} version`);
}
function field(f) {
  const id = 'pmf' + Math.random().toString(36).slice(2, 8);
  const ta = h('textarea', { id, class: 'pk-ta', rows: 2, spellcheck: 'false' }); ta.value = f.value;
  const cnt = h('span', { class: 'cnt' });
  const cp = h('button', { type: 'button', class: 'btn icon ghost sm copy', 'aria-label': 'Copy ' + f.label, title: 'Copy ' + f.label }, icon('copy'));
  cp.addEventListener('click', () => copyText(ta.value, f.label + ' copied', cp));
  const upd = () => {
    vals.set(f, ta.value); ta.rows = Math.min(8, Math.max(2, ta.value.split('\n').length + Math.floor(ta.value.length / 48)));
    if (!f.limit) { cnt.textContent = `${[...ta.value].length} chars`; cnt.className = 'cnt'; return; }
    const n = countOf(f, ta.value), L = f.limit;
    cnt.textContent = `${n} / ${L.max} ${L.unit === 'tags' ? 'tags' : 'chars'}`; cnt.className = 'cnt ' + (n > L.max ? 'over' : L.soft && n > L.soft ? 'warn' : 'ok');
  };
  ta.addEventListener('input', upd); upd();
  return h('div', { class: 'pk-field' }, h('div', { class: 'pk-lab' }, h('label', { for: id, text: f.label }), cnt, cp), ta);
}
function onClips() {
  if (!dlg?.open || idx < 0) return;
  const c = findClip(ids[idx]); if (!c) { if (ids.length > 1) { toast('That clip was removed.'); } back(); return; }
  S[idx].c = c;
  if (curChips?.isConnected) { const n = chips(c); curChips.replaceWith(n); curChips = n; }
}

// ---- keyboard ---------------------------------------------------------------------------------------------
function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target, k = e.key;
  if (k === '?' && !isTyping(t)) { e.preventDefault(); openShortcuts(); return; }
  if (isTyping(t) || !kit) return;
  const inSheet = !!t.closest?.('.pm-sheet'), c = S[idx]?.c; let used = true;
  if (k === 'j' || (!inSheet && (k === 'ArrowDown' || k === 'PageDown'))) step(1);
  else if (k === 'k' || (!inSheet && (k === 'ArrowUp' || k === 'PageUp'))) step(-1);
  else if (k === 'c') copyText(joinKit(kit.yt, f => vals.get(f) ?? f.value), 'YouTube kit copied');
  else if (k === 'i') copyText(joinKit(kit.ig, f => vals.get(f) ?? f.value), 'Instagram kit copied');
  else if (k === 'p' || k === 'P') { const t2 = toggles[k === 'p' ? 0 : 1]; if (t2) t2.click(); else toast('Could not mark this clip as posted.'); }
  else if (k === 'd') downloadClip(c);
  else if (k === 'm') setMuted(!muted);
  else if (k === 's') setSafe(!safeOn);
  else if (k === ' ' && (!t.closest?.('button,a') || t.classList.contains('pm-tap'))) tapped(idx);
  else used = false;
  if (used) e.preventDefault();
}
