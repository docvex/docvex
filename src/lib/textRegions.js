// Text detection WITH positions, for the Doc Viewer's image pane: the picture's
// text comes back as LINES — `{ text, x, y, w, h }`, normalised 0…1 to the image,
// in reading order — plus the SHAPES that light them up (`shapes`: outlines of
// the lit areas, neighbouring lines merged into one). The pane lays real,
// invisible text over each line, so the picture's text is selected by dragging
// and copied like any other text (a phone's / Windows Photos' live text).
//
// THE ENGINE IS LOCAL: PaddleOCR PP-OCRv6 (lib/paddleOcr — a neural text
// DETECTOR that finds every line on a real photo, tilted, blurred, shadowed or
// on a busy ground, then a recogniser reading each line cut out upright; the
// same two-stage design as Apple's Live Text). Tesseract (tesseract.js, with
// the Romanian + English models) is kept as the FALLBACK for when PaddleOCR
// can't start — it needs a clean, flat page and misses most of a phone photo. A highlight has to sit ON its text, and
// only a real OCR engine measures where glyphs are — it reports a pixel box per
// word. (The first two versions of this asked a vision model for boxes; it
// reads text well but only ESTIMATES positions, and the highlights never quite
// wrapped their text.) The engine, its core and both models are served from
// `public/ocr/` (scripts/copy-ocr-assets.mjs, postinstall) — nothing is
// downloaded.
//
// WHO DOES WHAT — settled after trying it every other way:
//   · WHERE the text is: MEASURED, here, by the engine. Never the AI. A language
//     model does not measure coordinates, it guesses them; boxes it was asked for
//     (raw, with rulers, snapped to the ink afterwards) never sat on their text.
//   · WHAT the text says: the AI. The engine spells roughly ("Given nomes").
//     So every measured piece is CUT OUT of the picture, the cut-outs are laid on
//     numbered sheets, and the AI is asked one thing only — what does strip 7
//     say? ("The AI reads the pieces", below.) It never sees a coordinate and
//     never gives one; a strip with no text in it (a flag, a signature) comes
//     back empty and that piece is dropped.
// The picture's strips do go to the Anthropic API for that (same endpoint and
// terms as the rest of the app's AI), once per file, then cached.
import { readLocalBlob } from './localFolder';
import { getAiFacet, saveAiFacet, stampFor } from './aiData';
import { isCloudMediaAllowed } from './cloudMedia';
import { readSourceText } from './identityExtract';
import { readLines } from './paddleOcr';

// The strips' reader. Sheets are sized to pass the API's image limits untouched
// (1568px on the long edge, ~1.15 MP), so small print stays as sharp as cut.
const MODEL = 'claude-sonnet-4-6';
const SHEET_W = 1000;
const SHEET_MAX_H = 1100;
const SHEET_MAX = 6;          // sheets per reading (~20 strips each)
const STRIP_TEXT_H = 38;      // a strip's text is scaled to about this tall
const STRIP_GUTTER = 64;      // the numbered margin down the left

// ── The local engine ────────────────────────────────────────────────────
const OCR_LANGS = ['ron', 'eng'];
// Tesseract likes capitals ~30px tall: a phone photo is downscaled to this, a
// small screenshot upscaled to it (up to 2.5×).
const OCR_TARGET_EDGE = 2200;
// NOTHING the engine reads is thrown away: no confidence floor, no cap on how
// many pieces, no minimum size. (There used to be — and real words on a worn
// card, read with low confidence, went missing with the noise.) Confidence is
// only used to JUDGE an orientation, below.
const SCORE_MIN_CONF = 60;

function ocrBaseUrl() {
  // Dev: '/', packaged Electron: './' beside index.html.
  const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || './';
  return new URL(`${base.replace(/\/?$/, '/')}ocr/`, window.location.href).href;
}

// Packaged Electron serves the app from file://, where the worker's `fetch` of
// the language data is refused ("URL scheme file is not supported"). Tesseract
// looks in its IndexedDB cache BEFORE fetching — idb-keyval's default store,
// key `./<lang>.traineddata` — so the models are put there from here, read with
// XHR (which file:// pages ARE allowed). A no-op once seeded, and skipped
// entirely over http(s), where the worker's own fetch works.
function idbGetSet(key, makeValue) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('keyval-store');
    open.onupgradeneeded = () => { open.result.createObjectStore('keyval'); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('keyval')) { db.close(); reject(new Error('no keyval store')); return; }
      const read = db.transaction('keyval', 'readonly').objectStore('keyval').getKey(key);
      read.onerror = () => { db.close(); reject(read.error); };
      read.onsuccess = async () => {
        if (read.result !== undefined) { db.close(); resolve(false); return; }
        try {
          const value = await makeValue();
          const tx = db.transaction('keyval', 'readwrite');
          tx.objectStore('keyval').put(value, key);
          tx.oncomplete = () => { db.close(); resolve(true); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        } catch (e) { db.close(); reject(e); }
      };
    };
  });
}
function xhrBytes(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => (xhr.response && (xhr.status === 200 || xhr.status === 0)
      ? resolve(new Uint8Array(xhr.response)) : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('read failed'));
    xhr.send();
  });
}
async function seedLanguageCache(base) {
  if (window.location.protocol !== 'file:') return;
  await Promise.all(OCR_LANGS.map((lang) => idbGetSet(`./${lang}.traineddata`, () => xhrBytes(`${base}${lang}.traineddata.gz`))));
}

// One worker for the life of the window: starting it (wasm + two models) costs
// a second or two, reading a picture with it a few more.
let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const base = ocrBaseUrl();
      try { await seedLanguageCache(base); } catch { /* the worker will try its own fetch */ }
      const { createWorker, PSM } = await import('tesseract.js');
      const worker = await createWorker(OCR_LANGS, 1, {
        workerPath: `${base}worker.min.js`,
        corePath: base.replace(/\/$/, ''),
        langPath: base.replace(/\/$/, ''),
        // Load the worker script itself (not a blob that importScripts it): a
        // blob worker has an opaque origin and can't import a file:// script.
        workerBlobURL: false,
        logger: () => {},
      });
      // A photograph of a card or a form is text scattered about, not a column
      // of prose: "sparse text" finds each piece wherever it is.
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
        // Quiet: a canvas carries no DPI, so the engine logged "Estimating
        // resolution as N" for every pass (hundreds of lines over a Files-tab
        // scan). The picture is scaled to ~2200px on its long edge, which is
        // what a 300 dpi scan of a card or a page amounts to; the engine's
        // other diagnostics go nowhere.
        user_defined_dpi: '300',
        debug_file: '/dev/null',
      });
      return worker;
    })().catch((err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

// The picture turned `turns` quarter-turns clockwise, at OCR size.
function ocrCanvas(el, turns) {
  const natW = el.naturalWidth;
  const natH = el.naturalHeight;
  const scale = Math.min(2.5, OCR_TARGET_EDGE / Math.max(natW, natH));
  const w = Math.max(1, Math.round(natW * scale));
  const h = Math.max(1, Math.round(natH * scale));
  const canvas = document.createElement('canvas');
  const side = turns % 2 === 1;
  canvas.width = side ? h : w;
  canvas.height = side ? w : h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((turns * Math.PI) / 2);
  ctx.drawImage(el, -w / 2, -h / 2, w, h);
  return canvas;
}

// A point of the TURNED canvas (normalised) → the same point of the picture as
// it is shown (normalised). Turning clockwise by k quarter-turns took (x, y) to:
//   1: (1 - y, x)    2: (1 - x, 1 - y)    3: (y, 1 - x)      — inverted here.
function unturn(turns, x, y) {
  if (turns === 1) return [y, 1 - x];
  if (turns === 2) return [1 - x, 1 - y];
  if (turns === 3) return [1 - y, x];
  return [x, y];
}

const hasInk = (text) => /[\p{L}\p{N}]/u.test(text);

// Tesseract's page → regions. Its LINES are the unit, split wherever two words
// stand further apart than about two letter-heights (the MEDIAN word height — a
// line's own box is inflated by any tall stray in it), and at any word that is
// only a rule or a bar ("|"): on a form, a label and the value beside it, or two
// columns on one baseline, are separate things to copy.
//
// The lit SHAPES follow the words: each word keeps its own top and bottom, so a
// line that runs from capitals into small letters steps down with them
// (`runRects`); neighbouring lines are joined (`bridgeRects`) and everything is
// united into outlines (`unionLoops`) — overlap cannot happen, a union has none.
// Of two readings of the same spot only the more confident survives
// (`dropDuplicates`). All of it is worked out in the TURNED canvas, where text
// runs left to right, and mapped back to the picture at the very end.
function collectRuns(data, taken = []) {
  const runs = [];
  // A word of a SECOND reading that sits where a word was already read adds
  // nothing; one that sits on untouched ground is text the first pass missed.
  const isTaken = (w) => {
    const area = Math.max(1, (w.bbox.x1 - w.bbox.x0) * (w.bbox.y1 - w.bbox.y0));
    return taken.some((t) => {
      const ix = Math.min(t.x1, w.bbox.x1) - Math.max(t.x0, w.bbox.x0);
      const iy = Math.min(t.y1, w.bbox.y1) - Math.max(t.y0, w.bbox.y0);
      return ix > 0 && iy > 0 && (ix * iy) / Math.min(area, Math.max(1, (t.x1 - t.x0) * (t.y1 - t.y0))) > 0.3;
    });
  };
  const pushRun = (words, letterH) => {
    if (!words.length) return;
    // The Romanian model still writes the legacy cedilla ş/ţ; Romanian is
    // written with the comma below, and this text gets pasted into documents.
    const fix = (t) => String(t).replace(/\s+/g, ' ').trim()
      .replace(/ş/g, 'ș').replace(/Ş/g, 'Ș')
      .replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț');
    const text = words.map((w) => fix(w.text)).filter(Boolean).join(' ');
    if (!text) return;
    const conf = words.reduce((n, w) => n + w.confidence, 0) / words.length;
    const ink = text.replace(/[^\p{L}\p{N}]/gu, '').length;
    const boxes = words.map((w) => ({ x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, ink: hasInk(w.text), t: fix(w.text) }));
    runs.push({
      text, conf, ink, letterH, boxes,
      x0: Math.min(...boxes.map((q) => q.x0)), y0: Math.min(...boxes.map((q) => q.y0)),
      x1: Math.max(...boxes.map((q) => q.x1)), y1: Math.max(...boxes.map((q) => q.y1)),
    });
  };
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const words = (line.words || [])
          .filter((w) => w.text && w.text.trim() && !isTaken(w))
          .sort((p, q) => p.bbox.x0 - q.bbox.x0);
        if (!words.length) continue;
        const heights = words.map((w) => w.bbox.y1 - w.bbox.y0).sort((p, q) => p - q);
        const letterH = Math.max(1, heights[Math.floor(heights.length / 2)]);
        let run = [];
        for (const w of words) {
          // A rule or a bar divides; a slash or a dash belongs to its phrase
          // ("Prenume / Given names").
          if (/^[|¦_=—]+$/.test(w.text.trim())) { pushRun(run, letterH); run = []; continue; }
          const prev = run[run.length - 1];
          if (prev && w.bbox.x0 - prev.bbox.x1 > letterH * 2.2) { pushRun(run, letterH); run = []; }
          run.push(w);
        }
        pushRun(run, letterH);
      }
    }
  }
  return runs;
}

// Sparse-text mode sometimes reads one spot twice (a block and a line inside
// it). Where two runs cover mostly the same ground, the surer one stays.
function dropDuplicates(runs) {
  const area = (r) => Math.max(1, (r.x1 - r.x0) * (r.y1 - r.y0));
  const dead = new Set();
  for (let i = 0; i < runs.length; i += 1) {
    if (dead.has(i)) continue;
    for (let j = i + 1; j < runs.length; j += 1) {
      if (dead.has(j)) continue;
      const a = runs[i]; const b = runs[j];
      const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ix <= 0 || iy <= 0) continue;
      // The SAME spot, not merely a small piece inside a long line's box — that
      // small piece is text of its own.
      if ((ix * iy) / Math.max(area(a), area(b)) < 0.6) continue;
      const worse = a.conf * Math.sqrt(a.ink) >= b.conf * Math.sqrt(b.ink) ? j : i;
      dead.add(worse);
      if (worse === i) break;
    }
  }
  return runs.filter((_, i) => !dead.has(i));
}

// One run → the rectangles that light it: a rectangle per word, padded, meeting
// its neighbour halfway across the space between them. Tops (and bottoms) that
// differ by less than half a letter are levelled, so the edge steps only where
// the text really changes height.
function runRects(run) {
  const { boxes } = run;
  const letterH = run.ref || run.letterH;
  const pad = Math.max(2, letterH * 0.26);
  const n = boxes.length;
  const tops = boxes.map((q) => q.y0 - pad);
  const bots = boxes.map((q) => q.y1 + pad);
  // A slash or a dash has no say in the line's height: it takes its neighbour's
  // (a "/" is taller than the words around it and would notch the edge).
  for (let i = 0; i < n; i += 1) {
    if (boxes[i].ink) continue;
    let k = -1;
    for (let d = 1; d < n && k < 0; d += 1) {
      if (boxes[i - d]?.ink) k = i - d; else if (boxes[i + d]?.ink) k = i + d;
    }
    if (k >= 0) { tops[i] = boxes[k].y0 - pad; bots[i] = boxes[k].y1 + pad; }
  }
  const tol = letterH * 0.5;
  const level = (v, pick) => {
    for (let i = 1; i < n; i += 1) if (Math.abs(v[i] - v[i - 1]) < tol) { v[i] = pick(v[i], v[i - 1]); v[i - 1] = v[i]; }
    for (let i = n - 2; i >= 0; i -= 1) if (Math.abs(v[i] - v[i + 1]) < tol) { v[i] = pick(v[i], v[i + 1]); v[i + 1] = v[i]; }
  };
  level(tops, Math.min);
  level(bots, Math.max);
  const edges = [boxes[0].x0 - pad];
  for (let i = 1; i < n; i += 1) edges.push((boxes[i - 1].x1 + boxes[i].x0) / 2);
  edges.push(boxes[n - 1].x1 + pad);
  return boxes.map((_, i) => [edges[i], tops[i], edges[i + 1], bots[i]]);
}

// NEIGHBOURS are joined: the lines of a paragraph (one under the other, less
// than a letter apart) and pieces side by side on a baseline (a label and its
// value, a few letters apart) get a rectangle across the space between them, so
// the union below lights them as ONE shape.
function bridgeRects(runs) {
  const out = [];
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const a = runs[i]; const b = runs[j];
      const letter = Math.min(a.ref || a.letterH, b.ref || b.letterH);
      const pad = Math.max(2, letter * 0.26);
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ox > 0 && oy <= 0 && -oy < letter * 1.15) {
        const [up, down] = a.y0 <= b.y0 ? [a, b] : [b, a];
        out.push([Math.max(a.x0, b.x0) - pad, up.y1, Math.min(a.x1, b.x1) + pad, down.y0]);
      } else if (oy > Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5 && ox <= 0 && -ox < letter * 3.5) {
        const [left, right] = a.x0 <= b.x0 ? [a, b] : [b, a];
        out.push([left.x1, Math.max(a.y0, b.y0) - pad, right.x0, Math.min(a.y1, b.y1) + pad]);
      }
    }
  }
  return out;
}

// The union of a set of rectangles, as outlines: closed loops of [x, y] (outer
// edges clockwise, holes the other way — fill them even-odd). Coordinates are
// snapped to `q` first, so two edges a hair apart become one edge instead of a
// nick. Done on the compressed grid of the rectangles' own coordinates.
function unionLoops(rects, q) {
  const snap = (v) => Math.round(v / q) * q;
  const R = rects.map((r) => r.map(snap)).filter((r) => r[2] > r[0] && r[3] > r[1]);
  if (!R.length) return [];
  const xs = [...new Set(R.flatMap((r) => [r[0], r[2]]))].sort((m, n) => m - n);
  const ys = [...new Set(R.flatMap((r) => [r[1], r[3]]))].sort((m, n) => m - n);
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const nx = xs.length - 1; const ny = ys.length - 1;
  const fill = new Uint8Array(nx * ny);
  for (const r of R) {
    for (let j = yi.get(r[1]); j < yi.get(r[3]); j += 1) fill.fill(1, j * nx + xi.get(r[0]), j * nx + xi.get(r[2]));
  }
  const on = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && fill[j * nx + i] === 1;
  // Boundary edges, directed clockwise round the lit cells (y grows downward).
  const next = new Map();   // "i,j" → [[i2, j2], …]
  const add = (i0, j0, i1, j1) => {
    const k = `${i0},${j0}`;
    if (!next.has(k)) next.set(k, []);
    next.get(k).push([i1, j1]);
  };
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      if (!on(i, j)) continue;
      if (!on(i, j - 1)) add(i, j, i + 1, j);
      if (!on(i + 1, j)) add(i + 1, j, i + 1, j + 1);
      if (!on(i, j + 1)) add(i + 1, j + 1, i, j + 1);
      if (!on(i - 1, j)) add(i, j + 1, i, j);
    }
  }
  const loops = [];
  for (const [startKey, outs] of next) {
    while (outs.length) {
      const [si, sj] = startKey.split(',').map(Number);
      const ring = [[si, sj]];
      let [ci, cj] = outs.pop();
      let guard = 0;
      while ((ci !== si || cj !== sj) && guard < 200000) {
        ring.push([ci, cj]);
        const o = next.get(`${ci},${cj}`);
        if (!o || !o.length) break;
        [ci, cj] = o.pop();
        guard += 1;
      }
      // Keep only the corners.
      const pts = ring.map(([i, j]) => [xs[i], ys[j]]);
      const corners = pts.filter((v, k) => {
        const u = pts[(k + pts.length - 1) % pts.length];
        const w = pts[(k + 1) % pts.length];
        return !((u[0] === v[0] && v[0] === w[0]) || (u[1] === v[1] && v[1] === w[1]));
      });
      if (corners.length >= 4) loops.push(corners);
    }
  }
  return loops;
}

// Reading order: top to bottom, and left to right among pieces on one baseline.
function readingOrder(runs) {
  const rows = [];
  for (const r of [...runs].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))) {
    const cy = (r.y0 + r.y1) / 2;
    const row = rows.find((w) => Math.abs(w.cy - cy) < Math.min(w.h, r.y1 - r.y0) * 0.55);
    if (row) row.items.push(r); else rows.push({ cy, h: r.y1 - r.y0, items: [r] });
  }
  return rows.flatMap((w) => w.items.sort((a, b) => a.x0 - b.x0));
}

// Runs (in the TURNED canvas, reading order) → what the pane draws: `regions`
// (a line box + each word's extent along it, normalised to the picture as it is
// shown) and the lit `shapes`.
function composeReading(runs, turns, cw, ch) {
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const round = (v) => Math.round(v * 1e6) / 1e6;
  const toPicture = (px, py) => {
    const [nx, ny] = unturn(turns, px / cw, py / ch);
    return [round(clamp(nx)), round(clamp(ny))];
  };
  const regions = [];
  const kept = [];
  const tilted = [];
  // A length measured in the turned canvas, as a fraction of the picture's
  // WIDTH as shown (the layer scales both of a tilted line's sizes by it).
  const shownW = turns % 2 === 1 ? ch : cw;
  for (const run of runs) {
    if (run.tilt) {
      // A TILTED line: its words shared along it by their length, laid at its
      // angle round its centre.
      const { cx, cy, angle, len, th } = run.tilt;
      const tokens = run.text.split(' ').filter(Boolean);
      if (!tokens.length) continue;
      const total = tokens.reduce((n, t) => n + t.length, 0) + tokens.length - 1;
      let at = 0;
      // Fitted to the ink (fitRunsToInk) when the words are the ones measured;
      // otherwise shared along it by their length.
      const fitted = run.tilt.words;
      const words = Array.isArray(fitted) && fitted.length === tokens.length
        ? fitted.map(([w, a, b, cuts], k) => (w === tokens[k] && Array.isArray(cuts)
          ? [tokens[k], round(a), round(b), cuts.map(round)]
          : [tokens[k], round(a), round(b)]))
        : tokens.map((t) => { const a = at / total; at += t.length; const b = at / total; at += 1; return [t, round(a), round(b)]; });
      const rad = (angle * Math.PI) / 180;
      const hx = (Math.abs(Math.cos(rad)) * len + Math.abs(Math.sin(rad)) * th) / 2;
      const hy = (Math.abs(Math.sin(rad)) * len + Math.abs(Math.cos(rad)) * th) / 2;
      const a = toPicture(cx - hx, cy - hy);
      const b = toPicture(cx + hx, cy + hy);
      regions.push({
        text: tokens.join(' '),
        x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: round(Math.abs(a[0] - b[0])), h: round(Math.abs(a[1] - b[1])),
        words, a: round(angle - 90 * turns), len: round(len / shownW), th: round(th / shownW),
        ...(Array.isArray(run.edge) ? { edge: run.edge } : {}),
      });
      tilted.push(run);
      continue;
    }
    // The LINE box — where the selectable text is laid: the words' own extent.
    const a = toPicture(run.x0, run.y0);
    const b = toPicture(run.x1, run.y1);
    const x = Math.min(a[0], b[0]); const y = Math.min(a[1], b[1]);
    const w = Math.abs(a[0] - b[0]); const h = Math.abs(a[1] - b[1]);
    if (!(w > 0) || !(h > 0)) continue;
    // Where each WORD starts and ends ALONG the line (0…1 of its length): the
    // pane lays every word where it really is — one stretch for a whole line
    // drifts, because words are not spaced in a photograph the way a font spaces
    // them ("11   03   2005").
    const span = Math.max(1, run.x1 - run.x0);
    // …and, when they were measured for these very letters, where its letters
    // meet (the 4th entry, same fractions).
    const words = run.boxes.filter((q) => q.t).map((q) => {
      const w = [q.t, round((q.x0 - run.x0) / span), round((q.x1 - run.x0) / span)];
      if (Array.isArray(q.cuts) && q.cuts.length === Array.from(q.t).length - 1) w.push(q.cuts.map((c) => round((c - run.x0) / span)));
      return w;
    });
    regions.push({ text: run.text, x, y, w: round(w), h: round(h), words, ...(Array.isArray(run.edge) ? { edge: run.edge } : {}) });
    kept.push(run);
  }
  const heights = kept.concat(tilted).map((r) => r.letterH).sort((m, n) => m - n);
  const letter = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  // Padding and reach are measured in letters — but a blot read as one giant
  // "letter" (a flag, a signature) must not get a giant margin: no run counts
  // as taller than 1.6 of the picture's typical letter.
  for (const r of kept) r.ref = Math.min(r.letterH, letter * 1.6);
  const rects = kept.flatMap(runRects).concat(bridgeRects(kept));
  const shapes = unionLoops(rects, Math.max(1, letter * 0.12)).map((loop) => loop.map(([px, py]) => toPicture(px, py)));
  // A tilted line is lit by its own quadrilateral (padded like an upright one),
  // clockwise like the loops above.
  for (const run of tilted) {
    const { cx, cy, angle, len, th } = run.tilt;
    const pad = Math.max(2, Math.min(run.letterH, letter * 1.6) * 0.26);
    const rad = (angle * Math.PI) / 180;
    const ux = Math.cos(rad); const uy = Math.sin(rad);
    const hl = len / 2 + pad; const ht = th / 2 + pad;
    const corner = (s, t) => toPicture(cx + ux * hl * s - uy * ht * t, cy + uy * hl * s + ux * ht * t);
    shapes.push([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);
  }
  return { regions, shapes };
}

// `pages` = one reading of the picture, or several of the SAME turned canvas
// (see detectLocally): a later one only contributes words on ground the earlier
// ones left untouched. → the runs, in reading order.
function runsFromPages(pages) {
  let runs = [];
  const taken = [];
  for (const data of pages) {
    const fresh = collectRuns(data, taken);
    for (const r of fresh) taken.push(...r.boxes);
    runs = runs.concat(fresh);
  }
  return readingOrder(dropDuplicates(runs));
}
// How much CONFIDENT text a reading found — what orientations are judged by
// (judged only: the unsure pieces are still among the runs).
function scoreRuns(runs) {
  let inkChars = 0;
  let confSum = 0;
  for (const run of runs) if (run.conf >= SCORE_MIN_CONF) { inkChars += run.ink; confSum += run.conf * run.ink; }
  return { score: inkChars ? confSum / 100 : 0, mean: inkChars ? confSum / inkChars : 0 };
}

// ── PaddleOCR ───────────────────────────────────────────────────────────
// The picture at the detector's size: long edge ≤ 1920px (a phone photo's small
// print stays several pixels tall), small pictures up to 2× — upscaling further
// only blurs.
const PADDLE_EDGE = 1920;
function paddleCanvas(el, turns) {
  const natW = el.naturalWidth; const natH = el.naturalHeight;
  const scale = Math.min(2, PADDLE_EDGE / Math.max(natW, natH));
  const w = Math.max(1, Math.round(natW * scale)); const h = Math.max(1, Math.round(natH * scale));
  const canvas = document.createElement('canvas');
  const side = turns % 2 === 1;
  canvas.width = side ? h : w; canvas.height = side ? w : h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((turns * Math.PI) / 2);
  ctx.drawImage(el, -w / 2, -h / 2, w, h);
  return canvas;
}
// A detected LINE → a run as the rest of this file knows it. The detector's box
// carries a margin round the letters (its "unclip"), trimmed back a little; the
// WORDS are laid along it by their length (the recogniser reads a whole line —
// it doesn't place each word).
// A line tilted more than this (degrees) keeps its tilt: its selectable text and
// its lit shape are laid along it, not in an upright box round it.
const TILT_MIN = 1.5;
function runFromLine(line) {
  const t = line.thick;
  const x0 = line.x0 + t * 0.05; const x1 = Math.max(x0 + 1, line.x1 - t * 0.05);
  const y0 = line.y0 + t * 0.1; const y1 = Math.max(y0 + 1, line.y1 - t * 0.1);
  const tokens = line.text.split(' ').filter(Boolean);
  const total = tokens.reduce((n, w) => n + w.length, 0) + Math.max(0, tokens.length - 1);
  let at = 0;
  const boxes = tokens.map((w) => {
    const a = x0 + (at / total) * (x1 - x0);
    at += w.length;
    const b = x0 + (at / total) * (x1 - x0);
    at += 1;
    return { x0: Math.round(a), y0: Math.round(y0), x1: Math.round(b), y1: Math.round(y1), ink: hasInk(w), t: w };
  });
  // The line as it lies — centre, length and thickness along its own tilt, the
  // detector's margin trimmed the same way.
  const tilt = Math.abs(line.angle) >= TILT_MIN && Math.abs(line.angle) <= 60 ? {
    cx: Math.round(line.cx), cy: Math.round(line.cy), angle: Math.round(line.angle * 100) / 100,
    len: Math.max(1, Math.round(line.along - t * 0.1)), th: Math.max(1, Math.round(t * 0.8)),
  } : null;
  // Every letter's centre as the recogniser saw it (lib/paddleCharPos) — kept
  // only when there is one per letter of the text.
  const letters = tokens.reduce((n, w) => n + Array.from(w).length, 0);
  const charAt = Array.isArray(line.chars) && line.chars.length === letters ? line.chars : null;
  return {
    text: tokens.join(' '), conf: line.conf, ink: line.text.replace(/[^\p{L}\p{N}]/gu, '').length,
    letterH: Math.max(1, Math.round(t * 0.75)),
    x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1), boxes, tilt, charAt,
  };
}
// ── Fitting the words to the INK ────────────────────────────────────────
// The detector gives a box per LINE only, and runFromLine shares it among the
// words by their letter counts — a guess that drifts along the line (an "M" is
// wider than an "i", a photograph spaces words as it likes). Here every line
// is looked at in the picture itself: the band along it is sampled (along its
// tilt for a tilted line), split into ink and ground (Otsu; the ink is the
// smaller class, so light text on a dark ground works too), and
//   · the line's START and END are moved onto its first and last ink,
//   · its TOP and BOTTOM onto the rows its letters actually cover,
//   · every word boundary onto a real blank gap between the letters — the
//     gaps are matched to the words in order (dynamic programming: a wide gap
//     near where the letter count put the boundary wins).
// Anything that doesn't add up (no contrast, too few gaps, a height far from
// the detector's) leaves that part as it was. Local and cheap: one
// getImageData per reading.
// Bump when the fitting changes: saved readings are refitted. 1 = first fit
// (grew into neighbouring lines, kept no raw geometry); 2 = core + valley
// vertical fit, raw geometry kept; 3 = each word's letters placed (charCuts);
// 4 = measured at full resolution, sub-pixel, along each line's own slant;
// 5 = letters from the recogniser's own columns, the line's edges along it.
const INK_FIT = 5;
function lumaOf(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const lum = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < lum.length; i += 1, p += 4) lum[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  return { lum, width, height };
}
function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let sumB = 0; let wB = 0; let best = -1; let level = 128; let mB = 0; let mF = 0;
  for (let i = 0; i < 256; i += 1) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const b = sumB / wB; const f = (sum - sumB) / wF;
    const v = wB * wF * (b - f) * (b - f);
    if (v > best) { best = v; level = i; mB = b; mF = f; }
  }
  return { level, contrast: mF - mB };
}
// One line, in its own frame: `s` along it (0 … len), `t` across it (−th/2 …
// th/2), centred on (cx, cy) at `angle` degrees. → the fitted extents in that
// frame, or null.
// Bilinear sample of the luminance at a sub-pixel point (white off the picture).
function lumAt(img, x, y) {
  const x0 = Math.floor(x); const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= img.width || y0 + 1 >= img.height) {
    const xi = Math.round(x); const yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < img.width && yi < img.height ? img.lum[yi * img.width + xi] : 255;
  }
  const fx = x - x0; const fy = y - y0;
  const i = y0 * img.width + x0;
  const a = img.lum[i] + (img.lum[i + 1] - img.lum[i]) * fx;
  const b = img.lum[i + img.width] + (img.lum[i + img.width + 1] - img.lum[i + img.width]) * fx;
  return Math.round(a + (b - a) * fy);
}
// `frame` = the line as the detector placed it. The line's real SLANT is
// measured first (the letters' ink centre along it, a weighted straight-line
// fit) and, when it differs, the line is sampled again along that slant from
// its ink's own middle — a long line a fraction of a degree off level drifts
// across several rows otherwise, and no box laid level can sit on it. The
// answer carries the frame it was measured in (`frame`).
function fitLineToInk(img, frame, tokens, { reslanted = false, centers = null } = {}) {
  const { cx, cy, angle, len, th } = frame;
  if (!(len > 4) || !(th > 3) || !tokens.length) return null;
  const rad = (angle * Math.PI) / 180;
  const ux = Math.cos(rad); const uy = Math.sin(rad);
  const nx = -uy; const ny = ux;
  const padS = Math.round(th * 0.5); const padT = Math.round(th * 0.25);
  const S = Math.round(len) + 2 * padS; const T = Math.round(th) + 2 * padT;
  if (S * T > 6e6) return null;
  const grid = new Uint8Array(S * T);
  const hist = new Uint32Array(256);
  for (let j = 0; j < T; j += 1) {
    const t = j - padT - th / 2;
    for (let i = 0; i < S; i += 1) {
      const s = i - padS - len / 2;
      const v = lumAt(img, cx + ux * s + nx * t, cy + uy * s + ny * t);
      grid[j * S + i] = v;
      // The histogram is taken on the line's own band (not the margins, which
      // may hold a neighbouring line).
      if (j >= padT && j < T - padT) hist[v] += 1;
    }
  }
  const { level, contrast } = otsu(hist, Math.round(th) * S);
  if (contrast < 28) return null;   // no ink to speak of: keep the estimate
  let dark = 0; let all = 0;
  for (let v = 0; v < 256; v += 1) { all += hist[v]; if (v <= level) dark += hist[v]; }
  const inkDark = dark <= all / 2;
  const isInk = (v) => (inkDark ? v <= level : v > level);
  // SLANT — the ink's centre row in short pieces along the line, fitted with a
  // straight line (weighted by how much ink each piece holds).
  if (!reslanted) {
    const inner = S - 2 * padS;
    const pieces = Math.max(3, Math.min(32, Math.round(inner / Math.max(4, th * 1.2))));
    const step = inner / pieces;
    let sw = 0; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let used = 0;
    for (let k = 0; k < pieces; k += 1) {
      const i0 = Math.floor(padS + k * step); const i1 = Math.floor(padS + (k + 1) * step);
      let w = 0; let m = 0;
      for (let j = padT; j < T - padT; j += 1) {
        let n = 0;
        for (let i = i0; i < i1; i += 1) if (isInk(grid[j * S + i])) n += 1;
        w += n; m += n * j;
      }
      if (w < (i1 - i0) * 0.5) continue;   // next to no ink: says nothing
      const x = (i0 + i1) / 2 - (padS + len / 2); const y = m / w;
      sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y; used += 1;
    }
    const den = sw * sxx - sx * sx;
    if (used >= 3 && den > 0) {
      const slope = (sw * sxy - sx * sy) / den;
      const mid = (sy - slope * sx) / sw;   // the fitted row at the line's middle (s = 0)
      const dDeg = (Math.atan(slope) * 180) / Math.PI;
      const tOff = mid - (padT + th / 2);
      if (Math.abs(dDeg) <= 8 && (Math.abs(dDeg) >= 0.03 || Math.abs(tOff) >= 0.5)) {
        const again = fitLineToInk(img, {
          cx: cx + nx * tOff, cy: cy + ny * tOff, angle: angle + dDeg, len, th,
        }, tokens, { reslanted: true, centers });
        if (again) return again;
      }
    }
  }
  // ACROSS — the rows THIS line's letters cover. Lines in a photograph sit
  // close and the blur between them is never quite empty, so growing out to
  // "any ink" ran into the next line. Instead: the CORE (the x-height band —
  // rows at least 35% as inked as the fullest, around the fullest row nearest
  // the band's middle), then out from it for ascenders and descenders only
  // while the ink keeps FALLING (a rise is the next line) and never more than
  // 0.6 of the core's height on either side.
  const rowInk = new Float64Array(T);
  for (let j = 0; j < T; j += 1) for (let i = padS; i < S - padS; i += 1) if (isInk(grid[j * S + i])) rowInk[j] += 1;
  // A light smoothing, so one noisy row doesn't end the walk.
  const rows = new Float64Array(T);
  for (let j = 0; j < T; j += 1) rows[j] = (rowInk[Math.max(0, j - 1)] + 2 * rowInk[j] + rowInk[Math.min(T - 1, j + 1)]) / 4;
  const mid = padT + th / 2;
  let maxRow = 0;
  for (let j = padT; j < T - padT; j += 1) maxRow = Math.max(maxRow, rows[j]);
  if (!maxRow) return null;
  const coreMin = maxRow * 0.35;
  // The core nearest the middle (a band may still hold a sliver of a
  // neighbouring line at its edge).
  let peak = -1;
  for (let j = padT; j < T - padT; j += 1) {
    if (rows[j] < coreMin) continue;
    if (peak < 0 || Math.abs(j - mid) < Math.abs(peak - mid)) peak = j;
  }
  if (peak < 0) return null;
  let cTop = peak; let cBot = peak;
  while (cTop > 0 && rows[cTop - 1] >= coreMin) cTop -= 1;
  while (cBot < T - 1 && rows[cBot + 1] >= coreMin) cBot += 1;
  const coreH = cBot - cTop + 1;
  const reach = Math.max(2, Math.round(coreH * 0.6));
  const edgeMin = maxRow * 0.04;
  const walk = (from, dir) => {
    let at = from; let low = rows[from];
    for (let n = 1; n <= reach; n += 1) {
      const j = from + dir * n;
      if (j < 0 || j >= T) break;
      const v = rows[j];
      if (v < edgeMin) break;                         // ground: the letters end
      if (v > low * 1.25 + maxRow * 0.03) break;      // rising: the next line
      low = Math.min(low, v);
      at = j;
    }
    return at;
  };
  const top = walk(cTop, -1); const bottom = walk(cBot, 1);
  let t0 = top - padT - th / 2; let t1 = bottom + 1 - padT - th / 2;
  const fittedTh = t1 - t0;
  if (fittedTh < th * 0.35 || fittedTh > th * 1.3) { t0 = -th / 2; t1 = th / 2; }
  // ALONG — ink columns (counted on the rows just found).
  const r0 = Math.max(0, Math.round(t0 + th / 2 + padT)); const r1 = Math.min(T, Math.round(t1 + th / 2 + padT));
  const colMin = Math.max(1, Math.round((r1 - r0) * 0.04));
  const ink = new Uint8Array(S);
  const colInk = new Float64Array(S);   // how much ink each column holds
  for (let i = 0; i < S; i += 1) {
    let n = 0;
    for (let j = r0; j < r1; j += 1) if (isInk(grid[j * S + i])) n += 1;
    colInk[i] = n;
    ink[i] = n >= colMin ? 1 : 0;
  }
  // Clusters of ink (letters closer than a third of the line's height) — the
  // line is the clusters that reach into the detector's own extent.
  const join = Math.max(2, th * 0.35);
  const blobs = [];
  for (let i = 0; i < S; i += 1) {
    if (!ink[i]) continue;
    const last = blobs[blobs.length - 1];
    if (last && i - last[1] <= join) last[1] = i; else blobs.push([i, i]);
  }
  const kept = blobs.filter(([a, b]) => b >= padS && a < S - padS);
  if (!kept.length) return null;
  const start = kept[0][0]; const end = kept[kept.length - 1][1] + 1;
  if (end - start < len * 0.4) return null;
  // The blank gaps inside the line.
  const gaps = [];
  for (let i = start; i < end; i += 1) {
    if (ink[i]) continue;
    let k = i;
    while (k < end && !ink[k]) k += 1;
    gaps.push({ a: i, b: k, w: k - i, c: (i + k) / 2 });
    i = k;
  }
  // Where the letter counts would put each boundary, on the fitted extent —
  // or, when the recogniser said where every letter is (`centers`, projected
  // onto this frame's columns), halfway between the last letter of a word and
  // the first of the next.
  const total = tokens.reduce((n, w) => n + w.length, 0) + tokens.length - 1;
  const letterCount = tokens.reduce((n, w) => n + Array.from(w).length, 0);
  const cols = Array.isArray(centers) && centers.length === letterCount
    ? centers.map(([px, py]) => (px - cx) * ux + (py - cy) * uy + padS + len / 2)
    : null;
  const wordCols = [];
  if (cols) { let q = 0; for (const w of tokens) { const n = Array.from(w).length; wordCols.push(cols.slice(q, q + n)); q += n; } }
  const expect = [];
  let at = 0;
  for (let k = 0; k < tokens.length - 1; k += 1) {
    at += tokens[k].length;
    expect.push(cols
      ? (wordCols[k][wordCols[k].length - 1] + wordCols[k + 1][0]) / 2
      : start + ((at + 0.5) / total) * (end - start));
    at += 1;
  }
  let cuts = [];
  const need = expect.length;
  if (need && gaps.length >= need) {
    // dp[k][g]: the best score with boundary k on gap g (gaps in order).
    const G = gaps.length;
    const gain = (k, g) => 4 * Math.min(gaps[g].w, th * 0.7) / th - 0.6 * Math.abs(gaps[g].c - expect[k]) / th;
    let prev = new Float64Array(G).fill(-Infinity);
    const from = [];
    for (let g = 0; g < G; g += 1) prev[g] = gain(0, g);
    from.push(new Int32Array(G).fill(-1));
    for (let k = 1; k < need; k += 1) {
      const cur = new Float64Array(G).fill(-Infinity);
      const back = new Int32Array(G).fill(-1);
      let bestPrev = -Infinity; let bestAt = -1;
      for (let g = 0; g < G; g += 1) {
        if (g > 0 && prev[g - 1] > bestPrev) { bestPrev = prev[g - 1]; bestAt = g - 1; }
        if (bestAt >= 0) { cur[g] = bestPrev + gain(k, g); back[g] = bestAt; }
      }
      from.push(back); prev = cur;
    }
    let g = 0;
    for (let i = 1; i < G; i += 1) if (prev[i] > prev[g]) g = i;
    if (Number.isFinite(prev[g])) {
      for (let k = need - 1; k >= 0; k -= 1) { cuts.unshift(gaps[g]); g = from[k][g]; }
    }
  }
  // Each word from the ink after one boundary to the ink before the next; a
  // line whose gaps couldn't be matched keeps the letter-count split, laid on
  // the fitted extent.
  let words;
  if (cuts.length === need) {
    words = tokens.map((w, k) => [w, k === 0 ? start : cuts[k - 1].b, k === need ? end : cuts[k].a]);
  } else {
    cuts = [];
    let p = 0;
    words = tokens.map((w) => { const a = start + (p / total) * (end - start); p += w.length; const b = start + (p / total) * (end - start); p += 1; return [w, a, b]; });
  }
  if (words.some(([, a, b]) => !(b > a))) return null;
  const off = padS + len / 2;   // grid column → s (centred frame)
  const wordsOut = words.map(([w, a, b], k) => [w, a - off, b - off, charCuts(colInk, a, b, w, cols ? wordCols[k] : null).map((c) => c - off)]);
  // THE LINE'S EDGES ALONG IT — where the letters' tops and bottoms actually
  // are, so a selection can follow text that grows or shrinks along the line (a
  // page photographed at an angle). Every letter's own top and bottom ink row
  // is measured; a straight line through the tops is moved up to the highest
  // tenth of them, one through the bottoms down to the lowest tenth.
  // A letter's top and bottom are found by growing from the line's middle
  // through ITS OWN ink (a gap of up to a sixth of the line's height is crossed —
  // the dot of an i, the breve of an ă), out to the edge of the sampled band:
  // a letter that is taller than the line's measured band (the big end of a
  // line in perspective) is followed, a neighbouring line beyond a real gap is
  // not.
  const edges = [];
  const midRow = Math.round((t0 + t1) / 2 + th / 2 + padT);
  const gapMax = Math.max(1, Math.round(th / 6));
  for (const [, a, b, cuts] of wordsOut) {
    const bounds = [a, ...cuts, b].map((v) => v + off);
    for (let i = 0; i + 1 < bounds.length; i += 1) {
      const c0 = Math.max(0, Math.round(bounds[i])); const c1 = Math.min(S, Math.round(bounds[i + 1]));
      if (c1 - c0 < 1) continue;
      const has = (j) => { for (let x = c0; x < c1; x += 1) if (isInk(grid[j * S + x])) return true; return false; };
      // The ink row nearest the middle (the letter's body).
      let seed = -1;
      for (let d = 0; d <= Math.round(th / 2) && seed < 0; d += 1) {
        if (midRow - d >= 0 && has(midRow - d)) seed = midRow - d;
        else if (midRow + d < T && has(midRow + d)) seed = midRow + d;
      }
      if (seed < 0) continue;
      let top = seed; let gap = 0;
      for (let j = seed - 1; j >= 0; j -= 1) { if (has(j)) { top = j; gap = 0; } else if (++gap > gapMax) break; }
      let bot = seed + 1; gap = 0;
      for (let j = seed + 1; j < T; j += 1) { if (has(j)) { bot = j + 1; gap = 0; } else if (++gap > gapMax) break; }
      edges.push({ s: (c0 + c1) / 2 - off, top: top - padT - th / 2, bot: bot - padT - th / 2 });
    }
  }
  let edge = null;
  if (edges.length >= 2) {
    const fitSide = (key, upper) => {
      const n = edges.length;
      let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
      for (const e of edges) { sx += e.s; sy += e[key]; sxx += e.s * e.s; sxy += e.s * e[key]; }
      const den = n * sxx - sx * sx;
      const m = den > 0 ? (n * sxy - sx * sy) / den : 0;
      const c = (sy - m * sx) / n;
      const res = edges.map((e) => e[key] - (m * e.s + c)).sort((x, y) => x - y);
      const q = res[Math.min(n - 1, Math.max(0, Math.round((upper ? 0.1 : 0.9) * (n - 1))))];
      return [c + q, m];   // value at s = 0, slope
    };
    const [tc, tm] = fitSide('top', true);
    const [bc, bm] = fitSide('bot', false);
    // Never beyond the sampled band, never inside out.
    const clampT = (v) => Math.min(T - padT - th / 2, Math.max(-padT - th / 2, v));
    const sL = start - off; const sR = end - off;
    const tl = clampT(tc + tm * sL); const tr = clampT(tc + tm * sR);
    const bl = clampT(bc + bm * sL); const br = clampT(bc + bm * sR);
    if (bl - tl > 1 && br - tr > 1) {
      edge = { tl, tr, bl, br };
      // The line's band covers its edges (the letters' cells, which take the
      // pointer, are as tall as the band).
      t0 = Math.min(t0, tl, tr); t1 = Math.max(t1, bl, br);
    }
  }
  return {
    frame: { cx, cy, angle },
    s0: start - off, s1: end - off, t0, t1, edge,
    // Each word also carries where its LETTERS meet (charCuts): what a drag
    // selects is then the letters under the pointer, not a font's guess.
    words: wordsOut,
  };
}
// The width a character takes in an ordinary sans-serif, relative — how a word's
// room is first shared among its letters before the ink corrects it.
let glyphCtx = null;
const glyphMemo = new Map();
function glyphWidth(ch) {
  if (glyphMemo.has(ch)) return glyphMemo.get(ch);
  let w = 0.55;
  try {
    if (!glyphCtx && typeof document !== 'undefined') glyphCtx = document.createElement('canvas').getContext('2d');
    if (glyphCtx) { glyphCtx.font = '100px Arial, Helvetica, sans-serif'; w = glyphCtx.measureText(ch).width / 100 || w; }
  } catch { /* the estimate stands */ }
  glyphMemo.set(ch, w);
  return w;
}
// Where the letters of ONE word meet, in grid columns between `a` and `b`
// (n letters → n − 1 cuts). The letters are first given their font's share of
// the word, then every boundary is moved onto the column with the LEAST ink
// near it — the gap (or the thinnest join, where blurred letters touch)
// between two letters — by dynamic programming over the boundaries in order:
// little ink and little distance from the font's estimate both count.
function charCuts(colInk, a, b, word, centers = null) {
  const chars = Array.from(word);
  const n = chars.length;
  if (n < 2 || b - a < n) return [];
  const widths = chars.map(glyphWidth);
  const total = widths.reduce((x, y) => x + y, 0) || n;
  const span = b - a;
  const expect = [];
  let acc = 0;
  // The recogniser's letter centres, when known and in order: each boundary
  // starts halfway between two centres. Otherwise the font's letter widths.
  const usable = Array.isArray(centers) && centers.length === n && centers.every((c, i) => i === 0 || c > centers[i - 1]);
  for (let k = 0; k < n - 1; k += 1) {
    acc += widths[k];
    expect.push(usable ? Math.min(b - 1, Math.max(a + 1, (centers[k] + centers[k + 1]) / 2)) : a + (acc / total) * span);
  }
  const avg = span / n;
  const win = Math.max(1, Math.round(avg * 0.85));
  let peak = 0;
  for (let i = a; i < b; i += 1) peak = Math.max(peak, colInk[i]);
  if (!peak) return expect;
  // A column's cost: its ink, lightly smoothed (one stray pixel is not a
  // letter), plus how far it is from where the font put the boundary.
  const inkAt = (i) => (colInk[i - 1] + 2 * colInk[i] + colInk[i + 1]) / (4 * peak);
  const cands = expect.map((e) => {
    const out = [];
    for (let c = Math.max(a + 1, Math.round(e - win)); c <= Math.min(b - 1, Math.round(e + win)); c += 1) {
      const d = (c - e) / avg;
      out.push({ c, cost: inkAt(c) * 3 + d * d * 0.6 });
    }
    return out;
  });
  if (cands.some((x) => !x.length)) return expect;
  // dp over boundaries: each strictly right of the one before.
  let prev = cands[0].map((x) => ({ cost: x.cost, from: -1 }));
  const backs = [prev];
  for (let k = 1; k < cands.length; k += 1) {
    const cur = cands[k].map((x) => {
      let best = Infinity; let from = -1;
      cands[k - 1].forEach((y, j) => { if (y.c < x.c && prev[j].cost < best) { best = prev[j].cost; from = j; } });
      return { cost: best + x.cost, from };
    });
    backs.push(cur); prev = cur;
  }
  let j = 0;
  for (let i = 1; i < prev.length; i += 1) if (prev[i].cost < prev[j].cost) j = i;
  if (!Number.isFinite(prev[j].cost)) return expect;
  const cuts = new Array(cands.length);
  for (let k = cands.length - 1; k >= 0; k -= 1) { cuts[k] = cands[k][j].c; j = backs[k][j].from; }
  return cuts;
}
// The picture at the resolution the fitting works at: its FULL size (a long
// edge up to FIT_EDGE), turned like the reading — the detector's <=1920px copy
// loses the half-pixels that decide where a letter ends, and the viewer zooms
// to 800%.
const FIT_EDGE = 6000;
function fitCanvas(el, turns, base) {
  const natW = el.naturalWidth || el.width; const natH = el.naturalHeight || el.height;
  const side = turns % 2 === 1;
  const baseW = side ? base.height : base.width;   // the base canvas's width, unturned
  const scale = Math.max(baseW / natW, Math.min(1, FIT_EDGE / Math.max(natW, natH)));
  const w = Math.max(1, Math.round(natW * scale)); const h = Math.max(1, Math.round(natH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = side ? h : w; canvas.height = side ? w : h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((turns * Math.PI) / 2);
  ctx.drawImage(el, -w / 2, -h / 2, w, h);
  return canvas;
}
// The runs of ONE reading (PaddleOCR's, in `base`'s pixels - the detector's
// canvas) fitted to the ink of the picture `el` at full resolution. Returns new
// runs in `base`'s pixels, kept to a hundredth of a pixel (no rounding to whole
// pixels: at 800% one is many screen pixels). A line found slanted by more
// than SLANT_MIN degrees becomes a tilted run, laid along its slant.
const SLANT_MIN = 0.12;
const r2 = (v) => Math.round(v * 100) / 100;
function fitRunsToInk(el, turns, base, runs) {
  let img; let k = 1;
  try {
    const big = el ? fitCanvas(el, turns, base) : base;
    k = big.width / base.width;
    img = lumaOf(big);
  } catch {
    try { img = lumaOf(base); k = 1; } catch { return runs; }
  }
  return runs.map((given) => {
    // Always fitted from the DETECTOR's own geometry (kept as `raw` the first
    // time), never from an earlier fit - refitting must not compound.
    const raw = given.raw || { x0: given.x0, y0: given.y0, x1: given.x1, y1: given.y1, tilt: given.tilt || null, boxes: given.boxes };
    const run = { ...given, x0: raw.x0, y0: raw.y0, x1: raw.x1, y1: raw.y1, tilt: raw.tilt, boxes: raw.boxes, raw };
    const tokens = run.text.split(' ').filter(Boolean);
    try {
      const start = run.tilt
        ? { cx: run.tilt.cx, cy: run.tilt.cy, angle: run.tilt.angle, len: run.tilt.len, th: run.tilt.th }
        : { cx: (run.x0 + run.x1) / 2, cy: (run.y0 + run.y1) / 2, angle: 0, len: run.x1 - run.x0, th: run.y1 - run.y0 };
      const centers = Array.isArray(given.charAt) ? given.charAt.map((c) => [c.x * k, c.y * k]) : null;
      const f = fitLineToInk(img, { cx: start.cx * k, cy: start.cy * k, angle: start.angle, len: start.len * k, th: start.th * k }, tokens, { centers });
      if (!f) return run;
      // Back into the base canvas's pixels.
      const { cx, cy, angle } = f.frame;
      const rad = (angle * Math.PI) / 180;
      const ux = Math.cos(rad); const uy = Math.sin(rad);
      const s0 = f.s0 / k; const s1 = f.s1 / k; const t0 = f.t0 / k; const t1 = f.t1 / k;
      const len = s1 - s0;
      const ms = (s0 + s1) / 2; const mt = (t0 + t1) / 2;
      const ccx = cx / k + ux * ms - uy * mt; const ccy = cy / k + uy * ms + ux * mt;
      const words = f.words.map(([w, a, b, cuts]) => [w, a / k, b / k, cuts.map((c) => c / k)]);
      // The line's top / bottom at its two ends, as fractions of its thickness
      // from its middle (-0.5 = the top of the band): [top-left, top-right,
      // bottom-left, bottom-right].
      const thk = (t1 - t0) || 1;
      const edge = f.edge
        ? [f.edge.tl, f.edge.tr, f.edge.bl, f.edge.br].map((v) => Math.round(((v / k - mt) / thk) * 10000) / 10000)
        : null;
      if (Math.abs(angle) >= SLANT_MIN) {
        return {
          ...run,
          tilt: {
            cx: r2(ccx), cy: r2(ccy), angle: Math.round(angle * 1000) / 1000,
            len: Math.max(1, r2(len)), th: Math.max(1, r2(t1 - t0)),
            words: words.map(([w, a, b, cuts]) => [w, (a - s0) / len, (b - s0) / len, cuts.map((c) => (c - s0) / len)]),
          },
          edge,
        };
      }
      // Level: an upright box (s runs along x, t along y).
      const x0 = r2(ccx - len / 2); const x1 = r2(ccx + len / 2);
      const y0 = r2(ccy - (t1 - t0) / 2); const y1 = r2(ccy + (t1 - t0) / 2);
      const toX = (v) => r2(ccx + (v - ms));
      return {
        ...run, tilt: null, x0, y0, x1, y1, edge,
        boxes: words.map(([t, a, b, cuts]) => ({ x0: toX(a), y0, x1: toX(b), y1, ink: hasInk(t), t, cuts: cuts.map(toX) })),
      };
    } catch { return run; }
  });
}

// How well a reading went: confident characters on lines that run ACROSS the
// canvas. A line the detector found running up or down it (a sideways photo)
// counts for nothing — the text is only laid out right once it runs across, so
// such a reading asks for another quarter-turn.
function scorePaddle(runs) {
  let inkChars = 0; let confSum = 0;
  for (const r of runs) {
    const across = (r.x1 - r.x0) >= (r.y1 - r.y0) * 1.1 || r.ink <= 2;
    if (!across || r.conf < SCORE_MIN_CONF) continue;
    inkChars += r.ink; confSum += r.conf * r.ink;
  }
  return { score: inkChars ? confSum / 100 : 0, mean: inkChars ? confSum / inkChars : 0 };
}
// The same, for the lines running DOWN the canvas. The recogniser turns such a
// line a quarter-turn ANTI-clockwise before reading it (PaddleOCR's rotate
// crop), so when they read well the picture wants that same turn (3), else the
// other way (1).
function downScore(runs) {
  let s = 0;
  for (const r of runs) if ((r.y1 - r.y0) > (r.x1 - r.x0) * 1.1 && r.ink > 2 && r.conf >= SCORE_MIN_CONF) s += (r.conf * r.ink) / 100;
  return s;
}
async function detectWithPaddle(el) {
  const read = async (turns) => {
    const canvas = paddleCanvas(el, turns);
    const runs = (await readLines(canvas)).map(runFromLine).filter((r) => r.text);
    return { turns, canvas, runs, ...scorePaddle(runs) };
  };
  // Upright first; only a poor reading tries the other ways up (a phone photo
  // lying on its side is common, and its lines then run down the canvas).
  let best = await read(0);
  // Nothing found at all is an answer: the detector finds text whichever way
  // up it runs, so turning the picture won't find any.
  if (best.runs.length && !(best.score >= 10 && best.mean >= 80)) {
    for (const turns of downScore(best.runs) >= 10 ? [3, 1, 2] : [1, 3, 2]) {
      const next = await read(turns);
      if (next.score > best.score) best = next;
      if (best.score >= 10 && best.mean >= 80) break;
    }
  }
  return {
    turns: best.turns, cw: best.canvas.width, ch: best.canvas.height,
    runs: readingOrder(fitRunsToInk(el, best.turns, best.canvas, best.runs)), engine: 'paddleocr', inkFit: INK_FIT,
  };
}

// → `{ turns, cw, ch, runs }`: the measured pieces, in the pixels of the picture
// turned `turns` quarter-turns clockwise at `cw`×`ch`. PaddleOCR; Tesseract only
// when PaddleOCR can't run.
async function detectLocally(el) {
  try {
    return await detectWithPaddle(el);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[text-regions] PaddleOCR could not run, falling back to Tesseract:', err);
    return detectWithTesseract(el);
  }
}

async function detectWithTesseract(el) {
  const worker = await getWorker();
  const { PSM } = await import('tesseract.js');
  const recognize = async (canvas, mode) => {
    await worker.setParameters({ tessedit_pageseg_mode: mode });
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
    return data;
  };
  const read = async (turns) => {
    const canvas = ocrCanvas(el, turns);
    const data = await recognize(canvas, PSM.SPARSE_TEXT);
    return { turns, canvas, data, ...scoreRuns(runsFromPages([data])) };
  };
  // Upright first. A reading that found a fair amount of confident text IS the
  // orientation; only a poor one (a phone photo lying on its side reads as
  // noise) is worth three more passes to find which way up the text runs.
  let best = await read(0);
  if (!(best.score >= 12 && best.mean >= 72)) {
    for (const turns of [1, 3, 2]) {
      const next = await read(turns);
      if (next.score > best.score) best = next;
      if (best.score >= 12 && best.mean >= 80) break;
    }
  }
  // A SECOND reading of the winning orientation, laid out the other way: sparse
  // mode finds text scattered over a card, page mode finds lines and paragraphs
  // — each misses some of what the other sees. Its words are added wherever the
  // first reading found nothing.
  let pages = [best.data];
  try { pages = [best.data, await recognize(best.canvas, PSM.AUTO)]; } catch { /* the first reading stands */ }
  const int = (v) => Math.round(v);
  const runs = runsFromPages(pages).map((r) => ({
    text: r.text, conf: int(r.conf), ink: r.ink, letterH: int(r.letterH),
    x0: int(r.x0), y0: int(r.y0), x1: int(r.x1), y1: int(r.y1),
    boxes: r.boxes.map((q) => ({ x0: int(q.x0), y0: int(q.y0), x1: int(q.x1), y1: int(q.y1), ink: q.ink, t: q.t })),
  }));
  return { turns: best.turns, cw: best.canvas.width, ch: best.canvas.height, runs, engine: 'tesseract' };
}

// ── The AI reads the pieces ─────────────────────────────────────────────
// Every measured run is cut out of the upright picture (with a little of its
// surroundings), scaled so its text is a comfortable size, and stacked on SHEETS
// with its number in the margin. The model transcribes strip by strip.
function buildSheets(src, runs) {
  const sheets = [];
  let canvas = null; let ctx = null; let y = 0; let ids = [];
  const open = () => {
    canvas = document.createElement('canvas');
    canvas.width = SHEET_W; canvas.height = SHEET_MAX_H;
    ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, SHEET_W, SHEET_MAX_H);
    ctx.imageSmoothingQuality = 'high';
    y = 0; ids = [];
  };
  const close = () => {
    if (!ids.length) return;
    const out = document.createElement('canvas');
    out.width = SHEET_W; out.height = Math.max(1, y);
    out.getContext('2d').drawImage(canvas, 0, 0);
    const url = out.toDataURL('image/jpeg', 0.9);
    sheets.push({ data: url.slice(url.indexOf(',') + 1), ids });
  };
  open();
  for (let i = 0; i < runs.length; i += 1) {
    const r = runs[i];
    const textH = Math.max(4, Math.min(r.y1 - r.y0, (r.ref || r.letterH) * 1.8));
    const mx = textH * 0.6; const my = Math.max(3, textH * 0.3);
    const sx = Math.max(0, r.x0 - mx); const sy = Math.max(0, r.y0 - my);
    const sw = Math.min(src.width - sx, r.x1 - r.x0 + mx * 2); const sh = Math.min(src.height - sy, r.y1 - r.y0 + my * 2);
    if (!(sw >= 2) || !(sh >= 2)) continue;
    const k = Math.min(3, STRIP_TEXT_H / textH, (SHEET_W - STRIP_GUTTER - 8) / sw, 300 / sh);
    const w = Math.max(1, Math.round(sw * k)); const h = Math.max(24, Math.round(sh * k));
    if (y + h + 6 > SHEET_MAX_H) { close(); if (sheets.length >= SHEET_MAX) return sheets; open(); }
    ctx.fillStyle = '#000000'; ctx.font = 'bold 20px sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), 8, y + h / 2);
    ctx.drawImage(src, sx, sy, sw, sh, STRIP_GUTTER, y, w, Math.round(sh * k));
    ctx.fillStyle = '#c8c8c8'; ctx.fillRect(0, y + h + 2, SHEET_W, 1);
    ids.push(i);
    y += h + 6;
  }
  close();
  return sheets;
}

function sheetsPrompt(count) {
  return [
    `These ${count > 1 ? `${count} images are sheets` : 'image is a sheet'} of numbered strips, each strip cut from the same photograph of a document. The number in the left margin names the strip beside it.`,
    'For EVERY numbered strip, transcribe the text in it.',
    '',
    'Respond with ONLY a JSON object — no prose, no code fence — mapping each strip number to its text:',
    '{"lines":{"1":"ROMÂNIA","2":"Nume / Surname","3":""}}',
    '',
    'Rules:',
    '- Transcribe EXACTLY what is printed: keep diacritics (Romanian ă â î ș ț), case, punctuation, spacing between groups of digits. Never correct, translate, expand or complete.',
    '- A strip holds ONE line — the one running through its middle. Ignore slivers of other lines cut off at its top or bottom edge.',
    '- A strip with no readable text (a picture, a pattern, a signature, a smudge) gets "" — never guess.',
    '- The margin numbers are not part of the text. Answer for every number you see.',
  ].join('\n');
}

function parseSheets(reply) {
  const raw = String(reply || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const braced = /\{[\s\S]*\}/.exec(raw);
  for (const candidate of [fenced?.[1], braced?.[0], raw]) {
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate);
      const lines = obj?.lines ?? obj;
      if (!lines || typeof lines !== 'object') continue;
      const out = new Map();
      if (Array.isArray(lines)) {
        for (const l of lines) if (l && l.n != null) out.set(Number(l.n), String(l.text ?? ''));
      } else {
        for (const [k, v] of Object.entries(lines)) if (/^\d+$/.test(k)) out.set(Number(k), String(v ?? ''));
      }
      if (out.size) return out;
    } catch { /* try the next shape */ }
  }
  return null;
}

// → an array aligned with `runs`: the AI's text for each ('' = no text there,
// null = it wasn't asked / didn't answer for that one), or `{ error }`.
async function readRunsWithAi(el, local, { projectId } = {}) {
  const src = local.engine === 'paddleocr' ? paddleCanvas(el, local.turns) : ocrCanvas(el, local.turns);
  const sheets = buildSheets(src, local.runs);
  if (!sheets.length) return [];
  const askAi = (await import('./aiEngine')).askAi;
  const res = await askAi({
    surface: 'tool', timeoutMs: 180_000,
    messages: [{
      role: 'user',
      content: [
        ...sheets.map((sh) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sh.data } })),
        { type: 'text', text: sheetsPrompt(sheets.length) },
      ],
    }],
    model: MODEL,
    usageProject: projectId,
    usageAction: 'text-regions',
  });
  if (res?.error) return { error: String(res.error?.message || res.error) };
  const answers = parseSheets(res.text);
  if (!answers) return { error: 'unparsable' };
  return local.runs.map((_, i) => (answers.has(i + 1) ? answers.get(i + 1).replace(/\s+/g, ' ').trim() : null));
}

// The AI's text laid onto a measured run, WORD BY WORD. The engine's word boxes
// are where the ink is; the AI's words are what it says. Same count → one each.
// Fewer AI words than boxes (the engine split "LUCA -ANDRE I" in three) → the
// boxes are grouped at the WIDEST gaps, which are the real spaces. More → the
// line's length is shared out by the length of each word.
function runWithText(run, text) {
  const tokens = text.split(' ').filter(Boolean);
  const src = run.boxes;
  let boxes = null;
  if (tokens.length === src.length) {
    boxes = src.map((q, i) => ({ ...q, t: tokens[i], ink: true }));
  } else if (tokens.length < src.length) {
    const gaps = src.slice(1).map((q, i) => ({ at: i + 1, size: q.x0 - src[i].x1 }))
      .sort((m, n) => n.size - m.size).slice(0, tokens.length - 1).map((g) => g.at).sort((m, n) => m - n);
    const cuts = [0, ...gaps, src.length];
    boxes = tokens.map((t, i) => {
      const group = src.slice(cuts[i], cuts[i + 1]);
      return {
        x0: group[0].x0, x1: group[group.length - 1].x1,
        y0: Math.min(...group.map((q) => q.y0)), y1: Math.max(...group.map((q) => q.y1)), ink: true, t,
      };
    });
  } else {
    const total = tokens.reduce((n, t) => n + t.length, 0) + (tokens.length - 1);
    const span = run.x1 - run.x0;
    let at = 0;
    boxes = tokens.map((t) => {
      const x0 = run.x0 + (at / total) * span;
      at += t.length;
      const x1 = run.x0 + (at / total) * span;
      at += 1;
      return { x0, x1, y0: run.y0, y1: run.y1, ink: true, t };
    });
  }
  return { ...run, text: tokens.join(' '), boxes, local: run.text };
}

// The picture at `path`, decoded — for a reading asked for from somewhere that
// has no <img> of it on screen (the Data tab's Refresh, a background sweep).
async function decodeImageAt(path) {
  const blob = await readLocalBlob(path);
  if (!blob) throw new Error('unreadable');
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // The decoded bitmap outlives the URL; the caller draws it straight away.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

// ── The saved reading ───────────────────────────────────────────────────
// A picture is read ONCE. The reading is a facet of the file's AI data
// (lib/aiData, kind `text`: `{ text, regions }`) — the Data tab shows it, the
// Advisor quotes it, any other document in the project can ask for it — stamped
// with the file's size + mtime so an edited picture is read again.
// Bumped whenever the READING itself changes (what is kept, how it is grouped
// or shaped), so a reading saved by an older version is made again rather than
// shown. 2 = nothing filtered out + the second (page-mode) pass; 3 = lines in
// reading order + merged shapes (selectable live text); 4 = per-word extents;
// 5 = the AI transcription read alongside and merged in; 6 = reading MODE + parts;
// 7 = the AI's placing shown upright + snapped to the ink; 8 = positions always
// measured, the AI reads numbered strips (no AI coordinates anywhere);
// 9 = PaddleOCR PP-OCRv6 finds and reads the lines (Tesseract the fallback).
const READING_VERSION = 9;

// ── The reading MODE (the Data tab's debug control) ─────────────────────
//   result — whose WORDS are shown: 'ai' (each measured piece read by the AI) |
//            'local' (the engine's own reading)
// POSITIONS are not a choice: they are always the engine's measurements. The
// mode is a per-machine debug preference; a saved reading remembers the mode it
// was composed in and the PARTS it was composed from (`data.parts`: the measured
// runs, the AI's text per run), so switching never pays for the AI twice.
const MODE_KEY = 'docvex:doc-viewer:text-reading-mode';
// LOCAL BY DEFAULT: the AI mode sends strips of the picture to Anthropic, so
// it is used only when it was chosen AND the project allows cloud reading of
// images (lib/cloudMedia) — see `extractImageText`.
export const DEFAULT_READING_MODE = { result: 'local' };
const cleanMode = (m) => ({ result: m?.result === 'ai' ? 'ai' : 'local' });
export function loadReadingMode() {
  try { return cleanMode(JSON.parse(localStorage.getItem(MODE_KEY) || 'null') || DEFAULT_READING_MODE); } catch { return { ...DEFAULT_READING_MODE }; }
}
export function saveReadingMode(mode) {
  try { localStorage.setItem(MODE_KEY, JSON.stringify(cleanMode(mode))); } catch { /* unavailable */ }
  try { window.dispatchEvent(new CustomEvent('docvex:reading-mode')); } catch { /* no window */ }
}
// Called with the new mode whenever it changes — in this window (Settings) or
// in another (the viewer is a window of its own: the `storage` event).
export function subscribeReadingMode(fn) {
  const here = () => fn(loadReadingMode());
  const there = (e) => { if (e.key === MODE_KEY) fn(loadReadingMode()); };
  window.addEventListener('docvex:reading-mode', here);
  window.addEventListener('storage', there);
  return () => { window.removeEventListener('docvex:reading-mode', here); window.removeEventListener('storage', there); };
}
const sameMode = (a, b) => !!a && a.result === b.result;
const current = (facet, mode = loadReadingMode()) => (
  facet && facet.data?.v === READING_VERSION && sameMode(facet.data.mode, mode) ? facet : null
);
// A saved reading the viewer can DRAW, whatever version or mode made it: its
// lines, their words and the lit shapes. An older reading is SHOWN, never
// hidden — hiding readings made by an earlier version (READING_VERSION has been
// raised nine times) or in the other debug mode is what made extracted text
// look lost after every update. Reading it again is Recapture's job.
const drawable = (facet) => {
  const d = facet?.data;
  return d && Array.isArray(d.regions) && Array.isArray(d.shapes) && d.regions.every((r) => r && typeof r.text === 'string') ? facet : null;
};
export async function loadImageText(path) {
  if (!path) return null;
  const facet = getAiFacet(path, 'text', await stampFor(path));
  return current(facet) || drawable(facet);
}

// Regions in reading order, one per line: what "the text of this picture" is.
function joinRegions(regions) {
  return regions.map((r) => r.text).join('\n');
}

// ── Fallback: the page-wide transcription, matched by likeness ──────────
// Used ONLY when the strips couldn't be read (the AI call failed or answered
// unusably) but a whole-page transcription exists (Claude OCR via `doc-ai` —
// `readSourceText`, cached in the `ocr` facet): every measured line looks for
// itself in that text and, where it finds a close match, takes its spelling.
const foldText = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}
function reconcileWithAi(regions, aiText) {
  // The AI's words, line by line (markdown dressing dropped).
  const aiLines = String(aiText || '').split(/\r?\n/)
    .map((l) => l.replace(/^[\s>*#-]+/, '').replace(/[*_`]+/g, '').trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/));
  if (!aiLines.length) return regions;
  return regions.map((r) => {
    const local = foldText(r.text);
    if (local.length < 2) return r;
    const n = r.text.split(/\s+/).length;
    let best = null;
    for (const tokens of aiLines) {
      // The engine splits and joins words the AI doesn't ("LUCA -ANDRE I" is
      // one word, "LUCA-ANDREI"): any run of the AI's words may be the match.
      for (let size = 1; size <= n + 2; size += 1) {
        for (let at = 0; at + size <= tokens.length; at += 1) {
          const cand = tokens.slice(at, at + size);
          const folded = foldText(cand.join(''));
          if (!folded || Math.abs(folded.length - local.length) > Math.max(2, local.length * 0.4)) continue;
          const sim = 1 - editDistance(local, folded) / Math.max(local.length, folded.length);
          // Same word count wins a tie: it keeps every word at its own place.
          const rank = sim + (size === n ? 0.001 : 0);
          if (!best || rank > best.rank) best = { rank, sim, cand };
        }
      }
    }
    // Short pieces must match closely — two letters off in a four-letter word is
    // a different word.
    const need = local.length <= 4 ? 0.74 : 0.62;
    if (!best || best.sim < need) return r;
    const text = best.cand.join(' ');
    if (text === r.text) return r;
    const words = Array.isArray(r.words) && r.words.length === best.cand.length
      ? r.words.map((w, i) => [best.cand[i], w[1], w[2]])
      : [[text, 0, 1]];
    return { ...r, text, words, local: r.text };
  });
}

// Read the picture (or return the saved reading) → the facet, or `{ error }`.
// `file` = { path, name?, projectId? }; `el` = its <img> when one is on screen;
// `mode` = the reading mode (default: the saved debug preference); `force` =
// run the readers again (Recapture) instead of reusing the saved parts.
// For the engine's checks outside the app (scratch harness), nothing else.
export const textRegionsInternals = { detectLocally, composeReading };

// The text of a picture that is not a file yet — a scan being saved — read on
// this computer (the local engine; no AI), composed as a saved reading is.
// → { data, engine } ready for saveAiFacet, or null when nothing could be read.
// The scan keeps the text its page carries: the picture's own reading is of
// the photo, whose geometry the flattening changed, so the page is read again.
export async function readCanvasText(canvas) {
  if (!canvas?.width || !canvas?.height) return null;
  // The engine reads <img>-shaped sources (naturalWidth / naturalHeight).
  const blob = await new Promise((res) => { canvas.toBlob(res, 'image/png'); });
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const local = await detectLocally(img);
    const { turns, cw, ch } = local;
    const composed = composeReading(local.runs.map((r) => ({ ...r })), turns, cw, ch);
    const data = {
      v: READING_VERSION,
      mode: { result: 'local' },
      text: joinRegions(composed.regions),
      regions: composed.regions,
      shapes: composed.shapes,
      turns,
      ai: false,
      parts: { local },
    };
    return { data, engine: local.engine || 'tesseract' };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[text-regions] could not read the scan:', err);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// `reuseAny` = any saved reading of THIS version of the file will do, whatever
// mode or engine made it (the Files tab's AI scan wants the text, not the
// best-placed highlights, and must not read a picture twice).
// `rebuild` = compose the reading for `mode` from the saved parts, reading
// only what is missing for it (the Data tab's mode switch) — without it, a
// reading that already exists is returned as it is.
export async function extractImageText(file, { el = null, force = false, mode: asked = null, reuseAny = false, rebuild = false } = {}) {
  const path = file?.path || '';
  const mode = cleanMode(asked || loadReadingMode());
  const stamp = await stampFor(path);
  const saved = getAiFacet(path, 'text', stamp);
  if (!force && current(saved, mode)) return saved;
  if (!force && reuseAny && typeof saved?.data?.text === 'string') return saved;
  // A reading that EXISTS is kept and used, whatever version or mode made it:
  // nothing is read (or paid for) again unless asked to (Recapture = force, the
  // mode switch = rebuild). Only one the viewer cannot draw is made again.
  if (!force && !rebuild && drawable(saved)) return saved;
  const parts = !force && saved?.data?.v === READING_VERSION && saved.data.parts ? { ...saved.data.parts } : {};
  const wantAi = mode.result === 'ai' && !Array.isArray(parts.ai) && isCloudMediaAllowed();
  let img = el;
  if ((!parts.local || wantAi) && !img?.naturalWidth) {
    try { img = await decodeImageAt(path); } catch { return { error: 'The picture couldn’t be opened for reading.' }; }
  }
  // 1. MEASURE — where every piece of text is.
  if (!parts.local) {
    try { parts.local = await detectLocally(img); } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[text-regions] the text engine could not run:', err);
      return { error: 'The text reader couldn’t start, so the text can’t be placed on the picture.' };
    }
  }
  // 2. READ — the AI transcribes each measured piece. Allowed to fail (offline,
  // not configured): the page-wide transcription is tried next, matched onto
  // the pieces by likeness; failing that too, the engine's own reading stands.
  let fallbackText = '';
  if (wantAi && parts.local.runs.length) {
    let answers = null;
    try { answers = await readRunsWithAi(img, parts.local, { projectId: file?.projectId }); } catch { answers = { error: 'failed' }; }
    if (Array.isArray(answers)) parts.ai = answers;
    else {
      try {
        const blob = await readLocalBlob(path);
        const res = blob ? await readSourceText(blob, file?.name || String(path).split(/[\\/]/).pop(), { path, force, projectId: file?.projectId }) : null;
        fallbackText = res?.text || '';
      } catch { fallbackText = ''; }
    }
  }
  // 3. COMPOSE.
  const { turns, cw, ch } = parts.local;
  const byAi = mode.result === 'ai' && Array.isArray(parts.ai);
  const runs = !byAi ? parts.local.runs : parts.local.runs
    .map((run, i) => (parts.ai[i] == null ? run : (parts.ai[i] ? runWithText(run, parts.ai[i]) : null)))
    .filter(Boolean);   // '' = the AI saw no text in that piece: it goes
  const composed = composeReading(runs.map((r) => ({ ...r })), turns, cw, ch);
  const regions = !byAi && fallbackText ? reconcileWithAi(composed.regions, fallbackText) : composed.regions;
  const data = {
    v: READING_VERSION,
    mode,
    text: joinRegions(regions),
    regions,
    shapes: composed.shapes,
    // Which way the text runs (quarter-turns the picture was turned clockwise to
    // read it) — the pane turns the selectable text to match.
    turns,
    ai: byAi || (mode.result === 'ai' && !!fallbackText),
    parts,
  };
  const base = parts.local.engine || 'tesseract';
  const engine = data.ai ? `${base}+claude` : base;
  // A reading WITH text is never replaced by an empty one (a reader that
  // failed quietly, the AI answering nothing): what was read stays.
  if (!String(data.text || '').trim() && String(saved?.data?.text || '').trim()) return saved;
  // An empty reading is saved too — "no text here" is an answer worth keeping.
  saveAiFacet({ path, name: file?.name, projectId: file?.projectId }, 'text', { data, engine, stamp });
  return getAiFacet(path, 'text') || { kind: 'text', at: Date.now(), engine, data };
}

// A SAVED PaddleOCR reading made before its words were fitted to the ink:
// fitted now from the picture on screen (`el`), with NO reading again and no
// AI call — the measured runs are re-placed, the text (the engine's or the
// AI's per piece) kept, and the reading re-composed and saved. → the new
// facet, or null when there is nothing to do.
export function needsInkFit(data) {
  const local = data?.parts?.local;
  return !!(local && local.engine === 'paddleocr' && Array.isArray(local.runs) && local.inkFit !== INK_FIT);
}
export async function refitImageText(file, el) {
  const path = file?.path || '';
  if (!path || !el?.naturalWidth) return null;
  const stamp = await stampFor(path);
  const saved = getAiFacet(path, 'text', stamp);
  const data = saved?.data;
  if (!needsInkFit(data)) return null;
  // A reading whose words were matched from a page-wide transcription has no
  // per-piece text to carry over: re-composing would lose it.
  if (data.ai && !Array.isArray(data.parts.ai)) return null;
  const local = data.parts.local;
  const canvas = paddleCanvas(el, local.turns || 0);
  // The runs were measured on a canvas made the same way; a different size
  // means another picture (or another rule) — leave it.
  if (canvas.width !== local.cw || canvas.height !== local.ch) return null;
  // A reading the first fit (INK_FIT 1) placed kept no detector geometry, and
  // that fit could swallow the next line: such a LOCAL reading is measured
  // again on this computer (no AI); an AI-read one is left as it is (its text
  // per piece is tied to the old pieces).
  const lostRaw = (local.inkFit && local.runs.some((r) => !r.raw))
    // …or made before the recogniser's letter positions were kept (local only).
    || (!data.ai && local.runs.length > 0 && local.runs.every((r) => !r.charAt));
  if (lostRaw && data.ai) return null;
  let fittedLocal;
  if (lostRaw) {
    try { fittedLocal = await detectLocally(el); } catch { return null; }
    if (fittedLocal.turns !== local.turns) return null;
  } else {
    fittedLocal = { ...local, runs: fitRunsToInk(el, local.turns || 0, canvas, local.runs), inkFit: INK_FIT };
  }
  const parts = { ...data.parts, local: fittedLocal };
  const byAi = data.ai && Array.isArray(parts.ai);
  const runs = !byAi ? fittedLocal.runs : fittedLocal.runs
    .map((run, i) => (parts.ai[i] == null ? run : (parts.ai[i] ? runWithText(run, parts.ai[i]) : null)))
    .filter(Boolean);
  const composed = composeReading(runs.map((r) => ({ ...r })), fittedLocal.turns, fittedLocal.cw, fittedLocal.ch);
  const next = {
    ...data,
    text: joinRegions(composed.regions),
    regions: composed.regions,
    shapes: composed.shapes,
    parts,
  };
  saveAiFacet({ path, name: file?.name, projectId: file?.projectId }, 'text', { data: next, engine: saved.engine, stamp });
  return getAiFacet(path, 'text') || { ...saved, data: next };
}
