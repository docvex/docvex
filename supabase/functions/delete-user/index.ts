// delete-user — self-service "delete my account" endpoint.
//
// Flow:
//   1. Auto JWT verification (verify_jwt = true at deploy time) — only the
//      authenticated caller can trigger their own deletion.
//   2. No body. The user_id to delete is taken from the JWT's `sub` claim,
//      not from a request parameter — that way a leaked token can't be
//      misused to delete an unrelated account, and we don't need a
//      separate same-user check on top.
//   3. Service-role admin.auth.deleteUser(uid). FK cascades (project_members,
//      notifications, …) and FK set-nulls (projects.created_by,
//      project_invitations.invited_by) run as part of the delete.
//   4. Return { ok: true }. The renderer is expected to call supabase.auth
//      .signOut() and route to /auth right after — the deleted user's
//      access token is invalid from this point on anyway.
//
// Note for callers: projects the user solely owned will be orphaned
// (created_by = null, no owner-role member). That's a known consequence
// for v1; a future enhancement could refuse to delete when the user is
// the only owner of a multi-member project, or auto-promote a co-admin.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Same CORS shape as the other functions — Electron renderer origin is
// not stable enough to allowlist.
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

  // Caller-context client just to identify *who* is calling. We don't use
  // it for the delete itself — that goes through the service-role admin
  // client because deleteUser requires it.
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: "unauthenticated" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) {
    return jsonResponse({ error: "delete_failed", detail: delErr.message }, 500);
  }

  return jsonResponse({ ok: true });
});
