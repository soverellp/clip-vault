export const human = n => { if (n == null || !Number.isFinite(+n)) return '—'; n = +n; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1000 && i < 3) { n /= 1000; i++; } return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i]; };
export const dur = s => { if (s == null || !Number.isFinite(+s)) return '—'; s = Math.round(+s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
export const bitrate = b => b == null || !Number.isFinite(+b) ? '—' : +b >= 1e6 ? (b / 1e6).toFixed(1) + ' Mbps' : Math.round(b / 1e3) + ' kbps';
export const scoreText = s => s == null || !Number.isFinite(+s) ? '' : (+s <= 10 ? (+s).toFixed(1) : String(Math.round(+s)));
export const pretty = s => s ? String(s).replace(/^\d{4}-\d\d-\d\d_/, '').replace(/[-_]+/g, ' ') : 'No stream';
export const norm = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
// posted_on (D46): optional array of platform keys from a fixed list; unknown keys are ignored, absent = not posted. Old posted_by values are ignored.
export const PLATFORMS = [['youtube', 'YouTube'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['x', 'X'], ['other', 'Other']];
export const postedOnOf = c => (c && Array.isArray(c.posted_on) ? PLATFORMS.map(p => p[0]).filter(k => c.posted_on.includes(k)) : []);
export const platformLabel = k => (PLATFORMS.find(p => p[0] === k) || [k, k])[1];
export const titleOf = c => (c && c.title ? String(c.title) : 'Untitled clip');
export const tagsOf = c => Array.isArray(c?.tags) ? c.tags.map(String).filter(Boolean) : [];
export const ago = n => n;
