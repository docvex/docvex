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

// ── DOCX ─────────────────────────────────────────────────────────────────
// .docx is a ZIP archive containing `word/document.xml` with the
// document body. There's no native browser renderer for it, and we
// don't want a heavyweight dep just for thumbnails — so we parse the
// ZIP by hand (8 fixed-offset reads) and decompress the one entry we
// care about via the native DecompressionStream('deflate-raw') API
// (Chromium >= 103, Electron 25+). Text content is extracted from
// <w:t> runs and rendered onto a paper-styled canvas; the result
// resembles an Explorer preview pane more than a faithful Word
// render, but it lets the user identify the document at a glance.

// Find the End Of Central Directory record. Sits at the end of the
// zip; may have a trailing comment up to 64 KiB, so we scan backward
// for the signature. Returns the byte offset of the EOCD, or -1.
function findEocd(view) {
  const sig = 0x06054b50;
  const len = view.byteLength;
  const minScan = Math.max(0, len - 65557);
  for (let i = len - 22; i >= minScan; i--) {
    if (view.getUint32(i, true) === sig) return i;
  }
  return -1;
}

// Walk the central directory, return { localOffset, compressedSize,
// method } for the first entry whose filename matches `targetName`,
// or null if not found.
function findZipEntry(view, uint8, cdOffset, cdEntries, targetName) {
  const decoder = new TextDecoder();
  let cursor = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) return null;
    const method         = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const filenameLength = view.getUint16(cursor + 28, true);
    const extraLength    = view.getUint16(cursor + 30, true);
    const commentLength  = view.getUint16(cursor + 32, true);
    const localOffset    = view.getUint32(cursor + 42, true);
    const filename = decoder.decode(uint8.subarray(cursor + 46, cursor + 46 + filenameLength));
    if (filename === targetName) {
      return { localOffset, compressedSize, method };
    }
    cursor += 46 + filenameLength + extraLength + commentLength;
  }
  return null;
}

// Read + decompress a single zip entry. Supports STORED (method 0)
// and DEFLATE (method 8); other methods (rarely used in docx) return
// null. Uses DecompressionStream('deflate-raw') because zip entries
// use raw deflate (no zlib header) — the alias 'deflate' would
// expect a 2-byte header and fail.
async function readZipEntry(view, uint8, entry) {
  // Local file header: 30 bytes fixed + variable name + variable extra.
  // The compressed-size in the local header is sometimes 0 (zip "data
  // descriptor" mode), so we use the central-directory value instead.
  const off = entry.localOffset;
  if (view.getUint32(off, true) !== 0x04034b50) return null;
  const lfnLength   = view.getUint16(off + 26, true);
  const lextraLength = view.getUint16(off + 28, true);
  const dataStart = off + 30 + lfnLength + lextraLength;
  const compressed = uint8.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method !== 8) return null;
  try {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([compressed]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

// Pull text from a docx XML body. The body is structured as
// <w:p><w:r><w:t>…</w:t></w:r></w:p>; paragraphs are separated by
// </w:p> boundaries. We surface paragraph breaks as newlines so the
// rendered preview has readable line breaks instead of a wall of
// text. HTML-style entities (the four XML ones + numeric &#NN;)
// are decoded.
function extractDocxText(xml) {
  const decodeEntities = (s) => s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  const paragraphs = xml.split(/<\/w:p>/);
  const out = [];
  // Match `<w:t>…</w:t>` and `<w:t xml:space="preserve">…</w:t>`.
  // Multi-line content inside a run is rare but possible; [\s\S]*?
  // covers it without enabling /s flag (compat).
  const runRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  for (const p of paragraphs) {
    let line = '';
    let m;
    while ((m = runRe.exec(p)) !== null) {
      line += decodeEntities(m[1]);
    }
    line = line.trim();
    if (line) out.push(line);
  }
  return out.join('\n');
}

// ── DOCX structured parser ───────────────────────────────────────────────
// Walk the document.xml with the browser's DOMParser and produce a
// per-paragraph / per-run model that carries the formatting bits the
// thumbnail renderer needs: alignment (per paragraph), bold / italic /
// underline / color / font-size / font-family (per run). This lets a
// document with a centred title in red 32pt Calibri render with the
// title centred in red 32pt Calibri on the thumbnail, instead of every
// line falling back to left-aligned 16px Inter.
//
// Returns [{ align, runs: [{ text, bold, italic, underline, color,
// fontSize, fontFamily }] }, ...] OR an empty array if the XML
// couldn't be parsed.

// Local-name accessor: works across both prefixed (`w:p`) and bare
// (`p`) forms regardless of how the browser resolves namespaces.
function _localName(el) {
  return el.localName || el.tagName.split(':').pop();
}

function _firstChild(el, name) {
  if (!el) return null;
  for (const child of el.childNodes) {
    if (child.nodeType === 1 && _localName(child) === name) return child;
  }
  return null;
}

function _childrenByName(el, name) {
  const out = [];
  if (!el) return out;
  for (const child of el.childNodes) {
    if (child.nodeType === 1 && _localName(child) === name) out.push(child);
  }
  return out;
}

// Attribute lookup that tolerates `val` vs `w:val` (and similar
// prefixes for other attribute names). DOMParser in XML mode keeps
// the prefix as part of the attribute name unless namespaces are
// recognised, so a tolerant getAttribute is the safest path.
function _attr(el, name) {
  if (!el) return null;
  return el.getAttribute(name) ?? el.getAttribute(`w:${name}`);
}

// Treat `<w:b/>` as bold-on. An explicit `w:val="0"` or `w:val="false"`
// turns it back off — Word emits this when a character style was
// bold by default but this run un-bolded it.
function _onOffFlag(el) {
  if (!el) return false;
  const v = _attr(el, 'val');
  if (v == null) return true;
  return v !== '0' && v.toLowerCase() !== 'false';
}

// Run properties → flat style object. `inherited` carries the
// paragraph-level defaults (e.g., from a heading style) so a run
// without its own rPr still picks up the right size + weight.
function _parseRunProperties(rPr, inherited) {
  const style = {
    bold: inherited.bold || false,
    italic: inherited.italic || false,
    underline: false,
    color: null,
    fontSize: inherited.fontSize || null,
    fontFamily: inherited.fontFamily || null,
  };
  if (!rPr) return style;
  const b = _firstChild(rPr, 'b');
  if (b) style.bold = _onOffFlag(b);
  const i = _firstChild(rPr, 'i');
  if (i) style.italic = _onOffFlag(i);
  const u = _firstChild(rPr, 'u');
  if (u) {
    const val = _attr(u, 'val');
    style.underline = val !== 'none';
  }
  const color = _firstChild(rPr, 'color');
  if (color) {
    const v = _attr(color, 'val');
    if (v && v !== 'auto' && /^[0-9A-Fa-f]{6}$/.test(v)) style.color = `#${v}`;
  }
  const sz = _firstChild(rPr, 'sz');
  if (sz) {
    // <w:sz w:val="24"/> means 24 half-points = 12 pt.
    const v = parseFloat(_attr(sz, 'val'));
    if (Number.isFinite(v)) style.fontSize = v / 2;
  }
  const rFonts = _firstChild(rPr, 'rFonts');
  if (rFonts) {
    const name = _attr(rFonts, 'ascii') || _attr(rFonts, 'hAnsi') || _attr(rFonts, 'cs');
    if (name) style.fontFamily = name;
  }
  return style;
}

// Map well-known heading / title pStyle ids to a size + weight bump
// applied as the paragraph-level inheritance for runs without their
// own rPr. styles.xml would be authoritative but it's a separate zip
// entry — for a thumbnail this hardcoded map is "close enough" and
// avoids a second parse pass.
function _inheritFromStyle(styleId) {
  const out = { fontSize: null, bold: false, italic: false, fontFamily: null };
  if (!styleId) return out;
  if (styleId === 'Title') { out.fontSize = 28; out.bold = true; }
  else if (/^Heading1\b|^Heading 1$/i.test(styleId)) { out.fontSize = 24; out.bold = true; }
  else if (/^Heading2\b|^Heading 2$/i.test(styleId)) { out.fontSize = 20; out.bold = true; }
  else if (/^Heading3\b|^Heading 3$/i.test(styleId)) { out.fontSize = 16; out.bold = true; }
  else if (/^Heading[4-9]\b/i.test(styleId))         { out.fontSize = 14; out.bold = true; }
  else if (/^Subtitle$/i.test(styleId))               { out.fontSize = 16; out.italic = true; }
  return out;
}

function _parseParagraph(p) {
  const pPr = _firstChild(p, 'pPr');
  let align = 'left';
  let inherited = { fontSize: null, bold: false, italic: false, fontFamily: null };
  if (pPr) {
    const jc = _firstChild(pPr, 'jc');
    if (jc) {
      const val = _attr(jc, 'val');
      // ECMA-376 alignment values → CSS-style alignment names.
      if (val === 'center') align = 'center';
      else if (val === 'right' || val === 'end') align = 'right';
      else if (val === 'both' || val === 'distribute') align = 'justify';
      else align = 'left';
    }
    const pStyle = _firstChild(pPr, 'pStyle');
    if (pStyle) {
      const id = _attr(pStyle, 'val') || '';
      inherited = { ...inherited, ..._inheritFromStyle(id) };
    }
    // rPr inside pPr applies to the paragraph mark itself; some
    // documents also encode the paragraph's default run properties
    // here. Treat it as another inheritance source.
    const ppRunPr = _firstChild(pPr, 'rPr');
    if (ppRunPr) {
      const ppr = _parseRunProperties(ppRunPr, inherited);
      inherited = { ...inherited, ...ppr };
    }
  }

  const runs = [];
  for (const child of p.childNodes) {
    if (child.nodeType !== 1) continue;
    const name = _localName(child);
    if (name === 'r') {
      runs.push(..._parseRun(child, inherited, false));
    } else if (name === 'hyperlink') {
      // Hyperlinks wrap one or more runs; force blue + underline so
      // they read as links in the thumbnail.
      for (const sub of _childrenByName(child, 'r')) {
        for (const seg of _parseRun(sub, inherited, true)) {
          if (!seg.color) seg.color = '#2563eb';
          seg.underline = true;
          runs.push(seg);
        }
      }
    }
  }
  return { align, runs };
}

function _parseRun(r, inherited, fromHyperlink) {
  const rPr = _firstChild(r, 'rPr');
  const baseStyle = _parseRunProperties(rPr, inherited);
  const segments = [];
  for (const child of r.childNodes) {
    if (child.nodeType !== 1) continue;
    const name = _localName(child);
    if (name === 't') {
      const text = child.textContent || '';
      if (text) segments.push({ ...baseStyle, text });
    } else if (name === 'br') {
      segments.push({ ...baseStyle, text: '', lineBreak: true });
    } else if (name === 'tab') {
      segments.push({ ...baseStyle, text: '    ' }); // 4-space tab visual
    }
  }
  return segments;
}

function parseDocxStructure(xml) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) return [];
    const root = doc.documentElement;
    if (!root) return [];
    const body = _firstChild(root, 'body');
    if (!body) return [];
    const result = [];
    for (const child of body.childNodes) {
      if (child.nodeType !== 1) continue;
      if (_localName(child) !== 'p') continue;
      result.push(_parseParagraph(child));
    }
    return result;
  } catch {
    return [];
  }
}

// Canvas renderer that turns the structured paragraphs into a styled
// page. Honors per-paragraph alignment and per-run font / size /
// weight / italic / color / underline. Word-wraps respecting each
// run's measured width so size changes mid-line don't blow past the
// margin.
function renderDocxStructuredToCanvas(ctx, paragraphs, W, H) {
  const margin = 40;
  const maxWidth = W - 2 * margin;
  // Half-point sizes from the file map to canvas pixels; the
  // pre-multiplier gives a readable density on the 600×800 thumb
  // (12pt → 18px, 24pt → 36px). Default when a run has no explicit
  // size comes from PT_DEFAULT.
  const PT_TO_PX = 1.5;
  const PT_DEFAULT = 11;
  const LINE_HEIGHT_MULT = 1.35;
  let y = margin + 12;

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#222222';

  const fontFor = (style) => {
    const pt = style?.fontSize || PT_DEFAULT;
    const px = pt * PT_TO_PX;
    const fam = style?.fontFamily
      ? `"${style.fontFamily}", "Inter", system-ui, sans-serif`
      : `"Inter", system-ui, sans-serif`;
    const parts = [];
    if (style?.italic) parts.push('italic');
    if (style?.bold)   parts.push('bold');
    parts.push(`${px}px`);
    parts.push(fam);
    return { font: parts.join(' '), px };
  };

  const measureToken = (text, style) => {
    const { font } = fontFor(style);
    ctx.font = font;
    return ctx.measureText(text).width;
  };

  outer: for (const para of paragraphs) {
    if (para.runs.length === 0) {
      // Empty paragraph — visual blank line. Use the default size.
      y += PT_DEFAULT * PT_TO_PX * LINE_HEIGHT_MULT * 0.6;
      if (y > H - margin) break;
      continue;
    }

    // Tokenise: each word becomes its own token carrying the
    // owning run's style. Whitespace runs become 'space' tokens so
    // line-breaks can drop them at line boundaries.
    const tokens = [];
    for (const seg of para.runs) {
      if (seg.lineBreak) {
        tokens.push({ type: 'break' });
        continue;
      }
      const parts = seg.text.split(/(\s+)/);
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          tokens.push({ type: 'space', style: seg, width: measureToken(' ', seg) });
        } else {
          tokens.push({ type: 'word', text: part, style: seg, width: measureToken(part, seg) });
        }
      }
    }

    // Greedy wrap.
    const lines = [];
    let line = [];
    let lineWidth = 0;
    for (const tk of tokens) {
      if (tk.type === 'break') {
        lines.push(line);
        line = [];
        lineWidth = 0;
        continue;
      }
      if (lineWidth + tk.width > maxWidth && line.length > 0) {
        lines.push(line);
        line = (tk.type === 'space') ? [] : [tk];
        lineWidth = (tk.type === 'space') ? 0 : tk.width;
      } else {
        line.push(tk);
        lineWidth += tk.width;
      }
    }
    if (line.length > 0) lines.push(line);

    // Render each wrapped line.
    for (const ln of lines) {
      // Trim leading + trailing spaces (justify could keep them but
      // we treat 'justify' the same as 'left' here — proportional
      // spacing in a 600px thumbnail isn't worth the implementation).
      while (ln.length && ln[0].type === 'space') ln.shift();
      while (ln.length && ln[ln.length - 1].type === 'space') ln.pop();
      // Recompute width after trim.
      let w = 0;
      for (const tk of ln) w += tk.width;
      // Tallest run on this line drives line height.
      let maxPx = PT_DEFAULT * PT_TO_PX;
      for (const tk of ln) {
        const { px } = fontFor(tk.style);
        if (px > maxPx) maxPx = px;
      }
      const lh = maxPx * LINE_HEIGHT_MULT;
      const baseline = y + maxPx * 0.85;
      if (baseline > H - margin) break outer;

      let x;
      if (para.align === 'center')      x = margin + (maxWidth - w) / 2;
      else if (para.align === 'right')  x = margin + (maxWidth - w);
      else                              x = margin;

      for (const tk of ln) {
        const { font, px } = fontFor(tk.style);
        ctx.font = font;
        ctx.fillStyle = tk.style?.color || '#222222';
        if (tk.type === 'word') {
          ctx.fillText(tk.text, x, baseline);
          if (tk.style?.underline) {
            // Underline sits a couple of px below the baseline; thickness
            // scales with font size so a 36px heading gets a thicker line.
            const thickness = Math.max(1, Math.round(px / 14));
            ctx.fillRect(x, baseline + 2, tk.width, thickness);
          }
        }
        x += tk.width;
      }

      y += lh;
      if (y > H - margin) break outer;
    }

    // Paragraph spacing — half a default line.
    y += PT_DEFAULT * PT_TO_PX * 0.4;
    if (y > H - margin) break;
  }
}

// Public: pull the plain text out of a .docx Blob/File. Reuses the
// same hand-rolled zip + DecompressionStream pipeline the thumbnail
// generator uses — no heavyweight Word renderer dep. Returns the
// extracted paragraphs joined by newlines, or an empty string when
// the file isn't a valid docx (missing EOCD, missing
// word/document.xml, or unsupported compression method). The preview
// pane consumes this directly.
export async function extractDocxTextFromFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const view = new DataView(buf);
    const uint8 = new Uint8Array(buf);
    const eocd = findEocd(view);
    if (eocd < 0) return '';
    const cdEntries = view.getUint16(eocd + 10, true);
    const cdOffset  = view.getUint32(eocd + 16, true);
    const entry = findZipEntry(view, uint8, cdOffset, cdEntries, 'word/document.xml');
    if (!entry) return '';
    const xmlBytes = await readZipEntry(view, uint8, entry);
    if (!xmlBytes) return '';
    return extractDocxText(new TextDecoder().decode(xmlBytes));
  } catch {
    return '';
  }
}

async function generateDocxThumbnail(file) {
  // 1. Parse the zip, locate word/document.xml, build the structured
  // paragraph model (alignment + per-run styling). Plain-text fallback
  // stays as a safety net for the placeholder render if the structured
  // parser comes back empty.
  let paragraphs = [];
  let fallbackText = '';
  try {
    const buf = await file.arrayBuffer();
    const view = new DataView(buf);
    const uint8 = new Uint8Array(buf);
    const eocd = findEocd(view);
    if (eocd >= 0) {
      const cdEntries = view.getUint16(eocd + 10, true);
      const cdOffset  = view.getUint32(eocd + 16, true);
      const entry = findZipEntry(view, uint8, cdOffset, cdEntries, 'word/document.xml');
      if (entry) {
        const xmlBytes = await readZipEntry(view, uint8, entry);
        if (xmlBytes) {
          const xml = new TextDecoder().decode(xmlBytes);
          paragraphs = parseDocxStructure(xml);
          if (paragraphs.length === 0) fallbackText = extractDocxText(xml);
        }
      }
    }
  } catch {
    paragraphs = [];
    fallbackText = '';
  }

  // 2. Render a portrait "page" canvas. 600x800 = 3:4 paper aspect at
  // 2x density for the 300-wide grid cards. The Files grid container
  // letterboxes via CSS so portrait documents read as documents (not
  // stretched landscape).
  const W = 600;
  const H = 800;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  // Page background — off-white so it reads as paper, not as a hole.
  ctx.fillStyle = '#fcfcfb';
  ctx.fillRect(0, 0, W, H);
  // Word-blue ribbon along the top edge — visual cue that this is a
  // .docx, distinct from the PDF preview (which is the actual page 1
  // rendered by pdf.js with a white background and no header band).
  ctx.fillStyle = '#2b579a';
  ctx.fillRect(0, 0, W, 14);

  if (paragraphs.length > 0) {
    renderDocxStructuredToCanvas(ctx, paragraphs, W, H);
  } else if (fallbackText) {
    // Structured parse failed but plain-text salvage worked — render
    // a calmer left-aligned default layout so the user still sees
    // recognisable content.
    const margin = 40;
    const lineHeight = 22;
    ctx.fillStyle = '#222222';
    ctx.font = `16px "Inter", system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    const maxWidth = W - 2 * margin;
    let y = margin + 8;
    const lines = fallbackText.split('\n');
    outer: for (const para of lines) {
      const words = para.split(/\s+/);
      let line = '';
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
          ctx.fillText(line, margin, y);
          y += lineHeight;
          if (y > H - margin) break outer;
          line = word;
        } else {
          line = test;
        }
      }
      if (line && y <= H - margin) {
        ctx.fillText(line, margin, y);
        y += lineHeight;
      }
      y += lineHeight * 0.4;
      if (y > H - margin) break;
    }
  } else {
    // Couldn't extract anything (encrypted docx, malformed zip,
    // unsupported compression method). Fall back to a placeholder
    // that still reads as a Word document at a glance.
    ctx.fillStyle = '#2b579a';
    ctx.font = 'bold 96px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('W', W / 2, H / 2 - 30);
    ctx.fillStyle = '#666666';
    ctx.font = '24px sans-serif';
    ctx.fillText('DOCX', W / 2, H / 2 + 60);
  }
  return await canvasToJpegBlob(canvas);
}

// ── Dispatcher ───────────────────────────────────────────────────────────
// Returns a Blob (image/jpeg) on success, null on:
//   - unsupported MIME (text/* and anything else)
//   - generation failure (logged silently)
//   - timeout (per-generator cap above)
// All three generators are async, none throw — the upload pipeline can
// `await generateThumbnail(file)` and trust that null means "no thumb,
// fall back to a glyph in the UI".
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Shared cache for rich-regenerated DOCX thumbnails. Surfaces that
// display DOCX thumbs (file grid cards, version-card mini thumbs,
// the modal preview) all read from this map keyed by content_hash
// — so the second view of a file lands instantly even if the
// renderer evolved since the file was first uploaded. FIFO eviction
// keeps the cache bounded; evicted blob URLs are revoked so we
// don't leak memory.
const _DOCX_RICH_CACHE = new Map();
const _DOCX_RICH_IN_FLIGHT = new Map(); // key → Promise (dedupes concurrent regens)
const _DOCX_RICH_CACHE_MAX = 200;

function _rememberRichDocx(key, blobUrl) {
  if (_DOCX_RICH_CACHE.size >= _DOCX_RICH_CACHE_MAX) {
    const oldest = _DOCX_RICH_CACHE.keys().next().value;
    if (oldest !== undefined) {
      const oldUrl = _DOCX_RICH_CACHE.get(oldest);
      try { URL.revokeObjectURL(oldUrl); } catch { /* ignore */ }
      _DOCX_RICH_CACHE.delete(oldest);
    }
  }
  _DOCX_RICH_CACHE.set(key, blobUrl);
}

// Regenerate a DOCX file's thumbnail from its source bytes, using
// whatever renderer is current. Returns a blob: URL on success or
// null on any failure (caller falls back to the stored thumb / glyph).
//
// `signedUrl`     — already-signed URL pointing at the DOCX bytes
//                   (canonical or pending; the helper doesn't care).
// `contentHash`   — primary cache key. Falls back to signedUrl if
//                   the row doesn't carry a hash yet.
// `fileName`      — used to wrap the fetched Blob as a File so
//                   generateThumbnail's MIME dispatcher routes to
//                   the DOCX path (some signed-URL fetches return
//                   blobs with empty .type).
// `mimeType`      — same — passed onto the File wrapper.
//
// Concurrent calls for the same cache key dedupe via the in-flight
// map: two surfaces opening the same file at once share one fetch.
export async function getRichDocxThumbnail({ signedUrl, contentHash, fileName, mimeType }) {
  if (!signedUrl) return null;
  const key = contentHash || signedUrl;
  const cached = _DOCX_RICH_CACHE.get(key);
  if (cached) return cached;
  const existing = _DOCX_RICH_IN_FLIGHT.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const res = await fetch(signedUrl);
      if (!res.ok) return null;
      const blob = await res.blob();
      const typed = new File(
        [blob],
        fileName || 'document.docx',
        { type: mimeType || DOCX_MIME },
      );
      const thumbBlob = await generateThumbnail(typed);
      if (!thumbBlob) return null;
      const url = URL.createObjectURL(thumbBlob);
      _rememberRichDocx(key, url);
      return url;
    } catch {
      return null;
    } finally {
      _DOCX_RICH_IN_FLIGHT.delete(key);
    }
  })();
  _DOCX_RICH_IN_FLIGHT.set(key, promise);
  return promise;
}

// Helper for callers that just want to know "is this a DOCX?"
// without duplicating the DOCX_MIME / `.docx` extension check.
export function isDocxFile(mimeType, fileName) {
  if ((mimeType || '') === DOCX_MIME) return true;
  if ((fileName || '').toLowerCase().endsWith('.docx')) return true;
  return false;
}

// Thumbnails are intentionally limited to image / video / PDF. Other
// types (DOCX, text, generic binaries) get a MIME glyph in the UI
// instead — rasterized "previews" of document formats were misleading
// (font fallbacks, broken layout) and the rich DOCX renderer in
// particular was a maintenance tax for a fundamentally approximate
// rendering. The DOCX generator is still exported below for callers
// that explicitly opt in (none today); the dispatcher just won't
// route to it.
export async function generateThumbnail(file) {
  if (!file) return null;
  const t = file.type || '';
  let generator = null;
  if (t.startsWith('image/'))      generator = generateImageThumbnail(file);
  else if (t === 'application/pdf') generator = generatePdfThumbnail(file);
  else if (t.startsWith('video/'))  generator = generateVideoThumbnail(file);
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
