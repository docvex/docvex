import { createClient } from '@supabase/supabase-js';

// Build-time constant set by .env / .env.web. The web build sets
// VITE_TARGET=web; the Electron build leaves it undefined (or 'electron').
// Vite inlines the comparison at build time, so the resulting bundle
// contains only the branch that applies.
const IS_WEB = import.meta.env.VITE_TARGET === 'web';

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
