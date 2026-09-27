// Copies the face-recognition models out of node_modules into public/faces/, so
// Vite serves them (dev) and ships them beside index.html (Electron + web
// builds) at a KNOWN, un-hashed URL — the same arrangement as the OCR engine
// (scripts/copy-ocr-assets.mjs).
//
// Used by lib/faceMatch.js (the Files tab's AI scan: an identity document's
// photo matched against the faces in the project's pictures). The models run
// entirely on this machine: no face ever leaves the computer.
//
// Runs on `npm install` (postinstall). public/faces/ is gitignored: ~12 MB of
// third-party weights that node_modules already pins by version.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'faces');
const from = join(root, 'node_modules', '@vladmandic', 'face-api', 'model');

// Detector (SSD MobileNet v1), the 68-point landmarks (to align the face) and
// the recogniser (a 128-number description of a face).
const names = ['ssd_mobilenetv1_model', 'face_landmark_68_model', 'face_recognition_model']
  .flatMap((n) => [`${n}-weights_manifest.json`, `${n}.bin`]);

let copied = 0;
let missing = 0;
mkdirSync(out, { recursive: true });
for (const name of names) {
  const src = join(from, name);
  if (!existsSync(src)) { missing += 1; console.warn(`[face-assets] missing: ${src}`); continue; }
  const to = join(out, name);
  if (existsSync(to) && statSync(to).size === statSync(src).size) continue;
  copyFileSync(src, to);
  copied += 1;
}
console.log(`[face-assets] ${copied} copied, ${names.length - copied - missing} up to date${missing ? `, ${missing} MISSING` : ''} → public/faces/`);
