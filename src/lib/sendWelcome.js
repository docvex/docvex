// Client wrapper for the `send-welcome` Edge Function. Same `{ data,
// error }` shape as the other Edge Function wrappers in this directory
// (sendInvite / sendSupportReport) so callers handle errors uniformly.
//
// Idempotency lives in the CALLER (see AuthContext): we only invoke
// this on the first sign-in where `user.user_metadata.welcome_email_sent`
// is missing/falsy, and write the flag after a successful send. The
// Edge Function itself sends unconditionally so the DEBUG menu's
// "Send all email previews" item can re-trigger it for visual checks.

import { supabase } from './supabaseClient';

// sendWelcomeEmail({ debug? })
//   debug: optional. Same flag the function accepts in body; reserved
//          for future symmetry with sendInviteDebug / sendSupportReport.
//          Currently the function ignores `debug` because it ALWAYS
//          sends to the caller's own JWT email — there's no different
//          behaviour to gate on. Accepted as a parameter so the call
//          site in AppShell.jsx reads consistently with the other two
//          debug invocations.
export async function sendWelcomeEmail({ debug } = {}) {
  const { data, error } = await supabase.functions.invoke('send-welcome', {
    body: debug ? { debug: true } : {},
  });

  if (error) return { data: null, error };
  if (data && data.error) return { data: null, error: new Error(data.error) };
  return { data, error: null };
}
