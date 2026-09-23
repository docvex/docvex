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

// ── Wheel → zoom ───────────────────────────────────────────────────────────
// A trackpad is a CONTINUOUS device and has to be zoomed continuously. The
// previous design accumulated deltas and took a fixed 1.3× step each time the
// total crossed a threshold (240px on a Mac), which failed three ways at once:
//
//   • a PINCH never reached the threshold. macOS reports a pinch as a wheel
//     event with ctrlKey set and deltas of a few pixels each, so a short,
//     gentle pinch accumulated ~50px and zoomed by nothing whatsoever;
//   • a two-finger FLICK blew straight through it. Scroll deltas are large and
//     go on arriving as momentum after the fingers lift, so one flick took the
//     whole 3-step cap — 1.3³ ≈ 2.2× — in an instant and then kept going;
//   • the 220ms gesture gap wiped the accumulator, so a slow deliberate pinch
//     threw its own progress away between its own events.
//
// Fast, slow, and nothing at all — from one gesture, depending only on how the
// hand happened to move. So there is no accumulator and no step any more: each
// event's delta maps straight to a MULTIPLIER, exp(−delta × gain). Zoom is then
// proportional to how far the fingers actually moved, and composes to the same
// total however many events the OS chose to cut the gesture into.
//
// Two gains, because the two gestures report on scales that differ by better
// than an order of magnitude. The wheel gain is set so a mouse detent (~100px)
// still lands on 1.3× — exactly the old step — so nothing changes off the Mac.
const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
// A pinch is a trackpad gesture on either platform, and reports its own scale:
// a comfortable full pinch totals ~100px, which this makes 3×.
const PINCH_GAIN = 0.011;
// The plain wheel, which is two DIFFERENT devices. A mouse reports one big
// quantised delta per notch (~100px) and wants a decisive jump for it; a
// trackpad reports a stream of small ones for a continuous finger movement AND
// goes on reporting momentum after the fingers lift, so the same gain would
// turn one hard flick into 13×. Off the Mac the gain is set so a notch lands on
// 1.3× — exactly the old step, no change where nothing was wrong. On the Mac,
// where the pointing device is overwhelmingly a trackpad (a Magic Mouse reports
// the same way), it is set so a hard flick with its momentum lands near 2.5×.
// A detented mouse on a Mac is then a little gentler per notch, which is a fair
// price for the gesture nine users in ten are actually making.
const WHEEL_GAIN = IS_MAC ? 0.0014 : 0.0026;
// However hard a single event pushes, it is worth at most this much — a stray
// 2000px delta must not throw the zoom across its whole range in one frame.
// Set clear of a real mouse notch (a 150px detent is 1.48×) so it only ever
// catches the pathological case.
const MAX_EVENT_FACTOR = 1.5;

// The multiplier one wheel event asks for. 1 = nothing to do.
export function wheelZoomFactor(e) {
  // deltaMode: 0 px, 1 lines, 2 pages — normalise so the gain means the same
  // thing whatever units the device reports in.
  const px = e.deltaMode === 1 ? e.deltaY * 16
    : e.deltaMode === 2 ? e.deltaY * 400
      : e.deltaY;
  if (!px) return 1;
  const f = Math.exp(-px * (e.ctrlKey ? PINCH_GAIN : WHEEL_GAIN));
  return Math.min(MAX_EVENT_FACTOR, Math.max(1 / MAX_EVENT_FACTOR, f));
}

// The step the pill's + / − buttons take. A button is a discrete thing and
// wants a discrete jump; only the wheel is continuous.
export const ZOOM_STEP = 1.3;

// Every zoom entry point takes either a direction — 'in' / 'out', from a
// button — or `{ by: factor }`, from the wheel. This resolves both to the
// multiplier to apply, so a pane's clamping and pan maths are written once.
export function zoomFactorOf(req, step = ZOOM_STEP) {
  if (req && typeof req === 'object' && typeof req.by === 'number') return req.by;
  return req === 'in' ? step : 1 / step;
}

// Returns a handler-shaped function: feed it wheel events, it calls
// `zoomBy({ by: factor })` for each one that asks for anything.
export function createWheelZoom(zoomBy) {
  return (e) => {
    const by = wheelZoomFactor(e);
    if (by !== 1) zoomBy({ by });
  };
}

// How long after the last wheel event a gesture counts as finished — when the
// easing/repainting a pane suppressed during the gesture is restored.
export const ZOOM_SETTLE_MS = 180;
