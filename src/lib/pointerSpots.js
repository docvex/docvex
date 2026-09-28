// The pointer-following lights that belong to ONE ELEMENT — a bar's or a
// composer's glow, a rail's chasing spotlight — driven by the app's one
// pointer (lib/pointer.js) instead of a mousemove listener each. The
// per-CONTROL hover light (`--item-spot-x/y`) is lib/pointer's
// registerHoverSpot; this file is the element-sized half.
//
// Every effect here reads its rects in the frame's read pass and writes in
// its write pass, so however many are live a frame does one layout at most.
import { useEffect } from 'react';
import { subscribePointer } from './pointer';
import { toLayoutPx } from './appZoom';
import { perfAllows } from './perf';
import '../styles/spotLights.css';

// ── The light elements ──────────────────────────────────────────────────────
// A host's light is two real elements appended to it — a glow
// (`.spot-light.spot-glow`) and a border shine (`.spot-light.spot-shine`),
// each holding a pre-drawn gradient dot (`.spot-dot`) that is MOVED by a
// transform (styles/spotLights.css; the Sidebar's recipe). They used to be the
// host's `::before` / `::after` with the gradient centred on `--spot-x/y`,
// which repainted both full-size layers on every frame the pointer moved.
// Injected here rather than written into each component's JSX, so a surface
// only needs its CSS. React leaves trailing children it did not create alone;
// a host that loses them (re-created, or its children replaced wholesale) is
// given them again on the next write.
const LIGHTS = new WeakMap(); // host → { glow, shine | null, liveUntil, liveTimer }

function makeLight(kind) {
  const w = document.createElement('span');
  w.className = `spot-light ${kind}`;
  w.setAttribute('aria-hidden', 'true');
  const dot = document.createElement('span');
  dot.className = 'spot-dot';
  w.appendChild(dot);
  return w;
}

/** Give `host` its light elements (once) → `{ glow, shine }`. `shine: false`
 *  for a surface with a glow alone. `fresh` when the pointer is already over
 *  the host: the lights start at opacity 0 for one style pass, so their hover
 *  fade runs instead of popping in. */
export function spotLights(host, { shine = true, fresh = false } = {}) {
  let l = LIGHTS.get(host);
  if (!l) {
    l = { glow: makeLight('spot-glow'), shine: shine ? makeLight('spot-shine') : null };
    LIGHTS.set(host, l);
  }
  const missing = [];
  if (l.glow.parentNode !== host) missing.push(l.glow);
  if (l.shine && l.shine.parentNode !== host) missing.push(l.shine);
  if (missing.length) {
    if (fresh) missing.forEach((w) => w.classList.add('spot-fresh'));
    missing.forEach((w) => host.appendChild(w));
    if (fresh) {
      // Resolve their style once at opacity 0; dropping the class then
      // transitions to whatever the host's hover rule says.
      void getComputedStyle(missing[0]).opacity;
      missing.forEach((w) => w.classList.remove('spot-fresh'));
    }
  }
  return l;
}

// How long a light keeps its own layer after its last move. Promoting it
// costs one repaint, so a light that keeps moving must not drop and retake it
// between frames; one that has settled gives it back (see `.is-live` in
// styles/spotLights.css — why the layer must not outlive the motion).
const LIVE_MS = 400;

function setLive(l, on) {
  for (const w of [l.glow, l.shine]) if (w) w.firstChild.classList.toggle('is-live', on);
}
function keepLive(l) {
  l.liveUntil = performance.now() + LIVE_MS;
  if (l.liveTimer) return;
  setLive(l, true);
  const check = () => {
    const left = l.liveUntil - performance.now();
    if (left > 0) { l.liveTimer = setTimeout(check, left); return; }
    l.liveTimer = 0;
    setLive(l, false);
  };
  l.liveTimer = setTimeout(check, LIVE_MS);
}

/** Centre `host`'s lights at (x, y) — layout px from the host's border-box
 *  corner, what `--spot-x/y` used to be. A composited move, no repaint.
 *  A 2D translate, not translate3d: a 3D transform would promote the dot
 *  even at rest, which is what `.is-live` exists to avoid. */
export function placeSpotLights(host, x, y, opts) {
  const l = spotLights(host, opts);
  const t = `translate(${x}px, ${y}px)`;
  for (const w of [l.glow, l.shine]) {
    if (!w) continue;
    const dot = w.firstChild;
    if (!dot.classList.contains('is-moved')) dot.classList.add('is-moved');
    if (dot.style.transform === t) continue;
    dot.style.transform = t;
  }
  keepLive(l);
}

// ── Snapped lights on the element the pointer is inside ────────────────────
// What `onMouseMove={miniHeaderSpot}` used to do on each bar: while the
// pointer moves anywhere inside an element matching a registered selector,
// that element's lights are centred on the pointer. Snap, not eased — the
// bars are thin strips, a trailing chase would mostly read as lag. Nothing is
// moved when the pointer leaves: the light fades out where it was, as it did.
// A selector registered `gated` stays still below the High graphics preset
// (lib/perf), like the handlers it replaces — still, not gone: its lights are
// given all the same, and simply not moved.
const glowSelectors = new Map(); // key → { selector, gated, shine, count }
let unsubGlow = null;

function glowRead(p) {
  if (!p.moved || !p.target || !p.target.closest) return null;
  const allowed = perfAllows('spotlight');
  const seen = new Set();
  const hits = [];
  glowSelectors.forEach(({ selector, gated, shine }) => {
    const still = gated && !allowed;
    // Every matching ancestor, not only the nearest: a mousemove bubbled
    // through all of them before.
    let el = p.target.closest(selector);
    while (el) {
      if (!seen.has(el)) {
        seen.add(el);
        hits.push({ el, shine, r: still ? null : el.getBoundingClientRect() });
      }
      el = el.parentElement ? el.parentElement.closest(selector) : null;
    }
  });
  return hits.length ? hits : null;
}
function glowWrite(p, hits) {
  if (!hits) return;
  for (const { el, shine, r } of hits) {
    if (r) placeSpotLights(el, toLayoutPx(p.x - r.left), toLayoutPx(p.y - r.top), { shine, fresh: true });
    else spotLights(el, { shine, fresh: true });
  }
}

/** Give every element matching `selector` lights that snap to the pointer
 *  (`shine: false` for a glow alone). → unregister. */
export function registerElementSpot(selector, { gated = false, shine = true } = {}) {
  const key = `${gated ? 1 : 0}|${shine ? 1 : 0}|${selector}`;
  const cur = glowSelectors.get(key);
  if (cur) cur.count += 1; else glowSelectors.set(key, { selector, gated, shine, count: 1 });
  if (!unsubGlow) unsubGlow = subscribePointer({ read: glowRead, write: glowWrite });
  // The hosts already drawn get their lights now, so one under a pointer that
  // has not moved yet shows its light where the old layer would have.
  if (typeof document !== 'undefined') document.querySelectorAll(selector).forEach((el) => spotLights(el, { shine }));
  return () => {
    const entry = glowSelectors.get(key);
    if (entry && entry.count > 1) entry.count -= 1; else glowSelectors.delete(key);
    if (!glowSelectors.size && unsubGlow) { unsubGlow(); unsubGlow = null; }
  };
}

/** registerElementSpot for as long as the calling component is mounted. */
export function useElementSpot(selector, { gated = false, shine = true } = {}) {
  useEffect(() => registerElementSpot(selector, { gated, shine }), [selector, gated, shine]);
}

/** The `.mini-glow` bars (styles/miniHeader.css): their spotlight and border
 *  shine. Call it in any component that renders one. */
export function useMiniGlowSpot() {
  useElementSpot('.mini-glow');
}

// ── A rail's spotlight, CHASING the pointer ─────────────────────────────────
// The sidebar-style glow + border shine on a rail (its injected lights, see
// above): Sidebar.jsx's loop to the letter — an exponential ease over elapsed
// time, so the chase runs at one speed whatever the refresh rate; parked once
// settled; snapped to the pointer on the first move after entering. `write`
// returns true while it is still travelling, which is what keeps frames
// coming once the pointer stops.
const EASE = 0.28;
const SETTLE = 0.5;
const FRAME_60 = 1000 / 60;

export function useRailSpotlight(ref, live = true) {
  useEffect(() => {
    const target = { x: 0, y: 0 };
    const pos = { x: 0, y: 0 };
    let inside = false;   // false again once the pointer left: the next entry snaps
    let running = false;
    let last = null;
    // The rail drawn already gets its lights now; one drawn later gets them
    // on the first move over it.
    if (ref.current) spotLights(ref.current);
    return subscribePointer({
      read(p) {
        if (!p.moved) return null;
        const el = ref.current;
        if (!el || !p.target || !el.contains(p.target)) { inside = false; return null; }
        // Graphics preset (lib/perf): below High the light stays where it is.
        if (!perfAllows('spotlight')) return { still: true };
        return { r: el.getBoundingClientRect() };
      },
      write(p, got) {
        const el = ref.current;
        if (!el) { running = false; last = null; return false; }
        if (got) spotLights(el, { fresh: true });
        const r = got && got.r;
        if (r) {
          target.x = toLayoutPx(p.x - r.left); target.y = toLayoutPx(p.y - r.top);
          if (!inside) { pos.x = target.x; pos.y = target.y; inside = true; }
          running = true;
        }
        if (!running) return false;
        const dt = last == null ? FRAME_60 : Math.min(p.ts - last, 100);
        last = p.ts;
        const f = 1 - Math.pow(1 - EASE, dt / FRAME_60);
        const dx = target.x - pos.x; const dy = target.y - pos.y;
        if (Math.abs(dx) < SETTLE && Math.abs(dy) < SETTLE) { pos.x = target.x; pos.y = target.y; } else { pos.x += dx * f; pos.y += dy * f; }
        placeSpotLights(el, pos.x, pos.y);
        if (pos.x === target.x && pos.y === target.y) { running = false; last = null; return false; }
        return true;
      },
    });
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
}
