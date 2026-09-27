// Live Photos in the Doc Viewer — a still that carries a few seconds of
// movement. Two kinds reach a computer:
//
//   paired    an iPhone Live Photo: the still (IMG_1234.JPG / .HEIC) and a short
//             video with the SAME NAME beside it (IMG_1234.MOV). Found by
//             listing the picture's folder.
//   embedded  an Android "motion photo" (Google Pixel MVIMG / MotionPhoto,
//             Samsung): ONE .jpg whose video (an MP4) is appended after the
//             picture. Found by the MP4's `ftyp` box AFTER the JPEG's end
//             marker (FF D9), and cut out as a Blob.
//
// findLivePhoto(file) → { kind, url, name, path?, blob?, ext } | null, cached
// per path + size; `releaseLivePhoto` frees an embedded video's object URL.
// Nothing leaves the machine.
//
// A paired video is found by NAME first, then — when the two were renamed
// apart ("Save as Video", a copy made elsewhere) — by CONTENT IDENTIFIER: iOS
// writes one UUID into both files (the picture's Apple maker note, the MOV's
// `com.apple.quicktime.content.identifier`), and matching it is how Photos
// itself glues them back (`contentIdsOf`).
//
// `.livp` — the ZIP iOS wraps a Live Photo in when it is exported — is
// unpacked into the picture and its video (`unpackLivp`), by the Files tab's
// import and by the phone upload's hold.

import { localFolderApi, readLocalBlob } from './localFolder';

const VIDEO_EXT = ['mov', 'mp4', 'm4v', 'webm'];
const cache = new Map();   // key → result (or null)

const stemOf = (name) => String(name || '').replace(/\.[^./\\]+$/, '');
const extOf = (name) => (/\.([a-z0-9]{1,5})$/i.exec(String(name || '')) || [])[1]?.toLowerCase() || '';
const localUrl = (p) => `localfile://local/${encodeURIComponent(p)}`;

/** The movement of a Live Photo / motion photo, or null. */
export async function findLivePhoto(file) {
  const path = file?.path || file?.storage_path || '';
  if (!path) return null;
  const key = `${path}|${file.size || file.sizeBytes || ''}`;
  if (cache.has(key)) return cache.get(key);
  let found = null;
  try { found = await pairedVideo(path, file.name); } catch { /* unlistable folder */ }
  if (!found && /^(jpe?g)$/.test(extOf(file.name || path))) {
    try { found = await embeddedVideo(path, file.name); } catch { /* unreadable */ }
  }
  cache.set(key, found);
  return found;
}

export function releaseLivePhoto(live) {
  if (live?.kind === 'embedded' && live.url) { try { URL.revokeObjectURL(live.url); } catch { /* ignore */ } }
}

// ── iPhone: IMG_1234.JPG + IMG_1234.MOV ─────────────────────────────────────
async function pairedVideo(path, name) {
  const sep = path.includes('\\') ? '\\' : '/';
  const dir = path.slice(0, path.lastIndexOf(sep));
  if (!dir) return null;
  const stem = stemOf(name || path.slice(path.lastIndexOf(sep) + 1)).toLowerCase();
  if (!stem) return null;
  const listing = await localFolderApi.list(dir);
  const videos = (listing?.files || []).filter((f) => VIDEO_EXT.includes(extOf(f.name)) && f.path && !(Number(f.sizeBytes) > 60 * 1024 * 1024));
  let hit = videos.find((f) => stemOf(f.name).toLowerCase() === stem);
  if (!hit) hit = await byContentId(path, videos);
  if (!hit?.path) return null;
  // A Live Photo's video is a few seconds; a long clip that merely shares a
  // name (a video and its poster frame) isn't one.
  if (Number(hit.sizeBytes) > 60 * 1024 * 1024) return null;
  return { kind: 'paired', url: localUrl(hit.path), path: hit.path, name: hit.name, ext: extOf(hit.name) };
}

// ── Pairing by content identifier ──────────────────────────────────────────
const UUID_RE = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g;
const HEAD = 512 * 1024;
const idCache = new Map();   // path|size → Set of UUIDs
const MAX_CANDIDATES = 40;

/** Every UUID written in a file's first and last 512 KB (where a picture's
 *  maker note and a MOV's metadata live) — iOS's content identifier among them. */
export async function contentIdsOf(blob) {
  const parts = blob.size <= HEAD * 2 ? [blob] : [blob.slice(0, HEAD), blob.slice(blob.size - HEAD)];
  const ids = new Set();
  for (const part of parts) {
    const text = new TextDecoder('latin1').decode(new Uint8Array(await part.arrayBuffer()));
    for (const m of text.matchAll(UUID_RE)) ids.add(m[0]);
  }
  return ids;
}
async function idsOfPath(p, size = '') {
  const key = `${p}|${size}`;
  if (idCache.has(key)) return idCache.get(key);
  let ids = new Set();
  try { const b = await readLocalBlob(p); if (b) ids = await contentIdsOf(b); } catch { /* unreadable */ }
  idCache.set(key, ids);
  if (idCache.size > 400) idCache.delete(idCache.keys().next().value);
  return ids;
}
async function byContentId(picturePath, videos) {
  if (!videos.length) return null;
  const mine = await idsOfPath(picturePath);
  if (!mine.size) return null;
  for (const v of videos.slice(0, MAX_CANDIDATES)) {
    const theirs = await idsOfPath(v.path, v.sizeBytes);
    for (const id of theirs) if (mine.has(id)) return v;
  }
  return null;
}

// ── .livp ─────────────────────────────────────────────────────────────────
export const isLivpName = (name) => /\.livp$/i.test(String(name || ''));
/** A `.livp` (a ZIP of the picture and its MOV) → { image, video } — each
 *  `{ name, blob }`, named after the .livp so they pair — or null. */
export async function unpackLivp(blob, name = 'Live Photo.livp') {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(blob);
  let image = null; let video = null;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const ext = extOf(entry.name);
    if (!image && /^(heic|heif|jpe?g|png)$/.test(ext)) image = { ext, entry };
    else if (!video && VIDEO_EXT.includes(ext)) video = { ext, entry };
  }
  if (!image) return null;
  const stem = stemOf(String(name).split(/[\\/]/).pop()) || 'Live Photo';
  const out = { image: { name: `${stem}.${image.ext}`, blob: await image.entry.async('blob') }, video: null };
  if (video) out.video = { name: `${stem}.${video.ext}`, blob: await video.entry.async('blob') };
  return out;
}

/**
 * The iPhone Live Photo video beside a picture on disk (anywhere — the folder
 * a file is being IMPORTED from, not only the project's) → { path, name, ext } | null.
 * The Files tab's import brings it along, so the pair stays a Live Photo.
 */
export async function livePartnerOf(path, name) {
  if (!path || !/\.(jpe?g|heic|heif|png)$/i.test(name || path)) return null;
  try {
    const hit = await pairedVideo(path, name);
    return hit ? { path: hit.path, name: hit.name, ext: hit.ext } : null;
  } catch { return null; }
}

// ── Android: an MP4 appended to the JPEG ────────────────────────────────────
async function embeddedVideo(path, name) {
  const blob = await readLocalBlob(path);
  if (!blob || blob.size < 1024) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const at = findAppendedMp4(bytes);
  if (at < 0) return null;
  const video = blob.slice(at, blob.size, 'video/mp4');
  const url = URL.createObjectURL(video);
  return { kind: 'embedded', url, blob: video, name: `${stemOf(name)} (motion).mp4`, ext: 'mp4' };
}

/**
 * Where an MP4 begins inside a JPEG, or -1. The picture ends at its last
 * FF D9 before the video; the video starts with a box `[size:4]['ftyp']` whose
 * brand is an ISO / QuickTime one. Exported for tests.
 */
export function findAppendedMp4(b) {
  // Search 'ftyp' (66 74 79 70) from the start of the file's second half-ish:
  // the video is always after the picture, and a picture's own data can
  // contain the four bytes by chance — so only a box whose size field is sane
  // and whose brand reads as letters counts, and an FF D9 must precede it.
  for (let i = 8; i < b.length - 12; i += 1) {
    if (b[i] !== 0x66 || b[i + 1] !== 0x74 || b[i + 2] !== 0x79 || b[i + 3] !== 0x70) continue;
    const start = i - 4;
    const size = ((b[start] << 24) | (b[start + 1] << 16) | (b[start + 2] << 8) | b[start + 3]) >>> 0;
    if (size < 8 || size > 512) continue;
    const brand = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (!/^[a-zA-Z0-9 ]{4}$/.test(brand)) continue;
    if (start < 2 || b[start - 2] !== 0xff || b[start - 1] !== 0xd9) {
      // Some writers leave padding between the picture's end and the video.
      let ok = false;
      for (let k = start - 1; k >= Math.max(1, start - 64); k -= 1) {
        if (b[k - 1] === 0xff && b[k] === 0xd9) { ok = true; break; }
      }
      if (!ok) continue;
    }
    return start;
  }
  return -1;
}
