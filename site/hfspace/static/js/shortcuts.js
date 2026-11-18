import { h } from './dom.js';
import { createModal } from './a11y.js';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
const GROUPS = [
  ['Anywhere', [['?', 'Show this list'], ['/', 'Search clips and commands'], [MAC ? 'Cmd K' : 'Ctrl K', 'Command palette'], ['Esc', 'Close the top panel']]],
  ['Post mode', [['j or Down', 'Next clip'], ['k or Up', 'Previous clip'], ['c', 'Copy the YouTube kit'], ['i', 'Copy the Instagram kit'], ['p', 'Toggle posted on YouTube'], ['Shift P', 'Toggle posted on Instagram'], ['d', 'Download the clip'], ['m', 'Mute or unmute'], ['s', 'Safe-zone overlay'], ['Space', 'Play or pause']]],
  ['Library', [['Arrow keys', 'Move between cards'], ['Enter', 'Open the clip'], ['Long press', 'Quick actions on a card']]],
];
let m = null;
export function openShortcuts() {
  if (m?.dialog.isConnected && m.dialog.open) return;
  m = createModal({ title: 'Keyboard shortcuts', cls: 'shortcuts' });
  for (const [name, rows] of GROUPS) {
    m.body.append(h('section', { class: 'sc-group' }, h('h3', { text: name }), h('dl', { class: 'sc-list' }, ...rows.flatMap(([k, d]) => [h('dt', null, ...k.split(' ').map((p, i) => (p === 'or' ? h('span', { class: 'or', text: 'or' }) : h('kbd', { text: p })))), h('dd', { text: d })]))));
  }
  m.foot.append(h('button', { type: 'button', class: 'btn primary', text: 'Got it', on: { click: () => m.close() } }));
  m.open(m.foot.querySelector('button'));
}
