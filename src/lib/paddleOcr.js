// The Doc Viewer's text engine for pictures: PaddleOCR PP-OCRv6 (small), run on
// this machine by ONNX Runtime Web (WebAssembly).
//
// Why this engine. A phone photo of a document is never a scan: it is tilted,
// curled, shadowed, slightly blurred, shot at an angle, often on a busy
// background. What Apple's Live Text does well there — and Tesseract does not —
// is FINDING the text: Vision runs a neural text DETECTOR over the whole
// picture first (it answers "where are the lines?" from how text looks, not
// from a binarised page layout), then a RECOGNISER reads each line it found,
// cut out and straightened. Tesseract instead binarises the page and analyses
// its layout, which is what falls apart on a real photo: no clean page, no
// lines, no text.
//
// PP-OCRv6 is the same two-stage design, open (Apache-2.0) and small enough to
// run here: a DB-style detector (LCNetV4 + RepLKFPN) that marks text pixels and
// turns them into a box per line — rotated, curved, blurred, handwritten and
// low-contrast text included — then an SVTR recogniser reading each line cut
// out along its box (the crop is rotated upright first). One recogniser covers
// English and 46 Latin-script languages, Romanian's ă â î ș ț included. On
// PaddleOCR's benchmark its detection scores 92.6 on BLURRED text and 93.7 on
// ROTATED text, where Tesseract-era engines barely register.
//
// Files (public/ocr/, scripts/copy-ocr-assets.mjs — postinstall): the runtime's
// WebAssembly in `ort/`, the two models + the character list in `paddle/`.
// Nothing leaves the computer.
let enginePromise = null;

function ocrBase() {
  const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || './';
  return new URL(`${base.replace(/\/?$/, '/')}ocr/`, window.location.href).href;
}

// fetch() where it works; XHR where it doesn't (a packaged build loaded from
// file:// refuses fetch of a local file, XHR still reads it).
async function readBytes(url) {
  try {
    const res = await fetch(url);
    if (res.ok) return await res.arrayBuffer();
  } catch { /* try XHR */ }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => (xhr.status === 200 || (xhr.status === 0 && xhr.response) ? resolve(xhr.response) : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('unreadable'));
    xhr.send();
  });
}

// Another file served from public/ocr/ (copy-ocr-assets.mjs), as bytes.
export function readOcrAsset(name) { return readBytes(ocrBase() + name); }

// THE ENGINE RUNS IN A WEB WORKER (paddleOcr.worker.js): reading a picture is
// seconds of WebAssembly, and on the window's own thread the whole window froze
// for that long — for EVERY picture the Files tab's AI scan read. One worker per
// window, made on first use and kept (loading the models is the slow part).
// Should the worker not start (a build that can't serve module workers), the
// engine runs in the window as before (`getPaddleOcr`) — slower to live with,
// but reading still works.
let worker = null;
let workerDead = false;
let nextId = 0;
const waiting = new Map();   // id → { resolve, reject }
function getWorker() {
  if (workerDead) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./paddleOcr.worker.js', import.meta.url), { type: 'module', name: 'paddle-ocr' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[paddle-ocr] no worker, reading in the window:', err);
    workerDead = true;
    return null;
  }
  worker.onmessage = ({ data }) => {
    const job = waiting.get(data?.id);
    if (!job) return;
    waiting.delete(data.id);
    if (data.ok) job.resolve(data.results); else job.reject(new Error(data.error || 'failed'));
  };
  // A worker that fails to LOAD (its script can't be fetched or evaluated)
  // answers nothing: every waiting read is failed over to the window.
  worker.onerror = (ev) => {
    // eslint-disable-next-line no-console
    console.warn('[paddle-ocr] the worker failed, reading in the window:', ev?.message || ev);
    workerDead = true;
    try { worker.terminate(); } catch { /* gone */ }
    worker = null;
    for (const job of waiting.values()) job.reject(Object.assign(new Error('worker'), { workerFailed: true }));
    waiting.clear();
  };
  return worker;
}
function recognizeInWorker(image) {
  const w = getWorker();
  if (!w) return Promise.reject(Object.assign(new Error('worker'), { workerFailed: true }));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    // The pixels are TRANSFERRED, not copied.
    w.postMessage({ id, base: ocrBase(), image }, [image.data.buffer]);
  });
}

// The in-window engine — the fallback only.
export function getPaddleOcr() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const base = ocrBase();
      const [ort, { PaddleOcrService }, { patchCharPositions }] = await Promise.all([import('onnxruntime-web/wasm'), import('paddleocr'), import('./paddleCharPos')]);
      patchCharPositions();
      ort.env.wasm.wasmPaths = `${base}ort/`;
      // Threads need SharedArrayBuffer, which only a cross-origin-isolated page has.
      ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      const [det, rec, dict] = await Promise.all([
        readBytes(`${base}paddle/det.onnx`),
        readBytes(`${base}paddle/rec.onnx`),
        readBytes(`${base}paddle/dict.txt`).then((b) => new TextDecoder().decode(b)),
      ]);
      return PaddleOcrService.createInstance({
        ort,
        modelPreset: 'PP-OCRv6_small',
        detection: { modelBuffer: det },
        // PaddleOCR's own `use_space_char`: the space is the list's last class.
        recognition: { modelBuffer: rec, charactersDictionary: [...dict.replace(/\r/g, '').replace(/\n+$/, '').split('\n'), ' '] },
      });
    })().catch((err) => { enginePromise = null; throw err; });
  }
  return enginePromise;
}

// The Romanian letters written with a comma below (ș ț), as Romanian is written
// and as this text is pasted into documents — never the legacy cedilla forms.
const fixRo = (t) => String(t).replace(/\s+/g, ' ').trim()
  .replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț');

// A canvas → every line of text on it: `{ text, conf (0–100), x0, y0, x1, y1,
// thick, along, cx, cy, angle, chars }` in the canvas's pixels, in reading order
// (`chars`: every letter's centre, spaces left out, or null).
// `thick` / `along` are the line's height and length measured ON its box (a
// tilted line's axis-aligned box is taller than its letters), `angle` its tilt
// in degrees (clockwise, as CSS rotates), `cx` / `cy` its centre.
export async function readLines(canvas) {
  const { width, height } = canvas;
  const pixels = () => ({ width, height, data: new Uint8Array(canvas.getContext('2d').getImageData(0, 0, width, height).data.buffer) });
  let results;
  try {
    results = await recognizeInWorker(pixels());
  } catch (err) {
    if (!err?.workerFailed) throw err;
    const ocr = await getPaddleOcr();
    results = await ocr.recognize(pixels(), { ordering: { sortByReadingOrder: true, sameLineThresholdRatio: 0.5 } });
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const out = [];
  for (const r of results || []) {
    const text = fixRo(r.text || '');
    if (!text) continue;
    const b = r.box || {};
    const pts = Array.isArray(b.points) && b.points.length === 4 ? b.points : null;
    const xs = pts ? pts.map((p) => p.x) : [b.x, b.x + b.width];
    const ys = pts ? pts.map((p) => p.y) : [b.y, b.y + b.height];
    const x0 = Math.max(0, Math.min(...xs)); const x1 = Math.min(width, Math.max(...xs));
    const y0 = Math.max(0, Math.min(...ys)); const y1 = Math.min(height, Math.max(...ys));
    if (!(x1 > x0) || !(y1 > y0)) continue;
    const along = pts ? (dist(pts[0], pts[1]) + dist(pts[3], pts[2])) / 2 : x1 - x0;
    const thick = pts ? (dist(pts[0], pts[3]) + dist(pts[1], pts[2])) / 2 : y1 - y0;
    const angle = pts
      ? (Math.atan2((pts[1].y - pts[0].y) + (pts[2].y - pts[3].y), (pts[1].x - pts[0].x) + (pts[2].x - pts[3].x)) * 180) / Math.PI
      : 0;
    const cx = pts ? pts.reduce((n, p) => n + p.x, 0) / 4 : (x0 + x1) / 2;
    const cy = pts ? pts.reduce((n, p) => n + p.y, 0) / 4 : (y0 + y1) / 2;
    // Each letter's centre on the picture (lib/paddleCharPos), the spaces left
    // out — in the order of the line's letters.
    const chars = Array.isArray(r.charPos) ? r.charPos.filter((c) => c && c.ch && !/\s/.test(c.ch)).map((c) => ({ x: c.x, y: c.y })) : null;
    out.push({ text, conf: Math.round((r.confidence || 0) * 100), x0, y0, x1, y1, thick, along, cx, cy, angle, chars });
  }
  return out;
}
