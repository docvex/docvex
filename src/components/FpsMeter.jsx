import React, { useContext, useEffect, useRef, useState } from 'react';
import { AppPrefsContext } from '../context/AppPrefsContext';
import './FpsMeter.css';

// Frames-per-second indicator pinned to the top-centre of the window — a quick
// read on render performance. Settings → Behavior → "FPS counter" picks how
// much it shows (`fpsCounter` pref):
//   off      — nothing (and no animation loop running)
//   simple   — "60 FPS", colour-coded: green ≥50, amber ≥30, red below
//   complex  — FPS, average frame time, 1% low, worst frame, janky frames
//   graph    — FPS + a live bar graph of the last frames' times
// One requestAnimationFrame loop records every frame's duration in a ring
// buffer; the numbers are taken from it every 250 ms (React state), and the
// graph is drawn straight onto its canvas, so neither re-renders per frame.
//
// `mode` overrides the pref and `inline` drops the fixed positioning — the
// Settings page uses both for its preview.

export const FPS_MODES = ['off', 'simple', 'complex', 'graph'];

const RING = 240;          // ~4 s of frames at 60 Hz
const UPDATE_MS = 250;
const GRAPH_BARS = 90;
const GRAPH_MAX_MS = 50;   // bars are scaled to this; longer frames are clipped
const JANK_MS = 1000 / 30; // a frame that missed 30 fps

const tierOf = (fps) => (fps >= 50 ? 'good' : fps >= 30 ? 'ok' : 'bad');

function statsOf(buf, count, head) {
  const n = Math.min(count, RING);
  if (!n) return null;
  const times = new Array(n);
  let sum = 0;
  let worst = 0;
  let jank = 0;
  for (let i = 0; i < n; i += 1) {
    const t = buf[(head - 1 - i + RING) % RING];
    times[i] = t;
    sum += t;
    if (t > worst) worst = t;
    if (t > JANK_MS) jank += 1;
  }
  // The current rate: the last ~500 ms of frames.
  let recent = 0;
  let frames = 0;
  for (let i = 0; i < n && recent < 500; i += 1) { recent += times[i]; frames += 1; }
  const sorted = times.slice().sort((a, b) => b - a);
  const p99 = sorted[Math.max(0, Math.floor(n * 0.01))];
  return {
    fps: recent ? Math.round((frames * 1000) / recent) : 0,
    avgMs: sum / n,
    low1: p99 ? Math.round(1000 / p99) : 0,
    worstMs: worst,
    jank,
    span: sum / 1000,
  };
}

function drawGraph(canvas, buf, count, head) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const css = getComputedStyle(canvas);
  const col = {
    good: css.getPropertyValue('--success').trim() || '#22c55e',
    ok: css.getPropertyValue('--warning').trim() || '#f59e0b',
    bad: css.getPropertyValue('--danger').trim() || '#ef4444',
    line: css.getPropertyValue('--border-strong').trim() || 'rgba(128,128,128,0.4)',
  };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const y = (ms) => h - (Math.min(ms, GRAPH_MAX_MS) / GRAPH_MAX_MS) * h;
  // Guides at 60 and 30 fps.
  ctx.strokeStyle = col.line;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  for (const ms of [1000 / 60, 1000 / 30]) {
    const gy = Math.round(y(ms)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
  }
  ctx.setLineDash([]);
  const n = Math.min(count, RING, GRAPH_BARS);
  const bw = w / GRAPH_BARS;
  for (let i = 0; i < n; i += 1) {
    const t = buf[(head - 1 - i + RING) % RING];
    const fps = 1000 / t;
    ctx.fillStyle = col[tierOf(fps)];
    const top = y(t);
    ctx.fillRect(w - (i + 1) * bw, top, Math.max(1, bw - 0.5), h - top);
  }
}

export default function FpsMeter({ mode: forced = null, inline = false }) {
  const prefs = useContext(AppPrefsContext)?.prefs;
  const mode = FPS_MODES.includes(forced) ? forced : (FPS_MODES.includes(prefs?.fpsCounter) ? prefs.fpsCounter : 'simple');
  const [stats, setStats] = useState(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    if (mode === 'off') return undefined;
    const buf = new Float64Array(RING);
    let head = 0;
    let count = 0;
    let raf = 0;
    let prev = 0;
    let lastUpdate = 0;
    const loop = (now) => {
      if (prev) {
        // A hidden window pauses rAF; don't record that gap as one long frame.
        const dt = now - prev;
        if (dt < 1000) { buf[head] = dt; head = (head + 1) % RING; count += 1; }
      }
      prev = now;
      if (mode === 'graph' && canvasRef.current) drawGraph(canvasRef.current, buf, count, head);
      if (now - lastUpdate >= UPDATE_MS) {
        lastUpdate = now;
        setStats(statsOf(buf, count, head));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  if (mode === 'off') return null;
  const fps = stats?.fps || 0;
  const tier = tierOf(fps);
  const cls = `fps-meter is-${mode} is-${tier}${inline ? ' is-inline' : ''}`;

  if (mode === 'simple') {
    return <div className={cls} aria-hidden="true">{fps} FPS</div>;
  }
  if (mode === 'graph') {
    return (
      <div className={cls} aria-hidden="true">
        <span className="fps-meter-big">{fps} <small>FPS</small></span>
        <canvas ref={canvasRef} className="fps-meter-graph" />
      </div>
    );
  }
  // complex
  const tierFor = (v) => `is-${tierOf(v)}`;
  return (
    <div className={cls} aria-hidden="true">
      <span className="fps-meter-big">{fps} <small>FPS</small></span>
      <dl className="fps-meter-stats">
        <div><dt>Frame</dt><dd>{stats ? stats.avgMs.toFixed(1) : '–'} ms</dd></div>
        <div><dt>1% low</dt><dd className={stats ? tierFor(stats.low1) : ''}>{stats ? stats.low1 : '–'}</dd></div>
        <div><dt>Worst</dt><dd className={stats ? tierFor(1000 / stats.worstMs) : ''}>{stats ? stats.worstMs.toFixed(0) : '–'} ms</dd></div>
        <div><dt>Jank</dt><dd className={stats?.jank ? 'is-bad' : ''}>{stats ? stats.jank : '–'}<small> / {stats ? stats.span.toFixed(0) : 0}s</small></dd></div>
      </dl>
    </div>
  );
}
