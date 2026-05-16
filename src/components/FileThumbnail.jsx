import React, { useEffect, useState } from 'react';
import VideoFrameSlideshow from './VideoFrameSlideshow';

// Unified thumbnail renderer for file cards. One component, one set of
// rules — replaces the divergent inline logic that used to live in
// FileCard (cloud) and LocalFileCard (local). The two halves of the
// app showed different thumbnails for the same file; this fixes that.
//
// Props:
//   mimeType        — file MIME, drives the renderer pick (image vs
//                     video vs document glyph).
//   posterUrl       — preferred display URL: a pre-baked thumbnail
//                     (cloud `thumbnail_path` signed URL). Wins over
//                     every other source when present.
//   sourceUrl       — secondary URL: the raw source bytes URL. For
//                     image MIMEs this becomes the display source if
//                     no poster is available. For video MIMEs it's
//                     fed into the extraction fallback below.
//   slideshowFrames — optional array of storage paths for a multi-
//                     frame video slideshow (cloud thumbnail_frames).
//                     When present AND `hovered`, cycles frames.
//   hovered         — slideshow active flag (parent-controlled).
//   glyph           — the SVG to show when no preview is available
//                     (loading / error / no preview supported).
//   duration        — optional video runtime in seconds, rendered as
//                     a bottom-right pill — kept inside the thumb so
//                     parents don't have to repeat the JSX.
//   onError         — bubble-up for the parent's analytics if needed.
//                     Not required.

// ── Frame-extraction cache + utility ─────────────────────────────────────

// Module-level Map: sourceUrl → extracted-frame blob URL. Survives
// component unmounts so re-mounting (scroll, re-render, tab switch)
// doesn't re-extract the same video. Capped at 200 entries — older
// entries fall out FIFO-ish via insertion order eviction below.
const frameCache = new Map();
const FRAME_CACHE_MAX = 200;

// In-flight extractions: keep a single Promise per sourceUrl so two
// cards mounting at the same time don't both run the heavy extraction
// dance against the same file.
const inflight = new Map();

function rememberFrame(url, blobUrl) {
  if (frameCache.size >= FRAME_CACHE_MAX) {
    const firstKey = frameCache.keys().next().value;
    if (firstKey !== undefined) {
      const old = frameCache.get(firstKey);
      // Revoke the old blob URL so the renderer drops its bytes.
      try { URL.revokeObjectURL(old); } catch { /* ignore */ }
      frameCache.delete(firstKey);
    }
  }
  frameCache.set(url, blobUrl);
}

// Extract a single frame from a video URL via hidden <video> + canvas.
// Returns blob: URL on success, null on any failure. Hard timeout
// prevents wedged decoders from stalling the cache slot forever.
function extractVideoFrame(sourceUrl, timeoutMs = 6000) {
  if (!sourceUrl) return Promise.resolve(null);
  const cached = frameCache.get(sourceUrl);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(sourceUrl);
  if (pending) return pending;

  const p = new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    // crossOrigin only matters for canvas-tainting prevention on
    // remote video. Set it for HTTP(S) sources (cloud signed URLs);
    // leave it off for `localfile://` and `blob:` which are
    // same-origin from the renderer's POV — some Chromium builds
    // reject `anonymous` mode on the custom protocol and the load
    // silently aborts.
    if (/^https?:/i.test(sourceUrl)) {
      video.crossOrigin = 'anonymous';
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach listeners before clearing src so a late event doesn't
      // resurrect a finished extraction.
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      try {
        video.removeAttribute('src');
        video.load();
      } catch { /* ignore */ }
      if (result) rememberFrame(sourceUrl, result);
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      // 10% in skips the black opening frame most clips have. Clamped
      // to [0, 1] so very-short clips don't seek past end.
      const target = Math.min(1, Math.max(0, dur * 0.1));
      video.onseeked = () => {
        try {
          const w = video.videoWidth || 320;
          const h = video.videoHeight || 180;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, w, h);
          canvas.toBlob((blob) => {
            if (!blob) { finish(null); return; }
            finish(URL.createObjectURL(blob));
          }, 'image/jpeg', 0.78);
        } catch {
          finish(null);
        }
      };
      try {
        video.currentTime = target;
      } catch {
        finish(null);
      }
    };

    // Kick off the load. Some Chromium codecs need this AFTER the
    // listeners are wired up; otherwise the events fire before we're
    // listening and the extraction silently stalls.
    video.src = sourceUrl;
  }).finally(() => {
    inflight.delete(sourceUrl);
  });

  inflight.set(sourceUrl, p);
  return p;
}

// ── Inner renderers ──────────────────────────────────────────────────────

function ThumbImage({ src, onError }) {
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      draggable={false}
      onError={onError}
    />
  );
}

function ThumbGlyph({ icon }) {
  return <span className="project-files-icon">{icon}</span>;
}

// ── Component ────────────────────────────────────────────────────────────

export default function FileThumbnail({
  mimeType,
  posterUrl,
  sourceUrl,
  slideshowFrames,
  hovered,
  glyph,
  duration,
}) {
  const mime = mimeType || '';
  const isImage = mime.startsWith('image/');
  const isVideo = mime.startsWith('video/');
  const hasSlideshow = isVideo && Array.isArray(slideshowFrames) && slideshowFrames.length > 1;

  const [errored, setErrored] = useState(false);
  // Frame extracted from `sourceUrl` for videos with no poster.
  // Starts null; the effect below populates it asynchronously.
  const [extractedFrame, setExtractedFrame] = useState(() => {
    return isVideo && !posterUrl && sourceUrl ? (frameCache.get(sourceUrl) || null) : null;
  });

  // Reset transient state when the URL inputs change — covers card
  // recycling in a virtualised list or a swap between files of
  // different types.
  useEffect(() => {
    setErrored(false);
  }, [posterUrl, sourceUrl, mime]);

  // Video-with-no-poster: kick off the extraction. Skipped when the
  // cache already has an answer (synchronous init above) or when a
  // poster is present (cloud thumbnail wins, no extraction needed).
  useEffect(() => {
    if (!isVideo) return undefined;
    if (posterUrl) return undefined;
    if (!sourceUrl) return undefined;
    if (extractedFrame) return undefined;
    if (errored) return undefined;
    let cancelled = false;
    extractVideoFrame(sourceUrl).then((blobUrl) => {
      if (cancelled) return;
      if (blobUrl) setExtractedFrame(blobUrl);
      else setErrored(true);
    });
    return () => { cancelled = true; };
  }, [isVideo, posterUrl, sourceUrl, extractedFrame, errored]);

  // ── Pick the renderer ────────────────────────────────────────────
  let content;

  if (hasSlideshow) {
    // Cloud-side multi-frame teaser. Slideshow component owns its
    // own image lifecycle — we just feed it the frames + poster.
    content = (
      <VideoFrameSlideshow
        framePaths={slideshowFrames}
        active={Boolean(hovered)}
        posterUrl={posterUrl}
        alt=""
      />
    );
  } else if (errored) {
    content = <ThumbGlyph icon={glyph} />;
  } else if (isImage) {
    const url = posterUrl || sourceUrl;
    content = url
      ? <ThumbImage src={url} onError={() => setErrored(true)} />
      : <ThumbGlyph icon={glyph} />;
  } else if (isVideo) {
    const url = posterUrl || extractedFrame;
    content = url
      ? <ThumbImage src={url} onError={() => setErrored(true)} />
      : <ThumbGlyph icon={glyph} />;
  } else {
    // PDF / text / other — cloud-baked thumbnail if any, glyph otherwise.
    content = posterUrl
      ? <ThumbImage src={posterUrl} onError={() => setErrored(true)} />
      : <ThumbGlyph icon={glyph} />;
  }

  return (
    <>
      {content}
      {duration ? (
        <span className="project-files-duration" aria-hidden="true">
          {formatDuration(duration)}
        </span>
      ) : null}
    </>
  );
}

// Minimal mm:ss / h:mm:ss formatter. Duplicated here from ProjectFiles
// (one extra import is one too many) — kept tiny so the duplication
// isn't a maintenance hazard. Update both if the format ever changes.
function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}
