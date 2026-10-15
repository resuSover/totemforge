// © 2026 Totem Forge. All rights reserved.
// Renders a portrait for the 88 x 184 e-ink screen:
// master → rotate → crop + fill → brightness → 4 inks (CIE Lab, weakened dither in steps) → crisp text bar.
// A portrait: { img (master), rot, crop: {zoom, x, y}, fill: 'colour'|'extend', adjust: {brightness, dither}, overlay }

export const W = 88, H = 184;
// Ink index order: black, white, yellow, red
export const INK = { black: 0, white: 1, yellow: 2, red: 3 };
export const INK_NAMES = ['black', 'white', 'yellow', 'red'];
const TARGET = [[0, 0, 0], [255, 255, 255], [242, 197, 0], [200, 16, 46]];   // conversion targets
export const SHOW = [[0, 0, 0], [243, 243, 243], [253, 206, 104], [183, 7, 7]]; // measured look of the real screen

function toLab(r, g, b) {
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const TARGET_LAB = TARGET.map(c => toLab(...c));
function nearest(r, g, b) {
  const [L, A, B] = toLab(r, g, b);
  let best = 0, bd = Infinity;
  for (let k = 0; k < 4; k++) {
    const p = TARGET_LAB[k], d = (L - p[0]) ** 2 + (A - p[1]) ** 2 + (B - p[2]) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}
// Dither steps: the share of each pixel's colour error passed on to its neighbours (strength), once
// the error is at least threshold; strength 0 is no dither. A portrait keeps its own numbers
// (adjust.dither), so retuning a step later doesn't change it.
export const DITHER = {
  none: { strength: 0, threshold: 24 },
  mild: { strength: 0.15, threshold: 24 },
  normal: { strength: 0.28, threshold: 24 },
  strong: { strength: 0.5, threshold: 24 },
};
// The step a portrait's dither matches (any strength 0 is None), or null for numbers that match none
export function ditherStep(d) {
  if (!(d?.strength > 0)) return 'none';
  return Object.keys(DITHER).find(k => DITHER[k].strength === d.strength && DITHER[k].threshold === d.threshold) || null;
}
// Weakened Floyd–Steinberg: part of the error, small errors not spread, values clamped
function quantize(rgb, d) {
  const dither = d?.strength > 0 ? d : null;
  const idx = new Uint8Array(W * H), clamp = v => Math.max(0, Math.min(255, v));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, j = p * 3;
    const r = clamp(rgb[j]), g = clamp(rgb[j + 1]), b = clamp(rgb[j + 2]);
    const k = nearest(r, g, b); idx[p] = k;
    if (!dither) continue;
    let er = r - TARGET[k][0], eg = g - TARGET[k][1], eb = b - TARGET[k][2];
    if (Math.max(Math.abs(er), Math.abs(eg), Math.abs(eb)) < dither.threshold) continue;
    er *= dither.strength; eg *= dither.strength; eb *= dither.strength;
    const spread = (dx, dy, f) => {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= W || yy >= H) return;
      const q = (yy * W + xx) * 3; rgb[q] += er * f; rgb[q + 1] += eg * f; rgb[q + 2] += eb * f;
    };
    spread(1, 0, 7 / 16); spread(-1, 1, 3 / 16); spread(0, 1, 5 / 16); spread(1, 1, 1 / 16);
  }
  return idx;
}

const work = document.createElement('canvas'); work.width = W; work.height = H;
const wctx = work.getContext('2d', { willReadFrequently: true });
const rotated = new WeakMap();
function source(p) {                         // the master, turned by p.rot degrees
  if (!p.rot) return p.img;
  let byRot = rotated.get(p.img);
  if (!byRot) { byRot = {}; rotated.set(p.img, byRot); }
  if (!byRot[p.rot]) {
    const c = document.createElement('canvas'), side = p.rot % 180 !== 0;
    c.width = side ? p.img.height : p.img.width; c.height = side ? p.img.width : p.img.height;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2); ctx.rotate(p.rot * Math.PI / 180);
    ctx.drawImage(p.img, -p.img.width / 2, -p.img.height / 2);
    byRot[p.rot] = c;
  }
  return byRot[p.rot];
}
export const wrapLines = text => text.trim().split('\n').flatMap(s => s.length <= 12 ? [s] : s.match(/.{1,12}/g)).slice(0, 3);

function placement(p) {                      // where the picture lands; push moves it away from the bar
  const img = source(p), s = Math.max(W / img.width, H / img.height) * p.crop.zoom;
  const dw = img.width * s, dh = img.height * s;
  let x = (W - dw) / 2 + p.crop.x, y = (H - dh) / 2 + p.crop.y;
  if (p.overlay && p.overlay.text.trim() && p.overlay.push) {
    y += (p.overlay.position === 'bottom' ? -1 : 1) * 30 * wrapLines(p.overlay.text).length * p.overlay.push / 100;
  }
  return { img, x, y, w: dw, h: dh };
}

/** Returns { idx: ink index per pixel, gap: whether the crop leaves an area to fill }. */
export function render(p) {
  const r = placement(p);
  wctx.imageSmoothingEnabled = true; wctx.imageSmoothingQuality = 'high';
  wctx.clearRect(0, 0, W, H);
  wctx.drawImage(r.img, r.x, r.y, r.w, r.h);
  const data = wctx.getImageData(0, 0, W, H).data;
  const x0 = Math.max(0, Math.ceil(r.x)), y0 = Math.max(0, Math.ceil(r.y));
  const x1 = Math.min(W - 1, Math.floor(r.x + r.w) - 1), y1 = Math.min(H - 1, Math.floor(r.y + r.h) - 1);
  const gap = x0 > 0 || y0 > 0 || x1 < W - 1 || y1 < H - 1;
  const edge = gap && p.fill === 'colour' ? edgeColours(data, x0, y0, x1, y1) : null;
  const rgb = new Float32Array(W * H * 3), b = p.adjust.brightness * 1.6;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sx = x, sy = y, col = null;
    if (x < x0 || x > x1 || y < y0 || y > y1) {
      if (edge) col = y < y0 ? edge.top : y > y1 ? edge.bottom : x < x0 ? edge.left : edge.right;
      else { sx = Math.min(x1, Math.max(x0, x)); sy = Math.min(y1, Math.max(y0, y)); }
    }
    const j = (y * W + x) * 3, k = (sy * W + sx) * 4;
    rgb[j] = (col ? col[0] : data[k]) + b; rgb[j + 1] = (col ? col[1] : data[k + 1]) + b; rgb[j + 2] = (col ? col[2] : data[k + 2]) + b;
  }
  const idx = quantize(rgb, p.adjust.dither);
  drawText(idx, p.overlay);
  return { idx, gap };
}

function edgeColours(d, x0, y0, x1, y1) {    // most common colour of each edge row/column
  const common = pts => {
    const bins = new Map();
    for (const [x, y] of pts) {
      const k = (y * W + x) * 4, key = (d[k] >> 5) << 6 | (d[k + 1] >> 5) << 3 | (d[k + 2] >> 5);
      const e = bins.get(key) || [0, 0, 0, 0]; e[0] += d[k]; e[1] += d[k + 1]; e[2] += d[k + 2]; e[3]++; bins.set(key, e);
    }
    let best = null;
    for (const e of bins.values()) if (!best || e[3] > best[3]) best = e;
    return best ? [best[0] / best[3], best[1] / best[3], best[2] / best[3]] : [255, 255, 255];
  };
  const row = y => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y]);
  const col = x => Array.from({ length: y1 - y0 + 1 }, (_, i) => [x, y0 + i]);
  return { top: common(row(y0)), bottom: common(row(y1)), left: common(col(x0)), right: common(col(x1)) };
}

// Text bar drawn after the ink reduction, without anti-aliasing, so it stays crisp on e-ink
const tcan = document.createElement('canvas'); tcan.width = W; tcan.height = H;
const tctx = tcan.getContext('2d', { willReadFrequently: true });
function drawText(idx, ov) {
  if (!ov || !ov.text.trim()) return;
  const lines = wrapLines(ov.text), barH = 30, total = barH * lines.length;
  const top = ov.position === 'top' ? 0 : H - total;
  for (let y = top; y < top + total; y++) for (let x = 0; x < W; x++) idx[y * W + x] = INK[ov.bar];
  tctx.clearRect(0, 0, W, H);
  let size = 18;
  const font = () => `700 ${size}px "Alegreya Sans", system-ui, sans-serif`;
  tctx.font = font();
  while (lines.some(l => tctx.measureText(l).width > W - 10) && size > 8) { size--; tctx.font = font(); }
  tctx.fillStyle = '#000'; tctx.textAlign = 'center'; tctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    let cy = top + i * barH + barH / 2;
    if (ov.position === 'top' && i === 0) cy += 5;
    if (ov.position === 'bottom' && i === lines.length - 1) cy -= 5;
    tctx.fillText(l, W / 2, cy);
  });
  const a = tctx.getImageData(0, 0, W, H).data;
  for (let p = 0; p < W * H; p++) if (a[p * 4 + 3] > 110) idx[p] = INK[ov.textColour];
}

/** Draws an ink index image in the screen's display colours. */
export function paint(canvas, idx) {
  const ctx = canvas.getContext('2d'), img = ctx.createImageData(W, H);
  for (let p = 0; p < W * H; p++) { const c = SHOW[idx[p]]; img.data.set([c[0], c[1], c[2], 255], p * 4); }
  ctx.putImageData(img, 0, 0);
}
