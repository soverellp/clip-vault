// Template manager (#/templates): list, create, edit (live preview on a sample clip), duplicate, delete. Rendering is plain text only (textContent).
import { state } from './state.js';
import { h, btn, icon } from './dom.js';
import { createModal } from './a11y.js';
import { newId, normTags } from './playlists.js';
import { TPL_PLATFORMS, TPL_LABEL, VARS, LIMIT_KEYS, PRESETS, renderPost, validatePost, sampleClip, sampleStream } from './templates.js';
import { ensureCss, canEditPl, RO_HINT, tplAct, effectiveTemplates } from './plui.js';
import { confirmDialog } from './plview.js';

const put = (el, ...kids) => el.replaceChildren(...kids.filter(Boolean));
const LIMIT_LABEL = { title_max: 'Title max', caption_max: 'Caption max', total_max: 'Total max', hashtags_max: 'Hashtags max', dur_min: 'Clip min (s)', dur_max: 'Clip max (s)' };
const limitText = l => LIMIT_KEYS.filter(k => l[k]).map(k => `${LIMIT_LABEL[k]} ${l[k]}`).join(', ') || 'No limits';

function openTemplateForm(t0, opener) {
  const isNew = !t0 || !effectiveTemplates().some(x => x.id === t0.id), t = t0 || { id: newId('tpl'), name: '', platform: 'any', title_tpl: '', caption_tpl: '', hashtags: [], required_hashtags: [], limits: {}, notes: '' };
  const m = createModal({ title: isNew ? 'New template' : 'Edit template', cls: 'pl-modal pl-editor' });
  const f = {
    name: h('input', { type: 'text', id: 'tf-name', maxlength: 80, value: t.name, 'aria-label': 'Template name' }),
    platform: h('select', { id: 'tf-platform', 'aria-label': 'Platform' }, ...TPL_PLATFORMS.map(k => h('option', { value: k, text: TPL_LABEL[k], selected: t.platform === k }))),
    title_tpl: h('input', { type: 'text', id: 'tf-title', maxlength: 300, value: t.title_tpl, 'aria-label': 'Title template' }),
    caption_tpl: h('textarea', { id: 'tf-caption', rows: 5, maxlength: 5000, 'aria-label': 'Caption template', text: t.caption_tpl }),
    hashtags: h('input', { type: 'text', id: 'tf-tags', value: t.hashtags.join(' '), 'aria-label': 'Hashtags', placeholder: '#shorts #fyp' }),
    required: h('input', { type: 'text', id: 'tf-req', value: t.required_hashtags.join(' '), 'aria-label': 'Required hashtags', placeholder: '#KaiCenat' }),
    notes: h('textarea', { id: 'tf-notes', rows: 2, maxlength: 500, 'aria-label': 'Notes', text: t.notes }),
  };
  const lim = Object.fromEntries(LIMIT_KEYS.map(k => [k, h('input', { type: 'text', inputmode: 'numeric', id: 'tf-' + k, value: t.limits[k] || '', 'aria-label': LIMIT_LABEL[k], maxlength: 6 })]));
  const prev = h('div', { class: 'pl-preview', 'aria-live': 'polite' }), err = h('p', { class: 'field-err', role: 'alert' });
  const cur = () => ({ id: t.id, name: f.name.value, platform: f.platform.value, title_tpl: f.title_tpl.value, caption_tpl: f.caption_tpl.value, hashtags: normTags(f.hashtags.value), required_hashtags: normTags(f.required.value),
    limits: Object.fromEntries(LIMIT_KEYS.map(k => [k, Number(lim[k].value)]).filter(([, v]) => Number.isFinite(v) && v > 0)), notes: f.notes.value });
  const upd = () => {
    const tp = cur(), r = renderPost(tp, sampleClip(), sampleStream(), 1), w = validatePost(r.post, tp, { dur: sampleClip().dur, unknown: r.unknown });
    put(prev, h('h3', { class: 'pl-sub', text: 'Preview on a sample clip' }), h('p', { class: 'pi-title', text: r.post.title || '(no title)' }), h('p', { class: 'pi-cap', text: r.post.caption || '(no caption)' }),
      r.post.hashtags.length ? h('p', { class: 'pi-tags', text: r.post.hashtags.join(' ') }) : null,
      w.length ? h('ul', { class: 'pl-warn' }, ...w.map(x => h('li', { text: x }))) : h('p', { class: 'pl-okline', text: 'No warnings.' }),
      r.empty.length ? h('p', { class: 'muted', text: `No data for ${r.empty.map(x => '{' + x + '}').join(' ')} on some clips: it renders empty.` }) : null);
  };
  for (const el of [...Object.values(f), ...Object.values(lim)]) el.addEventListener('input', upd);
  const lab = (text, el, cls) => h('label', { class: cls }, h('span', { text }), el);
  m.body.append(h('div', { class: 'pl-form' }, lab('Name', f.name), lab('Platform', f.platform), lab('Title template', f.title_tpl), lab('Caption template', f.caption_tpl),
    h('p', { class: 'muted pl-vars', text: 'Variables: ' + VARS.map(v => '{' + v + '}').join(' ') + '. Unknown ones stay as typed and are flagged.' }),
    lab('Hashtags', f.hashtags), lab('Required hashtags', f.required), h('fieldset', { class: 'pl-fs pl-limits' }, h('legend', { text: 'Limits (empty = none)' }), ...LIMIT_KEYS.map(k => lab(LIMIT_LABEL[k], lim[k]))), lab('Notes', f.notes), prev, err));
  upd();
  const save = async () => {
    const v = cur(); err.textContent = '';
    if (!v.name.trim()) { err.textContent = 'Give the template a name.'; f.name.focus(); return; }
    const r = await tplAct({ type: 'upsert', template: v }, 'Template saved'); if (r) m.close(true);
  };
  m.foot.append(btn('Cancel', { on: () => m.close(false) }), btn('Save', { kind: 'primary', on: save }));
  m.dialog.addEventListener('close', () => { if (opener?.isConnected) setTimeout(() => opener.focus?.(), 0); }, { once: true });
  m.open(f.name); return m;
}

export function render(el) {
  ensureCss(); el.classList.add('pl-view'); el.dataset.k = 'templates';
  const ro = !canEditPl(), tpls = effectiveTemplates();
  const head = h('header', { class: 'pl-head' }, h('a', { class: 'back-link', href: '#/playlists' }, icon('back'), h('span', { text: 'Playlists' })), h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1', text: 'Templates' }),
    h('p', { class: 'page-sub', text: 'Reusable post text with variables. Apply one to a playlist to fill every item.' }),
    h('div', { class: 'pl-bar' }, btn('New template', { ic: 'plus', kind: 'primary', cls: 'tpl-new', on: e => openTemplateForm(null, e.currentTarget), disabled: ro }),
      btn('Add built-in presets', { ic: 'layers', cls: 'tpl-seed', on: () => tplAct({ type: 'seed', templates: PRESETS }, 'Presets added'), disabled: ro || PRESETS.every(p => tpls.some(t => t.id === p.id)) })));
  const list = h('ul', { class: 'pl-list', 'aria-label': 'Templates' });
  for (const t of tpls) {
    list.append(h('li', { class: 'pl-card tpl-card', 'data-id': t.id },
      h('div', { class: 'pl-card-main' }, h('p', { class: 'pl-card-t', text: t.name }), h('span', { class: 'pi-badge', 'data-p': t.platform, text: TPL_LABEL[t.platform] }),
        h('p', { class: 'pl-desc', text: limitText(t.limits) + (t.required_hashtags.length ? '. Required: ' + t.required_hashtags.join(' ') : '') }), t.notes ? h('p', { class: 'muted', text: t.notes }) : null),
      h('div', { class: 'pl-card-act' },
        btn('', { ic: 'edit', kind: 'ghost', cls: 'icon', aria: `Edit ${t.name}`, on: e => openTemplateForm(t, e.currentTarget), disabled: ro }),
        btn('', { ic: 'copy', kind: 'ghost', cls: 'icon tpl-dup', aria: `Duplicate ${t.name}`, disabled: ro, on: e => openTemplateForm({ ...t, id: newId('tpl'), name: t.name + ' copy' }, e.currentTarget) }),
        btn('', { ic: 'trash', kind: 'ghost', cls: 'icon danger-ghost', aria: `Delete ${t.name}`, disabled: ro, on: async () => { if (await confirmDialog({ title: 'Delete this template?', text: `"${t.name}" will be removed for everyone. Posts already filled in playlists stay as they are.` })) await tplAct({ type: 'delete', id: t.id }, 'Template deleted'); } }))));
  }
  put(el, head, ro ? h('p', { class: 'pl-ro', text: RO_HINT + '.' }) : null, tpls.length ? list : h('div', { class: 'empty pl-empty' }, h('p', { text: 'No templates.' })));
}
