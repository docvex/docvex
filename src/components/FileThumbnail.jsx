import React, { useRef } from 'react';
import { useThumbnail } from '../lib/thumbnailResolver';
import { glyphForFile } from './fileGlyph';
import { useAppPrefs } from '../context/AppPrefsContext';

// Unified thumbnail renderer. Backed by lib/thumbnailResolver.js's
// useThumbnail hook — all the resolution, signing, regen, and caching
// happens there. This component is just paint: take the resolved
// poster URL (or null) and either show an <img>, the video slideshow,
// or the MIME glyph.
//
// Two API shapes, for backward compatibility during the migration:
//
//   1. NEW (preferred): pass a descriptor built via
//        lib/thumbnailDescriptor.js. Everything else (mime, name,
//        cache key, video frames, duration pill) derives from there.
//
//        <FileThumbnail descriptor={descriptor} hovered={hovered} />
//
//   2. LEGACY: pass loose props (mimeType, posterUrl, sourceUrl,
//      slideshowFrames, glyph, duration). Internally we synthesize a
//      descriptor — the resolver still owns the cache, but without a
//      proper contentKey we lose dedupe across surfaces. Call sites
//      should migrate to descriptors.
//
// Hover prop: when true AND the descriptor exposes framePaths (videos
// uploaded post-migration-010 with the 5-frame slideshow column),
// the slideshow cycles. Available on EVERY surface that consumes this
// component now — previously only the Files page grid wired it.

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

// Minimal mm:ss / h:mm:ss formatter. Kept tiny + inline so the
// duration pill stays self-contained inside this component.
function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

// Adapter: turn legacy props into a descriptor so the resolver still
// keys consistently. Synthetic contentKey is derived from whatever
// URLs the caller passed — fine for cache hits within one surface but
// won't dedupe across surfaces.
function legacyDescriptor({ mimeType, posterUrl, sourceUrl, slideshowFrames, name }) {
  const posters = posterUrl ? [{ kind: 'url', url: posterUrl }] : [];
  const source = sourceUrl ? { kind: 'url', url: sourceUrl } : null;
  // `name` is optional in the legacy path; fall back to a synthetic
  // one so DOCX detection still has something to look at.
  const keyParts = [posterUrl || '', sourceUrl || '', mimeType || ''].join('|');
  return {
    name: name || '',
    mime: mimeType || '',
    contentKey: keyParts ? `legacy:${keyParts}` : '',
    posters,
    framePaths: Array.isArray(slideshowFrames) && slideshowFrames.length > 1
      ? slideshowFrames
      : null,
    source,
    duration: null,
  };
}

export default function FileThumbnail(props) {
  const {
    descriptor: incomingDescriptor,
    hovered,
    glyph: legacyGlyph,
    duration: legacyDuration,
    // Legacy fields — synthesized into a descriptor below when no
    // proper descriptor is passed.
    mimeType,
    posterUrl: legacyPoster,
    sourceUrl: legacySource,
    slideshowFrames: legacyFrames,
  } = props;

  const descriptor = incomingDescriptor || legacyDescriptor({
    mimeType,
    posterUrl: legacyPoster,
    sourceUrl: legacySource,
    slideshowFrames: legacyFrames,
  });

  const { posterUrl, errored, reload } = useThumbnail(descriptor);

  // One-shot retry guard, reset whenever the file (contentKey) changes.
  // If a painted thumbnail's URL fails to load — most often a cached
  // signed URL that expired (10-min TTL) before this mount — re-sign it
  // once via reload(). Capped at a single retry per file so a genuinely
  // broken source (e.g. deleted object) can't loop.
  const retryRef = useRef({ key: null, count: 0 });
  if (retryRef.current.key !== (descriptor?.contentKey || null)) {
    retryRef.current = { key: descriptor?.contentKey || null, count: 0 };
  }
  const handleImgError = () => {
    if (retryRef.current.count < 1) {
      retryRef.current.count += 1;
      reload();
    }
  };

  const mime = descriptor?.mime || '';
  const duration = legacyDuration ?? descriptor?.duration ?? null;
  const glyph = legacyGlyph || glyphForFile(mime, descriptor?.name);

  // Settings → "Display thumbnails". When off, always show the compact type
  // glyph instead of the poster (the hook above still runs — unconditional —
  // we just ignore its result so file previews don't load).
  const { prefs } = useAppPrefs();

  // ── Pick the renderer ────────────────────────────────────────────
  let content;
  if (!prefs.thumbnails) {
    content = <ThumbGlyph icon={glyph} />;
  } else if (posterUrl) {
    content = <ThumbImage src={posterUrl} onError={handleImgError} />;
  } else if (errored || !descriptor) {
    content = <ThumbGlyph icon={glyph} />;
  } else {
    // Resolution in flight — render the glyph in place so the layout
    // is stable (no flash from empty → glyph → poster). The <img>
    // will replace it as soon as posterUrl lands.
    content = <ThumbGlyph icon={glyph} />;
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
