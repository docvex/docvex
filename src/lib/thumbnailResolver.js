// Unified thumbnail resolver — the single "what URL do I paint for
// this file?" code path the whole app uses. Replaces three parallel
// implementations that used to live in FileCard (Files / Main),
// LocalFileCard (Files / My branch), and CrThumb (Dashboard / Version
// control). Each of those rolled its own fallback chain, its own cache
// keying, and its own DOCX rich-render integration — so the same file
// often looked different across surfaces, and in-place edits could
// leave one surface stale while another regenerated.
//
// API:
//   const { posterUrl, framePaths, glyphKind, errored } = useThumbnail(descriptor);
//
// Descriptor shape (build via lib/thumbnailDescriptor.js):
//   {
//     name:         string,                // filename — drives DOCX ext detection
//     mime:         string,                // MIME type
//     contentKey:   string,                // STABLE cache key. Changes when the
//                                          // bytes change (content_hash / mtime /
//                                          // pending change_id). Same key → same
//                                          // cached result across surfaces.
//     posters:      Array<PosterSource>,   // pre-baked thumb candidates, in priority order
//     framePaths:   string[] | null,       // canonical-bucket paths for video frame slideshow
//     source:       BytesSource | null,    // bytes to regenerate from when no poster works
//     duration:     number | null,
//   }
//
//   PosterSource = { kind: 'cloud' | 'pending', path }            // signed against the right bucket
//                | { kind: 'url', url }                            // ready-to-use URL (blob: / localfile:// / https:)
//   BytesSource  = same shapes as PosterSource — what to fetch when regen is needed.
//
// Fallback chain inside the hook:
//   1. Cache hit on contentKey → return.
//   2. Try each poster source in order; first signed/resolved URL wins
//      (image branch: just use it; DOCX branch: replace it with a rich
//      regen from the same bytes so styling matches the modal preview).
//   3. No poster worked → try `source`. For images return URL directly.
//      PDFs / videos / DOCX go through generateThumbnail (or the rich
//      DOCX path) to produce a blob: URL.
//   4. Still nothing → null → component renders glyph.
//
// Cache invalidation:
//   • Same contentKey = cache hit (cheap on re-mount, scroll, tab switch).
//   • Different contentKey = miss → fresh resolution. Local edits bump
//     mtime → contentKey changes → fresh resolution. Cloud Realtime
//     UPDATE with new content_hash → same.
//   • Approve flow: pending paths disappear, cloud paths arrive — the
//     row's content_hash changes, contentKey changes, fresh resolution.
//
// Concurrency:
//   • Single in-flight Promise per contentKey — two cards mounting at
//     once share one network round-trip + one regen pass.

import { useCallback, useEffect, useState } from 'react';
import { createSignedDownloadUrl } from './projectFiles';
import { createPendingSignedUrl } from './branches';
import { generateThumbnail, isPptxFile, isTextThumbable } from './thumbnails';

// ── Unified cache ─────────────────────────────────────────────────────

// resolved blob/URL string keyed by contentKey. Survives unmounts so
// scroll + tab switches don't re-resolve. FIFO eviction with blob URL
// revocation so we don't accumulate orphaned bytes in memory.
const _cache = new Map();
const _CACHE_MAX = 300;
const _inflight = new Map(); // contentKey → Promise<string | null>

function _remember(key, url) {
  if (_cache.has(key)) {
    // Replacing — revoke the old blob URL before overwriting.
    const old = _cache.get(key);
    if (old && old !== url && old.startsWith('blob:')) {
      try { URL.revokeObjectURL(old); } catch { /* ignore */ }
    }
    _cache.delete(key); // delete + re-set so it lands at the tail (LRU-ish)
  } else if (_cache.size >= _CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) {
      const oldUrl = _cache.get(oldest);
      if (oldUrl && oldUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(oldUrl); } catch { /* ignore */ }
      }
      _cache.delete(oldest);
    }
  }
  _cache.set(key, url);
}

// Evict a single contentKey (revoking a blob URL if present) so the
// next resolution re-signs from scratch. Used when an <img> built from
// a cached — possibly expired — signed URL fails to load.
function _evict(key) {
  if (!key) return;
  const old = _cache.get(key);
  if (old && old.startsWith('blob:')) {
    try { URL.revokeObjectURL(old); } catch { /* ignore */ }
  }
  _cache.delete(key);
  _inflight.delete(key);
}

// Public eviction for debug menus / sign-out hooks. Idempotent.
export function clearThumbnailCache() {
  for (const url of _cache.values()) {
    if (url && url.startsWith('blob:')) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
  }
  _cache.clear();
  _inflight.clear();
}

// ── Source resolvers ──────────────────────────────────────────────────

// Resolve a PosterSource / BytesSource shape to a usable URL string.
// Returns null on failure so the caller can fall through.
async function signSource(src) {
  if (!src) return null;
  if (src.kind === 'url') return src.url || null;
  if (src.kind === 'cloud' && src.path) {
    const { data, error } = await createSignedDownloadUrl(src.path, 600);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  }
  if (src.kind === 'pending' && src.path) {
    const { data, error } = await createPendingSignedUrl(src.path, 600);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  }
  return null;
}

// Pull bytes off a source URL + wrap as a File with the right MIME so
// the generator dispatchers (which key off file.type) route correctly.
// Returns null on fetch failure.
async function fetchAsFile(url, name, mime) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new File(
      [blob],
      name || 'file',
      { type: mime || blob.type || 'application/octet-stream' },
    );
  } catch {
    return null;
  }
}

// Extract a single video frame by streaming the URL directly into a
// hidden <video>. Critical for large videos — the alternative
// (fetch-the-whole-file → wrap as File → URL.createObjectURL) would
// download megabytes just to grab a poster frame, and HTTP video
// elements already support byte-range requests for fast seek. Returns
// a blob: URL on success, null on failure / timeout.
function extractVideoPosterFromUrl(sourceUrl, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    if (/^https?:/i.test(sourceUrl)) {
      // crossOrigin only set for remote sources — required so canvas
      // reads don't taint when drawing the frame. localfile:// and
      // blob: are same-origin and some Chromium builds reject
      // crossOrigin='anonymous' on the custom protocol, silently
      // aborting the load.
      video.crossOrigin = 'anonymous';
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      try {
        video.removeAttribute('src');
        video.load();
      } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
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
    video.src = sourceUrl;
  });
}

// ── Resolution pipeline ───────────────────────────────────────────────

// Walks the fallback chain to produce a poster URL for the descriptor.
// Returns null when every branch failed (component will render glyph).
//
// Image / video / PDF / PPTX / plain-text get thumbnails. Every other
// MIME (DOCX, generic binaries…) falls through to null so the component
// renders its MIME glyph instead — a deliberate choice to stop the app
// from showing rasterized "previews" for file types where the rendering
// is approximate or misleading. Plain text is exempt: rendering its first
// lines is faithful (the text IS the content), not an approximation.
async function resolve(descriptor) {
  const { name, mime, posters, source } = descriptor;
  const m = mime || '';
  // PPTX is thumbable via its embedded first-slide preview (extracted in
  // generateThumbnail). Detected by name too, since the local-folder MIME
  // guesser reports .pptx as application/octet-stream.
  const isThumbable = m.startsWith('image/')
    || m.startsWith('video/')
    || m === 'application/pdf'
    || isPptxFile(m, name)
    || isTextThumbable(m, name);
  if (!isThumbable) return null;

  // 1. Try each poster source in order.
  for (const p of (posters || [])) {
    const url = await signSource(p);
    if (url) return url;
  }

  // 2. No poster. Try the source.
  if (!source) return null;
  const sourceUrl = await signSource(source);
  if (!sourceUrl) return null;

  // Image bytes ARE the poster — the renderer just <img src>s it.
  if (m.startsWith('image/')) return sourceUrl;

  // Video fast-path: stream the source directly into a hidden <video>
  // and snap a frame. Avoids the whole-file fetch the generic branch
  // below would do — large videos on slow connections would otherwise
  // hang the card while megabytes download just to grab a poster.
  if (m.startsWith('video/')) {
    return extractVideoPosterFromUrl(sourceUrl);
  }

  // PDF / PPTX — fetch bytes and let generateThumbnail produce the
  // poster (pdf.js rasters page 1; PPTX yields its embedded slide preview).
  const typed = await fetchAsFile(sourceUrl, name, mime);
  if (!typed) return null;
  const blob = await generateThumbnail(typed);
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

// Dedupes concurrent resolutions for the same contentKey — two cards
// mounting at once share one round-trip / one regen.
async function resolveOnce(descriptor) {
  const key = descriptor.contentKey;
  if (!key) return resolve(descriptor); // no cache key → no dedupe
  const cached = _cache.get(key);
  if (cached) return cached;
  const inflight = _inflight.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const url = await resolve(descriptor);
      if (url) _remember(key, url);
      return url;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, promise);
  return promise;
}

// ── React hook ────────────────────────────────────────────────────────

// Resolve a descriptor to a poster URL + status. Re-runs whenever
// `contentKey` changes — the descriptor's other fields are derived
// from the same upstream state, so contentKey alone is the canonical
// "the thing to display has changed" signal.
//
// Returns:
//   posterUrl: string | null   — what to <img src>. null = render glyph.
//   loading:   boolean         — true while the first resolution is in flight.
//   errored:   boolean         — true if the resolution finished with null.
export function useThumbnail(descriptor) {
  const key = descriptor?.contentKey || null;
  // Synchronous cache read — same-render hit so re-mounts don't flash blank.
  const [posterUrl, setPosterUrl] = useState(() => (key ? _cache.get(key) || null : null));
  const [loading, setLoading] = useState(() => Boolean(key) && !_cache.has(key));
  const [errored, setErrored] = useState(false);
  // Bumping this forces a fresh resolution for the current key — see
  // `reload` below (called when a painted thumbnail fails to load).
  const [retryTick, setRetryTick] = useState(0);

  // Drop the cached (likely expired) URL for this key and re-resolve.
  // The component's onError calls this when an <img> fails to load.
  const reload = useCallback(() => {
    if (!key) return;
    _evict(key);
    setRetryTick((t) => t + 1);
  }, [key]);

  useEffect(() => {
    if (!descriptor || !key) {
      setPosterUrl(null);
      setLoading(false);
      setErrored(false);
      return undefined;
    }
    // Cache hit fast-path. setState skipped when value is unchanged
    // (React bails on equal primitive setState).
    const cached = _cache.get(key);
    if (cached) {
      setPosterUrl(cached);
      setLoading(false);
      setErrored(false);
      return undefined;
    }
    let cancelled = false;
    setPosterUrl(null);
    setLoading(true);
    setErrored(false);
    resolveOnce(descriptor).then((url) => {
      // Only `cancelled` guards the write. It flips in this effect's
      // cleanup, which runs whenever `key` changes (or on unmount), so a
      // finished resolution always belongs to the CURRENT contentKey. We
      // deliberately do NOT compare descriptor object identity: the memo
      // upstream rebuilds the descriptor (same contentKey) whenever a
      // Realtime echo or refetch hands down a fresh file object, and
      // discarding the result in that case left thumbnails stuck on
      // their glyph.
      if (cancelled) return;
      setPosterUrl(url || null);
      setLoading(false);
      setErrored(!url);
    });
    return () => { cancelled = true; };
    // Resolve reads the descriptor's content but cache-keys on
    // contentKey, so contentKey (+ the manual retry tick) are the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retryTick]);

  return { posterUrl, loading, errored, reload };
}
