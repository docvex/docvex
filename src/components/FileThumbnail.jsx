import React from 'react';
import VideoFrameSlideshow from './VideoFrameSlideshow';
import { useThumbnail } from '../lib/thumbnailResolver';
import { glyphForFile } from './fileGlyph';

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

  const { posterUrl, errored } = useThumbnail(descriptor);
  const mime = descriptor?.mime || '';
  const isVideo = mime.startsWith('video/');
  const framePaths = descriptor?.framePaths || null;
  const hasSlideshow = isVideo && Array.isArray(framePaths) && framePaths.length > 1;
  const duration = legacyDuration ?? descriptor?.duration ?? null;
  const glyph = legacyGlyph || glyphForFile(mime, descriptor?.name);

  // ── Pick the renderer ────────────────────────────────────────────
  let content;
  if (hasSlideshow) {
    // Video with the multi-frame teaser column populated. The
    // slideshow component cycles the 5 frames while `active=true`
    // and pins to frame 0 (or `posterUrl`) otherwise — so this same
    // path doubles as the static-poster renderer when not hovered.
    content = (
      <VideoFrameSlideshow
        framePaths={framePaths}
        active={Boolean(hovered)}
        posterUrl={posterUrl}
        alt=""
      />
    );
  } else if (posterUrl) {
    content = <ThumbImage src={posterUrl} onError={() => {}} />;
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
