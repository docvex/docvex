import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Tooltip from './Tooltip';
import { toLayoutPx, createWheelZoom, zoomFactorOf, ZOOM_SETTLE_MS } from '../lib/appZoom';
import './PhotoEditor.css';

// The Doc Viewer's photo editor — what a phone photograph of a document needs
// before it is any use as one: turn it the right way up, straighten it, and cut
// it down to the page. Two crops:
//
//   • Rectangle — the ordinary one: a box with eight handles.
//   • Four points — each corner is placed on its own, ON the corners of the
//     page as photographed; saving pulls that quadrilateral out flat (a
//     perspective correction), which is what undoes a card shot at an angle.
//
// Nothing here touches the file until Save: the editor works on a downscaled
// PREVIEW of the rotated image, and the crop is kept in coordinates normalised
// to it (0…1), so the same geometry is replayed on the full-resolution pixels
// when saving. `onSave({ blob, ext, replace })` does the writing — this
// component knows nothing about folders.

const PREVIEW_EDGE = 1600;   // longest side of the on-screen working copy
const OUTPUT_EDGE = 5000;    // longest side written out (a 12 MP photo fits whole)
// The image pane's numbers, so the two zooms are one behaviour (DocViewer's
// ZOOM_STEP / ZOOM_MAX). The floor is the view the picture arrived with.
const ZOOM_STEP = 1.3;
const ZOOM_MAX = 8;
const SPIN_MS = 300;        // how long a quarter-turn takes to swing
// Straight is what the slider is FOR, and hitting exactly 0 by dragging a
// 90-step bar is fiddly — so it sticks there: anything inside this much of 0
// (or of the other whole degrees, more loosely) lands on it.
const ANGLE_SNAP = 1.2;
function snapAngle(v) {
  if (Math.abs(v) <= ANGLE_SNAP) return 0;
  const whole = Math.round(v);
  return Math.abs(v - whole) <= 0.2 ? whole : v;
}
const HIST_MAX = 40;        // undo steps kept; a crop editor needs no more
const PREVIEW_OUT = 520;    // longest side of the flattened four-point preview
const LOUPE_SIZE = 132;     // the loupe's own pixels
const LOUPE_SCALE = 3.4;    // how much bigger than the working canvas it shows
const LOUPE_LIFT = 108;     // how far above the cursor it rides (below, near the top)
const FULL_FRAME = { x0: 0, y0: 0, x1: 1, y1: 1 };
// Four points open ON the picture's own corners — the whole picture, nothing
// cropped until a corner is moved. They used to start inset, which made the
// mode look like it had already cut a border off. TL TR BR BL.
const EDGE_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];
const MIN_SPAN = 0.04;       // a crop can't be dragged thinner than this

// A crop may be dragged OUTSIDE the picture: what falls outside is blank space
// in the result (white, or see-through where the format keeps it), which is how
// a page photographed too tightly gets its margin back. Bounded, not unbounded
// — a handle dragged into the next county would make an enormous file for
// nothing.
const OUT_BOUND = 1.5;   // how far past each edge a crop may go, as a fraction
const clampOut = (v) => Math.min(1 + OUT_BOUND, Math.max(-OUT_BOUND, v));

// Formats a canvas can write. Anything else (HEIC, TIFF, BMP, GIF…) is saved as
// a JPEG COPY — it can't be written back in its own format, so "replace" is off.
function outputFormat(name) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  if (ext === 'png') return { mime: 'image/png', ext: 'png', canReplace: true, opaque: false };
  if (ext === 'webp') return { mime: 'image/webp', ext: 'webp', canReplace: true, opaque: false };
  if (ext === 'jpg' || ext === 'jpeg') return { mime: 'image/jpeg', ext, canReplace: true, opaque: true };
  return { mime: 'image/jpeg', ext: 'jpg', canReplace: false, opaque: true };
}

// The source image turned by `turns` quarter-turns plus `angle` degrees, on a
// canvas grown to hold it, longest natural side scaled to at most `maxEdge`.
function renderBase(img, turns, angle, maxEdge, opaque) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const theta = ((turns * 90 + angle) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(theta));
  const sin = Math.abs(Math.sin(theta));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * cos + h * sin));
  canvas.height = Math.max(1, Math.round(w * sin + h * cos));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  // The corners a straighten leaves bare: white under a JPEG (which has no
  // transparency to leave them as), nothing under a PNG.
  if (opaque) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(theta);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return canvas;
}

// Solve the 3×3 homography taking the rectangle (0,0)-(w,h) onto the
// quadrilateral `q` (TL, TR, BR, BL), as the 8 unknowns of A·x = b.
function homography(w, h, q) {
  const src = [[0, 0], [w, 0], [w, h], [0, h]];
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i += 1) {
    const [u, v] = src[i];
    const [x, y] = q[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 8; row += 1) if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    if (Math.abs(A[pivot][col]) < 1e-10) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let row = col + 1; row < 8; row += 1) {
      const f = A[row][col] / A[col][col];
      if (!f) continue;
      for (let k = col; k < 8; k += 1) A[row][k] -= f * A[col][k];
      b[row] -= f * b[col];
    }
  }
  const x = new Array(8).fill(0);
  for (let row = 7; row >= 0; row -= 1) {
    let sum = b[row];
    for (let k = row + 1; k < 8; k += 1) sum -= A[row][k] * x[k];
    x[row] = sum / A[row][row];
  }
  return x;
}

// Pull the quadrilateral `quad` (px, TL TR BR BL) of `base` out flat. Each
// output pixel is looked up in the source through the homography and sampled
// bilinearly — the inverse mapping, so the result has no holes.
//
// The quadrilateral may reach OUTSIDE the picture: a pixel whose source lands
// off it is left blank rather than clamped to the nearest edge (which smeared
// the border outwards). Blank is white for a format with no transparency and
// see-through otherwise — the same thing a straighten does with the corners it
// leaves bare.
function warpQuad(base, quad, maxEdge, opaque) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let w = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
  let h = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
  const fit = Math.min(1, maxEdge / Math.max(w, h));
  w = Math.max(2, Math.round(w * fit));
  h = Math.max(2, Math.round(h * fit));
  const H = homography(w, h, quad);
  if (!H) return null;

  const sw = base.width;
  const sh = base.height;
  const src = base.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const image = octx.createImageData(w, h);
  const dst = image.data;
  for (let v = 0; v < h; v += 1) {
    for (let u = 0; u < w; u += 1) {
      const den = H[6] * u + H[7] * v + 1;
      const rx = (H[0] * u + H[1] * v + H[2]) / den;
      const ry = (H[3] * u + H[4] * v + H[5]) / den;
      const o = (v * w + u) * 4;
      if (rx < 0 || ry < 0 || rx > sw - 1 || ry > sh - 1) {
        dst[o] = 255; dst[o + 1] = 255; dst[o + 2] = 255;
        dst[o + 3] = opaque ? 255 : 0;
        continue;
      }
      // Inside: `sw - 1.001` keeps the bilinear sample's right/bottom
      // neighbour on the canvas.
      const x = Math.min(sw - 1.001, rx);
      const y = Math.min(sh - 1.001, ry);
      const x0 = x | 0;
      const y0 = y | 0;
      const fx = x - x0;
      const fy = y - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 4; c += 1) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        dst[o + c] = top + (bot - top) * fy;
      }
    }
  }
  octx.putImageData(image, 0, 0);
  return out;
}

const Icon = ({ d, size = 16 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.map((p) => <path d={p} key={p} />)}
  </svg>
);
const ICONS = {
  centre: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M9 9h6v6H9z'],
  undo: ['M9 14 4 9l5-5', 'M4 9h8a7 7 0 0 1 0 14H7'],
  redo: ['M15 14l5-5-5-5', 'M20 9h-8a7 7 0 0 0 0 14h5'],
  left: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5'],
  right: ['M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'],
  rect: ['M4 5h16v14H4z'],
  points: ['M4 4h3', 'M4 4v3', 'M20 4h-3', 'M20 4v3', 'M4 20h3', 'M4 20v-3', 'M20 20h-3', 'M20 20v-3'],
};

// `fromRect` — where the PREVIEW's picture was on screen (a viewport rect) the
// moment Edit was pressed. The editor then puts its own picture exactly there:
// pressing Edit must change NOTHING about how the picture is being viewed, and
// the two stages don't have the same box (the editor's runs edge to edge, under
// the side panel), so the placing is MEASURED rather than derived. Deriving it
// from matching CSS was tried twice and is too brittle — an 8px inset on one
// side is enough to shift and rescale the picture.
export default function PhotoEditor({ url, name, fromRect = null, onCancel, onSave }) {
  const format = outputFormat(name);
  const [img, setImg] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [turns, setTurns] = useState(0);              // quarter-turns committed
  const [angle, setAngle] = useState(0);              // straighten, degrees
  const [mode, setMode] = useState('rect');           // 'rect' | 'points'
  const [rect, setRect] = useState(FULL_FRAME);
  const [quad, setQuad] = useState(EDGE_QUAD);
  const quadRef = useRef(quad);
  quadRef.current = quad;
  const [busy, setBusy] = useState(null);             // 'copy' | 'replace' | null
  const [error, setError] = useState(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  // The actions that open an undo step are declared above the history that
  // records them, so they reach it through a ref rather than by name.
  const markStepRef = useRef(null);
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const overlayRef = useRef(null);
  const barRef = useRef(null);
  const [base, setBase] = useState({ w: 1, h: 1 });   // the working canvas's pixels

  // Load the picture. `crossOrigin` only where it means something: over
  // `localfile://` (which sends ACAO) it is what keeps the canvas untainted, so
  // the edit can be read back out — but asking for it on a `data:` URL makes the
  // load fail in Chromium, and the editor would sit on "Opening the picture…"
  // for ever.
  useEffect(() => {
    let alive = true;
    setImg(null);
    setLoadError(false);
    if (!url) return undefined;
    const el = new Image();
    if (!/^data:/i.test(url)) el.crossOrigin = 'anonymous';
    el.onload = () => { if (alive) setImg(el); };
    el.onerror = () => { if (alive) setLoadError(true); };
    el.src = url;
    return () => { alive = false; };
  }, [url]);

  // Paint the working copy — the picture as it now stands, turned and
  // straightened — whenever either changes. Everything else (the crop, the
  // overlay, the loupe) is measured against THIS canvas, so its pixel size is
  // published as `base`.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const painted = renderBase(img, turns, angle, PREVIEW_EDGE, format.opaque);
    canvas.width = painted.width;
    canvas.height = painted.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(painted, 0, 0);
    setBase((b) => (b.w === painted.width && b.h === painted.height ? b : { w: painted.width, h: painted.height }));
  }, [img, turns, angle, format.opaque]);

  // ── The tool sleeve's arrival ────────────────────────────────────────────
  // It starts out of sight above the pane and comes DOWN into place. Its SPACE
  // is reserved from the first frame and only the sleeve itself moves (a
  // transform), so the picture below never changes size — the whole of edit mode
  // shows it at one scale. `barIn` is set on the frame after mount so the
  // painted starting state is the hidden one and the transition has something
  // to run from.
  const [barIn, setBarIn] = useState(false);
  useLayoutEffect(() => {
    if (!barRef.current) return undefined;
    if (document.documentElement.dataset.reduceMotion === 'true') { setBarIn(true); return undefined; }
    const id = requestAnimationFrame(() => setBarIn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // ── Zoom and pan, as over a picture ──────────────────────────────────────
  // The stage is FIXED and the picture is moved across it, exactly as the image
  // pane does it: a separate layer carries the pan and the zoom as one
  // transform. A scroller was tried first and is wrong here: it can only pan
  // what overflows, so at the fit — where the picture fits — the picture
  // couldn't be moved at all.
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  // True for the length of a wheel/pinch gesture — the transform's easing is
  // dropped while it runs so the picture tracks the fingers exactly.
  const [zooming, setZooming] = useState(false);
  const panRef = useRef(pan);
  panRef.current = pan;
  const viewRef = useRef(null);
  const floorRef = useRef(1);
  // How much bigger the stage's own fit is than the view the picture arrived
  // with. It multiplies the zoom but is NOT part of it: `zoom` stays 1 = the
  // picture as the preview was showing it, so the pill reads 100% on entry and
  // counts the same as every other view in the app.
  const [placeScale, setPlaceScale] = useState(1);
  const homeRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } });
  const resetView = useCallback(() => {
    const home = homeRef.current;
    zoomRef.current = home.zoom;
    setZoom(home.zoom);
    setPan({ ...home.pan });
  }, []);
  // Where a turn or Reset lands: the stage's own fit, at 100%. Once the picture
  // has been altered, the framing it arrived with is no longer worth returning
  // to — and `placeScale` goes with it.
  const resetFit = useCallback(() => {
    floorRef.current = 1;
    homeRef.current = { zoom: 1, pan: { x: 0, y: 0 } };
    zoomRef.current = 1;
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPlaceScale(1);
  }, []);
  // 'in' / 'out' from the pill's buttons; `{ by: factor }` from the wheel,
  // which is continuous (see createWheelZoom).
  const stepZoom = useCallback((req) => {
    const z = zoomRef.current;
    const raw = z * zoomFactorOf(req, ZOOM_STEP);
    const floor = floorRef.current;
    // Zooming out to the floor no longer calls resetView — that threw the pan
    // away with the zoom. The floor below clamps the ZOOM; the pan is scaled
    // with it like any other step, so the picture stays where it was dragged.
    // Reset is still there as its own button.
    const next = Math.max(floor, Math.min(ZOOM_MAX, +raw.toFixed(3)));
    const f = next / z;
    zoomRef.current = next;
    setZoom(next);
    setPan((p) => (p.x || p.y ? { x: p.x * f, y: p.y * f } : p));
  }, []);
  // A DIFFERENT picture starts fresh; the one it opened with keeps the view it
  // was handed.
  const seenUrl = useRef(null);
  useEffect(() => {
    if (!url) return;
    if (seenUrl.current === null || seenUrl.current === url) { seenUrl.current = url; return; }
    seenUrl.current = url;
    resetFit();
  }, [url, resetFit]);
  // The wheel zooms, no key held — a picture's gesture, and this is a picture.
  // Native + non-passive, so preventDefault holds.
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return undefined;
    // Continuous: every event's delta is a multiplier — see createWheelZoom.
    const zoomBy = createWheelZoom(stepZoom);
    let settle = 0;
    const onWheel = (e) => {
      e.preventDefault();
      // The 120ms transform transition smooths a button's jump; over a gesture
      // it is restarted by every event and never arrives, so the picture trails
      // the fingers. Dropped while zooming, as it is while dragging.
      setZooming(true);
      window.clearTimeout(settle);
      settle = window.setTimeout(() => setZooming(false), ZOOM_SETTLE_MS);
      zoomBy(e);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { window.clearTimeout(settle); el.removeEventListener('wheel', onWheel); };
  }, [stepZoom]);
  // Drag the picture about, at ANY zoom — except on the crop's own outline and
  // handles, which have their own drags.
  const onStagePointerDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.phe-shape, .phe-knob, .phe-point, .phe-zoom')) return;
    e.preventDefault();
    const x0 = e.clientX; const y0 = e.clientY;
    const from = panRef.current;
    let moved = false;
    const onMove = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 3) return;
      if (!moved) { moved = true; setPanning(true); }
      setPan({ x: from.x + (ev.clientX - x0), y: from.y + (ev.clientY - y0) });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setPanning(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Put the picture where the preview had it. Once — and only once the frame
  // knows its proportions (`base.w > 1`; the canvas's size is published by a
  // different layout effect, so on the commit where `img` first arrives the
  // frame is still 1×1 square and measuring it here would be meaningless).
  const placedRef = useRef(false);
  // The pan layer eases every change of view over 120ms — which would ease the
  // OPENING placing too, i.e. the picture visibly zooming from the stage's fit
  // to where the preview had it. It is only eased from the frame AFTER the
  // placing has been painted.
  const [settled, setSettled] = useState(false);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const view = viewRef.current;
    if (!frame || !view || !img || base.w <= 1 || placedRef.current) return undefined;
    placedRef.current = true;
    const done = requestAnimationFrame(() => setSettled(true));
    if (!fromRect?.width) return () => cancelAnimationFrame(done);
    const now = frame.getBoundingClientRect();
    const box = view.getBoundingClientRect();
    if (!now.width || !box.width) return () => cancelAnimationFrame(done);
    // Scale about the frame's own centre, so the size is one factor…
    const z = Math.max(0.05, +(fromRect.width / now.width).toFixed(4));
    // …and the centre is then moved outright (the translate comes before the
    // scale, so it is in screen pixels — `toLayoutPx` because a viewport
    // distance is being written as a CSS length).
    const p = {
      x: toLayoutPx((fromRect.left + fromRect.width / 2) - (box.left + box.width / 2)),
      y: toLayoutPx((fromRect.top + fromRect.height / 2) - (box.top + box.height / 2)),
    };
    setPlaceScale(z);
    homeRef.current = { zoom: 1, pan: p };
    setPan(p);
    return () => cancelAnimationFrame(done);
  }, [img, base, fromRect]);

  // ── Turning, straightening, starting over ───────────────────────────────
  // A quarter-turn is SHOWN happening: the picture swings round, and only when
  // it has landed is it re-drawn at the new orientation (the canvas is always
  // drawn upright, so committing first would make the turn instantaneous).
  //
  // A press NEVER waits for the swing: it adds a quarter-turn to the one under
  // way (`pendingRef`) and the frame transitions on toward the new angle, so
  // four quick presses spin it four times. The LAST press is what schedules the
  // landing. Landing itself must not be animated: the transform drops to none in
  // the same paint as the canvas redraws, and animating that would unwind the
  // whole turn backwards (`is-landing`).
  const [spin, setSpin] = useState(0);              // quarter-turns being shown, net
  const [landing, setLanding] = useState(false);
  const pendingRef = useRef(0);
  const spinTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(spinTimer.current), []);
  useEffect(() => {
    if (!landing) return undefined;
    const id = requestAnimationFrame(() => setLanding(false));
    return () => cancelAnimationFrame(id);
  }, [landing]);
  const land = useCallback(() => {
    const by = pendingRef.current;
    pendingRef.current = 0;
    if (!by) return;
    setTurns((t) => (((t + by) % 4) + 4) % 4);
    setRect(FULL_FRAME);
    setQuad(EDGE_QUAD);
    setSpin(0);
    setLanding(true);
    resetFit();                 // the fit changes with the orientation
  }, [resetFit]);
  const turn = (by) => {
    markStepRef.current?.();
    setConfirmReplace(false);
    pendingRef.current += by;
    if (document.documentElement.dataset.reduceMotion === 'true') { land(); return; }
    setSpin(pendingRef.current);
    window.clearTimeout(spinTimer.current);
    spinTimer.current = window.setTimeout(land, SPIN_MS);
  };
  const edited = turns !== 0 || angle !== 0
    || rect.x0 > 0 || rect.y0 > 0 || rect.x1 < 1 || rect.y1 < 1
    || (mode === 'points' && quad.some(([x, y], i) => x !== EDGE_QUAD[i][0] || y !== EDGE_QUAD[i][1]));

  // The flattened result, as it stands. `null` until a corner has been moved.
  const [preview, setPreview] = useState(null);
  const [showResult, setShowResult] = useState(true);
  const makePreview = useCallback(() => {
    const src = canvasRef.current;
    if (!src?.width || !src?.height) { setPreview(null); return; }
    const out = warpQuad(
      src,
      quadRef.current.map(([x, y]) => [x * (src.width - 1), y * (src.height - 1)]),
      PREVIEW_OUT,
      format.opaque,
    );
    setPreview(out ? out.toDataURL('image/png') : null);
  }, [format.opaque]);
  // Leaving the mode, turning the picture or starting over drops it — it would
  // be a picture of a shape that no longer exists.
  useEffect(() => { if (mode !== 'points') setPreview(null); }, [mode]);
  useEffect(() => { setPreview(null); }, [turns, angle, url]);

  // ── The loupe ───────────────────────────────────────────────────────────
  // A corner is put on a corner of the PAGE, and a finger or a cursor covers
  // exactly the pixels that tell you whether it is: so while one is being
  // dragged, the picture around it is shown enlarged FOLLOWING the cursor —
  // just above it, out from under the hand, and below it near the top of the
  // screen — with a cross on the point itself.
  const loupeRef = useRef(null);
  const [loupe, setLoupe] = useState(null);      // { n: [nx, ny], at: [clientX, clientY] }
  // The loupe is for reading the PICTURE closely — it has nothing to show once
  // the point has been dragged off it (only the blank space the crop is adding),
  // so out there it goes away rather than magnifying nothing.
  const showLoupe = (e, n) => setLoupe(
    n[0] < 0 || n[0] > 1 || n[1] < 0 || n[1] > 1
      ? null
      : { n, at: [e.clientX, e.clientY] },
  );
  // Where a pointer is, as a fraction of the PICTURE — which is the overlay's
  // own box, so the zoom and the pan are already accounted for (a rect includes
  // the transforms above it). Not clamped to 0…1: the crop may be dragged off
  // the picture, and what falls outside becomes blank space in the result.
  const toNorm = (e) => {
    const box = overlayRef.current?.getBoundingClientRect();
    if (!box?.width || !box?.height) return [0, 0];
    return [clampOut((e.clientX - box.left) / box.width), clampOut((e.clientY - box.top) / box.height)];
  };
  const dragRef = useRef(null);
  const startDrag = (what) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    markStepRef.current?.();       // this whole drag is one step
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { what, from: toNorm(e), rect, quad };
    // A corner or an edge — not a whole-crop move, which needs no close look.
    if (what !== 'move') showLoupe(e, toNorm(e));
    setConfirmReplace(false);
  };
  const onDragMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const [nx, ny] = toNorm(e);
    if (drag.what !== 'move') showLoupe(e, [nx, ny]);
    if (typeof drag.what === 'number') {
      // One corner of the four-point crop, wherever it is put.
      setQuad((q) => q.map((p, i) => (i === drag.what ? [nx, ny] : p)));
      return;
    }
    if (drag.what === 'move') {
      // The whole selection, carried. In four-point mode every corner moves
      // together, which keeps the shape — and so the correction — exactly as it
      // was placed; only its position over the page changes.
      const dx = nx - drag.from[0];
      const dy = ny - drag.from[1];
      if (mode === 'points') {
        setQuad(drag.quad.map(([x, y]) => [clampOut(x + dx), clampOut(y + dy)]));
        return;
      }
      const r0 = drag.rect;
      const w = r0.x1 - r0.x0;
      const h = r0.y1 - r0.y0;
      setRect({ x0: r0.x0 + dx, y0: r0.y0 + dy, x1: r0.x0 + dx + w, y1: r0.y0 + dy + h });
      return;
    }
    const r0 = drag.rect;
    // An edge or corner handle: 'n', 'ne', 'e'… — each letter moves one side.
    const next = { ...r0 };
    if (drag.what.includes('w')) next.x0 = Math.min(nx, r0.x1 - MIN_SPAN);
    if (drag.what.includes('e')) next.x1 = Math.max(nx, r0.x0 + MIN_SPAN);
    if (drag.what.includes('n')) next.y0 = Math.min(ny, r0.y1 - MIN_SPAN);
    if (drag.what.includes('s')) next.y1 = Math.max(ny, r0.y0 + MIN_SPAN);
    setRect(next);
  };
  const endDrag = () => {
    const was = dragRef.current;
    dragRef.current = null;
    setLoupe(null);
    // Four points: once a corner is let go, show what pulling that shape out
    // flat actually gives — the whole point of the mode is a result you can't
    // picture from the outline alone. Worked out from the on-screen PREVIEW
    // canvas, and only on release: the warp is a pixel loop, far too slow to run
    // while a corner is moving. Deferred a tick so letting go feels instant.
    if (was && mode === 'points') window.setTimeout(makePreview, 0);
  };

  // Paint the loupe: the working canvas, around the point, magnified.
  useEffect(() => {
    const view = loupeRef.current;
    const src = canvasRef.current;
    if (!view || !src || !loupe) return;
    const size = view.width;
    const span = size / LOUPE_SCALE;
    const cx = loupe.n[0] * src.width;
    const cy = loupe.n[1] * src.height;
    const ctx = view.getContext('2d');
    ctx.imageSmoothingEnabled = false;             // pixels, not a blur, up close
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(src, cx - span / 2, cy - span / 2, span, span, 0, 0, size, size);
    // The cross marks the exact point under the finger.
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(size / 2, size / 2 - 9); ctx.lineTo(size / 2, size / 2 + 9);
    ctx.moveTo(size / 2 - 9, size / 2); ctx.lineTo(size / 2 + 9, size / 2);
    ctx.stroke();
  }, [loupe, base]);

  // ── Undo / redo ─────────────────────────────────────────────────────────
  // The editable state is small and cheap to copy, so a step is simply a
  // snapshot of it. ONE STEP PER ACTION, and each action says so itself:
  // `markStep` is called as a drag, a turn, a straighten or a mode switch
  // BEGINS, and the first state change after that mark closes the previous step.
  // Everything after it — the hundreds of events a drag or a slider emits —
  // folds into the step in progress. A settling timer was tried instead and is
  // wrong: a few quick actions land inside one window and collapse into a single
  // step, so undo jumps back past work the user thinks of as separate and reads
  // as a reset rather than a step. `applying` marks the change an undo itself
  // makes, so stepping back never becomes a step.
  const histRef = useRef({ past: [], future: [], applying: false, last: null, want: false });
  const [, bumpHist] = useState(0);
  const markStep = useCallback(() => { histRef.current.want = true; }, []);
  markStepRef.current = markStep;
  const here = JSON.stringify({ turns, angle, rect, quad, mode });
  useEffect(() => {
    const h = histRef.current;
    if (h.applying) { h.applying = false; h.want = false; h.last = here; bumpHist((n) => n + 1); return; }
    if (h.last === null) { h.last = here; return; }
    if (h.last === here) return;
    if (h.want) {
      h.want = false;
      h.past.push(h.last);
      if (h.past.length > HIST_MAX) h.past.shift();
      h.future = [];
      bumpHist((n) => n + 1);
    }
    h.last = here;                 // the step in progress keeps moving
  }, [here]);
  const applyStep = useCallback((json) => {
    const v = JSON.parse(json);
    histRef.current.applying = true;
    setTurns(v.turns); setAngle(v.angle); setRect(v.rect); setQuad(v.quad); setMode(v.mode);
    setConfirmReplace(false);
  }, []);
  const undo = useCallback(() => {
    const h = histRef.current;
    if (!h.past.length) return;
    h.future.push(h.last);
    applyStep(h.past.pop());
  }, [applyStep]);
  const redo = useCallback(() => {
    const h = histRef.current;
    if (!h.future.length) return;
    h.past.push(h.last);
    applyStep(h.future.pop());
  }, [applyStep]);
  const canUndo = histRef.current.past.length > 0;
  const canRedo = histRef.current.future.length > 0;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) { e.stopPropagation(); onCancel?.(); return; }
      if (busy || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      // Ctrl+Z steps back; Ctrl+Y and Ctrl+Shift+Z both step forward (Windows
      // and the Mac-style shortcut, since either is muscle memory for someone).
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); redo(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onCancel, undo, redo]);

  // ── Save ────────────────────────────────────────────────────────────────
  const save = useCallback(async (replace) => {
    if (!img || busy) return;
    setBusy(replace ? 'replace' : 'copy');
    setError(null);
    // Let "Saving…" paint before the pixel loop takes the thread.
    await new Promise((resolve) => { window.setTimeout(resolve, 30); });
    try {
      const full = renderBase(img, turns, angle, OUTPUT_EDGE, format.opaque);
      let out;
      if (mode === 'points') {
        out = warpQuad(full, quad.map(([x, y]) => [x * (full.width - 1), y * (full.height - 1)]), OUTPUT_EDGE, format.opaque);
        if (!out) throw new Error('Those four points don’t make a shape that can be flattened — spread them out.');
      } else {
        // The crop may reach past the picture. The canvas IS the crop, and the
        // picture is drawn into it at its own place, so whatever the crop covers
        // beyond the picture's edges is simply never drawn on — blank space.
        const sx = Math.round(rect.x0 * full.width);
        const sy = Math.round(rect.y0 * full.height);
        const sw = Math.max(1, Math.round((rect.x1 - rect.x0) * full.width));
        const sh = Math.max(1, Math.round((rect.y1 - rect.y0) * full.height));
        out = document.createElement('canvas');
        out.width = sw; out.height = sh;
        const octx = out.getContext('2d');
        // White where the format has no transparency (a JPEG would otherwise
        // write it black); a PNG or WebP keeps the blank space see-through.
        if (format.opaque) { octx.fillStyle = '#fff'; octx.fillRect(0, 0, sw, sh); }
        octx.drawImage(full, -sx, -sy);
      }
      const blob = await new Promise((resolve) => { out.toBlob(resolve, format.mime, 0.92); });
      if (!blob) throw new Error('The edited picture couldn’t be encoded.');
      await onSave?.({ blob, ext: format.ext, replace });
    } catch (e) {
      setError(String(e?.message || e));
      setBusy(null);
      setConfirmReplace(false);
    }
  }, [img, busy, turns, angle, mode, rect, quad, format, onSave]);

  // ── Overlay geometry (in the working canvas's pixel space) ──────────────
  const W = base.w;
  const H = base.h;
  const shape = mode === 'points'
    ? quad.map(([x, y]) => [x * W, y * H])
    : [[rect.x0 * W, rect.y0 * H], [rect.x1 * W, rect.y0 * H], [rect.x1 * W, rect.y1 * H], [rect.x0 * W, rect.y1 * H]];
  const shapePath = `M${shape.map((p) => p.join(' ')).join(' L')} Z`;
  // Any of the crop off the picture? The overlay then shows the picture's edge,
  // and paints what is out there as the BLANK it will be in the saved file —
  // the stage's own ground showed through instead, which reads as a colour the
  // result won't have.
  //
  // The blank is CLIPPED TO THE CROP. Its shape is "the bounds, minus the
  // picture", which on its own spans the full width or height of those bounds:
  // reach past the left edge and it painted a strip up the whole left side,
  // including the parts above and below the crop — two pale boxes off in the
  // corners, nowhere near what is being resized. Clipping it leaves exactly the
  // blank the crop is adding and nothing else. It can't be done with even-odd
  // alone: the crop and the picture overlap, and the odd-count region would
  // include the part of the PICTURE the crop doesn't cover.
  const outside = shape.some(([x, y]) => x < -0.5 || y < -0.5 || x > W + 0.5 || y > H + 0.5);
  // Is the view anywhere other than where Center would put it? The picture
  // arrives with a pan of its own (it is placed where the preview had it), so
  // "panned at all" was true from the start and the button showed up with
  // nothing to do.
  const offHome = zoom !== homeRef.current.zoom
    || Math.abs(pan.x - homeRef.current.pan.x) > 0.5
    || Math.abs(pan.y - homeRef.current.pan.y) > 0.5;
  const blankClip = `${useId()}blank`;
  const bx0 = Math.min(0, ...shape.map((p) => p[0]));
  const by0 = Math.min(0, ...shape.map((p) => p[1]));
  const bx1 = Math.max(W, ...shape.map((p) => p[0]));
  const by1 = Math.max(H, ...shape.map((p) => p[1]));
  // Handle size in canvas pixels such that it is ~constant on screen. The
  // picture's on-screen width is WORKED OUT, not measured off the element:
  // `layoutW` is its size before any transform (which is what a ResizeObserver
  // reports, and what `offsetWidth` gives), times the scale it is under.
  // Measuring the drawn rect instead read it MID-TRANSITION — the zoom eases
  // over 120ms — so every change of zoom sized the handles for the scale just
  // left behind: pressing Center shrank the picture and the handles shrank with
  // it and stayed small.
  const [layoutW, setLayoutW] = useState(0);
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    setLayoutW(el.offsetWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => setLayoutW(entries[0]?.contentRect?.width || el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [img, base]);
  const shownW = layoutW * placeScale * zoom;
  const unit = shownW ? W / shownW : 1;       // canvas px per screen px
  const knob = 8 * unit;
  const rectHandles = mode === 'rect' ? [
    ['nw', rect.x0, rect.y0], ['n', (rect.x0 + rect.x1) / 2, rect.y0], ['ne', rect.x1, rect.y0],
    ['e', rect.x1, (rect.y0 + rect.y1) / 2], ['se', rect.x1, rect.y1], ['s', (rect.x0 + rect.x1) / 2, rect.y1],
    ['sw', rect.x0, rect.y1], ['w', rect.x0, (rect.y0 + rect.y1) / 2],
  ] : [];

  return (
    <div className="phe">
      {/* The chrome floats OVER the picture, which fills the pane behind it.
          Nothing here takes room from it, so the picture is shown at exactly the
          size it was outside the editor. */}
      <div className="phe-chrome">
        <div className={`phe-bar${barIn ? ' is-in' : ''}`} ref={barRef}>
          <h3 className="phe-bartitle">Edit controls</h3>
          <div className="phe-barrow">
            <div className="phe-group">
              <Tooltip content="Step back (Ctrl+Z)">
                <button type="button" className="phe-btn" onClick={undo} disabled={!canUndo || !!busy} aria-label="Step back"><Icon d={ICONS.undo} /></button>
              </Tooltip>
              <Tooltip content="Step forward (Ctrl+Y)">
                <button type="button" className="phe-btn" onClick={redo} disabled={!canRedo || !!busy} aria-label="Step forward"><Icon d={ICONS.redo} /></button>
              </Tooltip>
            </div>
            <div className="phe-group">
              <Tooltip content="Rotate left">
                <button type="button" className="phe-btn" onClick={() => turn(-1)} disabled={!img || !!busy} aria-label="Rotate left"><Icon d={ICONS.left} /></button>
              </Tooltip>
              <Tooltip content="Rotate right">
                <button type="button" className="phe-btn" onClick={() => turn(1)} disabled={!img || !!busy} aria-label="Rotate right"><Icon d={ICONS.right} /></button>
              </Tooltip>
              <label className="phe-slider">
                <span>Straighten</span>
                <input
                  type="range" min="-45" max="45" step="0.5" value={angle}
                  disabled={!img || !!busy}
                  onPointerDown={markStep}
                  onKeyDown={markStep}
                  onChange={(e) => { setAngle(snapAngle(Number(e.target.value))); setConfirmReplace(false); }}
                  onDoubleClick={() => { markStep(); setAngle(0); }}
                />
                <output>{angle > 0 ? '+' : ''}{angle.toFixed(1)}°</output>
              </label>
            </div>
            <div className="phe-group" role="radiogroup" aria-label="Crop">
              <Tooltip content="An ordinary crop: a box you resize">
                <button type="button" role="radio" aria-checked={mode === 'rect'} className={`phe-btn is-wide${mode === 'rect' ? ' is-on' : ''}`} onClick={() => { markStep(); setMode('rect'); }} disabled={!!busy}>
                  <Icon d={ICONS.rect} /><span>Rectangle</span>
                </button>
              </Tooltip>
              <Tooltip content="Put each corner on a corner of the page — saving flattens it, correcting the angle it was shot at">
                <button type="button" role="radio" aria-checked={mode === 'points'} className={`phe-btn is-wide${mode === 'points' ? ' is-on' : ''}`} onClick={() => { markStep(); setMode('points'); }} disabled={!!busy}>
                  <Icon d={ICONS.points} /><span>Four points</span>
                </button>
              </Tooltip>
              <Tooltip content={showResult ? 'Hide the result' : 'Show what the four points will give'}>
                <button
                  type="button"
                  className={`phe-btn is-wide${showResult ? ' is-on' : ''}`}
                  aria-pressed={showResult}
                  onClick={() => setShowResult((on) => !on)}
                  disabled={!!busy || mode !== 'points'}
                >
                  <Icon d={ICONS.rect} /><span>Result</span>
                </button>
              </Tooltip>
            </div>
            <div className="phe-group is-end">
              <button type="button" className="phe-btn is-wide" onClick={() => onCancel?.()} disabled={!!busy}>Cancel</button>
              {format.canReplace && (
                <button
                  type="button"
                  className={`phe-btn is-wide${confirmReplace ? ' is-danger' : ''}`}
                  disabled={!img || !!busy || !edited}
                  onClick={() => (confirmReplace ? save(true) : setConfirmReplace(true))}
                >
                  {busy === 'replace' ? 'Saving…' : confirmReplace ? 'Overwrite the original?' : 'Replace original'}
                </button>
              )}
              <button type="button" className="phe-btn is-wide is-primary" disabled={!img || !!busy || !edited} onClick={() => save(false)}>
                {busy === 'copy' ? 'Saving…' : 'Save a copy'}
              </button>
            </div>
          </div>
        </div>
        {/* Under the sleeve: the zoom pill at the left, the flattened result at
            the right, the two level with each other. The result is absolute
            INSIDE the row so it doesn't give the row its height and push the
            Center button down the stage. */}
        <div className="phe-underbar">
          {img && !loadError && (
            <div className="phe-zoom">
              <div className="dv-zoom-controls is-doc">
                <Tooltip content="Zoom out"><button type="button" className="dv-zoom-btn" onClick={() => stepZoom('out')} disabled={zoom <= 1} aria-label="Zoom out">−</button></Tooltip>
                <Tooltip content="Back to how the picture was being viewed"><button type="button" className="dv-zoom-pct" onClick={resetView}>{Math.round(zoom * 100)}%</button></Tooltip>
                <Tooltip content="Zoom in"><button type="button" className="dv-zoom-btn" onClick={() => stepZoom('in')} aria-label="Zoom in">+</button></Tooltip>
              </div>
            </div>
          )}
          {mode === 'points' && preview && showResult && (
            <figure className="phe-preview">
              <img src={preview} alt="The page pulled out flat" />
              <figcaption>Result</figcaption>
            </figure>
          )}
        </div>
        {/* The image pane's own Center control, so both views offer the same. */}
        {img && !loadError && offHome ? (
          <div className="phe-tools">
            <button type="button" className="dv-center-btn" onClick={resetView}>
              <Icon d={ICONS.centre} /><span>Center</span>
            </button>
          </div>
        ) : null}
      </div>

      <div className="phe-stage">
        {/* Rides the cursor. Fixed to the viewport (`toLayoutPx` because a
            viewport coordinate is being written as a CSS length). */}
        {loupe && (
          <div
            className="phe-loupe"
            style={{
              left: `${toLayoutPx(loupe.at[0])}px`,
              top: `${toLayoutPx(loupe.at[1] + (loupe.at[1] < LOUPE_LIFT + 16 ? LOUPE_LIFT : -LOUPE_LIFT))}px`,
            }}
          >
            <canvas ref={loupeRef} width={LOUPE_SIZE} height={LOUPE_SIZE} />
          </div>
        )}
        <div
          className={`phe-view${panning ? ' is-panning' : ''}`}
          ref={viewRef}
          onPointerDown={onStagePointerDown}
        >
          {loadError ? (
            <p className="phe-error">This picture couldn’t be opened for editing.</p>
          ) : !img ? (
            <span className="phe-loading">Opening the picture…</span>
          ) : (
            <div
              className="phe-pan"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${placeScale * zoom})`,
                transition: panning || zooming || !settled ? 'none' : 'transform 120ms ease',
              }}
            >
              <div
                ref={frameRef}
                className={`phe-frame${spin ? ' is-spinning' : ''}${landing ? ' is-landing' : ''}`}
                style={{
                  aspectRatio: `${W} / ${H}`,
                  '--phe-ratio': W / H,
                  // Rotated, and shrunk just enough that its turned bounds still
                  // fit where it stood. A half-turn needs no shrinking.
                  transform: spin ? `rotate(${spin * 90}deg) scale(${spin % 2 === 0 ? 1 : Math.min(W / H, H / W)})` : undefined,
                  transitionDuration: spin ? `${SPIN_MS}ms` : undefined,
                }}
              >
                <canvas ref={canvasRef} className="phe-canvas" />
                {!spin && (
                  <svg
                    ref={overlayRef}
                    className="phe-overlay"
                    viewBox={`0 0 ${W} ${H}`}
                    preserveAspectRatio="none"
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  >
                    {/* The blank the crop will bring with it: everything the crop
                        reaches that the picture doesn't cover. Drawn first, so
                        the picture and the dimming both sit on top of it. */}
                    {outside && (
                      <>
                        <defs>
                          <clipPath id={blankClip}><path d={shapePath} /></clipPath>
                        </defs>
                        <path
                          className="phe-blank"
                          clipPath={`url(#${blankClip})`}
                          fillRule="evenodd"
                          d={`M${bx0} ${by0}H${bx1}V${by1}H${bx0}Z M0 0H${W}V${H}H0Z`}
                        />
                      </>
                    )}
                    {/* The picture's own edge, drawn once the crop reaches past
                        it so it is clear where the blank space begins. */}
                    {outside && <rect className="phe-edge" x="0" y="0" width={W} height={H} strokeWidth={1.5 * unit} />}
                    {/* Everything outside the crop, dimmed (even-odd: the
                        picture minus the crop). */}
                    <path className="phe-dim" fillRule="evenodd" d={`M0 0H${W}V${H}H0Z ${shapePath}`} />
                    <path
                      className={`phe-shape${mode === 'rect' ? ' is-movable' : ' is-area'}`}
                      d={shapePath}
                      strokeWidth={1.5 * unit}
                      // Inside the area: a rectangle is carried by dragging it,
                      // and either mode is carried with CTRL held. Without the
                      // key, four points lets the press through to the stage so
                      // the picture still pans from inside the selection.
                      onPointerDown={(e) => { if (mode === 'rect' || e.ctrlKey || e.metaKey) startDrag('move')(e); }}
                    />
                    {mode === 'rect' && [1, 2].map((i) => (
                      <g key={i} className="phe-thirds" strokeWidth={unit}>
                        <line x1={(rect.x0 + ((rect.x1 - rect.x0) * i) / 3) * W} y1={rect.y0 * H} x2={(rect.x0 + ((rect.x1 - rect.x0) * i) / 3) * W} y2={rect.y1 * H} />
                        <line x1={rect.x0 * W} y1={(rect.y0 + ((rect.y1 - rect.y0) * i) / 3) * H} x2={rect.x1 * W} y2={(rect.y0 + ((rect.y1 - rect.y0) * i) / 3) * H} />
                      </g>
                    ))}
                    {rectHandles.map(([id, x, y]) => (
                      <rect
                        key={id}
                        className={`phe-knob is-${id}`}
                        x={x * W - knob / 2} y={y * H - knob / 2} width={knob} height={knob} rx={2 * unit}
                        strokeWidth={1.5 * unit}
                        onPointerDown={startDrag(id)}
                      />
                    ))}
                    {mode === 'points' && quad.map(([x, y], i) => (
                      <g key={i} onPointerDown={startDrag(i)} className="phe-point">
                        {/* A generous invisible target around a small, precise mark. */}
                        <circle cx={x * W} cy={y * H} r={18 * unit} className="phe-point-hit" />
                        <circle cx={x * W} cy={y * H} r={7 * unit} className="phe-point-ring" strokeWidth={2 * unit} />
                        <circle cx={x * W} cy={y * H} r={1.6 * unit} className="phe-point-dot" />
                      </g>
                    ))}
                  </svg>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {error && <p className="phe-error" role="alert">{error}</p>}

      <p className="phe-hint">
        {mode === 'points'
          ? 'Drag each corner onto a corner of the page. Saving flattens that shape into a straight-on rectangle.'
          : 'Drag the handles to crop, or the box to move it. Double-click the Straighten slider to zero it.'}
        {!format.canReplace && ' This format can’t be written back, so the result is saved as a JPEG copy.'}
      </p>
    </div>
  );
}
