// ONE POINTER FOR THE WHOLE APP.
//
// Every effect that follows the mouse — the dotted background spotlight
// (CursorSpotlight), the sidebar's light, the hover lights on buttons and tabs
// (`--item-spot-x/y`), the rails' glows, the custom tooltips — used to keep its
// own listener, read its own rects and write its own styles, each on its own
// schedule. Hovering one sidebar tab ran five of them, interleaving reads and
// writes, some on every raw event.
//
// Now there is ONE listener on the window. It only records where the pointer
// is. Once per animation frame the effects that subscribed run in two passes:
//   1. `read(p)`  — every effect measures what it needs (rects), nothing writes;
//   2. `write(p, whatReadReturned)` — every effect writes its styles.
// So a frame does one layout at most, however many effects are live, and no
// effect ever runs more than once a frame. A `write` returning `true` asks for
// another frame (an eased glow still travelling); frames stop when nothing
// moved and nothing asked.
//
// p = { x, y }       viewport px (clientX / clientY)
//     { lx, ly }     layout px (toLayoutPx — what a CSS length wants)
//     target         the element under the pointer (null once it left)
//     inWindow       false after the pointer left the window
//     moved          true when the pointer moved since the previous frame
//     ts             the frame's timestamp
import { toLayoutPx } from './appZoom';
import { perfAllows } from './perf';

const subs = new Set();
let x = 0;
let y = 0;
let target = null;
let inWindow = false;
let moved = false;
let raf = 0;
let listening = false;

function frame(ts) {
  raf = 0;
  const p = { x, y, lx: toLayoutPx(x), ly: toLayoutPx(y), target, inWindow, moved, ts };
  moved = false;
  const list = [...subs];
  const reads = new Array(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    if (!s.read) continue;
    try { reads[i] = s.read(p); } catch { reads[i] = undefined; }
  }
  let again = false;
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    if (!s.write) continue;
    try { if (s.write(p, reads[i]) === true) again = true; } catch { /* one effect never stops the rest */ }
  }
  if (again) schedule();
}
function schedule() { if (!raf) raf = requestAnimationFrame(frame); }

function onMove(e) {
  x = e.clientX;
  y = e.clientY;
  target = e.target;
  inWindow = true;
  moved = true;
  schedule();
}
function onLeaveWindow(e) {
  // `relatedTarget` null = the pointer left the window, not just an element.
  if (e.relatedTarget) return;
  target = null;
  inWindow = false;
  moved = true;
  schedule();
}

function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  // Capture + passive: it sees every move first and never delays scrolling.
  window.addEventListener('pointermove', onMove, { capture: true, passive: true });
  document.addEventListener('pointerout', onLeaveWindow, { capture: true, passive: true });
}
function unlisten() {
  if (!listening) return;
  listening = false;
  window.removeEventListener('pointermove', onMove, { capture: true });
  document.removeEventListener('pointerout', onLeaveWindow, { capture: true });
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
}

/** Subscribe an effect: `{ read?(p), write?(p, read) }` → unsubscribe. */
export function subscribePointer(sub) {
  subs.add(sub);
  listen();
  return () => {
    subs.delete(sub);
    if (!subs.size) unlisten();
  };
}

/** Ask for a frame without a pointer move (an effect that just appeared). */
export function requestPointerFrame() { if (listening) schedule(); }

/** Where the pointer is now (viewport px), for code that runs outside a frame. */
export function pointerNow() { return { x, y, lx: toLayoutPx(x), ly: toLayoutPx(y), target, inWindow }; }

// ── The per-control hover light (`--item-spot-x/y`) ─────────────────────────
// The control under the pointer, among those matching any REGISTERED selector,
// gets the pointer's position relative to itself; the one it left keeps its
// last value, as before. One rect read and two
// writes per frame for the whole app, instead of a handler per control.
const spotSelectors = new Map(); // selector → count
let spotSelectorText = '';
let spotEl = null;
let unsubSpot = null;

function spotRead(p) {
  if (!p.moved || !spotSelectorText) return null;
  // Below High the lights stay still (graphics preset, lib/perf).
  if (!perfAllows('spotlight')) return null;
  const el = p.target && p.target.closest ? p.target.closest(spotSelectorText) : null;
  return { el, r: el ? el.getBoundingClientRect() : null };
}
function spotWrite(p, got) {
  if (!got) return;
  const { el, r } = got;
  // The control the pointer LEFT keeps its last position, as every one of these
  // controls did with its own handler (a selected button's light would jump to
  // centre otherwise). The sidebar, which does recentre on leave, runs its own.
  spotEl = el;
  if (el && r) {
    el.style.setProperty('--item-spot-x', `${toLayoutPx(p.x - r.left)}px`);
    el.style.setProperty('--item-spot-y', `${toLayoutPx(p.y - r.top)}px`);
  }
}

/** Give every element matching `selector` the hover light. → unregister. */
export function registerHoverSpot(selector) {
  spotSelectors.set(selector, (spotSelectors.get(selector) || 0) + 1);
  spotSelectorText = [...spotSelectors.keys()].join(', ');
  if (!unsubSpot) unsubSpot = subscribePointer({ read: spotRead, write: spotWrite });
  return () => {
    const n = (spotSelectors.get(selector) || 1) - 1;
    if (n) spotSelectors.set(selector, n); else spotSelectors.delete(selector);
    spotSelectorText = [...spotSelectors.keys()].join(', ');
    if (!spotSelectors.size && unsubSpot) { unsubSpot(); unsubSpot = null; }
  };
}
