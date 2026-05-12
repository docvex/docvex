import React, { createContext, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { isNotificationsStorageKey } from '../lib/notifications';
import { deleteAllForUser as deleteAllNotificationsForUser } from '../lib/notificationsRepo';
import { PENDING_INVITE_TOKEN_KEY } from '../pages/Projects/InviteAccept';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const navigate = useNavigate();
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

      // Auto-resume a pending invite-accept after the user signs in. The
      // token is stashed by InviteAccept's signed-out branch (or by the
      // email-mismatch "Sign out & switch account" path) before redirecting
      // to /auth — see PENDING_INVITE_TOKEN_KEY in InviteAccept.jsx.
      if (event === 'SIGNED_IN') {
        try {
          const pending = sessionStorage.getItem(PENDING_INVITE_TOKEN_KEY);
          if (pending) {
            sessionStorage.removeItem(PENDING_INVITE_TOKEN_KEY);
            navigate(`/invite/${pending}`, { replace: true });
          }
        } catch { /* sessionStorage may be unavailable; non-fatal */ }
      }
    });

    // The `oauth:callback-url` IPC channel was originally OAuth-only, but
    // main.js routes every docvex:// URL through it — so this is really an
    // "OS handed us a deep-link URL" handler. We branch on the URL shape:
    //   docvex://auth/callback?code=…       → OAuth code exchange
    //   docvex://invite?token=…             → navigate to /invite/<token>
    // Other shapes fall through with a console.warn — useful when adding
    // new deep-link routes (you'll see exactly what got through unhandled).
    const handleDeepLinkUrl = async (url) => {
      let parsed;
      try { parsed = new URL(url); }
      catch { return; }

      // For docvex://invite?token=… the URL parser puts "invite" in the
      // hostname (no path) and "?token=…" in the search; for docvex:// links
      // with paths like docvex://auth/callback?code=… the hostname is "auth"
      // and the pathname is "/callback". Normalising on `parsed.host` lets us
      // route either shape with the same logic.
      const host = (parsed.host || parsed.hostname || '').toLowerCase();

      if (host === 'invite') {
        const token = parsed.searchParams.get('token');
        if (token) {
          navigate(`/invite/${encodeURIComponent(token)}`);
        }
        return;
      }

      // OAuth callback (default / legacy path).
      const code = parsed.searchParams.get('code');
      if (code) {
        await supabase.auth.exchangeCodeForSession(code);
      }
    };

    let unsubscribeAccountSwitch = null;
    if (window.electronAPI) {
      window.electronAPI.onOAuthCallback(handleDeepLinkUrl);
      // Pull any docvex:// URL that arrived on the command line at COLD
      // start — the `oauth:callback-url` event fires only on subsequent
      // launches (via second-instance), so a fresh first launch with a URL
      // in argv would otherwise drop it. Safe to call when nothing is
      // pending: main returns null and this is a no-op. The handle is
      // one-shot on the main side, so a StrictMode double-mount can't
      // process the same URL twice.
      if (typeof window.electronAPI.getStartupDeepLink === 'function') {
        window.electronAPI.getStartupDeepLink().then((url) => {
          if (url) handleDeepLinkUrl(url);
        }).catch(() => { /* non-fatal — IPC may not be wired in older builds */ });
      }
      // Dev-only "Account" menu wiring. The menu item's click handler in
      // main.js sends { email, password? } here; we sign out of the current
      // session, stash the credentials so AuthPage can prefill them on the
      // next render, and hard-reload so every in-memory context (project,
      // notifications, selected project) drops its previous-user data
      // instead of leaking it into the next session.
      if (typeof window.electronAPI.onAccountSwitch === 'function') {
        unsubscribeAccountSwitch = window.electronAPI.onAccountSwitch(async (payload) => {
          // Tolerate the older string-only payload shape for forward-compat
          // during dev: { email, password } today, or just an email string
          // if someone hand-fires the IPC.
          const email = typeof payload === 'string' ? payload : payload?.email;
          const password = typeof payload === 'object' ? payload?.password : null;
          if (!email) return;
          try {
            sessionStorage.setItem('docvex.prefillEmail', email);
            if (password) {
              sessionStorage.setItem('docvex.prefillPassword', password);
            } else {
              sessionStorage.removeItem('docvex.prefillPassword');
            }
          } catch { /* private mode */ }
          // Best-effort sign-out before the reload — even if it errors
          // (offline, expired token), the reload clears in-memory state
          // and supabase-js will treat the next mount as signed-out.
          try { await supabase.auth.signOut(); } catch { /* non-fatal */ }
          window.location.reload();
        });
      }
    }

    return () => {
      subscription.unsubscribe();
      if (window.electronAPI) {
        window.electronAPI.removeOAuthListener();
      }
      if (unsubscribeAccountSwitch) unsubscribeAccountSwitch();
    };
  }, [navigate]);

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

  // Link a Google identity to the CURRENT signed-in account (vs. signing in
  // a brand-new account). Used by the "Google" pill on the Account page
  // when the user hasn't already linked Google. The OAuth round-trip uses
  // the same docvex://auth/callback handler as sign-in — the existing
  // handleDeepLinkUrl above runs exchangeCodeForSession on the returned
  // code, which Supabase resolves into the link rather than a fresh
  // session because the caller still has a valid one.
  //
  // Caveat: requires "Allow account linking" enabled in Supabase Auth
  // settings (Dashboard → Authentication → Sign In / Up → Manual Linking).
  // Without it the call returns a "Manual linking is disabled" error.
  const linkGoogle = async () => {
    const { data, error } = await supabase.auth.linkIdentity({
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

  // Permanently delete the user's account (auth.users row + cascade-linked
  // data — project memberships, notifications). Goes through the
  // `delete-user` Edge Function because admin.auth.deleteUser requires the
  // service-role key, which the renderer must never see. On success we
  // also call signOut to flush the (now-invalid) local session; the
  // caller is responsible for navigating away from authenticated screens.
  //
  // Returns { error: null } on success or { error } from either the
  // function call or the local sign-out leg. On a non-2xx from the
  // function, we try to parse `{ error, detail }` out of the response body
  // so the caller's toast shows the actual reason ("delete_failed:
  // foreign key violation on …") instead of supabase-js's generic
  // "Edge Function returned a non-2xx status code" message.
  const deleteAccount = async () => {
    const { data, error: invokeErr } = await supabase.functions.invoke('delete-user', { body: {} });
    if (invokeErr) {
      // FunctionsHttpError carries the response on .context — read the
      // body once and synthesize a clearer Error. Wrap in try/catch in case
      // the body is empty / non-JSON.
      try {
        const ctx = invokeErr.context;
        if (ctx && typeof ctx.json === 'function') {
          const body = await ctx.json();
          if (body && (body.error || body.detail)) {
            const msg = body.detail
              ? `${body.error || 'function_error'}: ${body.detail}`
              : body.error;
            return { error: new Error(msg) };
          }
        }
      } catch { /* fall through to the raw invoke error */ }
      return { error: invokeErr };
    }
    if (data && data.error) return { error: new Error(data.error) };
    // Best-effort sign-out — the server-side delete already invalidated
    // the token, so signOut may itself error; not fatal for the caller.
    try { await supabase.auth.signOut(); } catch { /* non-fatal */ }
    return { error: null };
  };

  // Revoke every refresh token for this user (all devices) and wipe any
  // supabase-persisted state from this machine. Distinct from signOut, which
  // only ends the current device's session. Also deletes the user's
  // notifications from Supabase — "erase" means erase, not just sign out.
  const eraseData = async () => {
    // Delete server-side rows BEFORE signOut while we still have a valid
    // session (RLS would reject the delete otherwise). Non-fatal: if the
    // network is down we still proceed with the local wipe so the user's
    // device-side state matches their intent.
    const uid = session?.user?.id;
    if (uid) {
      try { await deleteAllNotificationsForUser(uid); }
      catch { /* non-fatal — local wipe still runs */ }
    }
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
    <AuthContext.Provider value={{ session, loading, lastAuthEvent, signInWithEmail, signUpWithEmail, signInWithGoogle, linkGoogle, signOut, eraseData, deleteAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
