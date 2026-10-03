// Document scanning — what the photo editor's Scan mode (components/PhotoEditor
// `scan`) does beyond its four-point perspective correction, the way a phone's
// document scanner does it:
//
//   detectPageQuad(canvas)   find the page's four corners in a photograph
//   enhanceScan(canvas, f)   even out the lighting, then 'auto' (colour),
//                            'grey', 'bw' (black & white) or 'original'
//   scanToPdf(canvas)        a one-page PDF of the result
//
// All local, on canvas pixels; nothing leaves the machine.

// ── Finding the page ───────────────────────────────────────────────────────
// A page photographed on a desk is the large, bright, low-saturation region.
// The picture is shrunk to ≤DETECT_EDGE px and smoothed; every pixel gets a
// "paper" score (bright and grey — `l − 0.6 × saturation`); Otsu's threshold
// splits paper from not-paper; the largest connected paper region is kept,
// holes and all; its four corners are its extreme points along the diagonals
// (top-left = smallest x+y, bottom-right = largest, top-right = largest x−y,
// bottom-left = smallest), which holds for any page turned less than ~40°.
// Each corner is then refined along the region's outline to the point that
// makes the quadrilateral largest. `null` when nothing page-like stands out —
// the caller keeps the whole picture.
const DETECT_EDGE = 360;

export function detectPageQuad(src) {
  if (!src?.width || !src?.height) return null;
  const k = Math.min(1, DETECT_EDGE / Math.max(src.width, src.height));
  const w = Math.max(8, Math.round(src.width * k));
  const h = Math.max(8, Math.round(src.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.filter = 'blur(1.5px)';
  ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  // Paper score, 0…255.
  const score = new Uint8Array(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < w * h; i += 1, p += 4) {
    const r = px[p]; const g = px[p + 1]; const b = px[p + 2];
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    const s = mx - mn;
    const v = Math.max(0, Math.min(255, Math.round(l - 0.6 * s)));
    score[i] = v; hist[v] += 1;
  }
  // Otsu.
  const total = w * h;
  let sum = 0;
  for (let t = 0; t < 256; t += 1) sum += t * hist[t];
  let sumB = 0; let wB = 0; let best = 0; let thr = 128;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB; const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  // Largest connected bright region (4-connected, iterative).
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let bestLabel = 0; let bestSize = 0; let next = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (label[i] || score[i] <= thr) continue;
    next += 1;
    let size = 0; let top = 0;
    stack[top++] = i; label[i] = next;
    while (top) {
      const j = stack[--top]; size += 1;
      const x = j % w; const y = (j - x) / w;
      if (x > 0 && !label[j - 1] && score[j - 1] > thr) { label[j - 1] = next; stack[top++] = j - 1; }
      if (x < w - 1 && !label[j + 1] && score[j + 1] > thr) { label[j + 1] = next; stack[top++] = j + 1; }
      if (y > 0 && !label[j - w] && score[j - w] > thr) { label[j - w] = next; stack[top++] = j - w; }
      if (y < h - 1 && !label[j + w] && score[j + w] > thr) { label[j + w] = next; stack[top++] = j + w; }
    }
    if (size > bestSize) { bestSize = size; bestLabel = next; }
  }
  // Too small to be the page, or everything (a page shot filling the frame —
  // the whole picture is then the right answer).
  if (!bestLabel || bestSize < total * 0.12 || bestSize > total * 0.97) return null;

  // Diagonal extremes over the region's pixels.
  const ext = [
    { f: (x, y) => -(x + y), p: null, v: -Infinity },   // TL
    { f: (x, y) => x - y, p: null, v: -Infinity },      // TR
    { f: (x, y) => x + y, p: null, v: -Infinity },      // BR
    { f: (x, y) => y - x, p: null, v: -Infinity },      // BL
  ];
  for (let i = 0; i < w * h; i += 1) {
    if (label[i] !== bestLabel) continue;
    const x = i % w; const y = (i - x) / w;
    for (const e of ext) { const v = e.f(x, y); if (v > e.v) { e.v = v; e.p = [x, y]; } }
  }
  const quad = ext.map((e) => e.p);
  if (quad.some((p) => !p)) return null;
  // A shape with (almost) no area is not a page.
  const area = Math.abs(
    (quad[0][0] * quad[1][1] - quad[1][0] * quad[0][1])
    + (quad[1][0] * quad[2][1] - quad[2][0] * quad[1][1])
    + (quad[2][0] * quad[3][1] - quad[3][0] * quad[2][1])
    + (quad[3][0] * quad[0][1] - quad[0][0] * quad[3][1]),
  ) / 2;
  if (area < total * 0.1) return null;
  // Pixel centres, normalised to 0…1 of the picture.
  return quad.map(([x, y]) => [Math.min(1, Math.max(0, (x + 0.5) / w)), Math.min(1, Math.max(0, (y + 0.5) / h))]);
}

// ── Evening out the light ──────────────────────────────────────────────────
// Paper is white; everything that makes it look otherwise across the page — a
// shadow from the phone, a lamp to one side, a warm cast — is SLOW, while ink
// is fast. So the page's own white is estimated per region: the picture is cut
// into blocks, each block's paper level is its bright end (the 90th percentile
// of each channel, on a downscaled copy so noise doesn't win), the block grid is
// widened (max of neighbours, so a block full of text borrows its neighbours'
// paper) and smoothed, and every pixel is divided by the paper level under it
// — shadows and colour casts both come out. Then the ink is deepened with a
// levels curve (black point at the darkest 2%, a little gamma).
const GRID = 28;

function paperMap(src) {
  const k = Math.min(1, 900 / Math.max(src.width, src.height));
  const w = Math.max(GRID, Math.round(src.width * k));
  const h = Math.max(GRID, Math.round(src.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const gw = GRID; const gh = Math.max(4, Math.round(GRID * (h / w)));
  const map = new Float32Array(gw * gh * 3);
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      const x0 = Math.floor((gx * w) / gw); const x1 = Math.floor(((gx + 1) * w) / gw);
      const y0 = Math.floor((gy * h) / gh); const y1 = Math.floor(((gy + 1) * h) / gh);
      hist[0].fill(0); hist[1].fill(0); hist[2].fill(0);
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const p = (y * w + x) * 4;
          hist[0][d[p]] += 1; hist[1][d[p + 1]] += 1; hist[2][d[p + 2]] += 1; n += 1;
        }
      }
      for (let ch = 0; ch < 3; ch += 1) {
        let acc = 0; let v = 255;
        const want = n * 0.1;
        for (let t = 255; t >= 0; t -= 1) { acc += hist[ch][t]; if (acc >= want) { v = t; break; } }
        map[(gy * gw + gx) * 3 + ch] = Math.max(v, 40);
      }
    }
  }
  // Widen (a block that is all text takes its neighbours' paper), then smooth.
  const widened = new Float32Array(map.length);
  const smooth = new Float32Array(map.length);
  const pass = (from, to, fn) => {
    for (let gy = 0; gy < gh; gy += 1) {
      for (let gx = 0; gx < gw; gx += 1) {
        for (let ch = 0; ch < 3; ch += 1) {
          let acc = fn === 'max' ? 0 : 0; let n = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const x = gx + dx; const y = gy + dy;
              if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
              const v = from[(y * gw + x) * 3 + ch];
              if (fn === 'max') acc = Math.max(acc, v); else { acc += v; n += 1; }
            }
          }
          to[(gy * gw + gx) * 3 + ch] = fn === 'max' ? acc : acc / n;
        }
      }
    }
  };
  pass(map, widened, 'max');
  pass(widened, smooth, 'mean');
  pass(smooth, map, 'mean');
  return { map, gw, gh };
}

/**
 * The scanned look. `filter`: 'auto' | 'grey' | 'bw' | 'original'. Returns a
 * new canvas (the input is left alone).
 */
export function enhanceScan(src, filter = 'auto') {
  const w = src.width; const h = src.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.drawImage(src, 0, 0);
  if (filter === 'original') return out;
  const img = octx.getImageData(0, 0, w, h);
  const d = img.data;
  const { map, gw, gh } = paperMap(src);

  // Divide by the paper under each pixel (bilinear over the grid).
  const sx = (gw - 1) / Math.max(1, w - 1);
  const sy = (gh - 1) / Math.max(1, h - 1);
  const lumHist = new Uint32Array(256);
  for (let y = 0; y < h; y += 1) {
    const fy = y * sy; const y0 = Math.min(gh - 2, Math.floor(fy)); const ty = Math.min(1, fy - y0);
    for (let x = 0; x < w; x += 1) {
      const fx = x * sx; const x0 = Math.min(gw - 2, Math.floor(fx)); const tx = Math.min(1, fx - x0);
      const i00 = (y0 * gw + x0) * 3; const i10 = i00 + 3; const i01 = i00 + gw * 3; const i11 = i01 + 3;
      const p = (y * w + x) * 4;
      let l = 0;
      for (let ch = 0; ch < 3; ch += 1) {
        const a = map[i00 + ch] + (map[i10 + ch] - map[i00 + ch]) * tx;
        const b = map[i01 + ch] + (map[i11 + ch] - map[i01 + ch]) * tx;
        const paper = a + (b - a) * ty;
        const v = Math.min(255, (d[p + ch] / paper) * 255);
        d[p + ch] = v;
        l += v * (ch === 0 ? 0.299 : ch === 1 ? 0.587 : 0.114);
      }
      lumHist[Math.min(255, l | 0)] += 1;
    }
  }
  // Black point: the darkest 2% of the page (never above 150 — a page with no
  // ink must not be pushed into the dark).
  const want = w * h * 0.02;
  let acc = 0; let black = 0;
  for (let t = 0; t < 256; t += 1) { acc += lumHist[t]; if (acc >= want) { black = Math.min(150, t); break; } }
  const white = 235;   // paper comes out at 255 already; this cleans the last grain
  const span = Math.max(1, white - black);
  const curve = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v += 1) {
    const n = Math.min(1, Math.max(0, (v - black) / span));
    curve[v] = Math.round(255 * Math.pow(n, 1.25));
  }
  for (let p = 0; p < d.length; p += 4) {
    if (filter === 'auto') {
      d[p] = curve[d[p]]; d[p + 1] = curve[d[p + 1]]; d[p + 2] = curve[d[p + 2]];
      continue;
    }
    const g = curve[Math.round(d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114)];
    // Black & white: a steep ramp rather than a hard cut, so letters keep a
    // clean, anti-aliased edge instead of turning to stairs.
    const v = filter === 'bw' ? Math.max(0, Math.min(255, (g - 150) * 4 + 128)) : g;
    d[p] = v; d[p + 1] = v; d[p + 2] = v;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// ── As a PDF ─────────────────────────────────────────────────────────────
// One page the scan's own shape, 210 mm wide — an A4 page when the page was
// A4 (the usual case), and never a letterbox around a receipt.
//
// `regions` (a reading of the page, lib/textRegions: lines with their words'
// extents, 0…1 of the page) are written OVER the picture as INVISIBLE text
// (PDF text rendering mode 3, what scanner apps write), word by word where each
// word lies: the PDF can be selected, searched and read (its text reaches the
// AI scan) like one made from a document, instead of being a photograph.
// The font is Liberation Sans (SIL Open Font License, shipped with pdfjs-dist,
// every Romanian letter — a PDF's own fonts have no ă / ș / ț), copied into
// public/ocr/ on install and loaded only when a scan carries text.
let textFont = null;
async function loadTextFont() {
  textFont ||= (async () => {
    // Copied into public/ocr/ on install (scripts/copy-ocr-assets.mjs).
    const { readOcrAsset } = await import('./paddleOcr');
    const buf = new Uint8Array(await readOcrAsset('LiberationSans-Regular.ttf'));
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  })().catch((e) => { textFont = null; throw e; });
  return textFont;
}
export async function scanToPdf(canvas, { quality = 0.88, regions = null } = {}) {
  const mod = await import('jspdf');
  const JsPDF = mod.jsPDF || mod.default || mod;
  const wMm = 210;
  let hMm = (wMm * canvas.height) / canvas.width;
  if (Math.abs(hMm - 297) / 297 < 0.06) hMm = 297;
  const doc = new JsPDF({ orientation: hMm >= wMm ? 'portrait' : 'landscape', unit: 'mm', format: [wMm, hMm], compress: true });
  doc.addImage(canvas.toDataURL('image/jpeg', quality), 'JPEG', 0, 0, wMm, hMm);
  const lines = (regions || []).filter((r) => r?.text && r.w > 0 && r.h > 0);
  if (lines.length) {
    try {
      doc.addFileToVFS('LiberationSans-Regular.ttf', await loadTextFont());
      doc.addFont('LiberationSans-Regular.ttf', 'LiberationSans', 'normal');
      doc.setFont('LiberationSans', 'normal');
      const PT = 72 / 25.4;   // points per mm
      for (const r of lines) {
        const x = r.x * wMm; const y = r.y * hMm; const w = r.w * wMm; const h = r.h * hMm;
        // A tilted line (r.a): laid at its angle about its own box, as a whole.
        const words = Array.isArray(r.words) && r.words.length && !r.a ? r.words : [[r.text, 0, 1]];
        const size = Math.max(2, h * 0.86 * PT);   // a line's letters ≈ its box's height
        doc.setFontSize(size);
        for (const [t, a, b] of words) {
          if (!t) continue;
          const wx = x + a * w; const ww = Math.max(0.5, (b - a) * w);
          // Stretched to the word's own width, so a selection covers what is
          // printed there.
          const natural = doc.getTextWidth(t);
          const opts = { renderingMode: 'invisible', baseline: 'bottom' };
          if (natural > 0) opts.horizontalScale = Math.max(0.2, Math.min(5, ww / natural));
          if (r.a) opts.angle = -r.a;
          doc.text(t, wx, y + h, opts);
        }
      }
    } catch (err) {
      // The picture alone is still a scan worth saving.
      // eslint-disable-next-line no-console
      console.warn('[scan] the text layer could not be written:', err);
    }
  }
  return doc.output('blob');
}
