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
