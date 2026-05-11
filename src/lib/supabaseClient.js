import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      // PKCE returns `?code=...` to the redirect URL; the renderer exchanges it
      // for a session. Avoids the implicit flow's `#access_token=...` fragment,
      // which is awkward to parse from a custom-scheme callback.
      flowType: 'pkce',
      // We hand the callback URL to the client manually via exchangeCodeForSession.
      // Don't let supabase-js try to read window.location (it's a renderer with no
      // real URL bar in Electron / MemoryRouter).
      detectSessionInUrl: false,
    },
  }
);
