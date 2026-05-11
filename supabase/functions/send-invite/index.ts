// send-invite — admin invites someone (by email) to a project.
//
// Flow:
//   1. Auto JWT verification (verify_jwt = true at deploy time).
//   2. Body: { project_id, email, role }. Email lowercased + regex-checked.
//   3. Caller must be admin on the project (has_project_role RPC under the
//      caller's JWT, so RLS context is right).
//   4. Upsert into project_invitations using the (project_id, lower(email))
//      partial unique index — returns the existing token if a pending row
//      exists, otherwise inserts a fresh one.
//   5. Send email via Resend. If Resend rejects (e.g. unverified domain),
//      log and still return ok — the invite row is the source of truth and
//      the admin can copy the link manually from the Members page.
//
// Body returns: { ok: true, invitation_id }.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined CORS helpers — kept identical across send-invite / accept-invite /
// revoke-invite. Access-Control-Allow-Origin is "*" because Electron's
// renderer origin (file:// in packaged builds, vite-dev-server URL in dev)
// isn't stable enough to allowlist.
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
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

// RFC-5322-ish basic check — anything that passes here goes to Resend for
// the real validation. We deliberately don't try to be perfect; we just
// want to reject obvious junk before consuming an RPC.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VALID_ROLES = new Set(["admin", "member", "viewer"]);

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  let body: { project_id?: string; email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const project_id = body.project_id?.trim();
  const email = body.email?.toLowerCase().trim();
  const role = body.role?.toLowerCase().trim() ?? "member";

  if (!project_id) return jsonResponse({ error: "missing_project_id" }, 400);
  if (!email || !EMAIL_RE.test(email)) return jsonResponse({ error: "invalid_email" }, 400);
  if (!VALID_ROLES.has(role)) return jsonResponse({ error: "invalid_role" }, 400);

  // Caller-context client for the admin check (RLS sees auth.uid()).
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: "unauthenticated" }, 401);

  const { data: isAdmin, error: roleErr } = await callerClient.rpc("has_project_role", {
    p_project_id: project_id,
    p_min_role: "admin",
  });
  if (roleErr) return jsonResponse({ error: "role_check_failed", detail: roleErr.message }, 500);
  if (!isAdmin) return jsonResponse({ error: "forbidden" }, 403);

  // Service-role client for the upsert (bypasses RLS so we can read the
  // existing row's token even if the partial-unique conflict path doesn't
  // return data on its own).
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // First look up an existing pending invitation for (project, lower(email)).
  // If found, reuse it. Otherwise insert fresh.
  const { data: existing, error: existErr } = await admin
    .from("project_invitations")
    .select("id, token, role, expires_at, accepted_at")
    .eq("project_id", project_id)
    .ilike("email", email)
    .is("accepted_at", null)
    .maybeSingle();
  if (existErr) return jsonResponse({ error: "lookup_failed", detail: existErr.message }, 500);

  let invitation_id: string;
  let token: string;
  let inviteRole: string = role;

  if (existing) {
    invitation_id = existing.id;
    token = existing.token;
    inviteRole = existing.role;
    // If the admin tried to invite at a different role, update it in place.
    if (existing.role !== role) {
      await admin.from("project_invitations").update({ role }).eq("id", existing.id);
      inviteRole = role;
    }
  } else {
    const { data: inserted, error: insErr } = await admin
      .from("project_invitations")
      .insert({ project_id, email, role, invited_by: user.id })
      .select("id, token")
      .single();
    if (insErr || !inserted) {
      return jsonResponse({ error: "insert_failed", detail: insErr?.message }, 500);
    }
    invitation_id = inserted.id;
    token = inserted.token;
  }

  // Need the project name + inviter's display name for the email body.
  const [projectQ, inviterEmail] = await Promise.all([
    admin.from("projects").select("name").eq("id", project_id).single(),
    Promise.resolve(user.email ?? "a teammate"),
  ]);
  const projectName = projectQ.data?.name ?? "a project";
  const inviterName =
    (user.user_metadata as Record<string, unknown> | null)?.full_name as string
    ?? (user.user_metadata as Record<string, unknown> | null)?.name as string
    ?? inviterEmail;

  const inviteLink = `docvex://invite?token=${token}`;
  const subject = `${inviterName} invited you to ${projectName}`;
  const text =
    `${inviterName} (${inviterEmail}) invited you to join "${projectName}" on Docvex as a ${inviteRole}.\n\n` +
    `Open this link in the Docvex desktop app to accept:\n${inviteLink}\n\n` +
    `If you don't have Docvex installed yet, download it first from docvex.ro.\n\n` +
    `This invitation expires in 7 days.`;
  const html =
    `<p><strong>${inviterName}</strong> (${inviterEmail}) invited you to join ` +
    `<strong>${projectName}</strong> on Docvex as a <code>${inviteRole}</code>.</p>` +
    `<p>Open this link in the Docvex desktop app to accept:</p>` +
    `<p><a href="${inviteLink}">${inviteLink}</a></p>` +
    `<p style="color:#888;font-size:0.9em">If you don't have Docvex installed yet, download it first from <a href="https://docvex.ro">docvex.ro</a>. This invitation expires in 7 days.</p>`;

  // TODO: verify the docvex.ro domain in Resend before going public — until
  // then Resend will 403 here and the email won't deliver. The invitation
  // row still exists, so the admin can copy the link from the Members page
  // and DM it. Production checklist: verify sender domain in Resend.
  if (RESEND_API_KEY) {
    try {
      const resendResp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "invites@docvex.ro",
          to: [email],
          subject,
          text,
          html,
        }),
      });
      if (!resendResp.ok) {
        const detail = await resendResp.text();
        console.warn("[send-invite] resend rejected", resendResp.status, detail);
      }
    } catch (err) {
      console.warn("[send-invite] resend fetch failed", err);
    }
  } else {
    console.warn("[send-invite] RESEND_API_KEY not set — skipping email send");
  }

  return jsonResponse({ ok: true, invitation_id });
});
