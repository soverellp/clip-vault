// Playlists: pure helpers (no DOM, no network). Stored as _config/playlists.json in the clip dataset:
//   {"version":1,"playlists":[{id,title,description,platforms[],status,items:[{moment_id,order,post:{title,caption,hashtags,edited?},posted:{<platform>:{date,link}}}],created_at,updated_at}]}
// A moment is the unit (key from shortlist.js momentKey). Every change is an OP applied to the file as read at the parent revision (see hubapi.js).
import { momentKey } from './shortlist.js';
export const PL_PLATFORMS = ['youtube', 'instagram', 'tiktok', 'x', 'other'];
export const PL_LABEL = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', x: 'X', other: 'Other' };
export const PL_STATUS = ['draft', 'ready', 'posted'];
export const MAX_PLAYLISTS = 200, MAX_ITEMS = 500;
const okKey = s => typeof s === 'string' && s.length > 0 && s.length <= 300 && !/[\u0000-\u001f\u007f]/.test(s);
const okId = s => typeof s === 'string' && /^[\w-]{1,64}$/.test(s);
const okAt = s => (typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(s) ? s : null);
const clean = (s, max, multi = false) => String(s ?? '').replace(multi ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ').replace(/\r\n?/g, '\n').slice(0, max);
const isUrlish = s => typeof s === 'string' && s.length <= 500 && !/[\u0000-\u001f\u007f\s]/.test(s);

// '#Tag one, two' -> ['#Tag', '#one', '#two'] (letters, digits, underscore only; deduped, case-insensitive, max 60)
export function normTags(v) {
  const src = Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/);
  const out = [], seen = new Set();
  for (const t0 of src) {
    const t = String(t0 ?? '').trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 60);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push('#' + t);
    if (out.length >= 60) break;
  }
  return out;
}
export const cleanPost = p => {
  const o = p && typeof p === 'object' ? p : {};
  const x = { title: clean(o.title, 300), caption: clean(o.caption, 5000, true), hashtags: normTags(o.hashtags) };
  if (o.edited === true) x.edited = true;
  return x;
};
function cleanPosted(p) {
  const out = {};
  if (p && typeof p === 'object') for (const k of PL_PLATFORMS) {
    const v = p[k]; if (!v || typeof v !== 'object') continue;
    const d = typeof v.date === 'string' && /^\d{4}-\d\d-\d\d(T[\d:.]+Z?)?$/.test(v.date) ? v.date.slice(0, 10) : null;
    if (!d) continue;
    out[k] = { date: d, link: isUrlish(v.link) ? v.link : '' };
  }
  return out;
}
function cleanItems(arr) {
  const by = new Map();
  for (const e of Array.isArray(arr) ? arr : []) {
    if (!e || typeof e !== 'object' || !okKey(e.moment_id) || by.has(e.moment_id)) continue;
    by.set(e.moment_id, { moment_id: e.moment_id, order: Number.isFinite(+e.order) ? +e.order : 1e9, post: cleanPost(e.post), posted: cleanPosted(e.posted) });
  }
  const items = [...by.values()].sort((a, b) => a.order - b.order).slice(0, MAX_ITEMS);
  items.forEach((it, i) => { it.order = i + 1; });
  return items;
}
export function cleanPlaylist(p) {
  if (!p || typeof p !== 'object' || !okId(p.id)) return null;
  const plat = Array.isArray(p.platforms) ? PL_PLATFORMS.filter(k => p.platforms.includes(k)) : [];
  return { id: p.id, title: clean(p.title, 120).trim() || 'Untitled playlist', description: clean(p.description, 1000, true), platforms: plat,
    status: PL_STATUS.includes(p.status) ? p.status : 'draft', template_id: okId(p.template_id) ? p.template_id : '', items: cleanItems(p.items), created_at: okAt(p.created_at), updated_at: okAt(p.updated_at) };
}
export const emptyDoc = () => ({ version: 1, playlists: [] });
export function parsePlaylists(raw) {
  let o = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return emptyDoc(); } }
  const by = new Map();
  for (const p of Array.isArray(o?.playlists) ? o.playlists : []) { const c = cleanPlaylist(p); if (c) { by.delete(c.id); by.set(c.id, c); } }
  return { version: 1, playlists: [...by.values()].slice(-MAX_PLAYLISTS) };
}
// A file that exists and cannot be read is an ERROR: a write must never overwrite what it cannot read.
export function parsePlaylistsStrict(text) {
  if (text == null) return emptyDoc();
  let o; try { o = JSON.parse(text); } catch { throw new Error('unreadable'); }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.playlists)) throw new Error('unreadable');
  return parsePlaylists(o);
}
export const serializePlaylists = doc => JSON.stringify({ version: 1, playlists: doc.playlists.map(p => ({ ...p, items: p.items.map(i => ({ ...i })) })) }, null, 1);

const find = (doc, id) => { const p = doc.playlists.find(x => x.id === id); if (!p) throw new Error('notfound'); return p; };
const touch = (p, now) => { p.updated_at = now; };
const itemOf = (p, mid) => { const i = p.items.find(x => x.moment_id === mid); if (!i) throw new Error('notfound'); return i; };
const renum = p => p.items.forEach((it, i) => { it.order = i + 1; });
// -> { doc, summary, changed } ; never mutates the input. ops:
// create{id,title,description,platforms} update{id,patch} delete{id} add_items{id,moment_ids,posts?} remove_item{id,moment_id} move{id,moment_id,to}
// reorder{id,order[]} set_post{id,moment_id,post} set_posts{id,posts{mid:post},overwrite} mark_posted{id,moment_id,platform,date,link} unmark_posted{id,moment_id,platform}
export function applyPlaylistOp(doc0, op, now) {
  const doc = parsePlaylists(JSON.parse(JSON.stringify(doc0))), t = op?.type;
  let summary = 'Playlists', changed = true;
  if (t === 'create') {
    if (!okId(op.id) || doc.playlists.some(p => p.id === op.id)) throw new Error('invalid');
    if (doc.playlists.length >= MAX_PLAYLISTS) throw new Error('limit');
    const p = cleanPlaylist({ id: op.id, title: op.title, description: op.description, platforms: op.platforms, status: 'draft', items: [], created_at: now, updated_at: now });
    doc.playlists.push(p); summary = 'Create playlist';
  } else if (t === 'update') {
    const p = find(doc, op.id), u = op.patch || {};
    if ('title' in u) p.title = clean(u.title, 120).trim() || p.title;
    if ('description' in u) p.description = clean(u.description, 1000, true);
    if ('platforms' in u && Array.isArray(u.platforms)) p.platforms = PL_PLATFORMS.filter(k => u.platforms.includes(k));
    if ('template_id' in u) p.template_id = okId(u.template_id) ? u.template_id : '';
    if ('status' in u) { if (!PL_STATUS.includes(u.status)) throw new Error('invalid'); p.status = u.status; }
    touch(p, now); summary = 'Update playlist';
  } else if (t === 'delete') {
    find(doc, op.id); doc.playlists = doc.playlists.filter(p => p.id !== op.id); summary = 'Delete playlist';
  } else if (t === 'add_items') {
    const p = find(doc, op.id), have = new Set(p.items.map(i => i.moment_id)); let n = 0;
    for (const mid of Array.isArray(op.moment_ids) ? op.moment_ids : []) {
      if (!okKey(mid) || have.has(mid) || p.items.length >= MAX_ITEMS) continue;
      have.add(mid); p.items.push({ moment_id: mid, order: p.items.length + 1, post: cleanPost(op.posts?.[mid]), posted: {} }); n++;
    }
    changed = n > 0; renum(p); if (changed) touch(p, now); summary = 'Add to playlist';
  } else if (t === 'remove_item') {
    const p = find(doc, op.id); itemOf(p, op.moment_id); p.items = p.items.filter(i => i.moment_id !== op.moment_id); renum(p); touch(p, now); summary = 'Remove from playlist';
  } else if (t === 'move') {
    const p = find(doc, op.id), i = p.items.findIndex(x => x.moment_id === op.moment_id); if (i < 0) throw new Error('notfound');
    const to = Math.max(0, Math.min(p.items.length - 1, Math.trunc(+op.to)));
    if (!Number.isFinite(to)) throw new Error('invalid');
    changed = to !== i; const [it] = p.items.splice(i, 1); p.items.splice(to, 0, it); renum(p); if (changed) touch(p, now); summary = 'Reorder playlist';
  } else if (t === 'reorder') {
    const p = find(doc, op.id), want = Array.isArray(op.order) ? op.order : [], pos = new Map(want.map((m, i) => [m, i]));
    p.items.sort((a, b) => (pos.has(a.moment_id) ? pos.get(a.moment_id) : 1e6 + a.order) - (pos.has(b.moment_id) ? pos.get(b.moment_id) : 1e6 + b.order)); renum(p); touch(p, now); summary = 'Reorder playlist';
  } else if (t === 'set_post') {
    const p = find(doc, op.id), it = itemOf(p, op.moment_id); it.post = cleanPost({ ...op.post, edited: op.post?.edited !== false }); touch(p, now); summary = 'Edit post text';
  } else if (t === 'set_posts') {
    const p = find(doc, op.id); let n = 0;
    for (const it of p.items) {
      const np = op.posts?.[it.moment_id]; if (!np) continue;
      if (it.post.edited && !op.overwrite) continue;
      it.post = cleanPost({ ...np, edited: false }); n++;
    }
    if (okId(op.template_id)) p.template_id = op.template_id;
    changed = n > 0 || okId(op.template_id); if (changed) touch(p, now); summary = 'Apply template';
  } else if (t === 'mark_posted') {
    const p = find(doc, op.id), it = itemOf(p, op.moment_id);
    if (!PL_PLATFORMS.includes(op.platform)) throw new Error('invalid');
    const d = cleanPosted({ [op.platform]: { date: op.date, link: op.link } })[op.platform]; if (!d) throw new Error('invalid');
    it.posted[op.platform] = d; touch(p, now); summary = 'Mark posted';
  } else if (t === 'unmark_posted') {
    const p = find(doc, op.id), it = itemOf(p, op.moment_id); delete it.posted[op.platform]; touch(p, now); summary = 'Unmark posted';
  } else throw new Error('invalid');
  return { doc, summary, changed };
}

// ---- reading helpers
const slotRank = c => (c.variant === 'clean' ? 0 : c.variant === 'with-streamer' || c.variant === 'with-girl' ? 1 : 2);
// The clip that stands for a moment (Clean first, like the library); null when the moment has no active clip (stale).
export function repClip(key, activeClips) {
  let best = null;
  for (const c of activeClips) if (momentKey(c) === key && (!best || slotRank(c) < slotRank(best))) best = c;
  return best;
}
export const isStale = (item, activeClips) => !repClip(item.moment_id, activeClips);
export const liveItems = (p, activeClips) => p.items.filter(i => !isStale(i, activeClips));
// Platforms an item is posted on (only platforms listed in `only` when given).
export const postedPlatforms = (item, only) => PL_PLATFORMS.filter(k => item.posted?.[k] && (!only || only.includes(k)));
// An item counts as posted when it is posted on every platform of the playlist (or on any platform when the playlist lists none).
export const itemDone = (p, item) => (p.platforms.length ? p.platforms.every(k => item.posted?.[k]) : postedPlatforms(item).length > 0);
export function progress(p, activeClips) {
  const live = liveItems(p, activeClips), done = live.filter(i => itemDone(p, i)).length;
  return { done, total: live.length, pct: live.length ? Math.round(done * 100 / live.length) : 0 };
}
// Suggest 'posted' when every live item is posted; never changes anything by itself.
export const suggestStatus = (p, activeClips) => { const g = progress(p, activeClips); return g.total > 0 && g.done === g.total ? 'posted' : null; };
// moment key -> Set(platforms) posted according to the playlists (the Library "Posted on" filter reads this next to clip.posted_on)
export function postedMap(doc) {
  const m = new Map();
  for (const p of doc?.playlists || []) for (const it of p.items) for (const k of postedPlatforms(it)) { if (!m.has(it.moment_id)) m.set(it.moment_id, new Set()); m.get(it.moment_id).add(k); }
  return m;
}
export const playlistsOf = (doc, key) => (doc?.playlists || []).filter(p => p.items.some(i => i.moment_id === key));
export const newId = (prefix = 'pl') => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---- export
// Spreadsheet formula neutralising: a cell that starts with = + - @ (or tab / CR) gets a leading apostrophe; then CSV quoting.
export function csvCell(v) {
  let s = String(v ?? '').replace(/\r\n?/g, '\n');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const CSV_HEAD = ['title', 'caption', 'hashtags', 'platform', 'status', 'link'];
// One row per live item and platform of the playlist (one row with an empty platform when it lists none). Stale items are ignored.
export function playlistCsv(p, activeClips) {
  const rows = [CSV_HEAD.join(',')];
  for (const it of liveItems(p, activeClips)) {
    const plats = p.platforms.length ? p.platforms : [''];
    for (const k of plats) {
      const d = k ? it.posted?.[k] : null, any = !k && postedPlatforms(it).length > 0;
      rows.push([it.post.title, it.post.caption, it.post.hashtags.join(' '), k ? PL_LABEL[k] : '', d || any ? 'posted' : p.status === 'posted' ? 'posted' : 'not posted', d?.link || ''].map(csvCell).join(','));
    }
  }
  return rows.join('\r\n') + '\r\n';
}
// What 'Copy caption' puts on the clipboard for one item: the caption, then the hashtags that are not already inside it.
export function captionText(post) {
  const cap = String(post?.caption || '').trim(), low = cap.toLowerCase();
  const extra = (post?.hashtags || []).filter(t => !low.includes(t.toLowerCase()));
  return [cap, extra.join(' ')].filter(Boolean).join('\n\n');
}
export function playlistText(p, activeClips) {
  const out = []; let n = 0;
  for (const it of liveItems(p, activeClips)) { n++; const body = [it.post.title, captionText({ ...it.post, title: '' })].filter(Boolean).join('\n'); out.push(`${n}. ${body || '(no text yet)'}`); }
  return out.join('\n\n');
}
