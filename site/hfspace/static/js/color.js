// Accent colour from a poster: sample a tiny canvas (same-origin only), weight vivid pixels, lift to a glow-friendly tone.
const byClip = new Map();
let cv, cx;
export const accentFor = id => byClip.get(id) || null;
export function accentFromImage(img, id) {
  try {
    if (!cv) { cv = document.createElement('canvas'); cv.width = 24; cv.height = 42; cx = cv.getContext('2d', { willReadFrequently: true }); }
    cx.drawImage(img, 0, 0, 24, 42);
    const d = cx.getImageData(0, 0, 24, 42).data;
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2], mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      const s = mx ? (mx - mn) / mx : 0, wt = s * s * (0.25 + mx / 255) + 0.02;
      r += R * wt; g += G * wt; b += B * wt; w += wt;
    }
    if (!w) return null;
    const rgb = lift(r / w, g / w, b / w);
    if (id) byClip.set(id, rgb);
    return rgb;
  } catch { return null; }
}
function lift(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let hh = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const dd = mx - mn; s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
    hh = mx === r ? (g - b) / dd + (g < b ? 6 : 0) : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4; hh /= 6;
  }
  s = Math.min(1, Math.max(s, 0.55)); const L = Math.min(0.64, Math.max(l, 0.5));
  const q = L < 0.5 ? L * (1 + s) : L + s - L * s, p = 2 * L - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [Math.round(f(hh + 1 / 3) * 255), Math.round(f(hh) * 255), Math.round(f(hh - 1 / 3) * 255)];
}
export const rgbVar = a => a.join(' ');
export function hueFor(str) { let x = 7; for (const ch of String(str)) x = (x * 31 + ch.charCodeAt(0)) % 360; return x; }
// Aurora accents: the page-wide aurora (and the post-mode glow) follow the current clip's colour. The three channels are registered numbers in CSS so they animate.
export function setAurora(rgb) {
  const s = document.documentElement.style;
  if (!rgb) { s.removeProperty('--hr'); s.removeProperty('--hg'); s.removeProperty('--hb'); return; }
  s.setProperty('--hr', String(rgb[0])); s.setProperty('--hg', String(rgb[1])); s.setProperty('--hb', String(rgb[2]));
}
