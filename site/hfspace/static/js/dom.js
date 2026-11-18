// Tiny DOM helpers: everything is built with createElement and textContent.
const NS = 'http://www.w3.org/2000/svg';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
      else if (k === 'data') for (const [n, val] of Object.entries(v)) el.dataset[n] = val;
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// stroke icons on a 24 grid; '|' separates sub-paths
const ICONS = {
  search: 'M21 21l-4.3-4.3|M11 19a8 8 0 100-16 8 8 0 000 16z',
  play: 'M7 4.5l13 7.5-13 7.5z', pause: 'M7 5v14|M17 5v14',
  grid: 'M4 4h6v6H4z|M14 4h6v6h-6z|M4 14h6v6H4z|M14 14h6v6h-6z',
  list: 'M8 6h13|M8 12h13|M8 18h13|M3 6h.01|M3 12h.01|M3 18h.01',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8z|M12 2v2|M12 20v2|M4.9 4.9l1.4 1.4|M17.7 17.7l1.4 1.4|M2 12h2|M20 12h2|M4.9 19.1l1.4-1.4|M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  bolt: 'M13 2L3 14h8l-1 8 10-12h-8z',
  upload: 'M12 16V4|M7 9l5-5 5 5|M4 20h16', download: 'M12 4v12|M7 11l5 5 5-5|M4 20h16',
  trash: 'M4 7h16|M10 11v6|M14 11v6|M6 7l1 13h10l1-13|M9 7V4h6v3',
  restore: 'M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8|M3 3v5h5',
  edit: 'M12 20h9|M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
  share: 'M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7|M16 6l-4-4-4 4|M12 2v13',
  copy: 'M9 9h11v11H9z|M5 15H4V4h11v1', check: 'M5 12l5 5 9-10', x: 'M6 6l12 12|M18 6L6 18',
  volume: 'M4 9v6h4l5 4V5L8 9z|M16 9a4 4 0 010 6|M18.5 6.5a8 8 0 010 11',
  mute: 'M4 9v6h4l5 4V5L8 9z|M17 9l5 6|M22 9l-5 6',
  maximize: 'M4 9V4h5|M20 9V4h-5|M4 15v5h5|M20 15v5h-5', pip: 'M3 5h18v14H3z|M12 12h7v5h-7z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  command: 'M9 6a3 3 0 10-3 3h12a3 3 0 10-3-3v12a3 3 0 103-3H6a3 3 0 103 3z',
  select: 'M4 4h16v16H4z|M8 12l3 3 5-6', log: 'M9 4h6v3H9z|M7 5H5v16h14V5h-2|M9 12h6|M9 16h6',
  logout: 'M9 21H5V3h4|M16 7l5 5-5 5|M21 12H9', film: 'M3 4h18v16H3z|M7 4v16|M17 4v16|M3 9h4|M3 15h4|M17 9h4|M17 15h4',
  alert: 'M12 3l10 18H2z|M12 10v5|M12 18h.01', link: 'M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1|M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  back: 'M15 6l-6 6 6 6', dots: 'M5 12a1 1 0 102 0 1 1 0 10-2 0|M11 12a1 1 0 102 0 1 1 0 10-2 0|M17 12a1 1 0 102 0 1 1 0 10-2 0',
  layers: 'M12 3l9 5-9 5-9-5z|M3 13l9 5 9-5', help: 'M12 3a9 9 0 100 18 9 9 0 000-18z|M9.5 9.5a2.5 2.5 0 115 .5c0 1.5-2.5 2-2.5 3.5|M12 17h.01',
  send: 'M22 2L11 13|M22 2l-7 20-4-9-9-4z', chevd: 'M6 9l6 6 6-6', chevu: 'M6 15l6-6 6 6', ban: 'M12 3a9 9 0 100 18 9 9 0 000-18z|M5.6 5.6l12.8 12.8', plus: 'M12 5v14|M5 12h14', image: 'M3 5h18v14H3z|M8 11a1.5 1.5 0 100-3 1.5 1.5 0 000 3z|M21 16l-5-5-8 8',
};
const FILLED = new Set(['play']);
export function icon(name, cls) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  for (const d of (ICONS[name] || '').split('|')) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    if (FILLED.has(name)) p.setAttribute('class', 'fill');
    s.append(p);
  }
  return s;
}
export function setIcon(btn, name) { const old = btn.querySelector('svg.ic'); if (old) old.replaceWith(icon(name)); }

export function btn(label, { kind = '', ic, cls = '', on, type = 'button', title, aria, disabled } = {}) {
  const b = h('button', { type, class: `btn ${kind} ${cls}`.trim(), title, disabled, 'aria-label': aria, on: on ? { click: on } : undefined });
  if (ic) b.append(icon(ic));
  if (label) b.append(h('span', { class: 'lbl', text: label }));
  return b;
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function frame() { return new Promise(r => requestAnimationFrame(() => r())); }
