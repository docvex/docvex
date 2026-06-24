import React from 'react';
import { DOCX_MIME, PPTX_MIME } from '../lib/thumbnails';

// Office Open XML + legacy binary MIME types, kept here next to the
// glyph dispatcher (thumbnails.js only exports the two it needs).
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOC_MIME = 'application/msword';
const PPT_MIME = 'application/vnd.ms-powerpoint';
const XLS_MIME = 'application/vnd.ms-excel';

// Single MIME → SVG glyph map for the whole app. Replaces the two
// parallel maps that used to live in ProjectFiles.jsx and
// ChangeRequestsView.jsx — same glyphs, slightly different ordering
// in each, drifted over time. Now there's one source so a new file
// type (or a glyph tweak) lands everywhere at once.
//
// All SVGs use stroke=currentColor so the parent's color inheritance
// works without per-icon overrides — the thumb container can recolor
// the glyph by setting `color` on its own rule.

const COMMON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: '1.8',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

const PaperBase = (
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </>
);

const PdfGlyph = (
  <svg {...COMMON_PROPS}>
    {PaperBase}
    <text x="8" y="18" fontSize="6" fontWeight="700" fill="currentColor" stroke="none">PDF</text>
  </svg>
);

// ── Microsoft Office file icons ─────────────────────────────────────
// Authentic Word / Excel / PowerPoint file icons: a white document with
// faint brand-coloured content hints and the app's letter badge sitting on
// the lower-left corner — the recognizable real Office look, in Microsoft's
// own brand colours (not the app palette). Full-colour SVGs (explicit fills,
// not currentColor), so the container's accent colour doesn't affect them.
const OFFICE_SPECS = {
  word: {
    color: '#185ABD',
    letter: 'W',
    content: (
      <path d="M6.8 5.9h10.4M6.8 8.5h10.4M6.8 11.1h7" stroke="#185ABD" strokeOpacity="0.5" strokeWidth="1.25" strokeLinecap="round" />
    ),
  },
  excel: {
    color: '#107C41',
    letter: 'X',
    content: (
      <path d="M6.8 6.1h10.4M6.8 9h10.4M10.6 4.6v6.9M14.1 4.6v6.9" stroke="#107C41" strokeOpacity="0.5" strokeWidth="1.1" />
    ),
  },
  ppt: {
    color: '#C43E1C',
    letter: 'P',
    content: (
      <>
        <circle cx="9.3" cy="7.6" r="3.1" fill="none" stroke="#C43E1C" strokeOpacity="0.5" strokeWidth="1.2" />
        <path d="M14.2 6h3.2M14.2 8.5h3.2M14.2 11h3.2" stroke="#C43E1C" strokeOpacity="0.5" strokeWidth="1.2" strokeLinecap="round" />
      </>
    ),
  },
};

export function OfficeFileIcon({ kind, className }) {
  const s = OFFICE_SPECS[kind] || OFFICE_SPECS.word;
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" style={{ width: '100%', height: '100%' }}>
      <rect x="4.6" y="2.5" width="14.8" height="19" rx="1.7" fill="#fff" stroke="rgba(0,0,0,0.16)" strokeWidth="0.8" />
      {s.content}
      <rect x="1.8" y="11.4" width="11" height="10.1" rx="1.8" fill={s.color} />
      <text x="7.3" y="19.3" textAnchor="middle" fontFamily="var(--font-display, sans-serif)" fontSize="8.6" fontWeight="700" fill="#fff">{s.letter}</text>
    </svg>
  );
}

const DocxGlyph = <OfficeFileIcon kind="word" />;
const PptxGlyph = <OfficeFileIcon kind="ppt" />;
const XlsxGlyph = <OfficeFileIcon kind="excel" />;

const VideoGlyph = (
  <svg {...COMMON_PROPS}>
    <rect x="2" y="6" width="14" height="12" rx="2" ry="2" />
    <polygon points="22 8 16 12 22 16 22 8" />
  </svg>
);

// Audio files — a decibel line: equalizer bars of varying heights (waveform).
const AudioGlyph = (
  <svg {...COMMON_PROPS}>
    <path d="M3 10.5v3" />
    <path d="M6.5 7.5v9" />
    <path d="M10 4.5v15" />
    <path d="M13.5 8.5v7" />
    <path d="M17 6v12" />
    <path d="M20.5 9.5v5" />
  </svg>
);

const ImageGlyph = (
  <svg {...COMMON_PROPS}>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </svg>
);

const TextGlyph = (
  <svg {...COMMON_PROPS}>
    {PaperBase}
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="14" y2="17" />
  </svg>
);

const FileGlyph = (
  <svg {...COMMON_PROPS}>
    {PaperBase}
  </svg>
);

// Pick the glyph for a given MIME + filename. Filename matters because
// DOCX-like files sometimes upload with mime_type='application/octet-stream'
// when the OS didn't resolve the type before upload — falling back to
// the `.docx` extension catches those.
export function glyphForFile(mime, name) {
  const m = (mime || '').toLowerCase();
  const lcName = (name || '').toLowerCase();
  if (m === 'application/pdf') return PdfGlyph;
  if (m === DOCX_MIME || m === DOC_MIME || /\.docx?$/.test(lcName)) return DocxGlyph;
  if (m === PPTX_MIME || m === PPT_MIME || /\.pptx?$/.test(lcName)) return PptxGlyph;
  if (m === XLSX_MIME || m === XLS_MIME || /\.xlsx?$/.test(lcName)) return XlsxGlyph;
  if (m.startsWith('image/')) return ImageGlyph;
  if (m.startsWith('video/')) return VideoGlyph;
  // Audio — match by MIME, or by extension when the OS didn't resolve a type.
  if (m.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|wma|aiff?)$/i.test(lcName)) return AudioGlyph;
  if (m.startsWith('text/')) return TextGlyph;
  return FileGlyph;
}
