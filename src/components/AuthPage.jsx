import React, { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { isElectron, setAuthWindowState } from '../lib/platform';
import { useAuthFlow } from './auth/useAuthFlow';
import AuthCabinet from './auth/AuthCabinet';
import CursorSpotlight from './CursorSpotlight';
import './AuthPage.css';
import './auth/authCabinet.css';

// One-shot read of the prefill credentials written by AuthContext when the
// user triggered the "Switch to <email>" menu item. Done eagerly during the
// initial render (via useState's init fn) so we never miss them; the storage
// keys are cleared immediately so a manual reload or a sign-out-and-back-in
// doesn't replay stale values. `password` is '' when the menu item only
// carried an email.
function consumePrefillCreds() {
  try {
    const email = sessionStorage.getItem('docvex.prefillEmail') || '';
    const password = sessionStorage.getItem('docvex.prefillPassword') || '';
    if (email) sessionStorage.removeItem('docvex.prefillEmail');
    if (password) sessionStorage.removeItem('docvex.prefillPassword');
    return { email, password };
  } catch {
    return { email: '', password: '' };
  }
}

// The logged-out screen — "The Cabinet" treatment from the "Auth Screens"
// design handoff: split brand panel beside the sign-in / 3-step onboarding form.
export default function AuthPage() {
  const { session } = useAuth();
  // useState init fn runs once on mount, so the storage read + clear happens
  // in the same tick the page first renders.
  const [prefilled] = useState(consumePrefillCreds);
  const flow = useAuthFlow(prefilled);

  // Latest session, reachable from the unmount cleanup without re-running the
  // effect on every auth event.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // The signed-out screen pins the window to the default app size and disables
  // resizing. On leaving: if a session now exists the user just signed in →
  // restore resizing and fill the screen; otherwise they navigated back to a
  // public page → just restore resizing. No-op on web.
  useEffect(() => {
    if (!isElectron) return undefined;
    setAuthWindowState('locked');
    return () => setAuthWindowState(sessionRef.current ? 'app' : 'unlock');
  }, []);

  // Once AuthContext has a session (email sign-in resolves, or the OAuth
  // callback completes exchangeCodeForSession), bounce out of /auth onto the
  // Hub — the app's default landing (matches the cold-launch route).
  if (session) {
    return <Navigate to="/projects" replace />;
  }

  return (
    <div className="auth-page">
      {/* Ambient dot grid (.auth-page::before) + this cursor-following spotlight
          — the same backdrop the main app shell paints, shown through the
          Cabinet's transparent form side. */}
      <CursorSpotlight />
      <AuthCabinet flow={flow} />
    </div>
  );
}
