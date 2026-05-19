// Per-(user, project) set of filenames the user has chosen to HIDE from
// their My-branch view. The files are still on disk and still tracked
// by the sidecar — they just don't render in the file grid. Unlike
// delete (which is a true filesystem rm), hide is a pure presentation
// filter: hidden files stay claimable by their sidecar entry, stay
// hashable for the diff layer, stay pushable if their bytes change,
// and survive reloads via localStorage.
//
// Why per-user instead of per-project shared: hiding is a personal
// "I don't want to look at this right now" preference, not a project-
// wide policy. Two collaborators on the same project can hide different
// files without affecting each other.
//
// Stored shape: a plain string array of LOWERCASE filenames. Lowercase
// because Windows + macOS filesystems are case-insensitive by default,
// so "Report.docx" and "report.docx" should hide as one entry.

const KEY = (userId, projectId) =>
  `docvex:hidden-files:${userId || '_anon'}:${projectId}`;

function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

// Returns a Set<string> of lowercase filenames. Empty set when nothing
// is hidden / when localStorage is unavailable. Always a fresh Set so
// callers can hand it to React state without sharing references.
export function loadHiddenFiles(userId, projectId) {
  if (!projectId) return new Set();
  const raw = safeRead(KEY(userId, projectId));
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((n) => typeof n === 'string').map((n) => n.toLowerCase()));
  } catch {
    return new Set();
  }
}

export function saveHiddenFiles(userId, projectId, names) {
  if (!projectId) return false;
  const arr = Array.from(names || []).map((n) => (n || '').toLowerCase()).filter(Boolean);
  return safeWrite(KEY(userId, projectId), JSON.stringify(arr));
}
