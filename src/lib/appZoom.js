// App-wide 20% downscale. The whole UI renders smaller via a plain CSS
// `zoom: 0.8` baked into the app's own stylesheet (`:root` in src/index.css) —
// a stylesheet-level scale, NOT Electron's webFrame zoom. webFrame stays
// reserved for the Settings "Display scale" preference, which composes
// independently on top (total visual scale = BASE_APP_ZOOM × display scale).
// On web there is no webFrame, so platform.setAppZoom folds this baseline into
// the inline `zoom` it writes on <html> — keep the constant and the index.css
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

export const BASE_APP_ZOOM = 0.8;

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
