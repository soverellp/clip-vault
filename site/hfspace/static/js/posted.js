// "Posted on" (D53): pure helpers (no DOM, no network). Stored as _config/posted.json in the clip dataset:
//   {"version":1,"posted":{"<moment key>":{"<platform>":{"date":"YYYY-MM-DD","link":"https://..."|""}}}}
// A moment counts as posted on a platform when ANY source says so: the index field posted_on (admin edit form), this file, or the legacy playlists.json posted marks.
// New writes go ONLY to this file; the other two are read-only legacy (removal is the one exception, see removalPlan).
export const PO_PLATFORMS = ['youtube', 'instagram', 'tiktok', 'x', 'other'];
export const PO_LABEL = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', x: 'X', other: 'Other' };
export const MAX_MOMENTS = 5000;
export const emptyPosted = () => ({ version: 1, posted: {} });
const okKey = s => typeof s === 'string' && s.length > 0 && s.length <= 300 && !/[\u0000-\u001f\u007f]/.test(s);

// A real calendar date, YYYY-MM-DD.
export function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
// Empty, or an https:// link without spaces or control characters (max 500). Never http, javascript:, data: ...
export const validLink = s => s === '' || (typeof s === 'string' && s.length <= 500 && !/[\u0000- \u007f]/.test(s) && /^https:\/\/[^/?#]+/i.test(s));
export function cleanEntry(v) {
  if (!v || typeof v !== 'object') return null;
  const d = typeof v.date === 'string' ? v.date.slice(0, 10) : '';
  if (!validDate(d)) return null;
  return { date: d, link: validLink(v.link ?? '') ? (v.link ?? '') : '' };
}
export function todayYmd(now = new Date()) { return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }

// Lenient parse (reading): junk is skipped, a missing or broken file is an empty document.
export function parsePosted(raw) {
  let o = raw;
  if (typeof raw === 'string') { if (!raw.trim()) return emptyPosted(); try { o = JSON.parse(raw); } catch { return emptyPosted(); } }
  const out = emptyPosted(), src = o && typeof o === 'object' && o.posted && typeof o.posted === 'object' && !Array.isArray(o.posted) ? o.posted : {};
  for (const [k, pm] of Object.entries(src)) {
    if (!okKey(k) || !pm || typeof pm !== 'object') continue;
    const m = {}; for (const p of PO_PLATFORMS) { const e = cleanEntry(pm[p]); if (e) m[p] = e; }
    if (Object.keys(m).length) out.posted[k] = m;
  }
  return out;
}
// Strict parse (before a write): an existing file that is not a valid document is an ERROR, never overwritten. null / '' = does not exist yet.
export function parsePostedStrict(text) {
  if (text == null || !String(text).trim()) return emptyPosted();
  const o = JSON.parse(text);
  if (!o || typeof o !== 'object' || Array.isArray(o) || (o.version != null && o.version !== 1) || !o.posted || typeof o.posted !== 'object' || Array.isArray(o.posted)) throw new Error('invalid');
  return parsePosted(o);
}
export function serializePosted(doc) {
  const d = parsePosted(doc), out = {};
  for (const k of Object.keys(d.posted).sort()) { out[k] = {}; for (const p of PO_PLATFORMS) if (d.posted[k][p]) out[k][p] = d.posted[k][p]; }
  return JSON.stringify({ version: 1, posted: out }, null, 2) + '\n';
}
// ops: set{moment_id,platform,date,link} unset{moment_id,platform} -> { doc, summary, changed }; never mutates the input; throws Error('invalid').
export function applyPostedOp(doc0, op) {
  const doc = parsePosted(JSON.parse(JSON.stringify(doc0 || emptyPosted()))), t = op?.type;
  if (!okKey(op?.moment_id) || !PO_PLATFORMS.includes(op?.platform)) throw new Error('invalid');
  const mid = op.moment_id, p = op.platform;
  if (t === 'set') {
    if (!validDate(op.date) || !validLink(op.link ?? '')) throw new Error('invalid');
    const e = { date: op.date, link: op.link ?? '' }, cur = doc.posted[mid]?.[p];
    if (cur && cur.date === e.date && cur.link === e.link) return { doc, summary: 'Mark posted', changed: false };
    if (!doc.posted[mid] && Object.keys(doc.posted).length >= MAX_MOMENTS) throw new Error('limit');
    (doc.posted[mid] ||= {})[p] = e;
    return { doc, summary: 'Mark posted', changed: true };
  }
  if (t === 'unset') {
    if (!doc.posted[mid]?.[p]) return { doc, summary: 'Unmark posted', changed: false };
    delete doc.posted[mid][p]; if (!Object.keys(doc.posted[mid]).length) delete doc.posted[mid];
    return { doc, summary: 'Unmark posted', changed: true };
  }
  throw new Error('invalid');
}

// ---- merged view (3 sources). indexOn = clip.posted_on (array), doc = posted.json, playlists = playlists.json document.
// -> { <platform>: { sources: ['posted'|'playlist'|'index'...], date, link } } for the platforms the moment is posted on. Date and link: posted.json first, then a playlist mark.
export function mergedPosted(key, { indexOn = [], doc = null, playlists = null } = {}) {
  const out = {}, add = (p, src, e) => { const m = (out[p] ||= { sources: [], date: '', link: '' }); if (!m.sources.includes(src)) m.sources.push(src); if (e && !m.date) { m.date = e.date || ''; m.link = e.link || ''; } };
  const mine = doc?.posted?.[key] || {};
  for (const p of PO_PLATFORMS) {
    if (mine[p]) add(p, 'posted', mine[p]);
    for (const pl of playlists?.playlists || []) for (const it of pl.items || []) if (it.moment_id === key && it.posted?.[p]) add(p, 'playlist', it.posted[p]);
    if (Array.isArray(indexOn) && indexOn.includes(p)) add(p, 'index', null);
  }
  return out;
}
// moment key -> Set(platform) for posted.json and the playlists (the Library "Posted on" filter reads this next to clip.posted_on)
export function postedUnion(doc, playlists) {
  const m = new Map(), put = (k, p) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(p); };
  for (const [k, pm] of Object.entries(doc?.posted || {})) for (const p of PO_PLATFORMS) if (pm[p]) put(k, p);
  for (const pl of playlists?.playlists || []) for (const it of pl.items || []) for (const p of PO_PLATFORMS) if (it.posted?.[p]) put(it.moment_id, p);
  return m;
}
// Playlist ops that remove the legacy marks of one platform on one moment.
export const playlistUnmarkOps = (playlists, key, platform) => (playlists?.playlists || []).filter(pl => (pl.items || []).some(i => i.moment_id === key && i.posted?.[platform])).map(pl => ({ type: 'unmark_posted', id: pl.id, moment_id: key, platform }));
// What toggling a platform OFF does: { unset: posted.json entry removed, playlistOps: [...], index: 'remove' (admin) | 'blocked' (not an admin) | null, full: nothing stays posted }
export function removalPlan(merged, key, platform, playlists, { admin = false } = {}) {
  const m = merged?.[platform]; if (!m) return { unset: false, playlistOps: [], index: null, full: true };
  const has = s => m.sources.includes(s), index = has('index') ? (admin ? 'remove' : 'blocked') : null;
  return { unset: has('posted'), playlistOps: has('playlist') ? playlistUnmarkOps(playlists, key, platform) : [], index, full: index !== 'blocked' };
}
