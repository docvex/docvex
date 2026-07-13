// Per-file cache of the DocViewer audio pane's AI captions. Transcription costs
// tokens (OpenAI Whisper via the doc-ai Edge Function), so the result is saved
// to localStorage keyed by the file's on-disk path — reopening the same file
// restores the transcript instantly instead of re-transcribing. One result per
// file (text + timed segments + language), unlike the OCR history which keeps a
// list of snippets (see lib/extractionHistory.js).

const KEY_PREFIX = 'docvex:doc-viewer:captions:';

// Exposed so other surfaces can recognise our keys (e.g. cross-window `storage`).
export const CAPTIONS_PREFIX = KEY_PREFIX;

function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function safeRemove(key) {
  try { localStorage.removeItem(key); return true; } catch { return false; }
}

// Returns { text, segments: [{ start, end, text }], language, createdAt,
// original } | null. `original` is the untouched AI transcript kept alongside
// manual edits so the panel's "Revert to original" can restore it.
export function loadCaptions(filePath) {
  if (!filePath) return null;
  const raw = safeRead(KEY_PREFIX + filePath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.text !== 'string') return null;
    return {
      text: parsed.text,
      segments: Array.isArray(parsed.segments) ? parsed.segments : [],
      language: parsed.language || null,
      createdAt: parsed.createdAt || 0,
      original: parsed.original && typeof parsed.original.text === 'string'
        ? {
            text: parsed.original.text,
            segments: Array.isArray(parsed.original.segments) ? parsed.original.segments : [],
          }
        : null,
    };
  } catch {
    return null;
  }
}

export function saveCaptions(filePath, data) {
  if (!filePath || !data || typeof data.text !== 'string') return false;
  return safeWrite(KEY_PREFIX + filePath, JSON.stringify({
    text: data.text,
    segments: Array.isArray(data.segments) ? data.segments : [],
    language: data.language || null,
    createdAt: data.createdAt || Date.now(),
    original: data.original && typeof data.original.text === 'string'
      ? {
          text: data.original.text,
          segments: Array.isArray(data.original.segments) ? data.original.segments : [],
        }
      : null,
  }));
}

export function clearCaptions(filePath) {
  if (!filePath) return false;
  return safeRemove(KEY_PREFIX + filePath);
}
