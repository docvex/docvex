// Persistent cache for the audio "decibel line" loudness envelope so the
// waveform scrubber paints instantly on reopen instead of re-decoding the whole
// file each time the Doc Viewer window opens. The envelope is a Float32Array in
// 0..1 (peak-normalised); we quantise to 8-bit and store it base64 in
// localStorage, with a small LRU cap so the cache can't grow unbounded.
//
// 8 bits = 256 levels is plenty for a purely visual waveform. Keyed by the
// file's localfile:// URL (which encodes the on-disk path) + the sample rate, so
// the key is stable across opens of the same file.

const PREFIX = 'docvex:doc-viewer:envelope:';
const INDEX_KEY = 'docvex:doc-viewer:envelope:index';
const MAX_ENTRIES = 32;

function readIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY)) || []; } catch { return []; }
}
function writeIndex(list) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
function keyFor(id) { return PREFIX + encodeURIComponent(id); }

// Return the cached envelope for `id` as a Float32Array, or null if absent.
// A hit bumps the entry's LRU recency.
export function loadEnvelope(id) {
  let raw;
  try { raw = localStorage.getItem(keyFor(id)); } catch { return null; }
  if (!raw) return null;
  try {
    const bin = atob(raw);
    const env = new Float32Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) env[i] = bin.charCodeAt(i) / 255;
    const idx = readIndex().filter((k) => k !== id);
    idx.push(id);
    writeIndex(idx);
    return env;
  } catch { return null; }
}

// Persist `env` (Float32Array, values 0..1) under `id`, evicting the
// oldest entries past MAX_ENTRIES and retrying once on a quota error.
export function saveEnvelope(id, env) {
  if (!env || !env.length) return;
  let bin = '';
  for (let i = 0; i < env.length; i += 1) {
    const v = env[i];
    const q = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    bin += String.fromCharCode(q);
  }
  let data;
  try { data = btoa(bin); } catch { return; }

  let idx = readIndex().filter((k) => k !== id);
  idx.push(id);
  while (idx.length > MAX_ENTRIES) {
    const victim = idx.shift();
    try { localStorage.removeItem(keyFor(victim)); } catch { /* ignore */ }
  }
  try {
    localStorage.setItem(keyFor(id), data);
    writeIndex(idx);
  } catch {
    // Quota hit — drop the oldest half and retry once.
    try {
      const half = idx.slice(0, Math.floor(idx.length / 2));
      half.forEach((k) => { try { localStorage.removeItem(keyFor(k)); } catch { /* ignore */ } });
      const remaining = idx.slice(half.length);
      localStorage.setItem(keyFor(id), data);
      writeIndex(remaining);
    } catch { /* give up — fall back to recomputing next time */ }
  }
}
