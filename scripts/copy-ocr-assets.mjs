// Copies the OCR engine's runtime files out of node_modules into public/ocr/, so
// Vite serves them (dev) and ships them beside index.html (Electron + web
// builds) at a KNOWN, un-hashed URL. They can't go through the bundler: the
// worker `importScripts` its core by URL, and tesseract asks for language data
// as `<dir>/<lang>.traineddata.gz`.
//
// Used by lib/textRegions.js (the Doc Viewer's "Extract text" on images) — the
// OCR runs entirely on this machine; with these files in place nothing is
// downloaded and no picture leaves the computer.
//
// Runs on `npm install` (postinstall). public/ocr/ is gitignored: ~13 MB of
// third-party binaries that node_modules already pins by version.
//
// It also puts the MAIN engine in place — PaddleOCR PP-OCRv6 (small), run by
// ONNX Runtime Web: the runtime's WebAssembly is copied to public/ocr/ort/, and
// the two models (text detection + recognition, Apache-2.0, ~31 MB) are
// DOWNLOADED once from PaddlePaddle's own Hugging Face repositories into
// public/ocr/paddle/ (npm doesn't carry them). A failed download only warns:
// the app then falls back to Tesseract.
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'ocr');
const nm = (...p) => join(root, 'node_modules', ...p);

// Face matching was removed (2026-09-28). Its models used to be copied into
// public/faces/, which Vite would still bundle into a release build from a
// machine that has them — so the folder is deleted here.
const oldFaces = join(root, 'public', 'faces');
if (existsSync(oldFaces)) {
  rmSync(oldFaces, { recursive: true, force: true });
  console.log('[ocr-assets] removed public/faces/ (face matching was removed)');
}

const files = [
  [nm('tesseract.js', 'dist', 'worker.min.js'), 'worker.min.js'],
  // LSTM-only cores (the modern recogniser — all this uses): SIMD where the CPU
  // has it, plain otherwise; tesseract picks between them from this directory.
  [nm('tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js'), 'tesseract-core-simd-lstm.wasm.js'],
  [nm('tesseract.js-core', 'tesseract-core-relaxedsimd-lstm.wasm.js'), 'tesseract-core-relaxedsimd-lstm.wasm.js'],
  [nm('tesseract.js-core', 'tesseract-core-lstm.wasm.js'), 'tesseract-core-lstm.wasm.js'],
  // Romanian + English, the integerised "best" models (smaller, LSTM).
  [nm('@tesseract.js-data', 'ron', '4.0.0_best_int', 'ron.traineddata.gz'), 'ron.traineddata.gz'],
  [nm('@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), 'eng.traineddata.gz'],
];

let copied = 0;
let missing = 0;
mkdirSync(out, { recursive: true });
for (const [from, name] of files) {
  if (!existsSync(from)) { missing += 1; console.warn(`[ocr-assets] missing: ${from}`); continue; }
  const to = join(out, name);
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  copied += 1;
}
console.log(`[ocr-assets] ${copied} copied, ${files.length - copied - missing} up to date${missing ? `, ${missing} MISSING` : ''} → public/ocr/`);

// ── PaddleOCR PP-OCRv6 small (lib/textRegions.js) ─────────────────────────
const ortOut = join(out, 'ort');
mkdirSync(ortOut, { recursive: true });
for (const name of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  const from = nm('onnxruntime-web', 'dist', name);
  const to = join(ortOut, name);
  if (!existsSync(from)) { console.warn(`[ocr-assets] missing: ${from}`); continue; }
  if (!existsSync(to) || statSync(to).size !== statSync(from).size) copyFileSync(from, to);
}

const HF = 'https://huggingface.co';
const MODELS = [
  // [url, file, minimum size — a truncated download is fetched again]
  [`${HF}/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/main/inference.onnx`, 'det.onnx', 9_000_000],
  [`${HF}/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.onnx`, 'rec.onnx', 20_000_000],
  // The recogniser's character list (18,708 entries — ă â î ș ț among them),
  // one per line, in the order of the model's output classes.
  [`${HF}/x3zvawq/paddleocr-js-onnx/resolve/main/ppocr_v6_small/ppocrv6_dict.txt`, 'dict.txt', 70_000],
];
const paddleOut = join(out, 'paddle');
mkdirSync(paddleOut, { recursive: true });
let fetched = 0;
for (const [url, name, min] of MODELS) {
  const to = join(paddleOut, name);
  if (existsSync(to) && statSync(to).size >= min) continue;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < min) throw new Error(`only ${buf.length} bytes`);
    writeFileSync(to, buf);
    fetched += 1;
  } catch (err) {
    console.warn(`[ocr-assets] couldn't download ${name} (${err?.message || err}) — text extraction falls back to Tesseract until it is.`);
  }
}
console.log(`[ocr-assets] PaddleOCR: ${fetched} model file(s) downloaded → public/ocr/paddle/`);
