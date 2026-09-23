import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getCachedPdf } from '../lib/pdfCache';
import { loadPdfModule } from '../lib/pdfWorker';
import Tooltip from './Tooltip';
import { alignWithSidePanel } from '../lib/sidePanelEdges';

// Preview renderer for the FileDetailModal's preview pane.
// Dispatches by MIME to one of:
//   • <ImagePreview>  — image/*           (<img> of the original)
//   • <VideoPreview>  — video/*           (native <video controls> of the original)
//   • <PdfPreview>    — application/pdf   (pdf.js renders EVERY page, lazily, in a scrolling column)
//   • <TextPreview>   — text/*            (fetched body, capped at 1 MB)
// Anything else renders a fallback "no preview" panel with a hint to
// use the View button in the right pane.
//
// signedUrl is the 10-minute signed URL for the source file. onOpen is
// the modal's handleView callback — fired when the user clicks the
// preview pane so the whole preview reads as a "tap to open" surface.

// Hard cap on text preview fetch — a giant log file would lock the
// modal otherwise. The fallback message points the user at View, which
// downloads the full file via the same signed URL.
const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

// External-link arrow used inside the hover-revealed "Open" hint pill.
// Inline so we don't pull an icon dep for one glyph.
const OpenIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

// Wrap a child node in a clickable surface that opens the full file
// when activated. Centralised so every sub-renderer gets the same
// hover hint, focus ring, and keyboard semantics. The hint pill is
// pinned in the corner via the stylesheet — only visible on hover or
// keyboard focus so it doesn't clutter the preview itself.
//
// When `onOpen` is null (e.g. DOCX in the version-control inspector,
// where opening the file would trigger a browser download rather than
// an inline view), render children directly with no button wrapper —
// the preview pane stays purely visual.
function ClickablePreview({ onOpen, children, ariaLabel }) {
  if (!onOpen) return children;
  return (
    <Tooltip content="Click to open">
      <button
        type="button"
        className="file-preview-clickable"
        onClick={onOpen}
        aria-label={ariaLabel}
      >
        {children}
        <span className="file-preview-open-hint">
          {OpenIcon}
          <span>Open</span>
        </span>
      </button>
    </Tooltip>
  );
}

// Generic "no preview" panel — used for unsupported MIMEs AND as the
// error fallback for the type-specific renderers when something goes
// wrong (pdf.js worker fails, video codec unsupported, etc.). Hint
// directs the user to the right-pane View action.
function NoPreview({ reason, canOpen = true }) {
  return (
    <div className="file-preview-empty">
      <p className="file-preview-empty-title">No preview available</p>
      {reason && <p className="file-preview-empty-reason">{reason}</p>}
      {canOpen && (
        <p className="file-preview-empty-hint">Use the <strong>View</strong> button to open the file in a new tab.</p>
      )}
    </div>
  );
}

// ── Image ────────────────────────────────────────────────────────────────
function ImagePreview({ signedUrl, file, onOpen }) {
  const [errored, setErrored] = useState(false);
  if (errored) return <NoPreview reason={`Image failed to load: ${file.name}`} />;
  return (
    <ClickablePreview onOpen={onOpen} ariaLabel={`Open ${file.name}`}>
      <div className="file-preview-image">
        <img
          src={signedUrl}
          alt={file.name}
          onError={() => setErrored(true)}
          draggable={false}
        />
      </div>
    </ClickablePreview>
  );
}

// ── Video ────────────────────────────────────────────────────────────────
// Mounts a native <video controls> element with the original file. NOT
// wrapped in ClickablePreview because the click-to-open surface would
// intercept the native play/pause/scrub controls.
function VideoPreview({ signedUrl }) {
  if (!signedUrl) return <div className="file-preview-loading">Loading video…</div>;
  return (
    <div className="file-preview-video">
      <video src={signedUrl} controls preload="metadata" />
    </div>
  );
}

// ── PDF ──────────────────────────────────────────────────────────────────
// EVERY page of the PDF, stacked in a scrolling column at the pane's width (it
// used to draw page 1 only — a leftover from when this was a thumbnail-sized
// preview). A page is only PAINTED while it is near the viewport and its canvas
// is given back when it scrolls far away, so a 300-page file costs a handful of
// canvases, not 300; until a page is painted its holder already has the page's
// real proportions, so the scrollbar is honest from the start.
const PDF_MAX_PAGE_WIDTH = 1100;
const PDF_PAGE_GUTTER = 16;
// A fitted page doesn't touch the pane: this much air above and under it (the
// page column is padded by the same, so the first page can sit that far down).
const PDF_FIT_GAP = 12;
// Text layers are light (spans, no pixels). For a document of ordinary length
// they are all laid at once, so the Doc Viewer's find bar reaches every page,
// not only the ones scrolled past; a very long one gets them page by page.
const PDF_EAGER_TEXT_PAGES = 60;

function PdfPage({ pdf, n, width, paintWidth, fallbackRatio, scrollRoot, eagerText }) {
  const holderRef = useRef(null);
  const canvasRef = useRef(null);
  // A transparent copy of the page's text, positioned over the canvas. The
  // canvas is pixels — nothing in it can be selected, searched or read by a
  // screen reader — so pdf.js's text layer is what makes a PDF behave like a
  // document rather than a picture of one. The Doc Viewer's find bar walks
  // exactly these nodes.
  const textLayerRef = useRef(null);
  const taskRef = useRef(null);
  const textWidthRef = useRef(0);
  const [textWidth, setTextWidth] = useState(0);   // the width the text layer was laid at
  const [page, setPage] = useState(null);
  const [near, setNear] = useState(false);
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPage(null); setPainted(false); textWidthRef.current = 0;
    pdf.getPage(n).then((pg) => { if (!cancelled) setPage(pg); }).catch(() => {});
    return () => { cancelled = true; };
  }, [pdf, n]);

  // Near the viewport = within about two screens of it.
  useEffect(() => {
    const el = holderRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return undefined; }
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { root: scrollRoot || null, rootMargin: '1400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRoot]);

  const base = page ? page.getViewport({ scale: 1 }) : null;
  const ratio = base ? base.height / base.width : fallbackRatio;

  // Paint while near; give the pixels back when far.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    if (!near || !page || !paintWidth) {
      if (!near && canvas.width) { canvas.width = 0; canvas.height = 0; setPainted(false); }
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const scale = paintWidth / page.getViewport({ scale: 1 }).width;
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr });
        // Painted OFF-screen and swapped in when done: resizing the visible
        // canvas would blank the page for the length of the render, and during
        // a zoom the old pixels (stretched by CSS) are what should stay up.
        const next = document.createElement('canvas');
        next.width = Math.round(viewport.width);
        next.height = Math.round(viewport.height);
        const ctx = next.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, next.width, next.height);
        const task = page.render({ canvasContext: ctx, viewport, canvas: next });
        taskRef.current = task;
        await task.promise;
        if (taskRef.current === task) taskRef.current = null;
        if (cancelled) return;
        canvas.width = next.width;
        canvas.height = next.height;
        canvas.getContext('2d').drawImage(next, 0, 0);
        next.width = 0; next.height = 0;
        setPainted(true);
      } catch { /* cancelled by a newer paint, or an unrenderable page — the holder stays blank */ }
    })();
    return () => {
      cancelled = true;
      if (taskRef.current) { try { taskRef.current.cancel(); } catch { /* ignore */ } taskRef.current = null; }
    };
  }, [near, page, paintWidth]);

  // Text layer, at CSS scale (the canvas is oversampled by dpr; the overlay is
  // not). Best-effort: a scanned page has no text, and a failure here must
  // never cost the rendered page. Laid once per width and kept.
  useEffect(() => {
    const layer = textLayerRef.current;
    if (!layer || !page || !paintWidth || !(near || eagerText) || textWidthRef.current === paintWidth) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const scale = paintWidth / page.getViewport({ scale: 1 }).width;
        const cssViewport = page.getViewport({ scale });
        const pdfjs = await loadPdfModule();
        const textContent = await page.getTextContent();
        if (cancelled) return;
        layer.replaceChildren();
        layer.style.setProperty('--scale-factor', String(scale));
        layer.style.setProperty('--total-scale-factor', String(scale));   // pdf.js 5's name for it
        if (pdfjs.TextLayer) {
          await new pdfjs.TextLayer({ textContentSource: textContent, container: layer, viewport: cssViewport }).render();
        } else if (pdfjs.renderTextLayer) {
          await pdfjs.renderTextLayer({ textContentSource: textContent, container: layer, viewport: cssViewport }).promise;
        }
        if (!cancelled) { textWidthRef.current = paintWidth; setTextWidth(paintWidth); }
      } catch { /* no text on this page, or an older pdf.js — the page still renders */ }
    })();
    return () => { cancelled = true; };
  }, [near, eagerText, page, paintWidth]);

  return (
    <div
      className="file-preview-pdf-stack file-preview-pdf-page"
      ref={holderRef}
      data-page={n}
      style={{ width: `${width}px`, height: `${Math.round(width * ratio)}px` }}
    >
      <canvas ref={canvasRef} className={`file-preview-pdf-canvas${painted ? ' is-visible' : ''}`} />
      {/* Laid at `textWidth`, SCALED to the width shown — so the text sits on its
          glyphs through a zoom's glide too, not only once it settles. */}
      <div
        className="file-preview-pdf-text"
        ref={textLayerRef}
        aria-hidden="true"
        style={textWidth ? { right: 'auto', bottom: 'auto', width: `${textWidth}px`, height: `${Math.round(textWidth * ratio)}px`, transformOrigin: '0 0', transform: `scale(${width / textWidth})` } : undefined}
      />
    </div>
  );
}

// One page of the LIST beside the document (`pdfView.rail`): a small canvas,
// painted when its slot nears the list's viewport and then kept (it is tiny).
const PDF_THUMB_W = 104;
// Painted thumbnails, kept for the life of the window: `<file>:<page>` → the
// finished bitmap + its proportions. The list is hidden rather than unmounted
// when switched off, and a PDF reopened later (or re-listed after a re-render)
// shows its pages at once instead of painting them again. Bounded; oldest out.
const PDF_THUMB_CACHE = new Map();
const PDF_THUMB_CACHE_MAX = 600;
function PdfThumb({ pdf, n, cacheKey, fallbackRatio, root, current, onPick }) {
  const slotRef = useRef(null);
  const canvasRef = useRef(null);
  const cached = cacheKey ? PDF_THUMB_CACHE.get(cacheKey) : null;
  const [ratio, setRatio] = useState(cached?.ratio || fallbackRatio);
  const [near, setNear] = useState(false);
  const doneRef = useRef(false);
  // Already painted once: straight onto the canvas, before the first frame.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const hit = cacheKey ? PDF_THUMB_CACHE.get(cacheKey) : null;
    if (!canvas || !hit || doneRef.current) return;
    canvas.width = hit.bitmap.width;
    canvas.height = hit.bitmap.height;
    canvas.getContext('2d').drawImage(hit.bitmap, 0, 0);
    doneRef.current = true;
  }, [cacheKey]);
  useEffect(() => {
    const el = slotRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return undefined; }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setNear(true); }, { root: root || null, rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  useEffect(() => {
    if (!near || doneRef.current) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdf.getPage(n);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        setRatio(base.height / base.width);
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: (PDF_THUMB_W / base.width) * dpr });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        if (cancelled) return;
        doneRef.current = true;
        if (cacheKey) {
          const keep = document.createElement('canvas');
          keep.width = canvas.width; keep.height = canvas.height;
          keep.getContext('2d').drawImage(canvas, 0, 0);
          PDF_THUMB_CACHE.delete(cacheKey);
          PDF_THUMB_CACHE.set(cacheKey, { bitmap: keep, ratio: base.height / base.width });
          while (PDF_THUMB_CACHE.size > PDF_THUMB_CACHE_MAX) PDF_THUMB_CACHE.delete(PDF_THUMB_CACHE.keys().next().value);
        }
      } catch { /* an unrenderable page keeps its blank slot */ }
    })();
    return () => { cancelled = true; };
  }, [near, pdf, n]);
  // The page being read stays in view in the list.
  useEffect(() => { if (current) slotRef.current?.scrollIntoView({ block: 'nearest' }); }, [current]);
  return (
    <button type="button" ref={slotRef} className={`dv-pagerail-item${current ? ' is-current' : ''}`} aria-label={`Go to page ${n}`} onClick={() => onPick(n)}>
      <span className="dv-pagerail-sheet" style={{ height: `${Math.round(PDF_THUMB_W * ratio)}px` }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      </span>
      <span className="dv-pagerail-num">{n}</span>
    </button>
  );
}

// `pdfView` = `{ zoom, rail, fitTick }` from the Doc Viewer's quick actions:
// `zoom` multiplies the fit-to-WIDTH page size (1 = as wide as the pane), `rail`
// shows the page list, and a bump of `fitTick` asks for FIT — a whole page
// inside the window's height (never wider than the pane), which only this
// component can work out, so it answers with `onPdfZoom(<number>)`.
// `onPdfZoom('in' | 'out')` is asked for by Ctrl + wheel over the pages (the
// plain wheel scrolls them).
// `pdfOverlay(left)` = something the Doc Viewer stands over the pages' top-left
// (its zoom pill); `left` is how far in the page list reaches, which only this
// component knows.
function PdfPreview({ signedUrl, file, onOpen, pdfView = null, onPdfZoom = null, onPdfFit = null, pdfOverlay = null }) {
  const containerRef = useRef(null);
  const [pdf, setPdf] = useState(null);
  const [error, setError] = useState(null);
  const [firstRatio, setFirstRatio] = useState(1.414);   // A4, until page 1 says otherwise
  const [pageWidth, setPageWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const [scrollRoot, setScrollRoot] = useState(null);
  const [railRoot, setRailRoot] = useState(null);
  const [railCard, setRailCard] = useState(null);
  // A ONE-page PDF is a picture, not a document to scroll: it is dragged around
  // like one (the image pane's pan) instead.
  const [dragging, setDragging] = useState(false);
  // The width SHOWN (glides during a zoom) and the width the pages are PAINTED at
  // (settled) — declared up here because the effects below read them.
  const [animWidth, setAnimWidth] = useState(0);
  const [paintWidth, setPaintWidth] = useState(0);
  const animRef = useRef(0);
  // A PDF OPENS fitted — a whole page in the window's height, as the Fit button
  // does it. Until that first zoom has been worked out nothing is laid out, so
  // the file never shows at one size and then jumps to another.
  const [fitReady, setFitReady] = useState(false);
  const zoom = Math.max(0.1, Math.min(5, Number(pdfView?.zoom) || 1));
  const showRail = !!pdfView?.rail;
  const count = pdf?.numPages || 0;
  const single = count === 1;
  const [railWanted, setRailWanted] = useState(showRail);
  useEffect(() => { if (showRail) setRailWanted(true); }, [showRail]);

  // Load the document via the module-level LRU cache (src/lib/pdfCache.js).
  // First open: pdf.js fetches + parses, result is cached. Second-and-
  // subsequent opens of the same file: cache hit, near-zero latency.
  //
  // Cleanup intentionally does NOT call doc.destroy(): the cache owns the
  // handle's lifetime via LRU eviction. Destroying on every unmount would
  // defeat the cache (next reopen of the same file would re-parse).
  useEffect(() => {
    if (!signedUrl) return undefined;
    let cancelled = false;
    setPdf(null); setError(null); setCurrent(1);
    setFitReady(false); animRef.current = 0;   // a new file opens fitted again, with no glide
    (async () => {
      try {
        const doc = await getCachedPdf(file.storage_path, signedUrl);
        if (cancelled) return;
        try {
          const vp = (await doc.getPage(1)).getViewport({ scale: 1 });
          if (!cancelled && vp.width) setFirstRatio(vp.height / vp.width);
        } catch { /* keep the A4 guess */ }
        if (!cancelled) setPdf(doc);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load PDF');
      }
    })();
    return () => { cancelled = true; };
  }, [signedUrl, file.storage_path]);

  // The column's width follows the pane (debounced — without it a resize-drag
  // stacks repaints and the pages flash blank).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    setScrollRoot(el);
    let timer = null;
    const measure = (w) => setPageWidth(Math.max(200, Math.min(PDF_MAX_PAGE_WIDTH, Math.floor(w - PDF_PAGE_GUTTER * 2))));
    measure(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (!w) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => measure(w), 150);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, []);

  // Which page is being read: the one crossing the upper third of the pane.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !pdf) return undefined;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const line = el.scrollTop + el.clientHeight / 3;
        let found = 1;
        for (const node of el.querySelectorAll('.file-preview-pdf-page')) {
          if (node.offsetTop <= line) found = Number(node.dataset.page) || found; else break;
        }
        setCurrent(found);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();   // and once now: which pages are on screen before any scrolling
    return () => { el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [pdf, animWidth > 0, paintWidth]);

  // A ONE-page PDF is a stage, so its plain WHEEL zooms, as a picture's does.
  // With more than one page the wheel belongs to reading them, so zooming there
  // is CTRL + wheel (held down).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onPdfZoom) return undefined;
    const onWheel = (e) => {
      if (count > 1 && !e.ctrlKey) return;
      e.preventDefault();
      onPdfZoom(e.deltaY < 0 ? 'in' : 'out');
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onPdfZoom, count]);

  // The pages' width = fit × zoom. When it changes, what was at the middle of
  // the view stays at the middle.
  // The width SHOWN glides there (~200ms, geometric): only the holders' sizes
  // change per frame — the painted pixels are stretched by CSS — and the pages
  // are re-painted ONCE, sharp, when it settles (`paintWidth`).
  // For a one-page file: the zoom the page is LAID OUT at, and the zoom being
  // shown (eased toward `zoom`). The difference is taken up by a scale.
  const [paintZoom, setPaintZoom] = useState(0);
  const [animZoom, setAnimZoom] = useState(0);
  useEffect(() => {
    if (!single || !zoom) return undefined;
    const from = animZoomRef.current;
    const still = document.documentElement.dataset.reduceMotion === 'true';
    if (!from || !paintZoom || still) {
      animZoomRef.current = zoom; setAnimZoom(zoom); setPaintZoom(zoom);
      return undefined;
    }
    if (from === zoom) return undefined;
    const t0 = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const p = Math.min(1, (now - t0) / 200);
      const e = 1 - (1 - p) ** 3;
      const z = p >= 1 ? zoom : from * (zoom / from) ** e;
      animZoomRef.current = z;
      setAnimZoom(z);
      if (p < 1) raf = requestAnimationFrame(tick);
      // Landed: the layout goes to the target in the same tick as the scale
      // reaches 1, so the picture doesn't move.
      else setPaintZoom(zoom);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, single]);
  useEffect(() => { if (!single) { animZoomRef.current = 0; setPaintZoom(0); setAnimZoom(0); } }, [single]);
  const scale = single && paintZoom ? (animZoom || paintZoom) / paintZoom : 1;

  const shownWidth = Math.round(pageWidth * (single ? (paintZoom || zoom) : zoom));
  useEffect(() => {
    if (!shownWidth || (onPdfZoom && !fitReady)) return undefined;
    const from = animRef.current;
    const still = single || document.documentElement.dataset.reduceMotion === 'true';
    if (!from || from === shownWidth || still) {
      animRef.current = shownWidth; setAnimWidth(shownWidth); setPaintWidth(shownWidth);
      return undefined;
    }
    const t0 = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const p = Math.min(1, (now - t0) / 200);
      const e = 1 - (1 - p) ** 3;
      const w = p >= 1 ? shownWidth : Math.round(from * (shownWidth / from) ** e);
      animRef.current = w;
      setAnimWidth(w);
      if (p < 1) raf = requestAnimationFrame(tick); else setPaintWidth(shownWidth);
    });
    return () => cancelAnimationFrame(raf);
  }, [shownWidth, fitReady, onPdfZoom, single]);
  // What was at the middle of the view stays at the middle, frame by frame.
  const lastWidthRef = useRef(0);
  useLayoutEffect(() => {
    const el = containerRef.current;
    const before = lastWidthRef.current;
    lastWidthRef.current = animWidth;
    if (!el || !before || !animWidth || before === animWidth) return;
    if (single) return;             // a one-page stage doesn't scroll; the pan is scaled instead
    const k = animWidth / before;
    el.scrollTop = (el.scrollTop + el.clientHeight / 2) * k - el.clientHeight / 2;
    el.scrollLeft = (el.scrollLeft + el.clientWidth / 2) * k - el.clientWidth / 2;
  }, [animWidth, single]);

  // The opening fit: once the document and the pane's width are known.
  useEffect(() => {
    if (fitReady || !pdf || !pageWidth) return;
    const el = containerRef.current;
    if (el && onPdfZoom) onPdfZoom(Math.min(1, (el.clientHeight - PDF_FIT_GAP * 2) / (pageWidth * firstRatio)));
    setFitReady(true);
  }, [fitReady, pdf, pageWidth, firstRatio, onPdfZoom]);

  // The page list stands level with the floating side panel beside it.
  useEffect(() => (railCard ? alignWithSidePanel(railCard) : undefined), [railCard, showRail]);

  // ── A ONE-page PDF behaves like a PICTURE ────────────────────────────────
  // Usually a scan, so it is read the way a photograph is: the page sits on a
  // fixed stage and is moved by a TRANSFORM, not by scrolling. That is what lets
  // it be dragged at any zoom, 100% included — a scroller can only pan what
  // overflows, so a page that fits couldn't be moved at all. The pan is scaled
  // by the zoom (which keeps the middle of the view where it was) and let go
  // once the whole page fits again, exactly as `applyZoom` does for an image.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef(pan);
  panRef.current = pan;
  const animZoomRef = useRef(0);
  // The zoom at which the WHOLE page is in the pane's height — the point below
  // which there is nothing to pan to.
  const fitZoom = useCallback(() => {
    const el = containerRef.current;
    if (!el || !pageWidth) return 1;
    const node = el.querySelector('.file-preview-pdf-page');
    const ratio = node && node.offsetWidth ? node.offsetHeight / node.offsetWidth : firstRatio;
    return Math.min(1, (el.clientHeight - PDF_FIT_GAP * 2) / (pageWidth * ratio));
  }, [pageWidth, firstRatio]);
  // …and publishes it, because only the preview can measure it: it is the FLOOR
  // the zoom is clamped to and the 100% the pill reads against for a one-page
  // file, so that — as over a picture — 100% means the whole page in view and
  // there is nothing below it.
  useEffect(() => {
    if (!onPdfFit || !pdf || !pageWidth) return;
    onPdfFit(fitZoom());
  }, [onPdfFit, pdf, pageWidth, fitZoom, count]);
  const lastZoomRef = useRef(zoom);
  useEffect(() => {
    const prev = lastZoomRef.current;
    lastZoomRef.current = zoom;
    if (!single || !prev || prev === zoom) return;
    if (zoom < prev && zoom <= fitZoom() + 0.001) { setPan({ x: 0, y: 0 }); return; }
    const f = zoom / prev;
    setPan((p) => (p.x || p.y ? { x: p.x * f, y: p.y * f } : p));
  }, [zoom, single, fitZoom]);
  useEffect(() => { setPan({ x: 0, y: 0 }); }, [single, file.storage_path]);

  // FIT: the page being read, whole, in the height of the pane.
  const fitTick = pdfView?.fitTick || 0;
  const fitSeenRef = useRef(fitTick);
  useEffect(() => {
    if (fitTick === fitSeenRef.current) return;
    fitSeenRef.current = fitTick;
    const el = containerRef.current;
    if (!el || !pageWidth || !onPdfZoom) return;
    const node = el.querySelector(`.file-preview-pdf-page[data-page="${current}"]`);
    const ratio = node && node.offsetWidth ? node.offsetHeight / node.offsetWidth : firstRatio;
    const z = Math.min(1, (el.clientHeight - PDF_FIT_GAP * 2) / (pageWidth * ratio));
    onPdfZoom(z);
    setPan({ x: 0, y: 0 });               // fitting re-centres a one-page stage
    // …and that page squarely in view once the glide has settled.
    window.setTimeout(() => {
      const again = el.querySelector(`.file-preview-pdf-page[data-page="${current}"]`);
      if (again) el.scrollTo({ top: Math.max(0, again.offsetTop - PDF_FIT_GAP), behavior: 'smooth' });
    }, 260);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitTick]);

  // Drag to move the page, at any zoom — a one-page PDF only (on a longer one a
  // drag is a text selection, and the wheel/list are how it is navigated). A
  // press ON A GLYPH RUN still starts a selection, as it does over a picture's
  // live text: the text layer itself takes no pointer, only its runs do.
  const onPagesMouseDown = (e) => {
    const el = containerRef.current;
    if (!el || e.button !== 0) return;
    if (e.target.closest('.dv-pagerail-card, .dv-pagerail, .dv-docpill, .file-preview-pdf-counter')) return;
    const onText = !!e.target.closest('.file-preview-pdf-text span');
    // A press away from the text lets go of what was selected. Worth doing by
    // hand: on a one-page PDF the pan below calls preventDefault, which is
    // exactly what stops the browser from collapsing the selection itself.
    if (!onText) {
      const sel = window.getSelection?.();
      if (sel && !sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode)) sel.removeAllRanges();
    }
    if (!single || onText) return;
    e.preventDefault();
    const x0 = e.clientX; const y0 = e.clientY;
    const from = panRef.current;
    let moved = false;
    const onMove = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 4) return;
      if (!moved) { moved = true; setDragging(true); document.body.classList.add('dv-media-panning'); }
      setPan({ x: from.x + (ev.clientX - x0), y: from.y + (ev.clientY - y0) });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dv-media-panning');
      setDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // The page list's footprint: what the pill and the counter stand clear of.
  const railPad = showRail && railWanted && count > 0 ? 134 : 8;

  const goToPage = (n) => {
    const el = containerRef.current;
    const node = el?.querySelector(`.file-preview-pdf-page[data-page="${n}"]`);
    if (el && node) el.scrollTo({ top: Math.max(0, node.offsetTop - PDF_FIT_GAP), behavior: 'smooth' });
  };

  if (error) return <NoPreview reason={error} />;
  return (
    <ClickablePreview onOpen={onOpen} ariaLabel={`Open ${file.name}`}>
      <div className="file-preview-pdf-static file-preview-pdf-shell">
      {/* Switched off = hidden, not unmounted — what it has painted stays. It is
          only MOUNTED once it has been wanted, so a list never shown costs nothing. */}
      {railWanted && pdf && count > 0 && (
        <div className={`dv-pagerail-card is-inline${showRail ? '' : ' is-hidden'}`} ref={setRailCard}>
          {/* The Quick actions card's own title band (DocRibbon.css), so the
              two cards beside the document read as one family. */}
          <h3 className="drb-quick-title">Pages</h3>
          <nav className="dv-pagerail is-inline" ref={setRailRoot} aria-label="Pages" aria-hidden={!showRail || undefined}>
            {Array.from({ length: count }, (_, i) => (
              <PdfThumb key={i + 1} pdf={pdf} n={i + 1} cacheKey={`${file.storage_path}:${i + 1}`} fallbackRatio={firstRatio} root={railRoot} current={current === i + 1} onPick={goToPage} />
            ))}
          </nav>
        </div>
      )}
      {pdfOverlay && pdf ? pdfOverlay(railPad) : null}
      <div
        className={`file-preview-pdf-scroll${count === 1 ? ' is-single' : ''}${dragging ? ' is-dragging' : ''}`}
        ref={containerRef}
        onMouseDown={onPagesMouseDown}
      >
        {!pdf && <div className="file-preview-loading">Loading PDF…</div>}
        {pdf && animWidth > 0 && (
          <div
            className="file-preview-pdf-pages"
            style={{
              padding: `${PDF_FIT_GAP}px ${PDF_PAGE_GUTTER}px`,
              // `translate` first, so the pan is in screen pixels and the
              // scale doesn't multiply it.
              transform: single && (pan.x || pan.y || scale !== 1)
                ? `translate(${pan.x}px, ${pan.y}px) scale(${scale})`
                : undefined,
            }}
          >
            {Array.from({ length: count }, (_, i) => (
              <PdfPage
                key={i + 1}
                pdf={pdf}
                n={i + 1}
                width={animWidth}
                paintWidth={paintWidth}
                fallbackRatio={firstRatio}
                scrollRoot={scrollRoot}
                eagerText={count <= PDF_EAGER_TEXT_PAGES}
              />
            ))}
          </div>
        )}
      </div>
      {count > 1 && <div className="file-preview-pdf-counter" style={{ left: railPad }} aria-live="off">Page {current} of {count}</div>}
      </div>
    </ClickablePreview>
  );
}

// ── Text ─────────────────────────────────────────────────────────────────
// Fetches the file body as text, capped at 1 MB. Markdown gets piped
// through ReactMarkdown (same dep the rest of the app uses for release
// notes etc.); everything else renders in a <pre> with word-break so
// long lines wrap inside the pane.
//
// Text previews are NOT click-to-open — the rendered text is itself the
// thing the user came to read, so we keep the existing scrollable
// content and let the right-pane View button serve the "open the file"
// intent.
function TextPreview({ signedUrl, file }) {
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);
  const [tooLarge, setTooLarge] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    setTooLarge(false);

    // Pre-flight HEAD-like check via the file row's known size. We
    // already have file.size_bytes from the metadata — no need to
    // round-trip just to know if it's too big.
    if ((file.size_bytes || 0) > TEXT_PREVIEW_MAX_BYTES) {
      setTooLarge(true);
      return undefined;
    }

    (async () => {
      try {
        const res = await fetch(signedUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (cancelled) return;
        // Defence in depth: if the metadata's size_bytes was wrong /
        // stale (unlikely — we set it at upload time from File.size),
        // truncate so the DOM doesn't choke on a runaway file.
        if (text.length > TEXT_PREVIEW_MAX_BYTES) {
          setTooLarge(true);
          return;
        }
        setContent(text);
      } catch (err) {
        if (cancelled) return;
        setError(err?.message || 'Failed to load text');
      }
    })();

    return () => { cancelled = true; };
  }, [signedUrl, file.size_bytes]);

  if (tooLarge) return <NoPreview reason="File is too large to preview (over 1 MB)." />;
  if (error)    return <NoPreview reason={error} />;
  if (content == null) return <div className="file-preview-loading">Loading text…</div>;

  const isMarkdown = file.mime_type === 'text/markdown' || /\.md$/i.test(file.name);

  return (
    <div className="file-preview-text">
      {isMarkdown ? (
        <div className="file-preview-text-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <pre className="file-preview-text-pre">{content}</pre>
      )}
    </div>
  );
}

// ── Dispatcher ───────────────────────────────────────────────────────────
// Previews are intentionally limited to image / video / PDF / text.
// DOCX (and other document formats) used to round-trip through a
// rasterized "rich render" of their text; that's been removed — the
// rendering was approximate, mismatched the real document, and the
// generator was a maintenance burden. DOCX now falls into NoPreview.
export default function FilePreview({ file, signedUrl, onOpen, pdfView = null, onPdfZoom = null, onPdfFit = null, pdfOverlay = null }) {
  if (!file) return null;

  const t = file.mime_type || '';

  // Both PDF and Video wait on signedUrl internally — PdfPreview gates
  // its pdf.js parse on it; VideoPreview shows a loading message until
  // it arrives, then mounts the native <video>.
  if (t === 'application/pdf') return <PdfPreview   file={file} signedUrl={signedUrl} onOpen={onOpen} pdfView={pdfView} onPdfZoom={onPdfZoom} onPdfFit={onPdfFit} pdfOverlay={pdfOverlay} />;
  if (t.startsWith('video/'))  return <VideoPreview signedUrl={signedUrl} />;

  // Everything else needs the signed URL before it can show anything.
  if (!signedUrl) {
    return <div className="file-preview-loading">Loading preview…</div>;
  }
  if (t.startsWith('image/'))  return <ImagePreview file={file} signedUrl={signedUrl} onOpen={onOpen} />;
  if (t.startsWith('text/'))   return <TextPreview  file={file} signedUrl={signedUrl} />;
  return <NoPreview reason={`No preview for ${t || 'this file type'}.`} canOpen={Boolean(onOpen)} />;
}
