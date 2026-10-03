// Reading any file to text — a picture or a scanned PDF by OCR, a PDF's text
// layer, a Word / Excel file or plain text directly. Used by the AI scan, the
// insights, the PDF conversion and the viewer.

import { recognizeCanvas, OCR_MAX_EDGE } from './ocr';
import { isCloudMediaAllowed } from './cloudMedia';
import { saveAiFacet, stampFor, bestTextFor } from './aiData';
import { loadPdfModule } from './pdfWorker';
import { extractFileText } from './extractFileText';
import { extractDocText } from './platform';
import { isIdentityFile } from './identities';

// Read an image file with the OCR the Doc Viewer already uses. The lasso tool
// hands `recognizeCanvas` a cropped canvas; here the whole picture is the crop,
// scaled down to the edge Claude works at so the upload stays small.
//
// Two decode paths on purpose. `createImageBitmap` is the fast one but throws
// on formats the browser will still happily paint — HEIC from an iPhone above
// all, which is exactly what a photo of an ID card arrives as. An <img> decode
// covers those, so a picture the viewer can SHOW is a picture this can read.
async function decodeToCanvas(blob) {
  let width = 0;
  let height = 0;
  let source = null;
  try {
    source = await createImageBitmap(blob);
    width = source.width; height = source.height;
  } catch {
    source = null;
  }
  if (!source) {
    const url = URL.createObjectURL(blob);
    try {
      source = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('decode_failed'));
        img.src = url;
      });
      width = source.naturalWidth; height = source.naturalHeight;
    } finally {
      // Revoked after draw, below — an <img> still needs its src while painting.
      source && (source._objectUrl = url);
      if (!source) URL.revokeObjectURL(url);
    }
  }
  if (!width || !height) throw new Error('decode_failed');

  const scale = Math.min(1, OCR_MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  // A white ground: a photo with transparency would otherwise reach the model
  // as text on black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  try { source.close?.(); } catch { /* not all engines expose close() */ }
  if (source._objectUrl) URL.revokeObjectURL(source._objectUrl);
  return canvas;
}

async function ocrImageBlob(blob, { cloud = false } = {}) {
  const canvas = await decodeToCanvas(blob);
  return recognizeCanvas(canvas, undefined, { cloud });
}


// ── Reading a record off ANY file ───────────────────────────────────────
// A photograph is only one of the ways an identity reaches a project. The same
// card arrives as a scanned PDF from the client, the company's details sit in a
// certificate exported to PDF or in the opening clause of a Word contract. So
// the reader takes whatever it is given and finds the route to its text:
//
//   picture            → OCR (as above)
//   PDF with text      → its text layer
//   PDF without text   → a scan: its first pages are rendered and OCR'd
//   Word / Excel / text→ extracted in the renderer
//   legacy .doc        → extracted by the main process (needs the file's path)
//   anything else      → read as text if that is what the bytes turn out to be
//
// What cannot be read says why, in the caller's terms, rather than failing as
// "unsupported": audio and video have no page to read, an identity record is
// already one.
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|heic|heif|bmp|tiff?|gif|avif)$/i;
const MEDIA_EXT_RE = /\.(mp3|wav|m4a|ogg|opus|flac|aac|mp4|mov|mkv|webm|avi|wmv)$/i;
// How many pages of a text-less PDF are OCR'd. An identity document is one or
// two pages; past that a scan is a contract, and each page is a paid call.
const SCAN_PDF_PAGES = 4;

export function identitySourceKind(name, mime = '') {
  const n = String(name || '').toLowerCase();
  if (isIdentityFile(n)) return 'identity';
  if (IMAGE_EXT_RE.test(n) || mime.startsWith('image/')) return 'image';
  if (/\.pdf$/.test(n) || mime === 'application/pdf') return 'pdf';
  if (MEDIA_EXT_RE.test(n) || mime.startsWith('audio/') || mime.startsWith('video/')) return 'media';
  if (/\.doc$/.test(n)) return 'doc';
  return 'document';
}

async function ocrPdfPages(blob, { cloud = false } = {}) {
  const pdfjs = await loadPdfModule();
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  try {
    const out = [];
    const pages = Math.min(doc.numPages, SCAN_PDF_PAGES);
    for (let p = 1; p <= pages; p += 1) {
      const page = await doc.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, OCR_MAX_EDGE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const text = await recognizeCanvas(canvas, undefined, { cloud });
      if (text) out.push(text);
    }
    return out.join('\n\n');
  } finally {
    try { doc.destroy(); } catch { /* ignore */ }
  }
}

// Bytes that are text without saying so — a .eml, a .vcf, an extensionless
// export. Decoded strictly, and rejected if it is mostly control characters.
async function sniffText(blob) {
  try {
    const buf = await blob.slice(0, 200000).arrayBuffer();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    // eslint-disable-next-line no-control-regex
    const odd = (text.match(/[\u0000-\u0008\u000e-\u001f]/g) || []).length;
    return odd > text.length * 0.02 ? '' : text;
  } catch {
    return '';
  }
}

// `{ text }` or `{ error, detail? }`. Errors: decode_failed, ocr_failed,
// no_text, media, identity, unsupported.
// WHAT IS ALREADY KNOWN COMES FIRST. Whatever has been read out of this file
// before is in its AI data (lib/aiData) and is shown in the Doc Viewer's Data
// tab: the `ocr` facet (this transcription) and the `text` facet (what the image
// pane's Extract text read — the same Claude OCR, laid on the measured pieces).
// Either answers "what does this file say", so a file on disk is transcribed
// ONCE and every later reading — this record, another record, another window —
// is free until the file changes. Only with nothing saved does the scan run.
// `force` reads it again (the Data tab's Recapture).
// `cloudOcr` — send pictures and scanned pages to the AI's OCR. Left out, the
// project's cloud-media switch decides (lib/cloudMedia, OFF by default): off,
// they are read on this computer by PaddleOCR.
export async function readSourceText(blob, name, { path, force = false, projectId, cloudOcr } = {}) {
  const cloud = cloudOcr ?? isCloudMediaAllowed(projectId || undefined);
  if (!blob) return { error: 'no_image' };
  const kind = identitySourceKind(name, blob.type || '');
  if (kind === 'media') return { error: 'media' };
  if (kind === 'identity') return { error: 'identity' };
  const stamp = path ? await stampFor(path) : null;
  const saved = path && !force ? bestTextFor(path, stamp) : '';
  const keep = (text) => {
    if (path && text.trim()) saveAiFacet({ path, name, projectId }, 'ocr', { data: { text }, engine: cloud ? 'claude' : 'paddleocr', stamp });
    return text.trim() ? { text } : { error: 'no_text' };
  };
  try {
    if (kind === 'image') {
      if (saved) return { text: saved, cached: true };
      return keep(await ocrImageBlob(blob, { cloud }));
    }
    if (kind === 'pdf') {
      const layer = await extractFileText(blob, name);
      if (layer?.text && layer.text.replace(/\s+/g, '').length > 40) return { text: layer.text };
      // No text layer worth the name: it is a scan.
      if (saved) return { text: saved, cached: true };
      return keep(await ocrPdfPages(blob, { cloud }));
    }
    if (kind === 'doc') {
      const res = path ? await extractDocText(path) : null;
      const text = String(res?.text || '').trim();
      return text ? { text } : { error: res?.error ? 'unsupported' : 'no_text' };
    }
    const res = await extractFileText(blob, name);
    if (res?.text) return { text: res.text };
    if (res?.error === 'empty') return { error: 'no_text' };
    const sniffed = (await sniffText(blob)).trim();
    return sniffed ? { text: sniffed.slice(0, 16000) } : { error: 'unsupported' };
  } catch (e) {
    const why = String(e?.message || '');
    if (why === 'decode_failed') return { error: 'decode_failed' };
    return { error: 'ocr_failed', detail: why };
  }
}
