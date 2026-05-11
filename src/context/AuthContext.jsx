import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { isNotificationsStorageKey } from '../lib/notifications';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  // Latest (event, session) tuple from onAuthStateChange. Consumers like the
  // notifications source-hook read this instead of subscribing to Supabase a
  // second time — one stream, one source of truth.
  // event ∈ INITIAL_SESSION | SIGNED_IN | SIGNED_OUT | TOKEN_REFRESHED | USER_UPDATED | …
  const [lastAuthEvent, setLastAuthEvent] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      // Tag with `at` so a downstream effect can detect repeated events of the
      // same name (e.g. two TOKEN_REFRESHED in a row would otherwise look like
      // a no-op via reference equality).
      setLastAuthEvent({ event, session, at: Date.now() });
    });

    const handleOAuthCallback = async (url) => {
      const parsed = new URL(url);
      const code = parsed.searchParams.get('code');
      if (code) {
        await supabase.auth.exchangeCodeForSession(code);
      }
    };

    if (window.electronAPI) {
      window.electronAPI.onOAuthCallback(handleOAuthCallback);
    }

    return () => {
      subscription.unsubscribe();
      if (window.electronAPI) {
        window.electronAPI.removeOAuthListener();
      }
    };
  }, []);

  const signInWithEmail = (email, password) =>
    supabase.auth.signInWithPassword({ email, password });

  const signUpWithEmail = (email, password) =>
    supabase.auth.signUp({ email, password });

  const signInWithGoogle = async () => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: 'docvex://auth/callback',
        skipBrowserRedirect: true,
      },
    });
    if (error) throw error;
    if (data?.url && window.electronAPI) {
      window.electronAPI.openOAuthUrl(data.url);
    }
  };

  const signOut = () => supabase.auth.signOut();

  // Revoke every refresh token for this user (all devices) and wipe any
  // supabase-persisted state from this machine. Distinct from signOut, which
  // only ends the current device's session.
  const eraseData = async () => {
    const { error } = await supabase.auth.signOut({ scope: 'global' });
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('sb-') || k.startsWith('supabase.') || isNotificationsStorageKey(k))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      /* localStorage may be unavailable in some contexts; non-fatal */
    }
    return { error };
  };

  return (
    <AuthContext.Provider value={{ session, loading, lastAuthEvent, signInWithEmail, signUpWithEmail, signInWithGoogle, signOut, eraseData }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
