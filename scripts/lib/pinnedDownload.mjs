// PINNED DOWNLOADS (V13). Model files fetched at install time (OCR, Whisper)
// run inside the app, so a tampered file is code we ship. Each file's SHA-256
// is kept in scripts/model-hashes.json and CHECKED on every install:
//   • pinned + matches  → kept / written;
//   • pinned + differs  → refused (the file is deleted, the install warns);
//   • not pinned yet    → trust on first use: the hash is recorded in
//     model-hashes.json and the script says to commit it. Commit that file —
//     from then on every machine verifies against it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PINS = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'model-hashes.json');

function readPins() {
  try { return JSON.parse(readFileSync(PINS, 'utf8')); } catch { return {}; }
}
function writePins(pins) {
  const sorted = Object.fromEntries(Object.entries(pins).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(PINS, `${JSON.stringify(sorted, null, 2)}\n`);
}
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Verify a file already on disk against its pin. → 'ok' | 'mismatch' | 'unpinned' | 'missing'
export function verifyPinned(id, file) {
  if (!existsSync(file)) return 'missing';
  const want = readPins()[id];
  if (!want) return 'unpinned';
  if (sha256(readFileSync(file)) === want) return 'ok';
  return 'mismatch';
}

// Download `url` to `file` and check it. Throws on a mismatch (nothing kept).
export async function pinnedDownload(id, url, file, { min = 1 } = {}) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < min) throw new Error(`only ${buf.length} bytes`);
  const got = sha256(buf);
  const pins = readPins();
  if (pins[id] && pins[id] !== got) throw new Error(`SHA-256 mismatch for ${id} (expected ${pins[id]}, got ${got}) — refusing it`);
  writeFileSync(file, buf);
  if (!pins[id]) {
    pins[id] = got;
    writePins(pins);
    console.warn(`[pinned] ${id}: first download, SHA-256 recorded in scripts/model-hashes.json — COMMIT that file.`);
  }
  return got;
}

// A file on disk that fails its pin is removed so the app can't load it.
export function dropIfTampered(id, file) {
  if (verifyPinned(id, file) !== 'mismatch') return false;
  try { unlinkSync(file); } catch { /* already gone */ }
  console.warn(`[pinned] ${id}: the file on disk doesn't match its pinned SHA-256 — deleted.`);
  return true;
}
