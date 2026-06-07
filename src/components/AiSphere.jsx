import React, { useRef, useEffect, useId } from 'react';
import './AiSphere.css';

// Animated "AI thinking" indicator — a glowing sphere of strands that wind from
// the north pole to the south pole and intertwine. Self-contained (inline SVG +
// a shared rAF loop); used everywhere the app needs an AI glyph (it backs the
// `spark` icon in aiHub.jsx, so every `I.spark(...)` call renders one).
//
// Geometry runs in a fixed 0..360 viewBox (the SVG scales to width/height), so
// one set of maths serves a 13px chip and a 160px orb alike. Strokes use
// `vector-effect: non-scaling-stroke` (see AiSphere.css) so filaments stay a
// constant on-screen weight at any size.

const SVG_NS = 'http://www.w3.org/2000/svg';
const CX = 180, CY = 180, R = 132;
const C0 = [29, 158, 117];   // teal
const C1 = [127, 119, 221];  // purple

const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const ramp = (t) =>
  `rgb(${Math.round(lerp(C0[0], C1[0], t))},${Math.round(lerp(C0[1], C1[1], t))},${Math.round(lerp(C0[2], C1[2], t))})`;

// ── Shared clock ──────────────────────────────────────────────────────────
// Every mounted sphere registers here; a single rAF loop ticks them all, so N
// spheres cost one loop (not N). Pauses when the document is hidden / no
// instances are live, and resumes on visibility.
const live = new Set();
let rafId = null;
let last = 0;
let T = 0;   // master rotation accumulator
let DP = 0;  // vertical-axis warp phase

function frame(now) {
  const dt = last ? Math.min((now - last) / 16.67, 3) : 1;
  last = now;
  T += 0.018 * dt;
  DP += 0.014 * dt;
  live.forEach((s) => s.draw());
  if (live.size && !document.hidden) {
    rafId = requestAnimationFrame(frame);
  } else {
    rafId = null;
    last = 0;
  }
}
function startLoop() {
  if (!rafId && live.size && (typeof document === 'undefined' || !document.hidden)) {
    last = 0;
    rafId = requestAnimationFrame(frame);
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) startLoop(); });
}

export default function AiSphere({
  width = 24,
  height,
  speed = 1,
  weave = 0.85,
  distort = 14,
  className = '',
  style,
  ...rest
}) {
  // Unique ids so each sphere's <filter> / <gradient> don't collide in the DOM.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const groupRef = useRef(null);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return undefined;

    // Fewer strands/segments for tiny glyphs (avatars, chips) — they read as a
    // glowing orb anyway, and it keeps many simultaneous spheres cheap.
    const small = width <= 18;
    const N = small ? 6 : 9;
    const SEGS = small ? 16 : 32;

    // Build the line segments ONCE; per frame we only move their endpoints.
    while (g.firstChild) g.removeChild(g.firstChild);
    const strands = [];
    for (let i = 0; i < N; i++) {
      const sg = document.createElementNS(SVG_NS, 'g');
      sg.setAttribute('stroke', ramp(N === 1 ? 0 : i / (N - 1)));
      const segs = [];
      for (let k = 0; k < SEGS; k++) {
        const ln = document.createElementNS(SVG_NS, 'line');
        ln.setAttribute('stroke-linecap', 'round');
        sg.appendChild(ln);
        segs.push(ln);
      }
      g.appendChild(sg);
      // Random params per strand: base longitude, two wander terms, and an
      // independent rotation rate (random magnitude AND direction) so no two
      // strands turn in lockstep.
      strands.push({
        segs,
        base: rand(0, Math.PI * 2),
        w1: rand(0.3, 0.9), w2: rand(0.15, 0.6),
        f1: rand(1, 3), f2: rand(2, 5),
        p1: rand(0, Math.PI * 2), p2: rand(0, Math.PI * 2),
        rot: (Math.random() < 0.5 ? -1 : 1) * rand(0.4, 1.2),
      });
    }

    const inst = {
      draw() {
        const PI = Math.PI;
        for (let s = 0; s < strands.length; s++) {
          const st = strands[s];
          let px = 0, py = 0, pz = 0;
          for (let j = 0; j <= SEGS; j++) {
            const u = j / SEGS;
            const radH = R * Math.sin(PI * u);          // 0 at poles, max at equator
            const y = CY - R * Math.cos(PI * u);        // top -> bottom
            const lam = st.base
              + weave * (st.w1 * Math.sin(st.f1 * PI * u + st.p1) + st.w2 * Math.sin(st.f2 * PI * u + st.p2))
              + T * speed * st.rot;                      // longitude
            let x = CX + radH * Math.sin(lam);
            const z = Math.cos(lam);                     // +front / -back
            // Vertical-axis warp, tapered to 0 at the poles so strands stay
            // anchored to the pole dots; only the body wobbles.
            x += distort * Math.sin((y - CY) * 0.045 + DP) * Math.sin(PI * u);
            if (j > 0) {
              const ln = st.segs[j - 1];
              ln.setAttribute('x1', px.toFixed(2));
              ln.setAttribute('y1', py.toFixed(2));
              ln.setAttribute('x2', x.toFixed(2));
              ln.setAttribute('y2', y.toFixed(2));
              const zm = (z + pz) * 0.5;                 // depth shade by avg z
              ln.setAttribute('opacity', (0.16 + 0.84 * ((zm + 1) / 2)).toFixed(3));
            }
            px = x; py = y; pz = z;
          }
        }
      },
    };

    inst.draw();          // paint a first frame immediately (no blank flash)
    live.add(inst);
    startLoop();
    return () => { live.delete(inst); };
  }, [width, speed, weave, distort]);

  const w = width;
  const h = height || width;
  return (
    <svg
      className={`ai-sphere ${className}`.trim()}
      viewBox="0 0 360 360"
      width={w}
      height={h}
      aria-hidden="true"
      style={{ overflow: 'visible', ...style }}
      {...rest}
    >
      <defs>
        {/* Bluish atmospheric halo. */}
        <radialGradient id={`hl${uid}`} cx="50%" cy="46%" r="50%">
          <stop offset="0%" stopColor="#3a5cff" stopOpacity="0.40" />
          <stop offset="45%" stopColor="#2a3bdd" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#0c1226" stopOpacity="0" />
        </radialGradient>
        {/* Neon bloom: blur merged UNDER the sharp source, twice over. */}
        <filter id={`gl${uid}`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <circle cx="180" cy="180" r="150" fill={`url(#hl${uid})`} />
      <g ref={groupRef} filter={`url(#gl${uid})`} fill="none" strokeWidth="1.6" />
      {/* Pole dots — strands meet here. */}
      <circle cx="180" cy="48" r="3.4" fill="#dfe6ff" filter={`url(#gl${uid})`} />
      <circle cx="180" cy="312" r="3.4" fill="#dfe6ff" filter={`url(#gl${uid})`} />
    </svg>
  );
}
