// Document generation — backs the Files tab's "New file" / "Create new file" →
// open in the Doc Viewer → describe it in the AI advisor → real downloadable
// Office/PDF file flow. Supported kinds: docx, pptx, xlsx, pdf.
//
// ── Two engines (picked by buildDocumentBlobSmart) ───────────────────────────
//   • 'skills' (default, "Path A") — Anthropic's managed document Agent Skills run
//     python-docx/-pptx/openpyxl/reportlab in a code-execution sandbox (the same
//     mechanism claude.ai uses) and return a real file; we download the bytes and
//     decode them. Routed through the `office` action of the `project-ai` Edge
//     Function. NOTE: on this account the skills path frequently times out
//     (~80–150s, occasional 502), so it auto-falls back to —
//   • 'local' ("Path B") — deterministic in-renderer builders (docx via `docx`,
//     pptx via `pptxgenjs`, xlsx via SheetJS, pdf via `jspdf`) that produce a
//     genuinely themed file offline+instantly. Selection: try Skills if engine is
//     'skills' AND the kind is an office kind; on unavailable/error/invalid output,
//     fall back to the local builder. Both are lazy-imported.
//
// ── Per-format notes ─────────────────────────────────────────────────────────
//   • xlsx: cells the model wrote as "=…" are rewritten to LIVE SheetJS formula
//     cells, so Excel/LibreOffice recalculates on open (totals stay dynamic).
//   • pdf: same Markdown-ish input as docx; jsPDF lays out a ruled title, accented
//     headings, bullets and wrapped/paginated body text (brand palette).
//
// ── Validation loop (validateBlob) ───────────────────────────────────────────
//   Every produced blob is structurally validated before it's returned — office
//   files must be ZIPs (PK magic), pdf must start with %PDF. A Skills file that
//   fails is discarded and the local builder runs instead; a local file that
//   fails throws. (Full LibreOffice recalc/validation isn't possible in the Deno
//   edge runtime, so this is the lightweight stand-in; the xlsx skill recalcs
//   server-side.)
//
// ── Revisions / versioning ───────────────────────────────────────────────────
//   Handled in DocViewer's generate mode: each request re-feeds the CURRENT
//   document content to the model, which returns the COMPLETE updated file via the
//   `write_document` tool → saved as a new version (prior versions kept; clicking
//   a version card writes it back to disk = revert). "Convert to PDF" of an
//   existing office file is separate — see lib/exportPdf.js (html2canvas + jsPDF
//   capture of the live rendered preview).

import { generateDocument, generateOfficeFile } from './projectAi';

// File kinds we can create + generate. Anything else falls back to plain text.
export const GEN_KINDS = {
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word document' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint presentation' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel spreadsheet' },
  pdf: { mime: 'application/pdf', label: 'PDF document' },
  md: { mime: 'text/markdown', label: 'Markdown document' },
  txt: { mime: 'text/plain', label: 'Text document' },
};

export function extOf(name) {
  const i = String(name || '').lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

// The generatable kind for a filename, or null if its extension isn't one we
// can build (the caller treats that as "not a New-file target").
export function docKindFromName(name) {
  const ext = extOf(name);
  return GEN_KINDS[ext] ? ext : null;
}

export function mimeForKind(kind) {
  return GEN_KINDS[kind]?.mime || 'application/octet-stream';
}

// A freshly-created file is a "wildcard" with no extension — we don't assume
// docx. The actual document kind is inferred from what the user describes in the
// advisor (and so determines the file's extension only once it's generated).
export function inferDocKind(instructions) {
  const t = String(instructions || '').toLowerCase();
  if (/\b(presentation|slides?|power\s?point|pptx|deck|slideshow|keynote|pitch)\b/.test(t)) return 'pptx';
  if (/\b(spreadsheet|excel|xlsx|csv|budget|ledger|balance sheet|sheet|table of|tabular)\b/.test(t)) return 'xlsx';
  if (/\bpdf\b/.test(t)) return 'pdf';
  return 'docx';
}

// Rewrite a filename to carry `kind`'s extension, stripping a recognised
// generatable extension first (so `report.docx` → `report.pptx`, and the
// wildcard `report` → `report.docx`). Unknown trailing tokens are kept as-is.
export function withKindExtension(filename, kind) {
  const name = String(filename || '');
  const cur = docKindFromName(name);
  const base = cur ? name.slice(0, name.length - (cur.length + 1)) : name;
  return `${base}.${kind}`;
}

export function labelForKind(kind) {
  return GEN_KINDS[kind]?.label || 'document';
}

// ── Binary builders ──────────────────────────────────────────────────────
// All accept the AI's plain-text/markdown-ish draft and return a Blob.
//
// These are the "Instant" (local) engine — they run entirely in the renderer
// and produce a genuinely STYLED file (themed cover/headings/accents), so the
// output looks designed even when the high-fidelity Skills engine is off. They
// share one brand palette (mirrors src/styles/tokens.css) so a Word doc and a
// deck from the same session read as one family.

// Brand palette (hex WITHOUT the leading '#', the form docx/pptxgenjs want).
// Mirrors the Cream theme's brand constants in tokens.css.
const BRAND = {
  ink: '0F172A',
  slate: '1E293B',
  sand: 'DCC9A3',
  cream: 'F5F2EA',
  cognac: '8B5E3C',
  cognacDark: '74502F',
  muted: '64748B',
  white: 'FFFFFF',
};
// Display (serif) + body (sans) faces chosen to be present on Windows, macOS and
// anywhere Office is installed, so the file renders the same on disk as in-app.
const FONT_DISPLAY = 'Georgia';
const FONT_BODY = 'Calibri';

// One font for the whole Word document so the in-app docx-preview
// "reconstruction" and the file opened in Word render identically. Calibri is a
// universally-installed sans (the long-standing Word default) — the preview CSS
// falls back to it where the chosen face isn't installed; keep that in sync with
// `.docx` in DocViewer.css.
const DOCX_FONT = FONT_BODY;

// Rough page capacity for a Letter/A4 page at 11pt with default margins. Used to
// insert explicit page breaks (docx-preview only paginates on explicit breaks,
// and the docx lib emits none on its own — so a long doc would be one tall page).
const LINES_PER_PAGE = 42;
const CHARS_PER_LINE = 95;

// Turn one line of markdown-ish body text into styled TextRuns, honouring
// **bold**, *italic* and `code` so emphasis survives into Word rather than
// showing as literal asterisks. `base` is merged into every run.
function inlineRuns(TextRun, text, base = {}) {
  const runs = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|`([^`]+)`)/g;
  let last = 0;
  let m;
  const plain = (t) => { if (t) runs.push(new TextRun({ ...base, text: t })); };
  while ((m = re.exec(text)) !== null) {
    plain(text.slice(last, m.index));
    if (m[2] || m[3]) runs.push(new TextRun({ ...base, text: m[2] || m[3], bold: true }));
    else if (m[4]) runs.push(new TextRun({ ...base, text: m[4], italics: true }));
    else if (m[5]) runs.push(new TextRun({ ...base, text: m[5], font: 'Consolas' }));
    last = re.lastIndex;
  }
  plain(text.slice(last));
  if (!runs.length) plain(' ');
  return runs;
}

// Themed Word doc: a coloured title with a cognac rule, accented headings,
// comfortable line spacing and proper bullets. Heading colours/sizes are set via
// named paragraph styles so HeadingLevel.* paragraphs pick them up.
async function buildDocx(text) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, BorderStyle } = await import('docx');
  const lines = String(text || '').split(/\r?\n/);
  const children = [];
  // Running estimate of how full the current page is; when a paragraph would
  // overflow it, we set pageBreakBefore on that paragraph and start a new page.
  let budget = 0;
  const estimate = (len, extra = 0) => Math.max(1, Math.ceil(len / CHARS_PER_LINE)) + extra;
  const push = (opts, estLines) => {
    const needBreak = children.length > 0 && budget + estLines > LINES_PER_PAGE;
    if (needBreak) budget = 0;
    children.push(new Paragraph({ ...opts, pageBreakBefore: needBreak }));
    budget += estLines;
  };

  let titled = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { push({}, 1); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    // The first heading/ALL-CAPS line becomes the document Title (big, ruled).
    const isCapsTitle = !titled && children.length === 0 && line === line.toUpperCase() && /[A-Z]/.test(line);
    if ((h && h[1].length === 1 && !titled) || isCapsTitle) {
      const label = stripInline(h ? h[2] : line);
      push({ heading: HeadingLevel.TITLE, children: inlineRuns(TextRun, label) }, estimate(label.length, 3));
      titled = true;
      continue;
    }
    if (h) {
      const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][h[1].length - 1];
      const label = stripInline(h[2]);
      push({ heading: level, children: inlineRuns(TextRun, label) }, estimate(label.length, 2));
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = (raw.match(/^\s*/)?.[0].length) || 0;
      push({ bullet: { level: indent >= 2 ? 1 : 0 }, children: inlineRuns(TextRun, bullet[1]) }, estimate(bullet[1].length));
      continue;
    }
    push({ spacing: { after: 160, line: 276 }, children: inlineRuns(TextRun, line) }, estimate(line.length));
  }
  if (!children.length) children.push(new Paragraph({}));

  const doc = new Document({
    styles: {
      default: { document: { run: { font: DOCX_FONT, size: 22, color: BRAND.slate } } },
      paragraphStyles: [
        {
          id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: FONT_DISPLAY, size: 52, bold: true, color: BRAND.ink },
          paragraph: {
            spacing: { after: 200 },
            border: { bottom: { color: BRAND.cognac, space: 8, style: BorderStyle.SINGLE, size: 18 } },
          },
        },
        {
          id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: FONT_DISPLAY, size: 30, bold: true, color: BRAND.cognac },
          paragraph: { spacing: { before: 300, after: 120 } },
        },
        {
          id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: FONT_DISPLAY, size: 24, bold: true, color: BRAND.ink },
          paragraph: { spacing: { before: 220, after: 100 } },
        },
        {
          id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: DOCX_FONT, size: 22, bold: true, color: BRAND.slate },
          paragraph: { spacing: { before: 160, after: 80 } },
        },
      ],
    },
    sections: [{
      properties: { page: { margin: { top: 1080, bottom: 1080, left: 1180, right: 1180 } } },
      children,
    }],
  });
  return Packer.toBlob(doc);
}

// Strip the lightweight markdown emphasis the model tends to emit so it doesn't
// show as literal asterisks/backticks in a rendered slide/cell.
function stripInline(s) {
  return String(s || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2')
    .replace(/`(.+?)`/g, '$1')
    .trim();
}

// Split a draft into slides: each "# Title" / "## Title" starts a new slide;
// "- " lines become bullets, and nesting (indentation, or "  - ") becomes a
// sub-bullet level so the deck has visual hierarchy rather than a flat list.
function splitSlides(text) {
  const lines = String(text || '').split(/\r?\n/);
  const slides = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    if (h) { cur = { title: stripInline(h[1]), bullets: [] }; slides.push(cur); continue; }
    if (!line.trim()) continue;
    if (!cur) { cur = { title: stripInline(line), bullets: [] }; slides.push(cur); continue; }
    const indent = (raw.match(/^\s*/)?.[0].length) || 0;
    const m = /^\s*[-*•]\s+(.*)$/.exec(line);
    const level = indent >= 2 ? 1 : 0;
    cur.bullets.push({ text: stripInline(m ? m[1] : line), level });
  }
  return slides;
}

// Themed deck: a deep-ink cover slide, then cream content slides with a slim
// cognac top rule, serif titles with an accent underline, and tiered bullets +
// slide numbers. The look mirrors the app's Cream theme.
async function buildPptx(text) {
  const mod = await import('pptxgenjs');
  const PptxGenJS = mod.default || mod;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33in × 7.5in
  const W = 13.33;
  const H = 7.5;

  pptx.defineSlideMaster({
    title: 'DVX_COVER',
    background: { color: BRAND.ink },
    objects: [
      { rect: { x: 0.9, y: 2.55, w: 1.6, h: 0.1, fill: { color: BRAND.sand } } },
      { rect: { x: 0, y: H - 0.5, w: W, h: 0.5, fill: { color: BRAND.cognac } } },
    ],
  });
  pptx.defineSlideMaster({
    title: 'DVX_CONTENT',
    background: { color: BRAND.white },
    objects: [{ rect: { x: 0, y: 0, w: W, h: 0.22, fill: { color: BRAND.cognac } } }],
    slideNumber: { x: W - 0.9, y: H - 0.42, color: BRAND.muted, fontFace: FONT_BODY, fontSize: 10 },
  });

  const slides = splitSlides(text);
  if (!slides.length) slides.push({ title: '', bullets: [] });

  slides.forEach((s, idx) => {
    if (idx === 0) {
      const slide = pptx.addSlide({ masterName: 'DVX_COVER' });
      slide.addText(s.title || 'Presentation', {
        x: 0.9, y: 2.75, w: W - 1.8, h: 1.7,
        fontSize: 40, bold: true, color: BRAND.white, fontFace: FONT_DISPLAY,
        align: 'left', valign: 'top',
      });
      if (s.bullets.length) {
        slide.addText(s.bullets.map((b) => b.text).join('   ·   '), {
          x: 0.92, y: 4.55, w: W - 1.8, h: 1,
          fontSize: 17, color: BRAND.sand, fontFace: FONT_BODY, align: 'left', valign: 'top',
        });
      }
      return;
    }
    const slide = pptx.addSlide({ masterName: 'DVX_CONTENT' });
    if (s.title) {
      slide.addText(s.title, {
        x: 0.7, y: 0.5, w: W - 1.4, h: 0.9,
        fontSize: 26, bold: true, color: BRAND.ink, fontFace: FONT_DISPLAY, valign: 'top',
      });
      slide.addShape(pptx.ShapeType.rect, { x: 0.73, y: 1.36, w: 1.1, h: 0.05, fill: { color: BRAND.cognac } });
    }
    if (s.bullets.length) {
      slide.addText(
        s.bullets.map((b) => ({
          text: b.text,
          options: {
            bullet: { code: b.level ? '2013' : '2022', indent: 16 },
            indentLevel: b.level,
            color: b.level ? BRAND.muted : BRAND.slate,
            fontSize: b.level ? 16 : 18,
            paraSpaceAfter: 8,
            breakLine: true,
          },
        })),
        { x: 0.8, y: 1.7, w: W - 1.6, h: H - 2.3, fontFace: FONT_BODY, valign: 'top' },
      );
    }
  });

  const out = await pptx.write({ outputType: 'blob' });
  return out instanceof Blob ? out : new Blob([out], { type: mimeForKind('pptx') });
}

// Parse a CSV-ish / markdown table into a 2-D array for SheetJS.
function parseTable(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [['']];
  // Markdown table? rows look like "| a | b |".
  if (lines[0].includes('|')) {
    return lines
      .filter((l) => !/^\s*\|?\s*-{2,}/.test(l)) // drop the "---|---" separator
      .map((l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()));
  }
  // Otherwise CSV.
  return lines.map((l) => l.split(',').map((c) => c.trim()));
}

async function buildXlsx(text) {
  const XLSX = await import('xlsx');
  const rows = parseTable(text);
  const data = rows.length ? rows : [['']];
  const ws = XLSX.utils.aoa_to_sheet(data);
  // Keep formulas LIVE: any cell the model wrote as "=…" lands as a text cell
  // from aoa_to_sheet — rewrite it to a real formula cell so Excel/LibreOffice
  // recalculates it on open (a sheet that "sums these columns" stays dynamic,
  // not a frozen number). SheetJS writes `f` (without the leading '=').
  if (ws['!ref']) {
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = range.s.r; r <= range.e.r; r += 1) {
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (cell && typeof cell.v === 'string' && cell.v[0] === '=' && cell.v.length > 1) {
          ws[addr] = { t: 'n', f: cell.v.slice(1) };
        }
      }
    }
  }
  // Auto-size columns to their widest cell (the community `xlsx` build ignores
  // cell styling, but honours column widths and a frozen header row).
  const cols = (data[0] || []).map((_, c) => {
    const w = data.reduce((mx, r) => Math.max(mx, String(r[c] ?? '').length), 10);
    return { wch: Math.min(60, w + 2) };
  });
  if (cols.length) ws['!cols'] = cols;
  if (data.length > 1) ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: mimeForKind('xlsx') });
}

// Themed PDF (jsPDF). Same Markdown-ish input as the docx builder: the first
// heading / ALL-CAPS line becomes a ruled title; "##/###" become accented
// headings; "- " become bullets; everything else flows as body text, wrapped to
// the page and paginated automatically. Standard PDF base-14 fonts (Times for
// display, Helvetica for body) so it renders identically everywhere with no
// font embedding. Colours mirror the Cream brand palette.
async function buildPdf(text) {
  const mod = await import('jspdf');
  const JsPDF = mod.jsPDF || mod.default || mod;
  const doc = new JsPDF({ unit: 'pt', format: 'a4', compress: true });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 56;
  const maxW = pageW - margin * 2;
  const ink = [15, 23, 42];
  const slate = [30, 41, 59];
  const cognac = [139, 94, 60];
  let y = margin;
  const ensure = (h) => { if (y + h > pageH - margin) { doc.addPage(); y = margin; } };

  const lines = String(text || '').split(/\r?\n/);
  let titled = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { y += 8; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const isCapsTitle = !titled && line === line.toUpperCase() && /[A-Z]/.test(line) && line.length < 90;
    if ((h && h[1].length === 1 && !titled) || isCapsTitle) {
      const label = stripInline(h ? h[2] : line);
      doc.setFont('times', 'bold'); doc.setFontSize(24); doc.setTextColor(...ink);
      const w = doc.splitTextToSize(label, maxW);
      ensure(w.length * 28 + 14);
      doc.text(w, margin, y); y += w.length * 28;
      doc.setDrawColor(...cognac); doc.setLineWidth(2); doc.line(margin, y - 4, pageW - margin, y - 4);
      y += 16; titled = true; continue;
    }
    if (h) {
      const lvl = h[1].length;
      const label = stripInline(h[2]);
      doc.setFont('times', 'bold'); doc.setFontSize(lvl === 2 ? 15 : 13);
      doc.setTextColor(...(lvl === 2 ? cognac : slate));
      const w = doc.splitTextToSize(label, maxW);
      ensure(w.length * 20 + 8); y += 8;
      doc.text(w, margin, y); y += w.length * 20 + 2; continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(...slate);
    if (bullet) {
      const w = doc.splitTextToSize(stripInline(bullet[1]), maxW - 16);
      ensure(w.length * 15);
      doc.setTextColor(...cognac); doc.text('•', margin + 2, y);
      doc.setTextColor(...slate); doc.text(w, margin + 16, y);
      y += w.length * 15; continue;
    }
    const w = doc.splitTextToSize(stripInline(line), maxW);
    ensure(w.length * 15 + 4);
    doc.text(w, margin, y); y += w.length * 15 + 5;
  }
  return doc.output('blob');
}

export async function buildDocumentBlob(kind, text) {
  if (kind === 'docx') return buildDocx(text);
  if (kind === 'pptx') return buildPptx(text);
  if (kind === 'xlsx') return buildXlsx(text);
  if (kind === 'pdf') return buildPdf(text);
  return new Blob([String(text || '')], { type: mimeForKind(kind) });
}

// Lightweight structural validation so a corrupt/truncated file never reaches
// the user (a stand-in for the heavyweight LibreOffice recalc/validation, which
// can't run in our Deno edge runtime). Office files are ZIPs → must start with
// the "PK\x03\x04" local-file-header magic; PDFs must start with "%PDF". Catches
// a botched Skills base64 decode or an empty build; the per-format builders make
// well-formed bytes otherwise.
export async function validateBlob(kind, blob) {
  try {
    if (!blob || blob.size < 64) return false;
    const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
    if (kind === 'pdf') {
      return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46; // %PDF
    }
    if (kind === 'docx' || kind === 'pptx' || kind === 'xlsx') {
      return head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04; // PK\x03\x04
    }
    return true; // txt / md / unknown — nothing to validate
  } catch { return true; } // never block a build on a validation read error
}

function base64ToBlob(base64, mime) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Two document engines, selectable from the composer toggle:
//   • 'skills' (default) — build a high-fidelity file with Anthropic's document
//     Agent Skills (real python-pptx/-docx/openpyxl output, = claude.ai). Falls
//     back to the local builders when the skill isn't available (betas off) or
//     errors, so document creation always succeeds.
//   • 'local' — skip the network round-trip and use the themed local builders
//     directly (instant, offline, free).
// `instructions` is optional extra guidance passed to the Skills engine.
export const DOC_ENGINES = { skills: 'skills', local: 'local' };
const OFFICE_KINDS = new Set(['docx', 'pptx', 'xlsx', 'pdf']);
export async function buildDocumentBlobSmart(kind, text, { instructions, engine = 'skills', model } = {}) {
  if (engine !== 'local' && OFFICE_KINDS.has(kind)) {
    try {
      const res = await generateOfficeFile({ kind, content: String(text || ''), instructions, model });
      if (res?.base64) {
        const blob = base64ToBlob(res.base64, mimeForKind(kind));
        // Validation loop: a Skills file that fails structural validation (e.g. a
        // truncated/garbled base64) is discarded — fall through to the local
        // builder rather than serving a corrupt download.
        if (await validateBlob(kind, blob)) {
          try { console.info('[DocVex] Office Skills produced the file (high-fidelity).'); } catch { /* noop */ }
          return blob;
        }
        try { console.warn('[DocVex] Office Skills returned an invalid file — using the local builder.'); } catch { /* noop */ }
      } else {
        // res.unavailable or res.error → log WHY, then fall through to the local builder.
        try {
          console.warn(`[DocVex] Office Skills unavailable — using the local builder. Reason: ${res?.code || res?.error?.message || 'unknown'}${res?.detail ? ` — ${res.detail}` : ''}`);
        } catch { /* noop */ }
      }
    } catch (e) {
      try { console.warn(`[DocVex] Office Skills call failed — using the local builder: ${e?.message || e}`); } catch { /* noop */ }
    }
  }
  const blob = await buildDocumentBlob(kind, text);
  // The local builders are deterministic and well-formed; this assertion just
  // guarantees we never hand back a corrupt file.
  if (!(await validateBlob(kind, blob))) throw new Error(`built ${kind} failed validation`);
  return blob;
}

// A minimal, VALID empty file so the freshly-named document opens cleanly in
// the viewer before the user has generated anything.
export async function emptyDocumentBlob(kind) {
  if (kind === 'docx') return buildDocx('');
  if (kind === 'pptx') return buildPptx('');
  if (kind === 'xlsx') return buildXlsx('');
  if (kind === 'pdf') return buildPdf('');
  return new Blob([''], { type: mimeForKind(kind) });
}

// ── AI content ───────────────────────────────────────────────────────────
// Ask Claude (via the project-ai `generate` action) to draft the document, with
// a format hint matched to the target kind so buildDocumentBlob can pack it.
export async function generateDocumentContent({ kind, instructions, projectName, fileNames }) {
  const guide =
    kind === 'pptx'
      ? 'Format the output as slides. Start every slide with a line "# Slide Title", then list its points as "- " bullet lines.'
      : kind === 'xlsx'
        ? 'Output ONLY a comma-separated CSV table — the first row is the column headers. No prose before or after.'
        : kind === 'md'
          ? 'Use Markdown: "# Heading", "## Subheading", and "- " bullets.'
          : 'Write a clean document. Put the title on the first line, then the body in clear paragraphs.';

  const res = await generateDocument({
    template: labelForKind(kind),
    instructions: `${instructions || ''}\n\n${guide}`.trim(),
    projectName: projectName || '',
    fileNames: fileNames || [],
  });
  if (res.error) return { error: res.error?.message || String(res.error) };
  return { text: res.text || '' };
}
