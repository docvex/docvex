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
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'ocr');
const nm = (...p) => join(root, 'node_modules', ...p);

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
