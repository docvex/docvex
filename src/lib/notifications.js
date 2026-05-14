// Pure helpers + constants for the notifications system.
// Anything stateful (provider, hooks, components) lives elsewhere — this file
// is import-cycle-safe and used by both the provider and the UI.

// Notification categories — each maps to a distinct color + default icon
// so the history list is scannable. Add a category instead of overloading
// SYSTEM when you ship a new event type; SYSTEM is the catch-all fallback
// (cache cleared, clipboard error, anything not domain-specific). See
// src/notifications/icons.jsx for category → default-icon mapping and
// src/styles/tokens.css for the --cat-* colors.
export const NOTIFICATION_CATEGORIES = Object.freeze({
  AUTH:    'auth',     // sign-in / sign-out / profile / link provider
  PROJECT: 'project',  // project lifecycle (create / update / join)
  MEMBER:  'member',   // members + invitations (send / revoke / resend / kick)
  FILE:    'file',     // file uploads / deletes / open errors
  ROLE:    'role',     // custom-role CRUD
  UPDATE:  'update',   // app self-update lifecycle
  SUPPORT: 'support',  // support reports
  SYSTEM:  'system',   // generic / fallback
  INFO:    'info',     // back-compat alias; new code should pick a real category
  SOCIAL:  'social',   // reserved for future @-mention / DM events
});

export const NOTIFICATION_VARIANTS = Object.freeze({
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'error',
});

// Notification priority — third axis orthogonal to category + variant. Drives
// the tab filter on /notifications and the small priority dot rendered next
// to each row's title. Use sparingly: most notifications are NORMAL, and the
// CRITICAL tier is reserved for "the user really has to act now" cases
// (auth-breaking errors, updater failures, etc.).
export const NOTIFICATION_PRIORITIES = Object.freeze({
  CRITICAL: 'critical',
  HIGH:     'high',
  NORMAL:   'normal',
  LOW:      'low',
});

// Order matters: index doubles as numeric weight if anything ever needs to
// compare priorities (lower index = higher priority).
export const NOTIFICATION_PRIORITY_ORDER = Object.freeze([
  NOTIFICATION_PRIORITIES.CRITICAL,
  NOTIFICATION_PRIORITIES.HIGH,
  NOTIFICATION_PRIORITIES.NORMAL,
  NOTIFICATION_PRIORITIES.LOW,
]);

const VALID_PRIORITIES = new Set(NOTIFICATION_PRIORITY_ORDER);

// Derive a priority for a notify() payload that didn't supply one explicitly.
//   - errors + warnings → high (the user should at least notice)
//   - everything else   → normal
// Callsites override when the default is wrong — see the table in the plan
// (e.g. "Could not delete account" is `critical`, "Signed in" is `low`).
export function derivePriority(payload) {
  if (payload?.priority && VALID_PRIORITIES.has(payload.priority)) {
    return payload.priority;
  }
  if (payload?.variant === NOTIFICATION_VARIANTS.ERROR
      || payload?.variant === NOTIFICATION_VARIANTS.WARNING) {
    return NOTIFICATION_PRIORITIES.HIGH;
  }
  return NOTIFICATION_PRIORITIES.NORMAL;
}

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

// Relative-time formatter for the history list. Within the last 24h we use
// the locale's relative-time wording ("just now", "5 min ago", "2 h ago").
// Once a notification crosses the 24-hour boundary, we switch to the EXACT
// timestamp ("Oct 5, 2:30 PM") so the user can see precisely when the
// event happened — vague "2 days ago" labels were unhelpful for triage.
const RTF = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat
  ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  : null;

const EXACT_TIME_FORMATTER = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
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

  // 24h+ — show the actual date + time. Locale-aware via Intl.DateTimeFormat.
  return EXACT_TIME_FORMATTER
    ? EXACT_TIME_FORMATTER.format(then)
    : new Date(then).toLocaleString();
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

// Group notifications by RELATIVE age for the Today/Yesterday buckets, then
// by calendar day for anything older. Bucketing strictly by calendar day
// (the previous behavior) was confusing: an event from 11pm last night
// would land in "Yesterday" the next morning even though it was barely
// 9 hours old. Now:
//   - anything <24h old  → "Today"
//   - 24-48h old         → "Yesterday"
//   - older              → calendar day with a localized date label
//
// Returns an array of { key, label, items } chunks ordered newest-first.
const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

export function groupByDay(notifications, now = Date.now()) {
  const buckets = new Map();
  // Insertion order matters for the older-day buckets below; we explicitly
  // re-order Today/Yesterday at the end so they always come first.
  const TODAY_KEY = '__today';
  const YESTERDAY_KEY = '__yesterday';

  for (const n of notifications) {
    const then = Date.parse(n.created_at);
    if (Number.isNaN(then)) continue;
    const ageMs = now - then;
    let key;
    if (ageMs < DAY) key = TODAY_KEY;
    else if (ageMs < 2 * DAY) key = YESTERDAY_KEY;
    else key = `day-${startOfDay(then)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(n);
  }

  const groups = [];
  if (buckets.has(TODAY_KEY)) {
    groups.push({ key: TODAY_KEY, label: 'Today', items: buckets.get(TODAY_KEY) });
  }
  if (buckets.has(YESTERDAY_KEY)) {
    groups.push({ key: YESTERDAY_KEY, label: 'Yesterday', items: buckets.get(YESTERDAY_KEY) });
  }
  // Older buckets: sorted day-descending so the most recent older day comes
  // first. Extract the day-start numeric suffix from the `day-<ms>` key.
  const olderKeys = [...buckets.keys()]
    .filter((k) => k.startsWith('day-'))
    .map((k) => [k, Number(k.slice(4))])
    .sort((a, b) => b[1] - a[1]);
  for (const [key, dayStart] of olderKeys) {
    const label = DAY_FORMATTER
      ? DAY_FORMATTER.format(dayStart)
      : new Date(dayStart).toDateString();
    groups.push({ key, label, items: buckets.get(key) });
  }
  // Preserve the legacy `dayStart` field on each group so any consumer that
  // hasn't migrated to `key` yet (the React `key={…}` prop in Notifications.jsx)
  // still works without refactor.
  return groups.map((g) => ({
    ...g,
    dayStart: g.key === TODAY_KEY
      ? startOfDay(now)
      : g.key === YESTERDAY_KEY
        ? startOfDay(now) - DAY
        : Number(g.key.slice(4)),
  }));
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
    // Third axis: priority. Explicit `payload.priority` wins; otherwise
    // derivePriority() picks based on variant (error/warning → high,
    // else normal). See NOTIFICATION_PRIORITIES.
    priority: derivePriority(payload),
    title: payload.title || '',
    body: payload.body ?? null,
    // Optional contextual-action icon key. Maps to a specific SVG in
    // src/notifications/icons.jsx (e.g. 'trash' for delete, 'envelope'
    // for send, 'plus' for create). When absent, the icon resolver falls
    // back to a variant-based default (alert for error / warning) and
    // then a category-based default (folder for project, etc.).
    icon: payload.icon || null,
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
    priority: n.priority || NOTIFICATION_PRIORITIES.NORMAL,
    title: n.title,
    body: n.body ?? null,
    icon: n.icon ?? null,
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
