import { useEffect } from 'react';

// Track the cursor's viewport position and publish it as CSS variables on
// :root (--cursor-x / --cursor-y). Surfaces that paint the ambient dot grid
// read those vars in a `::after` spotlight mask to brighten the dots in a
// fixed radius around the cursor (see AppShell.css / Launch.css).
//
// Throttled with requestAnimationFrame so we hit at most ~60Hz even on
// trackpads/mice that fire pointermove at 1kHz — a single inline-style write
// per frame, skipping intermediate frames to avoid stacking layout work.
//
// Shared by AppShell (the main app) and the Launch hub, which lives outside
// AppShell and so needs its own subscription.
export default function useCursorSpotlight() {
  useEffect(() => {
    const root = document.documentElement;
    let pendingFrame = null;
    let lastX = 0;
    let lastY = 0;

    const apply = () => {
      root.style.setProperty('--cursor-x', `${lastX}px`);
      root.style.setProperty('--cursor-y', `${lastY}px`);
      pendingFrame = null;
    };

    const onMove = (e) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (pendingFrame == null) {
        pendingFrame = requestAnimationFrame(apply);
      }
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (pendingFrame != null) cancelAnimationFrame(pendingFrame);
    };
  }, []);
}
