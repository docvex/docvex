// A PICTURE OF A DOCUMENT → an editable Word document. The Doc Viewer's
// Convert, for pictures (a phone photo of a contract, a scan saved as JPG).
//
// A picture has no text at all, so the document is RECONSTRUCTED: the picture
// goes to the AI (project-ai `ask`, sonnet — the same call path Extract text
// uses), which answers with the page's STRUCTURE and its LOOK as data —
// headings, paragraphs with their alignment, lists keeping the document's own
// numbering, tables, signature lines; the page size and margins, the default
// font; per block its font, size, colour, bold / italic / underline, spacing,
// indents and line spacing, and runs where the styling changes mid-paragraph —
// in the page's own language, nothing added. A photo carries no font data, so
// the look is READ OFF THE PICTURE (the closest common font, sizes judged
// against the page): close, not certain. The .docx is then
// BUILT here from that structure with the `docx` library (no AI in the file
// itself, so what is written is exactly what was read). A picture that is not
// a document answers `{ document: false }` and nothing is written.
//
//   pictureToWord(imgEl, { projectId }) → { ok, blob, blocks } | { ok: false, error }
//   parseReconstruction(text)           → { document, blocks } | null   (exported for tests)
//   buildWordFromBlocks(blocks, { page, font }) → Blob (.docx)          (exported for tests)

import { isCloudMediaAllowed, CLOUD_MEDIA_MESSAGE, CLOUD_MEDIA_OFF } from './cloudMedia';

const MODEL = 'claude-sonnet-4-6';
const MAX_EDGE = 2200;   // long side sent to the AI — enough for small print, under the API's limits

export const PROMPT = `This picture is a photograph or scan of a document. Reconstruct it as a Word document.

Transcribe EXACTLY what is written, in the document's own language and spelling (keep diacritics). Add nothing, summarise nothing, translate nothing. Ignore everything that is not the page: the table it lies on, fingers, shadows, the photo's edges. Keep the document's own numbering and markers as written ("1.", "Art. 3", "a)", "•") inside the text.

Reproduce its LOOK as exactly as you can read it off the picture: the page size and margins, the typeface (name the closest common font — "Times New Roman", "Arial", "Calibri", "Cambria", "Georgia", "Verdana", "Courier New", "Garamond"…), every size in points judged against the page's width (an A4 page is 595pt wide), colours as hex, bold / italic / underline, alignment, indents, the space above and below each paragraph, and line spacing.

Answer with JSON only, no prose, in this shape:
{"document": true,
 "page": {"size": "A4|Letter|Legal", "orientation": "portrait|landscape", "margins_mm": {"top": 20, "bottom": 20, "left": 25, "right": 15}},
 "font": {"family": "Times New Roman", "size": 12, "color": "000000"},
 "blocks": [
  {"type": "heading", "level": 1, "text": "…", "align": "center", "font": "…", "size": 16, "color": "1F3864", "bold": true, "spaceBefore": 0, "spaceAfter": 12},
  {"type": "paragraph", "text": "… **bold words** … *italic* …", "align": "left|center|right|justify", "size": 12, "indent_mm": 0, "firstLine_mm": 10, "lineSpacing": 1.15, "spaceAfter": 6},
  {"type": "paragraph", "runs": [{"text": "Între "}, {"text": "SC Alfa SRL", "bold": true}, {"text": " și ", "color": "C00000", "underline": true}], "align": "justify"},
  {"type": "list", "items": ["1. …", "2. …"], "indent_mm": 6, "size": 12},
  {"type": "table", "rows": [["cell", "cell"], ["cell", "cell"]], "header": true, "colWidths_pct": [30, 70], "borders": true, "headerFill": "D9D9D9", "size": 11},
  {"type": "signature", "left": "…", "right": "…"},
  {"type": "pagebreak"}
]}
Every style field is optional: leave out what is the document's default ("font") and give only what differs. Use "runs" instead of "text" when the styling changes inside a paragraph in ways ** / * cannot say (colour, size, underline, another font).

TABLES: use "table" ONLY for a real table — one drawn with visible ruled lines (cell borders, a grid, shaded header cells). Official documents almost never contain invisible tables. Text that is merely laid out — a letterhead centred across the page (with or without logos beside it; the logos themselves are not text and are left out), a title block, label: value lines, columns that only line up — is NOT a table: write it as headings and paragraphs with the right "align" (a centred letterhead line is a centred paragraph or heading). When in doubt, it is not a table.

level 1 = the document's title, 2 = a section heading, 3 = a sub-heading. A paragraph is one paragraph of the document (join the lines the photo wrapped). Two blocks of text side by side at the foot (the parties signing) are one "signature" block. A blank to fill in stays as written ("________", "..........").
If the picture is NOT a document with text to rebuild (a photo of a person, a landscape, a screenshot of an app), answer {"document": false}.`;

// The picture on screen, drawn to a JPEG no longer than MAX_EDGE on its long side.
function pictureJpeg(img) {
  const w0 = img.naturalWidth || img.width; const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new Error('The picture hasn’t loaded yet.');
  const k = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9).split(',')[1];
}

// Style fields, checked: a font name, a size in points, a hex colour, flags,
// spacing in points, indents in mm, a line-spacing multiple.
const hex = (v) => (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().replace('#', '').toUpperCase() : null);
const ptSize = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 5 && n <= 96 ? n : null; };
const fontName = (v) => (typeof v === 'string' && /^[A-Za-z0-9 .\-]{2,40}$/.test(v.trim()) ? v.trim() : null);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
function styleFields(b) {
  const out = {};
  const f = fontName(b.font); if (f) out.font = f;
  const z = ptSize(b.size); if (z) out.size = z;
  const c = hex(b.color); if (c) out.color = c;
  if (b.bold === true) out.bold = true; if (b.bold === false) out.bold = false;
  if (b.italic === true) out.italic = true;
  if (b.underline === true) out.underline = true;
  const sb = num(b.spaceBefore, 0, 200); if (sb != null) out.spaceBefore = sb;
  const sa = num(b.spaceAfter, 0, 200); if (sa != null) out.spaceAfter = sa;
  const ls = num(b.lineSpacing, 0.8, 3); if (ls != null) out.lineSpacing = ls;
  const ind = num(b.indent_mm, 0, 150); if (ind != null) out.indentMm = ind;
  const fl = num(b.firstLine_mm, -60, 60); if (fl != null) out.firstLineMm = fl;
  return out;
}

/** The AI's answer → `{ document, blocks, page, font }`, or null when it can't be read. */
export function parseReconstruction(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.document === false) return { document: false, blocks: [] };
  const blocks = (Array.isArray(obj.blocks) ? obj.blocks : []).map((b) => {
    if (!b || typeof b !== 'object') return null;
    const align = ['left', 'center', 'right', 'justify'].includes(b.align) ? b.align : null;
    const st = styleFields(b);
    const runs = Array.isArray(b.runs) ? b.runs.map((r) => (r && typeof r === 'object' && r.text != null ? { text: String(r.text), ...styleFields(r) } : null)).filter(Boolean) : null;
    const text = String(b.text || (runs ? runs.map((r) => r.text).join('') : ''));
    switch (b.type) {
      case 'heading': return { type: 'heading', level: Math.min(3, Math.max(1, Number(b.level) || 2)), text, runs, align, ...st };
      case 'paragraph': return { type: 'paragraph', text, runs, align, ...st };
      case 'list': return { type: 'list', items: (Array.isArray(b.items) ? b.items : []).map(String).filter(Boolean), ...st };
      case 'table': {
        const rows = (Array.isArray(b.rows) ? b.rows : []).filter(Array.isArray).map((r) => r.map((c) => String(c ?? '')));
        // A table with no drawn lines is almost never a table in an official
        // document — it is text laid out (a centred letterhead beside two
        // logos, label: value lines). It is rebuilt as paragraphs: one per
        // row, a lone cell in an inner column read as centred.
        if (b.borders === false) {
          return rows.flatMap((r) => {
            const filled = r.map((c, i) => ({ c: c.trim(), i })).filter((x) => x.c);
            if (!filled.length) return [];
            const lone = filled.length === 1 && r.length >= 3 && filled[0].i > 0 && filled[0].i < r.length - 1;
            const rowAlign = lone ? 'center' : align;
            return filled.map((x) => x.c).join('   ').split(/\n+/).map((line) => line.trim()).filter(Boolean)
              .map((line) => ({ type: 'paragraph', text: line, align: rowAlign, ...st }));
          });
        }
        const widths = Array.isArray(b.colWidths_pct) ? b.colWidths_pct.map(Number).filter((n) => n > 0) : null;
        return rows.length ? { type: 'table', rows, header: !!b.header, borders: b.borders !== false, widths, headerFill: hex(b.headerFill), ...st } : null;
      }
      case 'signature': return { type: 'signature', left: String(b.left || ''), right: String(b.right || ''), ...st };
      case 'pagebreak': return { type: 'pagebreak' };
      default: return text ? { type: 'paragraph', text, runs, align, ...st } : null;
    }
  }).flat().filter((b) => b && (b.type === 'pagebreak' || b.type === 'table' || b.type === 'signature' || (b.text || b.items?.length)));
  const pg = obj.page && typeof obj.page === 'object' ? obj.page : {};
  const m = pg.margins_mm && typeof pg.margins_mm === 'object' ? pg.margins_mm : {};
  const mm = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 80 ? Number(v) : d);
  const page = {
    size: ['A4', 'Letter', 'Legal'].includes(pg.size) ? pg.size : 'A4',
    landscape: pg.orientation === 'landscape',
    margins: { top: mm(m.top, 20), bottom: mm(m.bottom, 20), left: mm(m.left, 25), right: mm(m.right, 20) },
  };
  const font = obj.font && typeof obj.font === 'object'
    ? { family: fontName(obj.font.family) || 'Times New Roman', size: ptSize(obj.font.size) || 12, color: hex(obj.font.color) }
    : { family: 'Times New Roman', size: 12, color: null };
  return { document: blocks.length > 0, blocks, page, font };
}

// A run's look → docx TextRun options.
function runStyle(st = {}) {
  const o = {};
  if (st.font) o.font = st.font;
  if (st.size) o.size = Math.round(st.size * 2);
  if (st.color && st.color !== '000000') o.color = st.color;
  if (st.bold != null) o.bold = st.bold;
  if (st.italic) o.italics = true;
  if (st.underline) o.underline = {};
  return o;
}

// A block's text → TextRuns: its own `runs` when the AI gave them, else
// "**bold** and *italic*" read out of the text — all in the block's look.
function runs(TextRun, text, base = {}, list = null) {
  if (list?.length) return list.map((r) => new TextRun({ ...runStyle({ ...base, ...r }), text: r.text }));
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0; let m;
  const s = String(text || '');
  const baseRun = runStyle(base);
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(new TextRun({ ...baseRun, text: s.slice(last, m.index) }));
    const bold = m[0].startsWith('**');
    out.push(new TextRun({ ...baseRun, text: m[0].replace(/^\*\*?|\*\*?$/g, ''), ...(bold ? { bold: true } : { italics: true }) }));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(new TextRun({ ...baseRun, text: s.slice(last) }));
  return out.length ? out : [new TextRun({ ...baseRun, text: '' })];
}

const MM = 56.6929;   // twips per millimetre
const PAGE_SIZES = { A4: [11906, 16838], Letter: [12240, 15840], Legal: [12240, 20160] };

/**
 * The reconstructed structure → a real .docx, in the page's LOOK: `page`
 * (size, orientation, margins in mm) and `font` (the default family / size /
 * colour) from the reconstruction; each block's own style on top.
 */
export async function buildWordFromBlocks(blocks, { page = null, font = null } = {}) {
  const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle, PageBreak, ShadingType, LineRuleType } = docx;
  const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED };
  const line = { style: BorderStyle.SINGLE, size: 4, color: '808080' };
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const def = { family: font?.family || 'Times New Roman', size: font?.size || 12, color: font?.color || null };
  // Headings with no size of their own are sized off the body, as documents are.
  const HEAD_SCALE = { 1: 1.35, 2: 1.15, 3: 1.05 };
  const spacing = (b, after = 6) => ({
    before: Math.round((b.spaceBefore ?? 0) * 20),
    after: Math.round((b.spaceAfter ?? after) * 20),
    ...(b.lineSpacing ? { line: Math.round(b.lineSpacing * 240), lineRule: LineRuleType.AUTO } : {}),
  });
  const indent = (b) => ({
    ...(b.indentMm ? { left: Math.round(b.indentMm * MM) } : {}),
    ...(b.firstLineMm > 0 ? { firstLine: Math.round(b.firstLineMm * MM) } : b.firstLineMm < 0 ? { hanging: Math.round(-b.firstLineMm * MM) } : {}),
  });
  const look = (b) => ({ font: b.font, size: b.size, color: b.color, bold: b.bold, italic: b.italic, underline: b.underline });
  const children = [];
  for (const b of blocks || []) {
    if (b.type === 'heading') {
      const st = { bold: true, ...look(b), size: b.size || Math.round(def.size * (HEAD_SCALE[b.level] || 1.1) * 2) / 2 };
      children.push(new Paragraph({ alignment: ALIGN[b.align] || (b.level === 1 ? AlignmentType.CENTER : undefined), children: runs(TextRun, b.text, st, b.runs), spacing: spacing(b, 8), indent: indent(b), keepNext: true }));
    } else if (b.type === 'paragraph') {
      children.push(new Paragraph({ alignment: ALIGN[b.align] || AlignmentType.LEFT, children: runs(TextRun, b.text, look(b), b.runs), spacing: spacing(b), indent: indent(b) }));
    } else if (b.type === 'list') {
      // The document's own markers stay in the text; a hanging indent lines the items up.
      const ind = { left: Math.round((b.indentMm ?? 10) * MM), hanging: 340 };
      for (const it of b.items) children.push(new Paragraph({ children: runs(TextRun, it, look(b)), indent: ind, spacing: spacing(b, 3) }));
    } else if (b.type === 'table') {
      const cols = Math.max(...b.rows.map((r) => r.length));
      const border = b.borders ? line : none;
      const widths = b.widths?.length === cols ? b.widths : null;
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map((r, ri) => new TableRow({
          tableHeader: b.header && ri === 0,
          children: Array.from({ length: cols }, (_, ci) => new TableCell({
            borders: { top: border, bottom: border, left: border, right: border },
            ...(widths ? { width: { size: widths[ci], type: WidthType.PERCENTAGE } } : {}),
            ...(b.header && ri === 0 && b.headerFill ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: b.headerFill } } : {}),
            children: [new Paragraph({ children: runs(TextRun, r[ci] || '', { ...look(b), ...(b.header && ri === 0 ? { bold: true } : {}) }) })],
          })),
        })),
      }));
      children.push(new Paragraph({ children: [] }));
    } else if (b.type === 'signature') {
      const cell = (t, align) => new TableCell({
        borders: { top: none, bottom: none, left: none, right: none },
        children: String(t || '').split(/\n/).map((l) => new Paragraph({ alignment: align, children: runs(TextRun, l, look(b)) })),
      });
      children.push(new Paragraph({ children: [], spacing: { before: 240 } }));
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
        rows: [new TableRow({ children: [cell(b.left, AlignmentType.LEFT), cell(b.right, AlignmentType.RIGHT)] })],
      }));
    } else if (b.type === 'pagebreak') {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }
  if (!children.length) children.push(new Paragraph({ children: [] }));
  const [pw, ph] = PAGE_SIZES[page?.size] || PAGE_SIZES.A4;
  const land = !!page?.landscape;
  const mg = page?.margins || { top: 20, bottom: 20, left: 25, right: 20 };
  const doc = new Document({
    styles: { default: { document: { run: { font: def.family, size: Math.round(def.size * 2), ...(def.color && def.color !== '000000' ? { color: def.color } : {}) } } } },
    sections: [{
      properties: { page: {
        size: { width: land ? ph : pw, height: land ? pw : ph },
        margin: { top: Math.round(mg.top * MM), bottom: Math.round(mg.bottom * MM), left: Math.round(mg.left * MM), right: Math.round(mg.right * MM) },
      } },
      children,
    }],
  });
  return Packer.toBlob(doc);
}

/** The picture on screen → a reconstructed Word document. */
export async function pictureToWord(img, { projectId } = {}) {
  // The whole picture goes to the AI: only with cloud reading allowed.
  if (!isCloudMediaAllowed(projectId || undefined)) return { ok: false, error: CLOUD_MEDIA_MESSAGE, code: CLOUD_MEDIA_OFF };
  let data;
  try { data = pictureJpeg(img); } catch (e) { return { ok: false, error: e?.message || 'unreadable' }; }
  const askAi = (await import('./aiEngine')).askAi;
  const res = await askAi({
    surface: 'tool', timeoutMs: 180_000,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
      { type: 'text', text: PROMPT },
    ] }],
    model: MODEL,
    usageProject: projectId,
    usageAction: 'image-to-word',
  });
  if (res?.error) return { ok: false, error: String(res.error?.message || res.error) };
  const parsed = parseReconstruction(res.text);
  if (!parsed) return { ok: false, error: 'The AI’s answer couldn’t be read — try again.' };
  if (!parsed.document) return { ok: false, error: 'not_a_document' };
  const blob = await buildWordFromBlocks(parsed.blocks, { page: parsed.page, font: parsed.font });
  return { ok: true, blob, blocks: parsed.blocks };
}
