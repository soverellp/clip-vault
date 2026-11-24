// Live refresh (static mode): new clips, edited text, streams and thumbnails appear without a reload.
// Cheap check first: the dataset's head commit (one small JSON call). index.json is read again only when the head moved.
// Polls about every 60 s while the tab is visible and unlocked; also right after the tab becomes visible, on focus and when the network
// returns, never more than one check per 30 s; backs off on errors; pauses while an admin commit runs. A change is applied only while
// nothing is open (no dialog, no playing video), so nothing is interrupted; it is applied as soon as the dialog closes.
// Nothing here is stored anywhere; the tokens stay inside hubapi.js.
import { state, emit, on } from './state.js';
import * as api from './api.js';

const override = (() => { const o = globalThis.__clipVaultPollMs; return Number.isFinite(o) && o >= 100 && o <= 600000 ? o : 0; })();
const POLL_MS = override || 60000, MIN_GAP = override ? Math.round(override / 2) : 30000, MAX_BACKOFF = 5;
let timer = null, idleTimer = null, inflight = false, pending = false, lastCheck = 0, lastSha = null, errors = 0;

const active = () => !!state.me && state.loaded && !document.hidden && navigator.onLine !== false;
const playing = () => [...document.querySelectorAll('video')].some(v => !v.paused && !v.ended);
const busy = () => !!document.querySelector('dialog[open]') || playing();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keep = (olds, news, key = 'id') => { const m = new Map(olds.map(o => [o[key], o])); return news.map(n => { const o = m.get(n[key]); return o && same(o, n) ? o : n; }); };

// the tiny "Updated" flash (a polite status line, no layout shift)
let flashEl = null, flashT = null;
function flash() {
  if (!flashEl) {
    flashEl = document.createElement('div'); flashEl.className = 'upd-flash'; flashEl.id = 'upd-flash';
    flashEl.setAttribute('role', 'status'); flashEl.setAttribute('aria-live', 'polite');
    (document.getElementById('dialogs') || document.body).after(flashEl);
  }
  flashEl.textContent = 'Updated'; flashEl.classList.add('show');
  clearTimeout(flashT); flashT = setTimeout(() => { flashEl.classList.remove('show'); setTimeout(() => { if (!flashEl.classList.contains('show')) flashEl.textContent = ''; }, 400); }, 1800);
}

const clean = list => (Array.isArray(list) ? list.filter(c => c && typeof c === 'object' && c.id != null).map(c => ({ ...c, id: String(c.id) })) : []);
const TEXTY = ['title', 'hook', 'desc', 'post', 'tags', 'stream', 'notes', 'posted'];
const mediaChanged = (o, n) => o.poster !== n.poster || o.sha256 !== n.sha256 || o.size !== n.size || (o.updated_at !== n.updated_at && TEXTY.every(k => same(o[k], n[k])));

// Re-read the index and apply what differs. Returns 'same', 'applied' or 'raced' (an admin write or a dialog started meanwhile: nothing was changed).
async function fetchAndApply() {
  const gen = api.writeGen();
  api.invalidateSnapshot();
  const wantTrash = state.me?.role === 'admin' && state.trashLoaded;
  const [r, st, tr, sl] = await Promise.all([api.listClips(), api.listStreams().catch(() => null), wantTrash ? api.listClips({ trash: true }).catch(() => null) : null, api.listShortlist().catch(() => null)]);
  if (api.isWriting() || gen !== api.writeGen() || busy() || !state.me) return 'raced';
  const nc = clean(r?.clips), nt = tr ? clean(tr.clips) : null;
  const nf = Array.isArray(st?.streams) ? st.streams.filter(x => x && typeof x.id === 'string') : null;
  const drop = [], bump = p => { if (p) { drop.push(p); state.mediaRev.set(p, (state.mediaRev.get(p) || 0) + 1); } };
  const oldAll = new Map([...state.clips, ...state.trash].map(c => [c.id, c]));
  for (const c of [...nc, ...(nt || [])]) { const o = oldAll.get(c.id); if (o && c.poster && mediaChanged(o, c)) bump(c.poster); }
  const ns = Array.isArray(sl?.ids) ? sl.ids : null;
  let changed = !same(state.clips, nc) || (nt && !same(state.trash, nt)) || (nf && !same(state.folders, nf)) || (ns && !same(state.shortlist, ns));
  if (nf) { const oldF = new Map(state.folders.map(f => [f.id, f])); for (const f of nf) { const o = oldF.get(f.id); if (o && f.thumb && !same(o, f)) bump(f.thumb); } }
  if (!changed) return 'same';
  api.dropMedia?.(drop);
  const y = window.scrollY;
  state.clips = keep(state.clips, nc);
  if (nt) state.trash = keep(state.trash, nt);
  if (nf) state.folders = keep(state.folders, nf);
  if (ns) state.shortlist = ns;
  if (r?.counts) state.counts = { ...state.counts, ...r.counts };
  emit('clips');
  requestAnimationFrame(() => { if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y); });
  flash();
  return 'applied';
}

async function check(force) {
  if (inflight || !active()) return;
  if (api.isWriting()) { schedule(MIN_GAP); return; }       // an admin commit is running: never race it
  if (!force && Date.now() - lastCheck < MIN_GAP) { schedule(MIN_GAP - (Date.now() - lastCheck)); return; }
  inflight = true; lastCheck = Date.now();
  try {
    let sha = null;
    try { sha = await api.pollHead(); } catch (e) { if (!e || (e.status !== 403 && e.status !== 404)) throw e; }   // no head call allowed: fall back to reading the index
    if (api.isWriting()) { /* a commit began during the call: skip this round */ }
    else if (sha && sha === lastSha && !pending) { /* nothing new */ }
    else if (busy()) { pending = true; watchIdle(); }
    else {
      const res = await fetchAndApply();
      if (res === 'raced') { pending = true; watchIdle(); } else { lastSha = sha; pending = false; }
    }
    errors = 0;
  } catch (e) {
    if (e?.status === 401) return;                           // locked out: hubapi emits 'unauthorized'
    errors = Math.min(MAX_BACKOFF, errors + 1);
  } finally { inflight = false; schedule(); }
}
// A change is waiting because a dialog or video was open: look again every second, apply once everything is closed.
function watchIdle() {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    if (!pending || !active()) { if (!pending) { clearInterval(idleTimer); idleTimer = null; } return; }
    if (!busy() && !api.isWriting()) { clearInterval(idleTimer); idleTimer = null; check(true); }
  }, 1000 > POLL_MS ? POLL_MS : 1000);
}
function schedule(delay) {
  clearTimeout(timer); timer = null;
  if (!active()) return;
  const d = delay ?? Math.min(POLL_MS * 2 ** errors, 10 * 60000);
  timer = setTimeout(() => { timer = null; check(false); }, Math.max(d, 50));
}
const kick = () => { if (active() && !inflight) check(false); };   // respects the 30 s cap

document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(timer); timer = null; } else kick(); });
addEventListener('focus', kick);
addEventListener('online', kick);
addEventListener('offline', () => { clearTimeout(timer); timer = null; });
on('clips', () => { if (!timer && !inflight) schedule(); });
on('signedout', () => { clearTimeout(timer); timer = null; pending = false; lastSha = null; });
on('unauthorized', () => { clearTimeout(timer); timer = null; pending = false; lastSha = null; });
