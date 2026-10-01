// Per-file history of "Extract text" snippets from the DocViewer's photo/video
// pane. Each entry pairs a small thumbnail of the selected region with the
// text the AI read from it, kept per file so reopening the same file restores
// the history.
//
// WHERE IT LIVES: the project index, knowledge kind `extraction` (see
// lib/projectIndexClient) — tied to the file's content and carried with the
// case in `.docvex/knowledge/`. The localStorage key is the old home: still read
// for a file the index hasn't answered for, still written without main, and
// moved across on first hydration.
import { peekFacet, putFacet, clearFacet, cachedEntries, indexAvailable, normPath } from './projectIndexClient';
import { secureStorage, secureKeys } from './secureStore';

const KEY_PREFIX = 'docvex:doc-viewer:ocr-history:';
const MAX_ENTRIES = 30;

// Exposed so other surfaces (the AI section's "Extractions" tab) can recognise
// our localStorage keys — e.g. to refresh on the cross-window `storage` event.
export const OCR_HISTORY_PREFIX = KEY_PREFIX;

// Basename of an on-disk path (handles both / and \ separators).
function fileNameFromPath(p) {
  if (!p) return 'File';
  const norm = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base || norm;
}

function safeRead(key) {
  try { return secureStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try { secureStorage.setItem(key, value); return true; } catch { return false; }
}
function safeRemove(key) {
  try { secureStorage.removeItem(key); return true; } catch { return false; }
}

function loadLegacy(filePath) {
  const raw = safeRead(KEY_PREFIX + filePath);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Returns [{ id, thumb (data URL), text, createdAt }], newest first.
export function loadOcrHistory(filePath) {
  if (!filePath) return [];
  const facet = peekFacet(filePath, 'extraction');
  if (facet && Array.isArray(facet.data) && facet.data.length) return facet.data;
  return loadLegacy(filePath);
}

export function saveOcrHistory(filePath, entries) {
  if (!filePath) return false;
  if (!entries || entries.length === 0) {
    const had = indexAvailable() && clearFacet(filePath, 'extraction');
    return safeRemove(KEY_PREFIX + filePath) || had;
  }
  const list = entries.slice(0, MAX_ENTRIES);
  const facet = {
    kind: 'extraction',
    at: Math.max(Date.now(), ...list.map((e) => Number(e?.createdAt) || 0)),
    engine: 'claude',
    paid: true,
    data: list,
  };
  const writeLegacy = () => safeWrite(KEY_PREFIX + filePath, JSON.stringify(list));
  if (putFacet({ path: filePath }, 'extraction', facet, { onFail: writeLegacy })) {
    safeRemove(KEY_PREFIX + filePath);
    return true;
  }
  return writeLegacy();
}

// Enumerate every file that has saved OCR snippets — the index's copy (the
// files hydrated in this window) and any localStorage keys not moved yet.
// Returns [{ filePath, fileName, entries, count }], most-recently-updated
// first (by the newest entry's createdAt).
export function listOcrHistories() {
  const byPath = new Map();
  try {
    for (const key of secureKeys(KEY_PREFIX)) {
      const filePath = key.slice(KEY_PREFIX.length);
      const entries = loadLegacy(filePath);
      if (entries.length) byPath.set(normPath(filePath), { filePath, entries });
    }
  } catch {
    /* private mode / quota — return whatever we gathered */
  }
  for (const e of cachedEntries()) {
    const list = e.facets.extraction?.data;
    if (Array.isArray(list) && list.length) byPath.set(normPath(e.path), { filePath: e.path, entries: list });
  }
  const out = [...byPath.values()].map(({ filePath, entries }) => ({
    filePath, fileName: fileNameFromPath(filePath), entries, count: entries.length,
  }));
  out.sort((a, b) => (b.entries[0]?.createdAt || 0) - (a.entries[0]?.createdAt || 0));
  return out;
}
