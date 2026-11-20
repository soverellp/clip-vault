// Static-mode implementation of the api.js interface: no server. The browser talks to the Hugging Face Hub directly.
//   viewer: passphrase -> WebCrypto decrypts the READ token (memory only) -> resolve/main/index.json + files as blobs
//   admin : a fine-grained WRITE token pasted by the admin (memory only) -> Hub commit API (+ LFS) from the browser
// Exports the same names as site/hfspace/static/js/api.js (the build checks this). Nothing is ever put in storage.
import { state, emit } from './state.js';
import { parseShortlist, parseShortlistStrict, serializeShortlist, toggleEntry } from './shortlist.js';

export const MODE = 'static';
const HUB = 'https://huggingface.co';
const MAX_VIDEO = 150 * 1024 * 1024, MAX_POSTER = 3 * 1024 * 1024;
const TRASH_DAYS = 30, MAX_RETRIES = 3, STEP_UP_MS = 5 * 60 * 1000, SNAP_TTL = 2000, MP4_KEEP = 2;
const LIMITS = { title: 200, hook: 300, desc: 2000, post: 20000, stream: 120 };
const MULTILINE = new Set(['desc', 'post']);
const MAX_NOTES = 500, MAX_TOMBSTONES = 5000;
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,199}$/;
const VIDEO_RE = /^clips\/([A-Za-z0-9_.\-]{1,200})\.mp4$/;
const SAFE = /^(clips\/[\w.\-ऀ-ॿ]{1,200}\.(mp4|jpg|jpeg)|streams\/[A-Za-z0-9_.\-]{1,200}\/thumb\.jpg)$/;   // clip files and stream thumbnails
const THUMB_RE = /^streams\/[A-Za-z0-9_][A-Za-z0-9_.\-]{0,199}\/thumb\.jpg$/;
// Moment fields (all optional, see clip-vault-project/UI-LIBRARY.md). Enumerated ones are validated on read and on edit.
const ENUMS = { reaction: ['strong', 'mild', 'none', 'unrated'], kind: ['reaction', 'game'], tier: ['A', 'B', 'C'], variant: ['with-streamer', 'with-girl', 'clean', 'face-top'] };
const EDIT_ENUMS = ['reaction', 'kind', 'tier'], EDIT_TEXT = { why: 300, reaction_note: 300 };
const EDITABLE = new Set([...Object.keys(LIMITS), 'tags', 'posted', 'notes', ...EDIT_ENUMS, ...Object.keys(EDIT_TEXT)]);
const enc = encodeURIComponent;

export class ApiError extends Error {
  constructor(status, body) { super(body?.message || `HTTP ${status}`); this.status = status; this.code = body?.error || ''; this.body = body || {}; }
}
let reauthHandler = null;
export const setReauthHandler = fn => { reauthHandler = fn; };

// ------------------------------------------------------------------ session (memory only)
let cfg = null, readToken = null, writeToken = null, slToken = null, stepUpUntil = 0, failCount = 0, notBefore = 0, snapCache = null;
const issuedUrls = new Set(), posterCache = new Map(), posterWait = new Map(), mp4Cache = new Map();
let flight = null;
export const isAdminMode = () => !!writeToken;
export const canShortlistWrite = () => !!slToken;

// ------------------------------------------------------------------ config + passphrase
const hex = s => Uint8Array.from(s.match(/../g) || [], b => parseInt(b, 16));
async function loadConfig() {
  if (cfg) return cfg;
  let c;
  try {
    const r = await fetch('/config.json', { cache: 'no-store', credentials: 'omit' });
    if (!r.ok) throw 0;
    c = await r.json();
  } catch { throw new ApiError(503, { error: 'not_configured' }); }
  const okHex = v => typeof v === 'string' && /^([0-9a-f]{2})+$/.test(v);
  if (!c || typeof c.dataset !== 'string' || !/^[\w.\-]+\/[\w.\-]+$/.test(c.dataset) || !Number.isInteger(c.iter) || c.iter < 100000 || !okHex(c.salt) || !okHex(c.iv) || !okHex(c.token)) throw new ApiError(503, { error: 'not_configured' });
  // optional: a second token (the shortlist writer), encrypted under the same key with its own iv; dataset + path say where the shortlist file lives
  if (c.sl != null && (typeof c.sl !== 'object' || typeof c.sl.dataset !== 'string' || !/^[\w.\-]+\/[\w.\-]+$/.test(c.sl.dataset) || (c.sl.path != null && (typeof c.sl.path !== 'string' || !/^[\w.\-\/]{1,100}$/.test(c.sl.path) || c.sl.path.includes('..') || c.sl.path.startsWith('/'))) || !okHex(c.sl.iv) || !okHex(c.sl.token))) throw new ApiError(503, { error: 'not_configured' });
  cfg = c; return c;
}
async function decryptToken(pw) {
  const E = new TextEncoder();
  const m = await crypto.subtle.importKey('raw', E.encode(pw), 'PBKDF2', false, ['deriveKey']);
  const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: hex(cfg.salt), iterations: cfg.iter, hash: 'SHA-256' }, m, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const dec = (iv, ct) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: hex(iv) }, k, hex(ct)).then(b => new TextDecoder().decode(b));
  const tok = await dec(cfg.iv, cfg.token);          // a wrong passphrase fails here
  let sl = null; if (cfg.sl) { try { sl = await dec(cfg.sl.iv, cfg.sl.token); } catch { sl = null; } }   // a broken shortlist blob never blocks the read token
  return { tok, sl };
}
export const waitSeconds = () => Math.max(0, Math.ceil((notBefore - Date.now()) / 1000));
// In-memory attempt delay: 1 s, 2 s, 4 s ... up to 5 min after each wrong passphrase. A reload resets it, and it does NOT slow an
// attacker who works offline on config.json (that is why the passphrase must be random words).
async function checkPassphrase(pw) {
  await loadConfig();
  const w = waitSeconds();
  if (w > 0) throw new ApiError(429, { error: 'too_fast', wait: w });
  if (typeof pw !== 'string' || !pw || pw.length > 256) { noteFailure(); throw new ApiError(403, { error: 'bad_passphrase' }); }
  try { const t = await decryptToken(pw); failCount = 0; notBefore = 0; return t; }
  catch { noteFailure(); throw new ApiError(403, { error: 'bad_passphrase' }); }
}
function noteFailure() { failCount++; notBefore = Date.now() + Math.min(300000, 1000 * 2 ** (failCount - 1)); }

// ------------------------------------------------------------------ auth surface
export const authConfig = async () => { await loadConfig(); return { provider: 'passphrase' }; };
export const loadGoogleIdentity = async () => { throw new ApiError(400, { error: 'unsupported', message: 'Google sign-in is not available in static mode.' }); };
export const authGoogle = async () => { throw new ApiError(400, { error: 'unsupported' }); };
export const reauthGoogle = authGoogle;
export async function loginPassphrase(pw, { reauth = false } = {}) {
  const tok = await checkPassphrase(pw);
  if (reauth) { if (!readToken) throw new ApiError(401, { error: 'unauthorized' }); stepUpUntil = Date.now() + STEP_UP_MS; return null; }
  readToken = tok.tok; slToken = tok.sl || null; snapCache = null;
  try { await snapshot(); }
  catch (e) { readToken = slToken = null; throw new ApiError(503, { error: 'vault_unreachable' }); }
  return null;
}
// Lock: wipe tokens, revoke every blob URL, clear caches, reload.
export function wipe() {
  readToken = writeToken = slToken = null; stepUpUntil = 0; snapCache = null;
  for (const u of issuedUrls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
  issuedUrls.clear(); posterCache.clear(); posterWait.clear(); mp4Cache.clear();
  try { flight?.ac.abort(); } catch { /* ignore */ } flight = null;
}
export async function logout() { wipe(); try { location.reload(); } catch { /* ignore */ } }

export async function me() {
  if (!readToken) throw new ApiError(401, { error: 'unauthorized' });
  const admin = !!writeToken;
  return { role: admin ? 'admin' : 'viewer', name: admin ? 'Admin' : 'Viewer', email: '', picture: '', csrf: '', root: false, sub: '', can_write: admin,
    capabilities: { users: false, trash: admin, audit: admin, upload: admin, delete: admin, moments: admin, shortlist: !!slToken }, mode: 'static', dataset: cfg?.dataset };
}

// ------------------------------------------------------------------ Hub plumbing
const mapErr = (status, who) => {
  if (who === 'shortlist' && (status === 401 || status === 403)) return new ApiError(403, { error: 'shortlist_token_rejected' });
  if (status === 401 || status === 403) return who === 'write' ? new ApiError(403, { error: 'admin_token_rejected' }) : new ApiError(status === 401 ? 401 : 403, { error: status === 401 ? 'unauthorized' : 'forbidden' });
  if (status === 404) return new ApiError(404, { error: 'not_found' });
  if (status === 409 || status === 412) return new ApiError(409, { error: 'conflict' });
  if (status === 429) return new ApiError(429, { error: 'rate_limited' });
  return new ApiError(502, { error: 'upstream_error' });
};
async function hub(url, { method = 'GET', token, json, body, headers = {}, signal } = {}) {
  const hd = { ...headers };
  if (token) hd.Authorization = 'Bearer ' + token;
  if (json !== undefined) { hd['Content-Type'] ||= 'application/json'; body = JSON.stringify(json); }
  try { return await fetch(url, { method, headers: hd, body, signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }); }
  catch (e) { if (e?.name === 'AbortError') throw e; throw new ApiError(0, { error: 'network' }); }
}
async function hubOk(url, o = {}) {
  const r = await hub(url, o);
  if (!r.ok) {
    const e = mapErr(r.status, o.who || (o.token && o.token === writeToken ? 'write' : 'read'));
    if (e.status === 401 && o.who !== 'write') emit('unauthorized', e);
    if (e.code === 'admin_token_rejected') { writeToken = null; stepUpUntil = 0; queueMicrotask(() => { me().then(m => { state.me = m; emit('clips'); }).catch(() => {}); }); }
    throw e;
  }
  return r;
}
const repoPath = p => p.split('/').map(enc).join('/');
const resolveUrl = (p, rev) => `${HUB}/datasets/${cfg.dataset}/resolve/${rev}/${repoPath(p)}`;
async function readText(p, rev) {
  const r = await hub(resolveUrl(p, rev), { token: readToken });
  if (r.status === 404) return null;
  if (!r.ok) { const e = mapErr(r.status, 'read'); if (e.status === 401) emit('unauthorized', e); throw e; }
  return r.text();
}

// ------------------------------------------------------------------ data model (port of site/hfspace/store.py)
const isoNow = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const isoMs = v => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(v) && !Number.isNaN(Date.parse(v)) ? v.replace(/\.\d+Z$/, 'Z') : null);
const isoOrNull = v => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const KNOWN_CLIP = new Set(['id', 'stream', 'title', 'hook', 'desc', 'description', 'post', 'tags', 'dur', 'score', 'size', 'width', 'height', 'fps', 'codec', 'bitrate', 'sha256', 'added_at', 'updated_at', 'video', 'poster', 'posted', 'notes', 'trashed_at', 'purge_after']);
export function normalizeClip(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const m = typeof c.video === 'string' ? VIDEO_RE.exec(c.video) : null;
  let id;
  if (m) id = m[1];
  else { if (typeof c.id !== 'string' || !c.id) return null; id = c.id.replace(/[^A-Za-z0-9_.\-]/g, '_').slice(0, 200); }
  if (!ID_RE.test(id) || id.includes('..')) return null;
  const tags = Array.isArray(c.tags) ? c.tags.filter(t => typeof t === 'string' && t).map(t => t.slice(0, 40)).slice(0, 20) : [];
  // Fields this code does not know (group, variant, reaction, reaction_note, kind, tier, rank, why, ...) pass through UNCHANGED, so no edit erases them (D39).
  const extra = {}; for (const k of Object.keys(c)) if (!KNOWN_CLIP.has(k) && k !== '__proto__') extra[k] = c[k];
  return { ...extra, id, stream: str(c.stream, 120), title: str(c.title, 200) || id, hook: str(c.hook, 300), desc: str(c.desc ?? c.description, 2000), post: str(c.post, 20000), tags,
    dur: num(c.dur), score: num(c.score), size: num(c.size), width: num(c.width), height: num(c.height), fps: num(c.fps),
    codec: typeof c.codec === 'string' ? c.codec : null, bitrate: num(c.bitrate), sha256: typeof c.sha256 === 'string' ? c.sha256 : null,
    added_at: isoOrNull(c.added_at), updated_at: isoOrNull(c.updated_at), video: `clips/${id}.mp4`, poster: c.poster ? `clips/${id}.jpg` : null,
    posted: { youtube: isoMs(c.posted?.youtube), instagram: isoMs(c.posted?.instagram) }, notes: str(c.notes, MAX_NOTES),
    trashed_at: isoOrNull(c.trashed_at), purge_after: isoOrNull(c.purge_after), };
}
// Streams in the index are kept as written (never rewritten); this is only the display view of one entry.
export function normalizeStream(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.id !== 'string' || !ID_RE.test(s.id) || s.id.includes('..')) return null;
  const url = typeof s.url === 'string' && /^https:\/\/[^\s]{1,300}$/.test(s.url) ? s.url : '';
  return { id: s.id, title: str(s.title, 200) || s.id, channel: str(s.channel, 120), date: typeof s.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(s.date) ? s.date : '', url,
    thumb: typeof s.thumb === 'string' && THUMB_RE.test(s.thumb) && !s.thumb.includes('..') ? s.thumb : null, clip_count: num(s.clip_count),
    clipped_at: typeof s.clipped_at === 'string' && /^\d{4}-\d\d-\d\d(T[\d:.]+Z)?$/.test(s.clipped_at) ? s.clipped_at : '', lang: typeof s.lang === 'string' && /^[a-z]{2,3}$|^unknown$/.test(s.lang) ? s.lang : '', lang_name: str(s.lang_name, 40) };
}
export function normalizeIndex(raw) {
  const arr = Array.isArray(raw?.clips) ? raw.clips : Array.isArray(raw) ? raw : [];
  const seen = new Set(), clips = [];
  for (const c of arr) { const n = normalizeClip(c); if (n && !seen.has(n.id)) { seen.add(n.id); clips.push(n); } }
  // top-level keys we do not own (notably "streams", the Library folders) are carried through unchanged
  const extra = {}; if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const k of Object.keys(raw)) if (k !== 'clips' && k !== 'version' && k !== 'updated_at' && k !== '__proto__') extra[k] = raw[k];
  return { ...extra, version: 2, updated_at: isoOrNull(raw?.updated_at), clips };
}
const clipFiles = c => [c.video, c.poster].filter(Boolean);
const trashPath = p => 'trash/' + p;
const find = (index, id) => index.clips.find(c => c.id === id) || null;

async function snapshot() {
  if (snapCache && Date.now() - snapCache.at < SNAP_TTL) return snapCache.p;
  const p = (async () => {
    let rev = 'main';
    if (writeToken) rev = (await (await hubOk(`${HUB}/api/datasets/${cfg.dataset}/revision/main`, { token: readToken })).json()).sha;
    const text = await readText('index.json', rev);
    let raw = {};
    if (text) { try { raw = JSON.parse(text); } catch { throw new ApiError(502, { error: 'upstream_error' }); } }
    return { rev, index: normalizeIndex(raw) };
  })();
  snapCache = { at: Date.now(), p }; p.catch(() => { if (snapCache?.p === p) snapCache = null; });
  return p;
}
const fresh = () => { snapCache = null; return snapshot(); };
// ---- live refresh helpers (used by autorefresh.js): a cheap head check, a forced re-read, and cache-busting of changed files
export async function pollHead() {
  if (!readToken) throw new ApiError(401, { error: 'unauthorized' });
  const r = await hubOk(`${HUB}/api/datasets/${cfg.dataset}/revision/main`, { token: readToken });
  const j = await r.json().catch(() => null);
  return typeof j?.sha === 'string' && /^[0-9a-f]{7,64}$/.test(j.sha) ? j.sha : null;
}
export const invalidateSnapshot = () => { snapCache = null; };
// Forget the cached blob of these repo paths (poster/thumbnail replaced in the dataset). Other blobs stay.
export function dropMedia(paths) {
  for (const p of paths || []) for (const key of [p, 'trash/' + p]) {
    const u = posterCache.get(key);
    if (u) { posterCache.delete(key); issuedUrls.delete(u); try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
  }
}

// ------------------------------------------------------------------ reads
export async function listClips({ trash = false } = {}) {
  if (!readToken) throw new ApiError(401, { error: 'unauthorized' });
  const admin = !!writeToken;
  if (trash && !admin) throw new ApiError(403, { error: 'forbidden' });
  const snap = await snapshot();
  const active = snap.index.clips.filter(c => !c.trashed_at), trashed = snap.index.clips.filter(c => c.trashed_at);
  const shown = (trash ? trashed : active).map(c => (admin ? { ...c } : { ...c, trashed_at: null, purge_after: null }));
  return { clips: shown, counts: { active: active.length, trash: admin ? trashed.length : 0 }, updated_at: snap.index.updated_at, can_write: admin };
}
// The streams (folders) of the library, with their thumbnail paths. Thumbnails are fetched like posters (loadImage -> blob URL, token never in a URL).
export async function listStreams() {
  if (!readToken) throw new ApiError(401, { error: 'unauthorized' });
  const snap = await snapshot();
  const seen = new Set(), streams = [];
  for (const x of Array.isArray(snap.index.streams) ? snap.index.streams : []) { const n = normalizeStream(x); if (n && !seen.has(n.id)) { seen.add(n.id); streams.push(n); } }
  return { streams };
}
export async function audit() {
  requireAdmin();
  const snap = await snapshot();
  const now = new Date(), prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  let lines = [];
  for (const d of [now, prev]) {
    const t = await readText(`_audit/${d.toISOString().slice(0, 7)}.jsonl`, snap.rev);
    if (t) lines = t.split('\n').filter(Boolean).concat(lines);
    if (lines.length >= 100) break;
  }
  const out = [];
  for (const ln of lines) { try { const o = JSON.parse(ln); if (o && typeof o === 'object') out.push({ at: o.at, actor_email: o.actor_email, action: o.action, clip_id: o.clip_id, detail: o.detail }); } catch { /* skip */ } }
  return { entries: out.slice(-100).reverse() };
}
const noUsers = async () => { throw new ApiError(404, { error: 'no_users' }); };
export const listUsers = noUsers;
export const addUser = noUsers;
export const setUserRole = noUsers;
export const removeUser = noUsers;

// ------------------------------------------------------------------ media (blob URLs, never a direct URL)
export const directMediaUrl = () => null;
async function fetchBlob(path, { trashed, onProgress, signal, type }) {
  if (!readToken) throw new ApiError(401, { error: 'unauthorized' });
  if (typeof path !== 'string' || path.includes('..') || !SAFE.test(path)) throw new ApiError(404, { error: 'not_found' });
  const r = await hub(resolveUrl((trashed ? 'trash/' : '') + path, 'main'), { token: readToken, signal });
  if (!r.ok) { const e = mapErr(r.status, 'read'); if (e.status === 401) emit('unauthorized', e); throw e; }
  const len = Number(r.headers.get('content-length')) || Number(r.headers.get('x-linked-size')) || 0;
  if (!r.body?.getReader) { const b = await r.blob(); return new Blob([b], { type }); }
  const rd = r.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value); n += value.length; onProgress?.({ loaded: n, total: len });
  }
  return new Blob(parts, { type });
}
const issue = blob => { const url = URL.createObjectURL(blob); issuedUrls.add(url); return { url, revoke() { if (issuedUrls.delete(url)) URL.revokeObjectURL(url); } }; };
let active = 0; const queue = [];
const slot = () => new Promise(res => { const go = () => { active++; res(); }; if (active < 4) go(); else queue.push(go); });
const release = () => { active--; queue.shift()?.(); };
export async function fetchMedia(path, { trashed = false, onProgress, signal } = {}) {
  const isVideo = /\.mp4$/.test(String(path));
  const key = (trashed ? 'trash/' : '') + path;
  if (!isVideo) {
    if (posterCache.has(key)) return { url: posterCache.get(key), revoke() {} };
    if (!posterWait.has(key)) {
      const p = (async () => {
        await slot();
        try { const b = await fetchBlob(path, { trashed, type: 'image/jpeg' }); const u = URL.createObjectURL(b); issuedUrls.add(u); posterCache.set(key, u); return u; }
        finally { release(); posterWait.delete(key); }
      })();
      posterWait.set(key, p);
    }
    return { url: await posterWait.get(key), revoke() {} };
  }
  let blob = mp4Cache.get(key);
  if (blob) { mp4Cache.delete(key); mp4Cache.set(key, blob); }
  else if (flight && flight.key === key) blob = await flight.p; // the player and the Download button share ONE download
  else {
    try { flight?.ac.abort(); } catch { /* ignore */ }
    const ac = new AbortController();
    signal?.addEventListener('abort', () => ac.abort(), { once: true });
    const p = fetchBlob(path, { trashed, onProgress, signal: ac.signal, type: 'video/mp4' });
    flight = { key, p, ac };
    try { blob = await p; } finally { if (flight?.p === p) flight = null; }
    mp4Cache.set(key, blob);
    while (mp4Cache.size > MP4_KEEP) mp4Cache.delete(mp4Cache.keys().next().value);
  }
  return issue(blob);
}
export async function loadImage(img, path, opts = {}) { const m = await fetchMedia(path, opts); img.src = m.url; }

// ------------------------------------------------------------------ admin mode
function requireAdmin() {
  if (!readToken) throw new ApiError(401, { error: 'unauthorized' });
  if (!writeToken) throw new ApiError(403, { error: 'forbidden' });
}
const needFresh = () => { if (Date.now() >= stepUpUntil) throw new ApiError(403, { error: 'reauth_required' }); };
async function withReauth(fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof ApiError && e.status === 403 && e.code === 'reauth_required' && reauthHandler) {
      if (await reauthHandler()) return fn();
      throw new ApiError(403, { error: 'reauth_cancelled' });
    }
    throw e;
  }
}
const WRITE_PERM = /^repo\.(write|content\.write)$/;
const ANY_WRITE = /write|create|delete|manage|admin|edit/i;   // any permission that can change something, outside the dataset too
// -> { ok, reason?, warnings[], name? }. Account-wide tokens (role write/admin), the read token, a token with no write on the dataset and an unknown
// whoami format are refused. Write permissions outside the dataset only WARN (D36), naming each scope.
export async function verifyAdminToken(token) {
  await loadConfig();
  const no = reason => ({ ok: false, reason, warnings: [] });
  if (typeof token !== 'string' || !/^hf_[A-Za-z0-9_\-]{8,}$/.test(token)) return no('That does not look like a Hugging Face token (it starts with hf_).');
  if (token === readToken) return no('That is the read-only token. Paste a separate write token that is limited to this dataset.');
  const r = await hub(`${HUB}/api/whoami-v2`, { token });
  if (r.status === 401 || r.status === 403) return no('Hugging Face did not accept that token.');
  if (!r.ok) throw new ApiError(502, { error: 'upstream_error' });
  let j = null; try { j = await r.json(); } catch { /* unknown shape */ }
  const at = j?.auth?.accessToken, warnings = [], role = at?.role;
  if (role === 'write' || role === 'admin') return no('That token is account-wide (role "' + role + '"). Create a fine-grained token that can write to ONLY ' + cfg.dataset + '.');
  if (role === 'read') return no('That token is read-only, so it cannot change the vault.');
  if (role === 'fineGrained' && at?.fineGrained && Array.isArray(at.fineGrained.scoped)) {
    const fg = at.fineGrained, ds = String(cfg.dataset).toLowerCase();
    const mine = fg.scoped.filter(s => s?.entity?.type === 'dataset' && String(s.entity.name).toLowerCase() === ds);   // HF names may differ in case
    const others = fg.scoped.filter(s => !mine.includes(s));
    if (!mine.some(s => (s.permissions || []).some(p => WRITE_PERM.test(p)))) {
      const have = fg.scoped.map(s => (s?.entity?.type || '?') + '/' + (s?.entity?.name || '?'));
      return no('That token cannot write to ' + cfg.dataset + '. It has these scopes: ' + (have.length ? have.join(', ') : 'none') + '.');
    }
    const wp = a => (Array.isArray(a) ? a : []).filter(p => typeof p !== 'string' || ANY_WRITE.test(p)).map(p => typeof p === 'string' ? p : '?');
    const extra = [];
    for (const s of others) { const w = wp(s?.permissions); if (w.length) extra.push((s?.entity?.type || '?') + '/' + (s?.entity?.name || '?') + ': ' + w.join(', ')); }
    const gw = wp(fg.global); if (gw.length) extra.push('account-wide/global: ' + gw.join(', '));
    if (extra.length) warnings.push('The token can also write outside ' + cfg.dataset + ' (' + extra.join('; ') + '). You accept that risk if you continue.');
    if (others.length) warnings.push('The token also has read access to ' + others.length + ' other repo(s).');
    if ((fg.global || []).length && !gw.length) warnings.push('The token has extra account permissions (' + fg.global.length + ').');
  } else return no('Could not tell how wide this token is (unexpected answer from Hugging Face), so it was refused. Use a fine-grained token limited to ' + cfg.dataset + '.');
  return { ok: true, warnings, name: typeof j?.name === 'string' ? j.name : '' };
}
export async function enterAdmin(token) {
  if (!readToken) throw new ApiError(401, { error: 'unauthorized' });
  const v = await verifyAdminToken(token);
  if (!v.ok) throw new ApiError(422, { error: 'invalid', message: v.reason });
  writeToken = token; stepUpUntil = 0; snapCache = null;
}
export function exitAdmin() { writeToken = null; stepUpUntil = 0; snapCache = null; }

// ------------------------------------------------------------------ commit engine (Hub HTTP API, same wire format as huggingface_hub)
const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const hexOf = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256 = async blob => hexOf(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
const hostOk = u => { try { const x = new URL(u); return x.protocol === 'https:' && (x.hostname === 'huggingface.co' || x.hostname.endsWith('.hf.co')); } catch { return false; } };
const guardHost = u => { if (!hostOk(u)) { let h = '?'; try { h = new URL(u).hostname; } catch { /* ignore */ } throw new ApiError(422, { error: 'blocked_host', message: `Hugging Face asked this page to upload to ${h}, which the site security policy does not allow (only huggingface.co and *.hf.co). Use the Python uploader (site/hfvault/build_hfvault.py) for this file.` }); } };
const LFS = { Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' };
const lfsDone = new Set();

async function putBlob(url, blob, onBytes, signal) {
  const body = await blob.arrayBuffer(); // sent as bytes, not a Blob: simple, and makes the body observable to the tests
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    let last = 0;
    x.upload.onprogress = e => { if (e.lengthComputable) { onBytes?.(e.loaded - last); last = e.loaded; } };
    x.onload = () => { if (x.status >= 200 && x.status < 300) { onBytes?.(blob.size - last); resolve({ etag: x.getResponseHeader('ETag') }); } else reject(new ApiError(502, { error: 'upstream_error' })); };
    x.onerror = () => reject(new ApiError(0, { error: 'network' }));
    x.onabort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal) { if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); signal.addEventListener('abort', () => x.abort(), { once: true }); }
    x.send(body);
  });
}
async function lfsUpload(file, oid, onBytes, signal) {
  if (lfsDone.has(oid)) { onBytes?.(file.size); return; }
  const r = await hubOk(`${HUB}/datasets/${cfg.dataset}.git/info/lfs/objects/batch`, { method: 'POST', token: writeToken, headers: LFS, signal,
    json: { operation: 'upload', transfers: ['basic', 'multipart'], objects: [{ oid, size: file.size }], hash_algo: 'sha256', ref: { name: 'main' } } });
  const o = (await r.json())?.objects?.[0];
  if (!o || o.error) throw new ApiError(502, { error: 'upstream_error' });
  const up = o.actions?.upload;
  if (!up) { onBytes?.(file.size); lfsDone.add(oid); return; } // the Hub already has this object
  guardHost(up.href);
  const hd = up.header || {}, chunk = hd.chunk_size ? Number(hd.chunk_size) : 0;
  if (chunk) {
    const urls = Object.entries(hd).filter(([k]) => /^\d+$/.test(k)).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, v]) => v);
    if (urls.length !== Math.ceil(file.size / chunk)) throw new ApiError(502, { error: 'upstream_error' });
    const parts = [];
    for (let i = 0; i < urls.length; i++) {
      guardHost(urls[i]);
      const { etag } = await putBlob(urls[i], file.slice(i * chunk, (i + 1) * chunk), onBytes, signal);
      if (!etag) throw new ApiError(422, { error: 'blocked_host', message: 'The upload host did not expose the part ETag to this page (CORS), so a large multipart upload cannot be completed from a browser.' });
      parts.push({ partNumber: i + 1, etag });
    }
    await hubOk(up.href, { method: 'POST', headers: LFS, json: { oid, parts }, token: hostIsHub(up.href) ? writeToken : undefined, signal });
  } else await putBlob(up.href, file, onBytes, signal);
  const v = o.actions.verify;
  if (v) { guardHost(v.href); await hubOk(v.href, { method: 'POST', headers: LFS, json: { oid, size: file.size }, token: writeToken, signal }); }
  lfsDone.add(oid);
}
const hostIsHub = u => { try { return new URL(u).hostname === 'huggingface.co'; } catch { return false; } };

async function pathsInfo(rev, paths) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += 100) {
    const r = await hubOk(`${HUB}/api/datasets/${cfg.dataset}/paths-info/${rev}`, { method: 'POST', token: readToken, json: { paths: paths.slice(i, i + 100) } });
    for (const e of await r.json()) if (e?.type === 'file') out.set(e.path, e);
  }
  return out;
}

// A change set: { index, adds:[{path, bytes}|{path, file, sha}], copies:[[src,dst]], deletes:[path], audit:[...], message }
async function commitChanges(snap, ch, { onBytes, signal } = {}) {
  const lines = [{ key: 'header', value: { summary: ch.message.slice(0, 200), description: '', parentCommit: snap.rev } }];
  const files = (ch.adds || []).filter(a => a.file);
  if (files.length) {
    const sample = async f => new Uint8Array(await f.slice(0, 512).arrayBuffer());
    const body = { files: await Promise.all(files.map(async a => ({ path: a.path, sample: b64(await sample(a.file)), size: a.file.size }))) };
    const pre = await (await hubOk(`${HUB}/api/datasets/${cfg.dataset}/preupload/main`, { method: 'POST', token: writeToken, json: body, signal })).json();
    const mode = new Map((pre?.files || []).map(f => [f.path, f]));
    for (const a of files) {
      const m = mode.get(a.path);
      if (!m || (m.uploadMode !== 'regular' && m.uploadMode !== 'lfs')) throw new ApiError(502, { error: 'upstream_error' });
      if (m.shouldIgnore) continue;
      if (m.uploadMode === 'lfs') {
        await lfsUpload(a.file, a.sha, onBytes, signal);
        lines.push({ key: 'lfsFile', value: { path: a.path, algo: 'sha256', oid: a.sha, size: a.file.size } });
      } else { lines.push({ key: 'file', value: { content: b64(new Uint8Array(await a.file.arrayBuffer())), path: a.path, encoding: 'base64' } }); onBytes?.(a.file.size); }
    }
  }
  if (ch.copies?.length) {
    const info = await pathsInfo(snap.rev, ch.copies.map(c => c[0]));
    for (const [src, dst] of ch.copies) {
      const e = info.get(src);
      if (!e) throw new ApiError(404, { error: 'not_found' });
      if (e.lfs?.oid) lines.push({ key: 'lfsFile', value: { path: dst, algo: 'sha256', oid: e.lfs.oid } });
      else {
        const rr = await hub(resolveUrl(src, snap.rev), { token: readToken, signal });
        if (!rr.ok) throw mapErr(rr.status, 'read');
        lines.push({ key: 'file', value: { content: b64(new Uint8Array(await rr.arrayBuffer())), path: dst, encoding: 'base64' } });
      }
    }
  }
  for (const p of ch.deletes || []) lines.push({ key: 'deletedFile', value: { path: p } });
  for (const a of (ch.adds || []).filter(x => x.bytes)) lines.push({ key: 'file', value: { content: b64(a.bytes), path: a.path, encoding: 'base64' } });
  const body = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  await hubOk(`${HUB}/api/datasets/${cfg.dataset}/commit/main`, { method: 'POST', token: writeToken, headers: { 'Content-Type': 'application/x-ndjson' }, body, signal });
}
const utf8 = s => new TextEncoder().encode(s);

// Read the head, let build() plan, commit with parentCommit; on a conflict (409/412) re-read and rebuild, up to MAX_RETRIES times.
let writing = 0, writeGeneration = 0;
export const isWriting = () => writing > 0;
export const writeGen = () => writeGeneration;
async function transact(build, opts = {}) {
  writing++; writeGeneration++;
  try { return await transactRun(build, opts); } finally { writing--; writeGeneration++; }
}
async function transactRun(build, opts) {
  requireAdmin();
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const snap = await fresh();
    const { ch, result } = await build(snap);
    const now = new Date();
    for (const a of ch.audit || []) { a.at = isoNow(now); a.actor = 'admin'; a.actor_email = 'admin'; a.clip_id ??= null; a.detail ??= {}; }
    if (ch.index) { ch.index.updated_at = isoNow(now); ch.index.version = 2; }
    ch.adds = ch.adds || [];
    if (ch.index) ch.adds.push({ path: 'index.json', bytes: utf8(JSON.stringify(ch.index, null, 1)) });
    if (ch.audit?.length) {
      const path = `_audit/${now.toISOString().slice(0, 7)}.jsonl`;
      let old = (await readText(path, snap.rev)) || '';
      if (old && !old.endsWith('\n')) old += '\n';
      ch.adds.push({ path, bytes: utf8(old + ch.audit.map(a => JSON.stringify(a)).join('\n') + '\n') });
    }
    if (ch.tombstones?.length) { // contract: site/hfvault/VAULT-SYNC.md. An unreadable list fails the delete rather than being overwritten.
      const text = await readText('_config/tombstones.json', snap.rev);
      let old = {};
      if (text) { try { old = JSON.parse(text); } catch { throw new ApiError(502, { error: 'upstream_error' }); } }
      const by = new Map();
      for (let t of [...(Array.isArray(old?.ids) ? old.ids : []), ...ch.tombstones]) {
        if (typeof t === 'string') t = { id: t };
        if (t && typeof t.id === 'string' && t.id) { by.delete(t.id); by.set(t.id, { id: t.id, deleted_at: t.deleted_at ?? null, sha256: t.sha256 ?? null }); }
      }
      ch.adds.push({ path: '_config/tombstones.json', bytes: utf8(JSON.stringify({ version: 1, ids: [...by.values()].slice(-MAX_TOMBSTONES) }, null, 1)) });
    }
    if (!ch.adds.length && !ch.copies?.length && !ch.deletes?.length) return result;
    try { await commitChanges(snap, ch, opts); snapCache = null; return result; }
    catch (e) { if (e instanceof ApiError && e.code === 'conflict' && attempt < MAX_RETRIES) { snapCache = null; continue; } if (e instanceof ApiError && e.code === 'conflict') throw new ApiError(409, { error: 'conflict', message: 'The vault changed while you were saving. Reload and try again.' }); throw e; }
  }
}

// ------------------------------------------------------------------ clip operations (same codes and shapes as site/hfspace/admin.py)
const invalid = field => new ApiError(422, { error: 'invalid', field });
const cleanText = (v, multi) => {
  let s = String(v).normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');
  s = multi ? s.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n') : s.replace(/[\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
  return s.trim();
};
function cleanField(name, v) { if (typeof v !== 'string') throw invalid(name); const s = cleanText(v, MULTILINE.has(name)); if (s.length > LIMITS[name]) throw invalid(name); return s; }
function cleanTags(v) {
  if (!Array.isArray(v) || v.length > 20) throw invalid('tags');
  const out = [];
  for (const t of v) { if (typeof t !== 'string') throw invalid('tags'); const s = cleanText(t, false); if (s.length > 40) throw invalid('tags'); if (s && !out.includes(s)) out.push(s); }
  return out;
}
function cleanPosted(v, cur) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => k !== 'youtube' && k !== 'instagram')) throw invalid('posted');
  const out = { youtube: cur?.youtube ?? null, instagram: cur?.instagram ?? null };
  for (const [k, x] of Object.entries(v)) { if (x === null) out[k] = null; else { const t = isoMs(x); if (!t) throw invalid('posted'); out[k] = t; } }
  return out;
}
const validId = id => { if (typeof id !== 'string' || !ID_RE.test(id) || id.includes('..')) throw new ApiError(404, { error: 'not_found' }); };

// ------------------------------------------------------------------ shortlist (its OWN private dataset, its OWN fine-grained token)
// The shortlist file lives at cfg.sl.dataset / cfg.sl.path (the clip dataset's _config/shortlist.json today, or a separate tiny dataset).
// Anyone who unlocked the site can change it with the shortlist token from the encrypted config (no admin mode); its scope is whatever
// the owner put in the config (see CLIP-VAULT.md). Clip reads keep using readToken. If the shortlist lives in another dataset, the old
// _config/shortlist.json in the clip dataset is only a read-only fallback and is never written.
const SHORTLIST = '_config/shortlist.json';
const slFile = () => cfg.sl.path || 'shortlist.json';
const slResolve = (p, rev) => `${HUB}/datasets/${cfg.sl.dataset}/resolve/${rev}/${repoPath(p)}`;
async function slHead() {
  const r = await hubOk(`${HUB}/api/datasets/${cfg.sl.dataset}/revision/main`, { token: slToken, who: 'shortlist' });
  const j = await r.json().catch(() => null);
  if (typeof j?.sha !== 'string' || !/^[0-9a-f]{7,64}$/.test(j.sha)) throw new ApiError(502, { error: 'upstream_error' });
  return j.sha;
}
async function slRead(p, rev) {   // null when the file does not exist
  const r = await hub(slResolve(p, rev), { token: slToken });
  if (r.status === 404) return null;
  if (!r.ok) throw mapErr(r.status, 'shortlist');
  return r.text();
}
// -> { ids: [{id, at, note?}], can_write }. A missing or unreadable file reads as an empty shortlist (a read never fails the page).
export async function listShortlist() {
  if (!readToken) throw new ApiError(401, { error: 'unauthorized' });
  const snap = await snapshot();
  snap.shortlistP ||= (async () => {
    try {
      let text = null;
      if (slToken && cfg.sl) text = await slRead(slFile(), 'main');
      if (text == null) text = await readText(SHORTLIST, snap.rev);   // old file in the clip dataset: read-only fallback
      return parseShortlist(text || '');
    } catch { return parseShortlist(''); }
  })();
  return { ids: await snap.shortlistP, can_write: !!slToken };
}
// Add or remove ONE moment key. The file is read at the parent revision of the SHORTLIST dataset, changed, committed there with an audit line;
// an unreadable existing file fails the call instead of being overwritten. Ids stay deduped. -> { ok, ids }
export async function setShortlist(key, on, note) {
  if (!readToken) throw new ApiError(401, { error: 'unauthorized' });
  if (!slToken || !cfg.sl) throw new ApiError(403, { error: 'forbidden' });
  if (typeof key !== 'string' || !key || key.length > 300 || /[\u0000-\u001f\u007f]/.test(key)) throw invalid('id');
  if (note != null && (typeof note !== 'string' || note.length > 200)) throw invalid('note');
  writing++; writeGeneration++;
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const rev = await slHead();
      let text; try { text = await slRead(slFile(), rev); } catch (e) { throw e instanceof ApiError ? e : new ApiError(502, { error: 'upstream_error' }); }
      if (text == null) text = await readText(SHORTLIST, 'main');   // first write: start from the old list so nothing is lost (read only)
      let cur; try { cur = parseShortlistStrict(text); } catch { throw new ApiError(502, { error: 'upstream_error' }); }
      const now = new Date();
      const next = toggleEntry(cur, key, !!on, isoNow(now), note == null ? undefined : cleanText(note, false));
      const had = cur.some(e => e.id === key), has = next.some(e => e.id === key);
      if (had === has && note == null) return { ok: true, ids: next };
      const apath = `_audit/${now.toISOString().slice(0, 7)}.jsonl`;
      let old = (await slRead(apath, rev)) || ''; if (old && !old.endsWith('\n')) old += '\n';
      const line = JSON.stringify({ at: isoNow(now), actor: 'shortlist', action: on ? 'shortlist' : 'unshortlist', clip_id: null, detail: { id: key } });
      const lines = [{ key: 'header', value: { summary: on ? 'Shortlist moment' : 'Remove from shortlist', description: '', parentCommit: rev } },
        { key: 'file', value: { content: b64(utf8(serializeShortlist(next))), path: slFile(), encoding: 'base64' } },
        { key: 'file', value: { content: b64(utf8(old + line + '\n')), path: apath, encoding: 'base64' } }];
      try {
        await hubOk(`${HUB}/api/datasets/${cfg.sl.dataset}/commit/main`, { method: 'POST', token: slToken, who: 'shortlist', headers: { 'Content-Type': 'application/x-ndjson' }, body: lines.map(l => JSON.stringify(l)).join('\n') + '\n' });
        snapCache = null; return { ok: true, ids: next };
      } catch (e) {
        if (e instanceof ApiError && e.code === 'shortlist_token_rejected') slToken = null;
        if (e instanceof ApiError && e.code === 'conflict' && attempt < MAX_RETRIES) continue;
        if (e instanceof ApiError && e.code === 'conflict') throw new ApiError(409, { error: 'conflict', message: 'The shortlist changed while you were saving. Try again.' });
        throw e;
      }
    }
  } finally { writing--; writeGeneration++; }
}

export async function patchClip(id, fields) {
  requireAdmin(); validId(id);
  if (!fields || typeof fields !== 'object' || !Object.keys(fields).length || Object.keys(fields).some(k => !EDITABLE.has(k))) throw new ApiError(422, { error: 'invalid' });
  const nw = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'tags') nw[k] = cleanTags(v);
    else if (k === 'notes') { if (typeof v !== 'string') throw invalid('notes'); const s = cleanText(v, true); if (s.length > MAX_NOTES) throw invalid('notes'); nw[k] = s; }
    else if (EDIT_ENUMS.includes(k)) { if (v === '' || v === null) nw[k] = null; else if (typeof v === 'string' && ENUMS[k].includes(v)) nw[k] = v; else throw invalid(k); }
    else if (k in EDIT_TEXT) { if (typeof v !== 'string') throw invalid(k); const t = cleanText(v, false); if (t.length > EDIT_TEXT[k]) throw invalid(k); nw[k] = t; }
    else if (k === 'posted') nw[k] = v; // merged with the stored value inside the transaction
    else nw[k] = cleanField(k, v);
  }
  if (nw.posted !== undefined) cleanPosted(nw.posted, null); // validate now (shape and timestamps)
  if ('title' in nw && !nw.title) throw invalid('title');
  const clip = await transact(snap => {
    const c = find(snap.index, id);
    if (!c) throw new ApiError(404, { error: 'not_found' });
    if (c.trashed_at) throw new ApiError(409, { error: 'in_trash' });
    Object.assign(c, nw, 'posted' in nw ? { posted: cleanPosted(nw.posted, c.posted) } : {}); c.updated_at = isoNow(new Date());
    return { ch: { index: snap.index, message: 'Edit clip metadata', audit: [{ action: 'edit', clip_id: id, detail: { fields: Object.keys(nw).sort() } }] }, result: { ...c } };
  });
  return { ok: true, clip };
}
function move(id, toTrash) {
  requireAdmin(); validId(id);
  return transact(snap => {
    const c = find(snap.index, id);
    if (!c) throw new ApiError(404, { error: 'not_found' });
    if (toTrash && c.trashed_at) throw new ApiError(409, { error: 'in_trash' });
    if (!toTrash && !c.trashed_at) throw new ApiError(409, { error: 'not_in_trash' });
    const ch = { copies: [], deletes: [], audit: [], index: snap.index, message: toTrash ? 'Trash clip' : 'Restore clip' };
    for (const p of clipFiles(c)) { const [s, d] = toTrash ? [p, trashPath(p)] : [trashPath(p), p]; ch.copies.push([s, d]); ch.deletes.push(s); }
    const now = new Date();
    if (toTrash) { c.trashed_at = isoNow(now); c.purge_after = isoNow(new Date(now.getTime() + TRASH_DAYS * 86400000)); c.updated_at = isoNow(now); }
    else { c.trashed_at = c.purge_after = null; c.updated_at = isoNow(now); }
    ch.audit.push({ action: toTrash ? 'trash' : 'restore', clip_id: id, detail: {} });
    return { ch, result: { ...c } };
  });
}
export const trashClip = async id => ({ ok: true, clip: await move(id, true) });
export const restoreClip = async id => ({ ok: true, clip: await move(id, false) });
function purge(index, victims, action) {
  const gone = new Set(victims.map(c => c.id));
  return { index: { ...index, clips: index.clips.filter(c => !gone.has(c.id)) }, deletes: victims.flatMap(c => clipFiles(c).map(trashPath)),
    audit: victims.map(c => ({ action, clip_id: c.id, detail: { title: c.title } })),
    tombstones: victims.map(c => ({ id: c.id, deleted_at: isoNow(new Date()), sha256: c.sha256 || null })) };
}
export async function deleteClip(id, confirmTitle) {
  requireAdmin(); validId(id);
  return withReauth(async () => {
    needFresh();
    await transact(snap => {
      const c = find(snap.index, id);
      if (!c) throw new ApiError(404, { error: 'not_found' });
      if (!c.trashed_at) throw new ApiError(409, { error: 'not_in_trash' });
      if (typeof confirmTitle !== 'string' || confirmTitle !== c.title) throw new ApiError(400, { error: 'confirm_mismatch' });
      return { ch: { ...purge(snap.index, [c], 'delete_forever'), message: 'Delete clip forever' }, result: null };
    });
    return { ok: true };
  });
}
export async function emptyTrash({ all = false } = {}) {
  requireAdmin();
  return withReauth(async () => {
    needFresh();
    const n = await transact(snap => {
      const now = Date.now();
      const victims = snap.index.clips.filter(c => c.trashed_at && (all || (c.purge_after && Date.parse(c.purge_after) <= now)));
      if (!victims.length) return { ch: { audit: [] }, result: 0 };
      return { ch: { ...purge(snap.index, victims, 'empty_trash'), message: `Purge ${victims.length} clip(s) from trash` }, result: victims.length };
    });
    return { ok: true, purged: n };
  });
}

// ------------------------------------------------------------------ upload (browser -> Hub). Max 150 MB video, 3 MB poster.
const slug = t => (t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'clip');
const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
async function videoMeta(file) {
  const out = { dur: null, width: null, height: null };
  const url = URL.createObjectURL(file);
  try {
    await new Promise(res => {
      const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true;
      const done = () => { clearTimeout(t); v.removeAttribute('src'); v.load(); res(); };
      const t = setTimeout(done, 8000);
      v.onloadedmetadata = () => { if (Number.isFinite(v.duration)) out.dur = Math.round(v.duration * 100) / 100; if (v.videoWidth) { out.width = v.videoWidth; out.height = v.videoHeight; } done(); };
      v.onerror = done; v.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
  return out;
}
export async function uploadClip(form, { onProgress, signal } = {}) {
  requireAdmin();
  const video = form.get('video'), poster = form.get('poster');
  if (!(video instanceof Blob) || !video.size) throw invalid('video');
  if (video.size > MAX_VIDEO) throw new ApiError(413, { error: 'too_large' });
  const head = new Uint8Array(await video.slice(0, 12).arrayBuffer());
  if (String.fromCharCode(...head.slice(4, 8)) !== 'ftyp') throw invalid('video');
  let hasPoster = poster instanceof Blob && poster.size > 0;
  if (hasPoster) {
    if (poster.size > MAX_POSTER) throw new ApiError(413, { error: 'too_large' });
    const p = new Uint8Array(await poster.slice(0, 3).arrayBuffer());
    if (p[0] !== 0xff || p[1] !== 0xd8 || p[2] !== 0xff) throw invalid('poster');
  }
  const meta = {}; for (const k of Object.keys(LIMITS)) meta[k] = cleanField(k, String(form.get(k) ?? ''));
  if (!meta.title) throw invalid('title');
  const rawTags = String(form.get('tags') ?? '');
  if (rawTags.length > 2000) throw invalid('tags');
  const tags = cleanTags(rawTags.split(',').filter(t => t.trim()));
  const sha = await sha256(video);
  if (signal?.aborted) throw abortErr();
  const info = await videoMeta(video);
  // duplicate check: index sha256 first, then the Hub's own LFS oid of v1 clips that have no sha256 (an LFS oid IS the file's sha256)
  const dupOf = async snap => {
    const d = snap.index.clips.find(c => c.sha256 === sha); if (d) return d.id;
    const need = snap.index.clips.filter(c => !c.sha256 && c.video);
    if (need.length) { const infos = await pathsInfo(snap.rev, need.map(c => c.video)); const hit = need.find(c => infos.get(c.video)?.lfs?.oid === sha); if (hit) return hit.id; }
    return null;
  };
  const total = video.size + (hasPoster ? poster.size : 0); let loaded = 0;
  const onBytes = n => { loaded = Math.min(total, loaded + n); onProgress?.({ loaded, total }); };
  onProgress?.({ loaded: 0, total });
  const clip = await transact(async snap => {
    loaded = 0;
    const dup = await dupOf(snap);
    if (dup) throw new ApiError(409, { error: 'duplicate', clip_id: dup });
    const ids = new Set(snap.index.clips.map(c => c.id)), now = new Date();
    const stamp = isoNow(now).replace(/[-:]/g, '').replace('T', '-').replace('Z', '');
    let cid = `${slug(meta.title)}-${stamp}`;
    while (ids.has(cid)) cid = `${slug(meta.title)}-${stamp}-${[...crypto.getRandomValues(new Uint8Array(2))].map(x => x.toString(16).padStart(2, '0')).join('')}`;
    const c = { id: cid, ...meta, tags, dur: info.dur, score: null, size: video.size, width: info.width, height: info.height, fps: null, codec: null, bitrate: null, sha256: sha,
      added_at: isoNow(now), updated_at: isoNow(now), video: `clips/${cid}.mp4`, poster: hasPoster ? `clips/${cid}.jpg` : null, trashed_at: null, purge_after: null };
    const adds = [{ path: c.video, file: video, sha }];
    if (hasPoster) adds.push({ path: c.poster, file: poster, sha: await sha256(poster) });
    return { ch: { index: { ...snap.index, clips: [c, ...snap.index.clips] }, adds, message: 'Upload clip', audit: [{ action: 'upload', clip_id: cid, detail: { sha256: sha, size: video.size } }] }, result: c };
  }, { onBytes, signal });
  return { ok: true, clip };
}

// ------------------------------------------------------------------ error text
export function errorText(err, what = 'That') {
  if (!(err instanceof ApiError)) return 'Something went wrong. Try again.';
  switch (err.status) {
    case 0: return 'Could not reach Hugging Face. Check your connection and try again.';
    case 400: return err.code === 'confirm_mismatch' ? 'That did not match. Nothing was deleted.' : 'That request was not valid.';
    case 401: return 'The vault is locked. Type the passphrase again.';
    case 403:
      if (err.code === 'bad_passphrase') return 'That passphrase did not work';
      if (err.code === 'admin_token_rejected') return 'Hugging Face rejected the admin token. Admin mode is off; open Admin and paste it again.';
      if (err.code === 'reauth_cancelled') return 'Cancelled. Type the passphrase again to continue.';
      if (err.code === 'reauth_required') return 'Please type the passphrase again to continue.';
      return 'Admin mode is off. Use the Admin button and paste the write token.';
    case 404: return err.code === 'no_users' ? 'There are no personal accounts here: one shared passphrase opens the vault.' : `${what} no longer exists. It may have been moved or deleted.`;
    case 409:
      if (err.code === 'in_trash' || err.code === 'not_in_trash') return 'That clip is not in the state this needs. Reload and retry.';
      return err.code === 'duplicate' ? 'This exact video is already in the vault.' : (err.body.message || 'The vault changed under you. Reload and retry.');
    case 413: return 'That file is too large (video max 150 MB, poster max 3 MB).';
    case 422: return err.body.message || 'Some fields are not valid. Check them and try again.';
    case 429: return err.code === 'too_fast' ? `Too many wrong tries. Wait ${err.body.wait || 1} s and try again.` : 'Hugging Face says too many requests. Wait a minute and try again.';
    case 502: return 'The vault storage did not answer. Try again shortly.';
    case 503:
      if (err.code === 'vault_unreachable') return 'Unlocked, but the vault could not be reached (the read token may have been revoked). Tell the owner.';
      if (err.code === 'not_configured') return 'The site is not configured yet. Tell the owner.';
      return 'The service is unavailable. Try again shortly.';
    default: return err.body.message || `Error ${err.status}. Try again.`;
  }
}
