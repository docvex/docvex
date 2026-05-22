import React, { useEffect, useRef, useState } from 'react';
import { createSignedDownloadUrl } from '../lib/projectFiles';
import './VideoFrameSlideshow.css';

// Auto-rotating slideshow of the 5 frames extracted at upload time for a
// video file. Used by:
//   - FileCard (active=true on hover; pinned to frame 0 otherwise)
//   - VideoPreview inside FileDetailModal (active=true the whole time)
//
// Signed URLs for frames 1-N are fetched ONLY once the slideshow goes
// active (i.e. the card is hovered), then cached at module level by
// createSignedDownloadUrl so a re-hover is instant. Signing eagerly on
// mount was the wrong call: a grid of N video cards fired N×(frames)
// signed-URL requests the moment it rendered — wasteful, and a flood of
// 400s when a row's frames don't exist (e.g. unapproved change-request
// proposals whose frames aren't in the canonical bucket yet). While
// inactive the static `posterUrl` (frame 0, already resolved by the
// parent for the thumbnail) is all that's shown, so no frame signing is
// needed until the user actually hovers to cycle.
export default function VideoFrameSlideshow({
  framePaths,
  active,
  intervalMs = 600,
  posterUrl,
  alt = '',
}) {
  // urls[i] is the signed URL for framePaths[i], or undefined while pending.
  const [urls, setUrls] = useState(() => (posterUrl ? [posterUrl] : []));
  const [currentIndex, setCurrentIndex] = useState(0);
  // Track the latest framePaths array via ref to bail out of in-flight
  // signs if the parent swaps the paths mid-fetch.
  const pathsRef = useRef(framePaths);
  pathsRef.current = framePaths;

  // Resolve every frame's signed URL in parallel — but only while the
  // slideshow is ACTIVE (hovered). Skip frame 0 if the caller already
  // provided posterUrl. Failures surface as `undefined` in the array —
  // the render path falls back to posterUrl for any index that hasn't
  // resolved yet. Gating on `active` is what stops a freshly-rendered
  // grid from firing a frame-signing request per card on mount.
  useEffect(() => {
    if (!active) return undefined;
    if (!Array.isArray(framePaths) || framePaths.length === 0) return undefined;
    let cancelled = false;
    const next = posterUrl ? [posterUrl] : [];
    // Pre-size so we can write by index without races between parallel
    // resolutions on different indices.
    next.length = framePaths.length;
    if (posterUrl) next[0] = posterUrl;

    const tasks = framePaths.map(async (path, i) => {
      if (i === 0 && posterUrl) return;
      const { data } = await createSignedDownloadUrl(path, 600);
      if (cancelled || pathsRef.current !== framePaths) return;
      if (data?.signedUrl) {
        next[i] = data.signedUrl;
        // Trigger a render every time a frame lands so the slideshow can
        // start cycling as soon as it has >=2 resolved URLs. Using the
        // slice-spread guarantees a new array reference, which React
        // needs to commit the update.
        setUrls([...next]);
      }
    });
    Promise.all(tasks).catch(() => { /* swallowed — partial failures are OK */ });

    return () => { cancelled = true; };
  }, [active, framePaths, posterUrl]);

  // Cycle the frame index while active. Reset to 0 on deactivation so a
  // re-hover starts the slideshow from the beginning instead of resuming
  // mid-cycle (resuming reads as random / disorienting when scanning a
  // grid of cards).
  useEffect(() => {
    if (!active) {
      setCurrentIndex(0);
      return undefined;
    }
    if (!Array.isArray(framePaths) || framePaths.length < 2) return undefined;
    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % framePaths.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, framePaths, intervalMs]);

  // Render frame at the current index, falling back to the poster (or the
  // first resolved URL we have) while higher-index frames are still
  // pending. An empty render is fine while everything is loading — the
  // parent container's background covers it.
  const currentUrl = urls[currentIndex] || posterUrl || urls.find(Boolean) || null;
  if (!currentUrl) {
    return <div className="video-frame-slideshow video-frame-slideshow-empty" />;
  }
  return (
    <img
      className="video-frame-slideshow"
      src={currentUrl}
      alt={alt}
      loading="lazy"
      draggable="false"
    />
  );
}
