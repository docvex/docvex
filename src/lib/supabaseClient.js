import { createClient } from '@supabase/supabase-js';

// Build-time constant set by .env / .env.web. The web build sets
// VITE_TARGET=web; the Electron build leaves it undefined (or 'electron').
// Vite inlines the comparison at build time, so the resulting bundle
// contains only the branch that applies.
const IS_WEB = import.meta.env.VITE_TARGET === 'web';

// A short, unique-per-call suffix for Realtime channel topics. Supabase
// rejects a duplicate-topic subscribe on the same client, and split view can
// mount two subscribers for the same project at once (the primary pane and a
// secondary pane viewing the same project / chat). Appending this keeps each
// subscription's channel name distinct.
export function realtimeSuffix() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      // PKCE returns `?code=...` to the redirect URL; the renderer exchanges it
      // for a session. Avoids the implicit flow's `#access_token=...` fragment,
      // which is awkward to parse from a custom-scheme callback.
      flowType: 'pkce',
      // Electron: the callback is a docvex:// URL the renderer never sees in
      //   window.location — AuthContext drives exchangeCodeForSession itself
      //   after the deep-link handler fires.
      // Web: the callback IS the URL the browser navigates to
      //   (/app/auth/callback?code=…), so let supabase-js auto-detect and
      //   exchange it before any React effect runs.
      detectSessionInUrl: IS_WEB,
    },
  }
);
