// All times are shown in the viewer's own timezone with Intl (no libraries).
let F = null;
function fm() {
  if (F) return F;
  const L = undefined; // browser locale
  F = {
    time: new Intl.DateTimeFormat(L, { hour: 'numeric', minute: '2-digit' }),
    day: new Intl.DateTimeFormat(L, { weekday: 'short' }),
    date: new Intl.DateTimeFormat(L, { month: 'short', day: 'numeric' }),
    dateY: new Intl.DateTimeFormat(L, { year: 'numeric', month: 'short', day: 'numeric' }),
    full: new Intl.DateTimeFormat(L, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }),
    tz: new Intl.DateTimeFormat(L, { timeZoneName: 'short' }),
    rtf: new Intl.RelativeTimeFormat(L, { numeric: 'always' }),
    ymd: new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }),
  };
  return F;
}
export const parse = iso => { if (!iso) return null; const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d; };
export function tzName() {
  try { return fm().tz.formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || ''; } catch { return ''; }
}
export function exact(iso) { const d = parse(iso); return d ? fm().full.format(d) : ''; }
function dayNum(d) { const [y, m, dd] = fm().ymd.format(d).split('-').map(Number); return Math.round(Date.UTC(y, m - 1, dd) / 864e5); }
export function relative(iso, now = Date.now()) {
  const d = parse(iso); if (!d) return 'Unknown time';
  const f = fm(), diff = now - d.getTime(), s = Math.round(diff / 1000);
  if (Math.abs(s) < 45) return 'just now';
  if (s < 0) return rel(Math.round(-s / 60), 'minute', true, f);
  const m = Math.round(s / 60);
  if (m < 60) return f.rtf.format(-m, 'minute');
  const hrs = Math.floor(s / 3600);
  if (hrs < 24) return f.rtf.format(-hrs, 'hour');
  const dd = dayNum(new Date(now)) - dayNum(d);
  if (dd === 1) return 'Yesterday ' + f.time.format(d);
  if (dd < 7) return f.day.format(d) + ' ' + f.time.format(d);
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return (sameYear ? f.date : f.dateY).format(d) + ', ' + f.time.format(d);
}
function rel(n, unit, future, f) { return f.rtf.format(future ? n : -n, unit); }
export function daysLeft(iso, now = Date.now()) {
  const d = parse(iso); if (!d) return null;
  return Math.max(0, Math.ceil((d.getTime() - now) / 864e5));
}
export function leftText(iso) {
  const n = daysLeft(iso); if (n == null) return '';
  return n === 0 ? 'today' : n === 1 ? 'in 1 day' : `in ${n} days`;
}
export function trashLine(c) {
  const del = exact(c.trashed_at) || 'unknown time';
  return `Deleted ${del}` + (c.purge_after ? ` - purges ${exact(c.purge_after)} (${leftText(c.purge_after)})` : '');
}

// <time> that shows relative text and carries the exact local date-time + zone in its tooltip.
export function timeEl(iso, kind = 'rel') {
  const el = document.createElement('time');
  el.className = 't-rel';
  fill(el, iso, kind);
  return el;
}
function fill(el, iso, kind) {
  el.dataset.iso = iso || ''; el.dataset.kind = kind;
  if (!iso || !parse(iso)) { el.textContent = 'Unknown'; el.removeAttribute('datetime'); el.removeAttribute('title'); return; }
  el.setAttribute('datetime', iso);
  el.title = exact(iso);
  el.textContent = kind === 'abs' ? exact(iso) : relative(iso);
}
export function tickAll() {
  for (const el of document.querySelectorAll('time.t-rel[data-iso]')) {
    if (el.dataset.kind === 'rel' && el.dataset.iso) fill(el, el.dataset.iso, 'rel');
  }
  for (const el of document.querySelectorAll('[data-trashline]')) {
    const c = { trashed_at: el.dataset.trashed, purge_after: el.dataset.purge };
    el.textContent = trashLine(c);
  }
}
let timer = null;
export function startTicker() {
  if (timer) return;
  timer = setInterval(tickAll, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tickAll(); });
}
