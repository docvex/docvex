// How alike two files are — the Insights view's duplicates
// (lib/caseInsights). All local: nothing leaves the machine.
import { readLocalBlob } from './localFolder';

const localUrl = (path) => `localfile://local/${encodeURIComponent(path)}`;

// The file's bytes, hashed (identical copies).
export async function sha256Of(path) {
  const blob = await readLocalBlob(path);
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A picture's 64-bit DIFFERENCE HASH, from the OS thumbnail (fast, and the
// same for a resized or re-saved copy). null when it can't be drawn.
export async function dhashOf(path) {
  const res = await fetch(`${localUrl(path)}?thumb=128`);
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob());
  const c = document.createElement('canvas');
  c.width = 9; c.height = 8;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, 9, 8);
  bmp.close?.();
  const px = g.getImageData(0, 0, 9, 8).data;
  const lum = (x, y) => { const i = (y * 9 + x) * 4; return px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114; };
  let bits = 0n;
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) bits = (bits << 1n) | (lum(x, y) > lum(x + 1, y) ? 1n : 0n);
  return bits;
}
export function hamming(a, b) {
  let n = a ^ b; let c = 0;
  while (n) { c += Number(n & 1n); n >>= 1n; }
  return c;
}

// A text as its 5-word shingles, and the Jaccard likeness of two such sets.
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function shingles(text) {
  const w = fold(text).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 4 < w.length; i += 1) out.add(w.slice(i, i + 5).join(' '));
  return out;
}
export function likeness(a, b) {
  if (!a.size || !b.size) return 0;
  const small = a.size < b.size ? a : b; const big = small === a ? b : a;
  let common = 0;
  for (const x of small) if (big.has(x)) common += 1;
  return common / (a.size + b.size - common);
}
