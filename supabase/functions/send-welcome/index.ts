// send-welcome — sends the brand "Welcome to DocVex." email to the
// caller. Always sends to the caller's own JWT email (no `to` param
// accepted from the client to keep this from being abused as a relay).
//
// Idempotency is enforced by the renderer side: AuthContext only calls
// this function on the first sign-in where `user.user_metadata.welcome_email_sent`
// is missing/false, and writes the flag after a successful send. The
// function itself sends every time it's invoked — that's deliberate so
// the DEBUG menu's "Send all email previews" can re-trigger this to
// preview the template.
//
// Same response shape as send-invite for renderer parity:
//   { ok: true, email_status: 'sent' | 'skipped_no_key' | 'rejected' | 'failed', email_error, resend_status }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { welcomeEmail } from "../_shared/emailTemplates.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function preflight(req: Request): Response | null {
  return req.method === "OPTIONS" ? new Response("ok", { headers: corsHeaders }) : null;
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  // Caller-context client so RLS sees auth.uid() correctly when we read
  // the verified user off the JWT.
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !user || !user.email) {
    return jsonResponse({ error: "unauthenticated" }, 401);
  }

  const { subject, html, text } = welcomeEmail();

  // Same Resend-call + status-reporting shape as send-invite, so the
  // renderer can surface why an email didn't arrive (unverified domain,
  // missing API key, transient network failure) identically.
  let email_status: 'sent' | 'skipped_no_key' | 'rejected' | 'failed' = 'sent';
  let email_error: string | null = null;
  let resend_status: number | null = null;

  if (RESEND_API_KEY) {
    try {
      const resendResp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Same display-name pattern as send-invite — a friendly name
          // materially reduces spam-folder rate vs. a bare address.
          from: "Docvex <welcome@docvex.ro>",
          to: [user.email],
          subject,
          text,
          html,
        }),
      });
      resend_status = resendResp.status;
      if (!resendResp.ok) {
        email_status = 'rejected';
        email_error = (await resendResp.text()).slice(0, 500);
        console.warn("[send-welcome] resend rejected", resendResp.status, email_error);
      }
    } catch (err) {
      email_status = 'failed';
      email_error = String((err as Error)?.message ?? err).slice(0, 500);
      console.warn("[send-welcome] resend fetch failed", err);
    }
  } else {
    email_status = 'skipped_no_key';
    email_error = 'RESEND_API_KEY not set in Edge Function secrets';
    console.warn("[send-welcome] RESEND_API_KEY not set — skipping email send");
  }

  return jsonResponse({ ok: true, email_status, email_error, resend_status });
});
