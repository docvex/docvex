// App base zoom. The former 20% downscale (`zoom: 0.8`) has been removed —
// BASE_APP_ZOOM is now 1 (`:root { zoom: 1 }` in src/index.css). The Settings
// "Display scale" preference still composes on top: webFrame zoom on Electron,
// inline CSS `zoom` on <html> on web (platform.setAppZoom). Because display
// scale is itself CSS zoom on web, the viewport-vs-layout split below still
// applies whenever a non-1 scale is active — appZoom() reads the LIVE zoom so
// toLayoutPx compensates automatically. Keep the constant and the index.css
// declaration in sync.
//
// CSS zoom keeps layout, scrollbars and position:fixed behaving, but it splits
// geometry into two coordinate spaces:
//   viewport space — e.clientX/Y, window.innerWidth/Height, and everything
//                    getBoundingClientRect() returns (post-zoom);
//   layout space   — offsetWidth/scrollTop, SVG path coordinates, and every
//                    CSS length you SET (style.left, transform: translate(…)).
// Writing a viewport-space number into a CSS length lands 20% short of the
// cursor. Any code that turns pointer/viewport coordinates into CSS pixels
// must divide by the effective zoom first — that's toLayoutPx. Ratios of two
// viewport-space numbers (percent splitters, seek bars) cancel the zoom out
// and need no conversion. webFrame zoom needs NO compensating — it scales
// clientX and layout identically.

// Base app zoom = 1 (the former 0.8 baseline downscale was removed). The
// Settings display-scale preference still composes on top of this via
// platform.setAppZoom; appZoom() reads the LIVE computed zoom so that scale is
// still compensated by toLayoutPx.
export const BASE_APP_ZOOM = 1;

// Effective CSS zoom on the root right now. Read live (rather than assuming
// BASE_APP_ZOOM) so web display-scale — which is also CSS zoom — is
// compensated by the same math automatically.
export function appZoom() {
  if (typeof document === 'undefined') return 1;
  const root = document.documentElement;
  // currentCSSZoom (Chromium 128+); computed-style parse as the fallback.
  const z = root.currentCSSZoom ?? parseFloat(getComputedStyle(root).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

// Viewport-space length/coordinate (clientX, innerWidth, a DOMRect value)
// → layout-space CSS pixels, safe to write into a style.
export function toLayoutPx(v) {
  return v / appZoom();
}
