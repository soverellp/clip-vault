import { state, on, emit, isAdmin, canWrite, findClip } from './state.js';
import { folderFromHash } from './moments.js';
import * as api from './api.js';
import { h, btn, icon, setIcon, $ } from './dom.js';
import { initMotion, initRipple, announce, isTyping } from './a11y.js';
import { initToasts, toast } from './toast.js';
import { startTicker } from './time.js';
import * as auth from './auth.js';
import * as hero from './hero3d.js';
import * as lib from './library.js';
import * as drawer from './drawer.js';
import { loadAll, loadActive, loadTrash } from './data.js';
import { initActions, initBulkBar, renderAudit } from './admin.js';
import { renderUsers } from './users.js';
import { openUpload } from './upload.js';
import { openPalette } from './palette.js';
import { initMagnet, loadPostMode, postModule, startPost, openShortcuts } from './kit.js';

const root = document.documentElement;
let shell, signin, topbar, tabs, browse, auditEl, usersEl, parts = {}, inApp = false;

function buildSignin() {
  const slot = h('div', { class: 'gbtn', id: 'gbtn' });
  const status = h('p', { class: 'form-err center', role: 'alert', id: 'signin-status' });
  const retry = h('div', { class: 'row center', hidden: true });
  const another = btn('Try another account', { kind: 'ghost', on: () => auth.tryAnother(slot, status, retry) }); another.id = 'try-another';
  retry.append(another);
  signin = h('section', { class: 'screen signin', id: 'signin', hidden: true, 'aria-labelledby': 'signin-h' },
    h('div', { class: 'signin-card glass' },
      h('img', { class: 'logo-big', src: '/assets/logo.svg', alt: '', width: 64, height: 64 }),
      h('h1', { id: 'signin-h', class: 'display', text: 'Clip Vault' }),
      h('p', { class: 'tag', text: 'A private home for the clips. Sign in with the Google account that was shared with you.' }),
      slot, status, retry,
      h('p', { class: 'fine', text: 'Private library. Only accounts on the list get in.' })));
  parts.signin = { slot, status, retry };
  document.getElementById('app').append(signin);
}
function buildShell() {
  const themeB = btn('', { ic: 'moon', kind: 'ghost', cls: 'icon', aria: 'Switch theme', on: () => emit('cmd', 'theme') }); themeB.id = 'theme-btn';
  const powerB = btn('', { ic: 'bolt', kind: 'ghost', cls: 'icon', aria: 'Low power mode', title: 'Low power: turns off the 3D animation' , on: () => emit('cmd', 'power') }); powerB.id = 'power-btn'; powerB.setAttribute('aria-pressed', 'false');
  const palB = btn('', { ic: 'command', kind: 'ghost', cls: 'icon', aria: 'Command palette (Ctrl K)', on: () => openPalette() }); palB.id = 'pal-btn';
  const upB = btn('Upload', { ic: 'upload', kind: 'primary', cls: 'upbtn', on: () => emit('upload') }); upB.id = 'upload-btn'; upB.hidden = true;
  const ro = h('span', { class: 'badge-ro', id: 'ro-badge', hidden: true, title: 'Your account can look but not change things right now' }, icon('shield'), h('span', { text: 'Read-only' }));
  const who = h('div', { class: 'who' });
  const outB = btn('', { ic: 'logout', kind: 'ghost', cls: 'icon', aria: 'Sign out', on: () => auth.signOut() }); outB.id = 'signout-btn';
  topbar = h('header', { class: 'topbar glass' }, h('a', { class: 'brand', href: '#/', 'aria-label': 'Clip Vault home' }, h('img', { class: 'brand-logo', 'data-src': '/assets/brand/fragbag-96.png', decoding: 'async', alt: '', width: 32, height: 32 }), h('span', { class: 'display', text: 'FRAGBAG' })),
    h('span', { class: 'grow' }), ro, upB, palB, powerB, themeB, who, outB);
  tabs = h('nav', { class: 'tabs', id: 'tabs', 'aria-label': 'Sections', hidden: true });
  const main = h('main', { id: 'main', tabindex: '-1' });
  browse = h('div', { class: 'view', id: 'browse' }); auditEl = h('div', { class: 'view', id: 'audit-view', hidden: true }); usersEl = h('div', { class: 'view', id: 'users-view', hidden: true });
  main.append(tabs, browse, auditEl, usersEl);
  shell = h('div', { id: 'shell', hidden: true }, topbar, main);
  document.getElementById('app').append(shell);
  lib.build(browse);
  // the logo is not on the critical path of the first paint: it is requested once the page has finished loading
  const logo = () => { const i = topbar.querySelector('.brand-logo'); if (i && !i.src) i.src = i.dataset.src; };
  if (document.readyState === 'complete') logo(); else addEventListener('load', logo, { once: true });
  parts.shell = { themeB, powerB, upB, ro, who };
  initBulkBar();
}

function showSignin(msg) {
  inApp = false; drawer.close(true); postModule()?.close();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  document.body.classList.remove('locked');
  shell.hidden = true; signin.hidden = false; $('#boot')?.remove();
  state.me = null; state.clips = []; state.trash = []; state.folders = []; state.folder = null; state.cat = 'all'; state.postedBy.clear(); state.lang = ''; state.homeFilter.clear(); state.libHash = '#/'; state.loaded = false; state.trashLoaded = false; state.selecting = false; state.selected.clear(); state.shortlist = []; state.shortlistOnly = false;
  lib.resetCards(); hero.setPosters([]);
  hero.mount(signin); document.title = 'Sign in - Clip Vault';
  if (location.hash) history.replaceState(null, '', location.pathname);
  auth.mountSignin(parts.signin.slot, parts.signin.status, parts.signin.retry).then(() => { if (msg) parts.signin.status.textContent = msg; });
}
function refreshChrome() {
  const { upB, ro, who } = parts.shell, me = state.me; if (!me) return;
  upB.hidden = !canWrite(); ro.hidden = !(isAdmin() && !canWrite());
  who.replaceChildren(
    // The FRAGBAG badge replaces the account initial / Google picture (owner request); the circle crop is CSS, 36 px at 1x with a 2x file.
    h('img', { class: 'avatar', src: '/assets/brand/fragbag-96.png', srcset: '/assets/brand/fragbag-96.png 1x, /assets/brand/fragbag-192.png 2x', alt: 'FRAGBAG', width: 36, height: 36 }),
    h('span', { class: 'who-t' }, h('b', { text: me.name || me.email }), h('small', { text: isAdmin() ? (me.root ? 'Root admin' : 'Admin') : 'Viewer' })));
  who.title = me.email || '';
  tabs.hidden = !isAdmin();
  const caps = me.capabilities || {};
  const mk = (href, label, key, n) => { const a = h('a', { class: 'tab', href, 'data-view': key }, h('span', { text: label }), n != null ? h('span', { class: 'n', text: String(n) }) : null); if (state.view === key) a.setAttribute('aria-current', 'page'); return a; };
  tabs.replaceChildren(...[mk('#/', 'Library', 'library', state.clips.length), mk('#/trash', 'Trash', 'trash', state.trashLoaded ? state.trash.length : (state.counts.trash ?? 0)), mk('#/audit', 'Audit log', 'audit'), caps.users ? mk('#/users', 'People', 'users') : null].filter(Boolean));
  document.body.dataset.role = me.role;
}

function route() {
  if (!state.me || !inApp) return;
  const hash = location.hash;
  const pm = /^#\/post\/(.+)$/.exec(hash);
  if (pm) {
    if (!state.loaded) return;
    let id; try { id = decodeURIComponent(pm[1]); } catch { id = ''; }
    if (!state.clips.some(c => c.id === id)) { toast('That clip was not found.', { kind: 'error' }); location.hash = '#/'; return; }
    if (lastView == null) applyView('library');
    loadPostMode().then(m => { if (location.hash === hash) m.open(id, () => drawer.close(true)); });
    return;
  }
  postModule()?.close();
  const m = /^#\/clip\/(.+)$/.exec(hash);
  if (m) {
    if (!state.loaded) return;
    let id; try { id = decodeURIComponent(m[1]); } catch { id = ''; }
    const c = findClip(id);
    if (!c && isAdmin() && !state.trashLoaded) { loadTrash().then(route); return; }
    if (c && state.trash.includes(c) && state.view !== 'trash') applyView('trash');
    drawer.open(id);
    return;
  }
  drawer.close();
  const sm = /^#\/stream\/(.+)$/.exec(hash);
  let v = hash === '#/trash' ? 'trash' : hash === '#/audit' ? 'audit' : hash === '#/users' ? 'users' : 'library';
  if ((v !== 'library' && !isAdmin()) || (v === 'users' && !state.me?.capabilities?.users)) { v = 'library'; }
  if (v === 'library') {
    let id = null; if (sm) { try { id = folderFromHash(decodeURIComponent(sm[1])); } catch { id = null; } }
    const left = state.folder, changed = id !== state.folder;
    state.folder = id; if (changed) { state.cat = 'auto'; state.q = ''; lib.getRefs().q.value = ''; }
    state.libHash = sm ? hash : '#/';
    applyView(v);
    if (changed) { if (id != null) { window.scrollTo(0, 0); lib.focusHeading(); } else if (left != null) lib.focusFolder(left); }
    return;
  }
  applyView(v);
}
let lastView = null;
function applyView(v) {
  const changed = v !== lastView; lastView = v; state.view = v;
  const isBrowse = v === 'library' || v === 'trash';
  browse.hidden = !isBrowse; auditEl.hidden = v !== 'audit'; usersEl.hidden = v !== 'users';
  if (isBrowse) {
    if (state.selecting && changed) { state.selecting = false; state.selected.clear(); emit('selection'); }
    lib.setView(v);
    if (v === 'trash' && !state.trashLoaded) loadTrash();
  } else hero.mount(null);
  if (changed) {
    const el = isBrowse ? browse : v === 'audit' ? auditEl : usersEl; el.classList.remove('view-in'); void el.offsetWidth; el.classList.add('view-in');
    if (v === 'audit') renderAudit(auditEl); if (v === 'users') renderUsers(usersEl);
    document.title = ({ library: 'Library', trash: 'Trash', audit: 'Audit log', users: 'People' }[v]) + ' - Clip Vault';
    announce(`${({ library: 'Library', trash: 'Trash', audit: 'Audit log', users: 'People' })[v]} view`);
  }
  refreshChrome(); emit('view', v);
}

async function enterApp(early) {
  inApp = true; signin.hidden = true; shell.hidden = false; $('#boot')?.remove();
  state.view = 'library'; lastView = null;
  refreshChrome();
  lib.update({ flip: false });
  if (early) await early; else await loadActive();
  if (isAdmin()) loadTrash();
  route();
}

function setTheme(t) {
  state.theme = t; if (t === 'auto') delete root.dataset.theme; else root.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const b = $('#theme-btn'); if (b) { setIcon(b, dark ? 'sun' : 'moon'); b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme'); }
}
const effectiveDark = () => state.theme === 'dark' || (state.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);

function wire() {
  on('clips', () => { if (!inApp) return; lib.update(); drawer.refresh(); refreshChrome(); route(); });
  on('reload', () => { state.loaded = false; lib.update({ flip: false }); loadAll(); });
  on('upload', () => openUpload());
  on('unauthorized', () => { if (state.me || inApp) { toast('Your session ended. Please sign in again.', { kind: 'error' }); showSignin('Your session ended. Sign in again.'); } });
  on('signedin', () => { enterApp(); });
  on('signedout', () => showSignin());
  on('cmd', c => {
    if (c === 'grid' || c === 'list') { state.mode = c; lib.getRefs().modeG.setAttribute('aria-pressed', String(c === 'grid')); lib.getRefs().modeL.setAttribute('aria-pressed', String(c === 'list')); lib.update(); }
    else if (c === 'theme') setTheme(effectiveDark() ? 'light' : 'dark');
    else if (c === 'power') { state.lowPower = !state.lowPower; root.dataset.lowpower = String(state.lowPower); const b = $('#power-btn'); b.setAttribute('aria-pressed', String(state.lowPower)); emit('lowpower'); toast(state.lowPower ? 'Low power on: 3D animation off.' : 'Low power off.'); }
    else if (c.startsWith('sort:')) { state.sort = c.slice(5); state.sortTouched = true; lib.getRefs().sort.value = state.sort; lib.update(); }
    else if (c === 'post') { const ids = state.feedIds.length ? state.feedIds : state.clips.map(x => x.id); if (ids.length) startPost(ids[0], ids, null); }
    else if (c === 'keys') openShortcuts();
    else if (c === 'group') { state.group = !state.group; lib.update(); }
    else if (c === 'signout') auth.signOut();
  });
  addEventListener('hashchange', route);
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { if (!state.me) return; e.preventDefault(); openPalette(); return; }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && state.me && !isTyping(e.target) && !document.querySelector('dialog[open]')) { e.preventDefault(); openShortcuts(); return; }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && state.me && !isTyping(e.target) && !document.querySelector('dialog[open]')) { e.preventDefault(); openPalette(); return; }
    if (e.key === 'Escape' && state.selecting && !document.querySelector('dialog[open]')) { state.selecting = false; state.selected.clear(); emit('selection'); lib.update({ flip: false }); }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => setTheme(state.theme));
}

async function boot() {
  initMotion(); initRipple(); initMagnet(); initToasts(); startTicker(); hero.init(); initActions();
  buildSignin(); buildShell(); wire(); setTheme('auto');
  let me = null, netErr = false;
  const early = loadActive(true); // clips are requested in parallel with /api/me (dropped silently if signed out)
  try { me = await auth.loadMe(); } catch (e) { if (e.status !== 401) netErr = true; }
  if (!me) { state.loaded = false; showSignin(netErr ? 'Could not reach the server. Reload to try again.' : ''); return; }
  enterApp(early);
}
boot();
