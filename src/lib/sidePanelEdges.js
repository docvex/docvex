// Keeps a column that stands beside the Doc Viewer's floating side panel (the
// page list of a Word file / a PDF) LEVEL with it: its top at the top of the
// panel's topmost card (the Quick actions card when there is one, else the side
// panel itself) and its bottom at the side panel's bottom.
//
// The panel floats at a fixed inset of the viewer's main row, but the column
// lives inside a pane whose own top isn't the row's (a header, a padding…), so
// the right offsets can't be written down in CSS — they are MEASURED, and
// handed to the element as `--rail-top` / `--rail-bottom` (layout px from its
// offset parent's edges; the stylesheet falls back to the panel's 8px inset).
// Re-measured when the window, the cards or the element's frame change size.
import { toLayoutPx } from './appZoom';

export function alignWithSidePanel(el) {
  if (!el || typeof window === 'undefined') return () => {};
  // An absolutely placed column is offset from its offset parent; one in the
  // flow (the PDF's) from the box it sits in.
  const frameOf = () => (getComputedStyle(el).position === 'absolute' ? el.offsetParent : null) || el.parentElement;
  const measure = () => {
    const cards = Array.from(document.querySelectorAll('.dv-quick-card, .dv-advisor-card'))
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.height > 1 && r.width > 1);
    const frame = frameOf()?.getBoundingClientRect();
    if (!cards.length || !frame) { el.style.removeProperty('--rail-top'); el.style.removeProperty('--rail-bottom'); return; }
    const top = Math.min(...cards.map((r) => r.top));
    const bottom = Math.max(...cards.map((r) => r.bottom));
    // Only written when it changed: this runs per frame while things settle.
    const t = `${Math.max(0, Math.round(toLayoutPx(top - frame.top)))}px`;
    const b = `${Math.max(0, Math.round(toLayoutPx(frame.bottom - bottom)))}px`;
    if (el.style.getPropertyValue('--rail-top') !== t) el.style.setProperty('--rail-top', t);
    if (el.style.getPropertyValue('--rail-bottom') !== b) el.style.setProperty('--rail-bottom', b);
  };
  measure();
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
  if (ro) {
    ro.observe(document.body);
    const frame = frameOf();
    if (frame) ro.observe(frame);
    document.querySelectorAll('.dv-quick-card, .dv-advisor-card').forEach((c) => ro.observe(c));
  }
  window.addEventListener('resize', measure);
  // The cards MOVE without changing size — they slide in when the viewer opens,
  // the Quick actions card appears (and pushes the side panel down) a moment
  // after the pane mounts, its content is portalled in later still. A size
  // observer sees none of that, so: every frame for the first two seconds (cheap
  // — a few rects), then whenever a transition or animation ends anywhere, and
  // whenever the Quick actions card's content changes.
  let raf = 0;
  const until = performance.now() + 2000;
  const settle = () => { measure(); raf = performance.now() < until ? requestAnimationFrame(settle) : 0; };
  raf = requestAnimationFrame(settle);
  document.addEventListener('transitionend', measure, true);
  document.addEventListener('animationend', measure, true);
  const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
  document.querySelectorAll('.dv-quick-card').forEach((c) => mo?.observe(c, { childList: true, subtree: true }));
  return () => {
    ro?.disconnect();
    mo?.disconnect();
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('resize', measure);
    document.removeEventListener('transitionend', measure, true);
    document.removeEventListener('animationend', measure, true);
  };
}

// ── How much of a document pane the side panel covers ──────────────────────
// The document panes run EDGE TO EDGE with the side panel painted over them
// (--dv-doc-inset, DocViewer.css), so a pane's `clientWidth` is no longer the
// width a page has to live in: the leftmost slice of it is behind the panel.
// Every width-based calculation — fit-to-width, the zoom's "keep the middle of
// the view in the middle", a one-page stage's centring — has to subtract this
// or the document is sized and centred for a viewport partly nobody can see.
//
// Read off `--dv-advisor-w` rather than `--dv-doc-inset`: a custom property's
// computed value keeps its calc() unevaluated, so the composed one comes back
// as the string "calc(360px + 16px)" and cannot be parsed. The panel's own
// width is a plain inline px value, and `+ 16` is the gutter beside it. It goes
// to -16px when the panel is hidden, which is exactly what makes this zero.
export function docInset(el) {
  if (!el || typeof getComputedStyle !== 'function') return 0;
  const w = parseFloat(getComputedStyle(el).getPropertyValue('--dv-advisor-w'));
  return Number.isFinite(w) ? Math.max(0, w + 16) : 0;
}
