import { state, emit, isAdmin } from './state.js';
import * as api from './api.js';

export async function loadActive(boot = false) {
  try {
    const [r, st] = await Promise.all([api.listClips(), api.listStreams().catch(() => null)]);
    state.clips = Array.isArray(r?.clips) ? r.clips.filter(c => c && typeof c === 'object' && c.id != null).map(c => ({ ...c, id: String(c.id) })) : [];
    if (r?.counts) state.counts = { ...state.counts, ...r.counts }; else state.counts.active = state.clips.length;
    if (r && 'can_write' in r && state.me) state.me.can_write = state.me.can_write && r.can_write !== false;
    state.folders = Array.isArray(st?.streams) ? st.streams.filter(x => x && typeof x.id === 'string') : [];
    state.loaded = true; state.loadError = false;
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
