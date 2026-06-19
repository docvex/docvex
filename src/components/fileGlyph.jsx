import React from 'react';
import { DOCX_MIME, PPTX_MIME } from '../lib/thumbnails';

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

const DocxGlyph = (
  <svg {...COMMON_PROPS}>
    {PaperBase}
    <text x="7.5" y="18" fontSize="5.4" fontWeight="700" fill="currentColor" stroke="none">DOC</text>
  </svg>
);

const PptxGlyph = (
  <svg {...COMMON_PROPS}>
    {PaperBase}
    <text x="7.6" y="18" fontSize="5.4" fontWeight="700" fill="currentColor" stroke="none">PPT</text>
  </svg>
);

const VideoGlyph = (
  <svg {...COMMON_PROPS}>
    <rect x="2" y="6" width="14" height="12" rx="2" ry="2" />
    <polygon points="22 8 16 12 22 16 22 8" />
  </svg>
);

// Audio files — a speaker with sound waves (the "volume" mark).
const AudioGlyph = (
  <svg {...COMMON_PROPS}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.8 5.2a9 9 0 0 1 0 13.6" />
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
  if (m === DOCX_MIME || lcName.endsWith('.docx')) return DocxGlyph;
  if (m === PPTX_MIME || lcName.endsWith('.pptx')) return PptxGlyph;
  if (m.startsWith('image/')) return ImageGlyph;
  if (m.startsWith('video/')) return VideoGlyph;
  // Audio — match by MIME, or by extension when the OS didn't resolve a type.
  if (m.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|wma|aiff?)$/i.test(lcName)) return AudioGlyph;
  if (m.startsWith('text/')) return TextGlyph;
  return FileGlyph;
}
