// Best-effort plain-text extraction from a file Blob, for feeding document
// contents to the AI (chat attachments + the drop action sheet's suggestions).
// Handles the formats we can read entirely in the renderer:
//   • text-ish files  — read directly (byte-capped)
//   • PDF             — pdf.js text layer (reuses the shared worker)
//   • Word (.docx)    — docx-preview rendered off-screen, then textContent
//   • Excel (.xlsx/.xls/.xlsm/.xlsb) — SheetJS; cell values AND formulas, so the
//                       AI can review the calculation logic, not just results
// Anything else (images, scanned/text-less PDFs, .doc, binaries) returns an
// `unsupported` error so the caller can fall back to name-only context.

import { loadPdfModule } from './pdfWorker';

// Per-file character cap. Keeps the request reasonable and stays under the
// edge function's per-message limit even with a few files attached.
export const MAX_FILE_TEXT_CHARS = 16000;

// Extensions whose bytes are already plain text.
const TEXT_EXT_RE = /\.(txt|md|markdown|csv|tsv|json|js|jsx|ts|tsx|html|htm|css|scss|xml|yml|yaml|log|ini|env|py|java|c|h|cpp|cs|rb|go|rs|sh|sql|toml|rtf)$/i;

function isTexty(name, mime) {
  return TEXT_EXT_RE.test(name || '') || (mime || '').startsWith('text/');
}

async function extractPdfText(blob) {
  const pdfjs = await loadPdfModule();
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const maxPages = Math.min(doc.numPages, 60);
    let out = '';
    for (let p = 1; p <= maxPages; p += 1) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      out += `${tc.items.map((it) => (it.str ?? '')).join(' ')}\n\n`;
      if (out.length > MAX_FILE_TEXT_CHARS) break;
    }
    return out;
  } finally {
    try { doc.destroy(); } catch { /* ignore */ }
  }
}

async function extractDocxText(blob) {
  // docx-preview renders into a DOM node; we read its text back. Off-screen but
  // attached so any layout it measures resolves. Mirrors lib/openDocxWindow.js.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:800px;height:0;overflow:hidden;visibility:hidden;';
  document.body.appendChild(host);
  try {
    const { renderAsync } = await import('docx-preview');
    await renderAsync(blob, host, undefined, { inWrapper: false, ignoreWidth: true, ignoreHeight: true });
    return host.textContent || '';
  } finally {
    host.remove();
  }
}

// Extract an Excel workbook to text via SheetJS. Each sheet becomes a tab-
// separated grid prefixed with column letters + row numbers, and — crucially —
// any cell formula is appended as `value {=FORMULA}` so the model can audit the
// maths, not just the computed results.
async function extractXlsxText(blob) {
  const XLSX = await import('xlsx');
  const data = new Uint8Array(await blob.arrayBuffer());
  const wb = XLSX.read(data, { type: 'array', cellFormula: true, cellText: true, cellDates: true });
  const MAX_ROWS = 400;
  const MAX_COLS = 40;
  const out = [];
  let total = 0;
  const push = (line) => { out.push(line); total += line.length + 1; };
  const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ').trim();
  for (const name of wb.SheetNames) {
    if (total > MAX_FILE_TEXT_CHARS) break;
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) { push(`# Sheet: ${name} (empty)`); continue; }
    const range = XLSX.utils.decode_range(ws['!ref']);
    const lastR = Math.min(range.e.r, range.s.r + MAX_ROWS - 1);
    const lastC = Math.min(range.e.c, range.s.c + MAX_COLS - 1);
    push(`# Sheet: ${name}`);
    const header = [''];
    for (let C = range.s.c; C <= lastC; C += 1) header.push(XLSX.utils.encode_col(C));
    push(header.join('\t'));
    for (let R = range.s.r; R <= lastR; R += 1) {
      if (total > MAX_FILE_TEXT_CHARS) break;
      const cells = [String(R + 1)];
      let any = false;
      for (let C = range.s.c; C <= lastC; C += 1) {
        const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        if (!cell) { cells.push(''); continue; }
        any = true;
        let v = cell.w != null ? clean(cell.w) : (cell.v != null ? clean(cell.v) : '');
        if (cell.f) v = `${v} {=${clean(cell.f)}}`;
        cells.push(v);
      }
      if (any) push(cells.join('\t'));
    }
    if (lastR < range.e.r || lastC < range.e.c) push('… (sheet truncated)');
  }
  return out.join('\n');
}

// Returns `{ text, truncated }` when readable, or `{ error }` otherwise.
// `text` is whitespace-collapsed and capped at MAX_FILE_TEXT_CHARS.
export async function extractFileText(blob, name = '') {
  const mime = blob?.type || '';
  const lower = (name || '').toLowerCase();
  try {
    let text = '';
    if (/\.pdf$/.test(lower) || mime === 'application/pdf') {
      text = await extractPdfText(blob);
    } else if (/\.docx$/.test(lower) || mime.includes('officedocument.wordprocessingml')) {
      text = await extractDocxText(blob);
    } else if (/\.(xlsx|xlsm|xlsb|xls)$/.test(lower) || mime.includes('spreadsheetml') || mime.includes('ms-excel')) {
      text = await extractXlsxText(blob);
    } else if (isTexty(lower, mime)) {
      // Cap the bytes read so a huge log/CSV doesn't pull megabytes into memory.
      text = await blob.slice(0, 400000).text();
    } else {
      return { error: 'unsupported' };
    }
    text = (text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return { error: 'empty' };
    const truncated = text.length > MAX_FILE_TEXT_CHARS;
    return { text: truncated ? text.slice(0, MAX_FILE_TEXT_CHARS) : text, truncated };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}
