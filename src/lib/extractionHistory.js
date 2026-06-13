// Per-file history of "Extract text" snippets from the DocViewer's photo/video
// pane. Each entry pairs a small thumbnail of the selected region with the
// text the AI read from it, persisted to localStorage keyed by the file's
// on-disk path so reopening the same file restores the history.

const KEY_PREFIX = 'docvex:doc-viewer:ocr-history:';
const MAX_ENTRIES = 30;

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
