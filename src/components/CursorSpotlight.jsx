import React, { useEffect, useRef } from 'react';
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
export default function CursorSpotlight() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const R = 215; // spotlight radius — keep in sync with CursorSpotlight.css
    let frame = null;
    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;

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
      x = e.clientX;
      y = e.clientY;
      if (frame == null) frame = requestAnimationFrame(apply);
    };

    apply(); // position at viewport centre before the first pointermove
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, []);

  return <div ref={ref} className="cursor-spotlight" aria-hidden="true" />;
}
