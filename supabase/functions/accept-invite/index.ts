// accept-invite — turn a one-time invitation token into project membership.
//
// Flow:
//   1. Auto JWT verification.
//   2. Body: { token }.
//   3. Service-role lookup of the invitation (clients can't SELECT
//      invitations directly per RLS).
//   4. Email match check (case-insensitive) — invitation.email must match
//      the JWT user's email or we 403. Prevents a leaked token from being
//      redeemed by an unintended account.
//   5. Atomic accept via public.accept_invitation(token, user_id) RPC —
//      inserts into project_members and sets accepted_at = now() in one
//      transaction. The RPC raises sqlstate-coded errors that we map to
//      distinct HTTP statuses.
//
// Body returns: { ok: true, project_id }.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined CORS helpers — kept identical across send-invite / accept-invite /
// revoke-invite. See send-invite/index.ts for the rationale.
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
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const token = body.token?.trim();
  if (!token) return jsonResponse({ error: "missing_token" }, 400);

  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: "unauthenticated" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Pre-check the email match so we reject mismatched users *before* the RPC
  // takes a row lock. Returns 403 (not 404) on email mismatch to discourage
  // token-enumeration probing — if you can find a token AND match its email,
  // you can accept it; otherwise you can't tell the two failures apart.
  const { data: inv, error: invErr } = await admin
    .from("project_invitations")
    .select("email")
    .eq("token", token)
    .maybeSingle();
  if (invErr) return jsonResponse({ error: "lookup_failed", detail: invErr.message }, 500);
  if (!inv) return jsonResponse({ error: "invitation_not_found" }, 404);

  const inviteEmail = (inv.email ?? "").toLowerCase();
  const callerEmail = (user.email ?? "").toLowerCase();
  if (!callerEmail || inviteEmail !== callerEmail) {
    return jsonResponse({ error: "email_mismatch" }, 403);
  }

  // Atomic accept. Maps PG sqlstate → HTTP:
  //   P0001 invitation_not_found → 404 (race: deleted between pre-check and RPC)
  //   P0002 already_accepted     → 409
  //   P0003 expired              → 410
  const { data: project_id, error: acceptErr } = await admin.rpc("accept_invitation", {
    p_token: token,
    p_user_id: user.id,
  });
  if (acceptErr) {
    const msg = acceptErr.message || "";
    if (msg.includes("invitation_not_found")) return jsonResponse({ error: "invitation_not_found" }, 404);
    if (msg.includes("already_accepted"))     return jsonResponse({ error: "already_accepted" }, 409);
    if (msg.includes("expired"))              return jsonResponse({ error: "expired" }, 410);
    return jsonResponse({ error: "accept_failed", detail: msg }, 500);
  }

  return jsonResponse({ ok: true, project_id });
});
