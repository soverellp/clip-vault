// Sign-in providers. The network is only touched through api.js. Providers: 'google' (Google Identity Services) and 'passphrase'.
import { state, emit } from './state.js';
import * as api from './api.js';
import { h, btn } from './dom.js';
import { createModal } from './a11y.js';

let cfg = null, handler = null;

// ---------------- provider: google ----------------
const google = {
  async prepare() {
    await api.loadGoogleIdentity();
    window.google.accounts.id.initialize({ client_id: cfg.client_id, nonce: cfg.nonce, callback: r => handler?.(r), auto_select: false, cancel_on_tap_outside: true });
  },
  render(slot) {
    slot.replaceChildren();
    window.google.accounts.id.renderButton(slot, { type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
  },
  async submit(r, reauth) { return reauth ? api.reauthGoogle(r.credential) : api.authGoogle(r.credential); },
  forget() { try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* ignore */ } },
  notListed: 'This Google account is not on the list',
};
// ---------------- provider: passphrase ----------------
const passphrase = {
  async prepare() {},
  render(slot) {
    const input = h('input', { type: 'password', id: 'pp-input', autocomplete: 'current-password', 'aria-label': 'Passphrase', placeholder: 'Passphrase' });
    const go = btn('Unlock', { kind: 'primary', type: 'submit' });
    const f = h('form', { class: 'pp-form', on: { submit: e => { e.preventDefault(); if (input.value) handler?.({ credential: input.value }); } } }, input, go);
    slot.replaceChildren(f);
  },
  async submit(r, reauth) { return api.loginPassphrase(r.credential, { reauth }); },
  forget() {},
  notListed: 'That passphrase did not work',
};
const PROVIDERS = { google, passphrase };
const prov = () => PROVIDERS[cfg?.provider] || google;

async function ensure() { cfg = await api.authConfig(); await prov().prepare(); }

export async function loadMe() { const m = await api.me(); state.me = m; return m; }

export async function mountSignin(slot, status, retryRow) {
  status.textContent = ''; retryRow.hidden = true; slot.replaceChildren();
  try { await ensure(); }
  catch (e) {
    status.textContent = e?.status === 503 ? 'Sign-in is not configured yet. Tell the owner.' : 'Could not load sign-in. Check your connection and retry.';
    retryRow.hidden = false; return;
  }
  handler = async r => {
    status.textContent = 'Checking your account...';
    try {
      await prov().submit(r, false); await loadMe(); status.textContent = ''; emit('signedin');
    } catch (err) {
      status.textContent = (err.status === 403 || err.status === 401) ? prov().notListed : api.errorText(err);
      retryRow.hidden = false; prov().forget();
      try { await ensure(); prov().render(slot); } catch { /* ignore */ } // nonces are single use: fresh config
    }
  };
  prov().render(slot);
}
export async function tryAnother(slot, status, retryRow) { prov().forget(); await mountSignin(slot, status, retryRow); }
export async function signOut() { await api.logout(); prov().forget(); state.me = null; emit('signedout'); }

// Step-up: a fresh sign-in for the SAME account; the server re-issues the session.
export function reauth() {
  return new Promise(resolve => {
    const m = createModal({ title: 'Confirm it is you', desc: 'This action needs a recent sign-in. Sign in again as ' + (state.me?.email || 'the same account') + '.', cls: 'reauth', sticky: true });
    const slot = h('div', { class: 'gbtn' }), status = h('p', { class: 'form-err', role: 'alert' });
    m.body.append(slot, status);
    const cancel = btn('Cancel', { kind: 'ghost', on: () => m.close(false) }); m.foot.append(cancel);
    let ok = false;
    m.done.then(() => { handler = null; resolve(ok); });
    m.open(cancel);
    (async () => {
      try {
        await ensure();
        handler = async r => {
          status.textContent = 'Verifying...';
          try { await prov().submit(r, true); await loadMe(); ok = true; m.close(true); }
          catch (err) { status.textContent = api.errorText(err); try { await ensure(); prov().render(slot); } catch { /* ignore */ } }
        };
        prov().render(slot);
      } catch { status.textContent = 'Could not load sign-in.'; }
    })();
  });
}
api.setReauthHandler(reauth);
export const providers = Object.keys(PROVIDERS);
