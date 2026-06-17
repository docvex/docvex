// Shared Supabase client for the marketing site's standalone auth.
// The publishable (anon) key is meant to be public — it only grants the
// access that Row-Level Security allows. Same project as the app, so accounts
// created here are the same accounts used in the app.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = 'https://pntxlvhkqfryyyxlqytr.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_2JXDUwP4MFAk9t78UELKpA_99CImHfW';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    flowType: 'pkce',          // OAuth returns ?code=…; exchanged on load
    detectSessionInUrl: true,  // auto-exchange the OAuth code when we land back here
    persistSession: true,
    autoRefreshToken: true,
    // Default storage key is sb-<ref>-auth-token — same as the app, so a session
    // created on the site is visible to the app when served from the same origin.
  },
});
