import React, { useEffect, useRef } from 'react';
// clientX is viewport px; the transform/background-position we set are layout
// px — under the app's CSS-zoom downscale the two differ (see lib/appZoom).
// x/y are kept in LAYOUT px so rounding still lands on the dot grid's own
// (layout-px) tile offsets.
import { toLayoutPx } from '../lib/appZoom';
import './CursorSpotlight.css';

// A cursor-following "spotlight" that brightens the ambient dot grid in a soft
// radius around the pointer. Paired with the always-on dot grid painted by the
// host surface's `::before` (AppShell.css / Launch.css), which is anchored to
// the viewport top-left (`background-position: 0 0`) so this layer can stay
// pixel-aligned to it.
//
// PERF — why this is a real element and not a `::after` driven by a CSS var:
// the old version wrote `--cursor-x/--cursor-y` to :root every pointermove.
// Custom properties on the document root are INHERITED by every element, so
// each write invalidated and recalculated style for the WHOLE document tree —
// cheap at idle, brutal on move (the bottleneck scales with DOM size). Here we
// instead write `transform` to ONE dedicated node via a ref:
//   * transform is GPU-composited (no layout, no document-wide recalc),
//   * the box is small (430px = the 215px spotlight radius's diameter) so the
//     only paint is shifting a cached 24px dot tile inside it,
//   * the mask is STATIC (centred), rasterised once instead of every frame.
// The `background-position` counter-shift cancels the transform so the brighter
// dots stay locked to the viewport grid instead of sliding with the box.
// Props:
//   className — style hook for the box (default 'cursor-spotlight'); pass a
//               custom class to retint the dots for a different surface.
//   contain   — when true the box is positioned ABSOLUTELY inside its nearest
//               positioned ancestor (which should be overflow:hidden) and tracks
//               the cursor relative to that ancestor, so the spotlight stays
//               clipped to one panel. Default false = viewport-fixed (app-wide).
export default function CursorSpotlight({ className = 'cursor-spotlight', contain = false }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const R = 215; // spotlight radius — keep in sync with CursorSpotlight.css
    let frame = null;
    let x = contain ? 0 : toLayoutPx(window.innerWidth) / 2;
    let y = contain ? 0 : toLayoutPx(window.innerHeight) / 2;

    const apply = () => {
      frame = null;
      // Round to whole pixels so the dot pattern lands on integer offsets
      // (avoids shimmering subpixel re-rasterisation of the tile).
      const px = Math.round(x);
      const py = Math.round(y);
      el.style.transform = `translate3d(${px - R}px, ${py - R}px, 0)`;
      el.style.backgroundPosition = `${R - px}px ${R - py}px`;
    };

    const onMove = (e) => {
      if (contain) {
        // clientX/Y and getBoundingClientRect are both viewport (post-zoom)
        // space, so the delta is a valid panel-relative coordinate; one
        // toLayoutPx converts it to the layout px we write into transform.
        const parent = el.offsetParent || el.parentElement;
        if (!parent) return;
        const r = parent.getBoundingClientRect();
        x = toLayoutPx(e.clientX - r.left);
        y = toLayoutPx(e.clientY - r.top);
      } else {
        x = toLayoutPx(e.clientX);
        y = toLayoutPx(e.clientY);
      }
      if (frame == null) frame = requestAnimationFrame(apply);
    };

    apply(); // position before the first pointermove
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [contain]);

  return <div ref={ref} className={className} aria-hidden="true" />;
}
