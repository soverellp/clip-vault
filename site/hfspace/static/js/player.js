import { h, btn, icon, setIcon } from './dom.js';
import * as api from './api.js';
import { state } from './state.js';
import { toast } from './toast.js';
import { versionSelect } from './vsel.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const mmss = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

// versions (optional) = { combos: [key...], current: key, clipOf: key => clip, onPick: (key, clip, how) => void }: a compact version toggle INSIDE the player (under the phone).
// Switching keeps the playback position and the play/pause state.
export function createPlayer(clip, { trashed = false, versions = null } = {}) {
  const mediaRefs = [];
  const video = h('video', { playsinline: '', preload: 'metadata', 'aria-label': 'Clip video', disablepictureinpicture: undefined });
  const bigPlay = h('button', { type: 'button', class: 'bigplay', 'aria-label': 'Play' }, icon('play'));
  const safe = h('div', { class: 'safe', hidden: true, 'aria-hidden': 'true' }, h('i', { class: 'safe-b' }, h('b', { text: 'Bottom 20%: app UI' })), h('i', { class: 'safe-r' }, h('b', { text: 'Right 15%' })));
  const msg = h('div', { class: 'vmsg', hidden: true, role: 'alert' });
  const vprog = h('div', { class: 'vprog', hidden: true, role: 'status' });
  const screen = h('div', { class: 'phone-screen' }, video, safe, bigPlay, vprog, msg);
  const phone = h('div', { class: 'phone' }, h('span', { class: 'notch' }), screen);
  const viz = h('canvas', { class: 'viz', 'aria-hidden': 'true', height: 56 });

  const buf = h('i', { class: 'buf' }), played = h('i', { class: 'played' }), thumb = h('i', { class: 'thumb' });
  const seek = h('div', { class: 'seek', role: 'slider', tabindex: 0, 'aria-label': 'Seek', 'aria-valuemin': 0, 'aria-valuemax': 0, 'aria-valuenow': 0, 'aria-valuetext': '0:00' }, h('div', { class: 'track' }, buf, played), thumb);
  const time = h('span', { class: 'time', text: '0:00 / 0:00' });
  const bPlay = btn('', { ic: 'play', cls: 'icon', aria: 'Play', kind: 'ghost' });
  const bMute = btn('', { ic: 'volume', cls: 'icon', aria: 'Mute', kind: 'ghost' });
  const bSpeed = btn('1x', { cls: 'speed', aria: 'Playback speed 1x', kind: 'ghost', title: 'Playback speed' });
  const bSafe = btn('', { ic: 'shield', cls: 'icon', aria: 'Safe zone overlay', kind: 'ghost', title: 'Safe zone (S)' });
  bSafe.setAttribute('aria-pressed', 'false');
  const bPip = btn('', { ic: 'pip', cls: 'icon', aria: 'Picture in picture', kind: 'ghost' });
  bPip.hidden = !document.pictureInPictureEnabled;
  const bFs = btn('', { ic: 'maximize', cls: 'icon', aria: 'Fullscreen', kind: 'ghost', title: 'Fullscreen (F)' });
  const controls = h('div', { class: 'controls' }, h('div', { class: 'seek-row' }, seek, time), h('div', { class: 'btn-row' }, bPlay, bMute, bSpeed, h('span', { class: 'grow' }), bSafe, bPip, bFs));
  const vs = versions && versions.combos.length > 1 ? versionSelect({ combos: versions.combos, current: versions.current, cls: 'vs-player', aria: 'Version of this clip', onPick: (k, how) => swap(versions.clipOf(k), k, how) }) : null;
  const root = h('div', { class: 'player' }, phone, viz, ...(vs ? [vs.el] : []), controls);

  let speedI = 2, dragging = false;
  const dur = () => (Number.isFinite(video.duration) ? video.duration : 0);
  const sync = () => {
    const d = dur(), t = video.currentTime || 0, p = d ? t / d : 0;
    played.style.setProperty('--p', p.toFixed(4)); thumb.style.setProperty('--p', p.toFixed(4));
    seek.setAttribute('aria-valuemax', String(Math.round(d))); seek.setAttribute('aria-valuenow', String(Math.round(t))); seek.setAttribute('aria-valuetext', mmss(t) + ' of ' + mmss(d));
    time.textContent = mmss(t) + ' / ' + mmss(d);
  };
  const syncBuf = () => { const d = dur(); let e = 0; try { for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime + 0.5) e = Math.max(e, video.buffered.end(i)); } catch { /* ignore */ } buf.style.setProperty('--p', d ? (e / d).toFixed(4) : '0'); };
  const toggle = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
  bigPlay.addEventListener('click', toggle); bPlay.addEventListener('click', toggle);
  video.addEventListener('click', toggle);
  video.addEventListener('play', () => { setIcon(bPlay, 'pause'); bPlay.setAttribute('aria-label', 'Pause'); root.classList.add('playing'); initAudio(); startViz(); });
  video.addEventListener('pause', () => { setIcon(bPlay, 'play'); bPlay.setAttribute('aria-label', 'Play'); root.classList.remove('playing'); stopViz(); });
  video.addEventListener('ended', () => { root.classList.remove('playing'); stopViz(); });
  for (const ev of ['timeupdate', 'loadedmetadata', 'durationchange', 'seeked']) video.addEventListener(ev, sync);
  for (const ev of ['progress', 'loadedmetadata', 'seeked', 'canplay']) video.addEventListener(ev, syncBuf);
  video.addEventListener('error', () => {
    msg.hidden = false; msg.textContent = "This video can't be played in your browser. You can still download it.";
  });
  video.addEventListener('waiting', () => root.classList.add('wait')); video.addEventListener('playing', () => root.classList.remove('wait'));
  video.addEventListener('canplay', () => root.classList.remove('wait'));
  bMute.addEventListener('click', () => { video.muted = !video.muted; });
  video.addEventListener('volumechange', () => { setIcon(bMute, video.muted ? 'mute' : 'volume'); bMute.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute'); });
  bSpeed.addEventListener('click', () => { speedI = (speedI + 1) % SPEEDS.length; video.playbackRate = SPEEDS[speedI]; bSpeed.querySelector('.lbl').textContent = SPEEDS[speedI] + 'x'; bSpeed.setAttribute('aria-label', 'Playback speed ' + SPEEDS[speedI] + 'x'); });
  const toggleSafe = () => { safe.hidden = !safe.hidden; bSafe.setAttribute('aria-pressed', String(!safe.hidden)); };
  bSafe.addEventListener('click', toggleSafe);
  bPip.addEventListener('click', async () => { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); } catch { toast('Picture in picture is not available here.'); } });
  const toggleFs = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.requestFullscreen(); } catch { toast('Fullscreen is not available here.'); } };
  bFs.addEventListener('click', toggleFs);
  if (!root.requestFullscreen) bFs.hidden = true;

  const seekTo = e => { const r = seek.getBoundingClientRect(), p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); if (dur()) video.currentTime = p * dur(); };
  seek.addEventListener('pointerdown', e => { dragging = true; seek.setPointerCapture(e.pointerId); seekTo(e); });
  seek.addEventListener('pointermove', e => { if (dragging) seekTo(e); });
  seek.addEventListener('pointerup', () => { dragging = false; });
  seek.addEventListener('keydown', e => {
    const d = dur(); const step = e.shiftKey ? 10 : 5;
    if (e.key === 'ArrowRight') video.currentTime = Math.min(d, video.currentTime + step);
    else if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - step);
    else if (e.key === 'Home') video.currentTime = 0; else if (e.key === 'End') video.currentTime = d; else return;
    e.preventDefault();
  });

  // audio-reactive bars (Web Audio on the same-origin element; silently skipped if anything is blocked)
  let ctx = null, an = null, data = null, raf = 0, audioTried = false, vctx = null, rgb = '139 123 255';
  function initAudio() {
    if (audioTried) { ctx?.resume?.().catch(() => {}); return; }
    audioTried = true;
    try {
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      ctx = new AC(); const s = ctx.createMediaElementSource(video); an = ctx.createAnalyser(); an.fftSize = 128; an.smoothingTimeConstant = 0.78;
      s.connect(an); an.connect(ctx.destination); data = new Uint8Array(an.frequencyBinCount); ctx.resume?.().catch(() => {});
    } catch { an = null; }
  }
  function startViz() {
    if (state.reduced || !an || raf) return;
    viz.classList.add('on'); vctx = vctx || viz.getContext('2d');
    rgb = getComputedStyle(root).getPropertyValue('--ac-rgb').trim().replace(/\s+/g, ',') || '139,123,255';
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      const dpr = Math.min(devicePixelRatio || 1, 2), w = Math.round(viz.clientWidth * dpr), hh = Math.round(56 * dpr);
      if (viz.width !== w) viz.width = w; if (viz.height !== hh) viz.height = hh;
      an.getByteFrequencyData(data);
      vctx.clearRect(0, 0, w, hh);
      const n = 36, bw = w / n, g = vctx.createLinearGradient(0, hh, 0, 0); g.addColorStop(0, `rgba(${rgb},.25)`); g.addColorStop(1, `rgba(${rgb},1)`); vctx.fillStyle = g;
      for (let i = 0; i < n; i++) { const v = data[Math.floor(i * 0.9)] / 255, bh = Math.max(3 * dpr, v * hh); vctx.beginPath(); vctx.roundRect(i * bw + bw * 0.18, hh - bh, bw * 0.64, bh, bw * 0.3); vctx.fill(); }
    };
    raf = requestAnimationFrame(loop);
  }
  function stopViz() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  function key(e) {
    const t = e.target; if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const k = e.key.toLowerCase();
    if (k === 'k') toggle(); else if (k === 'm') video.muted = !video.muted; else if (k === 'f') toggleFs(); else if (k === 's') toggleSafe();
    else if (k === 'j') video.currentTime = Math.max(0, video.currentTime - 5); else if (k === 'l') video.currentTime = Math.min(dur(), video.currentTime + 5);
    else return;
    e.preventDefault();
  }
  let gone = false, loadId = 0, shown = clip, vref = null;
  function load(c, resume) {
    const id = ++loadId; msg.hidden = true; shown = c;
    if (c.poster) { const pu = api.directMediaUrl(c.poster, { trashed }); if (pu) video.poster = pu; else api.fetchMedia(c.poster, { trashed }).then(m => { if (gone || id !== loadId) { m.revoke(); return; } mediaRefs.push(m); video.poster = m.url; }).catch(() => {}); }
    if (c.video) {
      api.fetchMedia(c.video, { trashed, onProgress: ({ loaded, total }) => { if (id !== loadId) return; vprog.hidden = false; vprog.textContent = total ? `Loading ${Math.round((loaded / total) * 100)}%` : 'Loading…'; } })
        .then(m => {
          if (gone || id !== loadId) { m.revoke(); return; }
          vprog.hidden = true; const t = video.currentTime || 0, was = !video.paused, old = vref; vref = m; mediaRefs.push(m); video.src = m.url; if (old) { old.revoke(); const i = mediaRefs.indexOf(old); if (i >= 0) mediaRefs.splice(i, 1); }
          if (resume) video.addEventListener('loadedmetadata', () => { try { video.currentTime = Math.min(t, Math.max(0, (video.duration || t) - 0.05)); } catch { /* ignore */ } if (was) video.play().catch(() => {}); }, { once: true });
        })
        .catch(e => { if (id !== loadId) return; vprog.hidden = true; msg.hidden = false; msg.textContent = e?.status === 404 ? 'This clip has no video file.' : api.errorText(e); });
    } else { vprog.hidden = true; msg.hidden = false; msg.textContent = 'This clip has no video file.'; }
  }
  function swap(c, k, how) { if (!c || c === shown) return; load(c, true); versions?.onPick?.(k, c, how); }
  load(clip, false);
  sync();
  return {
    el: root, video, key, versionEl: vs?.el || null, get clip() { return shown; },
    destroy() { gone = true; loadId++; for (const m of mediaRefs) m.revoke(); stopViz(); try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ } try { ctx?.close(); } catch { /* ignore */ } },
  };
}
