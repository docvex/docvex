// Per-file history of "Extract text" snippets from the DocViewer's photo/video
// pane. Each entry pairs a small thumbnail of the selected region with the
// text the AI read from it, persisted to localStorage keyed by the file's
// on-disk path so reopening the same file restores the history.

const KEY_PREFIX = 'docvex:doc-viewer:ocr-history:';
const MAX_ENTRIES = 30;

// Exposed so other surfaces (the AI section's "Extractions" tab) can recognise
// our localStorage keys — e.g. to refresh on the cross-window `storage` event
// fired when the Doc Viewer window saves a new snippet.
export const OCR_HISTORY_PREFIX = KEY_PREFIX;

// Basename of an on-disk path (handles both / and \ separators).
function fileNameFromPath(p) {
  if (!p) return 'File';
  const norm = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base || norm;
}

function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function safeRemove(key) {
  try { localStorage.removeItem(key); return true; } catch { return false; }
}

// Returns [{ id, thumb (data URL), text, createdAt }], newest first.
export function loadOcrHistory(filePath) {
  if (!filePath) return [];
  const raw = safeRead(KEY_PREFIX + filePath);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveOcrHistory(filePath, entries) {
  if (!filePath) return false;
  if (!entries || entries.length === 0) return safeRemove(KEY_PREFIX + filePath);
  return safeWrite(KEY_PREFIX + filePath, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

// Enumerate every file that has saved OCR snippets, scanning localStorage for
// the per-file history keys. Returns [{ filePath, fileName, entries, count }],
// most-recently-updated first (by the newest entry's createdAt). Used by the
// AI section's "Extractions" tab to build its "All files" sidebar.
export function listOcrHistories() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      const filePath = key.slice(KEY_PREFIX.length);
      const entries = loadOcrHistory(filePath);
      if (!entries.length) continue;
      out.push({ filePath, fileName: fileNameFromPath(filePath), entries, count: entries.length });
    }
  } catch {
    /* private mode / quota — return whatever we gathered */
  }
  out.sort((a, b) => (b.entries[0]?.createdAt || 0) - (a.entries[0]?.createdAt || 0));
  return out;
}
