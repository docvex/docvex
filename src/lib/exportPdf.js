// Convert a rendered office preview into a real PDF, client-side. The Doc Viewer
// already renders .docx (docx-preview), .pptx (our OOXML renderer) and .xlsx
// (SheetJS → table) to the DOM, so we capture those nodes with html2canvas and
// pack the bitmaps into a PDF with jsPDF — a WYSIWYG "export to PDF" that needs
// no server round-trip and no LibreOffice. Both libs are lazy-loaded so their
// weight is only paid when an export actually runs.

let _libs = null;
async function libs() {
  if (!_libs) {
    const [pdfMod, h2cMod] = await Promise.all([import('jspdf'), import('html2canvas')]);
    _libs = {
      JsPDF: pdfMod.jsPDF || pdfMod.default || pdfMod,
      html2canvas: h2cMod.default || h2cMod,
    };
  }
  return _libs;
}

const CAPTURE = { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false };

// One PDF page per element, each page sized to that element's bitmap (so a deck
// gets one page per slide, a paginated doc one page per page). Orientation is
// derived per element from its aspect ratio.
export async function elementsToPdfBlob(elements, { quality = 0.92 } = {}) {
  const els = [...elements].filter(Boolean);
  if (!els.length) throw new Error('nothing to export');
  const { JsPDF, html2canvas } = await libs();
  let doc = null;
  for (const el of els) {
    const canvas = await html2canvas(el, CAPTURE);
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) continue;
    const orient = w >= h ? 'landscape' : 'portrait';
    if (!doc) doc = new JsPDF({ orientation: orient, unit: 'px', format: [w, h], compress: true });
    else doc.addPage([w, h], orient);
    doc.addImage(canvas.toDataURL('image/jpeg', quality), 'JPEG', 0, 0, w, h);
  }
  if (!doc) throw new Error('nothing to export');
  return doc.output('blob');
}

// One tall capture of a flowing node (a spreadsheet table, a continuous doc),
// sliced into A4-proportioned portrait pages.
export async function flowToPdfBlob(node, { quality = 0.92 } = {}) {
  if (!node) throw new Error('nothing to export');
  const { JsPDF, html2canvas } = await libs();
  const canvas = await html2canvas(node, CAPTURE);
  const pageW = canvas.width;
  if (!pageW || !canvas.height) throw new Error('nothing to export');
  const pageH = Math.max(1, Math.round((pageW * 297) / 210)); // A4 portrait aspect
  const doc = new JsPDF({ orientation: 'portrait', unit: 'px', format: [pageW, pageH], compress: true });
  let y = 0;
  let first = true;
  while (y < canvas.height) {
    const sliceH = Math.min(pageH, canvas.height - y);
    const slice = document.createElement('canvas');
    slice.width = pageW;
    slice.height = sliceH;
    slice.getContext('2d').drawImage(canvas, 0, y, pageW, sliceH, 0, 0, pageW, sliceH);
    if (!first) doc.addPage([pageW, pageH], 'portrait');
    doc.addImage(slice.toDataURL('image/jpeg', quality), 'JPEG', 0, 0, pageW, sliceH);
    first = false;
    y += sliceH;
  }
  return doc.output('blob');
}

// Capture a rendered office preview to a PDF Blob. `root` is the rendered node;
// `kind` picks the strategy (docx/pptx have per-page/per-slide elements; sheets
// flow). Falls back to a flow capture of the root when no page/slide nodes exist.
export async function renderedOfficeToPdfBlob(root, kind) {
  if (!root) throw new Error('nothing to export');
  if (kind === 'pptx') {
    const slides = root.querySelectorAll('.dv-ppx-slide');
    if (slides.length) return elementsToPdfBlob(slides);
  }
  if (kind === 'docx') {
    const pages = root.querySelectorAll('.dv-docx-page');
    if (pages.length) return elementsToPdfBlob(pages);
  }
  return flowToPdfBlob(root);
}
