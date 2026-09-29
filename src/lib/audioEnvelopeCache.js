// Persistent cache for the audio "decibel line" loudness envelope so the
// waveform scrubber paints instantly on reopen instead of re-decoding the whole
// file each time the Doc Viewer window opens. The envelope is a Float32Array in
// 0..1 (peak-normalised); we quantise to 8-bit and store it base64.
//
// 8 bits = 256 levels is plenty for a purely visual waveform. The id is the
// file's localfile:// URL (which encodes the on-disk path) + the sample rate.
//
// WHERE IT LIVES: the project index, knowledge kind `envelope` (see
// lib/projectIndexClient) — `{ [hz]: base64 }` per file, tied to the
// recording's content, so it survives a rename and travels with the case. An
// id that isn't a local file's URL, or a machine without main's side, keeps
// the old localStorage store: one key per id, with a small LRU cap so it can't
// grow unbounded.
import { peekFacet, putFacet, parseEnvelopeId } from './projectIndexClient';
import { secureStorage } from './secureStore';

const PREFIX = 'docvex:doc-viewer:envelope:';
const INDEX_KEY = 'docvex:doc-viewer:envelope:index';
const MAX_ENTRIES = 32;

function readIndex() {
  try { return JSON.parse(secureStorage.getItem(INDEX_KEY)) || []; } catch { return []; }
}
function writeIndex(list) {
  try { secureStorage.setItem(INDEX_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
function keyFor(id) { return PREFIX + encodeURIComponent(id); }

function decode(raw) {
  const bin = atob(raw);
  const env = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) env[i] = bin.charCodeAt(i) / 255;
  return env;
}

// Return the cached envelope for `id` as a Float32Array, or null if absent.
// A hit in the old store bumps the entry's LRU recency.
export function loadEnvelope(id) {
  const parsed = parseEnvelopeId(id);
  if (parsed) {
    const facet = peekFacet(parsed.path, 'envelope');
    const b64 = facet?.data?.[parsed.hz];
    if (b64) { try { return decode(b64); } catch { /* fall through */ } }
  }
  let raw;
  try { raw = secureStorage.getItem(keyFor(id)); } catch { return null; }
  if (!raw) return null;
  try {
    const env = decode(raw);
    const idx = readIndex().filter((k) => k !== id);
    idx.push(id);
    writeIndex(idx);
    return env;
  } catch { return null; }
}

// Persist `env` (Float32Array, values 0..1) under `id`.
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

  const parsed = parseEnvelopeId(id);
  if (parsed) {
    const cur = peekFacet(parsed.path, 'envelope');
    const facet = {
      kind: 'envelope',
      at: Date.now(),
      engine: 'local',
      paid: false,
      data: { ...(cur?.data || {}), [parsed.hz]: data },
    };
    if (putFacet({ path: parsed.path }, 'envelope', facet, { onFail: () => saveLegacy(id, data) })) return;
  }
  saveLegacy(id, data);
}

// The old store: evict past MAX_ENTRIES and retry once on a quota error.
function saveLegacy(id, data) {
  let idx = readIndex().filter((k) => k !== id);
  idx.push(id);
  while (idx.length > MAX_ENTRIES) {
    const victim = idx.shift();
    try { secureStorage.removeItem(keyFor(victim)); } catch { /* ignore */ }
  }
  try {
    secureStorage.setItem(keyFor(id), data);
    writeIndex(idx);
  } catch {
    // Quota hit — drop the oldest half and retry once.
    try {
      const half = idx.slice(0, Math.floor(idx.length / 2));
      half.forEach((k) => { try { secureStorage.removeItem(keyFor(k)); } catch { /* ignore */ } });
      const remaining = idx.slice(half.length);
      secureStorage.setItem(keyFor(id), data);
      writeIndex(remaining);
    } catch { /* give up — fall back to recomputing next time */ }
  }
}
