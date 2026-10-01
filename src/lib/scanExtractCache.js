// Per-file cache of what the AI gathered during a timeline scan — extracted
// document text, OCR/vision readings, Whisper captions. Re-analyzing the
// same files (regenerate, steering tweaks, a second session) recalls the
// stored result instead of re-paying for vision/transcription.
//
// Keyed by name|size|lastModified — a content-identity proxy that survives
// re-picking the same file from disk. Only successful extractions are
// cached (failures may be transient: missing AI key, network). A small LRU
// index bounds the footprint; writes are fire-and-forget (quota errors
// swallowed, the next scan just extracts again).

const PREFIX = 'docvex:timeline:extract:v1:';
const INDEX_KEY = 'docvex:timeline:extract:index:v1';
const MAX_ENTRIES = 60;
// Per-entry text cap — extraction itself caps at ~16k; this is a guard.
const MAX_TEXT = 24000;

const keyFor = (file) => `${PREFIX}${file.name}|${file.size}|${file.lastModified || 0}`;

function touchIndex(key) {
  try {
    const idx = JSON.parse(localStorage.getItem(INDEX_KEY) || '[]').filter((k) => k !== key);
    idx.push(key);
    while (idx.length > MAX_ENTRIES) {
      localStorage.removeItem(idx.shift());
    }
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
  } catch { /* fire-and-forget */ }
}

// → { text, media? } or null when nothing (valid) is cached.
export function loadExtract(file) {
  try {
    const raw = localStorage.getItem(keyFor(file));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.text !== 'string' || !parsed.text) return null;
    touchIndex(keyFor(file));
    return parsed;
  } catch {
    return null;
  }
}

export function saveExtract(file, res) {
  if (!res?.text) return;
  try {
    const key = keyFor(file);
    localStorage.setItem(key, JSON.stringify({
      text: res.text.slice(0, MAX_TEXT),
      // Media carry their full AI result (timed transcript / raw vision
      // text) so a cache hit can still seed the Doc Viewer's caches.
      ...(res.media ? {
        media: {
          kind: res.media.kind,
          segments: res.media.segments || 0,
          ...(res.media.transcript ? { transcript: res.media.transcript } : {}),
          ...(res.media.raw ? { raw: res.media.raw } : {}),
        },
      } : {}),
      at: Date.now(),
    }));
    touchIndex(key);
  } catch { /* quota — fire-and-forget */ }
}
