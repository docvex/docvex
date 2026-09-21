// PDF → Word, PDF → images. The Doc Viewer's two quick actions on a PDF
// (`DocPane`): both work from the pdf.js document the preview already parsed
// (`lib/pdfCache`), both run entirely on this machine — except the one case
// noted under "scanned" below — and both hand back blobs; WHERE they are
// written (beside the PDF, never over anything) is the caller's business.
//
// → IMAGES: every page rendered to a canvas, one PNG or JPEG each.
//
// → WORD: a PDF has no paragraphs, only glyph runs at coordinates — so the
// document is REBUILT from them: runs → lines (same baseline) → paragraphs
// (lines a normal leading apart, in the same size, where the line above ran to
// the margin) with headings told by size and centring by position. It is a
// faithful, EDITABLE text of the document, not a pixel copy of its layout:
// columns, tables and drawings don't survive as such (a table comes out as its
// rows of text). A page with NO text layer is a scan: its picture is placed in
// the Word file, so nothing is lost — and when the WHOLE file is a scan, its
// text is read once by the AI (`identityExtract.readSourceText`, the same
// cached transcription the rest of the app uses) and written as paragraphs
// instead, because a Word file of pictures is not what anyone converts for.
import { getCachedPdf } from './pdfCache';
import { readSourceText } from './identityExtract';
import { readLocalBlob } from './localFolder';

const pad = (n, width) => String(n).padStart(width, '0');

async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return canvas;
}
const canvasBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode_failed'))), type, quality);
});

// A page is rendered at ~200 dpi (a PDF point is 1/72"), less for a very large
// page so no canvas passes ~16 MP.
function renderScale(page, dpi) {
  const vp = page.getViewport({ scale: 1 });
  const want = dpi / 72;
  const cap = Math.sqrt(16e6 / Math.max(1, vp.width * vp.height));
  return Math.max(0.5, Math.min(want, cap));
}

// → `[{ filename, blob }]`, one per page: "<stem> - page 03.png".
export async function pdfToImages({ path, url, name, format = 'png', dpi = 200, onProgress } = {}) {
  const pdf = await getCachedPdf(path, url);
  const stem = String(name || 'document').replace(/\.[^./\\]+$/, '');
  const width = String(pdf.numPages).length < 2 ? 2 : String(pdf.numPages).length;
  const out = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    onProgress?.({ page: n, pages: pdf.numPages });
    const page = await pdf.getPage(n);
    const canvas = await renderPage(page, renderScale(page, dpi));
    const blob = format === 'jpeg' ? await canvasBlob(canvas, 'image/jpeg', 0.92) : await canvasBlob(canvas, 'image/png');
    out.push({ filename: `${stem} - page ${pad(n, width)}.${format === 'jpeg' ? 'jpg' : 'png'}`, blob });
    canvas.width = 0; canvas.height = 0;   // give the pixels back now, not at GC
  }
  return out;
}

// ── One page, edited as a picture (the Doc Viewer's "Edit page") ─────────
// A one-page PDF is very often a scan or an export of something that was a
// picture to begin with, so the photo editor (rotate, straighten, crop, and the
// four-point crop that squares up a page photographed at an angle) is exactly
// the right tool for it. The page goes in as a picture and comes back OUT as a
// PDF — the file stays what it was.

// → `{ dataUrl, widthPt, heightPt }`: the page as a picture (PNG: a document's
// text must not be blurred by JPEG), and the page's size in PDF points, which
// the edited PDF is built back at.
export async function pdfPageImage({ path, url, page = 1, dpi = 200 } = {}) {
  const pdf = await getCachedPdf(path, url);
  const pg = await pdf.getPage(page);
  const vp = pg.getViewport({ scale: 1 });
  const canvas = await renderPage(pg, renderScale(pg, dpi));
  const dataUrl = canvas.toDataURL('image/png');
  canvas.width = 0; canvas.height = 0;
  return { dataUrl, widthPt: vp.width, heightPt: vp.height };
}

// A picture → a one-page PDF of it. The page keeps the ORIGINAL's proportions
// where the edit did not change them (a crop does — then the page takes the
// picture's own, at the same area, so nothing is stretched or letterboxed).
export async function pdfFromImage(blob, { widthPt = 595, heightPt = 842 } = {}) {
  const bitmap = await createImageBitmap(blob);
  const ratio = bitmap.width / bitmap.height;
  bitmap.close?.();
  const same = Math.abs(ratio - widthPt / heightPt) < 0.01;
  const area = widthPt * heightPt;
  const w = same ? widthPt : Math.sqrt(area * ratio);
  const h = same ? heightPt : Math.sqrt(area / ratio);
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: [w, h], orientation: w > h ? 'landscape' : 'portrait' });
  const url = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('read_failed'));
    fr.readAsDataURL(blob);
  });
  doc.addImage(url, url.startsWith('data:image/png') ? 'PNG' : 'JPEG', 0, 0, w, h);
  return doc.output('blob');
}

// ── PDF text → lines → paragraphs ───────────────────────────────────────
// One page's glyph runs as LINES: `{ text, x0, x1, y, size }`, top to bottom.
// Exported for tests; pure.
export function linesFromItems(items) {
  const runs = [];
  for (const it of items || []) {
    const str = String(it?.str ?? '');
    if (!str.trim() || !Array.isArray(it.transform)) continue;
    const [a, b, , d, x, y] = it.transform;
    // Upright text only: a run written sideways (a stamp, a margin note) would
    // scramble the lines it crosses.
    if (Math.abs(b) > Math.abs(a)) continue;
    const size = Math.abs(d) || Math.abs(a) || it.height || 10;
    runs.push({ str, x, y, w: it.width || 0, size });
  }
  runs.sort((p, q) => q.y - p.y || p.x - q.x);
  const lines = [];
  for (const r of runs) {
    const line = lines.find((l) => Math.abs(l.y - r.y) < Math.max(l.size, r.size) * 0.45);
    if (line) line.runs.push(r); else lines.push({ y: r.y, size: r.size, runs: [r] });
  }
  return lines.map((l) => {
    l.runs.sort((p, q) => p.x - q.x);
    let text = '';
    let end = null;
    const weights = new Map();
    for (const r of l.runs) {
      // A gap wider than a fifth of the letter size is a space the PDF left out;
      // one several letters wide is two things on one baseline (the two
      // signature blocks, a label and a figure across the page) — kept apart
      // with a run of em spaces, which Word keeps where it collapses plain ones.
      if (end !== null && r.x - end > r.size * 3) text = `${text.trimEnd()}\u2003\u2003\u2003`;
      else if (end !== null && r.x - end > r.size * 0.2 && !/\s$/.test(text) && !/^\s/.test(r.str)) text += ' ';
      text += r.str.replace(/[ \t]+/g, ' ');
      end = r.x + r.w;
      weights.set(r.size, (weights.get(r.size) || 0) + r.str.length);
    }
    // The line's size is the size most of its letters are in.
    const size = [...weights.entries()].sort((p, q) => q[1] - p[1])[0][0];
    return { text: text.replace(/ {2,}/g, ' ').trim(), x0: l.runs[0].x, x1: end, y: l.y, size };
  }).filter((l) => l.text);
}

// Lines → PARAGRAPHS: `{ text, size, heading, align }`. `pageWidth` in the same
// units as the lines. Exported for tests; pure.
export function paragraphsFromLines(lines, pageWidth, bodySize) {
  if (!lines.length) return [];
  const left = Math.min(...lines.map((l) => l.x0));
  const right = Math.max(...lines.map((l) => l.x1));
  const out = [];
  let cur = null;
  let prev = null;
  for (const l of lines) {
    const gap = prev ? prev.y - l.y : 0;
    const sameSize = prev && Math.abs(prev.size - l.size) < 0.6;
    // The line above ran (nearly) to the right margin: the sentence goes on.
    const prevFull = prev && prev.x1 > right - (right - left) * 0.12;
    // A bullet, a numbered clause, an indented first line: a new paragraph.
    const starts = /^(\d+[.)]|[a-z][.)]|[-–•▪◦*]|art\.?\s*\d+|cap\.?\s)/i.test(l.text) || (prev && l.x0 - prev.x0 > l.size * 1.2);
    const joins = cur && sameSize && prevFull && !starts && gap > 0 && gap < l.size * 1.75;
    if (joins) {
      // A word broken across the line comes back together.
      cur.text = /[A-Za-zÀ-ž]-$/.test(cur.text) && /^[a-zà-ž]/.test(l.text) ? cur.text.slice(0, -1) + l.text : `${cur.text} ${l.text}`;
      cur.last = l;
    } else {
      cur = { text: l.text, size: l.size, first: l, last: l };
      out.push(cur);
    }
    prev = l;
  }
  return out.map((p) => {
    const single = p.first === p.last;
    const mid = (p.first.x0 + p.first.x1) / 2;
    // Centred: its middle is the page's middle AND it stands in from the left
    // margin (a full-width line is centred on the page too, by accident).
    const centred = single && Math.abs(mid - pageWidth / 2) < pageWidth * 0.04 && p.first.x0 - left > p.size * 1.2;
    const rightSide = single && !centred && p.first.x0 > pageWidth * 0.55;
    const big = p.size >= bodySize * 1.22;
    return {
      text: p.text,
      size: p.size,
      heading: big && p.text.length < 140 ? (p.size >= bodySize * 1.6 ? 1 : 2) : 0,
      align: centred ? 'center' : rightSide ? 'right' : 'left',
    };
  });
}

// The size most of the document's letters are set in.
function bodySizeOf(pages) {
  const weights = new Map();
  for (const pg of pages) for (const l of pg.lines) {
    const k = Math.round(l.size * 2) / 2;
    weights.set(k, (weights.get(k) || 0) + l.text.length);
  }
  const top = [...weights.entries()].sort((p, q) => q[1] - p[1])[0];
  return top ? top[0] : 11;
}

// → `{ blob, pages, scanned, usedAi }`. `scanned` = pages that had no text layer.
export async function pdfToDocx({ path, url, name, projectId, onProgress } = {}) {
  const pdf = await getCachedPdf(path, url);
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    onProgress?.({ stage: 'read', page: n, pages: pdf.numPages });
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines = linesFromItems(content.items);
    const letters = lines.reduce((sum, l) => sum + l.text.replace(/\s/g, '').length, 0);
    pages.push({ n, page, width: vp.width, height: vp.height, lines, scanned: letters < 12 });
  }
  const scanned = pages.filter((p) => p.scanned).map((p) => p.n);

  // The WHOLE file is a scan: read its text once (cached AI transcription).
  let aiText = '';
  if (scanned.length === pages.length && pages.length) {
    onProgress?.({ stage: 'ocr', page: 0, pages: pages.length });
    try {
      const blob = await readLocalBlob(path);
      const res = blob ? await readSourceText(blob, name || 'document.pdf', { path, projectId }) : null;
      aiText = res?.text || '';
    } catch { aiText = ''; }
  }

  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun } = await import('docx');
  const body = bodySizeOf(pages);
  const children = [];
  const halfPoints = (size) => Math.max(14, Math.min(96, Math.round(size * 2)));
  const ALIGN = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, left: AlignmentType.LEFT };

  if (aiText) {
    for (const block of aiText.split(/\n{2,}/)) {
      const text = block.replace(/\s*\n\s*/g, ' ').trim();
      if (text) children.push(new Paragraph({ children: [new TextRun({ text, size: 22 })], spacing: { after: 140 } }));
    }
  } else {
    for (const pg of pages) {
      onProgress?.({ stage: 'build', page: pg.n, pages: pages.length });
      // Each PDF page starts a Word page, so the two can be read side by side:
      // the first paragraph made for a page carries the break.
      let fresh = pg.n > 1;
      const breakOnce = () => { const b = fresh; fresh = false; return b; };
      if (pg.scanned) {
        // A scan: the page itself, fitted to the text area of an A4 sheet.
        const canvas = await renderPage(pg.page, renderScale(pg.page, 150));
        const png = new Uint8Array(await (await canvasBlob(canvas, 'image/png')).arrayBuffer());
        const fit = Math.min(600 / canvas.width, 880 / canvas.height);
        children.push(new Paragraph({
          pageBreakBefore: breakOnce(),
          children: [new ImageRun({ type: 'png', data: png, transformation: { width: Math.round(canvas.width * fit), height: Math.round(canvas.height * fit) } })],
        }));
        canvas.width = 0; canvas.height = 0;
      } else {
        for (const p of paragraphsFromLines(pg.lines, pg.width, body)) {
          children.push(new Paragraph({
            pageBreakBefore: breakOnce(),
            heading: p.heading === 1 ? HeadingLevel.HEADING_1 : p.heading === 2 ? HeadingLevel.HEADING_2 : undefined,
            alignment: ALIGN[p.align],
            spacing: { after: 140 },
            children: [new TextRun({ text: p.text, size: halfPoints(p.size), bold: p.heading > 0 })],
          }));
        }
      }
    }
  }
  if (!children.length) children.push(new Paragraph({ children: [new TextRun('')] }));
  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  return { blob, pages: pages.length, scanned, usedAi: !!aiText };
}
