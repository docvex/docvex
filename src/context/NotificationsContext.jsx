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
import { useAuthNotificationSource } from '../notifications/sources/useAuthNotificationSource';
import { useUpdateNotificationSource } from '../notifications/sources/useUpdateNotificationSource';
import { useSocialNotificationSource } from '../notifications/sources/useSocialNotificationSource';

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
  // persist the OLD bucket and hydrate the NEW one. Runs before the source
  // hooks' effects since it's declared first inside this component.
  const previousBucketRef = useRef(null);
  useEffect(() => {
    if (authLoading) return;
    const bucket = storageKeyForUser(userId);
    if (previousBucketRef.current === bucket) return;

    // Persist the soon-to-be-replaced state to the old bucket.
    if (previousBucketRef.current) {
      try {
        const persisted = notificationsRef.current.map(toPersistent).slice(0, HISTORY_CAP);
        localStorage.setItem(previousBucketRef.current, JSON.stringify(persisted));
      } catch { /* quota / private mode — non-fatal */ }
    }

    // Hydrate the new bucket.
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
  }, [authLoading, userId]);

  // Debounced persist on every state change (after the bucket is settled).
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

    // OS-level escalation (v2 scaffolding). Only fires when window is hidden
    // and only via channels that already exist (no permission prompts here).
    if (fresh.osLevel && typeof document !== 'undefined' && document.hidden) {
      const showOS = window.electronAPI?.showOSNotification;
      if (typeof showOS === 'function') {
        try { showOS({ title: fresh.title, body: fresh.body || '' }); } catch { /* ignore */ }
      } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
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
  }, []);

  const markAllRead = useCallback(() => {
    const now = new Date().toISOString();
    setNotifications((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: now })));
  }, []);

  const remove = useCallback((id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    setActiveToastIds((prev) => prev.filter((x) => x !== id));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
    setActiveToastIds([]);
  }, []);

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
