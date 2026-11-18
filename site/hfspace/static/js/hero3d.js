// WebGL hero: two counter-rotating rings of poster tiles (three.js, vendored). Falls back to the CSS aurora that always sits underneath.
import { state, on } from './state.js';
import * as api from './api.js';

let el, canvas, THREE, R = null, mounted = null, io = null, raf = 0, loading = null, posters = [], texKey = '', failed = false;
let tx = 0, ty = 0, cx = 0, cy = 0, scrollY = 0, t0 = 0;
const tiles = [];

export function weakDevice() {
  return (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || (navigator.deviceMemory && navigator.deviceMemory <= 2);
}
function allowed() { return !state.reduced && !state.lowPower && !weakDevice() && !failed; }
function webglOk() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}
function setFlag(v) { document.documentElement.dataset.hero = v; }

export function init() {
  el = document.getElementById('hero'); canvas = document.getElementById('hero-canvas');
  setFlag('css');
  addEventListener('pointermove', e => { tx = (e.clientX / innerWidth - 0.5) * 2; ty = (e.clientY / innerHeight - 0.5) * 2; }, { passive: true });
  addEventListener('scroll', () => { scrollY = scrollY * 0 + window.scrollY; }, { passive: true });
  document.addEventListener('visibilitychange', apply);
  document.addEventListener('cv:motion', apply);
  on('lowpower', apply);
  io = new IntersectionObserver(es => { for (const e of es) visible = e.isIntersecting; apply(); }, { threshold: 0.01 });
  io.observe(el);
}
let visible = true;

export function mount(container) {
  mounted = container;
  if (container) { container.prepend(el); el.hidden = false; } else el.hidden = true;
  apply();
}
export function setPosters(urls) {
  posters = urls.slice(0, 10);
  if (R) loadTextures();
}

async function load() {
  if (R || failed) return;
  if (!loading) {
    loading = (async () => {
      if (!webglOk()) throw new Error('no webgl');
      THREE = await import('/vendor/three.module.min.js');
      build();
    })().catch(() => { failed = true; setFlag('css'); });
  }
  await loading;
}

function apply() {
  const run = mounted && allowed() && visible && !document.hidden;
  if (!mounted || !allowed()) { stop(); setFlag('css'); canvas.hidden = true; return; }
  if (!R) {
    // lazy: only fetch three.js once the hero is actually wanted, after first paint
    (window.requestIdleCallback || (f => setTimeout(f, 300)))(() => { load().then(() => { if (R) { canvas.hidden = false; setFlag('webgl'); apply(); } }); });
    return;
  }
  canvas.hidden = false; setFlag('webgl');
  if (run) start(); else stop();
}

function roundedAlpha(THREE) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 112;
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 64, 112); g.fillStyle = '#fff';
  g.beginPath(); g.roundRect(1, 1, 62, 110, 9); g.fill();
  return new THREE.CanvasTexture(c);
}
function genTile(i) {
  const c = document.createElement('canvas'); c.width = 180; c.height = 320; const g = c.getContext('2d');
  const h1 = (i * 47 + 250) % 360, h2 = (h1 + 70) % 360;
  const gr = g.createLinearGradient(0, 0, 180, 320); gr.addColorStop(0, `hsl(${h1} 85% 58%)`); gr.addColorStop(1, `hsl(${h2} 90% 42%)`);
  g.fillStyle = gr; g.fillRect(0, 0, 180, 320);
  g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.arc(150, 60, 70, 0, 7); g.fill();
  g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, 230, 180, 90);
  g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.moveTo(72, 120); g.lineTo(72, 200); g.lineTo(122, 160); g.fill();
  return c;
}
function build() {
  const T = THREE;
  R = new T.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
  R.setClearColor(0x000000, 0);
  R.outputColorSpace = T.SRGBColorSpace;
  const scene = new T.Scene(), cam = new T.PerspectiveCamera(38, 1, 0.1, 60);
  cam.position.set(0, 0.4, 11.5);
  const geo = new T.PlaneGeometry(1.5, 2.667), alpha = roundedAlpha(T);
  const rings = [{ n: 16, r: 7.4, y: 1.55, dir: 1, s: 1 }, { n: 16, r: 7.4, y: -1.55, dir: -1, s: 1 }];
  const group = new T.Group(); scene.add(group); group.rotation.x = 0.08;
  rings.forEach((ring, ri) => {
    const g = new T.Group(); g.position.y = ring.y; group.add(g);
    for (let i = 0; i < ring.n; i++) {
      const m = new T.Mesh(geo, new T.MeshBasicMaterial({ alphaMap: alpha, transparent: true, color: 0xffffff }));
      const a = (i / ring.n) * Math.PI * 2;
      m.position.set(Math.sin(a) * ring.r, 0, Math.cos(a) * ring.r); m.rotation.y = a;
      g.add(m); tiles.push({ m, a, ring: g, dir: ring.dir, idx: ri * ring.n + i });
    }
    ring.g = g;
  });
  R._s = { scene, cam, group, rings };
  loadTextures();
  const resize = () => {
    const w = el.clientWidth || 1, hh = el.clientHeight || 1, dpr = Math.min(devicePixelRatio || 1, 2);
    R.setPixelRatio(dpr); R.setSize(w, hh, false); cam.aspect = w / hh;
    cam.fov = w < 640 ? 52 : 38; cam.position.z = w < 640 ? 14.5 : 13.5; cam.updateProjectionMatrix();
    group.position.x = w >= 900 ? Math.tan(cam.fov * Math.PI / 360) * cam.position.z * (w / hh) * 0.44 : 0; // wide hero: the ring sits right of the headline instead of floating in the middle
  };
  new ResizeObserver(resize).observe(el); resize();
}
function loadTextures() {
  const T = THREE, key = posters.join('|');
  if (key === texKey) return; texKey = key;
  const apply1 = (t, cv) => { const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; if (t.m.material.map) t.m.material.map.dispose(); t.m.material.map = tex; t.m.material.needsUpdate = true; };
  tiles.forEach(t => apply1(t, genTile(t.idx)));
  posters.forEach((u, i) => {
    const img = new Image(); img.decoding = 'async';
    api.fetchMedia(u).then(m => { img.src = m.url; }).catch(() => {});
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = 180; c.height = 320; c.getContext('2d').drawImage(img, 0, 0, 180, 320);
      if (texKey !== key) return;
      tiles.forEach(t => { if (t.idx % posters.length === i) apply1(t, c); });
    };
  });
}
function start() { if (raf) return; t0 = null; raf = requestAnimationFrame(frame); }
function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
function frame(now) {
  raf = requestAnimationFrame(frame);
  if (t0 == null) t0 = now;
  const { scene, cam, group, rings } = R._s, t = (now - t0) / 1000;
  cx += (tx - cx) * 0.06; cy += (ty - cy) * 0.06;
  const sc = Math.min(scrollY, 600) / 600;
  for (const r of rings) r.g.rotation.y = r.dir * (t * 0.12 + sc * 1.2) + cx * 0.35 * r.dir;
  group.rotation.x = 0.08 + cy * 0.1; cam.position.y = 0.4 - cy * 0.5 - sc * 1.2; cam.lookAt(0, 0, 0);
  for (const tl of tiles) { // fake lighting: tiles facing the camera are bright, the sides fall off
    const ang = tl.a + tl.ring.rotation.y, f = Math.cos(ang); const v = 0.25 + 0.75 * Math.max(0, f);
    tl.m.material.color.setScalar(v);
  }
  R.render(scene, cam);
}
