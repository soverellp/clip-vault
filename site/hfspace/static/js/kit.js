// Shared helpers for the posting workflow: post kit text, clipboard flash, downloads, the posting tracker, shared-element transitions and lazy loaders.
import { state, emit, findClip, replaceClip } from './state.js';
import { h, icon, setIcon } from './dom.js';
import * as api from './api.js';
import { toast } from './toast.js';
import { haptic, announce } from './a11y.js';
import { parsePost, LIMITS } from './post.js';
import { titleOf, tagsOf } from './fmt.js';
import { exact, parse } from './time.js';
import { momentKey, isShortlisted, liveKeys, shortlistText } from './shortlist.js';
import { pretty } from './fmt.js';

// Copy text. `src` (optional) is the button that gets the flash animation. Works inside open modal dialogs (the fallback textarea goes into the top dialog).
export async function copyText(text, what = 'Copied', src) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
    const ta = h('textarea', { class: 'sr', 'aria-hidden': 'true', tabindex: '-1' }); ta.value = text; host.append(ta); ta.select();
    let good = false; try { good = document.execCommand('copy'); } catch { good = false; }
    ta.remove();
    if (!good) { toast('Copy failed. Select the text and copy it by hand.', { kind: 'error' }); return false; }
  }
  haptic(12); flash(src);
  toast(what, { kind: 'success', timeout: 1800 }); return true;
}
// Tiny "copied" micro-animation: icon turns into a check and a ring pulses. CSS only, ~0.9 s.
export function flash(b) {
  if (!b || !b.isConnected) return;
  b.classList.remove('copied'); void b.offsetWidth; b.classList.add('copied');
  const old = b.querySelector('svg.ic'); const had = b.dataset.ic;
  if (old && !had) { b.dataset.ic = '1'; setIcon(b, 'check'); setTimeout(() => { if (b.isConnected) setIcon(b, 'copy'); b.classList.remove('copied'); delete b.dataset.ic; }, 900); }
  else setTimeout(() => b.classList.remove('copied'), 900);
}

const hashtags = c => tagsOf(c).map(t => '#' + t.replace(/^#/, '')).join(' ');
// -> { yt:{kind,name,fields:[{key,label,value,limit}]}, ig:{...} }. Uses the parsed `post` text, falling back to title/desc/tags so every clip has a kit.
export function kitOf(c) {
  const P = parsePost(c.post || '');
  const mk = (kind, name, defs) => {
    const sec = P.sections.find(s => s.kind === kind);
    const fields = defs.map(([key, label, fb]) => {
      const f = sec?.fields.find(x => x.key === key);
      return { key, label, value: f ? f.value : (sec ? '' : fb), limit: LIMITS[`${kind}:${key}`] || null };
    }).filter(f => f.value);
    return { kind, name, fields };
  };
  return {
    yt: mk('yt', 'YouTube', [['title', 'Title', titleOf(c)], ['description', 'Description', c.desc || c.hook || ''], ['tags', 'Tags', tagsOf(c).join(', ')]]),
    ig: mk('ig', 'Instagram', [['caption', 'Caption', c.desc || c.hook || titleOf(c)], ['hashtags', 'Hashtags', hashtags(c)]]),
  };
}
// Join one platform's fields into the single block people paste. `get(field)` returns the (possibly edited) value.
export function joinKit(section, get = f => f.value) {
  const v = k => { const f = section.fields.find(x => x.key === k); return f ? get(f) : ''; };
  const parts = section.kind === 'yt' ? [v('title'), v('description'), v('tags') ? 'Tags: ' + v('tags') : ''] : [v('caption'), v('hashtags')];
  return parts.filter(Boolean).join('\n\n');
}

export const fileNameOf = c => String(c.id || 'clip').replace(/[^\w.\-]/g, '_') + '.mp4';
// Start one browser download. Resolves true when it was handed to the browser. `onProgress`/`signal` are used by the queue (static mode shows real progress).
export async function downloadClip(c, { onProgress, signal } = {}) {
  if (!c?.video) { toast('This clip has no video file.', { kind: 'error' }); return false; }
  const trashed = !!c.trashed_at;
  try {
    const m = await api.fetchMedia(c.video, { trashed, onProgress, signal });
    const a = h('a', { href: m.url, download: fileNameOf(c), class: 'sr' }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => m.revoke(), 30000); haptic(10); return true;
  } catch (e) { if (e?.name !== 'AbortError') toast(api.errorText(e), { kind: 'error' }); return false; }
}
export async function shareClip(c) {
  try { await navigator.share({ title: titleOf(c), text: c.hook || titleOf(c), url: location.href.split('#')[0] + '#/clip/' + encodeURIComponent(c.id) }); } catch { /* cancelled */ }
}

// Posting tracker: which clips are already on YouTube Shorts / Instagram Reels. Stored on the clip as posted:{youtube,instagram} (ISO or null) and notes.

export const PLATFORMS = [{ key: 'youtube', short: 'YT', name: 'YouTube Shorts', cls: 'yt' }, { key: 'instagram', short: 'IG', name: 'Instagram Reels', cls: 'ig' }];
export function postedOf(c) {
  const p = c?.posted && typeof c.posted === 'object' ? c.posted : {};
  const v = k => (typeof p[k] === 'string' && parse(p[k]) ? p[k] : null);
  return { youtube: v('youtube'), instagram: v('instagram') };
}
// 'none' | 'yt' | 'ig' | 'both'
export function postState(c) { const p = postedOf(c); return p.youtube && p.instagram ? 'both' : p.youtube ? 'yt' : p.instagram ? 'ig' : 'none'; }
export const NOTES_MAX = 500;

// Small status chips. Posted: filled with a check and the local date-time on hover. Not posted: dim.
export function chips(c) {
  const p = postedOf(c);
  return h('span', { class: 'pchips' }, ...PLATFORMS.map(pl => {
    const iso = p[pl.key];
    const tip = iso ? `Posted on ${pl.name}: ${exact(iso)}` : `Not posted on ${pl.name}`;
    return h('span', { class: `pchip ${pl.cls}` + (iso ? ' on' : ''), title: tip, 'data-platform': pl.key, 'data-posted': iso ? '1' : '0' },
      iso ? icon('check') : null, h('b', { 'aria-hidden': 'true', text: pl.short }), h('span', { class: 'sr', text: tip }));
  }));
}

function fail(e, what) {
  if (e?.status === 401) return;
  if (e?.status === 400 || e?.status === 422) toast(`The server did not accept ${what}. It may be an older version. Nothing was changed.`, { kind: 'error' });
  else toast(api.errorText(e, 'That clip'), { kind: 'error' });
}
// Optimistic update + rollback. Returns true when saved.
export async function save(c0, fields, what) {
  const c = findClip(c0.id) || c0, before = c, next = { ...c, ...fields };
  replaceClip(next); emit('clips');
  try {
    const res = await api.patchClip(c.id, fields);
    const key = Object.keys(fields)[0];
    if (res?.clip && !(key in res.clip)) throw Object.assign(new Error('ignored'), { status: 422 }); // server silently dropped the field
    replaceClip(res?.clip ? { ...next, ...res.clip } : { ...next, updated_at: new Date().toISOString() }); emit('clips'); return true;
  } catch (e) { replaceClip(before); emit('clips'); fail(e, what); return false; }
}
export async function setPosted(c, key, on) {
  const pl = PLATFORMS.find(p => p.key === key); haptic(on ? [12, 30, 12] : 10);
  const ok = await save(c, { posted: { ...postedOf(findClip(c.id) || c), [key]: on ? new Date().toISOString() : null } }, 'the posting status');
  if (ok) { const m = on ? `Marked posted on ${pl.name}.` : `Unmarked on ${pl.name}.`; toast(m, { kind: 'success', timeout: 1800 }); announce(`${titleOf(c)}: ${m}`); }
  return ok;
}
export async function setNotes(c, text) {
  const t = String(text).slice(0, NOTES_MAX); const ok = await save(c, { notes: t }, 'notes');
  if (ok) toast('Notes saved.', { kind: 'success', timeout: 1600 }); return ok;
}
// Wire a toggle button to a clip + platform. Returns update(c) to repaint after the clip changes.
export function toggleBtn(c0, pl, { cls = '' } = {}) {
  const b = h('button', { type: 'button', class: `btn ptoggle ${pl.cls} ${cls}`.trim(), 'data-platform': pl.key, 'aria-pressed': 'false' }, icon('check'), h('span', { class: 'lbl s' }), h('span', { class: 'lbl l' }));
  let cur = c0, busy = false;
  const update = c => { cur = c; const on = !!postedOf(c)[pl.key]; b.setAttribute('aria-pressed', String(on)); b.querySelector('.s').textContent = pl.short; b.querySelector('.l').textContent = on ? `${pl.short} posted` : `Mark ${pl.short} posted`; b.title = on ? `Posted on ${pl.name}: ${exact(postedOf(c)[pl.key])}. Click to unmark.` : `Mark as posted on ${pl.name}`; b.setAttribute('aria-label', on ? `${pl.name}: posted. Press to unmark` : `Mark posted on ${pl.name}`); };
  b.addEventListener('click', async () => { if (busy) return; busy = true; b.classList.add('busy'); await setPosted(cur, pl.key, !postedOf(findClip(cur.id) || cur)[pl.key]); busy = false; b.classList.remove('busy'); });
  update(c0); b.update = update; return b;
}

// Shared-element transitions (View Transitions API with a plain fallback) and magnetic buttons.

let src = null;
export const markSource = el => { src = el || null; };
const NAME = 'clip-hero';
// Runs update() inside a view transition that morphs `src` (the clicked card poster) into getTarget() (the drawer / feed stage).
export function transition(update, getTarget) {
  const s = src; src = null;
  if (!s || !s.isConnected || state.reduced || state.lowPower || typeof document.startViewTransition !== 'function') { update(false); return; }
  let tg = null;
  const clear = () => { s.style.viewTransitionName = ''; if (tg) tg.style.viewTransitionName = ''; };
  try {
    s.style.viewTransitionName = NAME;
    const t = document.startViewTransition(() => { s.style.viewTransitionName = ''; update(true); tg = getTarget?.() || null; if (tg) tg.style.viewTransitionName = NAME; });
    t.finished.then(clear, clear);
    setTimeout(clear, 1500);
  } catch { clear(); update(false); }
}

// Magnetic buttons: primary buttons lean toward a mouse pointer (a few px). Uses the `translate` property so :active scale still works.
export function initMagnet() {
  let cur = null;
  const reset = () => { if (cur) { cur.style.removeProperty('--tx'); cur.style.removeProperty('--ty'); cur = null; } };
  document.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || state.reduced || state.lowPower) return;
    const b = e.target.closest?.('.btn.primary, .btn.mag');
    if (!b || b.disabled) { reset(); return; }
    if (cur && cur !== b) reset();
    cur = b; const r = b.getBoundingClientRect();
    b.style.setProperty('--tx', (((e.clientX - r.left) / r.width - 0.5) * 8).toFixed(1) + 'px');
    b.style.setProperty('--ty', (((e.clientY - r.top) / r.height - 0.5) * 6).toFixed(1) + 'px');
  }, { passive: true });
  document.addEventListener('pointerleave', reset, true);
}

// ---- lazy loaders: Post mode, the action sheet, the download queue and the shortcuts overlay are fetched on first use (keeps first paint light)
const cssDone = new Map();
function ensureCss(href) {
  if (!cssDone.has(href)) cssDone.set(href, new Promise(res => { const l = h('link', { rel: 'stylesheet', href }); l.onload = l.onerror = () => res(); document.head.append(l); setTimeout(res, 3000); }));
  return cssDone.get(href);
}
let pm = null;
export const postModule = () => pm; // already-loaded Post mode module or null (so route() can close it without loading it)
const load = async f => { await ensureCss('/css/post.css'); return f(); };
export const loadPostMode = () => load(() => import('./postmode.js')).then(m => (pm = m));
export const startPost = (...a) => loadPostMode().then(m => m.startPost(...a));
export const openCardSheet = (...a) => load(() => import('./sheet.js')).then(m => m.openCardSheet(...a));
export const downloadAll = (...a) => load(() => import('./sheet.js')).then(() => import('./dlqueue.js')).then(m => m.downloadAll(...a));
export const openShortcuts = () => load(() => import('./shortcuts.js')).then(m => m.openShortcuts());

// ---- shortlist (per moment; anyone who unlocked the site can change it when the site config carries the shortlist-only token; no admin mode)
export const SHL_HINT = 'Shortlist is read-only on this site';
export const canShortlist = () => state.me?.capabilities?.shortlist === true;
export const shortlisted = c => isShortlisted(state.shortlist, c);
export const shortlistCount = () => liveKeys(state.shortlist, state.clips).size;
const shlBusy = new Set();
export async function toggleShortlist(c) {
  if (!canShortlist()) { toast(SHL_HINT + '.'); return false; }
  const key = momentKey(c); if (shlBusy.has(key)) return false;
  const on = !shortlisted(c); shlBusy.add(key);
  try {
    const r = await api.setShortlist(key, on);
    if (Array.isArray(r?.ids)) state.shortlist = r.ids;
    emit('clips'); announce(on ? 'Added to the shortlist' : 'Removed from the shortlist'); toast(on ? 'Shortlisted' : 'Removed from the shortlist');
    return true;
  } catch (e) { toast(api.errorText(e), { kind: 'error' }); return false; }
  finally { shlBusy.delete(key); }
}
export function copyShortlist(src) {
  const text = shortlistText(state.shortlist, state.clips, { pretty, title: titleOf });
  if (!text) { toast('Nothing is shortlisted yet.'); return; }
  return copyText(text, `Copied ${shortlistCount()} shortlisted`, src);
}
