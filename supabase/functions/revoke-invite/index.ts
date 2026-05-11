// revoke-invite — admin deletes a pending invitation.
//
// Strictly speaking the renderer could DELETE this row through PostgREST
// under the existing "admins delete invitations" RLS policy. Routing it
// through a function keeps the public API uniform with send/accept and gives
// us one place to add audit logging later.
//
// Flow:
//   1. Auto JWT verification.
//   2. Body: { invitation_id }.
//   3. Look up the invitation's project_id with service_role (we don't trust
//      a client-supplied project_id — fetch ground truth).
//   4. Caller-context has_project_role(project_id, 'admin') check.
//   5. Delete with service_role.
//
// Body returns: { ok: true }.
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

  let body: { invitation_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const invitation_id = body.invitation_id?.trim();
  if (!invitation_id) return jsonResponse({ error: "missing_invitation_id" }, 400);

  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: "unauthenticated" }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: inv, error: lookupErr } = await admin
    .from("project_invitations")
    .select("project_id")
    .eq("id", invitation_id)
    .maybeSingle();
  if (lookupErr) return jsonResponse({ error: "lookup_failed", detail: lookupErr.message }, 500);
  if (!inv) return jsonResponse({ error: "invitation_not_found" }, 404);

  const { data: isAdmin, error: roleErr } = await callerClient.rpc("has_project_role", {
    p_project_id: inv.project_id,
    p_min_role: "admin",
  });
  if (roleErr) return jsonResponse({ error: "role_check_failed", detail: roleErr.message }, 500);
  if (!isAdmin) return jsonResponse({ error: "forbidden" }, 403);

  const { error: delErr } = await admin
    .from("project_invitations")
    .delete()
    .eq("id", invitation_id);
  if (delErr) return jsonResponse({ error: "delete_failed", detail: delErr.message }, 500);

  return jsonResponse({ ok: true });
});
