// Per-file store of a recording's captions — transcripts saved for a file
// earlier (DocVex no longer transcribes anything; what is here is the user's
// own data, shown and edited in the Doc Viewer and read by the AI scan). One
// result per file (text + timed segments + language), unlike the OCR history
// which keeps a list of snippets (see lib/extractionHistory.js).
//
// WHERE IT LIVES: the project index, knowledge kind `captions` (see
// lib/projectIndexClient) — tied to the recording's content, and carried with
// the case in `.docvex/knowledge/`. The localStorage key is its old home: still
// read for a file the index hasn't answered for yet, still written when main
// isn't there (or refuses the put), and moved across on first hydration.
import { peekFacet, putFacet, clearFacet, indexAvailable } from './projectIndexClient';

const KEY_PREFIX = 'docvex:doc-viewer:captions:';

// Exposed so other surfaces can recognise the old keys (lib/projectDataWipe).
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

function shape(parsed) {
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
}

// Returns { text, segments: [{ start, end, text }], language, createdAt,
// original } | null. `original` is the untouched AI transcript kept alongside
// manual edits so the panel's "Revert to original" can restore it.
export function loadCaptions(filePath) {
  if (!filePath) return null;
  const facet = peekFacet(filePath, 'captions');
  if (facet && typeof facet.data?.text === 'string') return shape(facet.data);
  const raw = safeRead(KEY_PREFIX + filePath);
  if (!raw) return null;
  try { return shape(JSON.parse(raw)); } catch { return null; }
}

export function saveCaptions(filePath, data) {
  if (!filePath || !data || typeof data.text !== 'string') return false;
  const value = {
    text: data.text,
    segments: Array.isArray(data.segments) ? data.segments : [],
    language: data.language || null,
    createdAt: data.createdAt || Date.now(),
    // When it was last written (an edit keeps createdAt) — the facet's `at`,
    // which is what picks the newer of two copies.
    updatedAt: Date.now(),
    original: data.original && typeof data.original.text === 'string'
      ? {
          text: data.original.text,
          segments: Array.isArray(data.original.segments) ? data.original.segments : [],
        }
      : null,
  };
  // `engine` names what made the saved captions — kept as it was written, so
  // existing data reads the same.
  const facet = { kind: 'captions', at: value.updatedAt, engine: 'whisper', paid: true, data: value };
  const writeLegacy = () => safeWrite(KEY_PREFIX + filePath, JSON.stringify(value));
  if (putFacet({ path: filePath }, 'captions', facet, { onFail: writeLegacy })) {
    safeRemove(KEY_PREFIX + filePath);
    return true;
  }
  return writeLegacy();
}

export function clearCaptions(filePath) {
  if (!filePath) return false;
  const had = indexAvailable() && clearFacet(filePath, 'captions');
  return safeRemove(KEY_PREFIX + filePath) || had;
}
