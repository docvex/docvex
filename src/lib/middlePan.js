// Middle-button (scroll-wheel press) panning for the Doc Viewer.
//
// Two kinds of view pan differently, and each keeps its own logic:
//   STAGES — a picture, the photo editor, a one-page PDF — move their content
//            with a transform; their own pan handlers take the middle button as
//            well as the left (MediaOcrPane `onStageMouseDown`, PhotoEditor
//            `onStagePointerDown`, FilePreview `onPagesMouseDown`).
//   SCROLLERS — a Word document, a PDF of several pages, the side panel's
//            lists — scroll; a middle press anywhere in one DRAGS it (the
//            content follows the pointer, as with a hand tool). That is this
//            file: one capture-phase listener for the whole viewer, which
//            finds the nearest element that can actually scroll.
//
// A middle press also stops Chromium's own middle-click autoscroll there.

export const PAN_STAGES = '.dv-media-stage, .phe, .file-preview-pdf-scroll.is-single';

function canScroll(el) {
  if (!el || el.nodeType !== 1) return false;
  const cs = getComputedStyle(el);
  const y = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
  const x = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
  return x || y;
}

/** Install on `root` (the viewer's document) → a cleanup function. */
export function installMiddlePan(root = document) {
  const onDown = (e) => {
    if (e.button !== 1) return;
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest(PAN_STAGES)) return;   // a stage pans itself
    let sc = t;
    while (sc && sc !== root.documentElement && !canScroll(sc)) sc = sc.parentElement;
    if (!sc || sc === root.documentElement) return;
    e.preventDefault();
    const x0 = e.clientX; const y0 = e.clientY;
    const left0 = sc.scrollLeft; const top0 = sc.scrollTop;
    root.body.classList.add('dv-media-panning');
    const onMove = (ev) => {
      sc.scrollLeft = left0 - (ev.clientX - x0);
      sc.scrollTop = top0 - (ev.clientY - y0);
    };
    const onUp = (ev) => {
      if (ev.button !== 1) return;
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      root.body.classList.remove('dv-media-panning');
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  };
  // A middle click would otherwise go on to `auxclick` (open-in-new-window on links).
  const onAux = (e) => { if (e.button === 1 && !e.target?.closest?.('a[href]')) e.preventDefault(); };
  root.addEventListener('mousedown', onDown, true);
  root.addEventListener('auxclick', onAux, true);
  return () => {
    root.removeEventListener('mousedown', onDown, true);
    root.removeEventListener('auxclick', onAux, true);
  };
}
