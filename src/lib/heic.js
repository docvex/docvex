// HEIC / HEIF pictures — what an iPhone saves by default — made drawable.
// Chromium cannot decode HEIC on Windows (Microsoft's HEIF extension does not
// reach it), so the picture is decoded HERE, in a web worker, by libheif
// compiled to WebAssembly (`heic-to`, lazy-imported: ~3 MB, paid only when a
// HEIC file is actually shown) and handed back as a JPEG object URL any
// <img> can draw. Nothing leaves the machine.
//
//   isHeicName(name)                 → by extension
//   heicUrl(source, { key, maxSide }) → object URL of a JPEG (cached per key)
//
// `source` is a path on disk (read through localfile://) or a Blob. `maxSide`
// downscales (thumbnails); left out, the full picture. The cache keeps the
// last few full pictures (a window shows one) and a few hundred thumbnails;
// the oldest are revoked as newer ones arrive.

import { readLocalBlob } from './localFolder';

export const isHeicName = (name) => /\.(heic|heif|hif)$/i.test(String(name || ''));

const FULL_MAX = 6;
const THUMB_MAX = 300;
const full = new Map();     // key → Promise<url>
const thumbs = new Map();
const inflight = new Map();

let lib = null;
const load = () => (lib ||= import('heic-to').catch((e) => { lib = null; throw e; }));

const remember = (map, cap, key, p) => {
  map.set(key, p);
  while (map.size > cap) {
    const [oldKey, old] = map.entries().next().value;
    map.delete(oldKey);
    old.then((u) => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }).catch(() => {});
  }
};

/** The picture as a JPEG Blob (not cached) — for callers that keep their own
 *  object URLs (the thumbnail engine). */
export async function heicJpeg(source, maxSide = 0) {
  const blob = source instanceof Blob ? source : await readLocalBlob(source);
  if (!blob || !blob.size) throw new Error('unreadable');
  const { heicTo } = await load();
  if (!maxSide) {
    return heicTo({ blob, type: 'image/jpeg', quality: 0.92 });
  }
  const bmp = await heicTo({ blob, type: 'bitmap' });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  if (!out) throw new Error('encode_failed');
  return out;
}
const decode = async (source, maxSide) => URL.createObjectURL(await heicJpeg(source, maxSide));

/** A drawable (JPEG) object URL for a HEIC picture. */
export function heicUrl(source, { key = null, maxSide = 0 } = {}) {
  const k = `${key || (typeof source === 'string' ? source : '')}|${maxSide}`;
  const map = maxSide ? thumbs : full;
  if (k !== `|${maxSide}` && map.has(k)) {
    // Refresh its place in the eviction order.
    const p = map.get(k); map.delete(k); map.set(k, p);
    return p;
  }
  if (inflight.has(k)) return inflight.get(k);
  const p = decode(source, maxSide);
  inflight.set(k, p);
  p.then(
    () => { inflight.delete(k); if (k !== `|${maxSide}`) remember(map, maxSide ? THUMB_MAX : FULL_MAX, k, p); },
    () => { inflight.delete(k); },
  );
  return p;
}
