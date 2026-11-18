// Defensive parser for the Markdown-ish `post` kit text. Never throws; unknown shapes fall back to one raw field.
export const LIMITS = {
  'yt:title': { max: 100, soft: 60, unit: 'chars' }, 'yt:description': { max: 5000, unit: 'chars' }, 'yt:tags': { max: 500, unit: 'chars' },
  'ig:caption': { max: 2200, unit: 'chars' }, 'ig:hashtags': { max: 30, unit: 'tags' },
};
const trimBlank = lines => { const a = [...lines]; while (a.length && !a[0].trim()) a.shift(); while (a.length && !a[a.length - 1].trim()) a.pop(); return a.join('\n'); };
export function parsePost(text) {
  const out = { sections: [], raw: typeof text === 'string' ? text : '' };
  if (!out.raw.trim()) return out;
  const lines = out.raw.replace(/\r\n?/g, '\n').split('\n');
  const labelRe = /^\s*(?:[-*]\s+)?\*\*(.+?)\*\*\s*(?:\(([^)]*)\))?\s*:?\s*(.*)$/;
  let sec = { name: '', kind: 'other', fields: [], free: [] }, f = null;
  const secs = [sec];
  for (const line of lines) {
    let m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      const name = m[1].replace(/\*+/g, '').trim(), n = name.toLowerCase();
      sec = { name, kind: /youtube|short/.test(n) ? 'yt' : /instagram|reel/.test(n) ? 'ig' : /credit/.test(n) ? 'credit' : /right/.test(n) ? 'rights' : 'other', fields: [], free: [] };
      secs.push(sec); f = null; continue;
    }
    m = labelRe.exec(line);
    if (m) { f = { label: m[1].replace(/\s*:\s*$/, '').trim(), note: m[2] || '', lines: m[3] ? [m[3]] : [] }; sec.fields.push(f); continue; }
    (f ? f.lines : sec.free).push(line);
  }
  for (const s of secs) {
    const fields = s.fields.map(x => {
      const key = x.label.toLowerCase().replace(/[^a-z]/g, '');
      const k = key.startsWith('title') ? 'title' : key.startsWith('desc') ? 'description' : key.startsWith('tag') ? 'tags' : key.startsWith('caption') ? 'caption' : key.startsWith('hashtag') ? 'hashtags' : key;
      return { key: k, label: x.label, value: trimBlank(x.lines), limit: LIMITS[`${s.kind}:${k}`] || null };
    });
    const free = trimBlank(s.free);
    if (free) fields.unshift({ key: 'text', label: s.name || 'Post text', value: free, limit: null });
    if (fields.length) out.sections.push({ name: s.name || 'Post', kind: s.kind, fields });
  }
  return out;
}
export const countOf = (field, value) => field.limit?.unit === 'tags' ? (value.match(/#[^\s#]+/g) || []).length : [...value].length;
export function copyAll(section, values) {
  const get = k => (section.fields.find(f => f.key === k) ? values.get(section.fields.find(f => f.key === k)) : '');
  const parts = section.kind === 'yt' ? [get('title'), get('description'), get('tags') ? 'Tags: ' + get('tags') : ''] : section.kind === 'ig' ? [get('caption'), get('hashtags')] : section.fields.map(f => values.get(f));
  return parts.filter(Boolean).join('\n\n');
}
