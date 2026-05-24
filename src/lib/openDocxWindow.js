// Render a .docx to self-contained HTML with docx-preview and open it in
// a separate window (cloud tab "view"). Chromium can't display .docx
// bytes natively, so we rasterize the document to HTML in the renderer
// (where docx-preview lives) and hand the markup to platform.openHtmlWindow
// — Electron stages it to a temp file + native DocVex window, web writes
// it into a blank tab.
//
// docx-preview is lazy-imported so its (and JSZip's) weight isn't paid
// until the user actually opens a Word doc.

import { openHtmlWindow } from './platform';

// Minimal HTML-attribute/text escape for the <title>.
function escapeHtml(s) {
  return String(s || '').replace(/[<>&"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]
  ));
}

// Fetch the document, render it off-screen, serialize the result (styles
// + body) into one HTML document, and open it in its own window. Returns
// { error } so the caller can fall back to "Open in Word" on failure.
export async function openDocxInWindow({ signedUrl, fileName }) {
  if (!signedUrl) return { error: new Error('No document URL') };

  let blob;
  try {
    const res = await fetch(signedUrl);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    blob = await res.blob();
  } catch (err) {
    return { error: new Error(err?.message || String(err)) };
  }

  // Render into off-screen containers in THIS document, then serialize to
  // a string (so there's no cross-document node transfer when the markup
  // lands in the separate window). Attached off-screen — not just
  // detached — so any layout docx-preview measures resolves correctly.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden;';
  const styleEl = document.createElement('div');
  const bodyEl = document.createElement('div');
  host.appendChild(styleEl);
  host.appendChild(bodyEl);
  document.body.appendChild(host);

  try {
    const { renderAsync } = await import('docx-preview');
    await renderAsync(blob, bodyEl, styleEl, {
      className: 'docx',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
      useBase64URL: true, // inline images so the markup is self-contained
    });

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(fileName || 'Document')}</title>
${styleEl.innerHTML}
<style>
  html, body { margin: 0; background: #444; }
  .docx-wrapper {
    background: #444 !important;
    padding: 24px !important;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
  }
  .docx-wrapper > section.docx {
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4);
    margin: 0 !important;
  }
</style>
</head>
<body>
${bodyEl.innerHTML}
</body>
</html>`;

    openHtmlWindow(html, fileName || 'Document');
    return { error: null };
  } catch (err) {
    return { error: new Error(err?.message || String(err)) };
  } finally {
    document.body.removeChild(host);
  }
}
