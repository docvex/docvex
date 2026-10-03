// Thin Supabase wrapper for the `public.notifications` table.
//
// The provider (NotificationsContext) keeps its local-state semantics — these
// helpers are fire-and-forget mirrors that talk to the server. Errors are
// returned as `{ error }` instead of thrown so callers can decide whether to
// log; the provider treats them as non-fatal (same pattern as the existing
// localStorage write effect).
//
// All reads/writes are scoped by RLS (auth.uid() = user_id), so callers don't
// need to add `.eq('user_id', ...)` for safety — only for filtering.

import { supabase } from './supabaseClient';
import { HISTORY_CAP, toPersistent } from './notifications';

const TABLE = 'notifications';

// Fetch the most recent rows for the signed-in user. Used at hydration time
// to seed the provider's state. Caller has already gated on `userId` being
// non-null — we still pass it as a filter for clarity (RLS would enforce it
// anyway).
//
// Field list mirrors `toPersistent` in src/lib/notifications.js — that's the
// canonical persisted shape. If a column is added to the table AND consumed
// by the provider, update both `toPersistent` and this select together.
export async function fetchRecent(userId, limit = HISTORY_CAP) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, user_id, category, variant, priority, title, body, icon, payload, created_at, read_at, dedupe_key')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return { data: data || [], error };
}

// Insert a row. The notification object comes from buildNotification() and
// already has every persistent field set (including the client-generated UUID
// used as the primary key). `ignoreDuplicates` flips on the upsert path so a
// coalesce-strategy notify() can be issued concurrently from two devices
// without one of them failing on the unique (user_id, dedupe_key) index.
// What leaves this computer (security audit 2026-10-01): no local file paths
// or localfile:// URLs anywhere in the payload (a thumbnail, an activity's
// filePath), and the dedupe key — which callers build from paths and names —
// only as a hash. The local history keeps the full notification.
const LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|Volumes|private|tmp|var)\/|localfile:|file:)/;
function scrubPaths(v, depth = 0) {
  if (depth > 6) return null;
  if (typeof v === 'string') return LOCAL_PATH.test(v) ? null : v;
  if (Array.isArray(v)) return v.map((x) => scrubPaths(x, depth + 1)).filter((x) => x != null);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (/^(thumb|thumbUrl|path|filePath|dir|folderPath|localPath)$/i.test(k)) continue;
      const y = scrubPaths(x, depth + 1);
      if (y != null) out[k] = y;
    }
    return out;
  }
  return v;
}
export async function hashDedupeKey(key) {
  if (!key) return null;
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(key)));
    return `h:${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch { return null; }
}
async function serverRow(notification) {
  const row = toPersistent(notification);
  return { ...row, payload: scrubPaths(row.payload || {}) || {}, dedupe_key: await hashDedupeKey(row.dedupe_key) };
}

export async function insertOne(notification, { ignoreDuplicates = false } = {}) {
  const row = await serverRow(notification);
  if (ignoreDuplicates) {
    const { error } = await supabase
      .from(TABLE)
      .upsert(row, { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true });
    return { error };
  }
  const { error } = await supabase.from(TABLE).insert(row);
  return { error };
}

// Used by the `replace` dedupe strategy — the provider deletes existing rows
// with the same key, then inserts the fresh one. Matching the server-side
// behavior to the client's in-memory filter keeps the table from accumulating
// stale rows that the UI no longer shows.
export async function deleteByDedupeKey(userId, dedupeKey) {
  if (!dedupeKey) return { error: null };
  // Rows are keyed by the HASH now; a row written before that by the key itself.
  const hashed = await hashDedupeKey(dedupeKey);
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('user_id', userId)
    .in('dedupe_key', hashed ? [hashed, dedupeKey] : [dedupeKey]);
  return { error };
}

export async function markRead(id) {
  const { error } = await supabase
    .from(TABLE)
    .update({ read_at: new Date().toISOString() })
    .eq('id', id)
    .is('read_at', null);
  return { error };
}

export async function markAllRead(userId) {
  const { error } = await supabase
    .from(TABLE)
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('read_at', null);
  return { error };
}

export async function deleteOne(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  return { error };
}

export async function deleteAllForUser(userId) {
  const { error } = await supabase.from(TABLE).delete().eq('user_id', userId);
  return { error };
}

// Realtime subscription for cross-device sync. `onChange` is invoked with the
// raw postgres_changes payload: { eventType, new, old }. Returns an unsubscribe
// function. The channel name is keyed on userId so re-subscribing on auth
// changes doesn't collide with a previous user's still-closing channel.
export function subscribeForUser(userId, onChange) {
  if (!userId) return () => {};
  const channel = supabase
    .channel(`notifications:${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: TABLE,
        filter: `user_id=eq.${userId}`,
      },
      onChange
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
  };
}
