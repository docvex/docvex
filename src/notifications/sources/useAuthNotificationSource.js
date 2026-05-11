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
 * Timing: fires "Signed in as …" once per process lifetime per signed-in user,
 * INCLUDING on fresh app launch with a cached session. supabase-js emits
 * `INITIAL_SESSION` on cold start (modern builds) or `SIGNED_IN` with a
 * restored session (older builds) — we treat both as "first observation of
 * this user" and toast. Subsequent SIGNED_IN events for the SAME user.id
 * (e.g. visibility-driven token refreshes when the window regains focus from
 * being minimized) are deduped via `lastSignedInUserRef`, so the toast doesn't
 * re-fire on every focus change. SIGNED_OUT clears the ref, arming the next
 * sign-in (same user or different) to toast again.
 *
 * Events handled:
 *   INITIAL_SESSION (with session)  → success toast, once per process+user
 *   SIGNED_IN                       → success toast, once per process+user
 *   SIGNED_OUT                      → info toast, clears the dedupe ref
 *   USER_UPDATED                    → info toast, coalesce dedupe to suppress refresh bursts
 *
 * @param {(payload: object) => string} notify  — provider's notify()
 * @param {{ ready: boolean }} [opts]            — gate so hooks don't fire before hydration
 */
export function useAuthNotificationSource(notify, { ready = true } = {}) {
  const { lastAuthEvent } = useAuth();
  // Tracks which user.id we've already toasted "Signed in as …" for in this
  // process. Cleared on SIGNED_OUT so re-signing-in (same user or different)
  // re-arms the toast. This is the SOLE gate against duplicate sign-in toasts;
  // there's no blind "skip first event" anymore.
  const lastSignedInUserRef = useRef(null);

  useEffect(() => {
    if (!ready) return;
    if (!lastAuthEvent) return;

    const { event, session } = lastAuthEvent;
    switch (event) {
      case 'INITIAL_SESSION':
      case 'SIGNED_IN': {
        // INITIAL_SESSION fires with session=null when there's no cached
        // session — that's just "I checked, you're not signed in", not a
        // sign-in event. Skip it.
        if (!session?.user?.id) break;
        if (lastSignedInUserRef.current === session.user.id) break;
        lastSignedInUserRef.current = session.user.id;
        notify({
          category: 'auth',
          variant: 'success',
          title: `Signed in as ${displayName(session.user)}`,
          dedupeKey: 'auth-signin',
          dedupeStrategy: 'replace',
        });
        break;
      }
      case 'SIGNED_OUT':
        lastSignedInUserRef.current = null;
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
      // TOKEN_REFRESHED, MFA_* → intentionally silent.
      default:
        break;
    }
  }, [lastAuthEvent, ready, notify]);
}
