import { momentKey } from './shortlist.js';
export const human = n => { if (n == null || !Number.isFinite(+n)) return '—'; n = +n; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1000 && i < 3) { n /= 1000; i++; } return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i]; };
export const dur = s => { if (s == null || !Number.isFinite(+s)) return '—'; s = Math.round(+s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
export const bitrate = b => b == null || !Number.isFinite(+b) ? '—' : +b >= 1e6 ? (b / 1e6).toFixed(1) + ' Mbps' : Math.round(b / 1e3) + ' kbps';
export const scoreText = s => s == null || !Number.isFinite(+s) ? '' : (+s <= 10 ? (+s).toFixed(1) : String(Math.round(+s)));
export const pretty = s => s ? String(s).replace(/^\d{4}-\d\d-\d\d_/, '').replace(/[-_]+/g, ' ') : 'No stream';
export const norm = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
// posted_on (D46): optional array of platform keys from a fixed list; unknown keys are ignored, absent = not posted. Old posted_by values are ignored.
export const PLATFORMS = [['youtube', 'YouTube'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['x', 'X'], ['other', 'Other']];
// D47: platforms marked posted inside playlists are kept here (moment key -> Set) and counted next to clip.posted_on, so the Library filter reads both.
export const postedExtra = { map: new Map() };
export const postedOnOf = c => {
  if (!c) return [];
  const own = Array.isArray(c.posted_on) ? c.posted_on : [], extra = postedExtra.map.get(momentKey(c));
  return PLATFORMS.map(p => p[0]).filter(k => own.includes(k) || (extra && extra.has(k)));
};
export const platformLabel = k => (PLATFORMS.find(p => p[0] === k) || [k, k])[1];
export const titleOf = c => (c && c.title ? String(c.title) : 'Untitled clip');
export const tagsOf = c => Array.isArray(c?.tags) ? c.tags.map(String).filter(Boolean) : [];
export const ago = n => n;
