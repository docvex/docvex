import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { isElectron, authAppReady, authRequired } from '../lib/platform';

// Decides which of the two windows the user should be looking at.
//
// The app window boots HIDDEN (main.js createWindow) and stays that way until
// this reports a session. Signed in → the app window reveals itself in the size
// and mode it was last closed in. Signed out → it stays hidden and the
// dedicated sign-in window comes up in front of it. That's the whole reason the
// app window no longer shrinks itself into a login box: the two surfaces are
// two windows, not one window wearing two shapes.
//
// Renders nothing. Mounted once, in the app window only (renderer.jsx) — the
// sign-in window reports its own completion from AuthPage, and the doc viewer
// windows have no say in this at all.
// A session saved on this machine (supabase-js keeps it as
// `sb-<project>-auth-token`) with a refresh token in it.
function hasStoredSession() {
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!/^sb-.+-auth-token$/.test(k || '')) continue;
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      if (v?.refresh_token && !v?.user?.is_anonymous) return true;
    }
  } catch { /* unreadable — wait for auth as before */ }
  return false;
}

export default function AuthWindowGate() {
  const { session, loading } = useAuth();
  // Only the transitions matter. Re-sending 'app-ready' on every token refresh
  // would re-focus the window out from under whatever the user is doing.
  const lastSent = useRef(null);

  // LOAD TIME: with a session saved on this machine, show the app window at
  // once. supabase-js holds INITIAL_SESSION until an expired access token is
  // refreshed over the network — which is every morning — and the window
  // used to stay hidden for that whole round trip (seconds on a slow office
  // line). The shell shows its own loading state meanwhile. If the session
  // turns out to be revoked, the effect below sends 'auth' and the sign-in
  // window takes over, as it always did.
  useEffect(() => {
    if (!isElectron || lastSent.current) return undefined;
    if (hasStoredSession()) { lastSent.current = 'app'; authAppReady(); return undefined; }
    // The session now lives in main's encrypted store: ask there.
    let alive = true;
    window.electronAPI?.authStoreHasSession?.().then((r) => {
      if (alive && r?.has && !lastSent.current) { lastSent.current = 'app'; authAppReady(); }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!isElectron || loading) return;
    // An anonymous session is not a signed-in user (no flow creates one any
    // more); treat it as signed out, as AuthPage does.
    const signedIn = !!session && !session.user?.is_anonymous;
    const next = signedIn ? 'app' : 'auth';
    if (lastSent.current === next) return;
    lastSent.current = next;
    if (signedIn) authAppReady();
    else authRequired();
  }, [session, loading]);

  return null;
}
