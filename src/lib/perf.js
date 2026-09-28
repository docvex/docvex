// GRAPHICS QUALITY — game-style presets that trade the app's look for speed on
// the office machines it actually runs on (integrated GPUs, 4–8 GB of RAM).
//
// A preset resolves to a LEVEL — ultra | high | medium | low — stamped on
// <html> as `data-perf` before the first paint (`initPerf`, called from
// renderer.jsx), and on every change. Two halves read it:
//   • styles/perf.css — everything a stylesheet can switch off: backdrop
//     blur (with opaque fallbacks where the frost carried legibility),
//     decorative infinite animations, heavy shadows, transition lengths.
//   • JS effects ask `perfAllows(feature)` (or `usePerfAllows`) — the
//     cursor spotlights, the Sidebar's and rails' glows — and stop
//     FOLLOWING the pointer when the level forbids it (the look stays).
//
// 'auto' (the default) picks a level from the hardware (`detectPerf`): the
// GPU WebGL reports, the CPU cores and the memory. Kept PER DEVICE, not per
// account — it describes the computer, not the person — in localStorage.

const KEY = 'docvex.perf.v1';
// What auto-detection found last time. Reading the GPU's name means creating
// a WebGL context (tens of ms), so boot uses this and re-checks it on idle.
const DETECT_KEY = 'docvex.perf.detected.v1';

export const PERF_LEVELS = ['ultra', 'high', 'medium', 'low'];

export const PERF_PRESETS = [
  { id: 'auto', label: 'Auto', blurb: 'Picks a preset for this computer from its graphics chip, processor and memory.' },
  { id: 'ultra', label: 'Ultra', blurb: 'Everything on: frosted glass, cursor light, ambient motion, full shadows and transitions.' },
  { id: 'high', label: 'High', blurb: 'Frosted glass and cursor light stay; looping decorative motion stops.' },
  { id: 'medium', label: 'Medium', blurb: 'Solid surfaces instead of blur, the background light stays still instead of following the mouse, lighter shadows. Transitions stay.' },
  { id: 'low', label: 'Low', blurb: 'The lightest the app can draw: no blur, shadows, ambient motion or transitions. Best for older office PCs.' },
];

// What each level keeps. A feature not listed is ON at every level.
export const PERF_FEATURES = {
  blur: { label: 'Frosted glass (backdrop blur)', levels: ['ultra', 'high'] },
  spotlight: { label: 'Light and glows follow the mouse', levels: ['ultra', 'high'] },
  ambient: { label: 'Looping decorative motion (shimmers, pulses)', levels: ['ultra'] },
  shadows: { label: 'Full shadows', levels: ['ultra', 'high'] },
  anyShadows: { label: 'Shadows at all', levels: ['ultra', 'high', 'medium'] },
  motion: { label: 'Animations and transitions (spinners always turn)', levels: ['ultra', 'high', 'medium'] },
};

let preset = 'auto';
let level = 'high';
let detected = null;
const subs = new Set();

function readPreset() {
  try {
    const v = localStorage.getItem(KEY);
    return PERF_PRESETS.some((p) => p.id === v) ? v : 'auto';
  } catch { return 'auto'; }
}

function gpuName() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return String(name || '');
  } catch { return ''; }
}

function cachedDetect() {
  try {
    const v = JSON.parse(localStorage.getItem(DETECT_KEY) || 'null');
    return v && PERF_LEVELS.includes(v.level) ? v : null;
  } catch { return null; }
}

/** What auto would pick here, and why. Measured once per window. */
export function detectPerf() {
  if (detected) return detected;
  detected = measure();
  try { localStorage.setItem(DETECT_KEY, JSON.stringify(detected)); } catch { /* private mode */ }
  return detected;
}

function measure() {
  const cores = navigator.hardwareConcurrency || 0;
  const memory = navigator.deviceMemory || 0; // GB, capped at 8 by Chromium
  const gpu = gpuName();
  const g = gpu.toLowerCase();
  const software = /swiftshader|llvmpipe|basic render|software|microsoft basic/.test(g);
  const discrete = /nvidia|geforce|quadro|rtx|gtx|radeon rx|radeon pro|arc a\d|apple m\d|apple gpu/.test(g);
  const integrated = !discrete && /intel|uhd|iris|hd graphics|radeon\(tm\) graphics|vega \d+ graphics|adreno|mali/.test(g);
  let pick;
  if (software || !gpu) pick = 'low';
  else if ((cores && cores <= 4) || (memory && memory <= 4)) pick = 'low';
  else if (integrated) pick = /iris xe|iris plus|780m|680m/.test(g) && cores >= 8 ? 'high' : 'medium';
  else if (discrete && cores >= 8) pick = 'high';
  else pick = 'medium';
  return { level: pick, gpu, cores, memory, software, integrated, discrete };
}

// At boot: the cached detection when there is one (no WebGL context on the
// startup path); the first launch measures.
const resolve = (p, boot = false) => (p !== 'auto' ? p : ((boot && cachedDetect()) || detectPerf()).level);

function apply() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-perf', level);
  // Low implies Minimize motion: the stylesheets' reduce-motion rules and
  // every JS animation that reads the attribute. The user's own choice
  // (AppPrefsContext's data-user-reduce-motion) still holds on other levels.
  const own = root.getAttribute('data-user-reduce-motion') === 'true';
  root.setAttribute('data-reduce-motion', level === 'low' || own ? 'true' : 'false');
}

/** Stamp the level on <html>. Call once at boot, before the first render. */
export function initPerf() {
  preset = readPreset();
  level = resolve(preset, true);
  apply();
  // Re-check the hardware once things are quiet (a new GPU driver, a docked
  // laptop) and follow it if Auto is on.
  if (preset === 'auto' && !detected) {
    setTimeout(() => {
      const idle = window.requestIdleCallback || ((fn) => fn());
      idle(() => {
        const was = level;
        detectPerf();
        if (preset === 'auto' && detected.level !== was) { level = detected.level; apply(); subs.forEach((fn) => fn()); }
      });
    }, 20000);
  }
  // Another window changed it: follow.
  try {
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY) return;
      preset = readPreset();
      level = resolve(preset);
      apply();
      subs.forEach((fn) => fn());
    });
  } catch { /* no window */ }
}

export const getPerfPreset = () => preset;
export const getPerfLevel = () => level;

export function setPerfPreset(id) {
  if (!PERF_PRESETS.some((p) => p.id === id)) return;
  preset = id;
  level = resolve(id);
  try { localStorage.setItem(KEY, id); } catch { /* private mode */ }
  apply();
  subs.forEach((fn) => fn());
}

/** Whether the current level keeps a feature (see PERF_FEATURES). */
export function perfAllows(feature, at = level) {
  const f = PERF_FEATURES[feature];
  return f ? f.levels.includes(at) : true;
}

export function subscribePerf(fn) { subs.add(fn); return () => subs.delete(fn); }
