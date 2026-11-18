import { state, emit, canWrite } from './state.js';
import { h, btn, icon } from './dom.js';
import { human } from './fmt.js';
import { createModal, haptic, announce } from './a11y.js';
import { toast } from './toast.js';
import * as api from './api.js';
import { loadActive } from './data.js';

const MAX_VIDEO = 150 * 1024 * 1024, MAX_POSTER = 3 * 1024 * 1024;
const isMp4 = f => f.type === 'video/mp4' || (!f.type && /\.mp4$/i.test(f.name)) || (f.type === '' && /\.mp4$/i.test(f.name));
const isJpg = f => f.type === 'image/jpeg' || (!f.type && /\.jpe?g$/i.test(f.name));
export const eta = s => !Number.isFinite(s) ? '…' : s < 60 ? Math.ceil(s) + ' s' : Math.floor(s / 60) + ' min ' + Math.ceil(s % 60) + ' s';

export function openUpload() {
  if (!canWrite()) { toast('The vault is read-only right now.', { kind: 'error' }); return; }
  const m = createModal({ title: 'Upload a clip', cls: 'upload', sticky: true, desc: 'MP4 video up to 150 MB, optional JPEG poster up to 3 MB.' });
  let video = null, poster = null, xhr = null, uploading = false, preview = null;
  const err = h('p', { class: 'form-err', role: 'alert', id: 'up-err' });
  const vIn = h('input', { type: 'file', accept: 'video/mp4,.mp4', id: 'up-video', class: 'file-in', 'aria-label': 'Video file (mp4)' });
  const pIn = h('input', { type: 'file', accept: 'image/jpeg,.jpg,.jpeg', id: 'up-poster', class: 'file-in', 'aria-label': 'Poster image (jpeg)' });
  const dzText = h('strong', { text: 'Drop an .mp4 here' }), dzSub = h('span', { text: 'or tap to choose a file' });
  const thumb = h('img', { class: 'up-thumb', alt: '', hidden: true }), shade = h('i', { class: 'up-shade', hidden: true });
  const dz = h('div', { class: 'dropzone', role: 'button', tabindex: 0, 'aria-label': 'Choose video file' }, h('div', { class: 'thumbwrap' }, thumb, shade, icon('upload')), h('div', { class: 'dz-t' }, dzText, dzSub));
  const mk = (id, label, ta) => { const el = ta ? h('textarea', { id, rows: 3 }) : h('input', { id, type: 'text', autocomplete: 'off' }); return [el, h('div', { class: 'field' }, h('label', { for: id, text: label }), el)]; };
  const [title, fTitle] = mk('up-title', 'Title'), [hook, fHook] = mk('up-hook', 'Hook'), [desc, fDesc] = mk('up-desc', 'Description', true), [postT, fPost] = mk('up-post', 'Post kit text', true), [stream, fStream] = mk('up-stream', 'Stream'), [tags, fTags] = mk('up-tags', 'Tags (comma separated)');
  stream.setAttribute('list', 'stream-list2');
  const dlist = h('datalist', { id: 'stream-list2' }, ...[...new Set(state.clips.map(c => c.stream).filter(Boolean))].map(s => h('option', { value: s })));
  const pBtn = btn('Choose poster (jpeg)', { ic: 'image', kind: 'ghost', cls: 'sm', on: () => pIn.click() }), pName = h('span', { class: 'muted', id: 'up-pname', text: 'No poster' });
  const bar = h('div', { class: 'pbar', role: 'progressbar', 'aria-label': 'Upload progress', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 }, h('i', { class: 'pfill' }));
  const pstat = h('p', { class: 'pstat', 'aria-live': 'polite' });
  const prog = h('div', { class: 'progress', hidden: true }, bar, pstat);
  const dupRow = h('div', { class: 'row dup-row', hidden: true });
  m.body.append(vIn, pIn, dz, h('div', { class: 'row poster-row' }, pBtn, pName), h('div', { class: 'form-grid' }, fTitle, fHook, fDesc, fPost, fStream, fTags, dlist), prog, err, dupRow);
  const cancel = btn('Cancel', { kind: 'ghost', on: () => { if (xhr) { xhr.abort(); } else m.close(false); } }); cancel.id = 'up-cancel';
  const go = btn('Upload', { kind: 'primary', ic: 'upload', disabled: true }); go.id = 'up-go';
  m.foot.append(cancel, go);

  const setErr = t => { err.textContent = t || ''; };
  const check = () => { go.disabled = uploading || !video || !title.value.trim(); };
  const setVideo = f => {
    setErr('');
    if (!isMp4(f)) { setErr('That is not an .mp4 video. Only mp4 is accepted.'); return; }
    if (f.size > MAX_VIDEO) { setErr(`That video is ${human(f.size)}. The limit is 150 MB.`); return; }
    if (f.size === 0) { setErr('That file is empty.'); return; }
    video = f; dzText.textContent = f.name; dzSub.textContent = human(f.size) + ' - tap to change';
    if (!title.value.trim()) title.value = f.name.replace(/\.mp4$/i, '').replace(/[_]+/g, ' ');
    dz.classList.add('has'); check();
  };
  const setPoster = f => {
    setErr('');
    if (!isJpg(f)) { setErr('The poster must be a JPEG image.'); return; }
    if (f.size > MAX_POSTER) { setErr(`The poster is ${human(f.size)}. The limit is 3 MB.`); return; }
    poster = f; pName.textContent = `${f.name} (${human(f.size)})`;
    if (preview) URL.revokeObjectURL(preview); preview = URL.createObjectURL(f); thumb.src = preview; thumb.hidden = false;
  };
  vIn.addEventListener('change', () => { if (vIn.files[0]) setVideo(vIn.files[0]); });
  pIn.addEventListener('change', () => { if (pIn.files[0]) setPoster(pIn.files[0]); });
  dz.addEventListener('click', () => vIn.click());
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); vIn.click(); } });
  for (const ev of ['dragenter', 'dragover']) dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); });
  dz.addEventListener('drop', e => { const fs = [...(e.dataTransfer?.files || [])]; const v = fs.find(f => isMp4(f) || /video/.test(f.type)), p = fs.find(isJpg); if (v) setVideo(v); else if (!p) setErr('Drop an .mp4 video (and optionally a JPEG poster).'); if (p) setPoster(p); });
  title.addEventListener('input', check);

  go.addEventListener('click', () => {
    if (!video || !title.value.trim()) return;
    setErr(''); dupRow.hidden = true; dupRow.replaceChildren();
    const fd = new FormData();
    fd.append('video', video, video.name); if (poster) fd.append('poster', poster, poster.name);
    for (const [k, el] of Object.entries({ title, hook, desc, post: postT, stream, tags })) fd.append(k, el.value.trim ? (k === 'desc' || k === 'post' ? el.value : el.value.trim()) : el.value);
    uploading = true; check(); cancel.querySelector('.lbl').textContent = 'Cancel upload';
    m.dialog.classList.add('uploading'); prog.hidden = false; shade.hidden = false; for (const el of m.body.querySelectorAll('input,textarea,select')) el.disabled = true;
    const t0 = performance.now(); let lastUi = 0, speed = 0, lastLoaded = 0, lastT = t0;
    const setP = p => { bar.setAttribute('aria-valuenow', String(Math.round(p * 100))); bar.firstElementChild.style.setProperty('--p', p.toFixed(4)); shade.style.setProperty('--p', p.toFixed(4)); };
    setP(0); pstat.textContent = 'Starting…';
    xhr = new AbortController();
    const onProgress = e => {
      const now = performance.now(), p = e.loaded / e.total; setP(p);
      if (now - lastUi < 120 && p < 1) return; lastUi = now;
      const inst = (e.loaded - lastLoaded) / Math.max(0.001, (now - lastT) / 1000); lastLoaded = e.loaded; lastT = now; speed = speed ? speed * 0.7 + inst * 0.3 : inst;
      const left = (e.total - e.loaded) / Math.max(1, speed);
      pstat.textContent = `${Math.round(p * 100)}% - ${human(e.loaded)} of ${human(e.total)} - ${human(speed)}/s - ${p >= 1 ? 'processing…' : eta(left) + ' left'}`;
    };
    const finish = () => { xhr = null; uploading = false; m.dialog.classList.remove('uploading'); for (const el of m.body.querySelectorAll('input,textarea,select')) el.disabled = false; cancel.querySelector('.lbl').textContent = 'Cancel'; check(); };
    api.uploadClip(fd, { onProgress, signal: xhr.signal }).then(async data => {
      finish(); setP(1); pstat.textContent = 'Done.'; haptic(15); announce('Upload complete');
      toast('Clip uploaded.', { kind: 'success' }); await loadActive(); m.close(true);
      if (data?.clip?.id) { location.hash = '#/clip/' + encodeURIComponent(data.clip.id); }
    }, async e => {
      finish(); prog.hidden = true; shade.hidden = true;
      if (e?.name === 'AbortError') { setErr('Upload cancelled.'); return; }
      if (e.status === 401) { m.close(false); return; }
      const msg = e.status === 0 ? 'The upload failed. Check your connection and try again.' : api.errorText(e);
      setErr(msg); toast(msg, { kind: 'error' });
      if (e.status === 409 && e.body?.clip_id) { dupRow.hidden = false; dupRow.append(btn('Open the existing clip', { ic: 'link', kind: 'primary', cls: 'sm', on: () => { m.close(false); location.hash = '#/clip/' + encodeURIComponent(e.body.clip_id); } })); }
    });
  });
  m.done.then(() => { if (xhr) xhr.abort(); if (preview) URL.revokeObjectURL(preview); });
  m.open(vIn.hidden ? dz : dz);
  return m;
}
