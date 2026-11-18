import { state, emit } from './state.js';

export class ApiError extends Error {
  constructor(status, body) { super(body?.message || `HTTP ${status}`); this.status = status; this.code = body?.error || ''; this.body = body || {}; }
}
let reauthHandler = null;
export const setReauthHandler = fn => { reauthHandler = fn; };
async function request(method, path, opts = {}) {
  try { return await once(method, path, opts); }
  catch (e) {
    // Step-up auth: destructive/privilege actions need a session younger than 15 min. Ask for a fresh Google sign-in, retry once.
    if (e instanceof ApiError && e.status === 403 && e.code === 'reauth_required' && reauthHandler && !opts.retried) {
      if (await reauthHandler()) return once(method, path, { ...opts, retried: true });
      throw new ApiError(403, { error: 'reauth_cancelled', message: 'Re-authentication was cancelled.' });
    }
    throw e;
  }
}
async function once(method, path, { json, form, signal, quiet401 } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET' && state.me?.csrf) headers['X-CSRF-Token'] = state.me.csrf;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (form) body = form;
  let res;
  try { res = await fetch(path, { method, headers, body, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'manual' }); }
  catch (e) { if (e?.name === 'AbortError') throw e; throw new ApiError(0, { error: 'network', message: 'Network error' }); }
  if (res.status === 204) return null;
  let data = null;
  if ((res.headers.get('content-type') || '').includes('json')) { try { data = await res.json(); } catch { data = null; } }
  if (res.type === 'opaqueredirect') return null;
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && !quiet401) emit('unauthorized', err);
    throw err;
  }
  return data;
}

const get = (p, o) => request('GET', p, o);
const post = (p, json = {}, o) => request('POST', p, { json, ...o });
const patch = (p, json, o) => request('PATCH', p, { json, ...o });
const del = (p, json, o) => request('DELETE', p, { json, ...o });
const enc = encodeURIComponent;

// =====================================================================================================
// THE interface. This is the ONLY module that talks to the network (fetch / XHR / media / Google script).
// A second implementation (static mode, no server) must export the same names; everything else imports "./api.js".
// =====================================================================================================
export const MODE = 'server';

// ---- auth -------------------------------------------------------------------------------------------
// -> { provider: 'google'|'passphrase', client_id?, nonce? }
export const authConfig = async () => { const c = await get('/api/auth/config', { quiet401: true }); return { provider: 'google', ...c }; };
export const loadGoogleIdentity = () => loadScript('https://accounts.google.com/gsi/client', () => window.google?.accounts?.id);
export const authGoogle = credential => post('/api/auth/google', { credential }, { quiet401: true });
export const reauthGoogle = credential => post('/api/auth/reauth', { credential }, { quiet401: true });
export const loginPassphrase = async () => { throw new ApiError(400, { error: 'unsupported', message: 'Passphrase sign-in is not available in server mode.' }); };
export const logout = async () => { try { await post('/logout', {}, { quiet401: true }); } catch { /* cookie may already be gone */ } };
// -> { email, name, picture, role, csrf, can_write, sub, root, session_age_seconds, capabilities:{users,trash,audit,upload} }; throws ApiError(401) when signed out
export async function me() {
  const m = await get('/api/me', { quiet401: true });
  const admin = m?.role === 'admin';
  return { ...m, capabilities: { users: admin, trash: admin, audit: admin, upload: admin && m.can_write === true, ...(m?.capabilities || {}) } };
}

// ---- clips ------------------------------------------------------------------------------------------
export const listClips = ({ trash = false } = {}) => get('/api/clips' + (trash ? '?trash=1' : ''), { quiet401: true });
// Streams (the folders of the library): -> { streams:[{ id, title, channel, date, url, thumb, clip_count }] }. The server store has no stream records, so
// server mode answers an empty list and the UI builds its folders from clip.stream alone (only when clips carry the new moment fields).
export const listStreams = async () => ({ streams: [] });
export const patchClip = (id, fields) => patch(`/api/clips/${enc(id)}`, fields);
export const trashClip = id => post(`/api/clips/${enc(id)}/trash`, {});
export const restoreClip = id => post(`/api/clips/${enc(id)}/restore`, {});
export const deleteClip = (id, confirmTitle) => del(`/api/clips/${enc(id)}`, { confirm: confirmTitle });
export const emptyTrash = ({ all = false } = {}) => post('/api/trash/empty', all ? { all: true, confirm: 'EMPTY TRASH' } : { confirm: 'EMPTY TRASH' });
export const audit = () => get('/api/audit');

// multipart upload with progress. onProgress({loaded,total}); signal aborts (rejects with AbortError). Resolves with the JSON body (201).
export function uploadClip(form, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/clips'); x.setRequestHeader('X-CSRF-Token', state.me?.csrf || ''); x.setRequestHeader('Accept', 'application/json');
    if (onProgress) x.upload.onprogress = e => { if (e.lengthComputable) onProgress({ loaded: e.loaded, total: e.total }); };
    x.onload = () => {
      let data = null; try { data = JSON.parse(x.responseText); } catch { /* ignore */ }
      if (x.status >= 200 && x.status < 300) return resolve(data);
      const e = new ApiError(x.status, data); if (x.status === 401) emit('unauthorized', e); reject(e);
    };
    x.onerror = () => reject(new ApiError(0, { error: 'network', message: 'Network error' }));
    x.onabort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal) { if (signal.aborted) return x.abort(); signal.addEventListener('abort', () => x.abort(), { once: true }); }
    x.send(form);
  });
}

// ---- media ------------------------------------------------------------------------------------------
const SAFE = /^clips\/[\w.\-ऀ-ॿ]{1,200}\.(mp4|jpg|jpeg)$/;
// Direct same-origin URL (server mode: Range streaming works). Returns null when media must be fetched as a blob (static mode).
export function directMediaUrl(path, { trashed = false } = {}) {
  if (typeof path !== 'string' || path.includes('..') || !SAFE.test(path)) return null;
  return '/api/files/' + (trashed ? 'trash/' : '') + path.split('/').map(enc).join('/');
}
// Always works: -> Promise<{ url, revoke() }>. Server mode resolves at once with the direct URL; static mode downloads with progress and returns a blob URL.
export async function fetchMedia(path, { trashed = false, onProgress, signal } = {}) {
  const url = directMediaUrl(path, { trashed });
  if (!url) throw new ApiError(404, { error: 'not_found', message: 'No such file' });
  return { url, revoke() {} };
}

// Convenience: point an <img> at a vault file (direct URL, or a blob URL in static mode). Rejects when the file cannot be loaded.
export async function loadImage(img, path, opts = {}) {
  const u = directMediaUrl(path, opts);
  if (u) { img.src = u; return; }
  const m = await fetchMedia(path, opts); img.src = m.url;
}

// ---- users (capability: me().capabilities.users) ------------------------------------------------------
// -> { users:[{email,role,root,source:'secret'|'site',added_at,added_by}], root_admins:[email] }
export const listUsers = () => get('/api/users');
export const addUser = (email, role) => post('/api/users', { email, role });
export const setUserRole = (email, role) => patch(`/api/users/${enc(email)}`, { role });
export const removeUser = email => del(`/api/users/${enc(email)}`, { confirm: email });

// ---- helpers (private) --------------------------------------------------------------------------------
const scripts = new Map();
function loadScript(src, ready) {
  if (ready()) return Promise.resolve();
  if (scripts.has(src)) return scripts.get(src);
  const p = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    s.onload = () => (ready() ? res() : rej(new Error('script'))); s.onerror = () => rej(new Error('script'));
    setTimeout(() => rej(new Error('timeout')), 12000); document.head.append(s);
  }).catch(e => { scripts.delete(src); throw e; });
  scripts.set(src, p); return p;
}

// Friendly text per status (server message is only used where it is useful and safe: it is rendered with textContent).
export function errorText(err, what = 'That') {
  if (!(err instanceof ApiError)) return 'Something went wrong. Try again.';
  switch (err.status) {
    case 0: return 'Could not reach the server. Check your connection and try again.';
    case 401: return 'Your session ended. Please sign in again.';
    case 403:
      if (err.code === 'managed_by_secret') return 'This person is set up on the server and cannot be changed here.';
      if (err.code === 'root_admin') return 'Root admins are set on the server and cannot be changed here.';
      if (err.code === 'self') return 'You cannot change or remove your own access.';
      if (err.code === 'reauth_cancelled') return 'Cancelled. Confirm it is you to continue.';
      if (err.code === 'reauth_required') return 'Please confirm it is you (sign in with Google again).';
      return 'You do not have permission to do that.';
    case 404: return `${what} no longer exists. It may have been moved or deleted.`;
    case 409:
      if (err.code === 'exists') return 'That person is already on the list.';
      if (err.code === 'in_trash' || err.code === 'not_in_trash') return 'That clip is not in the state this needs. Reload and retry.';
      return err.code === 'duplicate' ? 'This exact video is already in the vault.' : (err.body.message || 'That conflicts with a newer change. Reload and retry.');
    case 413: return 'That file is too large (video max 150 MB, poster max 3 MB).';
    case 415: return 'Unsupported file type. Use an .mp4 video and a JPEG poster.';
    case 422: return err.body.message || 'Some fields are not valid. Check them and try again.';
    case 429: return 'Too many requests. Wait a minute and try again.';
    case 502: return 'The vault storage did not answer. Try again shortly.';
    case 503:
      if (err.code === 'not_configured') return 'The site is not configured yet. Tell the owner.';
      return err.code === 'read_only' ? 'The vault is read-only right now. Try again later.' : 'The service is unavailable. Try again shortly.';
    default: return err.body.message || `Server error (${err.status}). Try again.`;
  }
}
