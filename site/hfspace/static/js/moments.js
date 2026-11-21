// Moments and folders: pure helpers (no DOM, no network). A moment is one card; its variants (with-streamer / clean / face-top) are the same moment cut up to three times.
// Everything is optional: a clip without group / variant / reaction / kind / tier is its own moment and the library stays a flat list.
import { pretty } from './fmt.js';

export const VARIANTS = [['with-streamer', 'With streamer'], ['clean', 'Clean'], ['face-top', 'Face on top']];
// The stored value is 'with-streamer'; the older 'with-girl' is read as the same variant until the index is migrated.
export const variantOf = c => (c && (c.variant === 'with-streamer' || c.variant === 'with-girl') ? 'with-streamer' : c && c.variant === 'clean' ? 'clean' : c && c.variant === 'face-top' ? 'face-top' : null);
export const REACTIONS = ['strong', 'mild', 'none', 'unrated'];
export const CATS = [['reaction', 'Streamer reactions'], ['game', 'Game moments'], ['best', 'Best'], ['all', 'All']];
const TIER_ORDER = { A: 0, B: 1, C: 2 };
export const tierOf = c => (c && TIER_ORDER[c.tier] != null ? c.tier : null);
export const reactionOf = c => (c && REACTIONS.includes(c.reaction) ? c.reaction : 'unrated');
const rankNum = c => (c && Number.isFinite(+c.rank) && c.rank !== null && c.rank !== '' ? +c.rank : Infinity);
export const hasNewFields = c => !!c && !!(c.group || c.variant || c.kind || c.tier || c.reaction || c.why || (c.rank != null && c.rank !== ''));
// Better first: tier A before B before C before unrated, then the lower rank number, then the higher score.
export const rankCmp = (a, b) => (TIER_ORDER[tierOf(a)] ?? 3) - (TIER_ORDER[tierOf(b)] ?? 3) || rankNum(a) - rankNum(b) || (Number(b.score) || 0) - (Number(a.score) || 0);

// -> [{ key, group, stream, clips:[...], byVariant:{ 'with-streamer': clip, clean: clip, 'face-top': clip } }] in the order of the first clip of each moment.
// Only clips that carry a known variant and a group are merged, and only one clip per variant slot; anything else stays a moment of its own.
export function buildMoments(clips) {
  const out = [], byKey = new Map();
  for (const c of clips) {
    const slot = c.group ? variantOf(c) : null;
    const k = slot ? `${c.stream || ''}|${c.group}` : null;
    const m = k ? byKey.get(k) : null;
    if (m && !m.byVariant[slot]) { m.byVariant[slot] = c; m.clips.push(c); continue; }
    const n = { key: k && !m ? k : 'c:' + c.id, group: slot ? c.group : null, stream: c.stream || '', clips: [c], byVariant: slot ? { [slot]: c } : {} };
    if (k && !m) byKey.set(k, n);
    out.push(n);
  }
  return out;
}
export const hasPair = m => Object.keys(m.byVariant).length > 1;
// The default variant is "Clean" when the moment has it, otherwise With streamer, otherwise whatever it has.
export function pick(m, sel) {
  return m.byVariant[sel] || m.byVariant.clean || m.byVariant['with-streamer'] || m.byVariant['face-top'] || m.clips[0];
}
// What a card shows: the selected variant's own fields, filled from the other variant when they are empty.
export function infoOf(m, rep) {
  const o = m.clips.filter(c => c !== rep);
  const first = f => (rep[f] ?? null) !== null && rep[f] !== '' ? rep[f] : (o.map(c => c[f]).find(v => v != null && v !== '') ?? null);
  let reaction = reactionOf(rep); if (reaction === 'unrated') reaction = o.map(reactionOf).find(r => r !== 'unrated') || 'unrated';
  const note = rep.reaction_note || o.map(c => c.reaction_note).find(Boolean) || '';
  return { reaction, note, kind: first('kind'), tier: tierOf(rep) || o.map(tierOf).find(Boolean) || null, rank: rankNum(rep) !== Infinity ? rankNum(rep) : o.map(rankNum).find(n => n !== Infinity) ?? null, why: first('why') || '', hook: first('hook') || '' };
}
// A missing kind counts as 'game' (data contract, API-CONTRACT.md section 0).
export const catHas = (m, cat) => cat === 'all' || m.clips.some(c => (cat === 'best' ? tierOf(c) === 'A' : (c.kind || 'game') === cat));
export function catCounts(moments) { const n = {}; for (const [k] of CATS) n[k] = moments.filter(m => catHas(m, k)).length; return n; }
export const momentRankCmp = (a, b) => { const x = a.clips.slice().sort(rankCmp)[0], y = b.clips.slice().sort(rankCmp)[0]; return rankCmp(x, y); };

// ---- folders (one per stream)
const dateOfId = id => { const m = /^(\d{4}-\d\d-\d\d)/.exec(String(id || '')); return m ? m[1] : ''; };
export const folderId = f => f.id || '';
export const folderHref = id => '#/stream/' + (id ? encodeURIComponent(id) : '~other');
export const folderFromHash = s => (s === '~other' ? '' : s);
// metas: [{id,title,channel,date,clipped_at,lang,lang_name,url,thumb,clip_count}] from the index (may be empty: then folders come from clip.stream alone).
// "clipped" = when the stream's newest clip was rendered (D40); old data has none and falls back to the YouTube date.
const LANGS = { en: 'English', hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', ar: 'Arabic', ja: 'Japanese', ko: 'Korean', ru: 'Russian', id: 'Indonesian', tr: 'Turkish' };
export const langName = c => (!c || c === 'unknown' ? '' : LANGS[c] || String(c).toUpperCase());
export const timeKey = f => f.clipped || f.date || '';
const cmpNewest = (a, b) => timeKey(b).localeCompare(timeKey(a)) || (b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title);
const sizeOf = f => f.clips.reduce((n, c) => n + (Number(c.size) || 0), 0);
export const HOME_SORTS = { clipped: cmpNewest, oldest: (a, b) => timeKey(a).localeCompare(timeKey(b)) || (a.date || '').localeCompare(b.date || '') || a.title.localeCompare(b.title),
  clips: (a, b) => b.clips.length - a.clips.length || cmpNewest(a, b), biggest: (a, b) => sizeOf(b) - sizeOf(a) || cmpNewest(a, b) };
export function foldersOf(clips, metas = [], sort = 'clipped') {
  const by = new Map();
  for (const s of metas) if (s && typeof s.id === 'string') by.set(s.id, { id: s.id, title: s.title || pretty(s.id), channel: s.channel || '', date: s.date || dateOfId(s.id), clipped: s.clipped_at || '', lang: s.lang && s.lang !== 'unknown' ? s.lang : '', langName: s.lang_name || '', url: s.url || '', thumb: s.thumb || null, clips: [] });
  for (const c of clips) {
    const id = c.stream || '';
    if (!by.has(id)) by.set(id, { id, title: id ? pretty(id) : 'Other clips', channel: '', date: dateOfId(id), clipped: '', lang: '', langName: '', url: '', thumb: null, clips: [] });
    by.get(id).clips.push(c);
  }
  const list = [...by.values()].filter(f => f.clips.length);
  for (const f of list) {
    if (!f.clipped) f.clipped = f.clips.map(c => c.clipped_at || '').sort().pop() || '';
    if (!f.lang) f.lang = f.clips.map(c => (c.lang && c.lang !== 'unknown' ? c.lang : '')).find(Boolean) || '';
    if (!f.langName) f.langName = langName(f.lang);
  }
  list.sort(HOME_SORTS[sort] || cmpNewest);
  return list;
}
// Language per stream (never guessed: missing or 'unknown' = no language). -> { by: Map(stream -> code), list: [{code, name, count}] by stream count }
export function langStats(clips, metas = []) {
  const by = new Map();
  for (const s of metas) if (s && s.id && s.lang && s.lang !== 'unknown') by.set(s.id, s.lang);
  for (const c of clips) if (c.lang && c.lang !== 'unknown' && !by.has(c.stream || '')) by.set(c.stream || '', c.lang);
  const n = new Map(); for (const l of by.values()) n.set(l, (n.get(l) || 0) + 1);
  return { by, list: [...n].map(([code, count]) => ({ code, name: langName(code), count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) };
}
export const langOfClip = (c, by) => (c.lang && c.lang !== 'unknown' ? c.lang : by.get(c.stream || '') || '');
export function dateText(d) {
  const t = /^\d{4}-\d\d-\d\d/.test(d || '') ? Date.parse(d.slice(0, 10) + 'T00:00:00Z') : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
}
// "18 Nov, 14:12" (viewer's local time); a clip with no known time of day (stamped 00:00:00Z) shows the day only. Year only when it is not this year.
export function clippedText(iso) {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d:\d\d:\d\d)Z)?$/.exec(iso || ''); if (!m) return '';
  const dayOnly = !m[4] || m[4] === '00:00:00', d = new Date(dayOnly ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : Date.parse(iso)); if (!Number.isFinite(+d)) return '';
  const tz = dayOnly ? 'UTC' : undefined, yr = new Date(d.toLocaleString('en-US', { timeZone: tz })).getFullYear() !== new Date().getFullYear();
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(yr ? { year: 'numeric' } : {}), timeZone: tz });
  return dayOnly ? day : day + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}
