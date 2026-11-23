// Post text templates: pure helpers (no DOM, no network). Stored as _config/templates.json:
//   {"version":1,"templates":[{id,name,platform,title_tpl,caption_tpl,hashtags[],required_hashtags[],limits{},notes}]}
// Variables: {hook} {title} {streamer} {game} {date} {hashtags} {n}. Output is PLAIN TEXT only (callers use textContent); an unknown {name} stays visible and is reported.
import { normTags, cleanPost } from './playlists.js';
export const TPL_PLATFORMS = ['youtube', 'instagram', 'tiktok', 'x', 'campaign', 'any'];
export const TPL_LABEL = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', x: 'X', campaign: 'Campaign', any: 'Any' };
export const VARS = ['hook', 'title', 'streamer', 'game', 'date', 'hashtags', 'n'];
export const LIMIT_KEYS = ['title_max', 'caption_max', 'total_max', 'hashtags_max', 'dur_min', 'dur_max'];
export const MAX_TEMPLATES = 100;
const clean = (s, max, multi = false) => String(s ?? '').replace(multi ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ').replace(/\r\n?/g, '\n').slice(0, max);
const okId = s => typeof s === 'string' && /^[\w-]{1,64}$/.test(s);

export function cleanTemplate(t) {
  if (!t || typeof t !== 'object' || !okId(t.id)) return null;
  const limits = {};
  for (const k of LIMIT_KEYS) { const v = Number(t.limits?.[k]); if (Number.isFinite(v) && v > 0 && v <= 100000) limits[k] = Math.round(v); }
  return { id: t.id, name: clean(t.name, 80).trim() || 'Untitled template', platform: TPL_PLATFORMS.includes(t.platform) ? t.platform : 'any',
    title_tpl: clean(t.title_tpl, 300), caption_tpl: clean(t.caption_tpl, 5000, true), hashtags: normTags(t.hashtags), required_hashtags: normTags(t.required_hashtags), limits, notes: clean(t.notes, 500, true) };
}
export const emptyTemplates = () => ({ version: 1, templates: [] });
export function parseTemplates(raw) {
  let o = raw; if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return emptyTemplates(); } }
  const by = new Map();
  for (const t of Array.isArray(o?.templates) ? o.templates : []) { const c = cleanTemplate(t); if (c) { by.delete(c.id); by.set(c.id, c); } }
  return { version: 1, templates: [...by.values()].slice(-MAX_TEMPLATES) };
}
export function parseTemplatesStrict(text) {
  if (text == null) return emptyTemplates();
  let o; try { o = JSON.parse(text); } catch { throw new Error('unreadable'); }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.templates)) throw new Error('unreadable');
  return parseTemplates(o);
}
export const serializeTemplates = doc => JSON.stringify({ version: 1, templates: doc.templates }, null, 1);
// ops: upsert{template} delete{id} seed{templates} (seed adds only ids that are missing)
export function applyTemplateOp(doc0, op) {
  const doc = parseTemplates(JSON.parse(JSON.stringify(doc0))), t = op?.type; let summary = 'Templates', changed = true;
  if (t === 'upsert') {
    const c = cleanTemplate(op.template); if (!c) throw new Error('invalid');
    const i = doc.templates.findIndex(x => x.id === c.id);
    if (i >= 0) doc.templates[i] = c; else { if (doc.templates.length >= MAX_TEMPLATES) throw new Error('limit'); doc.templates.push(c); }
    summary = i >= 0 ? 'Edit template' : 'Add template';
  } else if (t === 'delete') {
    if (!doc.templates.some(x => x.id === op.id)) throw new Error('notfound');
    doc.templates = doc.templates.filter(x => x.id !== op.id); summary = 'Delete template';
  } else if (t === 'seed') {
    const have = new Set(doc.templates.map(x => x.id)); let n = 0;
    for (const x of Array.isArray(op.templates) ? op.templates : []) { const c = cleanTemplate(x); if (c && !have.has(c.id)) { doc.templates.push(c); have.add(c.id); n++; } }
    changed = n > 0; summary = 'Seed templates';
  } else throw new Error('invalid');
  return { doc, summary, changed };
}

export const PRESETS = [
  { id: 'tpl_youtube_shorts', name: 'YouTube Shorts', platform: 'youtube', title_tpl: '{hook}', caption_tpl: '{title}\n\n{hashtags}', hashtags: ['#shorts'], required_hashtags: [], limits: { title_max: 100 }, notes: 'Title max 100 characters.' },
  { id: 'tpl_instagram_reels', name: 'Instagram Reels', platform: 'instagram', title_tpl: '', caption_tpl: '{hook}\n\n{title}\n\n{hashtags}', hashtags: ['#reels'], required_hashtags: [], limits: { caption_max: 2200, hashtags_max: 30 }, notes: 'Caption max 2200 characters, up to 30 hashtags.' },
  { id: 'tpl_tiktok', name: 'TikTok', platform: 'tiktok', title_tpl: '', caption_tpl: '{hook} {hashtags}', hashtags: ['#fyp'], required_hashtags: [], limits: { caption_max: 2200 }, notes: 'Caption max 2200 characters.' },
  { id: 'tpl_x', name: 'X', platform: 'x', title_tpl: '', caption_tpl: '{hook} {hashtags}', hashtags: [], required_hashtags: [], limits: { total_max: 280 }, notes: '280 characters in total (caption plus hashtags).' },
  { id: 'tpl_contentrewards_kai', name: 'Content Rewards Kai Cenat', platform: 'campaign', title_tpl: '{hook}', caption_tpl: '{hook} {hashtags}', hashtags: [], required_hashtags: ['#KaiCenat'], limits: { dur_min: 20, dur_max: 50 }, notes: 'Campaign: every caption needs #KaiCenat; clip length 20-50 s (see destinations/contentrewards-kai-gta6.json).' },
];

// ---- rendering
// -> { text, unknown:[names], empty:[names] }. {known} -> its value; {unknown} stays as typed and is listed; a known variable with no data renders empty and is listed in `empty`.
export function renderTemplate(tpl, vars) {
  const unknown = [], empty = [];
  const text = String(tpl ?? '').replace(/\{(\w+)\}/g, (m, name) => {
    if (!VARS.includes(name)) { if (!unknown.includes(name)) unknown.push(name); return m; }
    const v = vars?.[name]; const s = v == null ? '' : String(v);
    if (!s && !empty.includes(name)) empty.push(name);
    return s;
  });
  return { text, unknown, empty };
}
const ymd = s => { const m = /^(\d{4}-\d\d-\d\d)/.exec(String(s || '')); return m ? m[1] : ''; };
// Variable values from a moment (clip) and its stream meta; every field may be missing.
export function buildVars(clip, stream, n, tags) {
  const c = clip || {}, s = stream || {};
  return { hook: String(c.hook || c.title || '').trim(), title: String(c.title || '').trim(), streamer: String(s.channel || c.channel || c.streamer || '').trim(),
    game: String(c.game || s.game || '').trim(), date: ymd(s.date) || ymd(c.stream) || ymd(c.added_at), hashtags: (tags || []).join(' '), n: n == null ? '' : String(n) };
}
const len = s => [...String(s || '')].length;
// Post text for one item. Hashtags = required first, then the template's, then up to 5 of the clip's own tags (all deduped).
export function renderPost(tpl, clip, stream, n) {
  const own = (Array.isArray(clip?.tags) ? clip.tags : []).slice(0, 5);
  const tags = normTags([...(tpl.required_hashtags || []), ...(tpl.hashtags || []), ...own]);
  const vars = buildVars(clip, stream, n, tags);
  const t = renderTemplate(tpl.title_tpl, vars), c = renderTemplate(tpl.caption_tpl, vars);
  const usesTags = /\{hashtags\}/.test(tpl.title_tpl + '\n' + tpl.caption_tpl);
  const unknown = [...new Set([...t.unknown, ...c.unknown])], empty = [...new Set([...t.empty, ...c.empty])].filter(x => x !== 'hashtags');
  return { post: cleanPost({ title: t.text.trim(), caption: c.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), hashtags: tags }), unknown, empty, usesTags };
}
// Warnings for one post against a template: empty, over a limit, missing required hashtag, clip length, unknown variables.
export function validatePost(post, tpl, { dur = null, unknown = [] } = {}) {
  const w = [], p = post || {}, L = tpl?.limits || {};
  const cap = String(p.caption || ''), tit = String(p.title || ''), tags = p.hashtags || [];
  if (!tit.trim() && !cap.trim()) w.push('Empty: no title and no caption');
  if (L.title_max && len(tit) > L.title_max) w.push(`Title is ${len(tit)} characters, limit ${L.title_max}`);
  if (L.caption_max && len(cap) > L.caption_max) w.push(`Caption is ${len(cap)} characters, limit ${L.caption_max}`);
  if (L.total_max) { const all = len(cap) + (tags.filter(t => !cap.toLowerCase().includes(t.toLowerCase())).length ? 1 + len(tags.filter(t => !cap.toLowerCase().includes(t.toLowerCase())).join(' ')) : 0) + (tit ? len(tit) : 0); if (all > L.total_max) w.push(`Text is ${all} characters, limit ${L.total_max}`); }
  if (L.hashtags_max && tags.length > L.hashtags_max) w.push(`${tags.length} hashtags, limit ${L.hashtags_max}`);
  const low = (cap + ' ' + tit).toLowerCase(), have = new Set(tags.map(t => t.toLowerCase()));
  for (const r of tpl?.required_hashtags || []) if (!have.has(r.toLowerCase()) && !low.includes(r.toLowerCase())) w.push(`Missing required hashtag ${r}`);
  if (dur != null && Number.isFinite(+dur)) { if (L.dur_min && +dur < L.dur_min) w.push(`Clip is ${Math.round(dur)} s, minimum ${L.dur_min} s`); if (L.dur_max && +dur > L.dur_max) w.push(`Clip is ${Math.round(dur)} s, maximum ${L.dur_max} s`); }
  if (unknown.length) w.push(`Unknown variable ${unknown.map(u => '{' + u + '}').join(' ')}`);
  return w;
}
// Posts for every live item of a playlist. Items the user edited are skipped unless overwrite. -> { posts:{moment_id:post}, skipped:n }
export function applyTemplateToItems(items, tpl, clipOf, streamOf, overwrite) {
  const posts = {}; let skipped = 0, n = 0;
  for (const it of items) {
    const c = clipOf(it.moment_id); if (!c) continue; n++;
    if (it.post?.edited && !overwrite) { skipped++; continue; }
    posts[it.moment_id] = renderPost(tpl, c, streamOf(c), n).post;
  }
  return { posts, skipped };
}
export const sampleClip = () => ({ title: 'He screams when the boss dies', hook: 'He did NOT expect that boss', tags: ['boss', 'gta6'], stream: '2026-11-18_night-stream', added_at: '2026-11-18T10:00:00Z', dur: 42 });
export const sampleStream = () => ({ channel: 'Kai Cenat', date: '2026-11-18', game: 'GTA 6' });
