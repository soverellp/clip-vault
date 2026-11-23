import { state, emit, isAdmin } from './state.js';
import * as api from './api.js';
import { postedMap } from './playlists.js';
import { postedExtra } from './fmt.js';

export function setPlaylistsDoc(doc) { state.playlists = doc; postedExtra.map = postedMap(doc); }
export async function loadPlaylistData() {
  const [p, t] = await Promise.all([api.listPlaylists().catch(() => null), api.listTemplates().catch(() => null)]);
  if (p?.doc) { setPlaylistsDoc(p.doc); state.plExists = p.exists !== false; }
  if (t?.doc) { state.templates = t.doc; state.tplExists = t.exists !== false; }
  state.plLoaded = true;
}

export async function loadActive(boot = false) {
  try {
    const [r, st, sl] = await Promise.all([api.listClips(), api.listStreams().catch(() => null), api.listShortlist().catch(() => null)]);
    state.clips = Array.isArray(r?.clips) ? r.clips.filter(c => c && typeof c === 'object' && c.id != null).map(c => ({ ...c, id: String(c.id) })) : [];
    if (r?.counts) state.counts = { ...state.counts, ...r.counts }; else state.counts.active = state.clips.length;
    if (r && 'can_write' in r && state.me) state.me.can_write = state.me.can_write && r.can_write !== false;
    state.folders = Array.isArray(st?.streams) ? st.streams.filter(x => x && typeof x.id === 'string') : [];
    if (Array.isArray(sl?.ids)) state.shortlist = sl.ids;
    state.loaded = true; state.loadError = false;
    if (!state.plLoaded) await loadPlaylistData();
  } catch (e) { if (e.status === 401) { if (state.me && !boot) emit('unauthorized'); } else { state.loadError = true; state.loaded = true; } }
  emit('clips');
}
export async function loadTrash() {
  if (!isAdmin()) return;
  try {
    const r = await api.listClips({ trash: true });
    state.trash = Array.isArray(r?.clips) ? r.clips.filter(c => c && c.id != null).map(c => ({ ...c, id: String(c.id) })) : [];
    if (r?.counts) state.counts = { ...state.counts, ...r.counts }; else state.counts.trash = state.trash.length;
    state.trashLoaded = true;
  } catch (e) { state.trashLoaded = true; if (e.status !== 401 && e.status !== 403) state.loadError = true; }
  emit('clips');
}
export async function loadAll() { await Promise.all([loadActive(), isAdmin() ? loadTrash() : null]); }
