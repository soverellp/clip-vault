// Shortlist: pure helpers (no DOM, no network, no imports). The shortlist lives in the dataset as _config/shortlist.json:
//   {"version":1,"ids":[{"id":"<moment key or clip id>","at":"<iso>","note":"<optional>"}]}
// A key is per MOMENT: "<stream>|<group>" for a clip that has a group and a known variant (all versions of one moment share it), else the clip id.
export const MAX_SHORTLIST = 2000;
const SLOTS = new Set(['with-streamer', 'with-girl', 'clean', 'face-top']);
export const momentKey = c => (c && c.group && SLOTS.has(c.variant) ? `${c.stream || ''}|${c.group}` : String(c?.id ?? ''));
const okId = s => typeof s === 'string' && s.length > 0 && s.length <= 300 && !/[\u0000-\u001f\u007f]/.test(s);
const okAt = s => (typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(s) ? s : null);
// -> [{id, at, note?}] in file order, deduped (a later entry with the same id wins and moves to the end), junk skipped, newest MAX_SHORTLIST kept.
export function parseShortlist(raw) {
  let o = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return []; } }
  const arr = Array.isArray(o?.ids) ? o.ids : [];
  const by = new Map();
  for (let e of arr) {
    if (typeof e === 'string') e = { id: e };
    if (!e || typeof e !== 'object' || !okId(e.id)) continue;
    const x = { id: e.id, at: okAt(e.at) };
    if (typeof e.note === 'string' && e.note.trim()) x.note = e.note.trim().slice(0, 200);
    by.delete(e.id); by.set(e.id, x);
  }
  return [...by.values()].slice(-MAX_SHORTLIST);
}
// Same parse, but a file that exists and is not a valid shortlist is an ERROR (a write must never overwrite what it cannot read).
export function parseShortlistStrict(text) {
  if (text == null) return [];
  let o; try { o = JSON.parse(text); } catch { throw new Error('unreadable'); }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.ids)) throw new Error('unreadable');
  return parseShortlist(o);
}
export const serializeShortlist = list => JSON.stringify({ version: 1, ids: list.map(e => ({ id: e.id, at: e.at, ...(e.note ? { note: e.note } : {}) })) }, null, 1);
// -> new list. on=true adds (an existing entry keeps its date; a note replaces the old one only when given), on=false removes.
export function toggleEntry(list, id, on, at, note) {
  const cur = list.find(e => e.id === id), rest = list.filter(e => e.id !== id);
  if (!on) return rest;
  const n = typeof note === 'string' && note.trim() ? note.trim().slice(0, 200) : cur?.note;
  return [...rest, { id, at: cur?.at || at, ...(n ? { note: n } : {}) }].slice(-MAX_SHORTLIST);
}
export const keySet = list => new Set(list.map(e => e.id));
// Keys that point at a clip that is still in the library (active clips only: trashed or deleted clips are passed out, so their ids are stale and ignored).
export function liveKeys(list, activeClips) {
  const have = new Set(activeClips.map(momentKey)), out = new Set();
  for (const e of list) if (have.has(e.id)) out.add(e.id);
  return out;
}
export const isShortlisted = (list, c) => list.some(e => e.id === momentKey(c));
const slot = c => (c.variant === 'with-streamer' || c.variant === 'with-girl' ? 0 : c.variant === 'clean' ? 1 : 2);
// Plain text list of the shortlisted moments: "1. Title (stream)" and the post caption underneath when the clip has one.
export function shortlistText(list, activeClips, { pretty = s => s || '', title = c => c.title || 'Untitled clip' } = {}) {
  const live = liveKeys(list, activeClips), rep = new Map();
  for (const c of activeClips) { const k = momentKey(c); if (live.has(k) && (!rep.has(k) || slot(c) < slot(rep.get(k)))) rep.set(k, c); }
  const caption = c => String(c.post || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const lines = [];
  let i = 0;
  for (const c of rep.values()) { i++; lines.push(`${i}. ${title(c)} (${pretty(c.stream)})`); const p = caption(c); if (p) lines.push('   ' + p); }
  return lines.join('\n');
}
