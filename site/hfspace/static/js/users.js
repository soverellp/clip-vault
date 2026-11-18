import { state } from './state.js';
import { h, btn, icon } from './dom.js';
import * as api from './api.js';
import { toast } from './toast.js';
import { timeEl } from './time.js';
import { confirmDialog } from './admin.js';
import { announce, createModal } from './a11y.js';

const MAX = 50;
export const validEmail = e => typeof e === 'string' && e.length <= 254 && e === e.toLowerCase() && e.split('@').length === 2 && /^[^\s@,;<>()\[\]\\"'\u0000-\u001f]+@[^\s@,;<>()\[\]\\"'\u0000-\u001f]+\.[^\s@,;<>()\[\]\\"'\u0000-\u001f]+$/.test(e);

function addDialog(users, done) {
  const m = createModal({ title: 'Add a person', desc: 'They sign in with this Google account. Viewers can watch and download; admins can also upload, edit and delete.', cls: 'adduser' });
  const email = h('input', { type: 'email', id: 'u-email', autocomplete: 'off', placeholder: 'friend@example.com', spellcheck: 'false', autocapitalize: 'off', 'aria-describedby': 'u-err' });
  const role = h('select', { id: 'u-role', 'aria-label': 'Role' }, h('option', { value: 'viewer', text: 'Viewer (watch and download)' }), h('option', { value: 'admin', text: 'Admin (upload, edit, delete)' }));
  const err = h('p', { class: 'field-err', id: 'u-err', role: 'alert' });
  m.body.append(h('div', { class: 'field' }, h('label', { for: 'u-email', text: 'Google email' }), email), h('div', { class: 'field' }, h('label', { for: 'u-role', text: 'Role' }), role), err);
  const cancel = btn('Cancel', { kind: 'ghost', on: () => m.close(false) }), add = btn('Add person', { kind: 'primary', ic: 'plus' }); add.id = 'u-add';
  m.foot.append(cancel, add);
  const go = async () => {
    err.textContent = ''; const v = email.value.trim().toLowerCase();
    if (!validEmail(v)) { err.textContent = 'Enter one valid email address.'; email.setAttribute('aria-invalid', 'true'); return; }
    email.removeAttribute('aria-invalid');
    if (users.length >= MAX) { err.textContent = `The list is full (${MAX} people).`; return; }
    add.disabled = true;
    try { await api.addUser(v, role.value); m.close(true); toast(`Added ${v}.`, { kind: 'success' }); announce('Person added'); done(); }
    catch (e) { add.disabled = false; if (e.status === 401) { m.close(false); return; } err.textContent = api.errorText(e); }
  };
  add.addEventListener('click', go);
  email.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  m.open(email);
}

export async function renderUsers(root) {
  root.replaceChildren(h('div', { class: 'view-head' }, h('h2', { text: 'People' }), h('p', { class: 'muted', text: 'Who can open the vault. Changes apply on their next request.' })), h('div', { class: 'skel-lines' }, h('i'), h('i'), h('i')));
  let r;
  try { r = await api.listUsers(); }
  catch (e) { root.querySelector('.skel-lines')?.remove(); root.append(h('p', { class: 'form-err', role: 'alert', text: api.errorText(e) })); return; }
  root.querySelector('.skel-lines')?.remove();
  const users = r?.users || [], roots = r?.root_admins || [], me = state.me?.email, reload = () => renderUsers(root);
  const open = btn('Add person', { kind: 'primary', ic: 'plus', on: () => addDialog(users, reload) }); open.id = 'u-open';
  root.querySelector('.view-head').append(h('div', { class: 'row' }, open, h('span', { class: 'muted', text: `${users.length} of ${MAX} people` })));
  const rows = users.map(u => {
    const isRoot = !!u.root || roots.includes(u.email), self = u.email === me, secret = u.source === 'secret', locked = isRoot || self || secret;
    const why = isRoot ? 'Root admins are set on the server' : secret ? 'Set on the server, change it there' : self ? 'You cannot change your own access' : '';
    const sel = h('select', { 'aria-label': `Role for ${u.email}`, disabled: locked, title: why || undefined }, h('option', { value: 'viewer', text: 'Viewer' }), h('option', { value: 'admin', text: 'Admin' }));
    sel.value = u.role;
    sel.addEventListener('change', async () => {
      const prev = u.role;
      try { await api.setUserRole(u.email, sel.value); toast(`${u.email} is now ${sel.value}.`, { kind: 'success' }); await reload(); }
      catch (e) { sel.value = prev; if (e.status !== 401) toast(api.errorText(e), { kind: 'error' }); }
    });
    const rm = btn('Remove', { kind: 'danger-ghost', ic: 'trash', cls: 'sm', disabled: locked, aria: 'Remove ' + u.email, title: why || undefined });
    rm.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Remove this person?', desc: 'They lose access on their next request.', name: u.email, confirmLabel: 'Remove', typed: { label: 'Type the email address to confirm:', expected: u.email }, run: () => api.removeUser(u.email) });
      if (ok) { toast(`Removed ${u.email}.`, { kind: 'success' }); await reload(); }
    });
    const badge = isRoot ? h('span', { class: 'pill root', text: 'ROOT' }) : h('span', { class: 'pill role-' + u.role, text: u.role });
    return h('tr', { 'data-email': u.email, class: locked ? 'locked' : '' },
      h('td', { 'data-label': 'Person' }, h('span', { class: 'email', text: u.email }), badge, self ? h('span', { class: 'pill you', text: 'You' }) : null),
      h('td', { 'data-label': 'Role' }, sel), h('td', { 'data-label': 'Source' }, h('span', { class: 'src', text: secret ? 'Server secret' : 'Added here' })),
      h('td', { 'data-label': 'Added' }, u.added_at ? timeEl(u.added_at) : '—', u.added_by ? h('small', { class: 'by', text: ' by ' + u.added_by }) : null), h('td', { class: 'act' }, rm));
  });
  const tbl = h('table', { class: 'audit users' }, h('thead', null, h('tr', null, ...['Person', 'Role', 'Source', 'Added', ''].map(x => h('th', { scope: 'col', text: x })))), h('tbody', null, ...rows));
  root.append(h('div', { class: 'table-wrap' }, tbl),
    h('p', { class: 'muted note' }, icon('shield'), ' Root admins and people set as server secrets cannot be changed here, and nobody can change their own access. Granting admin or removing someone asks you to sign in again.'));
}
