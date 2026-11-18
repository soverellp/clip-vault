import { h, icon } from './dom.js';
let box;
export function initToasts() { box = document.getElementById('toasts'); }
export function toast(msg, { kind = 'info', timeout, action } = {}) {
  if (!box) initToasts();
  const ms = timeout ?? (kind === 'error' ? 7000 : 4200);
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' });
  const ic = kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'bolt';
  t.append(h('span', { class: 'toast-ic' }, icon(ic)), h('span', { class: 'toast-msg', text: msg }));
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    if (!t.isConnected) return;
    t.classList.add('out');
    setTimeout(() => t.remove(), 220);
  };
  if (action) t.append(h('button', { type: 'button', class: 'toast-act', text: action.label, on: { click: () => { dismiss(); action.run(); } } }));
  t.append(h('button', { type: 'button', class: 'toast-x', 'aria-label': 'Dismiss', on: { click: dismiss } }, icon('x')));
  box.append(t);
  while (box.children.length > 4) box.firstElementChild.remove();
  const arm = () => { clearTimeout(timer); if (ms > 0) timer = setTimeout(dismiss, ms); };
  t.addEventListener('pointerenter', () => clearTimeout(timer));
  t.addEventListener('pointerleave', arm);
  arm();
  return { dismiss };
}
