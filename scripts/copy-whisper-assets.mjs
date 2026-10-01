// Puts the LOCAL speech-to-text engine in place (security fix V11 — audio never
// leaves the computer; OpenAI is no longer used):
//
//   public/models/onnx-community/whisper-small/…  the Whisper model (multilingual,
//       Romanian included; 8-bit quantized ONNX), DOWNLOADED once from Hugging
//       Face — every file checked against its pinned SHA-256
//       (scripts/lib/pinnedDownload.mjs + scripts/model-hashes.json);
//   public/models/ort/…  the ONNX Runtime Web WebAssembly transformers.js runs
//       on, copied out of node_modules (the version transformers.js itself
//       depends on — its WebGPU/asyncify build, which is NOT the same file as the
//       one in public/ocr/ort/ that PaddleOCR uses, so it can't be shared).
//
// Read by lib/whisper.worker.js with remote loading switched OFF: at runtime
// the app never contacts huggingface.co or a CDN. public/models/ is gitignored.
//
// Runs on `npm install` (postinstall), after the OCR / face assets. A failed
// download only warns: captions then say the model isn't installed.
//
// The model files are fetched at a FIXED revision when WHISPER_REVISION names
// a commit of onnx-community/whisper-small (recommended: pin one before release
// and re-run so model-hashes.json records its files); `main` otherwise — the
// pinned hashes still refuse any file that changes under it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropIfTampered, pinnedDownload, verifyPinned } from './lib/pinnedDownload.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'models');
const nm = (...p) => join(root, 'node_modules', ...p);

// ── ONNX Runtime Web (the build transformers.js imports) ───────────────
// transformers.js pins its own onnxruntime-web (a newer one than the app's), so
// npm nests it under the package; fall back to the hoisted copy.
const ortDist = [
  nm('@huggingface', 'transformers', 'node_modules', 'onnxruntime-web', 'dist'),
  nm('onnxruntime-web', 'dist'),
].find((d) => existsSync(d));
const ortOut = join(out, 'ort');
mkdirSync(ortOut, { recursive: true });
if (!ortDist) {
  console.warn('[whisper-assets] onnxruntime-web not found in node_modules — run npm install first.');
} else {
  // transformers.js imports `onnxruntime-web/webgpu`, whose runtime is the
  // ASYNCIFY build (checked on onnxruntime-web 1.31.0-dev: ort.webgpu.min.mjs
  // loads ort-wasm-simd-threaded.asyncify.{mjs,wasm}). Only that pair is
  // copied (~27 MB); the other flavours would only add weight.
  const wanted = /^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/;
  let copied = 0;
  for (const name of readdirSync(ortDist)) {
    if (!wanted.test(name)) continue;
    const from = join(ortDist, name);
    const to = join(ortOut, name);
    if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
    copyFileSync(from, to);
    copied += 1;
  }
  console.log(`[whisper-assets] ONNX runtime: ${copied} copied → public/models/ort/`);
}

// ── Whisper small (onnx-community) ──────────────────────────────────────
// Keep MODEL in step with WHISPER_MODEL in src/lib/transcribe.js, and the onnx
// file names with the `dtype` (q8 → _quantized) in src/lib/whisper.worker.js.
const MODEL = 'onnx-community/whisper-small';
const REVISION = process.env.WHISPER_REVISION || 'main';
const HF = 'https://huggingface.co';
const FILES = [
  // [path inside the repo, minimum size — a truncated download is refused]
  ['config.json', 500],
  ['generation_config.json', 500],
  ['preprocessor_config.json', 100],
  ['tokenizer.json', 1_000_000],
  ['tokenizer_config.json', 500],
  ['onnx/encoder_model_quantized.onnx', 20_000_000],
  ['onnx/decoder_model_merged_quantized.onnx', 50_000_000],
];

const modelDir = join(out, ...MODEL.split('/'));
let fetched = 0;
let kept = 0;
let failed = 0;
for (const [rel, min] of FILES) {
  const id = `models/${MODEL}/${rel}`;
  const to = join(modelDir, ...rel.split('/'));
  mkdirSync(dirname(to), { recursive: true });
  dropIfTampered(id, to);
  if (existsSync(to) && statSync(to).size >= min && verifyPinned(id, to) === 'ok') { kept += 1; continue; }
  const url = `${HF}/${MODEL}/resolve/${encodeURIComponent(REVISION)}/${rel}`;
  try {
    await pinnedDownload(id, url, to, { min });
    fetched += 1;
  } catch (err) {
    failed += 1;
    console.warn(`[whisper-assets] couldn't fetch ${rel}: ${err?.message || err}`);
  }
}
console.log(`[whisper-assets] Whisper (${MODEL}@${REVISION}): ${fetched} downloaded, ${kept} up to date${failed ? `, ${failed} FAILED (captions won't work until it is fetched)` : ''} → public/models/`);
