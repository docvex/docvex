import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toLayoutPx } from '../lib/appZoom';
import './Tooltip.css';

// The SELECTED TEXT, in the app's custom tooltip (the `.tooltip` pill), in the
// Doc Viewer: a document's, a PDF's or a picture's text layer, the side
// panel's — anything the window can select. It appears once the selection is
// MADE — when the mouse button is let go (or, selecting with the keyboard,
// when the key comes back up) — never while dragging, and stands UNDER the
// selection, centred on its last line (above it when there is no room below).
// It goes as soon as a new press starts, the selection is cleared, or what it
// sits under scrolls; it never shows for text being typed in a field.
//
// Long selections are cut to MAX_CHARS with "…" and wrap to at most four
// lines; two lines or more take half the one-line pill's radius, the rule
// every tooltip follows (measured, like Tooltip.jsx).

const MAX_CHARS = 280;
const GAP = 8;   // between the selection and the pill
const EDGE = 8;

function selectedText() {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  // A field's own selection (the composer, a rename box) is typing, not reading.
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return '';
  const t = sel.toString().replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS).trimEnd()}…` : t;
}

// The selection's LAST line (where the reader's eye ends) and its whole box.
function selectionBox() {
  try {
    const range = window.getSelection().getRangeAt(0);
    const all = range.getBoundingClientRect();
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const last = rects[rects.length - 1] || all;
    return { all, last };
  } catch { return null; }
}

export default function SelectionTooltip() {
  const [text, setText] = useState('');
  const pillRef = useRef(null);

  useEffect(() => {
    let raf = 0;
    // Shown once the selection is finished: read on the next frame, after the
    // browser has settled the selection the release made.
    const show = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; setText(selectedText()); });
    };
    const hide = () => setText('');
    const onDown = (e) => { if (e.button === 0) hide(); };
    const onUp = (e) => { if (e.button === 0) show(); };
    const onKeyUp = (e) => {
      if (e.key === 'Shift' || (e.shiftKey && /^(Arrow|Home|End|Page)/.test(e.key)) || ((e.ctrlKey || e.metaKey) && e.key === 'a')) show();
    };
    // Cleared by any other means (a click elsewhere, Escape, the page): gone.
    const onChange = () => { if (!window.getSelection?.()?.toString()) hide(); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    window.addEventListener('resize', hide);
    document.addEventListener('selectionchange', onChange);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('scroll', hide, { capture: true });
      window.removeEventListener('resize', hide);
      document.removeEventListener('selectionchange', onChange);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Placed before it paints: measured, then set under the selection.
  useLayoutEffect(() => {
    const pill = pillRef.current;
    if (!pill || !text) return;
    const box = selectionBox();
    if (!box) { setText(''); return; }
    const r = pill.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(pill).lineHeight) || 12;
    pill.classList.toggle('is-multiline', r.height > lh * 1.6 + 12);
    const w = toLayoutPx(r.width);
    const h = toLayoutPx(r.height);
    const vw = toLayoutPx(window.innerWidth);
    const vh = toLayoutPx(window.innerHeight);
    const cx = toLayoutPx(box.last.left + box.last.width / 2);
    const left = Math.max(EDGE, Math.min(cx - w / 2, vw - EDGE - w));
    let top = toLayoutPx(box.all.bottom) + GAP;
    if (top + h > vh - EDGE) top = Math.max(EDGE, toLayoutPx(box.all.top) - GAP - h);
    pill.style.transform = `translate(${left}px, ${top}px)`;
  }, [text]);

  if (!text) return null;
  return createPortal(
    <div ref={pillRef} className="tooltip dv-sel-tooltip" role="status" aria-live="polite" data-no-i18n="" data-no-lawdetect="">
      {text}
    </div>,
    document.body,
  );
}
