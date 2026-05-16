// Client-side thumbnail generation for the Files grid.
//
// Called from src/lib/uploadProjectFile.js right after the main upload
// finishes — runs locally (canvas / pdf.js / a hidden <video>), produces
// a small JPEG Blob, then the upload pipeline ships it to storage as
// `{project_id}/{file_id}/_thumb.jpg`.
//
// All three generators return a Blob (image/jpeg) on success or null on
// failure. The caller never throws: a missing thumbnail is a degraded-UX
// outcome (the card shows a MIME glyph instead), not an error worth
// failing the parent upload over.
//
// Why client-side: we already have the File object in memory (the user
// just dropped it), so generating a thumbnail is a few hundred ms of
// local CPU + zero round-trips. Server-side thumbnailing via an Edge
// Function would need to download the binary, install an image library,
// and re-upload — much more code for the same end result on a single-
// user device. Trade-off: PDFs that are unusually large (>50MB) take a
// few extra seconds to parse on slow CPUs; we cap the time spent below.

// Target thumbnail dimensions. 400x300 covers the .project-files-thumb
// box (4:3 aspect) at retina density on the grid. JPEG quality 0.85 is
// the inflection point where artifacts become visually invisible for
// content that isn't already JPEG-compressed; smaller than 0.8 shows
// banding on PDF first pages with smooth gradients.
const TARGET_W = 400;
const TARGET_H = 300;
const JPEG_QUALITY = 0.85;
// Bounding box (square) for native-aspect thumbnails — used by the
// video + PDF generators so the resulting JPEG matches the source's
// aspect ratio without baked-in letterbox bars. Surfaces that need a
// fixed grid aspect (Files-grid card, hover slideshow) letterbox the
// thumb in CSS via `object-fit: contain` + the container's dark
// background; surfaces that want edge-to-edge previews (upload-modal
// preview tile) get the native aspect for free.
const MAX_DIM = 400;

// Hard cap on how long any single generator runs. PDF.js can stall on
// pathologically malformed PDFs; <video> on Windows occasionally hangs
// on codecs Chromium doesn't support. Capping per generator keeps the
// upload pipeline moving — the parent upload doesn't wait on a stuck
// thumbnail forever.
const GENERATE_TIMEOUT_MS = 8000;

// Promise.race helper — resolves to the generator's result, or null if
// the timer fires first. Doesn't actually cancel the underlying work
// (canvas / pdf.js don't expose cancellation), but the returned Promise
// resolves so the upload pipeline can move on. The leaked computation
// finishes silently and gets GC'd.
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      ()       => { clearTimeout(timer); resolve(null); },
    );
  });
}

// Convert a canvas to a JPEG Blob. Wraps the callback-style API in a
// Promise. Returns null on browsers/contexts where toBlob is missing
// (it isn't, in any Chromium-based renderer — defensive).
function canvasToJpegBlob(canvas) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') { resolve(null); return; }
    canvas.toBlob((blob) => resolve(blob || null), 'image/jpeg', JPEG_QUALITY);
  });
}

// Compute the destination box that fits (sourceW × sourceH) inside
// (TARGET_W × TARGET_H) preserving aspect ratio. Used to letterbox/pillar-
// box smaller dimensions instead of stretching them. Returns the canvas
// dimensions and the source-to-canvas placement.
function fitBox(sourceW, sourceH) {
  const scale = Math.min(TARGET_W / sourceW, TARGET_H / sourceH, 1);
  const drawW = Math.round(sourceW * scale);
  const drawH = Math.round(sourceH * scale);
  // Center inside the fixed-size canvas so all thumbnails have the same
  // dimensions — keeps the .project-files-grid rows pixel-aligned.
  const offsetX = Math.round((TARGET_W - drawW) / 2);
  const offsetY = Math.round((TARGET_H - drawH) / 2);
  return { drawW, drawH, offsetX, offsetY };
}

// Black backdrop so transparent PNGs / partial-page PDFs read as
// "deliberate thumbnails" instead of "broken images on white". Matches
// the `.project-files-thumb` background color in ProjectFiles.css.
const BACKDROP = '#131313';

function newCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_W;
  canvas.height = TARGET_H;
  return canvas;
}

// Scale (sourceW × sourceH) down to fit inside a MAX_DIM square while
// preserving aspect ratio. Used by the native-aspect generators so the
// JPEG ends up the exact size of the scaled frame (no surrounding
// canvas to flatten into dark bars on JPEG export).
function nativeAspectDims(sourceW, sourceH) {
  if (!Number.isFinite(sourceW) || !Number.isFinite(sourceH) || sourceW <= 0 || sourceH <= 0) {
    return { width: MAX_DIM, height: MAX_DIM };
  }
  const scale = Math.min(MAX_DIM / sourceW, MAX_DIM / sourceH, 1);
  return {
    width: Math.max(1, Math.round(sourceW * scale)),
    height: Math.max(1, Math.round(sourceH * scale)),
  };
}

// ── Image ────────────────────────────────────────────────────────────────
// Loads the file into an <img> via an object URL, then draws it onto a
// fixed-size canvas with letterboxing. Object URL revoked in finally so
// we don't leak across uploads.
async function generateImageThumbnail(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload  = () => resolve(el);
      el.onerror = () => reject(new Error('Image load failed'));
      el.src = url;
    });
    const canvas = newCanvas();
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = BACKDROP;
    ctx.fillRect(0, 0, TARGET_W, TARGET_H);
    const { drawW, drawH, offsetX, offsetY } = fitBox(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
    return await canvasToJpegBlob(canvas);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── PDF ──────────────────────────────────────────────────────────────────
// pdf.js is heavy (~500KB main + ~500KB worker), so the loader is shared
// with the full-size preview viewer (src/components/FilePreview.jsx) via
// src/lib/pdfWorker.js. Single worker port across thumbnail rastering AND
// in-modal pagination — first-touch wins, second touch is a cached
// microtask.
import { loadPdfModule } from './pdfWorker';

async function generatePdfThumbnail(file) {
  try {
    const pdfjs = await loadPdfModule();
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buffer }).promise;
    const page = await pdf.getPage(1);

    // pdf.js's getViewport works in PDF units (72/inch). Scale the
    // page to fit inside a MAX_DIM × MAX_DIM bounding box while
    // preserving aspect — the resulting canvas IS the scaled page,
    // no surrounding letterbox area. Most PDFs are portrait (8.5×11),
    // so the canvas comes out taller than wide; the modal preview
    // displays this edge-to-edge, and the Files grid letterboxes via
    // CSS using the container's dark backdrop.
    const baseViewport = page.getViewport({ scale: 1 });
    const { width, height } = nativeAspectDims(baseViewport.width, baseViewport.height);
    const scale = width / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    // White page background — most PDFs render assuming a white page.
    // No outer letterbox fill anymore (canvas is exactly the page
    // size), so this is the only fill needed.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;

    return await canvasToJpegBlob(canvas);
  } catch {
    return null;
  }
}

// ── Video ────────────────────────────────────────────────────────────────
// Loads the file into a hidden <video>, seeks to ~1s (skips the black-
// frame intro most videos start with), draws to canvas. The video
// element is detached after use so the codec / decoder pipeline is torn
// down. preload="auto" so the browser actually fetches enough bytes to
// satisfy the seek; preload="metadata" alone hangs `seeked` indefinitely
// on some codecs in Chromium.
async function generateVideoThumbnail(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  // muted+playsInline lets autoplay-restricted contexts seek without
  // raising the "user gesture required" rail. We're not actually
  // autoplaying — just seeking — but the restriction can still trip.
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';

  try {
    // Wait for enough data to know dimensions + be seekable.
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Video load failed'));
      video.src = url;
    });

    // Seek target: 1s in, or 10% of duration for very short clips, or
    // 0 if the video is shorter than that. Picking past 0 dodges the
    // black-frame intro most videos open with.
    const target = Math.min(1, Math.max(0, (video.duration || 0) * 0.1));
    await new Promise((resolve, reject) => {
      video.onseeked = resolve;
      video.onerror = () => reject(new Error('Video seek failed'));
      video.currentTime = target;
    });

    // Native-aspect canvas: sized to the scaled video frame so the
    // resulting JPEG has no surrounding letterbox bars baked in.
    // Portrait (9:16) videos come out as portrait thumbnails; the
    // upload-modal preview displays them edge-to-edge, the Files
    // grid letterboxes via CSS.
    const { width, height } = nativeAspectDims(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, width, height);

    return await canvasToJpegBlob(canvas);
  } catch {
    return null;
  } finally {
    // Detach handlers + free the underlying decoder before revoking the
    // object URL — revoking while the decoder still references the blob
    // can leave the chunk in memory until next GC.
    video.onloadedmetadata = null;
    video.onseeked = null;
    video.onerror = null;
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

// ── Multi-frame video extraction ────────────────────────────────────────
// Yields up to 5 JPEG frames at fixed relative offsets through the video,
// for the hover slideshow on the Files grid + the inline preview in the
// File Detail modal. Returns an empty array on metadata-load failure or
// undecodable duration; individual frame failures are silently skipped
// (a 4-frame slideshow is still better than 0). Caller is expected to
// wrap with withTimeout() so a stuck seek doesn't hang upload forever.
//
// Frames sampled at 10/30/50/70/90% of duration — avoids the black intro
// most clips open with and the credits/fade-to-black many end with. For
// very short clips (where 0.9 * duration would butt up against the end
// and trip a "past end of stream" error in some codecs), we clamp the
// target to `duration - 0.05`. This is best-effort: a 0.3s clip won't
// produce 5 distinct frames, but it won't crash either.
//
// Uses addEventListener with `{ once: true }` and explicit cleanup rather
// than the .onseeked/.onerror property pattern used by the single-frame
// generator above — assigning the property handlers in a loop creates a
// race where a late `seeked` event from iteration N can fire AFTER we've
// already moved on to iteration N+1 and rewired the resolver, briefly
// drawing the wrong frame.
const FRAME_OFFSETS = [0.1, 0.3, 0.5, 0.7, 0.9];
export const VIDEO_FRAME_COUNT = FRAME_OFFSETS.length;

export async function generateVideoFrames(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';

  const frames = [];
  try {
    await new Promise((resolve, reject) => {
      const onLoaded = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('Video load failed')); };
      function cleanup() {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      }
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.src = url;
    });

    const duration = video.duration || 0;
    if (!Number.isFinite(duration) || duration <= 0) return [];

    const targets = FRAME_OFFSETS.map((p) =>
      Math.max(0, Math.min(duration - 0.05, duration * p)),
    );

    for (const target of targets) {
      try {
        await new Promise((resolve, reject) => {
          const onSeeked = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error('Video seek failed')); };
          function cleanup() {
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
          }
          video.addEventListener('seeked', onSeeked, { once: true });
          video.addEventListener('error', onError, { once: true });
          video.currentTime = target;
        });

        // Native-aspect canvas per frame (no letterbox bars baked
        // in). Sized lazily inside the loop — videoWidth/Height is
        // stable across seeks, but we still recompute defensively
        // in case the decoder reports new dims partway through (some
        // formats with rotation metadata can).
        const { width, height } = nativeAspectDims(video.videoWidth, video.videoHeight);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, width, height);
        const blob = await canvasToJpegBlob(canvas);
        if (blob) frames.push(blob);
      } catch {
        // Single-frame failure — keep going, return whatever frames landed.
      }
    }
    return frames;
  } catch {
    return [];
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

// Storage path for the Nth video frame. Mirrors the single-thumb path
// convention but with an index suffix so the existing `_thumb.jpg` slot
// stays available for image/PDF/legacy callers. Centralised so the
// renderer (VideoFrameSlideshow) and the uploader agree on the format.
export function buildVideoFramePath(projectId, fileId, index) {
  return `${projectId}/${fileId}/_thumb_${index}.jpg`;
}

// Extract a video file's duration in seconds via a hidden <video> +
// the `loadedmetadata` event. Cheap (only fetches enough bytes for
// the header) and runs in parallel with the main upload, so the
// duration is usually available by the time the upload finishes.
// Returns null on any failure (codec unsupported, metadata never
// arrives, NaN/Infinity duration) — caller treats null as "no
// duration available" and skips the badge in the UI.
export async function extractVideoDuration(file) {
  if (!file || !file.type?.startsWith('video/')) return null;
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  try {
    const duration = await withTimeout(new Promise((resolve, reject) => {
      const onLoaded = () => { cleanup(); resolve(video.duration); };
      const onError = () => { cleanup(); reject(new Error('Video load failed')); };
      function cleanup() {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      }
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.src = url;
    }), GENERATE_TIMEOUT_MS);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return duration;
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────────
// Returns a Blob (image/jpeg) on success, null on:
//   - unsupported MIME (text/* and anything else)
//   - generation failure (logged silently)
//   - timeout (per-generator cap above)
// All three generators are async, none throw — the upload pipeline can
// `await generateThumbnail(file)` and trust that null means "no thumb,
// fall back to a glyph in the UI".
export async function generateThumbnail(file) {
  if (!file?.type) return null;
  const t = file.type;
  let generator = null;
  if (t.startsWith('image/'))   generator = generateImageThumbnail(file);
  else if (t === 'application/pdf') generator = generatePdfThumbnail(file);
  else if (t.startsWith('video/')) generator = generateVideoThumbnail(file);
  else return null;
  return withTimeout(generator, GENERATE_TIMEOUT_MS);
}

// Exported for the upload pipeline's orphan-cleanup path — same naming
// convention as the main file's storage path, just with the `_thumb.jpg`
// terminal segment. Kept in one place so the path format can be tweaked
// (e.g. webp) without grepping the whole codebase.
export function buildThumbnailPath(projectId, fileId) {
  return `${projectId}/${fileId}/_thumb.jpg`;
}
