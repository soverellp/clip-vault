import { h, icon } from './dom.js';
import { state } from './state.js';

export const reducedMotion = () => state.reduced;
export function initMotion() {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const set = () => { state.reduced = mq.matches; document.documentElement.dataset.motion = mq.matches ? 'reduced' : 'full'; };
  set(); mq.addEventListener?.('change', () => { set(); document.dispatchEvent(new CustomEvent('cv:motion')); });
}
export function haptic(p) { try { if (!state.reduced) navigator.vibrate?.(p); } catch { /* ignore */ } }
export function announce(text) {
  const el = document.getElementById('sr-live'); if (!el) return;
  el.textContent = ''; setTimeout(() => { el.textContent = text; }, 30);
}
export function shake(el) {
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
  el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
}
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
export function focusables(root) { return [...root.querySelectorAll(FOCUSABLE)].filter(e => !e.hidden && e.offsetParent !== null || e === document.activeElement); }
// Native <dialog> already inerts the page; this keeps Tab wrapping inside too.
export function trapFocus(dialog) {
  dialog.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const f = focusables(dialog); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

// Generic modal: returns controls. Default focus goes to the element passed as `focus` (Cancel for destructive ones).
export function createModal({ title, desc, cls = '', danger = false, sticky = false }) {
  const host = document.getElementById('dialogs');
  const id = 'm' + Math.random().toString(36).slice(2, 8);
  const dlg = h('dialog', { class: `modal ${cls} ${danger ? 'danger' : ''}`, 'aria-modal': 'true', 'aria-labelledby': id + 't', 'aria-describedby': desc ? id + 'd' : undefined });
  const head = h('header', { class: 'modal-head' }, h('h2', { id: id + 't', text: title }));
  const closeX = h('button', { type: 'button', class: 'btn icon ghost modal-x', 'aria-label': 'Close' }, icon('x'));
  head.append(closeX);
  const body = h('div', { class: 'modal-body' });
  if (desc) body.append(h('p', { id: id + 'd', class: 'modal-desc', text: desc }));
  const foot = h('footer', { class: 'modal-foot' });
  dlg.append(head, body, foot);
  host.append(dlg);
  trapFocus(dlg);
  let resolve; const done = new Promise(r => { resolve = r; });
  let result;
  const api = {
    dialog: dlg, body, foot, done, closeX,
    open(focusEl) {
      dlg.showModal(); document.body.classList.add('locked');
      requestAnimationFrame(() => dlg.classList.add('shown'));
      (focusEl || foot.querySelector('button') || closeX).focus();
    },
    close(r) { result = r; if (dlg.open) dlg.close(); },
  };
  dlg.addEventListener('close', () => {
    dlg.classList.remove('shown');
    if (!document.querySelector('dialog[open]')) document.body.classList.remove('locked');
    setTimeout(() => dlg.remove(), 0);
    resolve(result);
  });
  dlg.addEventListener('cancel', () => { result = undefined; });
  closeX.addEventListener('click', () => api.close(undefined));
  dlg.addEventListener('click', e => { if (e.target === dlg && !danger && !sticky) api.close(undefined); });
  return api;
}

// Ripple + press micro-interaction, delegated.
export function initRipple() {
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest?.('.btn,.chip,.tab,.seg button');
    if (!b || b.disabled || state.reduced) return;
    const r = b.getBoundingClientRect();
    const s = h('span', { class: 'ripple', vars: { '--x': (e.clientX - r.left) + 'px', '--y': (e.clientY - r.top) + 'px', '--s': Math.max(r.width, r.height) * 2 + 'px' } });
    b.append(s); s.addEventListener('animationend', () => s.remove(), { once: true });
  }, { passive: true });
}
export function isTyping(t) {
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}
