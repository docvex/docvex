import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getCachedPdf } from '../lib/pdfCache';
import VideoFrameSlideshow from './VideoFrameSlideshow';

// Preview renderer for the FileDetailModal's left pane.
// Dispatches by MIME to one of:
//   • <ImagePreview>  — image/*
//   • <VideoPreview>  — video/*           (static thumbnail only, no <video>)
//   • <PdfPreview>    — application/pdf   (first page only, no paginator)
//   • <TextPreview>   — text/*            (fetched, capped at 1 MB)
// Anything else renders a fallback "no preview" panel with a hint to
// use the View button in the right pane.
//
// All four sub-components receive `{ file, signedUrl, thumbnailUrl, onOpen }`.
// signedUrl is the 10-minute signed URL for the source file. thumbnailUrl
// is the signed URL for the pre-baked _thumb.jpg generated at upload
// time (see src/lib/thumbnails.js) — present for image/PDF/video uploads
// after migration 004. onOpen is the modal's handleView callback — fired
// when the user clicks anywhere on the preview pane so the whole preview
// reads as a "tap to open" surface.

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

// Large fallback glyph for video previews with no pre-baked thumbnail.
// Same shape as the VideoIcon in ProjectFiles.jsx (the file-card list)
// so the visual language is consistent across the page and the modal.
const VideoGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="6" width="14" height="12" rx="2" ry="2" />
    <polygon points="22 8 16 12 22 16 22 8" />
  </svg>
);

// Wrap a child node in a clickable surface that opens the full file
// when activated. Centralised so every sub-renderer gets the same
// hover hint, focus ring, and keyboard semantics. The hint pill is
// pinned in the corner via the stylesheet — only visible on hover or
// keyboard focus so it doesn't clutter the preview itself.
function ClickablePreview({ onOpen, children, ariaLabel }) {
  return (
    <button
      type="button"
      className="file-preview-clickable"
      onClick={onOpen}
      aria-label={ariaLabel}
      title="Click to open"
    >
      {children}
      <span className="file-preview-open-hint">
        {OpenIcon}
        <span>Open</span>
      </span>
    </button>
  );
}

// Generic "no preview" panel — used for unsupported MIMEs AND as the
// error fallback for the type-specific renderers when something goes
// wrong (pdf.js worker fails, video codec unsupported, etc.). Hint
// directs the user to the right-pane View action.
function NoPreview({ reason }) {
  return (
    <div className="file-preview-empty">
      <p className="file-preview-empty-title">No preview available</p>
      {reason && <p className="file-preview-empty-reason">{reason}</p>}
      <p className="file-preview-empty-hint">Use the <strong>View</strong> button to open the file in a new tab.</p>
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
// Static thumbnail only — no <video> element. We deliberately skip
// mounting the video tag so the preview reads as a low-cost teaser:
//   1. Loading the full video to play in a small pane is wasteful.
//   2. The user's intent when clicking a video card is usually "open it"
//      not "scrub in this little box", and the click-to-open affordance
//      now matches that.
// If the pre-baked thumbnail exists (uploads after migration 004),
// we show it; otherwise we fall back to a large video glyph.
function VideoPreview({ thumbnailUrl, file, onOpen }) {
  const hasFrames = Array.isArray(file?.thumbnail_frames) && file.thumbnail_frames.length > 1;

  if (hasFrames) {
    // Multi-frame slideshow path — the modal is "always hovered" since
    // the user explicitly opened the file, so the slideshow plays
    // continuously instead of being gated on a hover state.
    return (
      <ClickablePreview onOpen={onOpen} ariaLabel={`Open ${file.name}`}>
        <div className="file-preview-video-static">
          <VideoFrameSlideshow
            framePaths={file.thumbnail_frames}
            active={true}
            posterUrl={thumbnailUrl}
            alt={file.name}
          />
        </div>
      </ClickablePreview>
    );
  }

  if (thumbnailUrl) {
    return (
      <ClickablePreview onOpen={onOpen} ariaLabel={`Open ${file.name}`}>
        <div className="file-preview-video-static">
          <img src={thumbnailUrl} alt={file.name} draggable={false} />
        </div>
      </ClickablePreview>
    );
  }
  return (
    <ClickablePreview onOpen={onOpen} ariaLabel={`Open ${file.name}`}>
      <div className="file-preview-glyph" aria-hidden="true">
        {VideoGlyph}
        <span className="file-preview-glyph-label">Video preview unavailable</span>
      </div>
    </ClickablePreview>
  );
}

// ── PDF ──────────────────────────────────────────────────────────────────
// Progressive preview: paints the pre-baked thumbnail JPEG immediately as
// a fast first-frame, then runs pdf.js in parallel and fades the rendered
// canvas in over the thumbnail once ready. Two reasons this pattern wins:
//
//   1. Latency. pdf.js startup (worker fetch on cold load, getDocument,
//      page-1 render) is ~500ms–2s; the thumbnail is ~50KB and paints in
//      under 100ms. The user sees a real preview almost immediately
//      instead of staring at "Loading PDF…" text.
//   2. Visual fidelity. The thumbnail JPEG has dark letterbox bars baked
//      in for non-4:3 pages, which is why we don't use it as the FINAL
//      preview. But as a fast first-frame it's "good enough", and the
//      canvas crossfade hides the swap so the dark bars never read as
//      "ugly padding" the way they did when the thumbnail was permanent.
//
// If `thumbnailUrl` is absent (legacy uploads pre-migration 004), we fall
// back to the loading-text state until pdf.js finishes.
function PdfPreview({ signedUrl, thumbnailUrl, file, onOpen }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const pdfRef = useRef(null);
  const renderTaskRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  // True once pdf.js has finished its first render. Drives the canvas's
  // opacity + the thumbnail's fade-out; stays true for the lifetime of
  // the component so a resize-reflow doesn't bounce visibility.
  const [pdfPainted, setPdfPainted] = useState(false);

  // Load the document via the module-level LRU cache (src/lib/pdfCache.js).
  // First open: pdf.js fetches + parses, result is cached. Second-and-
  // subsequent opens of the same file: cache hit, near-zero latency.
  // Skips the work entirely while signedUrl is still null — lets the
  // thumbnail paint immediately even before the signed URL resolves.
  //
  // Cleanup intentionally does NOT call doc.destroy(): the cache owns the
  // handle's lifetime via LRU eviction. Destroying on every unmount would
  // defeat the cache (next reopen of the same file would re-parse).
  useEffect(() => {
    if (!signedUrl) return undefined;
    let cancelled = false;
    pdfRef.current = null;
    setLoading(true);
    setError(null);
    setPdfPainted(false);

    (async () => {
      try {
        const pdf = await getCachedPdf(file.storage_path, signedUrl);
        if (cancelled) return;
        pdfRef.current = pdf;
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err?.message || 'Failed to load PDF');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      pdfRef.current = null;  // cache keeps the doc alive; just drop our ref
    };
  }, [signedUrl, file.storage_path]);

  // Debounced container-size tracking — same pattern the old paginator
  // used; without the 150ms debounce a resize-drag stacks render
  // cancellations and the canvas flashes blank.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer = null;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setContainerSize({ w: width, h: height }), 150);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Render page 1 whenever the pdf handle resolves or the pane resizes.
  // `loading` is in the deps so the effect re-fires the moment the
  // pdf finishes loading — that's the render where the <canvas>
  // actually mounts (it's gated on !loading in the JSX below), so
  // before that flip canvasRef.current is null and the effect's
  // early-return is hit. Without this dep the canvas mounts but the
  // render never happens and the user sees a blank pane forever.
  // Cancels any in-flight render before starting a new one —
  // RenderingCancelledException is expected and swallowed.
  useEffect(() => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;
    if (containerSize.w === 0 || containerSize.h === 0) return;

    let cancelled = false;
    (async () => {
      try {
        if (renderTaskRef.current) {
          try { renderTaskRef.current.cancel(); } catch { /* ignore */ }
          renderTaskRef.current = null;
        }
        const page = await pdf.getPage(1);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const fitW = containerSize.w;
        const fitH = containerSize.h;
        const scale = Math.min(fitW / baseViewport.width, fitH / baseViewport.height);
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr });

        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.round(viewport.height / dpr)}px`;

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const task = page.render({ canvasContext: ctx, viewport, canvas });
        renderTaskRef.current = task;
        await task.promise;
        if (renderTaskRef.current === task) renderTaskRef.current = null;
        if (!cancelled) setPdfPainted(true);
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException' && !cancelled) {
          setError(err?.message || 'Failed to render page');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [containerSize, loading]);

  if (error) return <NoPreview reason={error} />;

  // The canvas is ALWAYS in the DOM (even before pdf.js finishes) so the
  // render effect can attach to it via canvasRef as soon as the document
  // resolves. Until pdfPainted, the canvas stays at opacity 0 and the
  // thumbnail underneath shows through. Once painted, the canvas fades
  // in and the thumbnail fades out.
  const showLoadingText = !pdfPainted && !thumbnailUrl;

  return (
    <ClickablePreview onOpen={onOpen} ariaLabel={`Open ${file.name}`}>
      <div className="file-preview-pdf-static" ref={containerRef}>
        {thumbnailUrl && (
          <img
            className={`file-preview-pdf-thumb${pdfPainted ? ' is-faded' : ''}`}
            src={thumbnailUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        )}
        <canvas
          ref={canvasRef}
          className={`file-preview-pdf-canvas${pdfPainted ? ' is-visible' : ''}`}
        />
        {showLoadingText && (
          <div className="file-preview-loading">Loading PDF…</div>
        )}
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
export default function FilePreview({ file, signedUrl, thumbnailUrl, onOpen }) {
  if (!file) return null;

  const t = file.mime_type || '';

  // PDF and Video both have a thumbnail-as-fast-paint path. They can render
  // their first frame from `thumbnailUrl` BEFORE `signedUrl` resolves, so we
  // dispatch them eagerly. Each component waits for signedUrl internally
  // before kicking off its heavier work (pdf.js parse / video fetch).
  if (t === 'application/pdf') return <PdfPreview   file={file} signedUrl={signedUrl} thumbnailUrl={thumbnailUrl} onOpen={onOpen} />;
  if (t.startsWith('video/'))  return <VideoPreview file={file} thumbnailUrl={thumbnailUrl} onOpen={onOpen} />;

  // Everything else needs the signed URL before it can show anything.
  if (!signedUrl) {
    return <div className="file-preview-loading">Loading preview…</div>;
  }
  if (t.startsWith('image/'))  return <ImagePreview file={file} signedUrl={signedUrl} onOpen={onOpen} />;
  if (t.startsWith('text/'))   return <TextPreview  file={file} signedUrl={signedUrl} />;
  return <NoPreview reason={`No preview for ${t || 'this file type'}.`} />;
}
