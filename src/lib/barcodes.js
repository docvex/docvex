// BARCODES AND QR CODES in a picture — read locally, nothing sent anywhere.
// ZXing's pure-JavaScript decoder (`@zxing/library`, lazy-imported: paid only
// when Barcode is pressed). It finds ONE code per pass, so every code found is
// blanked out and the picture read again, until nothing more is found (at most
// MAX_CODES) — a trade-register extract carries a Code 128, a receipt a QR
// code, an invoice both.
//
//   decodeLuminance(lum, w, h, { only }) → [{ format, text, box, shape, unread? }]   (pure: testable in Node)
//   readBarcodes(img, { only })          → the same, from an <img> / canvas on screen
//   describeQr(text)                     → what a QR code's text IS (a link, a Wi-Fi
//                                          network, a contact, a payment…)
//
// `only: 'qr'` (the QR code quick action) reads QR codes alone, and also reads
// the picture INVERTED — a light code on a dark ground, which a plain pass
// misses — since it is not also hunting for every 1-D format.
//
// `box` is the code's place, normalised 0…1 on the picture ({ x, y, w, h }).
// `shape` is the code's own four corners as it sits in the picture
// [[x, y], …], normalised the same way — exact, from what ZXing measured, so a
// code photographed tilted or at an angle is covered along its own edges (null
// when it cannot be worked out; `box` then stands in). See codeShape.

const MAX_EDGE = 2000;
const MAX_CODES = 8;

let zx = null;
const load = () => (zx ||= import('@zxing/library').catch((e) => { zx = null; throw e; }));

const FORMAT_NAMES = {
  QR_CODE: 'QR code', DATA_MATRIX: 'Data Matrix', AZTEC: 'Aztec', PDF_417: 'PDF417',
  CODE_128: 'Code 128', CODE_39: 'Code 39', CODE_93: 'Code 93', CODABAR: 'Codabar', ITF: 'ITF',
  EAN_13: 'EAN-13', EAN_8: 'EAN-8', UPC_A: 'UPC-A', UPC_E: 'UPC-E', RSS_14: 'GS1 DataBar', RSS_EXPANDED: 'GS1 DataBar Expanded',
};

// ── WHERE THE CODE IS, EXACTLY ────────────────────────────────────────────
// `shape` is the code's own four corners in the picture, from what ZXing
// measured — not a box around it:
//   - a QR code: the three corner markers' centres (and, on version 2 and up,
//     the alignment marker) sit at known places on the code's grid — 3.5
//     modules in from its corners, the alignment marker 6.5 in from the last
//     one. The grid's size is worked out as ZXing's own Detector does
//     (computeDimension), a perspective transform is solved from those points,
//     and the grid's outer corners are mapped through it: tilt, rotation and
//     perspective included.
//   - a 1-D barcode: ZXing hands back two points on the one row it read — the
//     middles of the start and stop patterns. The row is walked outward to the
//     first and last bar (a light run longer than the gaps between bars is the
//     quiet zone), then the same stretch is compared row by row up and down the
//     code's own normal while the bars still line up: the bars' top and bottom.
//   - anything else (Data Matrix, Aztec, PDF417): the convex hull of its points.

// Solve the homography mapping 4 source points onto 4 destination points.
function homography(src, dst) {
  const A = []; const bb = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]; const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); bb.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); bb.push(v);
  }
  // Gaussian elimination with partial pivoting.
  const n = 8;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]]; [bb[c], bb[piv]] = [bb[piv], bb[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      bb[r] -= f * bb[c];
    }
  }
  const hcoef = bb.map((val, i) => val / A[i][i]);
  return ([x, y]) => {
    const d = hcoef[6] * x + hcoef[7] * y + 1;
    return [(hcoef[0] * x + hcoef[1] * y + hcoef[2]) / d, (hcoef[3] * x + hcoef[4] * y + hcoef[5]) / d];
  };
}

function qrShape(points) {
  if (points.length < 3) return null;
  const [bl, tl, tr] = points;
  const al = points[3] || null;
  const P = (p) => [p.getX(), p.getY()];
  const dist = (a, c) => Math.hypot(a[0] - c[0], a[1] - c[1]);
  const TL = P(tl); const TR = P(tr); const BL = P(bl);
  // The grid's size in modules (4v + 17). The ALIGNMENT MARKER fixes it: it
  // sits 6.5 modules in from the last corner, i.e. at a fraction
  // (d − 10) / (d − 7) of the way along both sides measured from the top-left
  // marker — a ratio rotation does not change (the markers' own module-size
  // estimate does: it reads ~10% large on a tilted code, which picked the
  // wrong version). A code with no alignment marker is version 1 (21) unless
  // the estimate clearly says otherwise (ZXing missed the marker).
  const snap = (x) => Math.max(21, 17 + 4 * Math.round((x - 17) / 4));
  let d;
  if (al) {
    const A = P(al);
    const ex = [TR[0] - TL[0], TR[1] - TL[1]]; const ey = [BL[0] - TL[0], BL[1] - TL[1]];
    const det = ex[0] * ey[1] - ex[1] * ey[0];
    if (!det) return null;
    const rx = A[0] - TL[0]; const ry = A[1] - TL[1];
    const a = (rx * ey[1] - ry * ey[0]) / det; const b = (ex[0] * ry - ex[1] * rx) / det;
    const r = (a + b) / 2;
    if (!(r > 0.3 && r < 0.99)) return null;
    d = snap((10 - 7 * r) / (1 - r));
  } else {
    const sizes = [bl, tl, tr].map((q) => (typeof q.getEstimatedModuleSize === 'function' ? q.getEstimatedModuleSize() : 0)).filter((q) => q > 0);
    const m = sizes.length ? sizes.reduce((x, y) => x + y, 0) / sizes.length : 0;
    const est = m ? (dist(TL, TR) + dist(TL, BL)) / 2 / m + 7 : 21;
    d = est < 27 ? 21 : snap(est);
  }
  const src = [[3.5, 3.5], [d - 3.5, 3.5], [3.5, d - 3.5]];
  const dst = [TL, TR, BL];
  if (al) { src.push([d - 6.5, d - 6.5]); dst.push(P(al)); }
  else { src.push([d - 3.5, d - 3.5]); dst.push([TR[0] + BL[0] - TL[0], TR[1] + BL[1] - TL[1]]); }
  const H = homography(src, dst);
  if (!H) return null;
  return [[0, 0], [d, 0], [d, d], [0, d]].map(H);
}

function hull(pts) {
  const s2 = pts.slice().sort((a, c) => a[0] - c[0] || a[1] - c[1]);
  const cross = (o, a, c) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lower = []; const upper = [];
  for (const q of s2) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = s2.length - 1; i >= 0; i--) { const q = s2[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function barcodeShape(lum, w, h, p0, p1) {
  const L0 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (L0 < 8) return null;
  const ux = (p1[0] - p0[0]) / L0; const uy = (p1[1] - p0[1]) / L0;   // the row ZXing read
  const nx = -uy; const ny = ux;                                         // across that row
  const at = (x, y) => {
    const xi = Math.round(x); const yi = Math.round(y);
    return xi < 0 || yi < 0 || xi >= w || yi >= h ? 255 : lum[yi * w + xi];
  };
  // The row's own threshold: halfway between its darkest and lightest.
  let lo = 255; let hi = 0;
  for (let t = 0; t <= L0; t += 0.5) { const v = at(p0[0] + ux * t, p0[1] + uy * t); if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 40) return null;
  const thr = (lo + hi) / 2;
  const isDark = (x, y) => at(x, y) <= thr;
  // 1. Out along the row to the last bar on each side: a light run longer than
  //    any gap between bars (a fourteenth of the code) is the quiet zone.
  const gap = Math.max(4, L0 / 14);
  const edge = (sx, sy, dx, dy) => {
    let lastDark = 0; let light = 0;
    for (let t = 0; t < L0; t += 0.5) {
      if (isDark(sx + dx * t, sy + dy * t)) { lastDark = t; light = 0; }
      else if ((light += 0.5) > gap) break;
    }
    return lastDark;
  };
  const ta = edge(p0[0], p0[1], -ux, -uy);
  const tb = edge(p1[0], p1[1], ux, uy);
  const Lp = [p0[0] - ux * (ta + 0.5), p0[1] - uy * (ta + 0.5)];
  const Rp = [p1[0] + ux * (tb + 0.5), p1[1] + uy * (tb + 0.5)];
  const len = Math.hypot(Rp[0] - Lp[0], Rp[1] - Lp[1]);
  const N = Math.max(60, Math.min(800, Math.round(len * 1.5)));
  // A row of N samples from (x, y) along (dx, dy) for `span` pixels.
  const line = (x, y, dx, dy, span) => {
    const row = new Uint8Array(N);
    for (let i = 0; i < N; i++) { const t = (i / (N - 1)) * span; row[i] = isDark(x + dx * t, y + dy * t) ? 1 : 0; }
    return row;
  };
  const match = (r, q) => { let k = 0; for (let i = 0; i < N; i++) if (r[i] === q[i]) k++; return k / N; };
  // 2. The bars' SLANT. ZXing reads a tilted barcode along a plain row, which
  //    crosses the bars at an angle: a row k px off it repeats the same bars
  //    shifted by k·σ along it. σ is found by sliding nearby rows until their
  //    bars line up with the read row, and fitted across several distances.
  const base = line(Lp[0], Lp[1], ux, uy, len);
  const step = len / (N - 1);
  let sk = 0; let kk = 0;
  for (const f of [0.04, 0.07, 0.1, -0.04, -0.07, -0.1]) {
    const k = f * len;
    let best = -1; let bestS = 0;
    const lim = Math.abs(k) * 0.8;   // up to ~39°
    for (let sh = -lim; sh <= lim; sh += step) {
      const r = line(Lp[0] + nx * k + ux * sh, Lp[1] + ny * k + uy * sh, ux, uy, len);
      const m = match(r, base);
      if (m > best) { best = m; bestS = sh; }
    }
    if (best >= 0.75) { sk += bestS * k; kk += k * k; }
  }
  const sigma = kk ? sk / kk : 0;
  // The bars run along b = n + σ·u; the code's axis runs across them, a ⟂ b.
  const bl = Math.hypot(1, sigma);
  const bx = (nx + sigma * ux) / bl; const by = (ny + sigma * uy) / bl;
  const ax = (ux - sigma * nx) / bl; const ay = (uy - sigma * ny) / bl;
  // 3. The code's width along its axis, from the row's two ends, about the
  //    middle; then its height along the bars, while a line across the code
  //    still repeats the middle one (one or two bad lines forgiven — a scratch).
  const M = [(Lp[0] + Rp[0]) / 2, (Lp[1] + Rp[1]) / 2];
  const aL = (Lp[0] - M[0]) * ax + (Lp[1] - M[1]) * ay;
  const aR = (Rp[0] - M[0]) * ax + (Rp[1] - M[1]) * ay;
  const span = aR - aL;
  const across = (k) => line(M[0] + bx * k + ax * aL, M[1] + by * k + ay * aL, ax, ay, span);
  const mid = across(0);
  const reach = (dir) => {
    let last = 0; let misses = 0;
    for (let k = 1; k < span * 1.5; k++) {
      if (match(across(dir * k), mid) >= 0.8) { last = k; misses = 0; }
      else if (++misses > 2) break;
    }
    return last + 0.5;
  };
  const up = reach(-1); const down = reach(1);
  const P = (t, k) => [M[0] + ax * t + bx * k, M[1] + ay * t + by * k];
  return [P(aL, -up), P(aR, -up), P(aR, down), P(aL, down)];
}

const ONE_D = ['CODE_128', 'CODE_39', 'CODE_93', 'CODABAR', 'ITF', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'RSS_14', 'RSS_EXPANDED'];
function codeShape(lum, w, h, res, format) {
  const raw = res.getResultPoints() || [];
  const pts = raw.map((p) => [p.getX(), p.getY()]);
  let quad = null;
  if (format === 'QR_CODE') quad = qrShape(raw);
  else if (ONE_D.includes(format) && pts.length >= 2) {
    // The two points furthest apart are the row's two ends.
    let i0 = 0; let i1 = 1; let best = -1;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const dd = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      if (dd > best) { best = dd; i0 = i; i1 = j; }
    }
    quad = barcodeShape(lum, w, h, pts[i0], pts[i1]);
  } else if (pts.length >= 3) quad = hull(pts);
  if (!quad || quad.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
  return quad;
}

// ── READING EVERY CODE ────────────────────────────────────────────────────
// One pass of ZXing misses codes a phone camera reads without trouble, so the
// picture is read in several PASSES, each finding every code it can (a code
// found is blanked out and the picture read again), the codes of earlier
// passes blanked before the next starts:
//   1. as it is, ZXing's local threshold (HybridBinarizer) — most codes;
//   2. as it is, ZXing's global threshold (GlobalHistogramBinarizer) — a code
//      in even light that the local one breaks up;
//   3. contrast-stretched (the 1st / 99th percentiles to black / white) — a
//      faded print, a photo in poor light;
//   4. at half size — a code too large or too soft for the finder at full size;
//   5. inverted, QR codes only — a light code on a dark ground.
// Then the codes that are THERE but would not decode: ZXing's QR locator
// (Detector) is run on what is left; where it finds a code, that patch alone
// is cut out, enlarged and contrast-stretched and read again, and if it still
// will not decode it is reported anyway — `{ unread: true }`, its outline in
// `shape`. (The Doc Viewer drops those and shows only the codes it read; the
// patch re-read is what helps it — a code that reads there is a normal one.)

const MAX_UNREAD = 4;

function invertLum(lum) {
  const o = new Uint8ClampedArray(lum.length);
  for (let i = 0; i < lum.length; i++) o[i] = 255 - lum[i];
  return o;
}
function stretchLum(lum) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < lum.length; i++) hist[lum[i]]++;
  const cut = lum.length * 0.01;
  let lo = 0; let acc = 0; while (lo < 255 && (acc += hist[lo]) < cut) lo++;
  let hi = 255; acc = 0; while (hi > 0 && (acc += hist[hi]) < cut) hi--;
  if (hi - lo < 8) return null;
  const k = 255 / (hi - lo);
  const o = new Uint8ClampedArray(lum.length);
  for (let i = 0; i < lum.length; i++) o[i] = (lum[i] - lo) * k;
  return o;
}
function halfLum(lum, w, h) {
  const w2 = w >> 1; const h2 = h >> 1;
  if (w2 < 40 || h2 < 40) return null;
  const o = new Uint8ClampedArray(w2 * h2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const i = 2 * y * w + 2 * x;
    o[y * w2 + x] = (lum[i] + lum[i + 1] + lum[i + w] + lum[i + w + 1]) >> 2;
  }
  return { lum: o, w: w2, h: h2 };
}
// A patch of the picture (pixel rect), enlarged ×k (bilinear) and stretched.
function cropLum(lum, w, h, x0, y0, x1, y1, k) {
  const cw = Math.max(1, Math.round((x1 - x0) * k)); const ch = Math.max(1, Math.round((y1 - y0) * k));
  const o = new Uint8ClampedArray(cw * ch);
  for (let y = 0; y < ch; y++) {
    const sy = Math.min(h - 1.001, Math.max(0, y0 + y / k)); const iy = sy | 0; const fy = sy - iy;
    for (let x = 0; x < cw; x++) {
      const sx = Math.min(w - 1.001, Math.max(0, x0 + x / k)); const ix = sx | 0; const fx = sx - ix;
      const i = iy * w + ix;
      o[y * cw + x] = (lum[i] * (1 - fx) + lum[i + 1] * fx) * (1 - fy) + (lum[i + w] * (1 - fx) + lum[i + w + 1] * fx) * fy;
    }
  }
  return { lum: stretchLum(o) || o, w: cw, h: ch };
}

// White out every code already found (their boxes, normalised) on `work`.
function blankFound(work, w, h, found) {
  for (const c of found) {
    const x0 = Math.max(0, Math.floor(c.box.x * w) - 1); const x1 = Math.min(w, Math.ceil((c.box.x + c.box.w) * w) + 1);
    const y0 = Math.max(0, Math.floor(c.box.y * h) - 1); const y1 = Math.min(h, Math.ceil((c.box.y + c.box.h) * h) + 1);
    for (let y = y0; y < y1; y++) work.fill(255, y * w + x0, y * w + x1);
  }
}

// The upright box of a set of points, with a margin, clamped to the picture.
function boxOf(pts, w, h, pad) {
  const xs = pts.map((q) => q[0]); const ys = pts.map((q) => q[1]);
  return {
    x0: Math.max(0, Math.floor(Math.min(...xs) - pad)), x1: Math.min(w, Math.ceil(Math.max(...xs) + pad)),
    y0: Math.max(0, Math.floor(Math.min(...ys) - pad)), y1: Math.min(h, Math.ceil(Math.max(...ys) + pad)),
  };
}

// One pass: every code ZXing finds in `src` (w × h) with this binarizer.
// Results are normalised, so passes at other sizes merge directly.
function readPass(Z, src, w, h, { binarizer = 'hybrid', formats = null, found = [] } = {}) {
  const hints = new Map();
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  if (formats) hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, formats.map((f) => Z.BarcodeFormat[f]));
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const work = new Uint8ClampedArray(src);
  blankFound(work, w, h, found);
  const out = [];
  for (let n = 0; n < MAX_CODES; n++) {
    let res = null;
    try {
      const source = new Z.RGBLuminanceSource(work, w, h);
      const bin = binarizer === 'global' ? new Z.GlobalHistogramBinarizer(source) : new Z.HybridBinarizer(source);
      res = reader.decodeWithState(new Z.BinaryBitmap(bin));
    } catch { res = null; }
    reader.reset();
    if (!res) break;
    const fmtId = Z.BarcodeFormat[res.getBarcodeFormat()];
    let quad = null;
    try { quad = codeShape(work, w, h, res, fmtId); } catch { quad = null; }
    const pts = quad || (res.getResultPoints() || []).map((q) => [q.getX(), q.getY()]);
    let bx;
    if (quad) bx = boxOf(pts, w, h, 2);
    else {
      // Without the exact shape a 1-D code's points lie on one line across it:
      // its height is not in them, so the box is grown to a band round it.
      const b0 = boxOf(pts, w, h, 0);
      const wide = b0.x1 - b0.x0; const tall = b0.y1 - b0.y0;
      const padX = Math.max(8, wide * 0.08); const padY = Math.max(8, tall * 0.12, wide * (tall < wide * 0.2 ? 0.25 : 0));
      bx = {
        x0: Math.max(0, Math.floor(b0.x0 - padX)), x1: Math.min(w, Math.ceil(b0.x1 + padX)),
        y0: Math.max(0, Math.floor(b0.y0 - padY)), y1: Math.min(h, Math.ceil(b0.y1 + padY)),
      };
    }
    const text = res.getText();
    const format = FORMAT_NAMES[fmtId] || String(fmtId);
    if (!out.some((c) => c.text === text && c.format === format)) {
      out.push({
        format, text,
        box: { x: bx.x0 / w, y: bx.y0 / h, w: (bx.x1 - bx.x0) / w, h: (bx.y1 - bx.y0) / h },
        shape: quad ? quad.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]) : null,
      });
    }
    for (let y = bx.y0; y < bx.y1; y++) work.fill(255, y * w + bx.x0, y * w + bx.x1);
  }
  return out;
}

/** Every code in a grey picture (`lum`: one byte per pixel, w × h). */
export async function decodeLuminance(lum, w, h, { only = null } = {}) {
  const Z = await load();
  const formats = only === 'qr' ? ['QR_CODE'] : null;
  const found = [];
  const add = (list) => {
    for (const c of list) if (!found.some((f) => f.text === c.text && f.format === c.format)) found.push(c);
  };
  add(readPass(Z, lum, w, h, { formats, found }));
  add(readPass(Z, lum, w, h, { binarizer: 'global', formats, found }));
  const stretched = stretchLum(lum);
  if (stretched) add(readPass(Z, stretched, w, h, { formats, found }));
  const half = halfLum(lum, w, h);
  if (half) add(readPass(Z, half.lum, half.w, half.h, { formats, found }));
  add(readPass(Z, invertLum(lum), w, h, { formats: ['QR_CODE'], found }));
  // QR codes that are there but did not decode.
  try { add(await unreadQrCodes(Z, lum, w, h, found)); } catch { /* the locator is optional */ }
  return found;
}

let qrParts = null;
const loadQrParts = () => (qrParts ||= Promise.all([
  import('@zxing/library/esm/core/qrcode/detector/Detector'),
]).then(([d]) => ({ Detector: d.default })).catch((e) => { qrParts = null; throw e; }));

async function unreadQrCodes(Z, lum, w, h, found) {
  const { Detector } = await loadQrParts();
  const out = [];
  const work = new Uint8ClampedArray(lum);
  blankFound(work, w, h, found);
  const hints = new Map(); hints.set(Z.DecodeHintType.TRY_HARDER, true);
  for (let n = 0; n < MAX_UNREAD; n++) {
    let det = null;
    try {
      const matrix = new Z.HybridBinarizer(new Z.RGBLuminanceSource(work, w, h)).getBlackMatrix();
      det = new Detector(matrix).detect(hints);
    } catch { det = null; }
    if (!det) break;
    const quad = qrShape(det.getPoints());
    if (!quad || quad.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) break;
    const bx = boxOf(quad, w, h, 2);
    const bw = bx.x1 - bx.x0; const bh = bx.y1 - bx.y0;
    // A real code: at least 21 × ~1.5px, and a square-ish patch.
    if (bw < 30 || bh < 30 || bw / bh > 3 || bh / bw > 3) break;
    // The patch alone, with its quiet zone, enlarged and stretched: read again.
    const m = Math.max(bw, bh) * 0.2;
    const cx0 = Math.max(0, bx.x0 - m); const cy0 = Math.max(0, bx.y0 - m);
    const cx1 = Math.min(w, bx.x1 + m); const cy1 = Math.min(h, bx.y1 + m);
    const k = Math.max(1, Math.min(4, 600 / Math.max(cx1 - cx0, cy1 - cy0)));
    const patch = cropLum(lum, w, h, cx0, cy0, cx1, cy1, k);
    let read = null;
    for (const bin of ['hybrid', 'global']) {
      const got = readPass(Z, patch.lum, patch.w, patch.h, { binarizer: bin, formats: ['QR_CODE'] });
      if (got.length) { read = got[0]; break; }
    }
    const shape = quad.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
    const box = { x: bx.x0 / w, y: bx.y0 / h, w: bw / w, h: bh / h };
    if (read) out.push({ format: read.format, text: read.text, box, shape });
    else out.push({ format: 'QR code', text: '', unread: true, box, shape });
    for (let y = bx.y0; y < bx.y1; y++) work.fill(255, y * w + bx.x0, y * w + bx.x1);
  }
  return out;
}

/** Every code in a picture on screen (an <img> or a canvas). */
export async function readBarcodes(img, opts = {}) {
  const w0 = img.naturalWidth || img.width; const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new Error('The picture hasn’t loaded yet.');
  const k = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k)); const h = Math.max(1, Math.round(h0 * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const lum = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
  return decodeLuminance(lum, w, h, opts);
}

// What a QR code's text is, read by the conventions phones use:
// { type, label, fields: [[name, value]], url? } — `url` when it can be opened.
export function describeQr(text) {
  const t = String(text || '').trim();
  const kv = (body) => {
    const out = {};
    // WIFI:T:WPA;S:name;P:pass;; — values may escape ; , : \ with a backslash.
    body.replace(/([A-Z]+):((?:\\.|[^;])*);?/gi, (_, k, v) => { out[k.toUpperCase()] = v.replace(/\\(.)/g, '$1'); return ''; });
    return out;
  };
  if (/^https?:\/\//i.test(t)) return { type: 'link', label: 'Link', fields: [], url: t };
  if (/^www\./i.test(t)) return { type: 'link', label: 'Link', fields: [], url: `https://${t}` };
  if (/^WIFI:/i.test(t)) {
    const f = kv(t.slice(5));
    return { type: 'wifi', label: 'Wi-Fi network', fields: [['Network', f.S || ''], ['Password', f.P || ''], ['Security', f.T || (f.P ? 'WPA' : 'Open')]].filter((x) => x[1]) };
  }
  if (/^mailto:/i.test(t)) return { type: 'email', label: 'Email', fields: [['To', decodeURIComponent(t.slice(7).split('?')[0])]], url: t };
  if (/^MATMSG:/i.test(t)) { const f = kv(t.slice(7)); return { type: 'email', label: 'Email', fields: [['To', f.TO || ''], ['Subject', f.SUB || ''], ['Message', f.BODY || '']].filter((x) => x[1]), url: f.TO ? `mailto:${f.TO}` : '' }; }
  if (/^tel:/i.test(t)) return { type: 'phone', label: 'Phone number', fields: [['Number', t.slice(4)]], url: t };
  if (/^(smsto|sms):/i.test(t)) { const [, n, m] = t.split(':'); return { type: 'sms', label: 'Text message', fields: [['To', n || ''], ['Message', m || '']].filter((x) => x[1]) }; }
  if (/^geo:/i.test(t)) { const [lat, lon] = t.slice(4).split(/[,?]/); return { type: 'place', label: 'Place', fields: [['Coordinates', `${lat}, ${lon}`]], url: `https://www.google.com/maps?q=${lat},${lon}` }; }
  if (/^BEGIN:VCARD/i.test(t)) {
    const line = (k) => (t.match(new RegExp(`^${k}(?:;[^:\n]*)?:(.*)$`, 'im')) || [])[1]?.trim() || '';
    const n = line('FN') || line('N').split(';').filter(Boolean).reverse().join(' ');
    return { type: 'contact', label: 'Contact', fields: [['Name', n], ['Organisation', line('ORG').replace(/;/g, ' ')], ['Phone', line('TEL')], ['Email', line('EMAIL')], ['Address', line('ADR').replace(/;+/g, ' ').trim()]].filter((x) => x[1]) };
  }
  if (/^MECARD:/i.test(t)) { const f = kv(t.slice(7)); return { type: 'contact', label: 'Contact', fields: [['Name', (f.N || '').split(',').reverse().join(' ').trim()], ['Phone', f.TEL || ''], ['Email', f.EMAIL || ''], ['Address', f.ADR || '']].filter((x) => x[1]) }; }
  if (/^BEGIN:VEVENT|^BEGIN:VCALENDAR/i.test(t)) {
    const line = (k) => (t.match(new RegExp(`^${k}(?:;[^:\n]*)?:(.*)$`, 'im')) || [])[1]?.trim() || '';
    return { type: 'event', label: 'Calendar event', fields: [['Event', line('SUMMARY')], ['Starts', line('DTSTART')], ['Ends', line('DTEND')], ['Where', line('LOCATION')]].filter((x) => x[1]) };
  }
  // The EPC (SEPA credit transfer) code European invoices carry.
  if (/^BCD\r?\n/.test(t)) {
    const l = t.split(/\r?\n/);
    return { type: 'payment', label: 'Bank transfer (SEPA)', fields: [['Beneficiary', l[5] || ''], ['IBAN', l[6] || ''], ['BIC', l[4] || ''], ['Amount', (l[7] || '').replace(/^([A-Z]{3})(.*)$/, '$2 $1')], ['Reference', l[9] || l[10] || '']].filter((x) => x[1]) };
  }
  return { type: 'text', label: 'Text', fields: [] };
}
