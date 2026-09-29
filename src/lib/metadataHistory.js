// Per-file cache of the DocViewer Metadata tab's extraction result. Extracting
// re-reads the file end to end (a SHA-256 over the whole thing, a ZIP walk for
// OOXML docProps, a pdf.js parse, a media-duration probe), which is slow enough
// on a big file to be worth not repeating — so the result is saved to
// localStorage keyed by the file's on-disk path and restored when the tab is
// reopened. One result per file, like lib/captionsHistory.js (the OCR history
// instead keeps a LIST of snippets — see lib/extractionHistory.js).
//
// The cache is keyed by path alone, so an edited file would return stale
// values; `size` and `mtime` are stored alongside for exactly that reason —
// loadMetadata() takes the file's current stat and discards a snapshot that
// doesn't match, rather than serving metadata that no longer describes it.
// Both come straight from localFolderApi.stat: `size` is `sizeBytes`, `mtime`
// is `mtimeIso` (a string compares fine, it's the same field either way).

// WHERE IT LIVES: the project index, knowledge kind `metadata` (see
// lib/projectIndexClient) — tied to the file's content, so it travels with the
// case in `.docvex/knowledge/`. The localStorage key below is what it was kept
// under before; it is still read for a file the index hasn't answered for yet,
// still written when main isn't there, and moved across on first hydration.
import { peekFacet, putFacet, clearFacet, sameSize, indexAvailable } from './projectIndexClient';
import { secureStorage } from './secureStore';

const KEY_PREFIX = 'docvex:doc-viewer:metadata:';

// Exposed so other surfaces can recognise our keys (e.g. a cache sweep).
export const METADATA_PREFIX = KEY_PREFIX;

function safeRead(key) {
  try { return secureStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try { secureStorage.setItem(key, value); return true; } catch { return false; }
}
function safeRemove(key) {
  try { secureStorage.removeItem(key); return true; } catch { return false; }
}

// Returns the stored { groups, warnings, extractedAt } | null. Pass the file's
// current { size, mtime } to have a snapshot of a since-changed file rejected;
// omit them and whatever was stored is returned as-is.
export function loadMetadata(filePath, stamp) {
  if (!filePath) return null;
  const facet = peekFacet(filePath, 'metadata');
  if (facet && Array.isArray(facet.data?.groups)) {
    // The index only answers for the file's current content; the size is the
    // one part of the stamp that means the same thing on every machine.
    if (stamp && !sameSize(facet.stamp, stamp)) return null;
    return {
      groups: facet.data.groups,
      warnings: Array.isArray(facet.data.warnings) ? facet.data.warnings : [],
      extractedAt: facet.data.extractedAt || facet.at || 0,
    };
  }
  return loadLegacy(filePath, stamp);
}

function loadLegacy(filePath, stamp) {
  const raw = safeRead(KEY_PREFIX + filePath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.groups)) return null;
    // Only compare the fields we actually have on both sides — a caller with
    // no stat info shouldn't invalidate a good snapshot.
    if (stamp) {
      if (stamp.size != null && parsed.size != null && Number(stamp.size) !== Number(parsed.size)) return null;
      if (stamp.mtime != null && parsed.mtime != null && String(stamp.mtime) !== String(parsed.mtime)) return null;
    }
    return {
      groups: parsed.groups,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      extractedAt: parsed.extractedAt || 0,
    };
  } catch {
    return null;
  }
}

export function saveMetadata(filePath, data, stamp) {
  if (!filePath || !data || !Array.isArray(data.groups)) return false;
  const extractedAt = data.extractedAt || Date.now();
  const facet = {
    kind: 'metadata',
    at: extractedAt,
    engine: 'local',
    paid: false,
    stamp: { size: stamp?.size ?? null, mtime: stamp?.mtime ?? null },
    data: { groups: data.groups, warnings: Array.isArray(data.warnings) ? data.warnings : [], extractedAt },
  };
  if (putFacet({ path: filePath }, 'metadata', facet, { onFail: () => writeLegacy(filePath, data, stamp) })) {
    safeRemove(KEY_PREFIX + filePath);
    return true;
  }
  return writeLegacy(filePath, data, stamp);
}

function writeLegacy(filePath, data, stamp) {
  return safeWrite(KEY_PREFIX + filePath, JSON.stringify({
    groups: data.groups,
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
    extractedAt: data.extractedAt || Date.now(),
    size: stamp?.size ?? null,
    mtime: stamp?.mtime ?? null,
  }));
}

export function clearMetadata(filePath) {
  if (!filePath) return false;
  const had = indexAvailable() && clearFacet(filePath, 'metadata');
  return safeRemove(KEY_PREFIX + filePath) || had;
}
