// One small in-memory store. Nothing here is persisted anywhere in the browser.
export const state = {
  me: null, authChecked: false,
  clips: [], trash: [], counts: { active: 0, trash: 0 }, loaded: false, loadError: false, trashLoaded: false,
  view: 'library', mode: 'grid', sort: 'newest', streams: new Set(), postedOn: new Set(), tags: new Set(), minScore: 0, q: '',
  selecting: false, selected: new Set(),
  queue: 'all', post: 'any', shortlist: [], shortlistOnly: false, group: false, collapsed: new Set(), feedIds: [],
  folders: [], folder: null, cat: 'all', variants: new Map(), sortTouched: false, filterOpen: false, homeSort: 'clipped', homeFilter: new Set(), lang: '', libHash: '#/',
  lowPower: false, theme: 'auto', reduced: false,
  audit: null,
  mediaRev: new Map(),   // repo path -> counter; bumped when a poster/thumbnail file was replaced (live refresh), so the card reloads it
};
const subs = {};
export const on = (ev, fn) => { (subs[ev] ||= new Set()).add(fn); return () => subs[ev].delete(fn); };
export const emit = (ev, data) => { for (const fn of [...(subs[ev] || [])]) { try { fn(data); } catch (e) { console.error(e); } } };

export const isAdmin = () => state.me?.role === 'admin';
export const canWrite = () => isAdmin() && state.me?.can_write === true;
export const listFor = view => (view === 'trash' ? state.trash : state.clips);
export const findClip = id => state.clips.find(c => c.id === id) || state.trash.find(c => c.id === id) || null;
export function replaceClip(clip) {
  for (const list of [state.clips, state.trash]) { const i = list.findIndex(c => c.id === clip.id); if (i >= 0) list[i] = clip; }
}
export function removeClip(id) {
  state.clips = state.clips.filter(c => c.id !== id); state.trash = state.trash.filter(c => c.id !== id);
  state.selected.delete(id);
}
// Where Close / Back goes from a clip: the page the clip was opened from (a stream folder or the library home), the trash view, or '#/'.
export const backHash = () => (state.view === 'trash' ? '#/trash' : (state.libHash || '#/'));
