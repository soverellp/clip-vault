// Sequential "Download all" with a queue/progress panel. No zip: each clip is a normal browser download, one after another.
import { h, btn, icon } from './dom.js';
import { toast } from './toast.js';
import { announce } from './a11y.js';
import { dur, titleOf, human } from './fmt.js';
import { downloadClip } from './kit.js';
import { confirmDialog } from './admin.js';
import { state } from './state.js';

const GAP = 800; // browsers throttle bursts of downloads; a short pause keeps them all
let panel = null, running = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function isRunning() { return !!running; }
export async function downloadAll(clips, label = 'clips') {
  if (running) { toast('A download queue is already running. Wait for it or cancel it.', { kind: 'error' }); return false; }
  const items = clips.filter(c => c && c.video);
  if (!items.length) { toast('Nothing to download here.', { kind: 'error' }); return false; }
  if (items.length > 3) {
    const bytes = items.reduce((a, c) => a + (Number(c.size) || 0), 0);
    const ok = await confirmDialog({ title: `Download ${items.length} clips?`, desc: `They download one after another (about ${human(bytes)} in total). Your browser may ask to allow multiple downloads.`, name: label, confirmLabel: `Download ${items.length}`, danger: false, run: async () => {} }).catch(() => false);
    if (!ok) return false;
  }
  const ctl = new AbortController();
  const rows = items.map(c => ({ c, st: 'wait', pct: 0, li: h('li', { class: 'dq-row', 'data-id': c.id, 'data-state': 'wait' }, h('span', { class: 'dq-t', lang: 'hi-Latn', text: titleOf(c) }), h('span', { class: 'dq-s', text: 'Waiting' })) }));
  const head = h('p', { class: 'dq-head', 'aria-live': 'polite' }), bar = h('i', { class: 'dq-bar' });
  const cancel = btn('Cancel', { kind: 'ghost', cls: 'sm', on: () => { ctl.abort(); } }); cancel.id = 'dq-cancel';
  const close = btn('', { ic: 'x', kind: 'ghost', cls: 'icon', aria: 'Close download queue', on: () => end() }); close.hidden = true;
  panel?.remove();
  panel = h('section', { class: 'dq glass', role: 'region', 'aria-label': 'Download queue', id: 'dq' }, h('div', { class: 'dq-top' }, h('strong', { text: `Downloading ${label}` }), h('span', { class: 'grow' }), cancel, close), head, h('div', { class: 'dq-track' }, bar), h('ul', { class: 'dq-list' }, ...rows.map(r => r.li)));
  document.body.append(panel);
  const set = (r, st, text) => { r.st = st; r.li.dataset.state = st; r.li.querySelector('.dq-s').textContent = text; };
  const paint = () => { const done = rows.filter(r => r.st === 'done').length; head.textContent = `${done} of ${rows.length} downloaded`; bar.style.setProperty('--p', (rows.reduce((a, r) => a + (r.st === 'done' ? 1 : r.pct), 0) / rows.length).toFixed(3)); };
  const end = () => { panel?.remove(); panel = null; };
  running = ctl; paint();
  for (const r of rows) {
    if (ctl.signal.aborted) { set(r, 'skip', 'Cancelled'); continue; }
    set(r, 'prep', 'Starting…'); paint();
    const ok = await downloadClip(r.c, { signal: ctl.signal, onProgress: ({ loaded, total }) => { if (total) { r.pct = loaded / total; r.li.querySelector('.dq-s').textContent = Math.round(r.pct * 100) + '%'; paint(); } } });
    if (ok) { r.pct = 1; set(r, 'done', 'Saved ' + dur(r.c.dur)); } else set(r, ctl.signal.aborted ? 'skip' : 'fail', ctl.signal.aborted ? 'Cancelled' : 'Failed');
    paint();
    if (ok && r !== rows[rows.length - 1] && !ctl.signal.aborted) await sleep(GAP);
  }
  running = null; cancel.hidden = true; close.hidden = false;
  const done = rows.filter(r => r.st === 'done').length, skipped = rows.filter(r => r.st === 'skip').length, failed = rows.filter(r => r.st === 'fail').length;
  head.textContent = ctl.signal.aborted ? `Cancelled: ${done} of ${rows.length} downloaded` : failed ? `${done} downloaded, ${failed} failed` : `All ${done} downloaded`;
  panel.classList.add('finished'); announce(head.textContent);
  if (!state.reduced) setTimeout(() => { if (panel && !running && panel.classList.contains('finished')) end(); }, 12000);
  return !failed && !skipped;
}
