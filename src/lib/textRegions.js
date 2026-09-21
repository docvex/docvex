// Text detection WITH positions, for the Doc Viewer's image pane: the picture's
// text comes back as LINES — `{ text, x, y, w, h }`, normalised 0…1 to the image,
// in reading order — plus the SHAPES that light them up (`shapes`: outlines of
// the lit areas, neighbouring lines merged into one). The pane lays real,
// invisible text over each line, so the picture's text is selected by dragging
// and copied like any other text (a phone's / Windows Photos' live text).
//
// THE ENGINE IS LOCAL: Tesseract (tesseract.js, WebAssembly, in a Web Worker),
// with the Romanian + English models. A highlight has to sit ON its text, and
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
import { askProjectAi } from './projectAi';
import { readLocalBlob } from './localFolder';
import { getAiFacet, saveAiFacet, stampFor } from './aiData';
import { readSourceText } from './identityExtract';

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
  // Dev: '/', the web build: '/app/', packaged Electron: './' beside index.html.
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
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' });
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
  const round = (v) => Math.round(v * 10000) / 10000;
  const toPicture = (px, py) => {
    const [nx, ny] = unturn(turns, px / cw, py / ch);
    return [round(clamp(nx)), round(clamp(ny))];
  };
  const regions = [];
  const kept = [];
  for (const run of runs) {
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
    const words = run.boxes.filter((q) => q.t).map((q) => [q.t, round((q.x0 - run.x0) / span), round((q.x1 - run.x0) / span)]);
    regions.push({ text: run.text, x, y, w: round(w), h: round(h), words });
    kept.push(run);
  }
  const heights = kept.map((r) => r.letterH).sort((m, n) => m - n);
  const letter = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  // Padding and reach are measured in letters — but a blot read as one giant
  // "letter" (a flag, a signature) must not get a giant margin: no run counts
  // as taller than 1.6 of the picture's typical letter.
  for (const r of kept) r.ref = Math.min(r.letterH, letter * 1.6);
  const rects = kept.flatMap(runRects).concat(bridgeRects(kept));
  const shapes = unionLoops(rects, Math.max(1, letter * 0.12)).map((loop) => loop.map(([px, py]) => toPicture(px, py)));
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

// → `{ turns, cw, ch, runs }`: the measured pieces, in the pixels of the picture
// turned `turns` quarter-turns clockwise at `cw`×`ch` (`ocrCanvas`).
async function detectLocally(el) {
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
  return { turns: best.turns, cw: best.canvas.width, ch: best.canvas.height, runs };
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
  const src = ocrCanvas(el, local.turns);
  const sheets = buildSheets(src, local.runs);
  if (!sheets.length) return [];
  const res = await askProjectAi({
    messages: [{
      role: 'user',
      content: [
        ...sheets.map((sh) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sh.data } })),
        { type: 'text', text: sheetsPrompt(sheets.length) },
      ],
    }],
    model: MODEL,
    tools: false,
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
// measured, the AI reads numbered strips (no AI coordinates anywhere).
const READING_VERSION = 8;

// ── The reading MODE (the Data tab's debug control) ─────────────────────
//   result — whose WORDS are shown: 'ai' (each measured piece read by the AI) |
//            'local' (the engine's own reading)
// POSITIONS are not a choice: they are always the engine's measurements. The
// mode is a per-machine debug preference; a saved reading remembers the mode it
// was composed in and the PARTS it was composed from (`data.parts`: the measured
// runs, the AI's text per run), so switching never pays for the AI twice.
const MODE_KEY = 'docvex:doc-viewer:text-reading-mode';
export const DEFAULT_READING_MODE = { result: 'ai' };
const cleanMode = (m) => ({ result: m?.result === 'local' ? 'local' : 'ai' });
export function loadReadingMode() {
  try { return cleanMode(JSON.parse(localStorage.getItem(MODE_KEY) || 'null') || DEFAULT_READING_MODE); } catch { return { ...DEFAULT_READING_MODE }; }
}
export function saveReadingMode(mode) {
  try { localStorage.setItem(MODE_KEY, JSON.stringify(cleanMode(mode))); } catch { /* unavailable */ }
}
const sameMode = (a, b) => !!a && a.result === b.result;
const current = (facet, mode = loadReadingMode()) => (
  facet && facet.data?.v === READING_VERSION && sameMode(facet.data.mode, mode) ? facet : null
);
export async function loadImageText(path) {
  if (!path) return null;
  return current(getAiFacet(path, 'text', await stampFor(path)));
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
export async function extractImageText(file, { el = null, force = false, mode: asked = null } = {}) {
  const path = file?.path || '';
  const mode = cleanMode(asked || loadReadingMode());
  const stamp = await stampFor(path);
  const saved = getAiFacet(path, 'text', stamp);
  if (!force && current(saved, mode)) return saved;
  const parts = !force && saved?.data?.v === READING_VERSION && saved.data.parts ? { ...saved.data.parts } : {};
  const wantAi = mode.result === 'ai' && !Array.isArray(parts.ai);
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
  const engine = data.ai ? 'tesseract+claude' : 'tesseract';
  // An empty reading is saved too — "no text here" is an answer worth keeping.
  saveAiFacet({ path, name: file?.name, projectId: file?.projectId }, 'text', { data, engine, stamp });
  return getAiFacet(path, 'text') || { kind: 'text', at: Date.now(), engine, data };
}
