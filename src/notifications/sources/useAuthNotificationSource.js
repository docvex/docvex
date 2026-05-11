import { useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';

// displayName resolution duplicated from Sidebar.jsx / Account.jsx — keep in
// sync per CLAUDE.md convention (`user_metadata.full_name || .name || .email`).
function displayName(user) {
  return (
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    user?.email ||
    'your account'
  );
}

/**
 * Translates AuthContext events into notify() calls.
 *
 * Robustness: the first auth event after mount is *always* skipped via
 * `hasBootstrappedRef`, regardless of whether it's INITIAL_SESSION (modern
 * supabase-js), SIGNED_IN with a restored session (older builds), or a
 * StrictMode dev double-mount. This means a relaunch with a cached session
 * never produces a redundant "Signed in as …" toast.
 *
 * Events handled:
 *   SIGNED_IN     → success toast, dedupe-key 'auth-signin'
 *   SIGNED_OUT    → info toast
 *   USER_UPDATED  → info toast, coalesce dedupe to suppress refresh bursts
 *
 * @param {(payload: object) => string} notify  — provider's notify()
 * @param {{ ready: boolean }} [opts]            — gate so hooks don't fire before hydration
 */
export function useAuthNotificationSource(notify, { ready = true } = {}) {
  const { lastAuthEvent } = useAuth();
  const hasBootstrappedRef = useRef(false);

  useEffect(() => {
    if (!ready) return;
    if (!lastAuthEvent) return;

    // Always skip the first event. Whether it's INITIAL_SESSION or a "restored
    // SIGNED_IN", we treat startup as silent.
    if (!hasBootstrappedRef.current) {
      hasBootstrappedRef.current = true;
      return;
    }

    const { event, session } = lastAuthEvent;
    switch (event) {
      case 'SIGNED_IN':
        notify({
          category: 'auth',
          variant: 'success',
          title: `Signed in as ${displayName(session?.user)}`,
          dedupeKey: 'auth-signin',
          dedupeStrategy: 'replace',
        });
        break;
      case 'SIGNED_OUT':
        notify({
          category: 'auth',
          variant: 'info',
          title: 'Signed out',
          dedupeKey: 'auth-signout',
          dedupeStrategy: 'replace',
        });
        break;
      case 'USER_UPDATED':
        notify({
          category: 'auth',
          variant: 'info',
          title: 'Profile updated',
          dedupeKey: 'user-updated',
          dedupeStrategy: 'coalesce',
        });
        break;
      // TOKEN_REFRESHED, INITIAL_SESSION, MFA_* → intentionally silent.
      default:
        break;
    }
  }, [lastAuthEvent, ready, notify]);
}
