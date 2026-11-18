// Static-mode chrome added on top of the shared UI at runtime (the shared screens are never edited):
// passphrase wording on the unlock card, an Admin button (paste a write token, kept in memory only), Lock label.
import { state, emit, on } from './state.js';
import * as api from './api.js';
import { h, btn } from './dom.js';
import { createModal } from './a11y.js';
import { toast } from './toast.js';

const $ = (s, r = document) => r.querySelector(s);
let adminBtn = null;

// ---- "Remember on this device" (owner request, D37). This is the ONLY place in the static site that touches web storage, and it
// touches exactly one key. Only the shared passphrase is stored; the admin write token and the read token never are.
// build_static.py allows exactly these three call shapes and fails the build on any other storage use.
const PASS_KEY = 'cv.pass';
const getStored = () => { try { const v = localStorage.getItem(PASS_KEY); return typeof v === 'string' && v && v.length <= 256 ? v : null; } catch { return null; } };
const putStored = v => { try { localStorage.setItem(PASS_KEY, v); } catch { /* storage blocked: the page works without it */ } };
const forget = () => { try { localStorage.removeItem(PASS_KEY); } catch { /* ignore */ } };
const GENERIC_BAD = 'That passphrase did not work';
let rememberOn = true;      // the checkbox state; survives the unlock card being re-rendered after a wrong attempt
let pending = null;         // passphrase just submitted, stored only once the unlock succeeds
let autoTry = false;        // the silent unlock with the stored passphrase is in flight
let autoDone = false;
function addRemember() {
  const form = $('#signin form.pp-form');
  if (!form || $('#remember-cb', form)) return;
  const cb = h('input', { type: 'checkbox', id: 'remember-cb', checked: rememberOn });
  cb.addEventListener('change', () => { rememberOn = cb.checked; });
  form.append(h('label', { class: 'remember', for: 'remember-cb' }, cb, h('span', { text: 'Remember on this device' })));
}
function tryAuto() {
  if (autoDone) return;
  const input = $('#signin #pp-input'), form = input?.form;
  if (!input || !form) return;
  autoDone = true;
  const v = getStored(); if (!v) return;
  autoTry = true; input.value = v; form.requestSubmit();
}
document.addEventListener('submit', e => {
  const input = e.target?.querySelector?.('#pp-input');
  if (input && input.value) pending = rememberOn ? input.value : null;
}, true);
on('signedin', () => { if (pending) putStored(pending); pending = null; autoTry = false; });
function watchStatus() {
  const st = $('#signin-status');
  if (!st || !autoTry) return;
  if (st.textContent === GENERIC_BAD) { forget(); autoTry = false; pending = null; }          // rotated passphrase or config
  else if (st.textContent && !/^Checking/.test(st.textContent)) autoTry = false;               // e.g. network trouble: keep it, show the message
}
document.addEventListener('click', e => { if (e.target?.closest?.('#signout-btn')) forget(); }, true);   // Lock forgets
on('cmd', c => { if (c === 'signout') forget(); });

function fixCopy() {
  const tag = $('#signin .tag'), fine = $('#signin .fine');
  const T = 'A private home for the clips. Type the shared passphrase to open it.';
  const F = 'One shared passphrase protects this vault. There are no personal accounts, so only share it with people you trust.';
  if (tag && tag.textContent !== T) tag.textContent = T;
  if (fine && fine.textContent !== F) fine.textContent = F;
  const out = $('#signout-btn'); if (out) { out.setAttribute('aria-label', 'Lock'); out.title = 'Lock (forget the key and reload)'; }
  // main.js does tabs.replaceChildren(..., null) when the People tab is not offered, which prints the text "null"; remove it
  const tabs = $('#tabs'); if (tabs) for (const n of [...tabs.childNodes]) if (n.nodeType === 3 && n.textContent.trim() === 'null') n.remove();
  const input = $('#pp-input'); if (input) { input.autocomplete = 'current-password'; input.spellcheck = false; }
  addRemember(); tryAuto(); watchStatus();
}
function sync() {
  fixCopy();
  if (!adminBtn) return;
  adminBtn.hidden = !state.me;
  const isOn = state.me?.role === 'admin';
  adminBtn.querySelector('.lbl').textContent = isOn ? 'Exit admin' : 'Admin';
  adminBtn.setAttribute('aria-pressed', String(isOn)); adminBtn.setAttribute('aria-label', isOn ? 'Exit admin mode' : 'Admin mode');
}
async function refreshMe() { state.me = await api.me(); emit('reload'); emit('clips'); sync(); }

function openAdmin() {
  const m = createModal({ title: 'Admin mode', cls: 'adminmode', sticky: true,
    desc: 'Paste a fine-grained Hugging Face WRITE token limited to the vault dataset only. It stays in this tab\'s memory: reloading or Lock forgets it. Never paste an account-wide token.' });
  // type=text + CSS text-security (static-mode.css) instead of type=password: password managers and the browser's save-password prompt
  // then leave the write token alone. It is still shown as dots, and it is cleared on refusal, close and submit.
  const input = h('input', { type: 'text', id: 'admin-token', autocomplete: 'one-time-code', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Hugging Face write token', placeholder: 'hf_...' });
  const status = h('p', { class: 'form-err', role: 'alert', id: 'admin-status' });
  const warn = h('p', { class: 'muted', id: 'admin-warn' });
  m.body.append(h('div', { class: 'field' }, h('label', { for: 'admin-token', text: 'Write token' }), input), warn, status);
  const cancel = btn('Cancel', { kind: 'ghost', on: () => m.close(false) });
  const go = btn('Check and enter', { kind: 'primary' }); go.id = 'admin-go';
  m.foot.append(cancel, go);
  let warnedFor = '';   // the token the warning was shown for: a different token is checked and warned afresh
  go.addEventListener('click', async () => {
    status.textContent = ''; warn.textContent = ''; const tok = input.value.trim();
    if (!tok) { status.textContent = 'Paste the token first.'; return; }
    go.disabled = true;
    try {
      const v = await api.verifyAdminToken(tok);
      if (!v.ok) { status.textContent = v.reason; warn.textContent = ''; warnedFor = ''; input.value = ''; go.querySelector('.lbl').textContent = 'Check and enter'; return; }
      if (v.warnings.length && warnedFor !== tok) { warn.textContent = 'Warning: ' + v.warnings.join(' '); warnedFor = tok; go.querySelector('.lbl').textContent = 'Continue anyway'; return; }
      await api.enterAdmin(tok); input.value = '';
      await refreshMe(); m.close(true); toast('Admin mode is on. It ends on reload or Lock.', { kind: 'success' });
    } catch (e) { status.textContent = api.errorText(e); }
    finally { go.disabled = false; }
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
  m.done.then(() => { input.value = ''; });
  m.open(input);
}
function install() {
  const out = $('#signout-btn');
  if (!out) return false;
  adminBtn = btn('Admin', { ic: 'shield', kind: 'ghost', cls: 'sm adminbtn', aria: 'Admin mode', on: async () => { if (state.me?.role === 'admin') { api.exitAdmin(); await refreshMe(); toast('Admin mode is off.'); } else openAdmin(); } });
  adminBtn.id = 'admin-btn'; adminBtn.hidden = true;
  out.before(adminBtn); sync(); return true;
}
// Do not leave the typed passphrase sitting in a (hidden) input after it has been submitted.
document.addEventListener('submit', () => setTimeout(() => { for (const i of document.querySelectorAll('input[type=password], #admin-token')) i.value = ''; }, 0), true);
let tries = 0;
(function wait() { if (!install() && ++tries < 100) setTimeout(wait, 50); })();
for (const ev of ['signedin', 'clips', 'view']) on(ev, sync);
new MutationObserver(fixCopy).observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
// Idle lock: after 15 minutes without a click, key, touch or scroll (and no video playing) forget both tokens and reload, exactly like Lock.
const IDLE_MS = (() => { const o = globalThis.__clipVaultIdleMs; return Number.isFinite(o) && o >= 500 && o <= 3600000 ? o : 15 * 60 * 1000; })();
let idleTimer = null, lastBump = 0;
function idleFire() {
  idleTimer = null;
  if (!state.me) return;                                                    // not signed in: nothing to forget
  if ([...document.querySelectorAll('video')].some(v => !v.paused && !v.ended)) return bumpIdle(true);  // watching a clip is activity
  if (getStored()) {                                                        // passphrase remembered: only the admin write token is dropped
    if (state.me?.role === 'admin') { api.exitAdmin(); refreshMe().then(() => toast('Admin mode ended after 15 minutes idle.')); }
    return;
  }
  api.logout();                                                             // the existing Lock: wipe() + reload
}
function bumpIdle(force) {
  const now = Date.now();
  if (!force && now - lastBump < Math.min(1000, IDLE_MS / 4)) return;
  lastBump = now; clearTimeout(idleTimer); idleTimer = setTimeout(idleFire, IDLE_MS);
}
for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll']) document.addEventListener(ev, () => bumpIdle(false), { capture: true, passive: true });
on('signedin', () => bumpIdle(true));
bumpIdle(true);
