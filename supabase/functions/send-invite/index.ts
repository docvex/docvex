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

// HTTPS bouncer URL that Gmail (and every other email client) WILL
// linkify, unlike the bare docvex:// scheme. The page at this URL reads
// the ?token=… query string and immediately runs
// `location.replace('docvex://invite?token=…')` to hand off to the
// desktop app. Source lives in this repo at docs/invite.html.
//
// Default is docvex.ro — the canonical custom domain configured via
// docs/CNAME on the GitHub Pages site. If DNS isn't propagated yet,
// override via the INVITE_BOUNCER_URL env var in Supabase Edge Function
// secrets (e.g. https://petreluca1105-dotcom.github.io/docvex/invite.html
// while waiting on registrar) — emails will use whichever the env var
// returns. Remove the override once docvex.ro resolves.
const INVITE_BOUNCER_URL = Deno.env.get("INVITE_BOUNCER_URL")
  ?? "https://docvex.ro/invite.html";

// RFC-5322-ish basic check — anything that passes here goes to Resend for
// the real validation. We deliberately don't try to be perfect; we just
// want to reject obvious junk before consuming an RPC.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VALID_ROLES = new Set(["admin", "member", "viewer"]);

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  let body: { project_id?: string; email?: string; role?: string; custom_role_id?: string | null };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const project_id = body.project_id?.trim();
  const email = body.email?.toLowerCase().trim();
  const role = body.role?.toLowerCase().trim() ?? "member";
  // custom_role_id is optional — when present, the invitation persists it
  // and accept_invitation() copies it onto the new project_members row.
  const custom_role_id = body.custom_role_id?.trim() || null;

  if (!project_id) return jsonResponse({ error: "missing_project_id" }, 400);
  if (!email || !EMAIL_RE.test(email)) return jsonResponse({ error: "invalid_email" }, 400);
  if (!VALID_ROLES.has(role)) return jsonResponse({ error: "invalid_role" }, 400);

  // Caller-context client for the capability check (RLS sees auth.uid()).
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: "unauthenticated" }, 401);

  // Capability-aware check (migration 008): a base-Member custom role with
  // members.invite granted ALSO passes. Falls back to admin tier for
  // ordinary admins/owners. has_capability returns false for non-members
  // of the project, so this also handles "unauthenticated for this project".
  const { data: canInvite, error: capErr } = await callerClient.rpc("has_capability", {
    p_project_id: project_id,
    p_capability: "members.invite",
  });
  if (capErr) return jsonResponse({ error: "role_check_failed", detail: capErr.message }, 500);
  if (!canInvite) return jsonResponse({ error: "forbidden" }, 403);

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
    .select("id, token, role, custom_role_id, expires_at, accepted_at")
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
    // If the admin tried to invite at a different role/custom_role_id,
    // update it in place. We compare BOTH so re-inviting the same email
    // at a different custom role replaces the assignment correctly.
    if (existing.role !== role || (existing.custom_role_id ?? null) !== custom_role_id) {
      await admin
        .from("project_invitations")
        .update({ role, custom_role_id })
        .eq("id", existing.id);
      inviteRole = role;
    }
  } else {
    const { data: inserted, error: insErr } = await admin
      .from("project_invitations")
      .insert({ project_id, email, role, custom_role_id, invited_by: user.id })
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

  // Single URL in the email: the https bouncer page. The bouncer itself
  // tries the docvex:// custom protocol first, falls back to the web app
  // (docvex.ro/app/invite/<token>) if the OS doesn't dispatch within
  // ~1.5s. This means one link works for desktop users (protocol
  // handoff) AND web users (graceful fallback) without the email
  // needing two CTAs.
  const bouncerLink = `${INVITE_BOUNCER_URL}?token=${token}`;
  const subject = `${inviterName} invited you to ${projectName}`;
  const text =
    `${inviterName} (${inviterEmail}) invited you to join "${projectName}" on Docvex as a ${inviteRole}.\n\n` +
    `Accept the invitation:\n${bouncerLink}\n\n` +
    `The link opens the Docvex desktop app if you have it installed, or the web app otherwise.\n\n` +
    `Don't have Docvex installed yet? Get it from https://docvex.ro\n\n` +
    `This invitation expires in 7 days.`;
  const html =
    `<p><strong>${inviterName}</strong> (${inviterEmail}) invited you to join ` +
    `<strong>${projectName}</strong> on Docvex as a <code>${inviteRole}</code>.</p>` +
    `<p style="margin:24px 0">` +
      `<a href="${bouncerLink}" ` +
        `style="display:inline-block;background:#6366f1;color:#fff;padding:10px 20px;` +
        `border-radius:6px;text-decoration:none;font-weight:500;font-family:Arial,sans-serif">` +
        `Accept invitation` +
      `</a>` +
    `</p>` +
    `<p style="color:#666;font-size:0.85em">` +
      `If the button above doesn't work, open ` +
      `<a href="${bouncerLink}">${bouncerLink}</a> ` +
      `in your browser — it'll open the desktop app if you have it installed, or the web app otherwise.` +
    `</p>` +
    `<p style="color:#888;font-size:0.8em;margin-top:24px;padding-top:16px;border-top:1px solid #eee">` +
      `Don't have Docvex yet? <a href="https://docvex.ro">Download for Windows</a>. ` +
      `This invitation expires in 7 days.` +
    `</p>`;

  // Email-send result is reported back to the renderer alongside `ok: true`
  // so the admin sees WHY a real email didn't arrive even though the row
  // was created (Resend 403 on an unverified sender domain, missing API
  // key, transient network failure, …). The invitation row itself is the
  // source of truth — the admin can copy the link from the Pending list
  // and DM it manually until Resend is configured.
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
          // Friendly display name materially reduces spam-folder rate vs.
          // a bare address. Gmail and Outlook both weight presence of a
          // display name as a legitimacy signal.
          from: "Docvex <invites@docvex.ro>",
          to: [email],
          // Reply-To set to the inviter's address so a recipient asking
          // "wait, who is this?" reaches a real human. Also a positive
          // deliverability signal — robotic from/reply-to combos are
          // disproportionately spammy. We only include it when we have an
          // email (every Supabase auth user does; defensive ?? still).
          reply_to: inviterEmail ?? undefined,
          subject,
          text,
          html,
        }),
      });
      resend_status = resendResp.status;
      if (!resendResp.ok) {
        email_status = 'rejected';
        // Resend returns JSON like { name: "...", message: "..." }; pass
        // the raw body through so the dev sees the actual reason
        // ("Domain not verified", "API key invalid", etc.).
        email_error = (await resendResp.text()).slice(0, 500);
        console.warn("[send-invite] resend rejected", resendResp.status, email_error);
      }
    } catch (err) {
      email_status = 'failed';
      email_error = String((err as Error)?.message ?? err).slice(0, 500);
      console.warn("[send-invite] resend fetch failed", err);
    }
  } else {
    email_status = 'skipped_no_key';
    email_error = 'RESEND_API_KEY not set in Edge Function secrets';
    console.warn("[send-invite] RESEND_API_KEY not set — skipping email send");
  }

  return jsonResponse({ ok: true, invitation_id, email_status, email_error, resend_status });
});
