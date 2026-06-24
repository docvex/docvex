import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import FilePreview from '../components/FilePreview';
import FileThumbnail from '../components/FileThumbnail';
import CursorSpotlight from '../components/CursorSpotlight';
import ProjectFiles from './Projects/ProjectFiles';
import { PaneChromeProvider, usePaneChromePortalRef } from '../context/PaneChromeContext';
import { ItemGlyph, ItemThumbnail } from '../components/FilesWorkspace';
import Tooltip from '../components/Tooltip';
import { useMorphPill } from '../components/useMorphPill';
import { describeLocalFile } from '../lib/thumbnailDescriptor';
import { localFolderApi } from '../lib/localFolder';
import { getCachedPdf } from '../lib/pdfCache';
// Cursor coords / innerWidth / DOMRects are viewport px; the left/top/width
// CSS we set are layout px — under the app's CSS-zoom downscale the two
// differ (see lib/appZoom).
import { toLayoutPx } from '../lib/appZoom';
import { recognizeCanvas, OCR_MAX_EDGE } from '../lib/ocr';
import { loadOcrHistory, saveOcrHistory } from '../lib/extractionHistory';
import { loadCaptions, saveCaptions, clearCaptions } from '../lib/captionsHistory';
import { loadEnvelope, saveEnvelope } from '../lib/audioEnvelopeCache';
import { loadCaptionSettings, saveCaptionSettings } from '../lib/captionPosition';
import { transcribeAudio } from '../lib/transcribe';
import { askProjectAi } from '../lib/projectAi';
import { onDocViewerAddFile, extractDocText, openExternal, onFilesRemoved, notifyFilesChanged } from '../lib/platform';
import { extractFileText } from '../lib/extractFileText';
import { parseWhatsAppChat, splitTimestamp } from '../lib/whatsappChat';
import './DocViewer.css';

// Full-screen document viewer window (opened from the Files page when a file
// is double-clicked). A SINGLE shared window with Chrome-style tabs: the first
// file arrives in the query string; subsequent double-clicks are pushed in via
// `onDocViewerAddFile` and appended as new tabs. Each tab previews the original
// file — image / video / PDF / text via FilePreview, .docx via docx-preview,
// and a fallback (with an OS-open button) for everything else.

// `thumb` asks the localfile handler for a downscaled copy (see main.js) —
// the chat/rail never paint full-resolution photos, which is what made
// media-heavy conversations drop frames while scrolling. Non-image formats
// (and webp/gif, which keep animation + alpha) ignore the param and stream
// the original bytes.
function localUrlFor(path, thumb) {
  if (!path) return null;
  const base = `localfile://local/${encodeURIComponent(path)}`;
  return thumb ? `${base}?thumb=${thumb}` : base;
}
function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}
// Human file size ("426 kB", "1.2 MB") for the attachment meta line.
function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Mirrors guessMimeFromName in main.js — used when the file listing's
// mime is empty/generic and we only have the extension to go on.
const AUDIO_MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
  weba: 'audio/webm',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
};

// ── Date-range filtering for the WhatsApp view ──────────────────────────
// Message timestamps are locale-raw strings ("15/01/2023", "1/15/23",
// "2023-01-15" …) — the view normally avoids parsing them (day dividers
// group by the raw label), but a from/to filter needs real dates. The
// day-vs-month ambiguity is resolved by scanning the WHOLE transcript: any
// label with a first component > 12 proves day-first (dd/mm), any with a
// second component > 12 proves month-first; an ambiguous export falls back
// to day-first (the non-US default). Comparable keys are y*10000+m*100+d.
const DATE_PARTS_RE = /(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})/;

function buildDayResolver(messages) {
  let dayFirst = null;
  for (const m of messages) {
    const { date } = splitTimestamp(m.time);
    const p = date && DATE_PARTS_RE.exec(date);
    if (!p || p[1].length === 4) continue; // ISO labels carry no ambiguity
    if (+p[1] > 12) { dayFirst = true; break; }
    if (+p[2] > 12 && dayFirst == null) dayFirst = false;
  }
  if (dayFirst == null) dayFirst = true;
  const cache = new Map();
  return (time) => {
    const { date } = splitTimestamp(time);
    if (!date) return null;
    if (cache.has(date)) return cache.get(date);
    const p = DATE_PARTS_RE.exec(date);
    let key = null;
    if (p) {
      let d; let mo; let y;
      if (p[1].length === 4) { y = +p[1]; mo = +p[2]; d = +p[3]; }
      else {
        const a = +p[1]; const b = +p[2]; y = +p[3];
        if (a > 12) { d = a; mo = b; }
        else if (b > 12) { d = b; mo = a; }
        else if (dayFirst) { d = a; mo = b; }
        else { d = b; mo = a; }
        if (y < 100) y += 2000;
      }
      if (y >= 1990 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) key = y * 10000 + mo * 100 + d;
    }
    cache.set(date, key);
    return key;
  };
}

// "2023-01-15" (an <input type="date"> value) → the same comparable key.
function dateInputKey(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  return m ? (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]) : null;
}
// Inverse of dateInputKey: a comparable key (y*10000+m*100+d) → "2023-01-15"
// for an <input type="date">. null/invalid → '' (empty input).
function keyToDateInput(key) {
  if (key == null) return '';
  const y = Math.floor(key / 10000);
  const mo = Math.floor((key % 10000) / 100);
  const d = key % 100;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function classify(mime, name) {
  const m = (mime || '').toLowerCase();
  const e = extOf(name);
  if (m === 'application/pdf' || e === 'pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (e === 'docx' || m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return { kind: 'docx', mime: m };
  // Legacy binary Word (.doc / .dot): can't render in-browser — extract text.
  if (e === 'doc' || e === 'dot' || m === 'application/msword') return { kind: 'doc', mime: 'application/msword' };
  // Spreadsheets (Excel / CSV) — rendered as a styled table via SheetJS. Checked
  // before the text branch so a .csv (often text/csv or text/plain) lands here.
  if (e === 'xlsx' || e === 'xls' || e === 'csv'
    || m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || m === 'application/vnd.ms-excel'
    || m === 'text/csv') {
    return { kind: 'sheet', mime: m };
  }
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic', 'avif'].includes(e)) {
    return { kind: 'image', mime: m.startsWith('image/') ? m : 'image/png' };
  }
  if (m.startsWith('video/') || ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(e)) {
    return { kind: 'video', mime: m.startsWith('video/') ? m : 'video/mp4' };
  }
  if (m.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'wma', 'weba', 'aif', 'aiff'].includes(e)) {
    return { kind: 'audio', mime: m.startsWith('audio/') ? m : (AUDIO_MIME_BY_EXT[e] || 'audio/mpeg') };
  }
  if (m.startsWith('text/') || ['txt', 'md', 'rtf', 'log', 'json', 'xml', 'html', 'htm'].includes(e)) {
    return { kind: 'text', mime: e === 'md' ? 'text/markdown' : 'text/plain' };
  }
  return { kind: 'other', mime: m };
}

// Deterministic colour per chat participant (djb2 → vivid HSL), matching the
// avatar-hash pattern used elsewhere — gives each sender a stable name colour.
function senderColor(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i += 1) { h = ((h << 5) - h) + name.charCodeAt(i); h |= 0; }
  return `hsl(${Math.abs(h) % 360} 65% 45%)`;
}

// Split a file path into its directory + the separator in use, so we can
// resolve a chat's media siblings (they live in the same export folder as
// `_chat.txt`). Handles both Windows (\) and POSIX (/) paths.
function dirAndSep(filePath) {
  const p = String(filePath || '');
  const bi = p.lastIndexOf('\\');
  const fi = p.lastIndexOf('/');
  const i = Math.max(bi, fi);
  if (i < 0) return { dir: '', sep: '\\' };
  return { dir: p.slice(0, i), sep: bi > fi ? '\\' : '/' };
}

function mediaKindOf(name) {
  const e = extOf(name);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'tif', 'tiff'].includes(e)) return 'image';
  if (['mp4', 'mov', 'mkv', 'webm', 'm4v', '3gp', 'avi'].includes(e)) return 'video';
  if (['opus', 'ogg', 'oga', 'mp3', 'm4a', 'aac', 'wav'].includes(e)) return 'audio';
  return 'file';
}

// WhatsApp stickers are .webp files exported as "STICKER-…webp" (or the older
// "STK-…"). Detect them so the rail can list them apart from photos.
function isSticker(name) {
  return extOf(name) === 'webp' && /sticker|(^|[^a-z])stk[-_]/i.test(String(name || ''));
}

// The end-to-end-encryption notice WhatsApp injects at the top of a chat. Shown
// as its own lock banner (not a plain system pill). Matches every wording
// variant via the shared key phrase.
function isEncryptionNotice(text) {
  return /end-to-end encrypted/i.test(String(text || ''));
}

const PaperclipGlyph = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21.44 11.05l-8.49 8.49a6 6 0 0 1-8.49-8.49l8.49-8.49a4 4 0 0 1 5.66 5.66l-8.49 8.49a2 2 0 0 1-2.83-2.83l7.78-7.78" />
  </svg>
);
const LockGlyph = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 1.8a4.7 4.7 0 0 0-4.7 4.7V9H6.2A1.7 1.7 0 0 0 4.5 10.7v9A1.7 1.7 0 0 0 6.2 21.4h11.6a1.7 1.7 0 0 0 1.7-1.7v-9A1.7 1.7 0 0 0 17.8 9h-1.1V6.5A4.7 4.7 0 0 0 12 1.8zm0 1.9a2.8 2.8 0 0 1 2.8 2.8V9H9.2V6.5A2.8 2.8 0 0 1 12 3.7z" />
  </svg>
);

const PersonGlyph = (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
    <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.42 0-8 2.69-8 6v2h16v-2c0-3.31-3.58-6-8-6z" />
  </svg>
);

// A document icon coloured + labelled by file type (PDF / DOC / XLS / …). The
// page + folded corner is drawn in the type colour (currentColor, set by the
// `is-*` class) with a solid ribbon carrying the extension label. Used in the
// Docs rail and the in-chat document chip.
function docTypeGlyph(label) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
      <path d="M7 2.5h6.5L18 7v12.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M13.5 2.5V7H18" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <rect x="3" y="12.2" width="13" height="6.2" rx="1.3" fill="currentColor" stroke="none" />
      <text x="9.5" y="16.8" textAnchor="middle" fontSize="4.4" fontWeight="700" letterSpacing="0.2" fill="#fff" stroke="none">{label}</text>
    </svg>
  );
}
const DOC_TYPES = {
  pdf: { label: 'PDF', cls: 'is-pdf' },
  doc: { label: 'DOC', cls: 'is-word' }, docx: { label: 'DOC', cls: 'is-word' },
  rtf: { label: 'RTF', cls: 'is-word' }, odt: { label: 'ODT', cls: 'is-word' }, pages: { label: 'PAGE', cls: 'is-word' },
  xls: { label: 'XLS', cls: 'is-excel' }, xlsx: { label: 'XLS', cls: 'is-excel' },
  csv: { label: 'CSV', cls: 'is-excel' }, ods: { label: 'ODS', cls: 'is-excel' }, numbers: { label: 'NUM', cls: 'is-excel' },
  ppt: { label: 'PPT', cls: 'is-ppt' }, pptx: { label: 'PPT', cls: 'is-ppt' }, odp: { label: 'ODP', cls: 'is-ppt' }, key: { label: 'KEY', cls: 'is-ppt' },
  zip: { label: 'ZIP', cls: 'is-zip' }, rar: { label: 'RAR', cls: 'is-zip' }, '7z': { label: '7Z', cls: 'is-zip' }, gz: { label: 'GZ', cls: 'is-zip' }, tar: { label: 'TAR', cls: 'is-zip' },
  txt: { label: 'TXT', cls: 'is-text' }, log: { label: 'LOG', cls: 'is-text' }, md: { label: 'MD', cls: 'is-text' }, json: { label: 'JSON', cls: 'is-text' }, xml: { label: 'XML', cls: 'is-text' },
};
function docIconFor(name) {
  const e = extOf(name);
  const t = DOC_TYPES[e];
  const label = t ? t.label : (e ? e.slice(0, 4).toUpperCase() : 'FILE');
  return <span className={`dv-doc-ic ${t ? t.cls : 'is-generic'}`}>{docTypeGlyph(label)}</span>;
}

// Parse the bits of a vCard (.vcf) we surface on a contact card: the formatted
// name (FN), a fallback structured name (N), the first phone (TEL), and how
// many contacts the card holds (a shared multi-contact card has several FN).
function parseVcard(text) {
  const lines = String(text || '').split(/\r?\n/);
  let fn = ''; let n = ''; let tel = ''; let count = 0;
  for (const line of lines) {
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const key = line.slice(0, ci).split(';')[0].toUpperCase();
    const val = line.slice(ci + 1).trim();
    if (key === 'FN') { count += 1; if (!fn) fn = val; }
    else if (key === 'N' && !n) n = val.replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
    else if (key === 'TEL' && !tel) tel = val;
  }
  return { name: fn || n, tel, count };
}

// WhatsApp-style shared-contact card: grey avatar + name (and phone / "& N
// others"), then a divider and a "View contact" action that opens the .vcf in
// the OS. The vCard is fetched lazily; until it resolves (or if the file is
// missing) the name falls back to the filename.
function ContactCard({ name, fullPath, url, time }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    if (!url) return undefined;
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => { if (!cancelled && t) setInfo(parseVcard(t)); })
      .catch(() => { /* keep the filename fallback */ });
    return () => { cancelled = true; };
  }, [url]);

  const display = (info && info.name) || name.replace(/\.vcf$/i, '');
  const others = info && info.count > 1 ? info.count - 1 : 0;
  const sub = others > 0 ? `& ${others} other contact${others > 1 ? 's' : ''}` : (info && info.tel) || '';

  return (
    <div className="dv-wa-contact">
      <div className="dv-wa-contact-head">
        <span className="dv-wa-contact-avatar">{PersonGlyph}</span>
        <span className="dv-wa-contact-meta">
          <Tooltip content={display}><span className="dv-wa-contact-name">{display}</span></Tooltip>
          {sub && <span className="dv-wa-contact-sub">{sub}</span>}
        </span>
        {time && <span className="dv-wa-contact-time">{time}</span>}
      </div>
      <button
        type="button"
        className="dv-wa-contact-action"
        onClick={() => { if (fullPath) localFolderApi.openPath(fullPath); }}
        disabled={!fullPath}
      >
        View contact
      </button>
    </div>
  );
}

// A plain-text e-mail address surfaced in the Contacts rail. Mirrors the
// shared-contact card layout but with a "Send e-mail" action (mailto).
function EmailContactCard({ email }) {
  return (
    <div className="dv-wa-contact">
      <div className="dv-wa-contact-head">
        <span className="dv-wa-contact-avatar">{PersonGlyph}</span>
        <span className="dv-wa-contact-meta">
          <Tooltip content={email}><span className="dv-wa-contact-name">{email}</span></Tooltip>
          <span className="dv-wa-contact-sub">E-mail address</span>
        </span>
      </div>
      <button
        type="button"
        className="dv-wa-contact-action"
        onClick={() => openExternal(`mailto:${email}`)}
      >
        Send e-mail
      </button>
    </div>
  );
}

// A document attachment (PDF / Word / Excel / PowerPoint / OpenDocument / zip)
// inside a chat bubble — rendered as a rich card: an OS-generated page preview
// on top (Windows Shell / macOS QuickLook via the localfile `?thumb=` handler;
// absent for archives or where no provider exists), a meta row (type icon,
// filename, "TYPE · size", timestamp), and an Open / Save-as action footer.
const DOC_THUMB_EXTS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
function DocAttachment({ name, fullPath, time, caption, pages }) {
  const [noThumb, setNoThumb] = useState(false);
  const [size, setSize] = useState(null);
  const [pdfPages, setPdfPages] = useState(null);
  const [pdfThumb, setPdfThumb] = useState(null);
  // Prefer WhatsApp's own page count (works for every doc type); fall back to
  // the count pdf.js derives when rendering a PDF's thumbnail.
  const pageCount = pages != null ? pages : pdfPages;
  const ext = extOf(name);
  const fileUrl = fullPath ? localUrlFor(fullPath) : null;
  // PDFs use a pdf.js-rendered first-page image (reliable everywhere); other
  // doc types fall back to the OS thumbnailer via the localfile `?thumb=` route.
  const thumbUrl = ext === 'pdf'
    ? pdfThumb
    : ((fullPath && DOC_THUMB_EXTS.has(ext)) ? localUrlFor(fullPath, 480) : null);
  const showThumb = Boolean(thumbUrl) && !noThumb;
  // Drop WhatsApp's export-id prefix ("00000939-…") from the shown name; the
  // real `name`/`fullPath` (with prefix) is still used to open/resolve the file.
  const displayName = String(name || '').replace(/^\d{4,}-/, '');

  // File size via a 1-byte Range request — the localfile handler answers with
  // `content-range: bytes 0-0/<total>`, so we learn the size without shipping
  // the whole file or adding an IPC round-trip.
  useEffect(() => {
    if (!fileUrl) return undefined;
    let cancelled = false;
    fetch(fileUrl, { headers: { Range: 'bytes=0-0' } })
      .then((r) => {
        const cr = r.headers.get('content-range');
        const m = cr && /\/(\d+)\s*$/.exec(cr);
        const cl = r.headers.get('content-length');
        const n = m ? parseInt(m[1], 10) : (cl ? parseInt(cl, 10) : NaN);
        if (!cancelled && Number.isFinite(n)) setSize(n);
      })
      .catch(() => { /* size is cosmetic — just omit it */ });
    return () => { cancelled = true; };
  }, [fileUrl]);

  // PDFs (reliable via pdf.js, no OS dependency): page count + a real first-page
  // thumbnail rendered to a canvas. The parsed doc is cached so opening the file
  // later reuses it. Other formats don't carry a portable page count.
  useEffect(() => {
    if (ext !== 'pdf' || !fileUrl) return undefined;
    let cancelled = false;
    let objUrl = null;
    (async () => {
      try {
        const doc = await getCachedPdf(fullPath, fileUrl);
        if (cancelled) return;
        if (doc?.numPages) setPdfPages(doc.numPages);
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(2, 480 / base.width) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        if (cancelled) return;
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
        if (cancelled || !blob) return;
        objUrl = URL.createObjectURL(blob);
        setPdfThumb(objUrl);
      } catch { /* thumbnail + page count are cosmetic */ }
    })();
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [ext, fileUrl, fullPath]);

  const typeLabel = DOC_TYPES[ext]?.label || (ext ? ext.toUpperCase() : 'FILE');
  const sub = [
    pageCount != null ? `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : null,
    typeLabel,
    size != null ? formatBytes(size) : null,
  ].filter(Boolean).join(' · ');
  const open = () => localFolderApi.openPath(fullPath);

  return (
    <div className={`dv-wa-doccard${showThumb ? ' has-thumb' : ''}`}>
      {showThumb && (
        <button type="button" className="dv-wa-doccard-preview" onClick={open} aria-label={`Open ${displayName}`}>
          <img src={thumbUrl} alt={displayName} loading="lazy" decoding="async" onError={() => setNoThumb(true)} />
        </button>
      )}
      <button type="button" className="dv-wa-doccard-meta" onClick={open}>
        {docIconFor(name)}
        <span className="dv-wa-doccard-info">
          <Tooltip content={displayName}><span className="dv-wa-doccard-name">{displayName}</span></Tooltip>
          <span className="dv-wa-doccard-sub">{sub}</span>
        </span>
        {time && <span className="dv-wa-doccard-time">{time}</span>}
      </button>
      {caption}
      <div className="dv-wa-doccard-actions">
        <button type="button" className="dv-wa-doccard-btn" onClick={open}>Open</button>
      </div>
    </div>
  );
}

// Inline image attachment. On load we measure the photo's intrinsic ratio and
// size the bubble to match it: the display width is the height-capped width
// (so a landscape photo is wide, a portrait one narrow), floored by a minimum
// so tall/narrow photos don't squeeze the bubble to a sliver. The width is
// published as `--media-w` on the enclosing bubble; CSS clamps the caption to
// it so the caption text can't stretch the bubble wider than the image.
const IMG_MAX_W = 330;
const IMG_MAX_H = 420;
const IMG_MIN_W = 170;
function ImageAttachment({ url, name, fullPath, onError }) {
  const onLoad = (e) => {
    const img = e.currentTarget;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return;
    const w = Math.round(Math.max(IMG_MIN_W, Math.min(IMG_MAX_W, IMG_MAX_H * (nw / nh))));
    img.style.width = `${w}px`;
    img.style.aspectRatio = `${nw} / ${nh}`;
    const bubble = img.closest('.dv-wa-bubble');
    if (bubble) bubble.style.setProperty('--media-w', `${w}px`);
  };
  return (
    <Tooltip content={name}>
      <img
        className="dv-wa-media"
        src={url}
        alt={name}
        loading="lazy"
        decoding="async"
        onLoad={onLoad}
        onError={onError}
        onClick={() => localFolderApi.openPath(fullPath)}
      />
    </Tooltip>
  );
}

// One media attachment inside a chat bubble. Resolves the referenced filename
// against the export folder (same dir as _chat.txt) and renders it inline:
// image / video / <audio> for voice notes, or a clickable chip for documents
// and anything that fails to load (e.g. the file wasn't included in the export).
function ChatAttachment({ name, dir, sep, time, caption, pages }) {
  const [failed, setFailed] = useState(false);
  const fullPath = dir ? `${dir}${sep}${name}` : name;
  const kind = mediaKindOf(name);
  // Bubble images render at ~320 CSS px — a 640px thumb covers 2x densities.
  const url = dir ? localUrlFor(fullPath, kind === 'image' ? 640 : undefined) : null;

  // Shared contact (.vcf) → a WhatsApp-style contact card (renders from the
  // filename even when the file itself wasn't included in the export).
  if (extOf(name) === 'vcf') {
    return <ContactCard name={name} fullPath={url ? fullPath : null} url={url} time={time} />;
  }

  if (url && !failed && kind === 'image') {
    return <ImageAttachment url={url} name={name} fullPath={fullPath} onError={() => setFailed(true)} />;
  }
  if (url && !failed && kind === 'video') {
    // The OS-thumb poster paints instantly; if the handler can't generate
    // one it streams video bytes, the poster fails to decode, and the
    // element falls back to its own metadata first-frame as before.
    return <video className="dv-wa-media" src={url} poster={localUrlFor(fullPath, 640)} controls preload="metadata" onError={() => setFailed(true)} />;
  }
  if (url && !failed && kind === 'audio') {
    return <VoiceNote src={url} onError={() => setFailed(true)} />;
  }
  // Referenced but absent from the export folder → the same "not included in
  // this export" placeholder WhatsApp's own <Media omitted> markers get, rather
  // than a broken-looking filename chip. (WhatsApp caps the media it bundles,
  // so most of a long chat's photos/videos/voice notes simply aren't there.)
  const missing = failed || !url;
  if (missing) {
    const label = MEDIA_MISSING_LABEL[isSticker(name) ? 'sticker' : kind] || 'Attachment';
    return (
      <Tooltip content={`${name} — not included in this export`}>
        <span className="dv-wa-omitted">{PaperclipGlyph}{label} — not included in this export</span>
      </Tooltip>
    );
  }
  // Present document / archive / unknown → a rich card (thumbnail + meta + the
  // caption above a full-width Open button), opening the file in the OS app.
  return <DocAttachment name={name} fullPath={fullPath} time={time} caption={caption} pages={pages} />;
}

// Friendly label for an "exported without media" placeholder.
const OMITTED_LABEL = {
  image: 'Photo', photo: 'Photo', video: 'Video', audio: 'Audio',
  'voice message': 'Voice message', gif: 'GIF', sticker: 'Sticker',
  document: 'Document', 'contact card': 'Contact card', media: 'Media',
};
// Label for a media file that's REFERENCED in the transcript but isn't in the
// export folder — WhatsApp's "Attach Media" only bundles the most recent media
// up to a size cap, so most of a long chat's photos/videos/voice notes simply
// aren't included. Keyed by mediaKindOf (+ a sticker special-case).
const MEDIA_MISSING_LABEL = {
  image: 'Photo', video: 'Video', audio: 'Voice message', sticker: 'Sticker', file: 'Document',
};

// Wrap every occurrence of the (lowercased) search query `q` in <mark> so it
// reads like Windows Explorer's highlighted matches. Returns the original
// string untouched when there's no match.
function markMatches(str, q, kp) {
  if (!q) return str;
  const lower = str.toLowerCase();
  const out = [];
  let i = 0; let idx; let n = 0;
  while ((idx = lower.indexOf(q, i)) !== -1) {
    if (idx > i) out.push(str.slice(i, idx));
    out.push(<mark key={`${kp}-${n}`} className="dv-wa-hl">{str.slice(idx, idx + q.length)}</mark>);
    n += 1;
    i = idx + q.length;
  }
  if (n === 0) return str;
  if (i < str.length) out.push(str.slice(i));
  return out;
}

// Linkify a chat message the way WhatsApp does: URLs and e-mail addresses turn
// into underlined links (opened in the system browser / mail client), IBANs are
// highlighted (click to copy) and @mentions are underlined too; everything else
// stays plain text. When a search query is passed, plain-text runs also get
// their matches wrapped in <mark>. Returns the original string when there's
// nothing to mark up, otherwise an array of strings + <a>/<span> nodes.
const CHAT_LINK_RE = /(https?:\/\/[^\s<]+|www\.[^\s<]+|[^\s<@]+@[^\s<@]+\.[A-Za-z]{2,}|@\w[\w.]*|[A-Z]{2}\d{2}[A-Z0-9]{12,30})/g;
const TRAIL_PUNCT_RE = /[.,!?;:'")\]}]+$/;

function linkifyChat(text, query) {
  const str = String(text ?? '');
  if (!str) return str;
  const q = query || '';
  CHAT_LINK_RE.lastIndex = 0;
  if (!CHAT_LINK_RE.test(str)) return q ? markMatches(str, q, 'h') : str;
  CHAT_LINK_RE.lastIndex = 0;
  const nodes = [];
  let last = 0;
  let m;
  const pushPlain = (s, kp) => {
    if (!s) return;
    const r = q ? markMatches(s, q, kp) : s;
    if (Array.isArray(r)) nodes.push(...r); else nodes.push(r);
  };
  while ((m = CHAT_LINK_RE.exec(str)) !== null) {
    const raw = m[0];
    const start = m.index;
    if (start > last) pushPlain(str.slice(last, start), `p${start}`);
    if (raw[0] === '@') {
      nodes.push(<span key={start} className="dv-wa-mention">{raw}</span>);
      last = start + raw.length;
      continue;
    }
    // Keep trailing sentence punctuation out of the link's target and text.
    const trail = TRAIL_PUNCT_RE.exec(raw);
    const token = trail ? raw.slice(0, raw.length - trail[0].length) : raw;
    if (IBAN_FULL_RE.test(token)) {
      nodes.push(
        <span
          key={start}
          className="dv-wa-iban"
          role="button"
          tabIndex={0}
          title="Copy IBAN"
          onClick={() => copyText(token)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyText(token); } }}
        >
          {token}
        </span>,
      );
      if (trail) pushPlain(trail[0], `t${start}`);
      last = start + raw.length;
      continue;
    }
    const isEmail = token.indexOf('@') !== -1 && !/^(https?:\/\/|www\.)/i.test(token);
    const href = isEmail ? `mailto:${token}` : /^www\./i.test(token) ? `https://${token}` : token;
    nodes.push(
      <a
        key={start}
        className="dv-wa-link-a"
        href={href}
        onClick={(e) => { e.preventDefault(); openExternal(href); }}
      >
        {token}
      </a>,
    );
    if (trail) pushPlain(trail[0], `t${start}`);
    last = start + raw.length;
  }
  if (last < str.length) pushPlain(str.slice(last), `e${last}`);
  return nodes;
}

// WhatsApp appends "<This message was edited>" to a message it has edited.
// Render the body normally (linkified) and the marker as a small muted tag,
// like WhatsApp's inline "Edited" label, instead of literal angle-bracket text.
const EDITED_RE = /\s*<this message was edited>\s*$/i;
function renderMessageText(text, query) {
  const str = String(text ?? '');
  const m = EDITED_RE.exec(str);
  if (!m) return linkifyChat(str, query);
  const body = str.slice(0, m.index);
  return (
    <>
      {linkifyChat(body, query)}
      <span className="dv-wa-edited">Edited</span>
    </>
  );
}

// Does a message / render-row match the live search query (sender, body,
// attachment name or caption)? Used to filter the chat like Explorer's search.
function messageMatchesQuery(m, q) {
  if (!q) return true;
  if (m.sender && m.sender.toLowerCase().includes(q)) return true;
  if (m.text && m.text.toLowerCase().includes(q)) return true;
  if (m.attachment) {
    if (m.attachment.name && m.attachment.name.toLowerCase().includes(q)) return true;
    if (m.attachment.caption && m.attachment.caption.toLowerCase().includes(q)) return true;
  }
  return false;
}
function rowMatchesQuery(row, q) {
  if (!q) return true;
  if (row.kind === 'album') {
    return (row.sender && row.sender.toLowerCase().includes(q)) || row.items.some((it) => messageMatchesQuery(it.msg, q));
  }
  return messageMatchesQuery(row.msg, q);
}

// ── WhatsApp conversation view ─────────────────────────────────────────
// Renders parsed messages as WhatsApp-style bubbles. The participant who sent
// the most messages is treated as "me" (right side, green); everyone else sits
// on the left. Day dividers are grouped by the raw date label so we don't have
// to parse locale-specific date formats.
function isImageAttachment(m) {
  return Boolean(m && !m.system && m.attachment && mediaKindOf(m.attachment.name) === 'image');
}

// Collapse a burst of photos shared at the same instant (same sender + exact
// timestamp) into a single album row — the way WhatsApp groups them. Everything
// else stays a one-message row; system notices pass through untouched.
function buildRenderRows(messages) {
  const rows = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (isImageAttachment(m)) {
      const items = [{ msg: m, index: i }];
      let j = i + 1;
      while (j < messages.length && isImageAttachment(messages[j])
        && messages[j].sender === m.sender && messages[j].time === m.time) {
        items.push({ msg: messages[j], index: j });
        j += 1;
      }
      if (items.length >= 2) {
        rows.push({ kind: 'album', items, sender: m.sender, time: m.time });
        i = j;
        continue;
      }
    }
    rows.push({ kind: m.system ? 'system' : 'message', msg: m, index: i });
    i += 1;
  }
  return rows;
}

// Large-export windowing: only the newest rows are mounted when the
// conversation opens (WhatsApp-style — you land on the latest messages); a
// "Show earlier" pill at the top pages further back. Keeps a 100k-message
// export from mounting 100k bubbles (plus their media elements) at once;
// the rows that ARE mounted additionally skip offscreen layout/paint via
// content-visibility in DocViewer.css.
const WA_INITIAL_ROWS = 400;
const WA_EARLIER_CHUNK = 1200;

// Memoized: every prop is referentially stable across a rail resize / other
// DocTextPane-local state commits, so the (large) conversation subtree only
// re-renders when something it actually shows changes.
const WhatsAppChat = React.memo(function WhatsAppChat({ variant = 'whatsapp', messages, dir, sep, highlight, query, rawQuery, onQueryChange, dateFrom, dateTo, dateMin, dateMax, onDateFromChange, onDateToChange, onResetDates, rangeActive, timeInRange, railOpen, onToggleRail, footerSlot = null, headerSlot = null }) {
  // `query` is the deferred copy (drives the expensive filtering); `rawQuery`
  // is what the header's search input shows so typing never lags behind.
  // `rangeActive`/`timeInRange` come from DocTextPane (shared with the rail).
  const q = (query || '').trim().toLowerCase();
  const meSender = useMemo(() => {
    const counts = new Map();
    for (const m of messages) if (!m.system && m.sender) counts.set(m.sender, (counts.get(m.sender) || 0) + 1);
    let best = null; let bestN = -1;
    for (const [name, n] of counts) if (n > bestN) { best = name; bestN = n; }
    return best;
  }, [messages]);
  // Names only adorn incoming bubbles, and only in a multi-party chat (WhatsApp
  // hides the name in a 1:1).
  const showNames = useMemo(() => {
    const s = new Set(messages.filter((m) => !m.system && m.sender).map((m) => m.sender));
    return s.size > 2;
  }, [messages]);

  // Conversation tallies shown in the footer (middle-dot separated). Reuses the
  // rail's bucketing for media/voice/stickers/docs/links/calls/contacts; text
  // messages are the non-system, non-attachment, non-call lines.
  const stats = useMemo(() => {
    const { media, stickers, voice, docs, contacts, links, calls } = buildRailContent(messages);
    let textCount = 0;
    for (const m of messages) {
      if (m.system || m.attachment || m.omitted) continue;
      if (m.text && detectCall(m.text)) continue;
      if (m.text) textCount += 1;
    }
    return [
      { one: 'message', many: 'messages', n: textCount },
      { one: 'media file', many: 'media', n: media.length },
      { one: 'voice note', many: 'voice notes', n: voice.length },
      { one: 'sticker', many: 'stickers', n: stickers.length },
      { one: 'document', many: 'documents', n: docs.length },
      { one: 'link', many: 'links', n: links.length },
      { one: 'call', many: 'calls', n: calls.length },
      { one: 'contact', many: 'contacts', n: contacts.length },
    ].filter((s) => s.n > 0);
  }, [messages]);

  const rows = useMemo(() => buildRenderRows(messages), [messages]);
  // Live search filters the conversation to matching rows (Explorer-style),
  // while meSender / showNames stay derived from the full transcript so sides
  // and name visibility don't flip mid-search.
  const visibleRows = useMemo(() => {
    if (!q && !rangeActive) return rows;
    return rows.filter((r) => {
      if (rangeActive && !timeInRange(r.kind === 'album' ? r.time : r.msg.time)) return false;
      return !q || rowMatchesQuery(r, q);
    });
  }, [rows, q, rangeActive, timeInRange]);

  // Render window over visibleRows: null = the default tail of the list;
  // "Show earlier" and find-in-chat pull it back. Reset when the conversation
  // or the search changes so a stale window doesn't hide fresh results.
  const [startOverride, setStartOverride] = useState(null);
  useEffect(() => { setStartOverride(null); }, [messages, q, timeInRange]);
  const renderStart = startOverride != null
    ? Math.max(0, Math.min(startOverride, visibleRows.length))
    : Math.max(0, visibleRows.length - WA_INITIAL_ROWS);
  const renderRows = renderStart > 0 ? visibleRows.slice(renderStart) : visibleRows;

  // Land on the newest messages when a conversation first renders (matches
  // WhatsApp). Keyed per messages identity so tab switches re-anchor but
  // search keystrokes / window growth don't. Layout effect so the jump
  // happens before paint — no flash of the conversation's top.
  const endRef = useRef(null);
  const anchoredRef = useRef(null);
  useLayoutEffect(() => {
    if (anchoredRef.current === messages) return;
    anchoredRef.current = messages;
    endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages]);

  // Map every message index → its rendered row element so "Find in chat" can
  // scroll to (and briefly highlight) it. Album rows register all their indices.
  const rowRefs = useRef(new Map());
  const setRowRef = (indices) => (el) => {
    for (const idx of indices) { if (el) rowRefs.current.set(idx, el); else rowRefs.current.delete(idx); }
  };
  // Each find request is handled once (tracked by its bump counter `n`) —
  // the effect also re-fires on window growth so a target that sat behind
  // "Show earlier" can be scrolled to after the expanded window commits,
  // without re-jumping on every later expansion.
  const handledFindRef = useRef(0);
  useEffect(() => {
    if (!highlight || handledFindRef.current === highlight.n) return undefined;
    const el = rowRefs.current.get(highlight.index);
    if (!el) {
      // Not mounted — the row is behind the render window. Pull the window
      // back to include it; this effect re-runs once the rows commit.
      const pos = visibleRows.findIndex((r) => (r.kind === 'album'
        ? r.items.some((it) => it.index === highlight.index)
        : r.index === highlight.index));
      if (pos >= 0 && pos < renderStart) setStartOverride(Math.max(0, pos - 10));
      return undefined;
    }
    handledFindRef.current = highlight.n;
    // Jump straight to the match (no smooth animation) — "find in chat" should
    // teleport, not glide past every message in between.
    el.scrollIntoView({ behavior: 'auto', block: 'center' });
    el.classList.add('is-found');
    const t = setTimeout(() => el.classList.remove('is-found'), 2200);
    return () => clearTimeout(t);
  }, [highlight, renderStart, visibleRows]);

  // ── Header search (find controls) ─────────────────────────────────────
  // While a query is live every visible row IS a match, so Enter / Shift+
  // Enter walk the filtered list (VS-Code's find loop, like the AI chat
  // tab). `nav` carries a bump counter so re-triggering the same position
  // (single match) still re-scrolls.
  const findInputRef = useRef(null);
  const [nav, setNav] = useState(null); // { pos, n }
  useEffect(() => { setNav(null); }, [q, messages, timeInRange]);
  const goMatch = (dirn) => {
    const n = visibleRows.length;
    if (!q || !n) return;
    setNav((prev) => {
      const pos = prev == null ? (dirn > 0 ? 0 : n - 1) : (prev.pos + dirn + n) % n;
      return { pos, n: (prev?.n || 0) + 1 };
    });
  };
  useEffect(() => {
    if (!nav) return undefined;
    const row = visibleRows[nav.pos];
    if (!row) return undefined;
    const idx = row.kind === 'album' ? row.items[0].index : row.index;
    const el = rowRefs.current.get(idx);
    if (!el) {
      // Behind the render window — widen it; this effect re-runs on commit.
      if (nav.pos < renderStart) setStartOverride(Math.max(0, nav.pos - 10));
      return undefined;
    }
    el.scrollIntoView({ behavior: 'auto', block: 'center' });
    el.classList.add('is-found');
    const t = setTimeout(() => el.classList.remove('is-found'), 1400);
    return () => clearTimeout(t);
  }, [nav, renderStart, visibleRows]);

  // Ctrl/⌘+F focuses the header search (matches the AI chat tab). The doc
  // viewer keeps every open tab mounted, so gate on this instance actually
  // being visible (offsetParent is null under a display:none tab).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        const input = findInputRef.current;
        if (!input || input.offsetParent === null) return;
        e.preventDefault();
        input.focus();
        input.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Album cells are small crops — a 480px thumb is plenty at 2x density.
  const imgUrl = (name) => (dir ? localUrlFor(`${dir}${sep}${name}`, 480) : null);
  const openImg = (name) => { if (dir) localFolderApi.openPath(`${dir}${sep}${name}`); };

  let lastDate = null;
  const dividerFor = (time) => {
    const { date } = splitTimestamp(time);
    const d = date && date !== lastDate ? date : null;
    if (date) lastDate = date;
    return d;
  };

  // Docvex skin: incoming messages get a colour-hashed initial avatar to the
  // left of the bubble (own messages have none), mirroring the Team chat tab.
  // Only in GROUP chats though — a 1:1 has a single other party, so the circles
  // are noise there (same `showNames` rule WhatsApp uses to hide sender names).
  // Returns null in the WhatsApp skin, for own messages, in 1:1s, or no sender.
  const docvex = variant === 'docvex';
  const avatarFor = (sender, mine) => (docvex && !mine && sender && showNames)
    ? <span className="dv-wa-avatar" style={{ background: senderColor(sender) }} aria-hidden="true">{(sender.trim()[0] || '?').toUpperCase()}</span>
    : null;

  // A call rendered as a WhatsApp-style call bubble (left = incoming, right =
  // outgoing when we know the caller; system call lines default to incoming).
  const callBubble = (call, mine, clock, index, sender) => (
    <div className={`dv-wa-row ${mine ? 'is-out' : 'is-in'}`} ref={setRowRef([index])}>
      {avatarFor(sender, mine)}
      <div className={`dv-wa-bubble dv-wa-call-bubble${call.missed ? ' is-missed' : call.duration ? ' is-answered' : ''}`}>
        <span className="dv-wa-call-bubble-icon">{call.type === 'video' ? VideoGlyph : PhoneGlyph}</span>
        <span className="dv-wa-call-bubble-text">
          <span className="dv-wa-call-bubble-label">{call.label}</span>
          {(call.callback || call.duration) && (
            <span className="dv-wa-call-bubble-sub">{call.callback ? 'Tap to call back' : call.duration}</span>
          )}
        </span>
        {clock && <span className="dv-wa-time">{clock}</span>}
      </div>
    </div>
  );
  // The search + date-range controls live in a sticky FOOTER at the bottom of
  // the chat section (see the <footer className="dv-wa-footer"> after the
  // message list, and .dv-wa-footer in DocViewer.css).
  return (
    <div className={`dv-wa${docvex ? ' is-docvex' : ''}`}>
      <div className="dv-wa-inner">
        {(q || rangeActive) && visibleRows.length === 0 && (
          <div className="dv-wa-noresults">
            {q ? <>No messages match “{query.trim()}”{rangeActive ? ' in this date range' : ''}.</> : 'No messages in this date range.'}
          </div>
        )}
        {renderStart > 0 && (
          <button
            type="button"
            className="dv-wa-earlier"
            onClick={() => setStartOverride(Math.max(0, renderStart - WA_EARLIER_CHUNK))}
          >
            Show earlier messages ({renderStart.toLocaleString()} more)
          </button>
        )}
        {renderRows.map((row, rri) => {
          // Keys are absolute positions in visibleRows so already-mounted rows
          // keep their identity when "Show earlier" prepends a chunk.
          const ri = renderStart + rri;
          // System notice — or a styled call entry (missed/answered call).
          if (row.kind === 'system') {
            const dayDivider = dividerFor(row.msg.time);
            const call = detectCall(row.msg.text);
            const { clock } = splitTimestamp(row.msg.time);
            return (
              <React.Fragment key={ri}>
                {dayDivider && <div className="dv-wa-day"><span>{dayDivider}</span></div>}
                {call ? callBubble(call, false, clock, row.index)
                  : isEncryptionNotice(row.msg.text) ? (
                    <div className="dv-wa-encryption" ref={setRowRef([row.index])}>
                      <span className="dv-wa-encryption-icon">{LockGlyph}</span>
                      {q ? markMatches(row.msg.text, q, 'sys') : row.msg.text}
                    </div>
                  ) : (
                    <div className="dv-wa-system" ref={setRowRef([row.index])}><span>{q ? markMatches(row.msg.text, q, 'sys') : row.msg.text}</span></div>
                  )}
              </React.Fragment>
            );
          }
          // Album — a burst of photos shared at the same instant.
          if (row.kind === 'album') {
            const dayDivider = dividerFor(row.time);
            const mine = row.sender === meSender;
            const { clock } = splitTimestamp(row.time);
            const caption = row.items.map((it) => it.msg.attachment?.caption).find(Boolean) || '';
            return (
              <React.Fragment key={ri}>
                {dayDivider && <div className="dv-wa-day"><span>{dayDivider}</span></div>}
                <div className={`dv-wa-row ${mine ? 'is-out' : 'is-in'}`} ref={setRowRef(row.items.map((it) => it.index))}>
                  {avatarFor(row.sender, mine)}
                  <div className="dv-wa-bubble has-media dv-wa-album">
                    {!mine && showNames && (
                      <span className="dv-wa-name" style={{ color: senderColor(row.sender) }}>{q ? markMatches(row.sender, q, 'an') : row.sender}</span>
                    )}
                    <div className="dv-wa-album-grid" data-count={Math.min(row.items.length, 4)}>
                      {row.items.map((it, k) => (
                        <Tooltip key={k} content={it.msg.attachment.name}>
                          <button type="button" className="dv-wa-album-cell" onClick={() => openImg(it.msg.attachment.name)}>
                            <img src={imgUrl(it.msg.attachment.name)} alt={it.msg.attachment.name} loading="lazy" decoding="async" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                          </button>
                        </Tooltip>
                      ))}
                    </div>
                    {caption && <span className="dv-wa-text dv-wa-caption">{linkifyChat(caption, q)}</span>}
                    {clock && <span className="dv-wa-time">{clock}</span>}
                  </div>
                </div>
              </React.Fragment>
            );
          }
          // Single message.
          const m = row.msg;
          const dayDivider = dividerFor(m.time);
          const { clock } = splitTimestamp(m.time);
          const mine = m.sender === meSender;
          // A call written as a normal message (group chats carry the caller as
          // the sender) renders as a call bubble, aligned by direction.
          const msgCall = !m.attachment ? detectCall(m.text) : null;
          if (msgCall) {
            return (
              <React.Fragment key={ri}>
                {dayDivider && <div className="dv-wa-day"><span>{dayDivider}</span></div>}
                {callBubble(msgCall, mine, clock, row.index, m.sender)}
              </React.Fragment>
            );
          }
          const caption = m.attachment ? m.attachment.caption : '';
          const hasMedia = Boolean(m.attachment) || Boolean(m.omitted);
          // A shared-contact card carries its own timestamp inside the head (so
          // the "View contact" button can run flush to the bubble's bottom),
          // so suppress the generic floated time for those.
          const isContact = Boolean(m.attachment) && extOf(m.attachment.name) === 'vcf';
          // Document / archive attachments render as a self-contained card that
          // carries its own timestamp — suppress the bubble's floated clock so
          // it isn't shown twice.
          const isDoc = Boolean(m.attachment) && !isContact && mediaKindOf(m.attachment.name) === 'file';
          return (
            <React.Fragment key={ri}>
              {dayDivider && <div className="dv-wa-day"><span>{dayDivider}</span></div>}
              <div className={`dv-wa-row ${mine ? 'is-out' : 'is-in'}`} ref={setRowRef([row.index])}>
                {avatarFor(m.sender, mine)}
                <div className={`dv-wa-bubble${hasMedia ? ' has-media' : ''}${isContact ? ' is-contact' : ''}`}>
                  {!mine && showNames && (
                    <span className="dv-wa-name" style={{ color: senderColor(m.sender) }}>{q ? markMatches(m.sender, q, 'sn') : m.sender}</span>
                  )}
                  {m.attachment ? (
                    <>
                      <ChatAttachment
                        name={m.attachment.name}
                        dir={dir}
                        sep={sep}
                        time={(isContact || isDoc) ? clock : null}
                        pages={m.attachment.pages}
                        caption={isDoc && caption ? <span className="dv-wa-text dv-wa-caption">{linkifyChat(caption, q)}</span> : null}
                      />
                      {/* Media (image/video/audio) keep the caption below the
                          thumbnail; for the document card it's embedded inside
                          (above the Open button) instead. */}
                      {caption && !isDoc && <span className="dv-wa-text dv-wa-caption">{linkifyChat(caption, q)}</span>}
                    </>
                  ) : m.omitted ? (
                    <span className="dv-wa-omitted">{PaperclipGlyph}{OMITTED_LABEL[m.omitted] || 'Attachment'} — not included in this export</span>
                  ) : (
                    <span className="dv-wa-text">{renderMessageText(m.text, q)}</span>
                  )}
                  {clock && !isContact && !isDoc && <span className="dv-wa-time">{clock}</span>}
                </div>
              </div>
            </React.Fragment>
          );
        })}
        <div ref={endRef} aria-hidden="true" />
      </div>
      {meSender && (() => {
        const controlsNode = (
        <div className="dv-wa-controls">
          <div className="dv-wa-header-controls">
            {/* Search pill — reuses the Files tab's .fx-search styling (its CSS
                is loaded here via the embedded Files browser) so it's identical.
                Enter / Shift+Enter walk the matches; count chip + Ctrl/⌘+F hint. */}
            <div className={`fx-search${(rawQuery || '').trim() ? ' is-active' : ''}`}>
              <span className="fx-search-glyph">{SearchGlyph}</span>
              <input
                ref={findInputRef}
                type="text"
                value={rawQuery || ''}
                onChange={(e) => onQueryChange?.(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && (rawQuery || '')) { e.stopPropagation(); onQueryChange?.(''); return; }
                  if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) goMatch(-1); else goMatch(1); }
                }}
                placeholder="Search this chat"
                aria-label="Search messages in this chat"
              />
              {q ? (
                <span className={`dv-wa-find-count${visibleRows.length === 0 ? ' is-empty' : ''}`} aria-live="polite">
                  {visibleRows.length ? `${(nav ? nav.pos : 0) + 1}/${visibleRows.length}` : 'No results'}
                </span>
              ) : null}
              {(rawQuery || '') ? (
                <button type="button" className="fx-search-clear" onClick={() => { onQueryChange?.(''); findInputRef.current?.focus(); }} aria-label="Clear search">
                  {ClearGlyph}
                </button>
              ) : (
                <span className="fx-search-kbd" aria-hidden="true">
                  <kbd>{/mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd>
                  <span className="fx-search-kbd-plus">+</span>
                  <kbd>F</kbd>
                </span>
              )}
            </div>
            {/* Date-range controls — show only messages between From and To
                (either bound optional). The same range filters the rail's
                Media / Links / Docs / … sections (state lives in DocTextPane). */}
            <div className={`dv-wa-dates${rangeActive ? ' is-active' : ''}`}>
              <span className="dv-wa-dates-label">From</span>
              <input
                type="date"
                className="dv-wa-date"
                value={dateFrom || ''}
                min={dateMin || undefined}
                max={dateTo || dateMax || undefined}
                onChange={(e) => onDateFromChange?.(e.target.value)}
                aria-label="Show content from this date"
              />
              <span className="dv-wa-dates-label">to</span>
              <input
                type="date"
                className="dv-wa-date"
                value={dateTo || ''}
                min={dateFrom || dateMin || undefined}
                max={dateMax || undefined}
                onChange={(e) => onDateToChange?.(e.target.value)}
                aria-label="Show content up to this date"
              />
              {rangeActive && (
                <button
                  type="button"
                  className="dv-wa-find-clear"
                  onClick={() => onResetDates?.()}
                  aria-label="Reset to the full date range"
                >
                  {ClearGlyph}
                </button>
              )}
            </div>
          </div>
          {/* Burger — shows/hides the Media, links & docs rail. Hidden in the
              Docvex skin, where the rail is pinned open beside the chat. */}
          {!docvex && (
            <Tooltip content={railOpen ? 'Hide media, links & docs' : 'Show media, links & docs'}>
              <button
                type="button"
                className={`dv-wa-burger${railOpen ? ' is-active' : ''}`}
                onClick={() => onToggleRail?.()}
                aria-pressed={Boolean(railOpen)}
                aria-label="Toggle media, links and docs panel"
              >
                {BurgerGlyph}
              </button>
            </Tooltip>
          )}
        </div>
        );
        // Footer now carries the conversation tallies (messages · media · …)
        // instead of the controls, which moved up to the header slot.
        const footerNode = (
        <footer className="dv-wa-footer">
          <div className="dv-wa-stats">
            {stats.length ? stats.map((s, i) => (
              <React.Fragment key={s.many}>
                {i > 0 && <span className="dv-wa-stat-dot" aria-hidden="true">·</span>}
                <span className="dv-wa-stat">
                  <strong>{s.n.toLocaleString()}</strong> {s.n === 1 ? s.one : s.many}
                </span>
              </React.Fragment>
            )) : <span className="dv-wa-stat dv-wa-stat-empty">No messages</span>}
          </div>
        </footer>
        );
        // Controls portal up above the tab bars; the stats footer spans the
        // full pane width (chat + media rail) via the slot below the split.
        return (
          <>
            {headerSlot ? createPortal(controlsNode, headerSlot) : controlsNode}
            {footerSlot ? createPortal(footerNode, footerSlot) : footerNode}
          </>
        );
      })()}
    </div>
  );
});

// ── Media / links / docs / contacts rail ───────────────────────────────
// WhatsApp's "Media, links, and docs" panel: a right rail beside the chat that
// aggregates every shared photo/video, link, document and contact across the
// whole transcript.
const PlayGlyph = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.78-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" />
  </svg>
);
const PhoneGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);
const VideoGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
  </svg>
);
const PauseGlyph = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />
  </svg>
);
const MusicNoteGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
  </svg>
);
const VolumeHighGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);
const VolumeMuteGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
  </svg>
);
const CaptionsGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="5" width="20" height="14" rx="2" /><path d="M7 12.5a1.5 1.5 0 0 1-1.5 1.5h-.5a1.5 1.5 0 0 1-1.5-1.5v-1a1.5 1.5 0 0 1 1.5-1.5h.5A1.5 1.5 0 0 1 7 11.5" /><path d="M15.5 12.5a1.5 1.5 0 0 1-1.5 1.5h-.5a1.5 1.5 0 0 1-1.5-1.5v-1a1.5 1.5 0 0 1 1.5-1.5h.5a1.5 1.5 0 0 1 1.5 1.5" />
  </svg>
);

// WhatsApp-style voice-note / audio player for an audio attachment (opus / ogg /
// mp3 / m4a / wav). A play-pause button, a scrubbable progress bar and the
// elapsed-or-total time. The hidden <audio> is the engine; seeking + duration
// rely on the localfile handler's Range support (added in main.js).
// ── Voice-note waveform (WhatsApp's volume bars) ────────────────────────
// The amplitude envelope is decoded from the real audio via Web Audio,
// LAZILY: only once a player has scrolled into view (an export can hold
// hundreds of notes — decoding them all up front would undo the rail's
// preload="none"). Results are cached by src for the window's lifetime.
// Until (or in case) the decode lands, a deterministic filename-seeded
// pattern keeps the layout identical so nothing jumps.
const WAVE_BARS = 36;
const waveCache = new Map();
const waveInflight = new Map();
let waveCtx = null;

function seededWave(seedStr, bars = WAVE_BARS) {
  let h = 5381;
  const s = String(seedStr || '');
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  const out = [];
  for (let i = 0; i < bars; i += 1) {
    h = (h * 1103515245 + 12345) | 0;
    out.push(0.22 + ((Math.abs(h) % 1000) / 1000) * 0.55);
  }
  return out;
}

async function computeWaveform(src, bars = WAVE_BARS) {
  const key = `${src}:${bars}`;
  if (waveCache.has(key)) return waveCache.get(key);
  if (waveInflight.has(key)) return waveInflight.get(key);
  const p = (async () => {
    try {
      const res = await fetch(src);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      // Low sample rate: we only need a coarse envelope, and it cuts the
      // decode cost of long notes substantially. decodeAudioData works on a
      // suspended context, so no user-gesture requirement applies.
      if (!waveCtx) waveCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const audio = await waveCtx.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      const bucket = Math.max(1, Math.floor(ch.length / bars));
      const peaks = new Array(bars).fill(0);
      for (let b = 0; b < bars; b += 1) {
        const start = b * bucket;
        const end = Math.min(ch.length, start + bucket);
        const step = Math.max(1, Math.floor((end - start) / 64)); // sparse RMS sample
        let sum = 0; let n = 0;
        for (let i = start; i < end; i += step) { sum += ch[i] * ch[i]; n += 1; }
        peaks[b] = Math.sqrt(sum / Math.max(1, n));
      }
      const max = Math.max(...peaks, 0.0001);
      const wave = peaks.map((v) => Math.max(0.12, Math.min(1, v / max)));
      waveCache.set(key, wave);
      return wave;
    } catch {
      return null;
    } finally {
      waveInflight.delete(key);
    }
  })();
  waveInflight.set(key, p);
  return p;
}

// `preload` defaults to metadata (duration shows up front). The rail's Voice
// tab passes "none" — it mounts EVERY note at once, and a metadata request
// per <audio> would hammer the localfile handler on a big export; durations
// there resolve on first play instead.
function VoiceNote({ src, onError, preload = 'metadata' }) {
  const audioRef = useRef(null);
  const rootRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);

  // Real amplitude bars, decoded once the player scrolls into view.
  const [wave, setWave] = useState(() => waveCache.get(`${src}:${WAVE_BARS}`) || null);
  useEffect(() => {
    if (!src || wave) return undefined;
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((en) => en.isIntersecting)) return;
      io.disconnect();
      computeWaveform(src).then((w) => { if (!cancelled && w) setWave(w); });
    }, { rootMargin: '120px' });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [src, wave]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {}); else a.pause();
  };
  const seek = (e) => {
    const a = audioRef.current;
    if (!a || !dur || !Number.isFinite(dur)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    a.currentTime = ratio * dur;
    setCur(a.currentTime);
  };
  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${mm}:${String(ss).padStart(2, '0')}`;
  };
  const pct = dur && Number.isFinite(dur) ? Math.min(100, (cur / dur) * 100) : 0;
  const bars = wave || seededWave(src);
  const playedBars = Math.round((pct / 100) * bars.length);

  return (
    <div className="dv-wa-voice" ref={rootRef}>
      <audio
        ref={audioRef}
        src={src}
        preload={preload}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCur(0); }}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onDurationChange={(e) => setDur(e.currentTarget.duration)}
        onError={onError}
      />
      <button type="button" className="dv-wa-voice-btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? PauseGlyph : PlayGlyph}
      </button>
      <div className={`dv-wa-voice-wave${wave ? '' : ' is-estimate'}`} onClick={seek}>
        {bars.map((v, i) => (
          <span
            key={i}
            className={`dv-wa-voice-tick${i < playedBars ? ' is-played' : ''}`}
            style={{ height: `${Math.round(v * 100)}%` }}
          />
        ))}
        <span className="dv-wa-voice-knob" style={{ left: `${pct}%` }} />
      </div>
      <span className="dv-wa-voice-time">{(playing || cur > 0) ? fmt(cur) : fmt(dur)}</span>
    </div>
  );
}

// Feather-style stroke icons for the rail's section tabs.
const RAIL_ICONS = {
  media: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" />
    </svg>
  ),
  stickers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7z" /><path d="M14 21v-5a2 2 0 0 1 2-2h5" /><path d="M8.5 13.5s1 1.5 3.5 1.5" /><circle cx="9" cy="9.5" r="0.6" fill="currentColor" /><circle cx="14" cy="9.5" r="0.6" fill="currentColor" />
    </svg>
  ),
  voice: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  ),
  links: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  docs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  contacts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  ),
  calls: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  ),
};

const SearchGlyph = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
const ClearGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const BurgerGlyph = (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" />
  </svg>
);

// Hover / right-click chrome for one rail entry — the same morph pill the
// file grids use: hovering shows the cursor-following name pill, and a
// right-click FLIP-morphs that pill into the Open / Find-in-chat menu
// (replaces the old detached dropdown, which just popped in from nowhere).
// Render-prop because rail entries are different elements (buttons, anchors,
// list rows, card wrappers): spread the provided props on the interactive
// element; the portal node renders as its sibling.
function RailItemMorph({ label, items, render }) {
  const morph = useMorphPill({ hoverContent: label, menuItems: items });
  return (
    <>
      {render({
        onMouseMove: morph.handleMouseMove,
        onMouseLeave: morph.handleMouseLeave,
        onContextMenu: (e) => { e.stopPropagation(); morph.handleContextMenu(e); },
      })}
      {morph.node}
    </>
  );
}

// http(s)/www links, trimming trailing punctuation that usually isn't part of
// the URL. (RegExp literal is module-level so it isn't recompiled per render.)
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,!?;:'"]/gi;
function collectLinks(text, into, seen, msgIndex) {
  const matches = String(text || '').match(URL_RE);
  if (!matches) return;
  for (const raw of matches) {
    const url = /^www\./i.test(raw) ? `https://${raw}` : raw;
    if (seen.has(url)) continue;
    seen.add(url);
    into.push({ url, label: raw, msgIndex });
  }
}

// E-mail addresses mentioned in a message — surfaced in the Contacts rail
// alongside shared .vcf cards so the address book also covers people written
// out in plain text.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function collectEmails(text, contacts, seen, msgIndex) {
  const matches = String(text || '').match(EMAIL_RE);
  if (!matches) return;
  for (const raw of matches) {
    const email = raw.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    contacts.push({ kind: 'email', email, msgIndex });
  }
}

// IBANs (e.g. the Romanian "RO61BTRLRONCRT0PA2570501") — country code + 2 check
// digits + up to 30 alphanumerics. Surfaced in the Links rail and highlighted
// inline; clicking copies the number (there's nothing to navigate to).
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{12,30}\b/g;
const IBAN_FULL_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{12,30}$/;
function copyText(text) {
  try { navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
}
function collectIbans(text, into, seen, msgIndex) {
  const matches = String(text || '').match(IBAN_RE);
  if (!matches) return;
  for (const raw of matches) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    into.push({ kind: 'iban', value: raw, label: raw, msgIndex });
  }
}

// WhatsApp call entries (missed / answered voice or video calls) export as a
// line whose whole body is the call phrase, e.g. "Missed voice call",
// "Silenced missed video call", "Voice call", and the newer
// "Missed voice call. Tap to call back". Detect them so the chat can style them
// and the Calls rail can list every one. Returns { type, missed, callback,
// label } or null.
// The tail after "call" is optional: ". Tap to call back" (missed) or a
// duration like ". 29 sec." / ". 5 min" / ". 1 hr 3 min" (answered).
const CALL_RE = /^(silenced\s+)?(missed\s+)?(voice|video)\s+call\b\s*\.?\s*(tap to call back\.?|(?:\d+\s*(?:hr|hrs|hours?|min|mins|minutes?|sec|secs|seconds?)\b\.?\s*)+)?$/i;
function detectCall(text) {
  const t = String(text || '').trim();
  const m = CALL_RE.exec(t);
  if (!m) return null;
  const type = m[3].toLowerCase();
  const missed = Boolean(m[2]);
  const silenced = Boolean(m[1]);
  const tail = (m[4] || '').trim();
  const callback = /tap to call back/i.test(tail);
  const duration = callback ? '' : tail.replace(/\.+$/, '').trim();
  let label = `${type === 'video' ? 'Video' : 'Voice'} call`;
  if (missed) label = `Missed ${label.toLowerCase()}`;
  if (silenced) label = `Silenced ${label.toLowerCase()}`;
  return { type, missed, callback, duration: duration || null, label };
}

// Walk the parsed messages once and bucket everything the rail surfaces. Each
// item carries the index of its source message so "Find in chat" can scroll to it.
function buildRailContent(messages) {
  const media = []; const docs = []; const contacts = []; const links = []; const calls = [];
  const stickers = []; const voice = [];
  const seenLinks = new Set(); const seenEmails = new Set(); const seenIbans = new Set();
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m.attachment) {
      const call = detectCall(m.text);
      if (call) calls.push({ ...call, time: m.time, sender: m.sender || null, msgIndex: i });
    }
    if (m.system) continue;
    if (m.attachment) {
      const name = m.attachment.name;
      const e = extOf(name);
      if (e === 'vcf') contacts.push({ kind: 'vcf', name, msgIndex: i });
      else if (isSticker(name)) stickers.push({ name, msgIndex: i });
      else {
        const k = mediaKindOf(name);
        if (k === 'image' || k === 'video') media.push({ name, kind: k, msgIndex: i });
        else if (k === 'audio') voice.push({ name, msgIndex: i });
        else docs.push({ name, kind: k, msgIndex: i });
      }
      if (m.attachment.caption) {
        collectLinks(m.attachment.caption, links, seenLinks, i);
        collectEmails(m.attachment.caption, contacts, seenEmails, i);
        collectIbans(m.attachment.caption, links, seenIbans, i);
      }
    } else if (m.text) {
      collectLinks(m.text, links, seenLinks, i);
      collectEmails(m.text, contacts, seenEmails, i);
      collectIbans(m.text, links, seenIbans, i);
    }
  }
  return { media, stickers, voice, docs, contacts, links, calls };
}

function WhatsAppRail({ messages, dir, sep, onFindInChat, width, rangeActive, timeInRange }) {
  const railAll = useMemo(() => buildRailContent(messages), [messages]);
  // The chat's date-range filter propagates here: every entry is tied to its
  // source message (msgIndex), so each section — and its tab count — narrows
  // to the same From → To window the conversation shows. Entries that can't
  // be dated (no msgIndex) stay visible rather than silently vanishing.
  const { media, stickers, voice, docs, contacts, links, calls } = useMemo(() => {
    if (!rangeActive) return railAll;
    const keep = (it) => it.msgIndex == null || timeInRange(messages[it.msgIndex]?.time);
    return {
      media: railAll.media.filter(keep),
      stickers: railAll.stickers.filter(keep),
      voice: railAll.voice.filter(keep),
      docs: railAll.docs.filter(keep),
      contacts: railAll.contacts.filter(keep),
      links: railAll.links.filter(keep),
      calls: railAll.calls.filter(keep),
    };
  }, [railAll, rangeActive, timeInRange, messages]);
  const tabs = [
    { id: 'media', label: 'Media', count: media.length, icon: RAIL_ICONS.media },
    { id: 'stickers', label: 'Stickers', count: stickers.length, icon: RAIL_ICONS.stickers },
    { id: 'voice', label: 'Voice notes', count: voice.length, icon: RAIL_ICONS.voice },
    { id: 'links', label: 'Links', count: links.length, icon: RAIL_ICONS.links },
    { id: 'docs', label: 'Docs', count: docs.length, icon: RAIL_ICONS.docs },
    { id: 'contacts', label: 'Contacts', count: contacts.length, icon: RAIL_ICONS.contacts },
    { id: 'calls', label: 'Calls', count: calls.length, icon: RAIL_ICONS.calls },
  ];
  const [tab, setTab] = useState(() => tabs.find((t) => t.count > 0)?.id || 'media');

  const urlFor = (name) => (dir ? localUrlFor(`${dir}${sep}${name}`) : null);
  // Grid tiles are ~108px — a 256px thumb covers 2x density. Stickers ask
  // too, but webp ignores the param (keeps animation/alpha) — harmless.
  const thumbFor = (name) => (dir ? localUrlFor(`${dir}${sep}${name}`, 256) : null);
  const pathFor = (name) => (dir ? `${dir}${sep}${name}` : name);
  const openOnDisk = (name) => { if (dir) localFolderApi.openPath(pathFor(name)); };

  // Right-click morph-menu entries shared by every section: an open action
  // (label varies — Copy for IBANs) + "Find in chat".
  const railMenuItems = ({ onOpen, openDisabled, msgIndex, openLabel = 'Open' }) => [
    { key: 'open', label: openLabel, onClick: onOpen, disabled: Boolean(openDisabled) },
    { key: 'find', label: 'Find in chat', onClick: () => onFindInChat?.(msgIndex), disabled: msgIndex == null },
  ];

  return (
    <aside className="dv-wa-rail" style={width ? { width: `${width}px`, flex: 'none' } : undefined}>
      {/* No section title — the tabs sit flush at the top, in line with the
          AI-advisor tab strip on other file types. */}
      <div className="dv-wa-rail-tabs" role="tablist">
        {tabs.map((t) => (
          <Tooltip key={t.id} content={t.label}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`dv-wa-rail-tab${tab === t.id ? ' is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.icon}
              <span className="dv-wa-rail-tab-label">{t.label}</span>
              {t.count > 0 && <span className="dv-wa-rail-count">{t.count}</span>}
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="dv-wa-rail-body">
        {tab === 'media' && (media.length ? (
          <div className="dv-wa-rail-grid">
            {media.map((it, i) => (
              <RailItemMorph
                key={i}
                label={it.name}
                items={railMenuItems({ onOpen: () => openOnDisk(it.name), openDisabled: !dir, msgIndex: it.msgIndex })}
                render={(morphProps) => (
                  <button
                    type="button"
                    className="dv-wa-rail-tile"
                    onClick={() => openOnDisk(it.name)}
                    {...morphProps}
                  >
                    {it.kind === 'image' ? (
                      <img src={thumbFor(it.name)} alt={it.name} loading="lazy" decoding="async" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                    ) : (
                      // Video: OS-generated poster frame with a play badge on
                      // top. The gradient glyph sits behind as the fallback —
                      // when no poster can be generated the handler streams
                      // video bytes, the <img> errors out and hides itself,
                      // and the gradient shows through.
                      <>
                        <span className="dv-wa-rail-vid">{PlayGlyph}</span>
                        <img className="dv-wa-rail-vidposter" src={thumbFor(it.name)} alt={it.name} loading="lazy" decoding="async" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                        <span className="dv-wa-rail-vidplay" aria-hidden="true">{PlayGlyph}</span>
                      </>
                    )}
                  </button>
                )}
              />
            ))}
          </div>
        ) : <div className="dv-wa-rail-empty">No photos or videos</div>)}

        {tab === 'stickers' && (stickers.length ? (
          <div className="dv-wa-rail-stickers">
            {stickers.map((it, i) => (
              <RailItemMorph
                key={i}
                label={it.name}
                items={railMenuItems({ onOpen: () => openOnDisk(it.name), openDisabled: !dir, msgIndex: it.msgIndex })}
                render={(morphProps) => (
                  <button
                    type="button"
                    className="dv-wa-rail-sticker"
                    onClick={() => openOnDisk(it.name)}
                    {...morphProps}
                  >
                    <img src={thumbFor(it.name)} alt={it.name} loading="lazy" decoding="async" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                  </button>
                )}
              />
            ))}
          </div>
        ) : <div className="dv-wa-rail-empty">No stickers</div>)}

        {tab === 'voice' && (voice.length ? (
          <ul className="dv-wa-rail-list">
            {voice.map((v, i) => (
              <RailItemMorph
                key={i}
                label={v.name}
                items={railMenuItems({ onOpen: () => onFindInChat?.(v.msgIndex), openDisabled: v.msgIndex == null, msgIndex: v.msgIndex })}
                render={(morphProps) => (
                  <li className="dv-wa-rail-voice" {...morphProps}>
                    {dir && <VoiceNote src={urlFor(v.name)} preload="none" />}
                    <span className="dv-wa-rail-voice-name">{v.name}</span>
                  </li>
                )}
              />
            ))}
          </ul>
        ) : <div className="dv-wa-rail-empty">No voice notes</div>)}

        {tab === 'links' && (links.length ? (
          <div className="dv-wa-rail-groups">
            {[
              { key: 'web', title: 'Links', items: links.filter((l) => l.kind !== 'iban') },
              { key: 'iban', title: 'IBANs', items: links.filter((l) => l.kind === 'iban') },
            ].filter((g) => g.items.length).map((g) => (
              <div key={g.key}>
                <div className="dv-wa-rail-divider">{g.title}</div>
                <ul className="dv-wa-rail-list">
                  {g.items.map((l, i) => (
                    <li key={i}>
                      {l.kind === 'iban' ? (
                        <RailItemMorph
                          label="Copy IBAN"
                          items={railMenuItems({ onOpen: () => copyText(l.value), msgIndex: l.msgIndex, openLabel: 'Copy IBAN' })}
                          render={(morphProps) => (
                            <button
                              type="button"
                              className="dv-wa-rail-link dv-wa-rail-iban"
                              onClick={() => copyText(l.value)}
                              {...morphProps}
                            >
                              {l.label}
                            </button>
                          )}
                        />
                      ) : (
                        <RailItemMorph
                          label={l.url}
                          items={railMenuItems({ onOpen: () => openExternal(l.url), msgIndex: l.msgIndex })}
                          render={(morphProps) => (
                            <a
                              className="dv-wa-rail-link"
                              href={l.url}
                              onClick={(e) => { e.preventDefault(); openExternal(l.url); }}
                              {...morphProps}
                            >
                              {l.label}
                            </a>
                          )}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : <div className="dv-wa-rail-empty">No links</div>)}

        {tab === 'docs' && (docs.length ? (
          <div className="dv-wa-rail-docs">
            {docs.map((d, i) => (
              <RailItemMorph
                key={i}
                label={d.name}
                items={railMenuItems({ onOpen: () => openOnDisk(d.name), openDisabled: !dir, msgIndex: d.msgIndex })}
                render={(morphProps) => (
                  <button
                    type="button"
                    className="dv-wa-rail-doc"
                    onClick={() => openOnDisk(d.name)}
                    disabled={!dir}
                    {...morphProps}
                  >
                    <span className="dv-wa-rail-doc-icon">{docIconFor(d.name)}</span>
                    <span className="dv-wa-rail-doc-name">{d.name}</span>
                  </button>
                )}
              />
            ))}
          </div>
        ) : <div className="dv-wa-rail-empty">No documents</div>)}

        {tab === 'contacts' && (contacts.length ? (
          <div className="dv-wa-rail-contacts">
            {contacts.map((c, i) => (c.kind === 'email' ? (
              <RailItemMorph
                key={i}
                label={c.email}
                items={railMenuItems({ onOpen: () => openExternal(`mailto:${c.email}`), msgIndex: c.msgIndex })}
                render={(morphProps) => (
                  <div {...morphProps}>
                    <EmailContactCard email={c.email} />
                  </div>
                )}
              />
            ) : (
              <RailItemMorph
                key={i}
                label={c.name}
                items={railMenuItems({ onOpen: () => openOnDisk(c.name), openDisabled: !dir, msgIndex: c.msgIndex })}
                render={(morphProps) => (
                  <div {...morphProps}>
                    <ContactCard name={c.name} fullPath={dir ? pathFor(c.name) : null} url={urlFor(c.name)} />
                  </div>
                )}
              />
            )))}
          </div>
        ) : <div className="dv-wa-rail-empty">No contacts</div>)}

        {tab === 'calls' && (calls.length ? (
          <ul className="dv-wa-rail-list">
            {calls.map((c, i) => (
              <li key={i}>
                <RailItemMorph
                  label={c.label}
                  items={railMenuItems({ onOpen: () => onFindInChat?.(c.msgIndex), openDisabled: c.msgIndex == null, msgIndex: c.msgIndex })}
                  render={(morphProps) => (
                <button
                  type="button"
                  className="dv-wa-rail-call"
                  onClick={() => onFindInChat?.(c.msgIndex)}
                  {...morphProps}
                >
                  <span className={`dv-wa-call-icon${c.missed ? ' is-missed' : c.duration ? ' is-answered' : ''}`}>
                    {c.type === 'video' ? VideoGlyph : PhoneGlyph}
                  </span>
                  <span className="dv-wa-call-meta">
                    <span className="dv-wa-call-label">{c.label}</span>
                    {(c.sender || c.duration || c.time) && (
                      <span className="dv-wa-call-sub">{[c.sender, c.duration, c.time].filter(Boolean).join(' · ')}</span>
                    )}
                  </span>
                </button>
                  )}
                />
              </li>
            ))}
          </ul>
        ) : <div className="dv-wa-rail-empty">No calls</div>)}
      </div>
    </aside>
  );
}

// ── Text pane (plain / markdown / WhatsApp) ────────────────────────────
// Fetches the file body and renders it. A `.txt` that parses as a WhatsApp
// export gets a top-left toggle between the styled conversation and raw text;
// markdown renders through ReactMarkdown; everything else is a <pre>.
// Read cap for text files. Generous because WhatsApp exports of long group
// chats run tens of MB — the conversation view stays fast on those (windowed
// rows + content-visibility), so truncating at a few MB would silently drop
// most of the history. The PLAIN <pre> / markdown view keeps a smaller cap:
// one multi-MB text node is where Chromium's line layout actually chokes.
const TEXT_MAX_BYTES = 32 * 1024 * 1024;
const PRE_MAX_CHARS = 4 * 1024 * 1024;

function DocTextPane({ file, url, dir, sep, onWhatsAppDetected }) {
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);
  // Default to the Docvex skin for recognised WhatsApp convos (the user can
  // switch to the Plain-text view). Only matters once the content parses as a
  // chat — plain text always renders below.
  const [mode, setMode] = useState('docvex'); // 'docvex' | 'plain'
  const [query, setQuery] = useState('');
  // "Find in chat" target — { index, n }. The bumped `n` makes the chat's
  // scroll effect re-fire even when the same message is requested twice.
  const [findReq, setFindReq] = useState(null);
  const findInChat = useCallback((index) => {
    if (index == null) return;
    setFindReq((prev) => ({ index, n: (prev?.n || 0) + 1 }));
  }, []);

  // Drag-to-resize the media/links/docs rail. The handle sits on the rail's
  // RIGHT edge (the split's last child), so dragging right grows the rail
  // OUTWARD: the split widens into the pane's free space (it defaults to
  // half the pane) and the conversation column keeps its width. Once the
  // split hits the pane edge, further growth comes out of the conversation.
  // Both widths stay null until the first drag (CSS defaults apply).
  // Column widths (layout px). The conversation is FIXED at a readable
  // 640px (not resizable); only the rail is user-draggable. Its minimum is
  // derived from the Media grid so dragging can never drop below 4 tiles
  // per row: 4 tiles × 108px + 3 × 4px gaps + 2 × 12px body padding + 2px
  // of borders + 10px for the body's scrollbar and subpixel rounding under
  // the app zoom (an exact-to-the-pixel fit lets the scrollbar steal a
  // column).
  const CHAT_BASE = 640;
  const RAIL_MIN = 4 * 108 + 3 * 4 + 2 * 12 + 2 + 10;
  const RAIL_BASE = RAIL_MIN;
  const [railWidth, setRailWidth] = useState(null);
  // Docvex skin only: the conversation column is a fixed, draggable width (the
  // media rail fills the rest). Persisted across files so the chat ↔ media split
  // is remembered the next time a conversation is opened. null → 50/50 default.
  const CHAT_COL_MIN = 360;
  const [chatW, setChatW] = useState(() => {
    const w = readDvLayout().chatW;
    return typeof w === 'number' ? w : null;
  });
  // Burger toggle (chat header, right edge). CLOSED by default — opening
  // adds the rail as its own section BESIDE the conversation (the split
  // widens by the rail's width, the conversation keeps its size).
  const [railOpen, setRailOpen] = useState(false);
  const toggleRail = useCallback(() => setRailOpen((v) => !v), []);
  const splitRef = useRef(null);
  // The chat column's inner scroller — wrapped so a custom overlay scrollbar can
  // sit OUTSIDE it (the native bar is hidden), keeping the sticky tab strip and
  // footer full-width instead of being narrowed by the gutter.
  const chatScrollRef = useRef(null);
  // Slot below the chat+media split that the conversation footer (search + date
  // range + view toggle) portals into, so it spans the FULL width — across the
  // media / stickers rail too, not just the chat column.
  const [footerSlot, setFooterSlot] = useState(null);
  // Slot ABOVE the tab bars that the search + date-range controls portal into,
  // so they sit at the very top of the conversation section (the footer below
  // now carries the conversation stats instead).
  const [headerSlot, setHeaderSlot] = useState(null);
  // Both drags write widths STRAIGHT to the DOM (rAF-coalesced) and commit
  // React state once on mouseup. Routing every mousemove through setState
  // re-rendered the whole split — hundreds of chat rows plus every rail
  // entry (the Voice tab alone re-reconciled ~15k waveform ticks) — which
  // is what dropped the frame rate while resizing.
  // Shared scaffolding: cursor/selection lock + rAF coalescing + the
  // one-commit mouseup.
  const dragHorizontal = (e, onDx, onDone) => {
    e.preventDefault();
    const startX = e.clientX;
    let frame = null;
    let pendingDx = 0;
    const onMove = (ev) => {
      pendingDx = toLayoutPx(ev.clientX - startX);
      if (frame == null) {
        frame = requestAnimationFrame(() => { frame = null; onDx(pendingDx); });
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (frame != null) cancelAnimationFrame(frame);
      onDx(pendingDx); // land on the final cursor position
      onDone();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Handle on the rail's RIGHT edge — resizes the rail outward; the
  // conversation keeps its (fixed) width. Floored at RAIL_MIN so the media
  // tiles never shrink — narrower just means fewer per row, down to 3.
  const startRailResize = (e) => {
    const split = splitRef.current;
    const railEl = split?.querySelector('.dv-wa-rail');
    if (!split || !railEl) return;
    const startRail = railWidth ?? RAIL_BASE;
    const paneW = split.parentElement ? toLayoutPx(split.parentElement.getBoundingClientRect().width) : Infinity;
    let lastRail = startRail;
    dragHorizontal(e, (dx) => {
      lastRail = Math.max(RAIL_MIN, Math.min(Math.max(RAIL_MIN, paneW - CHAT_BASE), startRail + dx));
      railEl.style.width = `${lastRail}px`;
      railEl.style.flex = 'none';
      split.style.width = `${CHAT_BASE + lastRail}px`;
    }, () => setRailWidth(lastRail));
  };

  // Docvex skin: handle between the conversation and the media rail. Resizes the
  // chat column (fixed width); the rail flexes to fill the rest. Persisted.
  const startChatColResize = (e) => {
    const split = splitRef.current;
    const chatEl = split?.querySelector('.dv-wa-chatcol');
    if (!split || !chatEl) return;
    const startW = toLayoutPx(chatEl.getBoundingClientRect().width);
    const paneW = toLayoutPx(split.getBoundingClientRect().width);
    let last = startW;
    dragHorizontal(e, (dx) => {
      const maxChat = Math.max(CHAT_COL_MIN, paneW - RAIL_MIN - 6);
      last = Math.max(CHAT_COL_MIN, Math.min(maxChat, startW + dx));
      chatEl.style.flex = 'none';
      chatEl.style.width = `${last}px`;
    }, () => { setChatW(last); writeDvLayout({ chatW: last }); });
  };

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = (await res.text()).slice(0, TEXT_MAX_BYTES);
        if (!cancelled) setContent(text);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load text');
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  const isMarkdown = file.mime_type === 'text/markdown' || /\.md$/i.test(file.name);
  const chat = useMemo(
    () => (content != null && !isMarkdown ? parseWhatsAppChat(content) : { messages: [], isWhatsApp: false }),
    [content, isMarkdown],
  );

  // Tell the shell this tab is a WhatsApp conversation (content-parsed, not
  // name-based) so its sidebar tile shows the WhatsApp mark.
  useEffect(() => {
    if (chat.isWhatsApp) onWhatsAppDetected?.();
  }, [chat.isWhatsApp, onWhatsAppDetected]);

  // Date-range filter (the From/To controls under the chat's search bar).
  // Owned here — not by the chat — because the rail filters by the same
  // range: every Media/Links/Docs/… entry hides with its message.
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const dayResolver = useMemo(() => buildDayResolver(chat.messages), [chat.messages]);
  // The conversation's own date span (first → last parseable message). The
  // From/To inputs default to these so the user sees the real range and narrows
  // inward, rather than starting from blank fields.
  const dateBounds = useMemo(() => {
    let min = null; let max = null;
    for (const m of chat.messages) {
      const k = dayResolver(m.time);
      if (k == null) continue;
      if (min == null || k < min) min = k;
      if (max == null || k > max) max = k;
    }
    return { minKey: min, maxKey: max, from: keyToDateInput(min), to: keyToDateInput(max) };
  }, [chat.messages, dayResolver]);
  // Seed (and re-seed on a new conversation) the inputs to the full span.
  useEffect(() => {
    setDateFrom(dateBounds.from);
    setDateTo(dateBounds.to);
  }, [dateBounds.from, dateBounds.to]);
  const fromKey = dateInputKey(dateFrom);
  const toKey = dateInputKey(dateTo);
  // "Active" only once the user narrows INSIDE the conversation's own span —
  // the default (full span) shows everything, exactly as an empty filter did,
  // so unparseable-timestamp lines aren't hidden just because defaults are set.
  const rangeActive = (fromKey != null && (dateBounds.minKey == null || fromKey > dateBounds.minKey))
    || (toKey != null && (dateBounds.maxKey == null || toKey < dateBounds.maxKey));
  const timeInRange = useCallback((time) => {
    if (!rangeActive) return true;
    const k = dayResolver(time);
    if (k == null) return false; // unparseable timestamp — hide while filtering
    if (fromKey != null && k < fromKey) return false;
    if (toKey != null && k > toKey) return false;
    return true;
  }, [dayResolver, fromKey, toKey, rangeActive]);
  // Clear/reset returns the inputs to the full conversation span (not blank).
  const resetDates = useCallback(() => {
    setDateFrom(dateBounds.from);
    setDateTo(dateBounds.to);
  }, [dateBounds.from, dateBounds.to]);

  // The search input (in the chat's POV header) stays controlled by `query`,
  // but everything expensive (filtering + re-rendering thousands of rows)
  // keys off the deferred copy, so typing stays responsive on huge
  // conversations — React catches the list up between keystrokes.
  const deferredQuery = useDeferredValue(query);

  if (error) return <div className="dv-noview"><p className="dv-noview-title">Couldn't read the file</p><p className="dv-noview-sub">{error}</p></div>;
  if (content == null) return <div className="dv-loading">Loading text…</div>;

  const showChat = chat.isWhatsApp && mode === 'docvex';
  // Docvex skin pins the media rail open beside the conversation and splits the
  // space up to the extraction panel 50/50 (no fixed width, no resize handle).
  const docvex = mode === 'docvex';
  const railShown = docvex || railOpen;

  // Display-mode toggle (WhatsApp / Docvex / Plain text). Lives in the chat's
  // footer next to the search + date controls (and in a footer of its own in
  // plain-text mode so you can always switch back).
  const modeToggle = chat.isWhatsApp ? (
    <div className="dv-text-toggle" role="group" aria-label="Display mode">
      <button
        type="button"
        className={`dv-text-toggle-btn${mode === 'docvex' ? ' is-active' : ''}`}
        onClick={() => setMode('docvex')}
        aria-pressed={mode === 'docvex'}
      >
        {DocvexGlyph}
        Docvex
      </button>
      <button
        type="button"
        className={`dv-text-toggle-btn${mode === 'plain' ? ' is-active' : ''}`}
        onClick={() => setMode('plain')}
        aria-pressed={mode === 'plain'}
      >
        Plain text
      </button>
    </div>
  ) : null;

  return (
    <div className="dv-text-pane">
      {showChat ? (
        <>
        {/* Full-width slot ABOVE the tab bars — the search + date controls
            portal in here so they top the whole conversation section. */}
        <div className="dv-wa-headerslot" ref={setHeaderSlot} />
        <div
          className={`dv-wa-split${docvex ? ' is-fluid' : ''}`}
          ref={splitRef}
          // WhatsApp skin: derived width — the conversation's width plus the
          // rail's when the burger opens it (the resize handles contribute no
          // layout width; max-width:100% caps it at the pane edge). Docvex skin
          // (is-fluid): no inline width — the split fills the pane up to the
          // extraction panel and chat + rail share it 50/50 via CSS.
          style={docvex ? undefined : { width: `${CHAT_BASE + (railOpen ? Math.round(railWidth ?? RAIL_BASE) : 0)}px` }}
        >
          <div
            className="dv-wa-chatcol"
            // Docvex: fixed, draggable width once the user has resized it (else
            // 50/50 via CSS). WhatsApp skin keeps its own fixed CHAT_BASE width.
            style={docvex && chatW != null ? { flex: 'none', width: `${chatW}px` } : undefined}
          >
            {/* View-mode tabs (Docvex / Plain text) — a tab strip at the top-left
                of the conversation section, styled like the media rail's tabbar
                and in line with it. Outside the scroller so the scrollbar gutter
                never narrows it. */}
            {modeToggle}
            {/* Scroller wrapped so the custom overlay scrollbar (below) sits in a
                right-edge gutter instead of taking layout width. */}
            <div className="dv-wa-chatscroll-wrap">
              <div className="dv-wa-chatscroll" ref={chatScrollRef}>
                <WhatsAppChat
                  variant={mode}
                  messages={chat.messages}
                  dir={dir}
                  sep={sep}
                  highlight={findReq}
                  query={deferredQuery}
                  rawQuery={query}
                  onQueryChange={setQuery}
                  dateFrom={dateFrom}
                  dateTo={dateTo}
                  dateMin={dateBounds.from}
                  dateMax={dateBounds.to}
                  onDateFromChange={setDateFrom}
                  onDateToChange={setDateTo}
                  onResetDates={resetDates}
                  rangeActive={rangeActive}
                  timeInRange={timeInRange}
                  railOpen={railOpen}
                  onToggleRail={toggleRail}
                  footerSlot={footerSlot}
                  headerSlot={headerSlot}
                />
              </div>
              <SidebarScrollbar scrollRef={chatScrollRef} refreshKey={chat.messages} />
            </div>
          </div>
          {/* Docvex: draggable divider between the conversation and the media rail. */}
          {docvex && railShown && (
            <div className="dv-wa-resizer" onMouseDown={startChatColResize} role="separator" aria-orientation="vertical" title="Drag to resize the conversation" />
          )}
          {railShown && (
            <>
              <WhatsAppRail messages={chat.messages} dir={dir} sep={sep} onFindInChat={findInChat} width={docvex ? null : (railWidth ?? RAIL_BASE)} rangeActive={rangeActive} timeInRange={timeInRange} />
              {!docvex && <div className="dv-wa-resizer" onMouseDown={startRailResize} role="separator" aria-orientation="vertical" title="Drag to resize the panel" />}
            </>
          )}
        </div>
        {/* Full-width footer slot — the conversation footer portals in here so
            it spans the chat + media rail. */}
        <div className="dv-wa-footerslot" ref={setFooterSlot} />
        </>
      ) : (
        <>
          {/* Same view-mode tab strip pinned at the top-left in plain-text mode,
              so you can always switch back to the Docvex view. */}
          {modeToggle}
          <div className="dv-text-scroll">
            {content.length > PRE_MAX_CHARS && (
              <div className="dv-text-truncated">
                Showing the first {Math.round(PRE_MAX_CHARS / (1024 * 1024))} MB — switch to the Docvex view for the full conversation.
              </div>
            )}
            {isMarkdown ? (
              <div className="dv-text-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content.slice(0, PRE_MAX_CHARS)}</ReactMarkdown></div>
            ) : (
              <pre className="dv-text-pre">{content.slice(0, PRE_MAX_CHARS)}</pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const WhatsAppGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
    <path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-2.9.8.8-2.8-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.6-6.1c-.3-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-2-1.2 7.4 7.4 0 0 1-1.4-1.7c-.1-.3 0-.4.1-.5l.4-.5.3-.4v-.4l-.8-1.9c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 2.9 2.9 0 0 0-.9 2.2 5 5 0 0 0 1.1 2.7 11.5 11.5 0 0 0 4.4 3.9c2.6 1 2.6.7 3.1.6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .1-1.2c-.1-.1-.3-.2-.5-.3z" />
  </svg>
);
// Speech-bubble mark for the Docvex (Team-chat-styled) view toggle.
const DocvexGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
  </svg>
);

// ── Photo / video pane with the text-extraction (OCR) tool ─────────────
const ScanTextGlyph = (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M7 9h10" />
    <path d="M7 13h7" />
    <path d="M7 17h4" />
  </svg>
);

// "Extract text" selection-tool icons for the tool-picker pill.
const HighlightToolGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="12" r="7" />
  </svg>
);
const CircleToolGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="8" />
  </svg>
);
const SquareToolGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </svg>
);
const LassoToolGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3c4.5 0 8 2.4 8 6.2 0 2.8-1.9 4.4-4.2 5.3-1 .4-1.3 1-1 1.9.3 1 .9 2.3-1 3-2.4.9-9.8-.8-9.8-6.4C4 7.8 7.5 3 12 3z" strokeDasharray="2.4 2.2" />
  </svg>
);
const ChevronGlyph = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6l4 4 4-4" />
  </svg>
);

// ── Custom video player glyphs ───────────────────────────────────
// PlayGlyph, PauseGlyph, VolumeHighGlyph, VolumeMuteGlyph are already
// declared above (shared with the WhatsApp media player).
const FullscreenGlyph = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </svg>
);

// Selection tools for "Extract text": Highlight (default) paints a brush
// stroke like a highlighter marker; Circle/Square drag a shape outward from
// the click point; Custom traces a freeform Photoshop-lasso outline. The
// shape tools share one size (OCR_CIRCLE_MIN..MAX), adjustable via scroll.
const OCR_TOOLS = [
  {
    id: 'highlight',
    label: 'Highlight',
    icon: HighlightToolGlyph,
    hint: 'Click and drag like a highlighter to paint over the text, then release to read it. Scroll to change the brush size.',
  },
  {
    id: 'square',
    label: 'Square',
    icon: SquareToolGlyph,
    hint: 'Click and drag from the top-left corner to define the selection area, then release to read it.',
  },
  {
    id: 'lasso',
    label: 'Custom',
    icon: LassoToolGlyph,
    hint: 'Click and drag to trace a freeform outline around the area, then release to read it.',
  },
];

// Downscale a cropped canvas to a small PNG for the history thumbnail — PNG
// (vs. JPEG) keeps the circular crop's transparent corners so the card's
// background shows through; keeps localStorage entries compact regardless
// of the OCR crop's resolution.
const HISTORY_THUMB_MAX_EDGE = 220;
function canvasToThumbDataUrl(source, maxEdge = HISTORY_THUMB_MAX_EDGE) {
  const { width, height } = source;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale === 1) return source.toDataURL('image/png');
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width * scale));
  c.height = Math.max(1, Math.round(height * scale));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function formatVideoTime(s) {
  if (!s || !isFinite(s)) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// "Jun 13" / "14:32" — split so the history timeline rail can stack them.
function formatHistoryTimestamp(ms) {
  const d = new Date(ms);
  return {
    date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

// Renders a photo or video full-pane with an "Extract text" tool. Arming it
// shows a tool-picker pill (Highlight / Circle / Square / Custom) at the top
// of the stage; the active tool's brush/shape follows the cursor and a
// click-drag paints or draws the selection — release to run OCR (lib/ocr) on
// it. Videos auto-pause when the tool is armed — extraction always reads the
// still frame on screen — and playing again disarms it.
//
// Coordinate spaces: all pointer positions live in viewport px relative to
// the stage (clientX / getBoundingClientRect agree there), converted to
// layout px only when rendered as SVG (the app's root zoom — see
// lib/appZoom). The crop maps each shape to natural-resolution pixels via the
// media element's box, so the zoom cancels out.
const OCR_CIRCLE_MIN = 16;
const OCR_CIRCLE_MAX = 300;
const OCR_CIRCLE_DEFAULT = 60;
const OCR_CIRCLE_STEP = 0.15; // viewport px of brush radius per wheel-delta unit

// Builds an SVG path string ("M x y L x y ... Z") from points in
// stage-viewport px, converting to layout px for rendering.
function pathD(points) {
  return `${points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toLayoutPx(p.x)} ${toLayoutPx(p.y)}`).join(' ')} Z`;
}

// Renders a selection shape's geometry as SVG element(s) in stage-viewport
// px (converted to layout px) — used for the outline preview (with a
// className), inside a <clipPath>, or inside a <mask> (with svgProps={fill:'black'}).
function shapeElements(shape, className, svgProps) {
  switch (shape.kind) {
    case 'circle':
      return <circle {...svgProps} className={className} cx={toLayoutPx(shape.cx)} cy={toLayoutPx(shape.cy)} r={toLayoutPx(shape.r)} />;
    case 'rect': {
      const x = toLayoutPx(Math.min(shape.x1, shape.x2));
      const y = toLayoutPx(Math.min(shape.y1, shape.y2));
      const w = toLayoutPx(Math.abs(shape.x2 - shape.x1));
      const h = toLayoutPx(Math.abs(shape.y2 - shape.y1));
      return <rect {...svgProps} className={className} x={x} y={y} width={w} height={h} />;
    }
    case 'union':
      return shape.points.map((p, i) => (
        <circle key={i} {...svgProps} className={className} cx={toLayoutPx(p.x)} cy={toLayoutPx(p.y)} r={toLayoutPx(shape.r)} />
      ));
    case 'path':
      return <path {...svgProps} className={className} d={pathD(shape.points)} />;
    default:
      return null;
  }
}

// Inverse of runOcr's `toNat`: maps a stored selection region (natural-
// resolution px) back to stage-viewport px for the "locate selection" overlay.
// `toStage` converts a natural-px point to stage px; `scale` is the live
// natural→display ratio (for the highlight brush radius).
function regionToStageShape(region, toStage, scale) {
  if (!region) return null;
  switch (region.kind) {
    case 'rect': {
      const a = toStage({ x: region.x1, y: region.y1 });
      const b = toStage({ x: region.x2, y: region.y2 });
      return { kind: 'rect', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    case 'union':
      return { kind: 'union', points: region.points.map(toStage), r: region.r * scale };
    case 'path':
      return { kind: 'path', points: region.points.map(toStage) };
    default:
      return null;
  }
}

// Width bounds (layout px) for the resizable "Extracted text" panel.
const HISTORY_MIN_WIDTH = 240;
// Zoom bounds and step for the media viewer.
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.3;
const HISTORY_MAX_WIDTH = 960;
// One default width for the side panel across ALL file types (it's the same
// panel everywhere). Defaults to the max so the panel opens at full width;
// still resizable down to HISTORY_MIN_WIDTH.
const HISTORY_DEFAULT_WIDTH = HISTORY_MAX_WIDTH;

// Persisted doc-viewer column layout (px). Shared across files so resizing the
// chat / media / advisor columns in one WhatsApp conversation is remembered the
// next time any conversation (or document) is opened.
//   chatW    — width of the conversation column (chat ↔ media split)
//   advisorW — width of the side panel (AI advisor / extracted-text)
const DV_LAYOUT_KEY = 'docvex:doc-viewer:layout:v1';
function readDvLayout() {
  try { const v = JSON.parse(localStorage.getItem(DV_LAYOUT_KEY)); if (v && typeof v === 'object') return v; } catch { /* ignore */ }
  return {};
}
function writeDvLayout(patch) {
  try { localStorage.setItem(DV_LAYOUT_KEY, JSON.stringify({ ...readDvLayout(), ...patch })); } catch { /* ignore */ }
}

// Side-panel tab labels. Which tabs a file type shows is decided by
// sideTabsForKind: Text extraction is for images + video, AI captions for
// audio + video, and the AI advisor is available for every file type. All three
// live in ONE tabbed side panel (the "AI advisor" panel) beside the document.
const SIDE_TAB_LABELS = { extract: 'Text extraction', captions: 'AI captions', advisor: 'AI advisor' };
// The Multitool always shows all three tools; each pane renders a graceful empty
// state for a tool that doesn't apply to its file type.
function sideTabsForKind() {
  return ['extract', 'captions', 'advisor'];
}

// Tab bar shared by every file type's side panel. `tabs` is the ordered list of
// tab ids the host wants shown (see sideTabsForKind).
function SidePanelTabs({ tabs = ['extract', 'captions'], active, onChange, slot = null }) {
  const el = (
    <div className="dv-side-tabs">
      {tabs.map((id) => (
        <button
          key={id}
          type="button"
          className={`dv-side-tab${active === id ? ' is-active' : ''}`}
          onClick={() => onChange(id)}
        >
          {SIDE_TAB_LABELS[id]}
        </button>
      ))}
    </div>
  );
  // When a slot is given (the Multitool topbar), render the tabs there instead
  // of inline above the panel content.
  return slot ? createPortal(el, slot) : el;
}
// Paper-plane send glyph for the advisor composer (mirrors the main app's
// AI-tab composer send button).
const AdvisorSendGlyph = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4z" />
  </svg>
);

// Per-file AI advisor — a lightweight chat about the open file, available on
// every file type's side panel. Backed by the project-ai Edge Function
// (askProjectAi); shows an inline notice when the AI key isn't configured. The
// conversation is per-mount (resets when the file changes), not persisted.
function AdvisorPanel({ file }) {
  const [messages, setMessages] = useState([]); // [{ role, content }]
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  // Reset the thread when the panel is reused for a different file.
  useEffect(() => { setMessages([]); setInput(''); setError(null); }, [file.storage_path]);

  // Keep the newest turn in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || busy) return;
    const next = [...messages, { role: 'user', content: q }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setError(null);
    const res = await askProjectAi({ messages: next, fileNames: [file.name] });
    setBusy(false);
    if (res.error) { setError('The AI advisor is unavailable right now.'); return; }
    setMessages((m) => [...m, { role: 'assistant', content: res.text }]);
  }, [input, busy, messages, file.name]);

  return (
    <div className="dv-advisor">
      <div className="dv-advisor-scroll" ref={scrollRef}>
        <header className="dv-ocr-history-head">
          <div className="dv-ocr-history-eyebrow">
            <span>AI advisor</span>
            <span className="dv-ocr-history-eyebrow-muted">· about this file</span>
          </div>
          <h2 className="dv-ocr-history-title">Ask about this file</h2>
        </header>
        {messages.length === 0 && !busy ? (
          <p className="dv-ocr-history-empty">
            Ask the AI advisor anything about <strong>{file.name}</strong> — a summary, the key points, or what to do next.
          </p>
        ) : (
          <div className="dv-advisor-msgs">
            {messages.map((m, i) => (
              <div key={i} className={`dv-advisor-msg is-${m.role}`}>{m.content}</div>
            ))}
            {busy && <div className="dv-advisor-msg is-assistant is-typing">Thinking…</div>}
          </div>
        )}
        {error && (
          <div className="dv-ocr-error" role="alert">
            <span>{error}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>×</button>
          </div>
        )}
      </div>
      <div className="dv-advisor-compose">
        {/* Mirrors the main app's AI-tab composer (.dvx-composer): a frosted
            rounded surface, textarea on top, a round accent send button below. */}
        <div
          className="dv-advisor-composer"
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            e.currentTarget.style.setProperty('--spot-x', `${e.clientX - r.left}px`);
            e.currentTarget.style.setProperty('--spot-y', `${e.clientY - r.top}px`);
          }}
        >
          <textarea
            className="dv-advisor-composer-textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask about this file…"
            rows={1}
          />
          <div className="dv-advisor-composer-toolbar">
            <div className="dv-advisor-composer-spacer" />
            <button
              type="button"
              className="dv-advisor-composer-send"
              onClick={send}
              disabled={busy || !input.trim()}
              aria-label="Send"
            >
              {AdvisorSendGlyph}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Caption snap layout (px within the video stage):
//  • CAP_PAD      — edge inset for the top / left / right snap targets
//  • CAP_BOTTOM   — keep the caption clear of the timeline + controls bar
//  • CAP_TOPRIGHT — top-right target drops below the zoom pill + Extract-text
//                   button (both now live in the stage's top-right corner)
//  • CAP_SNAP     — snap when the caption centre is within this distance
const CAP_PAD = 16;
const CAP_BOTTOM = 118;
const CAP_TOPRIGHT = 108;
const CAP_SNAP = 46;
// Fixed nominal half-size used ONLY to place the snap dots, so they sit in the
// same spot regardless of the current caption's width/height (the snap-target
// centres still use the real half-size so the box lands fully inside the stage).
const CAP_DOT_HALFW = 80;
const CAP_DOT_HALFH = 18;

function MediaOcrPane({ file, url, kind, sidePanelSlot = null, sideTabsSlot = null }) {
  const stageRef = useRef(null);
  const mediaRef = useRef(null);
  const clipIdRef = useRef(`dvocr-${Math.random().toString(36).slice(2)}`);
  const [armed, setArmed] = useState(false);
  const [tool, setTool] = useState('highlight');
  // Hover position — viewport px relative to the stage, null until the
  // cursor enters the overlay.
  const [cursorPos, setCursorPos] = useState(null);
  // Brush/shape size shared by Highlight, Circle and Square (Custom ignores
  // it); viewport px.
  const [brushRadius, setBrushRadius] = useState(OCR_CIRCLE_DEFAULT);
  const brushRadiusRef = useRef(brushRadius);
  useEffect(() => { brushRadiusRef.current = brushRadius; }, [brushRadius]);
  // Active mouse-down stroke: { tool, start: {x,y}, points: [{x,y}, ...] }.
  const [drag, setDrag] = useState(null);
  // Finalized shape awaiting/under OCR — stays visible so the loading
  // gradient has something to paint over.
  const [selection, setSelection] = useState(null);
  const [working, setWorking] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [failed, setFailed] = useState(false);
  // Persisted snippet history for this file — newest first; rendered oldest
  // first so the newest snippet lands at the bottom of the list.
  const [history, setHistory] = useState(() => loadOcrHistory(file.path));
  const [copiedId, setCopiedId] = useState(null);
  const [historyWidth, setHistoryWidth] = useState(HISTORY_DEFAULT_WIDTH);
  const jobIdRef = useRef(0);
  const historyListRef = useRef(null);
  // Compact-header-on-scroll (mirrors the Versions page): show the mini header
  // once the masthead has scrolled away. Hysteresis avoids edge flicker.
  const [historyScrolled, setHistoryScrolled] = useState(false);
  useEffect(() => {
    const el = historyListRef.current;
    if (!el) return undefined;
    const onScroll = () => setHistoryScrolled((s) => (s ? el.scrollTop > 8 : el.scrollTop > 28));
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // "Locate selection": clicking a snippet thumbnail highlights where it was
  // taken from, back on the picture/video. `highlightId` is the entry being
  // shown; `highlightShape` is its region mapped to current stage-viewport px.
  const [highlightId, setHighlightId] = useState(null);
  const [highlightShape, setHighlightShape] = useState(null);
  // Full-frame JPEG overlay shown while the video seeks to the right timestamp.
  // Gives an instant "correct frame" appearance; cleared once seeked fires.
  const [frameSnapOverlay, setFrameSnapOverlay] = useState(null);
  // True while seeking between highlighted items — blanks the stage.
  const [seekLoading, setSeekLoading] = useState(false);
  // Latest value for the stable pan handler (a plain stage click dismisses it).
  const highlightIdRef = useRef(null);
  useEffect(() => { highlightIdRef.current = highlightId; }, [highlightId]);
  // Re-map the stored region (natural px) to stage px every frame while a
  // highlight is shown, so it stays glued through zoom/pan transitions and
  // window resizes. The loop only runs while something is highlighted.
  useEffect(() => {
    if (!highlightId) { setHighlightShape(null); setFrameSnapOverlay(null); setSeekLoading(false); return undefined; }
    const entry = history.find((e) => e.id === highlightId);
    const el = mediaRef.current;
    const stage = stageRef.current;
    if (!entry?.region || !el || !stage) { setHighlightShape(null); setFrameSnapOverlay(null); setSeekLoading(false); return undefined; }

    let raf = 0;
    let dead = false;
    let snapSeekListener = null;
    let prevKey = '';

    // Compute the selection outline in current stage-viewport px.
    const computeShape = () => {
      const sr = stage.getBoundingClientRect();
      const mr = el.getBoundingClientRect();
      const natW = kind === 'video' ? el.videoWidth : el.naturalWidth;
      if (!mr.width || !natW) return null;
      const scale = mr.width / natW;
      const ox = mr.left - sr.left;
      const oy = mr.top - sr.top;
      const toStage = (p) => ({ x: p.x * scale + ox, y: p.y * scale + oy });
      return regionToStageShape(entry.region, toStage, scale);
    };

    // rAF loop keeps the outline glued through zoom/pan/resize.
    const tick = () => {
      if (dead) return;
      const shape = computeShape();
      const key = JSON.stringify(shape);
      if (key !== prevKey) { prevKey = key; setHighlightShape(shape); }
      raf = requestAnimationFrame(tick);
    };

    if (kind === 'video' && typeof entry.videoTime === 'number') {
      try { el.pause(); } catch { /* noop */ }
      const needsSeek = Math.abs((el.currentTime || 0) - entry.videoTime) >= 0.05;

      if (!needsSeek) {
        // Already on the right frame — show everything immediately.
        setSeekLoading(false);
        setFrameSnapOverlay(null);
        setHighlightShape(computeShape());
      } else {
        // Seeking needed. Show blank loading state immediately, then reveal
        // both the correct frame and selection outline together on `seeked`.
        // If a frameSnap was captured at extraction time, show it under the
        // loading overlay so the transition is less abrupt.
        setSeekLoading(true);
        setHighlightShape(null);
        if (entry.frameSnap) {
          const mr = el.getBoundingClientRect();
          const sr = stage.getBoundingClientRect();
          setFrameSnapOverlay({
            url: entry.frameSnap,
            left: mr.left - sr.left,
            top: mr.top - sr.top,
            width: mr.width,
            height: mr.height,
          });
        } else {
          setFrameSnapOverlay(null);
        }

        const onSeeked = () => {
          if (dead) return;
          setSeekLoading(false);
          setFrameSnapOverlay(null);
          const shape = computeShape();
          prevKey = JSON.stringify(shape);
          setHighlightShape(shape);
          raf = requestAnimationFrame(tick);
        };
        snapSeekListener = onSeeked;
        el.addEventListener('seeked', snapSeekListener, { once: true });
        try {
          if (el.fastSeek) el.fastSeek(entry.videoTime);
          else el.currentTime = entry.videoTime;
        } catch {
          el.removeEventListener('seeked', snapSeekListener);
          snapSeekListener = null;
          setSeekLoading(false);
          setFrameSnapOverlay(null);
          setHighlightShape(computeShape());
          raf = requestAnimationFrame(tick);
        }
        return () => {
          dead = true;
          cancelAnimationFrame(raf);
          if (snapSeekListener) el.removeEventListener('seeked', snapSeekListener);
        };
      }
    } else {
      setSeekLoading(false);
      setFrameSnapOverlay(null);
      setHighlightShape(computeShape());
    }

    // Start the rAF loop after the initial sync set.
    prevKey = JSON.stringify(computeShape());
    raf = requestAnimationFrame(tick);

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      if (snapSeekListener) el.removeEventListener('seeked', snapSeekListener);
    };
  }, [highlightId, history, kind]);

  // Esc clears an active highlight (matches the tool's Esc-to-cancel).
  useEffect(() => {
    if (!highlightId) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setHighlightId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [highlightId]);

  // ── Zoom / pan ───────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const panStateRef = useRef({ x: 0, y: 0 });

  // ── Video player ─────────────────────────────────────────────────
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Right sidebar tab (video only): 'extract' (OCR snippets) | 'captions'.
  const [rightTab, setRightTab] = useState('extract');
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [controlsShown, setControlsShown] = useState(true);
  const controlsTimerRef = useRef(null);
  // YouTube-style play/pause flash: { type: 'play'|'pause', seq: number }
  // `seq` is incremented on each trigger so the element remounts and the
  // animation restarts even if the user clicks the same action twice fast.
  const [playbackFlash, setPlaybackFlash] = useState(null);
  const flashSeqRef = useRef(0);

  const disarm = useCallback(() => {
    setArmed(false); setCursorPos(null); setDrag(null); setSelection(null);
    setWorking(false); setErrorMsg(null); setHighlightId(null);
  }, []);

  const bumpControls = useCallback(() => {
    setControlsShown(true);
    clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setControlsShown(false), 2500);
  }, []);
  const triggerPlaybackFlash = useCallback((type) => {
    flashSeqRef.current += 1;
    setPlaybackFlash({ type, seq: flashSeqRef.current });
  }, []);
  const togglePlay = useCallback(() => {
    const v = mediaRef.current;
    if (!v) return;
    if (v.paused) { v.play(); triggerPlaybackFlash('play'); }
    else { v.pause(); triggerPlaybackFlash('pause'); }
  }, [triggerPlaybackFlash]);
  const seekTo = useCallback((val) => {
    const v = mediaRef.current;
    if (v) v.currentTime = val;
  }, []);
  const setVol = useCallback((val) => {
    const v = mediaRef.current;
    if (!v) return;
    v.volume = val;
    v.muted = val === 0;
  }, []);
  const toggleMute = useCallback(() => {
    const v = mediaRef.current;
    if (v) v.muted = !v.muted;
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  }, []);

  useEffect(() => {
    if (!playing) { clearTimeout(controlsTimerRef.current); setControlsShown(true); }
  }, [playing]);
  useEffect(() => () => clearTimeout(controlsTimerRef.current), []);

  // ── Live AI captions (video) ─────────────────────────────────────
  // Mirror the generated transcript (pushed up from the side CaptionsPanel and
  // seeded from the per-file cache) so the line at the current time can show as
  // a subtitle over the decibel line. null until captions exist.
  const [captions, setCaptions] = useState(() => captionsFromCache(file.storage_path));
  useEffect(() => { setCaptions(captionsFromCache(file.storage_path)); }, [file.storage_path]);
  const activeCaption = useMemo(() => {
    if (kind !== 'video' || captions?.state !== 'done') return null;
    const seg = captions.segments.find((s) => currentTime >= s.start && currentTime < s.end);
    return seg?.text?.trim() || null;
  }, [kind, captions, currentTime]);

  // ── Movable caption (YouTube-style) ──────────────────────────────
  // `captionSettings` = { x, y, enabled }: x/y are the caption centre as a %
  // of the stage, loaded from a GLOBAL store so the placement (and on/off
  // state) is shared across files and survives app restarts. Dragging updates
  // it live and persists on drop.
  const captionRef = useRef(null);
  const [captionSettings, setCaptionSettings] = useState(loadCaptionSettings);
  const [draggingCaption, setDraggingCaption] = useState(false);
  // Snap targets shown while dragging (caption-centre px within the stage) +
  // the id of the one currently engaged.
  const [snapAnchors, setSnapAnchors] = useState(null);
  const [activeSnap, setActiveSnap] = useState(null);

  const toggleCaptions = useCallback(() => {
    setCaptionSettings((s) => {
      const next = { ...s, enabled: !s.enabled };
      saveCaptionSettings({ enabled: next.enabled });
      return next;
    });
  }, []);

  // The 9 snap targets (corners + edge-centres + middle) as caption-centre px,
  // each carrying the text alignment to apply when snapped there. Left column →
  // left-aligned, right column → right-aligned, centre column → centred. The
  // top-right target sits under the zoom pill + Extract-text button; the bottom
  // row stays above the timeline/controls.
  const captionSnapAnchors = useCallback((sr, halfW, halfH) => {
    // Snap-target CENTRES (x/y) — the caption box's centre when snapped here.
    // They use the REAL half-size so the box pins its edge at CAP_PAD and stays
    // fully inside the stage. These are viewport px, tested against the cursor.
    const leftX = CAP_PAD + halfW;
    const centreX = sr.width / 2;
    const rightX = sr.width - CAP_PAD - halfW;
    const topY = CAP_PAD + halfH;
    const midY = sr.height / 2;
    const bottomY = sr.height - CAP_BOTTOM - halfH;
    const topRightY = CAP_TOPRIGHT + halfH;
    // DOT positions (dx/dy) — where the snap dot is DRAWN. They use a FIXED
    // nominal half-size so the dots stay in the same place no matter how wide /
    // tall the current caption is (xPct/yPct are stage-relative %, since CSS px
    // ≠ viewport px under the app's CSS-zoom).
    const dLeftX = CAP_PAD + CAP_DOT_HALFW;
    const dRightX = sr.width - CAP_PAD - CAP_DOT_HALFW;
    const dTopY = CAP_PAD + CAP_DOT_HALFH;
    const dBottomY = sr.height - CAP_BOTTOM - CAP_DOT_HALFH;
    const dTopRightY = CAP_TOPRIGHT + CAP_DOT_HALFH;
    return [
      { id: 'tl', x: leftX, y: topY, dx: dLeftX, dy: dTopY, align: 'left' },
      { id: 'tc', x: centreX, y: topY, dx: centreX, dy: dTopY, align: 'center' },
      { id: 'tr', x: rightX, y: topRightY, dx: dRightX, dy: dTopRightY, align: 'right' },
      { id: 'ml', x: leftX, y: midY, dx: dLeftX, dy: midY, align: 'left' },
      { id: 'mc', x: centreX, y: midY, dx: centreX, dy: midY, align: 'center' },
      { id: 'mr', x: rightX, y: midY, dx: dRightX, dy: midY, align: 'right' },
      { id: 'bl', x: leftX, y: bottomY, dx: dLeftX, dy: dBottomY, align: 'left' },
      { id: 'bc', x: centreX, y: bottomY, dx: centreX, dy: dBottomY, align: 'center' },
      { id: 'br', x: rightX, y: bottomY, dx: dRightX, dy: dBottomY, align: 'right' },
    ].map((a) => ({ ...a, xPct: (a.dx / sr.width) * 100, yPct: (a.dy / sr.height) * 100 }));
  }, []);

  // Keep the caption clear of the timeline/controls whenever the stage resizes
  // (window resize, Files footer opening) — never raises a higher placement.
  useEffect(() => {
    if (kind !== 'video' || typeof ResizeObserver === 'undefined') return undefined;
    const stage = stageRef.current;
    if (!stage) return undefined;
    const clamp = () => {
      const sr = stage.getBoundingClientRect();
      if (!sr.height) return;
      const capEl = captionRef.current;
      const halfH = capEl ? capEl.getBoundingClientRect().height / 2 : 18;
      const maxYpct = ((sr.height - CAP_BOTTOM - halfH) / sr.height) * 100;
      setCaptionSettings((s) => (s.y > maxYpct ? { ...s, y: Math.max(0, maxYpct) } : s));
    };
    const ro = new ResizeObserver(clamp);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [kind]);

  const onCaptionMouseDown = useCallback((e) => {
    // Don't fight the OCR lasso or start a stage pan when grabbing the caption.
    if (armed) return;
    e.preventDefault();
    e.stopPropagation();
    const stage = stageRef.current;
    const capEl = captionRef.current;
    if (!stage || !capEl) return;
    const sr = stage.getBoundingClientRect();
    const cr = capEl.getBoundingClientRect();
    // Keep the grab point under the cursor (no jump to centre on grab).
    const grabDx = e.clientX - (cr.left + cr.width / 2);
    const grabDy = e.clientY - (cr.top + cr.height / 2);
    const halfW = cr.width / 2;
    const halfH = cr.height / 2;
    const anchors = captionSnapAnchors(sr, halfW, halfH);
    // Never let the caption drop under the timeline/controls.
    const maxY = sr.height - CAP_BOTTOM - halfH;
    setSnapAnchors(anchors);
    setDraggingCaption(true);
    let latest = null;
    const onMove = (ev) => {
      let cx = ev.clientX - grabDx - sr.left;
      let cy = ev.clientY - grabDy - sr.top;
      cx = Math.max(halfW, Math.min(sr.width - halfW, cx));
      cy = Math.max(halfH, Math.min(maxY, cy));
      // Snap to the nearest target within range; otherwise align by column.
      let best = null; let bestDist = CAP_SNAP;
      for (const a of anchors) {
        const d = Math.hypot(cx - a.x, cy - a.y);
        if (d < bestDist) { bestDist = d; best = a; }
      }
      let align;
      if (best) { cx = best.x; cy = best.y; align = best.align; setActiveSnap(best.id); }
      else { align = cx / sr.width <= 0.34 ? 'left' : cx / sr.width >= 0.66 ? 'right' : 'center'; setActiveSnap(null); }
      // Store the alignment-relevant EDGE (left edge for left, right edge for
      // right, centre for centre) so the caption pins to that side: text-align
      // reads naturally and the box stays put as the line length changes.
      const anchorX = align === 'left' ? cx - halfW : align === 'right' ? cx + halfW : cx;
      latest = { x: (anchorX / sr.width) * 100, y: (cy / sr.height) * 100, align };
      setCaptionSettings((s) => ({ ...s, ...latest }));
    };
    const onUp = () => {
      setDraggingCaption(false);
      setSnapAnchors(null);
      setActiveSnap(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (latest) saveCaptionSettings(latest);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [armed, captionSnapAnchors]);

  // ── Zoom / pan ───────────────────────────────────────────────────
  // Reset on file change.
  useEffect(() => { setZoom(1); setPanX(0); setPanY(0); }, [file.path]);
  // Keep panStateRef current so the drag closure reads the latest value.
  useEffect(() => { panStateRef.current = { x: panX, y: panY }; }, [panX, panY]);

  // Scale the pan by the zoom factor so the point at the stage centre stays put
  // through a zoom change — zooming in/out happens around the current view
  // centre (the panned-to spot) rather than the image's own centre.
  const reanchorPan = useCallback((factor) => {
    setPanX((px) => px * factor);
    setPanY((py) => py * factor);
  }, []);

  const zoomIn = useCallback(() => setZoom(z => {
    const next = Math.min(ZOOM_MAX, +(z * ZOOM_STEP).toFixed(3));
    reanchorPan(next / z);
    return next;
  }), [reanchorPan]);
  const zoomOut = useCallback(() => setZoom(z => {
    const next = z / ZOOM_STEP;
    if (next <= 1) { setPanX(0); setPanY(0); return 1; }
    const clamped = Math.max(ZOOM_MIN, +next.toFixed(3));
    reanchorPan(clamped / z);
    return clamped;
  }), [reanchorPan]);
  const zoomReset = useCallback(() => { setZoom(1); setPanX(0); setPanY(0); }, []);

  // Non-passive wheel listener for scroll-to-zoom (passive: false required for preventDefault).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (e) => {
      if (armed) return;
      e.preventDefault();
      setZoom(z => {
        const raw = e.deltaY < 0 ? z * ZOOM_STEP : z / ZOOM_STEP;
        if (raw <= 1 && e.deltaY > 0) { setPanX(0); setPanY(0); return 1; }
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +raw.toFixed(3)));
        reanchorPan(next / z);
        return next;
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [armed, reanchorPan]);

  // Stage mousedown: pan when zoomed, or click-to-play for video (replaces dv-player-click).
  const onStageMouseDown = useCallback((e) => {
    if (armed || e.button !== 0) return;
    if (e.target.closest('.dv-player-controls, .dv-ocr-btn-wrap, .dv-zoom-controls')) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const { x: startPanX, y: startPanY } = panStateRef.current;
    let moved = false;
    setIsDragging(true);
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      document.body.classList.add('dv-media-panning');
      setPanX(startPanX + dx);
      setPanY(startPanY + dy);
    };
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dv-media-panning');
      setIsDragging(false);
      if (moved) return;
      // A plain click dismisses an active "locate selection" highlight;
      // otherwise it falls through to the video's click-to-play.
      if (highlightIdRef.current) setHighlightId(null);
      else if (kind === 'video') togglePlay();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [armed, kind, togglePlay]);

  // Keyboard shortcuts: +/= zoom in, - zoom out, 0 reset.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn(); }
      else if (e.key === '-') { e.preventDefault(); zoomOut(); }
      else if (e.key === '0') { e.preventDefault(); zoomReset(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomIn, zoomOut, zoomReset]);

  // Reopening the file restores its history; edits to the list persist back.
  useEffect(() => { saveOcrHistory(file.path, history); }, [file.path, history]);

  // Esc cancels the tool and any in-flight selection/error.
  useEffect(() => {
    if (!armed) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') disarm(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, disarm]);

  // Auto-dismiss the error pill.
  useEffect(() => {
    if (!errorMsg) return undefined;
    const t = setTimeout(() => setErrorMsg(null), 4000);
    return () => clearTimeout(t);
  }, [errorMsg]);

  // shape: { kind: 'circle' | 'rect' | 'union' | 'path', ... } in
  // stage-viewport px. Maps it to natural-resolution pixels via the media
  // element's box, clips the crop to its outline (Photoshop-lasso style),
  // and sends it to lib/ocr.
  const runOcr = useCallback(async (shape, stageRect) => {
    const el = mediaRef.current;
    if (!el) return;
    const natW = kind === 'video' ? el.videoWidth : el.naturalWidth;
    const natH = kind === 'video' ? el.videoHeight : el.naturalHeight;
    if (!natW || !natH) return;
    // For video, remember the exact moment OCR read the frame so clicking the
    // snippet later can teleport the player back to it. Also capture a full-
    // frame JPEG snapshot so the "jump to moment" button can show the correct
    // frame instantly while the video seeks in the background.
    const videoTime = kind === 'video' ? (el.currentTime || 0) : undefined;
    let frameSnap;
    if (kind === 'video') {
      try {
        const fc = document.createElement('canvas');
        const fscale = Math.min(1, 720 / Math.max(natW, natH));
        fc.width = Math.round(natW * fscale);
        fc.height = Math.round(natH * fscale);
        fc.getContext('2d').drawImage(el, 0, 0, fc.width, fc.height);
        frameSnap = fc.toDataURL('image/jpeg', 0.82);
      } catch { /* cross-origin or canvas taint — skip */ }
    }
    const mr = el.getBoundingClientRect();
    if (!mr.width || !mr.height) { setSelection(null); return; }
    const mrRelLeft = mr.left - stageRect.left;
    const mrRelTop = mr.top - stageRect.top;

    // object-fit: contain keeps the element's box aspect ratio equal to the
    // image's, so one scale factor covers both axes.
    const mapScale = mr.width / natW;
    const toNat = (p) => ({ x: (p.x - mrRelLeft) / mapScale, y: (p.y - mrRelTop) / mapScale });

    let bbox;
    if (shape.kind === 'rect') {
      const p1 = toNat({ x: shape.x1, y: shape.y1 });
      const p2 = toNat({ x: shape.x2, y: shape.y2 });
      bbox = { minX: Math.min(p1.x, p2.x), minY: Math.min(p1.y, p2.y), maxX: Math.max(p1.x, p2.x), maxY: Math.max(p1.y, p2.y) };
    } else if (shape.kind === 'union') {
      const r = shape.r / mapScale;
      const pts = shape.points.map(toNat);
      bbox = {
        minX: Math.min(...pts.map((p) => p.x - r)), minY: Math.min(...pts.map((p) => p.y - r)),
        maxX: Math.max(...pts.map((p) => p.x + r)), maxY: Math.max(...pts.map((p) => p.y + r)),
      };
    } else {
      const pts = shape.points.map(toNat);
      bbox = {
        minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)),
        maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)),
      };
    }

    // Selection geometry in natural-resolution px — stored with the entry so
    // clicking its thumbnail can re-draw the selection back onto the media at
    // any zoom/size (see the "locate selection" highlight overlay below).
    let region = null;
    if (shape.kind === 'rect') {
      const a = toNat({ x: shape.x1, y: shape.y1 });
      const b = toNat({ x: shape.x2, y: shape.y2 });
      region = { kind: 'rect', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    } else if (shape.kind === 'union') {
      region = { kind: 'union', points: shape.points.map(toNat), r: shape.r / mapScale };
    } else if (shape.kind === 'path') {
      region = { kind: 'path', points: shape.points.map(toNat) };
    }

    const minX = Math.max(0, bbox.minX);
    const minY = Math.max(0, bbox.minY);
    const maxX = Math.min(natW, bbox.maxX);
    const maxY = Math.min(natH, bbox.maxY);
    const sw = maxX - minX;
    const sh = maxY - minY;
    if (sw < 4 || sh < 4) { setSelection(null); return; }
    // Claude downsizes anything over OCR_MAX_EDGE on the long side — cap the
    // crop there (never upscale; extra pixels only slow the upload).
    const cropScale = Math.min(1, OCR_MAX_EDGE / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * cropScale));
    canvas.height = Math.max(1, Math.round(sh * cropScale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const toCanvas = (p) => { const n = toNat(p); return { x: (n.x - minX) * cropScale, y: (n.y - minY) * cropScale }; };
    const rScale = cropScale / mapScale;

    // Clip to the selection's outline before drawing — pixels outside it
    // stay transparent rather than reading as part of the snippet.
    ctx.beginPath();
    if (shape.kind === 'rect') {
      const p1 = toCanvas({ x: shape.x1, y: shape.y1 });
      const p2 = toCanvas({ x: shape.x2, y: shape.y2 });
      ctx.rect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
    } else if (shape.kind === 'union') {
      const r = shape.r * rScale;
      shape.points.forEach((p) => {
        const c = toCanvas(p);
        ctx.moveTo(c.x + r, c.y);
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      });
    } else {
      shape.points.forEach((p, i) => {
        const c = toCanvas(p);
        if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y);
      });
      ctx.closePath();
    }
    ctx.clip();
    try {
      ctx.drawImage(el, minX, minY, sw, sh, 0, 0, canvas.width, canvas.height);
    } catch {
      setSelection(null);
      setWorking(false);
      setErrorMsg("Couldn't read pixels from this file.");
      return;
    }

    jobIdRef.current += 1;
    const id = jobIdRef.current;
    setWorking(true);
    try {
      const text = await recognizeCanvas(canvas);
      if (jobIdRef.current === id) {
        const entry = { id: `${Date.now()}-${id}`, thumb: canvasToThumbDataUrl(canvas), text, createdAt: Date.now(), region, natW, natH, videoTime, frameSnap };
        setHistory((prev) => [entry, ...prev]);
        setSelection(null);
        setWorking(false);
        requestAnimationFrame(() => {
          const listEl = historyListRef.current;
          if (listEl) listEl.scrollTop = listEl.scrollHeight;
        });
      }
    } catch (e) {
      if (jobIdRef.current === id) {
        setWorking(false);
        setSelection(null);
        setErrorMsg(String(e?.message || 'Text recognition failed.'));
      }
    }
  }, [kind]);

  // Builds the finalized shape for a finished drag, applying tool-specific
  // minimum sizes — a plain click without dragging falls back to the brush
  // size, like the previous click-to-extract behaviour.
  const finalizeDrag = useCallback((d, stageRect) => {
    const cur = d.points[d.points.length - 1];
    let shape;
    if (d.tool === 'square') {
      const trivial = Math.abs(cur.x - d.start.x) < 4 && Math.abs(cur.y - d.start.y) < 4;
      const r = brushRadiusRef.current;
      shape = trivial
        ? { kind: 'rect', x1: d.start.x - r, y1: d.start.y - r, x2: d.start.x + r, y2: d.start.y + r }
        : { kind: 'rect', x1: d.start.x, y1: d.start.y, x2: cur.x, y2: cur.y };
    } else if (d.tool === 'lasso') {
      shape = d.points.length < 3
        ? { kind: 'rect', x1: d.start.x - brushRadiusRef.current, y1: d.start.y - brushRadiusRef.current, x2: d.start.x + brushRadiusRef.current, y2: d.start.y + brushRadiusRef.current }
        : { kind: 'path', points: d.points };
    } else {
      shape = { kind: 'union', points: d.points, r: brushRadiusRef.current };
    }
    setSelection(shape);
    runOcr(shape, stageRect);
  }, [runOcr]);

  // Tracks the cursor for the idle brush/shape preview. State stays in
  // viewport px; toLayoutPx only at render time.
  const onOverlayMouseMove = (e) => {
    if (drag) return;
    const stageRect = stageRef.current.getBoundingClientRect();
    setCursorPos({ x: e.clientX - stageRect.left, y: e.clientY - stageRect.top });
  };

  // Scroll resizes the active tool's brush/shape size (Custom ignores it).
  const onOverlayWheel = (e) => {
    e.preventDefault();
    if (tool === 'lasso') return;
    setBrushRadius((r) => Math.min(OCR_CIRCLE_MAX, Math.max(OCR_CIRCLE_MIN, r - e.deltaY * OCR_CIRCLE_STEP)));
  };

  // Click-and-drag paints (Highlight/Custom) or draws (Circle/Square) the
  // selection; release runs OCR on it.
  const onOverlayMouseDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const stageEl = stageRef.current;
    const stageRect0 = stageEl.getBoundingClientRect();
    const start = { x: e.clientX - stageRect0.left, y: e.clientY - stageRect0.top };
    setErrorMsg(null);
    setDrag({ tool, start, points: [start] });
    const onMove = (ev) => {
      const r = stageEl.getBoundingClientRect();
      const p = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      setCursorPos(p);
      setDrag((d) => {
        if (!d) return d;
        if (d.tool === 'highlight' || d.tool === 'lasso') {
          const last = d.points[d.points.length - 1];
          const minDist = d.tool === 'highlight' ? Math.max(4, brushRadiusRef.current * 0.35) : 3;
          if (Math.hypot(p.x - last.x, p.y - last.y) < minDist) return d;
          return { ...d, points: [...d.points, p] };
        }
        return { ...d, points: [d.start, p] };
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const r = stageEl.getBoundingClientRect();
      setDrag((d) => {
        if (d) finalizeDrag(d, r);
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Drag handle resizing the "Extracted text" panel. clientX deltas are
  // viewport px; the panel's width is a layout-px CSS length (see lib/appZoom).
  const beginHistoryResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = historyWidth;
    document.body.classList.add('dv-ocr-resizing');
    const onMove = (ev) => {
      const delta = toLayoutPx(startX - ev.clientX);
      setHistoryWidth(Math.min(HISTORY_MAX_WIDTH, Math.max(HISTORY_MIN_WIDTH, startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dv-ocr-resizing');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const toggleTool = () => {
    if (armed) { disarm(); return; }
    setHighlightId(null);
    // Extraction only ever reads a paused frame — arm pauses the video.
    if (kind === 'video') { try { mediaRef.current?.pause(); } catch { /* noop */ } }
    setArmed(true);
  };

  const copyHistoryEntry = async (entry) => {
    try {
      await navigator.clipboard.writeText(entry.text || '');
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId((cur) => (cur === entry.id ? null : cur)), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const removeHistoryEntry = (entryId) => {
    if (highlightId === entryId) setHighlightId(null);
    setHistory((prev) => prev.filter((e) => e.id !== entryId));
  };

  const clearHistory = () => { setHighlightId(null); setHistory([]); };

  // The shape shown to the user: the active drag in progress, or the idle
  // brush/shape preview that follows the cursor before any drag starts.
  const previewShape = useMemo(() => {
    if (drag) {
      const cur = drag.points[drag.points.length - 1];
      if (drag.tool === 'square') {
        return { kind: 'rect', x1: drag.start.x, y1: drag.start.y, x2: cur.x, y2: cur.y };
      }
      if (drag.tool === 'lasso') return { kind: 'path', points: drag.points };
      return { kind: 'union', points: drag.points, r: brushRadius };
    }
    if (!cursorPos) return null;
    if (tool === 'square') return { kind: 'rect', x1: cursorPos.x - brushRadius, y1: cursorPos.y - brushRadius, x2: cursorPos.x + brushRadius, y2: cursorPos.y + brushRadius };
    if (tool === 'lasso') return { kind: 'circle', cx: cursorPos.x, cy: cursorPos.y, r: 4 };
    return { kind: 'circle', cx: cursorPos.x, cy: cursorPos.y, r: brushRadius };
  }, [drag, cursorPos, tool, brushRadius]);

  const clipBase = clipIdRef.current;

  if (failed) {
    return (
      <div className="dv-noview">
        <p className="dv-noview-title">Couldn't display this {kind}</p>
        <p className="dv-noview-sub">{file.name}</p>
        <button type="button" className="dv-chip" onClick={() => localFolderApi.openPath(file.path || file.storage_path)}>
          Open in default app
        </button>
      </div>
    );
  }

  return (
    <>
    <div
      ref={stageRef}
      className="dv-media-stage"
      onMouseMove={kind === 'video' ? bumpControls : undefined}
      onMouseLeave={kind === 'video' && playing ? () => setControlsShown(false) : undefined}
      onMouseDown={onStageMouseDown}
      style={{
        cursor: armed ? undefined
          : kind === 'video' && playing && !controlsShown ? 'none'
          : zoom > 1 ? 'grab'
          : undefined,
      }}
    >
      {kind === 'video' ? (
        <video
          ref={mediaRef}
          className="dv-media-el"
          src={url}
          // CORS-mode load (the localfile handler sends ACAO) — without it
          // drawing the frame to the OCR canvas taints it and export throws.
          crossOrigin="anonymous"
          preload="metadata"
          onPlay={() => { setPlaying(true); disarm(); bumpControls(); }}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={() => setCurrentTime(mediaRef.current?.currentTime || 0)}
          onDurationChange={() => setDuration(mediaRef.current?.duration || 0)}
          onVolumeChange={() => { const v = mediaRef.current; if (v) { setMuted(v.muted); setVolume(v.volume); } }}
          onError={() => setFailed(true)}
          style={{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})`, transition: isDragging ? 'none' : 'transform 120ms ease' }}
        />
      ) : (
        <img
          ref={mediaRef} className="dv-media-el" src={url} alt={file.name}
          crossOrigin="anonymous" onError={() => setFailed(true)}
          style={{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})`, transition: isDragging ? 'none' : 'transform 120ms ease' }}
        />
      )}

      {frameSnapOverlay && (
        <img
          className="dv-frame-snap"
          src={frameSnapOverlay.url}
          alt=""
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: frameSnapOverlay.left,
            top: frameSnapOverlay.top,
            width: frameSnapOverlay.width,
            height: frameSnapOverlay.height,
            objectFit: 'fill',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
      )}

      {armed && (
        <div
          className="dv-ocr-overlay"
          style={tool === 'square' ? { cursor: 'crosshair' } : undefined}
          onMouseMove={onOverlayMouseMove}
          onMouseLeave={() => { if (!drag) setCursorPos(null); }}
          onWheel={onOverlayWheel}
          onMouseDown={onOverlayMouseDown}
        >
          {/* SVG layer: scrim (dark overlay with selection punched out),
              clipPath defs, and shape outlines. */}
          <svg className="dv-ocr-lasso" aria-hidden="true">
            <defs>
              {/* Scrim mask — white everywhere except inside the active
                  selection (black = hole → image shows at full brightness). */}
              <mask id={`${clipBase}-m`}>
                <rect width="100%" height="100%" fill="white" />
                {previewShape && shapeElements(previewShape, undefined, { fill: 'black' })}
                {selection && working && shapeElements(selection, undefined, { fill: 'black' })}
              </mask>
              {previewShape && (
                <clipPath id={`${clipBase}-p`} clipPathUnits="userSpaceOnUse">
                  {shapeElements(previewShape)}
                </clipPath>
              )}
              {selection && working && (
                <clipPath id={`${clipBase}-s`} clipPathUnits="userSpaceOnUse">
                  {shapeElements(selection)}
                </clipPath>
              )}
            </defs>
            {/* Dark scrim, cut out around the active selection. */}
            <rect className="dv-ocr-lasso-scrim" width="100%" height="100%" mask={`url(#${clipBase}-m)`} />
            {/* Outline for rect / lasso-path shapes; union (highlight brush)
                and the lasso cursor dot rely on fills only. */}
            {previewShape && previewShape.kind !== 'union' && previewShape.kind !== 'circle' && shapeElements(previewShape, 'dv-ocr-lasso-outline')}
          </svg>
          {/* Flat accent-tint fill clipped to the live preview shape. */}
          {previewShape && (
            <div className="dv-ocr-livefill" style={{ clipPath: `url("#${clipBase}-p")` }} />
          )}
          {/* Apple-Intelligence-style animated gradient while OCR runs. */}
          {selection && working && (
            <div className="dv-ocr-loading" style={{ clipPath: `url("#${clipBase}-s")` }} />
          )}
        </div>
      )}

      {/* "Locate selection" highlight — clicking a snippet thumbnail dims the
          media and spotlights where that snippet was read from. Non-interactive
          (pointer-events: none) so pan/zoom keep working; dismissed via Esc, a
          plain stage click, or re-clicking the thumbnail. */}
      {highlightShape && !armed && (
        <div className="dv-ocr-highlight">
          <svg className="dv-ocr-lasso" aria-hidden="true">
            <defs>
              <mask id={`${clipBase}-hl`}>
                <rect width="100%" height="100%" fill="white" />
                {shapeElements(highlightShape, undefined, { fill: 'black' })}
              </mask>
              {/* Brush stroke = union of overlapping circles. Clip ONE uniform
                  fill to that union (like the live tool's tint) so it reads as
                  a single smooth blob, not stacked circle outlines. */}
              {highlightShape.kind === 'union' && (
                <clipPath id={`${clipBase}-hlc`} clipPathUnits="userSpaceOnUse">
                  {shapeElements(highlightShape)}
                </clipPath>
              )}
            </defs>
            <rect className="dv-ocr-lasso-scrim dv-ocr-highlight-scrim" width="100%" height="100%" mask={`url(#${clipBase}-hl)`} />
            {highlightShape.kind === 'union'
              ? <rect className="dv-ocr-highlight-union" width="100%" height="100%" clipPath={`url(#${clipBase}-hlc)`} />
              : shapeElements(highlightShape, 'dv-ocr-lasso-outline dv-ocr-highlight-outline')}
          </svg>
        </div>
      )}

      {seekLoading && (
        <div className="dv-seek-loading" aria-hidden="true">
          <div className="dv-seek-loading-dots">
            <span /><span /><span />
          </div>
        </div>
      )}

      {/* Zoom controls — floating pill top-right, always visible. */}
      <div className="dv-zoom-controls">
        <button type="button" className="dv-zoom-btn" onClick={zoomOut} aria-label="Zoom out">−</button>
        <button type="button" className="dv-zoom-pct" onClick={zoomReset} title="Reset zoom">{Math.round(zoom * 100)}%</button>
        <button type="button" className="dv-zoom-btn" onClick={zoomIn} aria-label="Zoom in">+</button>
      </div>

      {/* Custom video player — auto-hiding controls bar. */}
      {kind === 'video' && playbackFlash && (
        <div
          key={playbackFlash.seq}
          className="dv-playback-flash"
          aria-hidden="true"
          onAnimationEnd={() => setPlaybackFlash(null)}
        >
          <div className="dv-playback-flash-circle">
            {playbackFlash.type === 'play' ? PlayGlyph : PauseGlyph}
          </div>
        </div>
      )}

      {kind === 'video' && (
        <>
          {/* Snap targets — shown while dragging the caption. Corners +
              edge-centres + middle; the engaged one lights up. */}
          {draggingCaption && snapAnchors && (
            <div className="dv-caption-snaps" aria-hidden="true">
              {snapAnchors.map((a) => (
                <span
                  key={a.id}
                  className={`dv-caption-snap${activeSnap === a.id ? ' is-active' : ''}`}
                  style={{ left: `${a.xPct}%`, top: `${a.yPct}%` }}
                />
              ))}
            </div>
          )}
          {/* Live AI caption — the active transcript line as a subtitle.
              Drag it anywhere over the video (YouTube-style); it snaps to the
              edges/corners and aligns its text to match. The spot is remembered
              globally and stays clear of the timeline. */}
          {captionSettings.enabled && activeCaption && (
            <div
              ref={captionRef}
              className={`dv-video-caption${draggingCaption ? ' is-dragging' : ''}${armed ? ' is-locked' : ''}`}
              style={{
                left: `${captionSettings.x}%`,
                top: `${captionSettings.y}%`,
                // Pin the edge that matches the alignment (left edge / centre /
                // right edge) so x is that edge's position.
                transform: `translate(${captionSettings.align === 'left' ? '0%' : captionSettings.align === 'right' ? '-100%' : '-50%'}, -50%)`,
                textAlign: captionSettings.align,
              }}
              onMouseDown={onCaptionMouseDown}
              title="Drag to reposition"
            >
              {activeCaption}
            </div>
          )}
          <div className={`dv-player${!playing || controlsShown ? ' is-visible' : ''}`}>
            <div className="dv-player-scrim" />
            <div className="dv-player-controls">
              <MediaScope
                mediaRef={mediaRef}
                url={url}
                currentTime={currentTime}
                duration={duration}
                playing={playing}
                onSeek={seekTo}
                className="dv-player-scope"
                label="Seek through video"
              />
              <div className="dv-player-row">
                <button type="button" className="dv-player-btn" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
                  {playing ? PauseGlyph : PlayGlyph}
                </button>
                <span className="dv-player-time">{formatVideoTime(currentTime)} / {formatVideoTime(duration)}</span>
                <div className="dv-player-spacer" />
                <div className="dv-player-vol-wrap">
                  <button type="button" className="dv-player-btn" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
                    {muted || volume === 0 ? VolumeMuteGlyph : VolumeHighGlyph}
                  </button>
                  <input
                    type="range"
                    className="dv-player-vol"
                    min="0" max="1" step="0.01"
                    value={muted ? 0 : volume}
                    onChange={(e) => setVol(parseFloat(e.target.value))}
                    style={{ '--pct': `${(muted ? 0 : volume) * 100}%` }}
                    aria-label="Volume"
                  />
                </div>
                {captions?.state === 'done' && (
                  <button
                    type="button"
                    className={`dv-player-btn dv-player-cc${captionSettings.enabled ? ' is-active' : ''}`}
                    onClick={toggleCaptions}
                    aria-label={captionSettings.enabled ? 'Hide captions' : 'Show captions'}
                    aria-pressed={captionSettings.enabled}
                  >
                    {CaptionsGlyph}
                  </button>
                )}
                <button type="button" className="dv-player-btn" onClick={toggleFullscreen} aria-label="Toggle fullscreen">
                  {FullscreenGlyph}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Extract-text button + tool-picker dropdown, co-located so the pill
          morphs open from the button. Toolbar is always in the DOM so the
          grid-accordion can animate height on both open and close. */}
      <div className={`dv-ocr-btn-wrap${armed ? ' is-armed' : ''}`}>
          <button type="button" className={`dv-ocr-btn${armed ? ' is-active' : ''}`} onClick={toggleTool}>
            {ScanTextGlyph}
            <span>Extract text</span>
            <span className="dv-ocr-btn-chevron">{ChevronGlyph}</span>
          </button>
        <div className={`dv-ocr-toolbar-wrap${armed ? ' is-open' : ''}`}>
          <div className="dv-ocr-toolbar">
            <div className="dv-ocr-toolbar-inner">
              <div className="dv-ocr-tools">
                {OCR_TOOLS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`dv-ocr-tool${tool === t.id ? ' is-active' : ''}`}
                    onClick={() => setTool(t.id)}
                  >
                    {t.icon}
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
              <p className="dv-ocr-tool-hint">{OCR_TOOLS.find((t) => t.id === tool)?.hint}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Error pill — replaces the old bottom-of-stage status modal. */}
      {errorMsg && (
        <div className="dv-ocr-error" role="alert">
          <span>{errorMsg}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setErrorMsg(null)}>×</button>
        </div>
      )}
    </div>

    {(() => {
    const sidePanel = (
    <aside className={`dv-ocr-history${sidePanelSlot ? ' dv-side-portal' : ''}`} style={sidePanelSlot ? undefined : { width: `${historyWidth}px` }}>
      {/* Tab strip portals into the Multitool topbar when slotted, else inline. */}
      <SidePanelTabs tabs={sideTabsForKind(kind)} active={rightTab} onChange={setRightTab} slot={sideTabsSlot} />
      {rightTab === 'advisor' ? (
        <AdvisorPanel file={file} />
      ) : rightTab === 'captions' ? (
        <CaptionsPanel file={file} url={url} currentTime={currentTime} onSeek={seekTo} onCaptionsChange={setCaptions} />
      ) : (
      <>
      <div className="dv-ocr-history-scroll" ref={historyListRef}>
        {/* Masthead — accent eyebrow + display title + meta (Versions style). */}
        <header className="dv-ocr-history-head">
          <div className="dv-ocr-history-eyebrow">
            <span>Snippets</span>
            <span className="dv-ocr-history-eyebrow-muted">· from this file</span>
          </div>
          <h2 className="dv-ocr-history-title">Extracted text</h2>
          <div className="dv-ocr-history-meta">
            <span className="dv-ocr-history-count">
              {history.length > 0
                ? <><strong>{history.length}</strong> {history.length === 1 ? 'snippet' : 'snippets'}</>
                : 'No snippets yet'}
            </span>
            {history.length > 0 && (
              <button type="button" className="dv-ocr-history-clear" onClick={clearHistory}>Clear all</button>
            )}
          </div>
        </header>
        {history.length === 0 ? (
        <p className="dv-ocr-history-empty">
          Click “Extract text”, then click the {kind === 'video' ? 'video frame' : 'image'} to start collecting snippets here. They'll be here next time you open this file.
        </p>
      ) : (
        <div className="dv-ocr-history-list">
          {[...history].reverse().map((entry) => {
            const { date, time } = formatHistoryTimestamp(entry.createdAt);
            return (
              <div key={entry.id} className="dv-ocr-history-item">
                <div className="dv-ocr-history-rail">
                  <span className="dv-ocr-history-node" />
                  <div className="dv-ocr-history-date">
                    <span className="dv-ocr-history-date-d">{date}</span>
                    <span className="dv-ocr-history-date-t">{time}</span>
                  </div>
                </div>
                <div className="dv-ocr-history-content">
                  {entry.region ? (
                    <Tooltip content={highlightId === entry.id ? 'Hide selection' : (kind === 'video' ? 'Jump to this moment & show the selection' : 'Show this selection on the image')}>
                      <button
                        type="button"
                        className={`dv-ocr-history-thumb is-locatable${highlightId === entry.id ? ' is-active' : ''}`}
                        onClick={() => setHighlightId((cur) => (cur === entry.id ? null : entry.id))}
                      >
                        <img src={entry.thumb} alt="" />
                      </button>
                    </Tooltip>
                  ) : (
                    <div className="dv-ocr-history-thumb">
                      <img src={entry.thumb} alt="" />
                    </div>
                  )}
                  <div className="dv-ocr-history-card">
                    <p className={`dv-ocr-history-text${entry.text ? '' : ' is-empty'}`}>
                      {entry.text || 'No text found in this selection.'}
                    </p>
                    <div className="dv-ocr-history-actions">
                      {entry.text && (
                        <button type="button" className="dv-ocr-history-act" onClick={() => copyHistoryEntry(entry)}>
                          {copiedId === entry.id ? 'Copied' : 'Copy'}
                        </button>
                      )}
                      <button type="button" className="dv-ocr-history-remove" aria-label="Remove" onClick={() => removeHistoryEntry(entry.id)}>×</button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>
      </>
      )}
    </aside>
    );
    return sidePanelSlot
      ? createPortal(sidePanel, sidePanelSlot)
      : (<><div className="dv-ocr-resize" onMouseDown={beginHistoryResize} role="separator" aria-orientation="vertical" aria-label="Resize extracted text panel" />{sidePanel}</>);
    })()}
    </>
  );
}

// ── One open file's preview pane ───────────────────────────────────────
// Thumbnail for an open-files sidebar tile (Files-window style: preview on
// top, name underneath). Identical pipeline to the Files window: a
// thumbnailDescriptor resolved by FileThumbnail (image/video/PDF/PPTX
// posters from the shared resolver cache) with the same colored
// extension-badge glyph for everything else.
// `isWhatsApp` comes from the shell's per-tab detection (the text pane
// reports it after parsing the transcript) — recognised conversations show
// the WhatsApp mark, exactly like the Files window's export tiles.
function FileTabThumb({ tab, isWhatsApp }) {
  const descriptor = useMemo(() => describeLocalFile({
    localFile: { name: tab.name, mimeType: tab.mime, path: tab.path },
    localUrl: localUrlFor(tab.path),
    cloud: null,
    bytesChanged: false,
    localContentHash: null,
  }), [tab.path, tab.name, tab.mime]);
  return (
    <span className="fx-tile-thumb">
      {/* Reuses the Files-tab thumbnail (poster + type glyph + the cassette-tape
          frame for videos). */}
      <ItemThumbnail item={{ name: tab.name, ext: extOf(tab.name), descriptor, isWhatsApp: isWhatsApp || undefined }} />
    </span>
  );
}

// Split a filename into an editable base + extension (".pdf"), so a rename
// edits only the base — the extension is re-attached on commit (mirrors the
// Files page so the format is never changed by accident). Dotfiles / no-ext
// names pass through unchanged.
function splitBaseExt(name) {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  if (i <= 0 || i === n.length - 1) return { base: n, ext: '' };
  return { base: n.slice(0, i), ext: n.slice(i) };
}
function joinBaseExt(base, originalName) {
  const { ext } = splitBaseExt(originalName);
  const b = String(base || '').trim();
  if (!ext) return b;
  return b.toLowerCase().endsWith(ext.toLowerCase()) ? b : b + ext;
}

// Sidebar tab item — wraps the file tile with a morph-pill so hover shows the
// filename tooltip and right-click expands it into a context menu. The menu
// mirrors the Files page's file right-click (Open / Rename / Properties / Open
// file location), minus the in-app-clipboard Copy/Cut and Delete, plus Close.
function FileTabItem({ tab, isActive, isWhatsApp, onActivate, onClose, onRename }) {
  // Inline rename — same UX as the Files page tiles: an in-place input that
  // edits the base name only and commits on Enter / blur (Escape cancels).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  const beginRename = useCallback(() => {
    setDraft(splitBaseExt(tab.name).base);
    setEditing(true);
  }, [tab.name]);

  useLayoutEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (el) { el.focus(); el.select(); }
  }, [editing]);

  const commitRename = useCallback(() => {
    setEditing((wasEditing) => {
      if (wasEditing) {
        const next = joinBaseExt(draft, tab.name);
        if (next && next !== tab.name) onRename?.(tab, next);
      }
      return false;
    });
  }, [draft, tab, onRename]);

  const morphPill = useMorphPill({
    hoverContent: isWhatsApp ? (
      <span className="dv-filetab-wa-hover">
        <span className="dv-filetab-wa-name">{tab.name}</span>
        <span className="dv-filetab-wa-note">Recognized as WhatsApp convo</span>
      </span>
    ) : tab.name,
    menuItems: [
      {
        label: 'Open',
        key: 'open',
        onClick: () => localFolderApi.openPath(tab.path),
      },
      {
        label: 'Rename',
        key: 'rename',
        onClick: () => beginRename(),
      },
      {
        label: 'Properties',
        key: 'properties',
        onClick: () => localFolderApi.openPath(tab.path),
        confirm: {
          title: tab.name,
          message: tab.path,
          cancelLabel: 'Close',
          confirmLabel: 'Open',
        },
      },
      {
        label: 'Open file location',
        key: 'location',
        onClick: () => localFolderApi.showInFolder(tab.path),
      },
      {
        label: 'Close',
        key: 'close',
        onClick: () => onClose(),
      },
    ],
  });

  return (
    <>
      <div
        role="tab"
        aria-selected={isActive}
        className={`fx-tile dv-filetab-item${isActive ? ' is-selected' : ''}`}
        onClick={editing ? undefined : onActivate}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
        onMouseMove={editing ? undefined : morphPill.handleMouseMove}
        onMouseLeave={morphPill.handleMouseLeave}
        onContextMenu={editing ? undefined : morphPill.handleContextMenu}
      >
        <FileTabThumb tab={tab} isWhatsApp={isWhatsApp} />
        {editing ? (
          <input
            ref={inputRef}
            className="fx-tile-name fx-inline-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }}
            onBlur={commitRename}
            aria-label={`Rename ${tab.name}`}
          />
        ) : (
          <span><span className="fx-tile-name">{splitBaseExt(tab.name).base}</span></span>
        )}
        <button
          type="button"
          className="dv-filetab-close"
          aria-label={`Close ${tab.name}`}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        >
          ×
        </button>
      </div>
      {morphPill.node}
    </>
  );
}

// ── Audio player pane ────────────────────────────────────────────────
// Full-pane player for .mp3 / .wav / .ogg / etc opened from the Files page:
// play/pause + volume, with the file's loudness "decibel line" along the
// bottom doubling as the seek scrubber.

// "Decibel line": a loudness envelope decoded from the file (RMS per
// 1/AUDIO_SCOPE_HZ second, peak-normalised to 0..1). It's drawn full-width as a
// static waveform with a playhead, and click/drag on it seeks. We decode the
// envelope rather than tap the <audio> element through a MediaElementSource
// because routing a cross-origin localfile:// element through Web Audio outputs
// silence — it would mute playback. Cached per src so re-opens are instant.
const AUDIO_SCOPE_HZ = 120;
const envelopeCache = new Map();
let scopeDecodeCtx = null;
async function computeEnvelope(src, hz) {
  const key = `${src}:${hz}`;
  if (envelopeCache.has(key)) return envelopeCache.get(key);
  // Persistent cache: paints instantly on reopen instead of re-decoding.
  const stored = loadEnvelope(key);
  if (stored) { envelopeCache.set(key, stored); return stored; }
  try {
    const res = await fetch(src);
    const buf = await res.arrayBuffer();
    if (!scopeDecodeCtx) scopeDecodeCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const audio = await scopeDecodeCtx.decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    const total = Math.max(1, Math.round(audio.duration * hz));
    const per = Math.max(1, Math.floor(ch.length / total));
    const env = new Float32Array(total);
    let peak = 0;
    for (let i = 0; i < total; i += 1) {
      const start = i * per;
      const end = Math.min(ch.length, start + per);
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += ch[j] * ch[j];
      const rms = Math.sqrt(sum / Math.max(1, end - start));
      env[i] = rms;
      if (rms > peak) peak = rms;
    }
    if (peak > 0) for (let i = 0; i < total; i += 1) env[i] = Math.min(1, env[i] / peak);
    envelopeCache.set(key, env);
    saveEnvelope(key, env);
    return env;
  } catch {
    return null;
  }
}

// Resizable captions panel bounds (mirrors the OCR "Extracted text" panel).
// The side panel is the same across every file type, so the audio captions
// aside shares the media panel's width bounds + default exactly.
const CAPTIONS_MIN_WIDTH = HISTORY_MIN_WIDTH;
const CAPTIONS_MAX_WIDTH = HISTORY_MAX_WIDTH;
const CAPTIONS_DEFAULT_WIDTH = HISTORY_DEFAULT_WIDTH;

// Rebuild a done-state captions object from the per-file cache, or null.
function captionsFromCache(path) {
  const c = loadCaptions(path);
  return c
    ? { state: 'done', text: c.text, segments: c.segments || [], language: c.language || null, createdAt: c.createdAt }
    : null;
}

// Clock mm:ss for caption timestamps.
function fmtClock(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

// Auto-growing textarea for correcting a caption line — sizes to its content so
// long lines wrap without an inner scrollbar.
function CaptionEditor({ value, onChange, ariaLabel }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="dv-caption-edit"
      value={value}
      rows={1}
      aria-label={ariaLabel}
      placeholder="(no speech — type to add)"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// Shared AI-captions transcript panel — used by the audio player aside AND the
// video pane's "AI captions" tab. Owns its own transcription state + per-file
// cache; `currentTime`/`onSeek` come from whichever media element is playing.
// Renders the `.dv-ocr-history-*` chrome (same as the OCR "Extracted text"
// panel). `onCaptionsChange` (optional) lets a parent mirror the transcript —
// the audio pane uses it to drive its now-playing karaoke lyrics.
function CaptionsPanel({ file, url, currentTime, onSeek, onCaptionsChange }) {
  const [captions, setCaptions] = useState(() => captionsFromCache(file.storage_path));
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false); // edit transcript text to fix AI mistakes
  const listRef = useRef(null);

  useEffect(() => {
    setCaptions(captionsFromCache(file.storage_path));
    setCopied(false);
    setEditing(false);
  }, [url, file.storage_path]);

  // Mirror the transcript out to any parent that wants it (audio-pane lyrics).
  useEffect(() => { onCaptionsChange?.(captions); }, [captions, onCaptionsChange]);

  const generate = useCallback(async () => {
    setCaptions({ state: 'working' });
    try {
      const result = await transcribeAudio(url, file.mime_type, file.name);
      const createdAt = Date.now();
      // Cache the transcript per file so reopening it never re-spends tokens.
      saveCaptions(file.storage_path, {
        text: result.text, segments: result.segments, language: result.language, createdAt,
      });
      setCaptions({ state: 'done', text: result.text, segments: result.segments, language: result.language, createdAt });
    } catch (e) {
      setCaptions({ state: 'error', message: String(e?.message || e) });
    }
  }, [url, file.mime_type, file.name, file.storage_path]);

  const regenerate = useCallback(() => {
    clearCaptions(file.storage_path);
    setCopied(false);
    generate();
  }, [file.storage_path, generate]);

  const copyTranscript = async () => {
    if (captions?.state !== 'done') return;
    try {
      await navigator.clipboard.writeText(captions.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  // ── Manual edits (correct the AI's transcription) ───────────────────
  // Persist on every change so an edit survives reopening the file, just like a
  // freshly generated transcript. The onCaptionsChange effect mirrors edits to
  // the now-playing lyrics.
  const persistCaptions = useCallback((next) => {
    setCaptions(next);
    if (next?.state === 'done') {
      saveCaptions(file.storage_path, {
        text: next.text, segments: next.segments, language: next.language, createdAt: next.createdAt,
      });
    }
  }, [file.storage_path]);

  const editSegment = (i, value) => {
    if (captions?.state !== 'done') return;
    const segments = captions.segments.map((s, idx) => (idx === i ? { ...s, text: value } : s));
    const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
    persistCaptions({ ...captions, segments, text });
  };

  const editFullText = (value) => {
    if (captions?.state !== 'done') return;
    persistCaptions({ ...captions, text: value });
  };

  // Active caption line follows playback; auto-scrolled into view.
  const activeSegIndex = useMemo(() => {
    if (captions?.state !== 'done') return -1;
    return captions.segments.findIndex((s) => currentTime >= s.start && currentTime < s.end);
  }, [captions, currentTime]);

  useEffect(() => {
    if (activeSegIndex < 0) return;
    const line = listRef.current?.children?.[activeSegIndex];
    line?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeSegIndex]);

  return (
    <div className="dv-ocr-history-scroll">
      <header className="dv-ocr-history-head">
        <div className="dv-ocr-history-eyebrow">
          <span>Transcript</span>
          <span className="dv-ocr-history-eyebrow-muted">· from this file</span>
        </div>
        <h2 className="dv-ocr-history-title">AI captions</h2>
        <div className="dv-ocr-history-meta">
          <span className="dv-ocr-history-count">
            {captions?.state === 'done'
              ? (captions.segments.length > 0
                  ? <><strong>{captions.segments.length}</strong> {captions.segments.length === 1 ? 'line' : 'lines'}{captions.language ? ` · ${captions.language}` : ''}</>
                  : 'Transcript ready')
              : 'Not generated yet'}
          </span>
          {captions?.state === 'done' && (
            <div className="dv-audio-captions-acts">
              <button type="button" className="dv-ocr-history-clear" onClick={copyTranscript}>{copied ? 'Copied' : 'Copy'}</button>
              <button type="button" className="dv-ocr-history-clear" onClick={() => setEditing((v) => !v)}>{editing ? 'Done' : 'Edit'}</button>
              <button type="button" className="dv-ocr-history-clear" onClick={regenerate}>Regenerate</button>
            </div>
          )}
        </div>
      </header>

      {!captions ? (
        <div className="dv-audio-captions-empty">
          <p className="dv-ocr-history-empty">
            Transcribe the audio in this file with AI. The result is saved to this file, so reopening it won’t spend tokens again.
          </p>
          <button type="button" className="dv-chip dv-audio-captions-btn" onClick={generate}>
            {CaptionsGlyph}
            <span>Generate AI captions</span>
          </button>
        </div>
      ) : captions.state === 'working' ? (
        <div className="dv-audio-captions-status">
          <span className="dv-audio-captions-spinner" />
          Transcribing…
        </div>
      ) : captions.state === 'error' ? (
        <div className="dv-audio-captions-status is-error">
          <span>{captions.message}</span>
          <button type="button" className="dv-chip" onClick={generate}>Try again</button>
        </div>
      ) : captions.segments.length > 0 ? (
        <div className="dv-ocr-history-list" ref={listRef}>
          {captions.segments.map((seg, i) => (
            editing ? (
              <div
                key={i}
                className={`dv-ocr-history-item dv-audio-caption-row is-editing${i === activeSegIndex ? ' is-active' : ''}`}
              >
                <div className="dv-ocr-history-rail">
                  <span className="dv-ocr-history-node" />
                  <div className="dv-ocr-history-date">
                    <button
                      type="button"
                      className="dv-ocr-history-date-d dv-caption-seek"
                      onClick={() => onSeek(seg.start)}
                      title="Jump to this moment"
                    >
                      {fmtClock(seg.start)}
                    </button>
                  </div>
                </div>
                <div className="dv-ocr-history-content">
                  <CaptionEditor
                    value={seg.text}
                    onChange={(v) => editSegment(i, v)}
                    ariaLabel={`Caption at ${fmtClock(seg.start)}`}
                  />
                </div>
              </div>
            ) : (
              <button
                key={i}
                type="button"
                className={`dv-ocr-history-item dv-audio-caption-row${i === activeSegIndex ? ' is-active' : ''}`}
                onClick={() => onSeek(seg.start)}
              >
                <div className="dv-ocr-history-rail">
                  <span className="dv-ocr-history-node" />
                  <div className="dv-ocr-history-date">
                    <span className="dv-ocr-history-date-d">{fmtClock(seg.start)}</span>
                  </div>
                </div>
                <div className="dv-ocr-history-content">
                  <div className="dv-ocr-history-card">
                    <p className={`dv-ocr-history-text${seg.text ? '' : ' is-empty'}`}>{seg.text || ' '}</p>
                  </div>
                </div>
              </button>
            )
          ))}
        </div>
      ) : editing ? (
        <div className="dv-caption-fulledit">
          <CaptionEditor
            value={captions.text}
            onChange={editFullText}
            ariaLabel="Transcript"
          />
        </div>
      ) : (
        <p className="dv-ocr-history-empty">{captions.text || 'No speech detected in this file.'}</p>
      )}
    </div>
  );
}

// ── Shared loudness "decibel line" scrubber ──────────────────────────
// The video overlay renders this to match the audio pane's seek line: it
// decodes the media's loudness envelope (computeEnvelope demuxes the audio
// track of audio AND video URLs alike), paints it across the canvas as a
// mirrored waveform with the played portion in accent + a glowing playhead, and
// doubles as a seek control (click / drag / arrow keys). The parent owns the
// <audio>/<video> element and playback state; MediaScope only visualises and
// seeks via onSeek. Colours come from CSS — `color` is the played/playhead
// accent, `--text-muted` the unplayed base — so each host (.dv-audio-scope /
// .dv-player-scope) themes it. Mirrors AudioPlayerPane's inline scope.
// Seek-knob radius: resting size, and the expanded size on hover / scrubbing.
const KNOB_MIN = 4.5;
const KNOB_MAX = 8;

function MediaScope({ mediaRef, url, currentTime, duration, playing, onSeek, className = '', label = 'Seek' }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const envRef = useRef(null);   // Float32Array loudness envelope | null
  const ampCacheRef = useRef({ env: null, w: 0, amp: null }); // per-column peaks
  const draggingRef = useRef(false);
  const hoveringRef = useRef(false);
  // YouTube-style seek knob that grows on hover / while scrubbing. The radius is
  // eased on its own rAF (knobAnimRef) so it animates even while paused.
  const knobRRef = useRef(KNOB_MIN);
  const expandRef = useRef(false);
  const knobAnimRef = useRef(0);
  const playingRef = useRef(playing);
  const [envReady, setEnvReady] = useState(false);
  useEffect(() => { playingRef.current = playing; }, [playing]);

  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${mm}:${String(ss).padStart(2, '0')}`;
  };

  // Decode the loudness envelope the waveform reads from.
  useEffect(() => {
    envRef.current = null;
    ampCacheRef.current = { env: null, w: 0, amp: null };
    setEnvReady(false);
    if (!url) return undefined;
    let cancelled = false;
    computeEnvelope(url, AUDIO_SCOPE_HZ).then((env) => {
      if (cancelled) return;
      envRef.current = env;
      setEnvReady(true);
    });
    return () => { cancelled = true; };
  }, [url]);

  const effectiveDuration = () => {
    const m = mediaRef.current;
    if (m && Number.isFinite(m.duration) && m.duration > 0) return m.duration;
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  };

  const drawScope = useCallback((overrideRatio) => {
    const canvas = canvasRef.current;
    const ctx2d = canvas?.getContext('2d');
    if (!canvas || !ctx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 1;
    const hgt = canvas.clientHeight || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, hgt);

    const cs = getComputedStyle(canvas);
    const accent = cs.color || '#888';
    const baseCol = (cs.getPropertyValue('--text-muted') || '').trim() || accent;

    const env = envRef.current;
    const media = mediaRef.current;
    const dur2 = (media && Number.isFinite(media.duration) && media.duration > 0)
      ? media.duration
      : (Number.isFinite(duration) && duration > 0 ? duration : 0);
    let ratio;
    if (overrideRatio != null) ratio = Math.min(1, Math.max(0, overrideRatio));
    else if (media && dur2) ratio = Math.min(1, Math.max(0, (media.currentTime || 0) / dur2));
    else ratio = 0;
    const playheadX = ratio * w;

    const mid = hgt / 2;
    const maxAmp = hgt / 2 - 4;
    const cols = Math.max(2, Math.round(w));

    let amp = ampCacheRef.current.amp;
    if (!amp || ampCacheRef.current.env !== env || ampCacheRef.current.w !== w) {
      amp = new Array(cols + 1);
      for (let c = 0; c <= cols; c += 1) {
        if (!env || env.length === 0) { amp[c] = 0.03; continue; }
        const a0 = Math.floor((c / cols) * env.length);
        const a1 = Math.max(a0 + 1, Math.floor(((c + 1) / cols) * env.length));
        let peak = 0;
        for (let k = a0; k < a1 && k < env.length; k += 1) if (env[k] > peak) peak = env[k];
        amp[c] = Math.max(0.03, peak);
      }
      ampCacheRef.current = { env, w, amp };
    }

    const buildPath = () => {
      ctx2d.beginPath();
      for (let c = 0; c <= cols; c += 1) ctx2d.lineTo((c / cols) * w, mid - amp[c] * maxAmp);
      for (let c = cols; c >= 0; c -= 1) ctx2d.lineTo((c / cols) * w, mid + amp[c] * maxAmp);
      ctx2d.closePath();
    };

    buildPath();
    ctx2d.fillStyle = baseCol;
    ctx2d.globalAlpha = 0.3;
    ctx2d.fill();

    if (playheadX > 0) {
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.rect(0, 0, playheadX, hgt);
      ctx2d.clip();
      buildPath();
      ctx2d.fillStyle = accent;
      ctx2d.globalAlpha = 0.9;
      ctx2d.fill();
      ctx2d.restore();
    }
    ctx2d.globalAlpha = 1;

    if (dur2) {
      ctx2d.strokeStyle = accent;
      ctx2d.lineWidth = 2;
      ctx2d.lineCap = 'round';
      ctx2d.shadowColor = accent;
      ctx2d.shadowBlur = playing ? 12 : 0;
      ctx2d.beginPath();
      ctx2d.moveTo(playheadX, 5);
      ctx2d.lineTo(playheadX, hgt - 5);
      ctx2d.stroke();
      ctx2d.shadowBlur = 0;
      // Playhead knob — grows on hover / scrub (radius eased in knobRRef), with
      // a soft glow once enlarged.
      const knobR = knobRRef.current;
      ctx2d.fillStyle = accent;
      ctx2d.shadowColor = accent;
      ctx2d.shadowBlur = knobR > KNOB_MIN + 0.4 ? 10 : 0;
      ctx2d.beginPath();
      ctx2d.arc(playheadX, mid, knobR, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.shadowBlur = 0;
    }
  }, [duration, playing, mediaRef]);

  // Ease the knob radius toward its target on its own rAF — repaints itself
  // while paused; the play loop already repaints each frame while playing.
  const animateKnob = useCallback(() => {
    cancelAnimationFrame(knobAnimRef.current);
    const step = () => {
      const target = expandRef.current ? KNOB_MAX : KNOB_MIN;
      const cur = knobRRef.current;
      const next = cur + (target - cur) * 0.3;
      knobRRef.current = Math.abs(target - next) < 0.15 ? target : next;
      if (!playingRef.current) drawScope();
      if (knobRRef.current !== target) knobAnimRef.current = requestAnimationFrame(step);
    };
    knobAnimRef.current = requestAnimationFrame(step);
  }, [drawScope]);
  const setKnobExpanded = useCallback((on) => {
    if (expandRef.current === on) return;
    expandRef.current = on;
    animateKnob();
  }, [animateKnob]);

  const ratioFromClientX = (clientX) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };
  const seekToRatio = (ratio) => {
    const d = effectiveDuration();
    if (!d) return;
    onSeek?.(ratio * d);
    drawScope(ratio); // immediate feedback even while paused
  };
  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    canvasRef.current?.focus();
    draggingRef.current = true;
    setKnobExpanded(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    seekToRatio(ratioFromClientX(e.clientX));
  };
  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    seekToRatio(ratioFromClientX(e.clientX));
  };
  const endDrag = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    // Stay big only if the pointer is still hovering the scrubber.
    setKnobExpanded(hoveringRef.current);
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* unsupported */ }
  };
  const onPointerEnter = () => { hoveringRef.current = true; setKnobExpanded(true); };
  const onPointerLeave = () => { hoveringRef.current = false; if (!draggingRef.current) setKnobExpanded(false); };
  const onKeyDown = (e) => {
    const d = effectiveDuration();
    if (!d) return;
    const m = mediaRef.current;
    let t = m ? (m.currentTime || 0) : currentTime;
    if (e.key === 'ArrowRight') t = Math.min(d, t + 5);
    else if (e.key === 'ArrowLeft') t = Math.max(0, t - 5);
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = d;
    else return;
    e.preventDefault();
    onSeek?.(t);
    drawScope(t / d);
  };

  // rAF loop while playing.
  useEffect(() => {
    if (!playing) return undefined;
    const tick = () => { drawScope(); rafRef.current = requestAnimationFrame(tick); };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, drawScope]);

  // Resting repaint on source / envelope / time / size change (the rAF loop
  // owns the canvas while playing).
  useEffect(() => {
    if (playing) return undefined;
    const id = requestAnimationFrame(() => drawScope());
    return () => cancelAnimationFrame(id);
  }, [url, envReady, currentTime, duration, playing, drawScope]);

  // Repaint when the canvas is resized (e.g. window / pane resize).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { if (!playing) drawScope(); });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [playing, drawScope]);

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); cancelAnimationFrame(knobAnimRef.current); }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`dv-scope ${className}`.trim()}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Number.isFinite(duration) ? Math.round(duration) : 0}
      aria-valuenow={Math.round(currentTime)}
      aria-valuetext={`${fmt(currentTime)} of ${fmt(duration)}`}
      title="Click or drag to seek"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    />
  );
}

function AudioPlayerPane({ file, url, sidePanelSlot = null, sideTabsSlot = null }) {
  const audioRef = useRef(null);
  const scopeCanvasRef = useRef(null);
  const scopeRafRef = useRef(0);
  const lyricsRef = useRef(null); // karaoke lyric list (auto-scroll target)
  const envRef = useRef(null);   // Float32Array loudness envelope | null
  const ampCacheRef = useRef({ env: null, w: 0, amp: null }); // per-column peaks (recomputed on env/width change)
  const scopeDraggingRef = useRef(false); // pointer-drag scrubbing on the decibel line
  const [envReady, setEnvReady] = useState(false); // re-renders the resting waveform once decoded
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [captionsWidth, setCaptionsWidth] = useState(CAPTIONS_DEFAULT_WIDTH);
  // Shared side-panel tabs — audio supports AI captions, not text extraction.
  const [rightTab, setRightTab] = useState('captions');
  // Transcript mirrored from the side CaptionsPanel — drives the now-playing
  // karaoke lyrics over the controls. null until generated.
  const [lyrics, setLyrics] = useState(() => captionsFromCache(file.storage_path));

  useEffect(() => {
    setFailed(false);
    setPlaying(false);
    setCur(0);
    setDur(0);
    setLyrics(captionsFromCache(file.storage_path));
    cancelAnimationFrame(scopeRafRef.current);
    scopeRafRef.current = 0;
  }, [url, file.storage_path]);

  // Decode the loudness envelope that the "decibel line" waveform reads from.
  useEffect(() => {
    envRef.current = null;
    ampCacheRef.current = { env: null, w: 0, amp: null };
    setEnvReady(false);
    if (!url) return undefined;
    let cancelled = false;
    computeEnvelope(url, AUDIO_SCOPE_HZ).then((env) => {
      if (cancelled) return;
      envRef.current = env;
      setEnvReady(true);
    });
    return () => { cancelled = true; };
  }, [url]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {}); else a.pause();
  };
  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${mm}:${String(ss).padStart(2, '0')}`;
  };
  const toggleMute = () => {
    const a = audioRef.current;
    if (!a) return;
    a.muted = !a.muted;
    setMuted(a.muted);
  };
  const changeVolume = (e) => {
    const v = Number(e.target.value);
    setVolume(v);
    setMuted(v === 0);
    const a = audioRef.current;
    if (a) { a.muted = false; a.volume = v; }
  };
  const seekTo = (t) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = t;
    setCur(t);
  };

  // ── Decibel-line seeking ────────────────────────────────────────────
  // The loudness waveform doubles as a scrubber: click/drag anywhere to jump
  // to that point in the file (x position → time), with arrow-key fine control.
  const effectiveDuration = () => {
    const a = audioRef.current;
    if (a && Number.isFinite(a.duration) && a.duration > 0) return a.duration;
    return Number.isFinite(dur) && dur > 0 ? dur : 0;
  };
  const ratioFromClientX = (clientX) => {
    const canvas = scopeCanvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };
  const scopeSeekToRatio = (ratio) => {
    const duration = effectiveDuration();
    if (!duration) return;
    const t = ratio * duration;
    const a = audioRef.current;
    if (a) a.currentTime = t;
    setCur(t);
    drawScope(ratio); // immediate feedback even while paused
  };
  const onScopePointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    scopeCanvasRef.current?.focus();
    scopeDraggingRef.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    scopeSeekToRatio(ratioFromClientX(e.clientX));
  };
  const onScopePointerMove = (e) => {
    if (!scopeDraggingRef.current) return;
    scopeSeekToRatio(ratioFromClientX(e.clientX));
  };
  const endScopeDrag = (e) => {
    if (!scopeDraggingRef.current) return;
    scopeDraggingRef.current = false;
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* unsupported */ }
  };
  const onScopeKeyDown = (e) => {
    const duration = effectiveDuration();
    if (!duration) return;
    const a = audioRef.current;
    let t = a ? (a.currentTime || 0) : cur;
    if (e.key === 'ArrowRight') t = Math.min(duration, t + 5);
    else if (e.key === 'ArrowLeft') t = Math.max(0, t - 5);
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = duration;
    else return;
    e.preventDefault();
    if (a) a.currentTime = t;
    setCur(t);
    drawScope(t / duration);
  };

  // Drag handle resizing the captions panel (raw clientX deltas, 1:1).
  const beginCaptionsResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = captionsWidth;
    document.body.classList.add('dv-ocr-resizing');
    const onMove = (ev) => {
      const delta = startX - ev.clientX;
      setCaptionsWidth(Math.min(CAPTIONS_MAX_WIDTH, Math.max(CAPTIONS_MIN_WIDTH, startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dv-ocr-resizing');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── "Decibel line" waveform + scrubber ──────────────────────────────
  // Renders the whole file's loudness envelope as a static mirrored waveform
  // across the canvas width, with the played portion in accent and a playhead
  // marker at the current time. Doubles as a seek control (see the pointer/key
  // handlers above). `overrideRatio` lets the scrubber paint the new position
  // instantly while paused, before state/audio catch up.
  const drawScope = useCallback((overrideRatio) => {
    const canvas = scopeCanvasRef.current;
    const ctx2d = canvas?.getContext('2d');
    if (!canvas || !ctx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 1;
    const hgt = canvas.clientHeight || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, hgt);

    const cs = getComputedStyle(canvas);
    const accent = cs.color || '#888';
    const baseCol = (cs.getPropertyValue('--text-muted') || '').trim() || accent;

    const env = envRef.current;
    const audio = audioRef.current;
    const duration = (audio && Number.isFinite(audio.duration) && audio.duration > 0)
      ? audio.duration
      : (Number.isFinite(dur) && dur > 0 ? dur : 0);
    let ratio;
    if (overrideRatio != null) ratio = Math.min(1, Math.max(0, overrideRatio));
    else if (audio && duration) ratio = Math.min(1, Math.max(0, (audio.currentTime || 0) / duration));
    else ratio = 0;
    const playheadX = ratio * w;

    const mid = hgt / 2;
    const maxAmp = hgt / 2 - 4;
    const cols = Math.max(2, Math.round(w));

    // Per-column peak over the envelope range each pixel covers. Cached so a
    // playing track (60 fps) doesn't re-scan the whole envelope every frame —
    // only env identity or a width change invalidates it.
    let amp = ampCacheRef.current.amp;
    if (!amp || ampCacheRef.current.env !== env || ampCacheRef.current.w !== w) {
      amp = new Array(cols + 1);
      for (let c = 0; c <= cols; c += 1) {
        if (!env || env.length === 0) { amp[c] = 0.03; continue; }
        const a0 = Math.floor((c / cols) * env.length);
        const a1 = Math.max(a0 + 1, Math.floor(((c + 1) / cols) * env.length));
        let peak = 0;
        for (let k = a0; k < a1 && k < env.length; k += 1) if (env[k] > peak) peak = env[k];
        amp[c] = Math.max(0.03, peak); // floor so silence still draws a hairline
      }
      ampCacheRef.current = { env, w, amp };
    }

    const buildPath = () => {
      ctx2d.beginPath();
      for (let c = 0; c <= cols; c += 1) ctx2d.lineTo((c / cols) * w, mid - amp[c] * maxAmp);
      for (let c = cols; c >= 0; c -= 1) ctx2d.lineTo((c / cols) * w, mid + amp[c] * maxAmp);
      ctx2d.closePath();
    };

    // Full waveform (unplayed) in a muted tone.
    buildPath();
    ctx2d.fillStyle = baseCol;
    ctx2d.globalAlpha = 0.3;
    ctx2d.fill();

    // Played portion in accent, clipped to the left of the playhead.
    if (playheadX > 0) {
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.rect(0, 0, playheadX, hgt);
      ctx2d.clip();
      buildPath();
      ctx2d.fillStyle = accent;
      ctx2d.globalAlpha = 0.9;
      ctx2d.fill();
      ctx2d.restore();
    }
    ctx2d.globalAlpha = 1;

    // Playhead line + knob (glows while playing).
    if (duration) {
      ctx2d.strokeStyle = accent;
      ctx2d.lineWidth = 2;
      ctx2d.lineCap = 'round';
      ctx2d.shadowColor = accent;
      ctx2d.shadowBlur = playing ? 12 : 0;
      ctx2d.beginPath();
      ctx2d.moveTo(playheadX, 5);
      ctx2d.lineTo(playheadX, hgt - 5);
      ctx2d.stroke();
      ctx2d.shadowBlur = 0;
      ctx2d.fillStyle = accent;
      ctx2d.beginPath();
      ctx2d.arc(playheadX, mid, 4.5, 0, Math.PI * 2);
      ctx2d.fill();
    }
  }, [dur, playing]);

  const startScope = useCallback(() => {
    cancelAnimationFrame(scopeRafRef.current);
    const tick = () => {
      drawScope();
      scopeRafRef.current = requestAnimationFrame(tick);
    };
    scopeRafRef.current = requestAnimationFrame(tick);
  }, [drawScope]);

  const stopScope = useCallback(() => {
    cancelAnimationFrame(scopeRafRef.current);
    scopeRafRef.current = 0;
    drawScope(); // final paint at the paused position
  }, [drawScope]);

  // Repaint the resting waveform on track change / seek / resize / envelope
  // arrival. Skipped while playing — the rAF loop owns the canvas then.
  useEffect(() => {
    if (playing) return undefined;
    const id = requestAnimationFrame(() => drawScope());
    return () => cancelAnimationFrame(id);
  }, [url, envReady, cur, dur, captionsWidth, playing, drawScope]);

  useEffect(() => () => cancelAnimationFrame(scopeRafRef.current), []);

  // ── Now-playing karaoke lyrics ──────────────────────────────────────
  const hasLyrics = lyrics?.state === 'done' && lyrics.segments.length > 0;
  const activeLyricIndex = useMemo(() => {
    if (!hasLyrics) return -1;
    return lyrics.segments.findIndex((s) => cur >= s.start && cur < s.end);
  }, [hasLyrics, lyrics, cur]);

  // Keep the active line centred as playback advances (mirrors the YT-Music
  // lyrics view).
  useEffect(() => {
    if (activeLyricIndex < 0) return;
    const el = lyricsRef.current?.children?.[activeLyricIndex];
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeLyricIndex]);

  if (failed) {
    return (
      <div className="dv-noview">
        <p className="dv-noview-title">Couldn't play this audio file</p>
        <p className="dv-noview-sub">{file.name}</p>
        <button type="button" className="dv-chip" onClick={() => localFolderApi.openPath(file.storage_path)}>
          Open in default app
        </button>
      </div>
    );
  }

  return (
    <div className="dv-audio-layout">
      <div className={`dv-audio-pane${hasLyrics ? ' has-lyrics' : ''}`}>
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => { setPlaying(true); startScope(); }}
          onPause={() => { setPlaying(false); stopScope(); }}
          onEnded={() => { setPlaying(false); setCur(0); stopScope(); }}
          onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => { setDur(e.currentTarget.duration); e.currentTarget.volume = volume; }}
          onDurationChange={(e) => setDur(e.currentTarget.duration)}
          onError={() => setFailed(true)}
        />
        {hasLyrics && (
          <div className="dv-audio-lyrics" ref={lyricsRef}>
            {lyrics.segments.map((seg, i) => (
              <button
                key={i}
                type="button"
                className={`dv-lyric-line${seg.text ? '' : ' is-empty'}${i === activeLyricIndex ? ' is-active' : ''}${i < activeLyricIndex ? ' is-past' : ''}`}
                onClick={() => seekTo(seg.start)}
                title={fmt(seg.start)}
              >
                {seg.text || '♪'}
              </button>
            ))}
          </div>
        )}
        <div className="dv-audio-deck">
          <button type="button" className="dv-audio-playbtn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? PauseGlyph : PlayGlyph}
          </button>
        </div>
        <div className="dv-audio-volume">
          <button type="button" className="dv-audio-volume-btn" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted || volume === 0 ? VolumeMuteGlyph : VolumeHighGlyph}
          </button>
          <input
            type="range"
            className="dv-audio-volume-slider"
            min="0"
            max="1"
            step="0.01"
            value={muted ? 0 : volume}
            onChange={changeVolume}
            aria-label="Volume"
          />
        </div>
        <canvas
          ref={scopeCanvasRef}
          className="dv-audio-scope"
          role="slider"
          tabIndex={0}
          aria-label="Seek through audio"
          aria-valuemin={0}
          aria-valuemax={Number.isFinite(dur) ? Math.round(dur) : 0}
          aria-valuenow={Math.round(cur)}
          aria-valuetext={`${fmt(cur)} of ${fmt(dur)}`}
          title="Click or drag to seek"
          onPointerDown={onScopePointerDown}
          onPointerMove={onScopePointerMove}
          onPointerUp={endScopeDrag}
          onPointerCancel={endScopeDrag}
          onKeyDown={onScopeKeyDown}
        />
      </div>

      {(() => {
      const sidePanel = (
      <aside className={`dv-ocr-history dv-audio-captions-aside${sidePanelSlot ? ' dv-side-portal' : ''}`} style={sidePanelSlot ? undefined : { width: `${captionsWidth}px` }}>
        {/* Audio gets AI captions + AI advisor (no text extraction). */}
        <SidePanelTabs tabs={sideTabsForKind('audio')} active={rightTab} onChange={setRightTab} slot={sideTabsSlot} />
        {rightTab === 'advisor' ? (
          <AdvisorPanel file={file} />
        ) : rightTab === 'extract' ? (
          <div className="dv-ocr-history-scroll"><p className="dv-ocr-history-empty">Text extraction isn’t available for audio files.</p></div>
        ) : (
          <CaptionsPanel file={file} url={url} currentTime={cur} onSeek={seekTo} onCaptionsChange={setLyrics} />
        )}
      </aside>
      );
      return sidePanelSlot
        ? createPortal(sidePanel, sidePanelSlot)
        : (<><div className="dv-ocr-resize" onMouseDown={beginCaptionsResize} role="separator" aria-orientation="vertical" aria-label="Resize captions panel" />{sidePanel}</>);
      })()}
    </div>
  );
}

// Excel-style column label for a 0-based index (0 → A, 25 → Z, 26 → AA…).
function colLabel(n) {
  let s = '';
  let i = n + 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

// Cap on rendered rows — a huge sheet would otherwise build a multi-thousand-row
// DOM table and stall the viewer. The rest stays in the file (open externally).
const SHEET_MAX_ROWS = 2000;

// Spreadsheet pane — renders .xlsx / .xls / .csv as a styled, scrollable table
// with sticky A/B/C column headers + 1/2/3 row numbers (and a tab strip when the
// workbook has multiple sheets). SheetJS is lazy-imported so its weight isn't
// paid until a spreadsheet is opened (mirrors docx-preview for .docx).
function SpreadsheetPane({ file, url }) {
  const [state, setState] = useState({ status: 'loading', sheets: [], error: null });
  const [active, setActive] = useState(0);

  useEffect(() => {
    setState({ status: 'loading', sheets: [], error: null });
    setActive(0);
    if (!url) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const XLSX = await import('xlsx');
        if (cancelled) return;
        const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
        const sheets = wb.SheetNames.map((name) => {
          // header:1 → rows of cell arrays; raw:false → number/date formats applied.
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '', raw: false });
          return { name, rows };
        });
        setState({ status: sheets.length ? 'ready' : 'empty', sheets, error: null });
      } catch (e) {
        if (!cancelled) setState({ status: 'error', sheets: [], error: String(e?.message || e) });
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  if (state.status === 'loading') return <div className="dv-loading">Reading spreadsheet…</div>;
  if (state.status === 'error') {
    return (
      <div className="dv-noview">
        <p className="dv-noview-title">Couldn't read this spreadsheet</p>
        <p className="dv-noview-sub">{file.name}</p>
        <button type="button" className="dv-chip" onClick={() => localFolderApi.openPath(file.storage_path)}>
          Open in default app
        </button>
      </div>
    );
  }
  if (state.status === 'empty') {
    return (
      <div className="dv-noview">
        <p className="dv-noview-title">This spreadsheet is empty</p>
        <p className="dv-noview-sub">{file.name}</p>
      </div>
    );
  }

  const sheet = state.sheets[active] || state.sheets[0];
  const allRows = sheet.rows;
  const rows = allRows.slice(0, SHEET_MAX_ROWS);
  const truncated = allRows.length - rows.length;
  const colCount = rows.reduce((mx, r) => Math.max(mx, r.length), 0);
  const cols = Array.from({ length: colCount });

  return (
    <div className="dv-sheet">
      {state.sheets.length > 1 && (
        <div className="dv-sheet-tabs" role="tablist">
          {state.sheets.map((s, i) => (
            <button
              key={`${s.name}-${i}`}
              type="button"
              role="tab"
              className={`dv-sheet-tab${i === active ? ' is-active' : ''}`}
              aria-selected={i === active}
              onClick={() => setActive(i)}
            >
              {s.name || `Sheet ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      <div className="dv-sheet-scroll">
        <table className="dv-sheet-table">
          <thead>
            <tr>
              <th className="dv-sheet-corner" />
              {cols.map((_, c) => <th key={c} className="dv-sheet-colhead">{colLabel(c)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <th className="dv-sheet-rowhead">{r + 1}</th>
                {cols.map((_, c) => {
                  const v = row[c];
                  return <td key={c}>{v == null ? '' : String(v)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated > 0 && (
        <div className="dv-sheet-note">
          Showing the first {SHEET_MAX_ROWS.toLocaleString()} rows of {allRows.length.toLocaleString()} — open the file in its app to see the rest.
        </div>
      )}
    </div>
  );
}

// Shared right-hand panel for document file types (PDF / Word / Excel / text /
// legacy .doc / other). Same chrome as the photo/video OCR panel, but instead
// of a lasso it offers a one-click whole-document text extraction
// (lib/extractFileText, or the main-process parser for legacy .doc) saved into
// the SAME per-file history store — so every file type has a consistent panel.
function DocExtractPanel({ file, url, kind, width, fill = false, sideTabsSlot = null }) {
  const [history, setHistory] = useState(() => loadOcrHistory(file.storage_path));
  const [working, setWorking] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  // Documents only get the AI advisor (text extraction is images/video only).
  const [rightTab, setRightTab] = useState('advisor');

  useEffect(() => { setHistory(loadOcrHistory(file.storage_path)); }, [file.storage_path]);
  useEffect(() => { saveOcrHistory(file.storage_path, history); }, [file.storage_path, history]);

  const extractable = kind !== 'other';

  const runExtract = useCallback(async () => {
    setWorking(true);
    setErrorMsg(null);
    try {
      let text = '';
      if (kind === 'doc') {
        const res = await extractDocText(file.storage_path);
        if (res?.error) throw new Error(res.error === 'unsupported' ? 'This file type can’t be read as text.' : res.error);
        text = res?.text || '';
      } else {
        const blob = await (await fetch(url)).blob();
        const res = await extractFileText(blob, file.name);
        if (res?.error) {
          throw new Error(res.error === 'unsupported'
            ? 'This file type can’t be read as text.'
            : res.error === 'empty' ? 'No readable text found in this file.' : res.error);
        }
        text = res.text || '';
      }
      if (!text.trim()) { setErrorMsg('No readable text found in this file.'); return; }
      const entry = { id: `doc-${Date.now()}-${Math.round(Math.random() * 1e6)}`, text: text.trim(), createdAt: Date.now() };
      setHistory((h) => [entry, ...h]);
    } catch (e) {
      setErrorMsg(String(e?.message || e));
    } finally {
      setWorking(false);
    }
  }, [kind, url, file.name, file.storage_path]);

  const copyEntry = async (entry) => {
    try {
      await navigator.clipboard.writeText(entry.text || '');
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId((c) => (c === entry.id ? null : c)), 1500);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <aside className={`dv-ocr-history dv-doc-extract${fill ? ' dv-side-portal' : ''}`} style={fill ? undefined : { width: `${width}px` }}>
      <SidePanelTabs tabs={sideTabsForKind(kind)} active={rightTab} onChange={setRightTab} slot={sideTabsSlot} />
      {rightTab === 'advisor' ? (
        <AdvisorPanel file={file} />
      ) : rightTab === 'captions' ? (
        <CaptionsPanel file={file} url={url} currentTime={0} onSeek={() => {}} onCaptionsChange={() => {}} />
      ) : (
      <>
      <div className="dv-doc-extract-bar">
        <button type="button" className="dv-doc-extract-btn" onClick={runExtract} disabled={working || !extractable}>
          {ScanTextGlyph}
          <span>{working ? 'Extracting…' : 'Extract text'}</span>
        </button>
      </div>
      {errorMsg && (
        <div className="dv-ocr-error dv-doc-extract-error" role="alert">
          <span>{errorMsg}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setErrorMsg(null)}>×</button>
        </div>
      )}
      <div className="dv-ocr-history-scroll">
        <header className="dv-ocr-history-head">
          <div className="dv-ocr-history-eyebrow">
            <span>Snippets</span>
            <span className="dv-ocr-history-eyebrow-muted">· from this file</span>
          </div>
          <h2 className="dv-ocr-history-title">Extracted text</h2>
          <div className="dv-ocr-history-meta">
            <span className="dv-ocr-history-count">
              {history.length > 0
                ? <><strong>{history.length}</strong> {history.length === 1 ? 'snippet' : 'snippets'}</>
                : 'No snippets yet'}
            </span>
            {history.length > 0 && (
              <button type="button" className="dv-ocr-history-clear" onClick={() => setHistory([])}>Clear all</button>
            )}
          </div>
        </header>
        {history.length === 0 ? (
          <p className="dv-ocr-history-empty">
            {extractable
              ? 'Click “Extract text” to read this document’s text. It’s saved here for next time you open the file.'
              : 'This file type can’t be read as text.'}
          </p>
        ) : (
          <div className="dv-ocr-history-list">
            {[...history].reverse().map((entry) => {
              const { date, time } = formatHistoryTimestamp(entry.createdAt);
              return (
                <div key={entry.id} className="dv-ocr-history-item">
                  <div className="dv-ocr-history-rail">
                    <span className="dv-ocr-history-node" />
                    <div className="dv-ocr-history-date">
                      <span className="dv-ocr-history-date-d">{date}</span>
                      <span className="dv-ocr-history-date-t">{time}</span>
                    </div>
                  </div>
                  <div className="dv-ocr-history-content">
                    <div className="dv-ocr-history-card">
                      <p className={`dv-ocr-history-text${entry.text ? '' : ' is-empty'}`}>
                        {entry.text || 'No text found.'}
                      </p>
                      <div className="dv-ocr-history-actions">
                        {entry.text && (
                          <button type="button" className="dv-ocr-history-act" onClick={() => copyEntry(entry)}>
                            {copiedId === entry.id ? 'Copied' : 'Copy'}
                          </button>
                        )}
                        <button type="button" className="dv-ocr-history-remove" aria-label="Remove" onClick={() => setHistory((prev) => prev.filter((e) => e.id !== entry.id))}>×</button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </>
      )}
    </aside>
  );
}

// Lays out a document preview. Its side panel (just the AI advisor for plain
// documents — extraction/captions are media-only) portals into the right card.
function DocumentWithPanel({ file, url, kind, mainClass = '', sidePanelSlot = null, sideTabsSlot = null, children }) {
  return (
    <>
      <div className={`dv-doc-main ${mainClass}`.trim()}>{children}</div>
      {sidePanelSlot && createPortal(
        <DocExtractPanel file={file} url={url} kind={kind} sideTabsSlot={sideTabsSlot} fill />,
        sidePanelSlot,
      )}
    </>
  );
}

function DocPane({ file, onWhatsAppDetected, sidePanelSlot = null, sideTabsSlot = null }) {
  const { kind, mime } = useMemo(() => classify(file.mime, file.name), [file.mime, file.name]);
  const url = useMemo(() => localUrlFor(file.path), [file.path]);
  // Folder holding this file — a WhatsApp export's media siblings live here.
  const { dir, sep } = useMemo(() => dirAndSep(file.path), [file.path]);
  const docxRef = useRef(null);
  // Legacy .doc extracted text: null = loading, string = body, '' = empty.
  const [docText, setDocText] = useState(null);
  const [docErr, setDocErr] = useState(null);

  const previewFile = useMemo(
    () => ({ name: file.name, mime_type: mime, storage_path: file.path, size_bytes: 0 }),
    [file.name, mime, file.path],
  );

  useEffect(() => {
    if (kind !== 'docx' || !url) return undefined;
    let cancelled = false;
    const host = docxRef.current;
    if (!host) return undefined;
    (async () => {
      try {
        const blob = await (await fetch(url)).blob();
        const { renderAsync } = await import('docx-preview');
        if (cancelled) return;
        host.innerHTML = '';
        await renderAsync(blob, host, undefined, {
          className: 'docx', inWrapper: true, breakPages: true,
          ignoreLastRenderedPageBreak: true, experimental: true, useBase64URL: true,
        });
      } catch {
        if (!cancelled && host) host.innerHTML = `<p class="dv-docx-error">Couldn't display the document.</p>`;
      }
    })();
    return () => { cancelled = true; };
  }, [kind, url]);

  // Extract text from a legacy .doc (binary parsed in the main process).
  useEffect(() => {
    if (kind !== 'doc') return undefined;
    let cancelled = false;
    setDocText(null);
    setDocErr(null);
    extractDocText(file.path)
      .then((res) => { if (!cancelled) { if (res?.error) setDocErr(res.error); else setDocText(res?.text || ''); } })
      .catch((e) => { if (!cancelled) setDocErr(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, [kind, file.path]);

  // image/video keep their integrated OCR pane; audio keeps its captions pane.
  // Every OTHER type renders inside the shared split (preview + Extract-text
  // panel) so the right panel is consistent and present for all file types.
  const isMedia = kind === 'image' || kind === 'video';
  const isAudio = kind === 'audio';
  const isSplit = !isMedia && !isAudio;

  const bodyClass = isMedia ? 'dv-doc-body is-media'
    : isAudio ? 'dv-doc-body is-audio'
    : 'dv-doc-body is-split';

  // Flush (fills, no padding) for the panes that manage their own scroll;
  // padded block for the document renderers (matches the old body padding).
  const mainClass = kind === 'text' || kind === 'sheet' ? 'is-flush' : '';

  let content;
  if (kind === 'docx') {
    content = <div ref={docxRef} className="dv-docx" />;
  } else if (kind === 'doc') {
    content = (docErr || docText === '') ? (
      <div className="dv-noview">
        <p className="dv-noview-title">{docErr ? "Couldn't read the .doc document" : 'The document has no text'}</p>
        <p className="dv-noview-sub">{file.name}</p>
        <button type="button" className="dv-chip" onClick={() => localFolderApi.openPath(file.path)}>Open in default app</button>
      </div>
    ) : docText === null ? (
      <div className="dv-loading">Reading document…</div>
    ) : (
      <div className="dv-text-doc">
        {docText.split(/\n/).map((line, i) => <p key={i}>{line || ' '}</p>)}
      </div>
    );
  } else if (kind === 'sheet') {
    content = <SpreadsheetPane file={previewFile} url={url} />;
  } else if (kind === 'text') {
    content = <DocTextPane file={previewFile} url={url} dir={dir} sep={sep} onWhatsAppDetected={onWhatsAppDetected} />;
  } else if (kind === 'other') {
    content = (
      <div className="dv-noview">
        <p className="dv-noview-title">This file type can't be previewed</p>
        <p className="dv-noview-sub">{file.name}</p>
        <button type="button" className="dv-chip" onClick={() => localFolderApi.openPath(file.path)}>Open in default app</button>
      </div>
    );
  } else {
    content = <FilePreview file={previewFile} signedUrl={url} onOpen={null} />;
  }

  return (
    <div className={bodyClass}>
      {isMedia ? (
        <MediaOcrPane file={{ ...previewFile, path: file.path }} url={url} kind={kind} sidePanelSlot={sidePanelSlot} sideTabsSlot={sideTabsSlot} />
      ) : isAudio ? (
        <AudioPlayerPane file={previewFile} url={url} sidePanelSlot={sidePanelSlot} sideTabsSlot={sideTabsSlot} />
      ) : (
        <DocumentWithPanel file={previewFile} url={url} kind={kind} mainClass={mainClass} sidePanelSlot={sidePanelSlot} sideTabsSlot={sideTabsSlot}>
          {content}
        </DocumentWithPanel>
      )}
    </div>
  );
}

// Custom vertical scrollbar for the tabs sidebar — lives OUTSIDE the scroll
// view (a sibling overlaid in the right gutter) so the native bar can be
// hidden. Tracks the scroller's metrics and drives scrollTop on drag / track
// click. `refreshKey` recomputes the thumb when the tab list changes height.
function SidebarScrollbar({ scrollRef, refreshKey }) {
  const [thumb, setThumb] = useState(null); // { top, height } in %, or null when no overflow

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 1) { setThumb(null); return; }
    setThumb({
      top: (scrollTop / scrollHeight) * 100,
      height: (clientHeight / scrollHeight) * 100,
    });
  }, [scrollRef]);

  useLayoutEffect(() => { recompute(); }, [recompute, refreshKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    el.addEventListener('scroll', recompute, { passive: true });
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(recompute);
      ro.observe(el);
      // Also watch the content child so the thumb updates when the scrollHeight
      // grows (e.g. chat "Show earlier") — observing only `el` misses that, since
      // the scroller's own box size doesn't change.
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    return () => { el.removeEventListener('scroll', recompute); ro?.disconnect(); };
  }, [recompute, scrollRef]);

  // Drag the thumb → scroll proportionally (thumb travel maps to scroll range).
  const onThumbDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = scrollRef.current;
    const track = e.currentTarget.parentElement;
    if (!el || !track) return;
    const startY = e.clientY;
    const startScroll = el.scrollTop;
    const trackH = track.clientHeight;
    const thumbH = (el.clientHeight / el.scrollHeight) * trackH;
    const maxTravel = Math.max(1, trackH - thumbH);
    const maxScroll = el.scrollHeight - el.clientHeight;
    const ratio = maxScroll / maxTravel;
    const onMove = (ev) => { el.scrollTop = startScroll + (ev.clientY - startY) * ratio; };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Click the track (not the thumb) → page the view so the thumb centres there.
  const onTrackDown = (e) => {
    const el = scrollRef.current;
    if (!el || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const target = ratio * el.scrollHeight - el.clientHeight / 2;
    el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, target));
  };

  if (!thumb) return null;
  return (
    <div className="dv-tabbar-scroll" onMouseDown={onTrackDown}>
      <div
        className="dv-tabbar-thumb"
        style={{ top: `${thumb.top}%`, height: `${thumb.height}%` }}
        onMouseDown={onThumbDown}
      />
    </div>
  );
}

// Small / large square markers flanking the Open-files icon-size slider.
const SmallTileGlyph = (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="8" y="8" width="8" height="8" rx="1.5" /></svg>
);
const LargeTileGlyph = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
);
// Refresh glyph mirroring the main app's pane-chrome refresh button (SplitView).
const DvRefreshGlyph = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
);

// Pane chrome IDENTICAL to the main app's SplitView pane chrome: a refresh
// button + title + "· description" on the left and a destination dropdown (the
// open-documents picker) on the right. `extra` renders just left of the
// dropdown (e.g. the Recently-open icon-size slider); `row2Ref` is a portal
// target where an embedded page's toolbar renders as a merged 2nd row.
// `tabsRef` is a portal target inside the topbar — a pane portals its side-panel
// tab strip (Text extraction / AI captions / AI advisor) into it, so the tabs
// live IN the chrome instead of as a separate row below it. When set, the tabs
// take the row (the title/description are dropped).
function DvChrome({ title, desc = null, onRefresh = null, extra = null, row2Ref = null, tabsRef = null }) {
  return (
    <div className="dv-chrome">
      <div className={`dv-chrome-row${tabsRef ? ' dv-chrome-row--tabs' : ''}`}>
        {onRefresh && (
          <Tooltip content="Refresh"><button type="button" className="dv-chrome-refresh" onClick={() => onRefresh()} aria-label="Refresh">{DvRefreshGlyph}</button></Tooltip>
        )}
        {tabsRef ? (
          <div className="dv-chrome-tabs" ref={tabsRef} />
        ) : (
          <>
            <div className="dv-chrome-head">
              <span className="dv-chrome-title">{title}</span>
              {desc && <span className="dv-chrome-dot" aria-hidden="true">·</span>}
              {desc && <span className="dv-chrome-desc">{desc}</span>}
            </div>
            <div className="dv-chrome-spacer" />
            {extra}
          </>
        )}
      </div>
      {row2Ref && <div className="dv-chrome-row2" ref={row2Ref} />}
    </div>
  );
}

// Files card — wraps the embedded Files browser in a PaneChromeProvider so its
// toolbar (folder nav + breadcrumb + search) portals up into the chrome's 2nd
// row, exactly like the main app (one merged bar instead of a separate pathbar).
// The chrome refresh (left of the title) re-lists the embedded browser.
function DvFilesCard() {
  const setPortalEl = usePaneChromePortalRef();
  return (
    <div className="dv-files-browse">
      <DvChrome title="Files" onRefresh={() => notifyFilesChanged()} row2Ref={setPortalEl} />
      <div className="dv-files-browse-body"><ProjectFiles embedded /></div>
    </div>
  );
}

// ── Tabbed viewer ───────────────────────────────────────────────────────
export default function DocViewer() {
  const [params] = useSearchParams();

  // Files browser footer is resizable: a horizontal handle at its top edge.
  const [footerHeight, setFooterHeight] = useState(340);
  const beginFooterResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = footerHeight;
    document.body.classList.add('dv-row-resizing');
    const onMove = (ev) => {
      const next = startH + toLayoutPx(startY - ev.clientY);
      const cap = Math.max(200, window.innerHeight - 220);
      setFooterHeight(Math.min(cap, Math.max(160, next)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dv-row-resizing');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Recently-open column (full-height, left of everything): a scrollable column
  // of file tiles, at a fixed persisted width.
  const RAIL_MIN = 150;
  const RAIL_MAX = 460;
  const railScrollRef = useRef(null);
  const [railW] = useState(() => {
    const w = readDvLayout().railW;
    return typeof w === 'number' ? Math.min(RAIL_MAX, Math.max(RAIL_MIN, w)) : 230;
  });

  // The right card is a slot: each file's pane portals its tabbed side panel
  // (Text extraction / AI captions / AI advisor) into it. Width persisted.
  const [sidePanelSlot, setSidePanelSlot] = useState(null);
  // Slot inside the Multitool topbar where the active pane portals its side-panel
  // tab strip (Text extraction / AI captions / AI advisor).
  const [sideTabsSlot, setSideTabsSlot] = useState(null);
  const ADVISOR_MIN = 240;
  const ADVISOR_MAX = 960;
  const [advisorW, setAdvisorW] = useState(() => {
    const w = readDvLayout().advisorW;
    return typeof w === 'number' ? Math.min(ADVISOR_MAX, Math.max(ADVISOR_MIN, w)) : 360;
  });
  const beginAdvisorResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = advisorW;
    let lastW = startW;
    document.body.classList.add('dv-ocr-resizing');
    const onMove = (ev) => {
      lastW = Math.min(ADVISOR_MAX, Math.max(ADVISOR_MIN, startW + toLayoutPx(startX - ev.clientX)));
      setAdvisorW(lastW);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dv-ocr-resizing');
      writeDvLayout({ advisorW: lastW });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Tabs are keyed by the file's on-disk path (re-opening the same file just
  // re-activates its tab). The first tab comes from the boot query string.
  const [tabs, setTabs] = useState(() => {
    const path = params.get('path');
    if (!path) return [];
    return [{ id: path, path, name: params.get('name') || 'Document', mime: params.get('mime') || '' }];
  });
  const [activeId, setActiveId] = useState(() => params.get('path') || null);

  // Subsequent double-clicks in the Files page push files here → new tabs. The
  // just-opened file goes to the FRONT of the list (most-recently-opened first);
  // an already-open file is moved to the front, keeping its tab object (so any
  // rename is preserved).
  useEffect(() => onDocViewerAddFile((file) => {
    if (!file?.path) return;
    const id = file.path;
    setTabs((prev) => {
      const existing = prev.find((t) => t.id === id);
      const rest = prev.filter((t) => t.id !== id);
      const entry = existing || { id, path: file.path, name: file.name || 'Document', mime: file.mime || '' };
      return [entry, ...rest];
    });
    setActiveId(id);
  }), []);

  // A Files tab just trashed/deleted file(s) — close any tab showing one. A
  // folder delete arrives as the folder path, so also close tabs inside it.
  // Closing the last surviving tab closes the window (matches closeTab).
  useEffect(() => onFilesRemoved((paths) => {
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const removed = (Array.isArray(paths) ? paths : [paths]).map(norm).filter(Boolean);
    if (removed.length === 0) return;
    const isGone = (p) => { const t = norm(p); return removed.some((r) => t === r || t.startsWith(`${r}/`)); };
    setTabs((prev) => {
      const next = prev.filter((t) => !isGone(t.path));
      if (next.length === prev.length) return prev;
      if (next.length === 0) {
        setTimeout(() => { try { window.close(); } catch { /* noop */ } }, 0);
        return next;
      }
      setActiveId((cur) => (next.some((t) => t.id === cur) ? cur : next[next.length - 1].id));
      return next;
    });
  }), []);

  // Rename the file behind a tab on disk, then re-key the tab to its new path
  // (the tab id IS the path). Keeps the old name on failure (silent — the
  // inline input simply reverts to the existing name).
  const renameTab = useCallback(async (tab, newName) => {
    const { dir, sep } = dirAndSep(tab.path);
    if (!dir || !newName || newName === tab.name) return;
    const res = await localFolderApi.renameFile({ dir, fromName: tab.name, toName: newName });
    if (!res || res.error) return;
    const newPath = `${dir}${sep}${newName}`;
    setTabs((prev) => prev.map((t) => (t.id === tab.id
      ? { ...t, id: newPath, path: newPath, name: newName }
      : t)));
    setActiveId((cur) => (cur === tab.id ? newPath : cur));
    // Propagate the rename to every Files tab (the doc-viewer's own embedded
    // one + the main window) so their listings show the new name.
    notifyFilesChanged();
  }, []);

  const closeTab = (id) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        // Closing the last tab closes the window.
        setTimeout(() => { try { window.close(); } catch { /* noop */ } }, 0);
        return next;
      }
      if (id === activeId) {
        const fallback = next[Math.min(idx, next.length - 1)];
        setActiveId(fallback.id);
      }
      return next;
    });
  };

  // Activate a tab — used when clicking a Recently-open tile. Selection only;
  // the list order is left untouched (clicking a tile no longer rearranges it).
  const activateTab = useCallback((id) => {
    setActiveId(id);
  }, []);

  // Tabs whose content parsed as a WhatsApp conversation (reported by the
  // text pane) — their sidebar tiles show the WhatsApp mark.
  const [waTabs, setWaTabs] = useState(() => new Set());
  const markActiveWhatsApp = useCallback((id) => {
    setWaTabs((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  // Bumped to remount (reload) the active document pane — drives the chrome
  // refresh buttons on the Documents / Multitool cards.
  const [reloadKey, setReloadKey] = useState(0);
  const reloadActive = useCallback(() => setReloadKey((k) => k + 1), []);

  const active = tabs.find((t) => t.id === activeId) || tabs[0] || null;

  if (!active) return <div className="dv-page dv-page-empty">No file to display.</div>;

  return (
    <div className="dv-page">
      <CursorSpotlight contain className="dv-cursor-spotlight" />

      {/* Body: the full-height "Recently open" column on the left, then the
          right column (Documents + Multitool on top, Files browser below). */}
      <div className="dv-body-row">
        {/* Open-file tiles — a bare full-height column (no section chrome); each
            tile is a Files-page-style item; clicking one makes it active. */}
        <div className="dv-files-recent">
          <div className="dv-files-recent-list">
            <div className="dv-files-recent-scroll" ref={railScrollRef}>
              {tabs.map((t) => (
                <FileTabItem
                  key={t.id}
                  tab={t}
                  isActive={t.id === activeId}
                  isWhatsApp={waTabs.has(t.id)}
                  onActivate={() => activateTab(t.id)}
                  onClose={() => closeTab(t.id)}
                  onRename={renameTab}
                />
              ))}
            </div>
            <SidebarScrollbar scrollRef={railScrollRef} refreshKey={tabs.length} />
          </div>
        </div>

        {/* Right column — Documents + Multitool on top, Files browser below. */}
        <div className="dv-right-col">
          {/* Main row: the document card + the Multitool card side by side. */}
          <div className="dv-main-row">
            {/* Document card — "Documents" chrome + the active file's body. */}
            <div className="dv-doc-card">
              <DvChrome title="Documents" desc={active?.name} onRefresh={reloadActive} />
              <div className="dv-section-body">
                <div className="dv-section-pane dv-doc">
                  {/* Remount per active tab (keyed, + reloadKey so the chrome
                      refresh reloads it). Its side panel (Text extraction / AI
                      captions / AI advisor) portals into the Multitool card. */}
                  <DocPane key={`${active.id}:${reloadKey}`} file={active} sidePanelSlot={sidePanelSlot} sideTabsSlot={sideTabsSlot} onWhatsAppDetected={() => markActiveWhatsApp(active.id)} />
                </div>
              </div>
            </div>

            {/* Draggable gutter between the document and the side panel. */}
            <div
              className="dv-advisor-resize"
              onMouseDown={beginAdvisorResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize side panel"
            />

            {/* Multitool card — hosts the active file's tabbed side panel,
                portalled into the slot below by its pane. */}
            <aside className="dv-advisor-card" style={{ width: `${advisorW}px` }}>
              <DvChrome title="Multitool" desc={active?.name} onRefresh={reloadActive} />
              <div className="dv-advisor-slot" ref={setSidePanelSlot} />
            </aside>
          </div>

          {/* Files browser — its own rounded card at the bottom of the column. */}
          <footer className="dv-files-footer" style={{ height: `${footerHeight}px` }}>
            <div
              className="dv-footer-resize"
              onMouseDown={beginFooterResize}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize files panel height"
            />
            <PaneChromeProvider>
              <DvFilesCard />
            </PaneChromeProvider>
          </footer>
        </div>
      </div>
    </div>
  );
}
