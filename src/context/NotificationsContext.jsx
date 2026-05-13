import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';
import {
  ANONYMOUS_BUCKET,
  HISTORY_CAP,
  MAX_ACTIVE_TOASTS,
  buildNotification,
  resolveDedupeStrategy,
  storageKeyForUser,
  toPersistent,
} from '../lib/notifications';
import {
  deleteByDedupeKey,
  deleteOne as repoDeleteOne,
  deleteAllForUser as repoDeleteAllForUser,
  fetchRecent,
  insertOne,
  markAllRead as repoMarkAllRead,
  markRead as repoMarkRead,
  subscribeForUser,
} from '../lib/notificationsRepo';
import { useAuthNotificationSource } from '../notifications/sources/useAuthNotificationSource';
import { useUpdateNotificationSource } from '../notifications/sources/useUpdateNotificationSource';
import { useSocialNotificationSource } from '../notifications/sources/useSocialNotificationSource';
import * as platform from '../lib/platform';

const NotificationsContext = createContext(null);

export function NotificationsProvider({ children }) {
  const { session, loading: authLoading } = useAuth();
  const userId = session?.user?.id || null;

  // History (newest-first) and the subset of ids currently shown as toasts.
  // Active is just ids — we look up the full notification on render so a
  // single source of truth (`notifications`) carries every field.
  const [notifications, setNotifications] = useState([]);
  const [activeToastIds, setActiveToastIds] = useState([]);

  // `ready` flips true after the first hydration for the current bucket. The
  // source-hooks gate on this so they don't fire toasts for events that
  // arrive before history has been loaded from storage (otherwise StrictMode
  // dev double-mount or hot reload could re-toast yesterday's notification).
  const [ready, setReady] = useState(false);

  // Refs so notify() can peek at "current state" without making the callback
  // depend on the array — keeps the function referentially stable across
  // every notification add and stops the source-hook effects from re-running.
  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;
  const activeToastsRef = useRef(activeToastIds);
  activeToastsRef.current = activeToastIds;

  // Bucket transitions (sign-in/out switches storage key). On change we
  // persist the OLD bucket and hydrate the NEW one — from localStorage when
  // anonymous, from Supabase (with localStorage as instant-render cache) when
  // signed in. The user's auth state ID is the bucket key.
  const previousBucketRef = useRef(null);
  useEffect(() => {
    if (authLoading) return;
    const bucket = storageKeyForUser(userId);
    if (previousBucketRef.current === bucket) return;

    // Persist the soon-to-be-replaced state to the old bucket. This doubles
    // as the offline cache for the user bucket and the sole store for the
    // anonymous bucket.
    if (previousBucketRef.current) {
      try {
        const persisted = notificationsRef.current.map(toPersistent).slice(0, HISTORY_CAP);
        localStorage.setItem(previousBucketRef.current, JSON.stringify(persisted));
      } catch { /* quota / private mode — non-fatal */ }
    }

    // Hydrate the new bucket in two phases that run in parallel:
    //
    //   Phase 1 (sync, below): read localStorage so the UI renders instantly
    //     with the last known state.
    //   Phase 2 (async, below): fetch from Supabase and reconcile.
    //
    // Phase 2 is kicked off FIRST so its network roundtrip overlaps with the
    // localStorage parse + React render. The local cache still hydrates
    // synchronously — what changes is that the server response is already
    // in flight by the time React commits the cached state.
    let cancelled = false;
    const serverPromise = userId
      ? fetchRecent(userId, HISTORY_CAP).catch((err) => ({ data: null, error: err }))
      : null;

    let hydrated = [];
    try {
      const raw = localStorage.getItem(bucket);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // Mark hydrated rows as toastShown so the UI never re-animates them
          // and the source-hooks aren't tricked into re-emitting toasts.
          hydrated = parsed.map((n) => ({ ...n, toastShown: true }));
        }
      }
    } catch { /* corrupted JSON — start fresh */ }

    setNotifications(hydrated);
    setActiveToastIds([]); // toasts never survive across bucket switches
    previousBucketRef.current = bucket;
    setReady(true);

    // Reconcile when the server fetch resolves. Only overwrite when the
    // server has rows — an empty server result is ambiguous (genuinely new
    // user with no notifications, OR transient RLS hiccup) and replacing the
    // local cache with [] in that ambiguous case would briefly blank out the
    // bell for someone whose phone is offline. The cache wins ties; freshly
    // arrived rows on the next event will reconcile.
    if (serverPromise) {
      serverPromise.then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.warn('[notifications] fetchRecent failed, using cache:', error.message ?? error);
          return;
        }
        if (!data || data.length === 0) return; // keep the cache
        // Server rows arrive in DB shape — add the runtime-only fields back.
        const rebuilt = data.map((row) => ({
          ...row,
          duration: 0,
          persistent: false,
          osLevel: false,
          toastShown: true, // server-loaded rows never animate
        }));
        setNotifications(rebuilt);
      });
    }

    return () => { cancelled = true; };
  }, [authLoading, userId]);

  // Debounced persist on every state change (after the bucket is settled).
  // Doubles as the offline cache when signed-in.
  useEffect(() => {
    if (!ready) return;
    const bucket = storageKeyForUser(userId);
    const handle = setTimeout(() => {
      try {
        const persisted = notifications.map(toPersistent).slice(0, HISTORY_CAP);
        localStorage.setItem(bucket, JSON.stringify(persisted));
      } catch { /* non-fatal */ }
    }, 200);
    return () => clearTimeout(handle);
  }, [notifications, ready, userId]);

  // Cross-window sync — Electron may grow multi-window. The `storage` event
  // fires in other tabs/windows of the same origin when localStorage changes.
  useEffect(() => {
    if (!ready) return;
    const bucket = storageKeyForUser(userId);
    const handler = (e) => {
      if (e.key !== bucket) return;
      if (e.newValue === null) {
        setNotifications([]);
        return;
      }
      try {
        const parsed = JSON.parse(e.newValue);
        if (Array.isArray(parsed)) {
          setNotifications(parsed.map((n) => ({ ...n, toastShown: true })));
        }
      } catch { /* ignore */ }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [ready, userId]);

  // Realtime subscription — only when signed in. Cross-device sync: an INSERT
  // from another machine appears here as a new row (no toast, since the user
  // already saw it where it was created). UPDATE syncs read_at; DELETE drops.
  // We dedupe by id against current state so the echo of our own write is a
  // no-op (we already optimistically applied it in notify()/markRead()/etc.).
  useEffect(() => {
    if (!ready || !userId) return;
    const unsubscribe = subscribeForUser(userId, (payload) => {
      const { eventType, new: newRow, old: oldRow } = payload;
      if (eventType === 'INSERT' && newRow?.id) {
        setNotifications((prev) => {
          if (prev.some((n) => n.id === newRow.id)) return prev;
          const rebuilt = {
            ...newRow,
            duration: 0,
            persistent: false,
            osLevel: false,
            toastShown: true,
          };
          return [rebuilt, ...prev].slice(0, HISTORY_CAP);
        });
      } else if (eventType === 'UPDATE' && newRow?.id) {
        setNotifications((prev) =>
          prev.map((n) => (n.id === newRow.id ? { ...n, read_at: newRow.read_at } : n))
        );
      } else if (eventType === 'DELETE' && oldRow?.id) {
        setNotifications((prev) => prev.filter((n) => n.id !== oldRow.id));
        setActiveToastIds((prev) => prev.filter((id) => id !== oldRow.id));
      }
    });
    return unsubscribe;
  }, [ready, userId]);

  // ── Public API ────────────────────────────────────────────────────────────

  const notify = useCallback((payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const strategy = resolveDedupeStrategy(payload);
    const dedupeKey = payload.dedupeKey ?? null;

    const currentList = notificationsRef.current;
    const currentActive = activeToastsRef.current;

    // Coalesce: if a row with the same key exists, do nothing and return its id.
    if (dedupeKey && strategy === 'coalesce') {
      const existing = currentList.find((n) => n.dedupe_key === dedupeKey);
      if (existing) return existing.id;
    }

    const fresh = buildNotification(payload, { userId });

    // Compute whether this notification gets to show a toast. Replace can
    // displace an active toast that had the same key; otherwise we respect
    // the MAX_ACTIVE_TOASTS cap and silently drop overflow into history.
    const displacedActiveIds = (dedupeKey && strategy === 'replace')
      ? currentActive.filter((id) => {
          const n = currentList.find((x) => x.id === id);
          return n?.dedupe_key === dedupeKey;
        })
      : [];
    const remainingActiveCount = currentActive.length - displacedActiveIds.length;
    const willShowToast = remainingActiveCount < MAX_ACTIVE_TOASTS;
    fresh.toastShown = willShowToast;

    // Apply state updates.
    setNotifications((prev) => {
      let next = prev;
      if (dedupeKey && strategy === 'replace') {
        next = prev.filter((n) => n.dedupe_key !== dedupeKey);
      }
      return [fresh, ...next].slice(0, HISTORY_CAP);
    });

    if (willShowToast) {
      setActiveToastIds((prev) => {
        const filtered = displacedActiveIds.length
          ? prev.filter((id) => !displacedActiveIds.includes(id))
          : prev;
        return [fresh.id, ...filtered].slice(0, MAX_ACTIVE_TOASTS);
      });
    } else if (displacedActiveIds.length) {
      // Replace fired but we're at cap — still drop the replaced active id.
      setActiveToastIds((prev) => prev.filter((id) => !displacedActiveIds.includes(id)));
    }

    // Mirror to Supabase when signed in. Anonymous bucket stays local-only
    // (RLS would reject the insert anyway since user_id is required). The
    // server write is fire-and-forget — local state is already authoritative
    // for this device; the row eventually lands in the cloud (or doesn't, in
    // which case the user still sees it locally).
    if (userId) {
      const mirror = async () => {
        try {
          if (strategy === 'replace' && dedupeKey) {
            await deleteByDedupeKey(userId, dedupeKey);
            await insertOne(fresh);
          } else if (strategy === 'coalesce' && dedupeKey) {
            await insertOne(fresh, { ignoreDuplicates: true });
          } else {
            await insertOne(fresh);
          }
        } catch (err) {
          console.warn('[notifications] mirror insert failed:', err);
        }
      };
      mirror();
    }

    // OS-level escalation (v2 scaffolding). Only fires when window is hidden
    // and only via channels that already exist (no permission prompts here).
    // Two layers: the platform adapter (Electron IPC if/when wired; web no-op)
    // and a web-browser Notification API fallback when permission was already
    // granted out-of-band. Neither path prompts the user.
    if (fresh.osLevel && typeof document !== 'undefined' && document.hidden) {
      try { platform.showOSNotification({ title: fresh.title, body: fresh.body || '' }); } catch { /* ignore */ }
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification(fresh.title, { body: fresh.body || '' }); } catch { /* ignore */ }
      }
    }

    return fresh.id;
  }, [userId]);

  const dismissToast = useCallback((id) => {
    setActiveToastIds((prev) => prev.filter((x) => x !== id));
  }, []);

  const markRead = useCallback((id) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n))
    );
    if (userId) {
      repoMarkRead(id).catch((err) => console.warn('[notifications] markRead mirror failed:', err));
    }
  }, [userId]);

  const markAllRead = useCallback(() => {
    const now = new Date().toISOString();
    setNotifications((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: now })));
    if (userId) {
      repoMarkAllRead(userId).catch((err) => console.warn('[notifications] markAllRead mirror failed:', err));
    }
  }, [userId]);

  const remove = useCallback((id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    setActiveToastIds((prev) => prev.filter((x) => x !== id));
    if (userId) {
      repoDeleteOne(id).catch((err) => console.warn('[notifications] remove mirror failed:', err));
    }
  }, [userId]);

  const clearAll = useCallback(() => {
    setNotifications([]);
    setActiveToastIds([]);
    if (userId) {
      repoDeleteAllForUser(userId).catch((err) => console.warn('[notifications] clearAll mirror failed:', err));
    }
  }, [userId]);

  // ── Source hooks (compose once, gated on bootstrap) ───────────────────────
  // The provider's job ends here — adding a new source is literally one line.

  useAuthNotificationSource(notify, { ready });
  useUpdateNotificationSource(notify, { ready });
  useSocialNotificationSource(notify, userId, { ready });

  // Derived values memoized so unrelated re-renders (e.g. toast hover) don't
  // bleed into every consumer of the context.
  const unreadCount = useMemo(
    () => notifications.reduce((acc, n) => (n.read_at ? acc : acc + 1), 0),
    [notifications]
  );

  const activeToasts = useMemo(() => {
    if (activeToastIds.length === 0) return [];
    const byId = new Map(notifications.map((n) => [n.id, n]));
    return activeToastIds.map((id) => byId.get(id)).filter(Boolean);
  }, [activeToastIds, notifications]);

  const value = useMemo(() => ({
    notifications,
    activeToasts,
    unreadCount,
    notify,
    dismissToast,
    markRead,
    markAllRead,
    remove,
    clearAll,
  }), [notifications, activeToasts, unreadCount, notify, dismissToast, markRead, markAllRead, remove, clearAll]);

  // Expose a dev-only handle for the verification step in the plan
  // (`window.__notify(...)`). No-op in production builds (Vite strips
  // import.meta.env.DEV at build time).
  if (import.meta.env?.DEV && typeof window !== 'undefined') {
    window.__notify = notify;
  }

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used inside <NotificationsProvider>');
  return ctx;
}

// Re-export the anonymous bucket constant for any caller (Account page,
// debug UI) that wants to talk about "the pre-signin notification bucket".
export { ANONYMOUS_BUCKET };
