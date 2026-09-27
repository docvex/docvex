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
// the margin). The copy keeps the PDF's LOOK as far as a PDF states it:
//   · every run's real FONT (pdf.js's font object after the page's operator
//     list is loaded — "ABCDEF+TimesNewRomanPS-BoldMT" → Times New Roman,
//     bold), SIZE, bold / italic, and COLOUR (sampled off the rendered page
//     under the run — a PDF's text content carries no colour);
//   · every paragraph's alignment (justified included), left and first-line
//     indent, EXACT line spacing (the baseline gaps) and the space above it;
//   · every PAGE as its own Word section with the PDF page's size and margins,
//     so page N of the PDF is page N of the Word file.
// Word heading styles are NOT used (they would impose their own font and
// colour); the look is direct formatting. Columns, tables and drawings still
// don't survive as such (a table comes out as its rows of text). A page with NO text layer is a scan: its picture is placed in
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

// ── Styling, read off the PDF ──────────────────────────────────────────────
// A PostScript font name → { family, bold, italic }:
//   "ABCDEF+TimesNewRomanPS-BoldItalicMT" → Times New Roman, bold, italic
//   "ArialMT" → Arial · "CourierNewPSMT" → Courier New · "Calibri-Light" → Calibri Light
// Exported for tests; pure.
export function fontFromName(raw, generic = '') {
  let n = String(raw || '').replace(/^[A-Z]{6}\+/, '');
  const style = /[-,](.*)$/.exec(n)?.[1] || '';
  n = n.replace(/[-,].*$/, '');
  const all = `${n} ${style}`;
  const bold = /bold|black|heavy|semibold|demi/i.test(all);
  const italic = /italic|oblique|slanted/i.test(all);
  n = n.replace(/(PSMT|PS|MT|Std|Pro|LT)$/g, '').replace(/(PSMT|PS|MT)$/g, '');
  // "TimesNewRoman" → "Times New Roman"; keeps runs of capitals ("OCRB").
  let family = n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim();
  const light = /light/i.test(style) && !/light/i.test(family) ? ' Light' : '';
  family = family ? family + light : '';
  // The PDF standard fonts, by the names Word has for them.
  const STANDARD = { Times: 'Times New Roman', 'Times Roman': 'Times New Roman', Helvetica: 'Arial', Courier: 'Courier New' };
  if (STANDARD[family.replace(/ Light$/, '')]) family = STANDARD[family.replace(/ Light$/, '')];
  if (!family || /^g_d\d|^f\d+$/i.test(family)) {
    family = /mono|courier/i.test(generic) ? 'Courier New' : /sans/i.test(generic) ? 'Arial' : 'Times New Roman';
  }
  return { family, bold, italic };
}

// The ink colour of a run: the rendered page's pixels in the run's box that
// stand out from the paper, averaged by how far they stand out → "RRGGBB".
function inkColour(ctx, scale, pageH, r) {
  const x0 = Math.max(0, Math.floor(r.x * scale));
  const x1 = Math.max(x0 + 1, Math.ceil((r.x + Math.max(r.w, r.size * 0.3)) * scale));
  const y1 = Math.max(1, Math.ceil((pageH - r.y + r.size * 0.12) * scale));
  const y0 = Math.max(0, Math.floor((pageH - r.y - r.size * 0.75) * scale));
  const w = Math.min(ctx.canvas.width - x0, x1 - x0); const h = Math.min(ctx.canvas.height - y0, y1 - y0);
  if (w <= 0 || h <= 0) return null;
  let d;
  try { d = ctx.getImageData(x0, y0, w, h).data; } catch { return null; }
  let br = 0; let bg = 0; let bb = 0; let bl = -1;
  for (let i = 0; i < d.length; i += 4) {   // the paper: the lightest pixel here
    const l = d[i] + d[i + 1] + d[i + 2];
    if (l > bl) { bl = l; br = d[i]; bg = d[i + 1]; bb = d[i + 2]; }
  }
  let sr = 0; let sg = 0; let sb = 0; let sw = 0;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb);
    if (dist < 90) continue;
    const k = dist * dist;
    sr += d[i] * k; sg += d[i + 1] * k; sb += d[i + 2] * k; sw += k;
  }
  if (!sw) return null;
  const c = [sr / sw, sg / sw, sb / sw].map((v) => Math.round(v));
  // Anti-aliased black reads as dark grey: a near-neutral dark is black.
  if (Math.max(...c) < 90 && Math.max(...c) - Math.min(...c) < 24) return '000000';
  return c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// One page's runs as LINES of STYLED SEGMENTS: `{ y, size, x0, x1, segs: [{ text,
// family, size, bold, italic, color }] }`, top to bottom. `styleOf(run)` gives a
// run's style. Pure given `styleOf`; exported for tests.
export function styledLines(items, styleOf) {
  const runs = [];
  for (const it of items || []) {
    const str = String(it?.str ?? '');
    if (!str.trim() || !Array.isArray(it.transform)) continue;
    const [a, b, , d, x, y] = it.transform;
    if (Math.abs(b) > Math.abs(a)) continue;
    const size = Math.abs(d) || Math.abs(a) || it.height || 10;
    runs.push({ str, x, y, w: it.width || 0, size, fontName: it.fontName });
  }
  runs.sort((p, q) => q.y - p.y || p.x - q.x);
  const lines = [];
  for (const r of runs) {
    const line = lines.find((l) => Math.abs(l.y - r.y) < Math.max(l.size, r.size) * 0.45);
    if (line) line.runs.push(r); else lines.push({ y: r.y, size: r.size, runs: [r] });
  }
  const same = (p, q) => p.family === q.family && p.size === q.size && p.bold === q.bold && p.italic === q.italic && p.color === q.color;
  return lines.map((l) => {
    l.runs.sort((p, q) => p.x - q.x);
    const segs = [];
    let end = null;
    const weights = new Map();
    for (const r of l.runs) {
      const st = styleOf(r);
      let lead = '';
      if (end !== null && r.x - end > r.size * 3) lead = '\t';
      else if (end !== null && r.x - end > r.size * 0.2 && !/^\s/.test(r.str)) lead = ' ';
      const text = lead + r.str.replace(/[ \t]+/g, ' ');
      const last = segs[segs.length - 1];
      if (last && same(last, st)) last.text += text; else segs.push({ ...st, text });
      end = r.x + r.w;
      weights.set(r.size, (weights.get(r.size) || 0) + r.str.length);
    }
    if (segs.length) segs[0].text = segs[0].text.replace(/^\s+/, '');
    const size = [...weights.entries()].sort((p, q) => q[1] - p[1])[0][0];
    const text = segs.map((g) => g.text).join('');
    return { y: l.y, size, x0: l.runs[0].x, x1: end, segs, text: text.trim() };
  }).filter((l) => l.text);
}

// Styled lines → PARAGRAPHS with their geometry: `{ segs, align, indent,
// firstLine, lineGap, gapBefore, size }` in PDF points, the margins given.
// Pure; exported for tests.
export function styledParagraphs(lines, pageW, margins) {
  if (!lines.length) return [];
  const { left, right } = margins;
  const out = [];
  let cur = null; let prev = null;
  for (const l of lines) {
    const gap = prev ? prev.y - l.y : 0;
    const sameSize = prev && Math.abs(prev.size - l.size) < 0.6;
    const prevFull = prev && prev.x1 > pageW - right - (pageW - left - right) * 0.12;
    const starts = /^(\d+[.)]|[a-z][.)]|[-–•▪◦*]|art\.?\s*\d+|cap\.?\s)/i.test(l.text) || (prev && l.x0 - prev.x0 > l.size * 1.2);
    const joins = cur && sameSize && prevFull && !starts && gap > 0 && gap < l.size * 1.75;
    if (joins) {
      const tail = cur.segs[cur.segs.length - 1];
      const head = l.segs[0];
      const hyphen = /[A-Za-zÀ-ž]-$/.test(tail.text) && /^[a-zà-ž]/.test(head.text);
      if (hyphen) tail.text = tail.text.slice(0, -1); else tail.text += ' ';
      cur.segs.push(...l.segs.map((g) => ({ ...g })));
      cur.lines.push(l);
    } else {
      cur = { segs: l.segs.map((g) => ({ ...g })), lines: [l], gapBefore: prev ? gap : 0, prevSize: prev?.size || 0 };
      out.push(cur);
    }
    prev = l;
  }
  const textW = pageW - left - right;
  return out.map((p) => {
    const first = p.lines[0]; const last = p.lines[p.lines.length - 1];
    const size = first.size;
    const gaps = p.lines.slice(1).map((l, i) => p.lines[i].y - l.y).filter((g) => g > 0);
    const lineGap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : size * 1.18;
    const body = p.lines.length > 1 ? p.lines[1] : first;
    const indent = Math.max(0, body.x0 - left);
    const firstLine = first.x0 - body.x0;
    let align = 'left';
    if (p.lines.length > 1) {
      const full = p.lines.slice(0, -1).every((l) => l.x1 > pageW - right - textW * 0.02);
      if (full) align = 'justify';
    } else {
      const mid = (first.x0 + first.x1) / 2;
      if (Math.abs(mid - (left + textW / 2)) < textW * 0.04 && first.x0 - left > size * 1.2) align = 'center';
      else if (first.x1 > pageW - right - size * 0.6 && first.x0 > left + textW * 0.4) align = 'right';
    }
    return {
      segs: p.segs, size, align,
      indent: align === 'center' || align === 'right' ? 0 : indent,
      firstLine: align === 'center' || align === 'right' ? 0 : firstLine,
      lineGap,
      // The space between the previous paragraph's last baseline and this one's
      // first, less the line this paragraph itself takes.
      gapBefore: p.gapBefore ? Math.max(0, p.gapBefore - lineGap) : 0,
      lines: p.lines.length,
      top: first.y, bottom: last.y,
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
    pages.push({ n, page, width: vp.width, height: vp.height, lines, items: content.items, styles: content.styles, scanned: letters < 12 });
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

  const { Document, Packer, Paragraph, TextRun, AlignmentType, ImageRun, LineRuleType, TabStopType, Tab } = await import('docx');
  const body = bodySizeOf(pages);
  const tw = (pt) => Math.max(0, Math.round(pt * 20));        // points → twips
  const hp = (pt) => Math.max(2, Math.round(pt * 2));          // points → half-points
  const ALIGN = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, left: AlignmentType.LEFT, justify: AlignmentType.JUSTIFIED };
  const sections = [];

  if (aiText) {
    const children = [];
    for (const block of aiText.split(/\n{2,}/)) {
      const text = block.replace(/\s*\n\s*/g, ' ').trim();
      if (text) children.push(new Paragraph({ children: [new TextRun({ text, size: 22 })], spacing: { after: 140 } }));
    }
    sections.push({ children: children.length ? children : [new Paragraph({ children: [] })] });
  } else {
    for (const pg of pages) {
      onProgress?.({ stage: 'build', page: pg.n, pages: pages.length });
      const pageProps = { size: { width: tw(pg.width), height: tw(pg.height) } };
      if (pg.scanned) {
        // A scan: the page itself, filling the page as the PDF did.
        const canvas = await renderPage(pg.page, renderScale(pg.page, 150));
        const png = new Uint8Array(await (await canvasBlob(canvas, 'image/png')).arrayBuffer());
        const wPx = Math.round(pg.width * 96 / 72) - 2; const hPx = Math.round(pg.height * 96 / 72) - 2;
        sections.push({
          properties: { page: { ...pageProps, margin: { top: 0, bottom: 0, left: 0, right: 0, header: 0, footer: 0 } } },
          children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: [new ImageRun({ type: 'png', data: png, transformation: { width: wPx, height: hPx } })] })],
        });
        canvas.width = 0; canvas.height = 0;
        continue;
      }
      // Fonts: loaded with the operator list, then read off pdf.js's font objects.
      const fonts = new Map();
      try { await pg.page.getOperatorList(); } catch { /* fonts fall back to the generic family */ }
      const genericOf = (fontName) => pg.styles?.[fontName]?.fontFamily || '';
      const fontOf = (fontName) => {
        if (fonts.has(fontName)) return fonts.get(fontName);
        let info;
        try {
          const f = pg.page.commonObjs.get(fontName);
          info = fontFromName(f?.name || '', genericOf(fontName));
          if (f?.bold) info.bold = true;
          if (f?.italic) info.italic = true;
        } catch { info = fontFromName('', genericOf(fontName)); }
        fonts.set(fontName, info);
        return info;
      };
      // Colours: sampled off the page rendered at 2×.
      const scale = Math.min(2, renderScale(pg.page, 144));
      const canvas = await renderPage(pg.page, scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const styleOf = (r) => {
        const f = fontOf(r.fontName);
        return { family: f.family, bold: f.bold, italic: f.italic, size: Math.round(r.size * 2) / 2, color: inkColour(ctx, scale, pg.height, r) || '000000' };
      };
      const lines = styledLines(pg.items, styleOf);
      canvas.width = 0; canvas.height = 0;
      // Margins: where the text actually stands on the page.
      const left = Math.max(18, Math.min(...lines.map((l) => l.x0)));
      const right = Math.max(18, pg.width - Math.max(...lines.map((l) => l.x1)));
      const top = Math.max(18, pg.height - Math.max(...lines.map((l) => l.y + l.size * 0.9)));
      const bottom = Math.max(18, Math.min(...lines.map((l) => l.y - l.size * 0.25)));
      const paras = styledParagraphs(lines, pg.width, { left, right });
      const children = paras.map((p) => new Paragraph({
        alignment: ALIGN[p.align],
        indent: { left: tw(p.indent), ...(p.firstLine > 0.5 ? { firstLine: tw(p.firstLine) } : p.firstLine < -0.5 ? { hanging: tw(-p.firstLine) } : {}) },
        spacing: { before: tw(p.gapBefore), after: 0, line: tw(p.lineGap), lineRule: LineRuleType.EXACT },
        tabStops: [{ type: TabStopType.RIGHT, position: tw(pg.width - left - right) }],
        children: p.segs.flatMap((g) => {
          const style = {
            font: g.family, size: hp(g.size), bold: g.bold || undefined, italics: g.italic || undefined,
            color: g.color && g.color !== '000000' ? g.color : undefined,
          };
          // A wide gap on one baseline (two signature blocks) was kept as a tab,
          // which the right-hand tab stop carries to the far margin.
          return g.text.split('	').flatMap((t, i) => [
            ...(i > 0 ? [new TextRun({ ...style, children: [new Tab()] })] : []),
            ...(t ? [new TextRun({ ...style, text: t })] : []),
          ]);
        }),
      }));
      sections.push({
        properties: { page: { ...pageProps, margin: { top: tw(top), bottom: tw(bottom), left: tw(left), right: tw(right), header: 0, footer: 0 } } },
        children: children.length ? children : [new Paragraph({ children: [] })],
      });
    }
  }
  const doc = new Document({
    styles: { default: { document: { run: { size: hp(body) } } } },
    sections,
  });
  const blob = await Packer.toBlob(doc);
  return { blob, pages: pages.length, scanned, usedAi: !!aiText };
}
