// Pure helpers + constants for the notifications system.
// Anything stateful (provider, hooks, components) lives elsewhere — this file
// is import-cycle-safe and used by both the provider and the UI.

export const NOTIFICATION_CATEGORIES = Object.freeze({
  AUTH: 'auth',
  UPDATE: 'update',
  SOCIAL: 'social',
  SYSTEM: 'system',
  INFO: 'info',
});

export const NOTIFICATION_VARIANTS = Object.freeze({
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'error',
});

// How many toasts may be visible at once. Excess events still land in history
// with toastShown: false — they're never auto-promoted from a queue (matches
// macOS Notification Center). User reads them in the inbox.
export const MAX_ACTIVE_TOASTS = 3;

// Cap on history length. Newest-first; oldest beyond this are dropped on write.
export const HISTORY_CAP = 100;

// Default toast lifetime (ms) when neither `duration` nor `persistent` is set.
export const DEFAULT_TOAST_DURATION = 5000;

// localStorage key prefix. We namespace by user id so two accounts on the same
// machine don't see each other's history. Pre-signin / system events land in
// the _anonymous bucket.
export const NOTIFICATIONS_STORAGE_PREFIX = 'docvex.notifications.v1.';
export const ANONYMOUS_BUCKET = '_anonymous';

export function storageKeyForUser(userId) {
  return NOTIFICATIONS_STORAGE_PREFIX + (userId || ANONYMOUS_BUCKET);
}

// Returns true if the localStorage key is one of ours (any user bucket).
// Used by AuthContext.eraseData() to wipe all notification history on erase.
export function isNotificationsStorageKey(key) {
  return typeof key === 'string' && key.startsWith(NOTIFICATIONS_STORAGE_PREFIX);
}

// Relative-time formatter for the history list. Returns "just now", "5 min ago",
// "2 h ago", "3 d ago", or falls back to a localized date for older items.
// Uses Intl.RelativeTimeFormat so users see their locale's wording.
const RTF = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat
  ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  : null;

export function formatRelativeTime(iso, now = Date.now()) {
  if (!iso) return '';
  const then = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffMs = now - then;
  const diffSec = Math.round(diffMs / 1000);

  if (diffSec < 30) return 'just now';
  if (!RTF) return new Date(then).toLocaleString();

  const abs = Math.abs(diffSec);
  if (abs < 60) return RTF.format(-Math.round(diffSec), 'second');
  if (abs < 3600) return RTF.format(-Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return RTF.format(-Math.round(diffSec / 3600), 'hour');
  if (abs < 7 * 86400) return RTF.format(-Math.round(diffSec / 86400), 'day');

  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Return the start of the day (local time) for the given timestamp.
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY_FORMATTER = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long' })
  : null;

// Group notifications by day for the history list. Returns an array of
// { label, items } chunks ordered newest-first. Today / Yesterday are spelled
// out as words; older days use a long localized date label.
export function groupByDay(notifications, now = Date.now()) {
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 86400 * 1000;

  const buckets = new Map();
  for (const n of notifications) {
    const then = Date.parse(n.created_at);
    if (Number.isNaN(then)) continue;
    const dayStart = startOfDay(then);
    if (!buckets.has(dayStart)) buckets.set(dayStart, []);
    buckets.get(dayStart).push(n);
  }

  // Map.entries() preserves insertion order; we want strict day-DESC.
  const sortedDays = [...buckets.keys()].sort((a, b) => b - a);

  return sortedDays.map((dayStart) => {
    let label;
    if (dayStart === todayStart) label = 'Today';
    else if (dayStart === yesterdayStart) label = 'Yesterday';
    else label = DAY_FORMATTER ? DAY_FORMATTER.format(dayStart) : new Date(dayStart).toDateString();
    return { dayStart, label, items: buckets.get(dayStart) };
  });
}

// Build a fresh notification object from a notify() payload + ambient context.
// The result is what gets stored in history (persistent fields only) plus a
// few client-only runtime fields the provider strips before persisting.
// Caller is responsible for dedupe handling — this is a pure constructor.
export function buildNotification(payload, { userId = null, now = Date.now() } = {}) {
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `n_${now}_${Math.random().toString(36).slice(2, 10)}`;

  return {
    // ── persistent ────────────────────────────────────────────────────────
    id,
    user_id: userId,
    category: payload.category || NOTIFICATION_CATEGORIES.INFO,
    variant: payload.variant || NOTIFICATION_VARIANTS.INFO,
    title: payload.title || '',
    body: payload.body ?? null,
    payload: payload.payload || {},
    created_at: new Date(now).toISOString(),
    read_at: null,
    dedupe_key: payload.dedupeKey ?? null,
    // ── runtime (not persisted — stripped on write) ───────────────────────
    duration: payload.duration ?? DEFAULT_TOAST_DURATION,
    persistent: !!payload.persistent,
    osLevel: !!payload.osLevel,
    toastShown: false,
  };
}

// Strip runtime-only fields so a notification can be JSON-serialized to the
// same shape we'll one day pull from a Supabase `public.notifications` table.
export function toPersistent(n) {
  return {
    id: n.id,
    user_id: n.user_id,
    category: n.category,
    variant: n.variant,
    title: n.title,
    body: n.body ?? null,
    payload: n.payload || {},
    created_at: n.created_at,
    read_at: n.read_at ?? null,
    dedupe_key: n.dedupe_key ?? null,
  };
}

// Decide which dedupe strategy applies to an incoming payload.
//   coalesce → no-op if a row with the same key already exists (default with key)
//   replace  → remove existing, insert new, show toast (status transitions)
//   stack    → always insert (no key, or social events)
export function resolveDedupeStrategy(payload) {
  if (payload.dedupeStrategy) return payload.dedupeStrategy;
  return payload.dedupeKey ? 'coalesce' : 'stack';
}
