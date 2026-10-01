// Personal activity log — long-retention local store of "progress" events:
// every file action (create / import / edit / rename / move / delete / restore)
// and AI assist (text extract, captions, generated document, PDF export).
//
// Why a second store next to notifications: the notification history is capped
// at 100 rows, which is far too small to compute 28-day heatmaps, streaks and
// per-file totals for an active user. This log keeps ~90 days of lightweight
// events per user in localStorage and powers the Activity page's metrics strip
// and its per-file / per-action grouping.
//
// It is written from ONE choke point: NotificationsContext.notify() forwards
// any payload that carries `payload.activity` here. Call sites therefore tag
// their existing notify() calls instead of writing to two stores themselves —
// see `payload: { activity: { action, fileName, ... } }` in ProjectFiles /
// DocViewer. Cross-window consistency piggybacks on the `storage` event, same
// as the notification history.

const STORAGE_PREFIX = 'docvex.activityLog.v1.';
const ANONYMOUS_BUCKET = '_anonymous';
const LOG_CAP = 2000;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// In-window change signal (localStorage `storage` events only fire in OTHER
// windows) — subscribeActivity listens to both.
const LOCAL_EVENT = 'docvex:activity-log';

// Action vocabulary. Every event's `action` should be one of these; anything
// unknown still renders (label falls back to the raw string).
export const ACTIVITY_ACTIONS = Object.freeze({
  CREATE: 'create',
  CREATE_FOLDER: 'create-folder',
  IMPORT: 'import',
  EDIT: 'edit',
  RENAME: 'rename',
  MOVE: 'move',
  DELETE: 'delete',
  RESTORE: 'restore',
  PURGE: 'purge',
  EXTRACT_TEXT: 'extract-text',
  CAPTIONS: 'captions',
  GENERATE_DOC: 'generate-doc',
  EXPORT_PDF: 'export-pdf',
});

// Friendly labels for grouping headers, metric tiles and tooltips.
export const ACTIVITY_ACTION_LABELS = Object.freeze({
  create: 'Created',
  'create-folder': 'Folders created',
  import: 'Imported',
  edit: 'Edited',
  rename: 'Renamed',
  move: 'Moved',
  delete: 'Deleted',
  restore: 'Restored',
  purge: 'Permanently deleted',
  'extract-text': 'Text extracted',
  captions: 'Captions generated',
  'generate-doc': 'Documents generated',
  'export-pdf': 'PDF exports',
});

export function activityActionLabel(action) {
  return ACTIVITY_ACTION_LABELS[action] || String(action || 'Activity');
}

export function activityStorageKey(userId) {
  return STORAGE_PREFIX + (userId || ANONYMOUS_BUCKET);
}

function readBucket(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // corrupted JSON — start fresh
  }
}

function prune(events, now = Date.now()) {
  const cutoff = now - MAX_AGE_MS;
  return events
    .filter((e) => {
      const t = Date.parse(e?.at);
      return !Number.isNaN(t) && t >= cutoff;
    })
    .slice(0, LOG_CAP);
}

// Newest-first list of events for the user (already pruned on write).
export function listActivity(userId) {
  return readBucket(activityStorageKey(userId));
}

// Append one event. Shape (all optional except action):
//   { id, at, action, fileName, filePath, files: [names], count,
//     projectId, projectName, title }
// `count` defaults to 1 and lets a batch import weigh as N files in the
// file-count metrics while staying a single feed row.
export function appendActivityEvent(userId, event) {
  if (!event || !event.action) return null;
  const key = activityStorageKey(userId);
  const now = Date.now();
  const entry = {
    id: event.id || `act_${now}_${Math.random().toString(36).slice(2, 10)}`,
    at: event.at || new Date(now).toISOString(),
    action: event.action,
    fileName: event.fileName ?? null,
    filePath: event.filePath ?? null,
    files: Array.isArray(event.files) ? event.files.slice(0, 20) : undefined,
    count: Number(event.count) > 0 ? Number(event.count) : 1,
    projectId: event.projectId ?? null,
    projectName: event.projectName ?? null,
    title: event.title ?? null,
  };
  try {
    const next = prune([entry, ...readBucket(key)], now);
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    return null; // quota / private mode — non-fatal, fire-and-forget
  }
  try { window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: { key } })); } catch { /* SSR-safe */ }
  return entry;
}

// Notifies on any change to the user's log — same-window appends AND writes
// from other windows (doc-viewer, second app window) via the storage event.
export function subscribeActivity(userId, callback) {
  const key = activityStorageKey(userId);
  const onLocal = (e) => { if (e?.detail?.key === key) callback(); };
  const onStorage = (e) => { if (e.key === key) callback(); };
  window.addEventListener(LOCAL_EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(LOCAL_EVENT, onLocal);
    window.removeEventListener('storage', onStorage);
  };
}

export function clearActivity(userId) {
  try { localStorage.removeItem(activityStorageKey(userId)); } catch { /* non-fatal */ }
  try { window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: { key: activityStorageKey(userId) } })); } catch { /* ignore */ }
}

// True if the localStorage key is one of ours (any user bucket) — mirrors
// isNotificationsStorageKey so eraseData() can wipe activity history too.
export function isActivityStorageKey(key) {
  return typeof key === 'string' && key.startsWith(STORAGE_PREFIX);
}
