// send-support-report — signed-in user files a bug report.
//
// Flow:
//   1. Auto JWT verification (verify_jwt = true at deploy time).
//   2. Body: { subject, description, attachments[], metadata }. Description
//      required; attachments capped at 25 MB total and ≤10 files.
//   3. Forward as a Resend email to customersupport@docvex.ro with the
//      user's auth email set as Reply-To so the support team can hit
//      Reply and land directly in the user's inbox.
//
// No DB writes — the support inbox is the source of truth. No role
// check — any signed-in user can submit (gating happens client-side
// in Sidebar.jsx, which hides the button when there's no session).
//
// Body returns: { ok: true, email_id, email_status, email_error, resend_status }.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined CORS helpers — same shape as send-invite.
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

// Hard cap on attachment payload — matches the client-side cap in
// ReportProblemModal so the user sees an immediate "too large" error
// before the upload even starts. Defence in depth: this guard fires if
// the client cap is ever bypassed (modified client, replay, etc.).
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_ATTACHMENT_COUNT = 10;

// HTML escaper for any user-provided string we drop into the email body
// (description, subject, user-agent, URL). Resend renders HTML as-is —
// without escaping, a malicious user could send themselves an email
// that includes attacker-styled content. The support team only ever
// reads these in their inbox client, but treating them like trusted
// HTML would be a bad habit.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Approximate the raw byte count from base64 length. Each 4 chars of
// base64 = 3 bytes, minus padding (`=` chars at the end). Cheap and
// exact for our purposes — we just need a server-side guard.
function base64ByteLength(b64: string): number {
  if (!b64) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

// Strip characters that would unbalance an RFC 5322 From header or
// allow header injection (CR/LF). The display name is wrapped in
// double-quotes in the From line below, so we don't need to escape
// every special — just the ones that break out of the quoted-string
// (quotes and backslashes) plus line terminators. Bounded length so
// a pathologically-long user_metadata.full_name can't blow up the
// header.
function sanitizeDisplayName(s: string): string {
  return s
    .replace(/["<>\\]/g, "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 200)
    .trim();
}

type Attachment = {
  filename?: string;
  content_type?: string;
  content_base64?: string;
};

type Metadata = {
  app_version?: string;
  platform?: string;
  user_agent?: string;
  url?: string;
  submitted_at?: string;
};

type Payload = {
  subject?: string | null;
  description?: string;
  attachments?: Attachment[];
  metadata?: Metadata;
};

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  let body: Payload;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const description = (body.description ?? "").trim();
  if (!description) return jsonResponse({ error: "missing_description" }, 400);

  const subject = (body.subject ?? "").trim();
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const metadata: Metadata = body.metadata ?? {};

  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    return jsonResponse(
      { error: "too_many_attachments", detail: `max ${MAX_ATTACHMENT_COUNT} attachments` },
      413,
    );
  }

  // Sum the decoded byte sizes of every attachment for the size guard.
  let totalBytes = 0;
  for (const a of attachments) {
    totalBytes += base64ByteLength(a.content_base64 ?? "");
  }
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    const mb = (totalBytes / 1024 / 1024).toFixed(1);
    return jsonResponse(
      {
        error: "attachments_too_large",
        detail: `total ${mb} MB exceeds ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB cap`,
      },
      413,
    );
  }

  // Resolve the caller via their JWT — needed for the Reply-To header
  // and for the support team to know which user filed the report.
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: "unauthenticated" }, 401);

  const userEmail = user.email ?? "unknown@docvex.ro";
  const userName =
    (user.user_metadata as Record<string, unknown> | null)?.full_name as string
    ?? (user.user_metadata as Record<string, unknown> | null)?.name as string
    ?? userEmail;

  // Build the From display so the support inbox shows the actual user
  // at a glance. The envelope address stays at support@support.docvex.ro
  // — Resend's verified sender domain. We can't put the user's literal
  // email in the From's <address> part: Resend would reject the
  // request (domain not verified) and even if it didn't, receiving
  // providers (Gmail, Outlook) would mark it as spoofing because the
  // SPF/DKIM signatures wouldn't align with the From domain.
  //
  // The display name MUST NOT contain a second email address (the
  // `Name (other@email.com)` pattern). Gmail / Google Workspace flag
  // that as a phishing spoof pattern and respond with a vague 4xx
  // ("Generic Temporary Delivery Failure" in Resend's dashboard) even
  // though DKIM passes — the heuristic is content-based, not auth-
  // based. Instead we tag the display name with "via Docvex" so the
  // support team still sees who reported it, and rely on the
  // `reply_to` header + the body's "From: ... <email>" line for the
  // actual address.
  const safeName = sanitizeDisplayName(userName);
  const safeEmail = sanitizeDisplayName(userEmail);
  const fromDisplay =
    safeName && safeName !== safeEmail
      ? `${safeName} via Docvex`
      : "Docvex bug report";

  // Subject: user-provided when set, else auto-generated. Keep it short
  // and scannable for the support team's inbox. Avoid embedding the
  // reporter's email here — same anti-spoofing heuristic as the From
  // line above; the user's email is already in the body's "From:" line
  // and the Reply-To header, so the support team can still reach them.
  const finalSubject = subject || (safeName ? `Bug report from ${safeName}` : "Docvex bug report");

  // Plain-text body — first thing email clients fall back to when they
  // can't render HTML, and the only thing some triage tools index.
  const text =
    `Docvex bug report\n\n` +
    `From: ${userName} <${userEmail}>\n` +
    `User ID: ${user.id}\n\n` +
    `── Description ─────────────────────\n` +
    `${description}\n\n` +
    `── Context ─────────────────────────\n` +
    `App version: ${metadata.app_version ?? "unknown"}\n` +
    `Platform: ${metadata.platform ?? "unknown"}\n` +
    `URL / route: ${metadata.url ?? "unknown"}\n` +
    `User-Agent: ${metadata.user_agent ?? "unknown"}\n` +
    `Submitted: ${metadata.submitted_at ?? new Date().toISOString()}\n\n` +
    `Attachments: ${attachments.length} file(s).\n` +
    `Reply to this email to reach the user directly.`;

  // HTML body — same content, prettier rendering. All user-provided
  // strings escaped via esc(). The metadata block uses a muted color
  // so the description (the part the support team should read first)
  // stays prominent.
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:640px">` +
      `<h2 style="margin:0 0 16px;font-size:18px">Docvex bug report</h2>` +
      `<p style="margin:0 0 4px"><strong>From:</strong> ${esc(userName)} &lt;${esc(userEmail)}&gt;</p>` +
      `<p style="margin:0 0 16px;color:#666;font-size:0.9em"><strong>User ID:</strong> <code>${esc(user.id)}</code></p>` +
      `<h3 style="margin:24px 0 8px;font-size:15px">Description</h3>` +
      `<div style="background:#f7f7f8;border:1px solid #e5e5e7;border-radius:6px;padding:12px;white-space:pre-wrap;font-size:14px;line-height:1.5">${esc(description)}</div>` +
      `<h3 style="margin:24px 0 8px;font-size:15px;color:#666">Context</h3>` +
      `<table style="font-size:0.85em;color:#555;border-collapse:collapse">` +
        `<tr><td style="padding:2px 12px 2px 0">App version</td><td><code>${esc(metadata.app_version ?? "unknown")}</code></td></tr>` +
        `<tr><td style="padding:2px 12px 2px 0">Platform</td><td><code>${esc(metadata.platform ?? "unknown")}</code></td></tr>` +
        `<tr><td style="padding:2px 12px 2px 0">URL / route</td><td><code>${esc(metadata.url ?? "unknown")}</code></td></tr>` +
        `<tr><td style="padding:2px 12px 2px 0">User-Agent</td><td style="word-break:break-all"><code>${esc(metadata.user_agent ?? "unknown")}</code></td></tr>` +
        `<tr><td style="padding:2px 12px 2px 0">Submitted</td><td><code>${esc(metadata.submitted_at ?? new Date().toISOString())}</code></td></tr>` +
      `</table>` +
      `<p style="margin:24px 0 0;color:#666;font-size:0.85em">` +
        `${attachments.length} file(s) attached. Reply to this email to reach the user directly.` +
      `</p>` +
    `</div>`;

  // Resend's attachments format expects `{ filename, content (base64), content_type }`.
  // Our payload shape uses `content_base64` to avoid colliding with the
  // word "content" elsewhere in the request — renaming here.
  const resendAttachments = attachments.map((a) => ({
    filename: a.filename ?? "attachment",
    content: a.content_base64 ?? "",
    content_type: a.content_type ?? "application/octet-stream",
  }));

  // Email-send result is reported back to the caller alongside `ok: true`
  // so the modal can surface the actual failure reason ("Domain not
  // verified") instead of a generic error.
  let email_status: "sent" | "skipped_no_key" | "rejected" | "failed" = "sent";
  let email_error: string | null = null;
  let resend_status: number | null = null;
  let email_id: string | null = null;

  if (!RESEND_API_KEY) {
    email_status = "skipped_no_key";
    email_error = "RESEND_API_KEY not set in Edge Function secrets";
    console.warn("[send-support-report] RESEND_API_KEY not set — skipping email send");
    return jsonResponse({
      ok: false,
      error: "email_not_configured",
      detail: email_error,
      email_status,
    }, 500);
  }

  try {
    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Envelope address stays on a Resend-verified domain. We send
        // from `support.docvex.ro` (a dedicated transactional subdomain)
        // rather than the root `docvex.ro` so this stream has its own
        // sending reputation — large attachments / automated content
        // can't drag down reputation for the invite stream or any
        // future marketing mail. The display name is the user's name +
        // email so the inbox list view shows who filed the report at a
        // glance. See the `fromDisplay` comment above for the why.
        from: `"${fromDisplay}" <support@support.docvex.ro>`,
        to: ["customersupport@docvex.ro"],
        // Reply-To set to the reporter so the support team can hit Reply
        // and land in the user's inbox. Without this, replies bounce
        // around the support@ address with no end user attached.
        reply_to: userEmail,
        subject: finalSubject,
        text,
        html,
        attachments: resendAttachments,
      }),
    });
    resend_status = resendResp.status;
    if (!resendResp.ok) {
      email_status = "rejected";
      email_error = (await resendResp.text()).slice(0, 500);
      console.warn("[send-support-report] resend rejected", resendResp.status, email_error);
      return jsonResponse(
        { ok: false, error: "resend_rejected", detail: email_error, resend_status },
        502,
      );
    }
    try {
      const data = await resendResp.json();
      email_id = (data?.id as string) ?? null;
    } catch { /* non-JSON body — leave email_id null */ }
  } catch (err) {
    email_status = "failed";
    email_error = String((err as Error)?.message ?? err).slice(0, 500);
    console.warn("[send-support-report] resend fetch failed", err);
    return jsonResponse(
      { ok: false, error: "resend_fetch_failed", detail: email_error },
      502,
    );
  }

  return jsonResponse({ ok: true, email_id, email_status, email_error, resend_status });
});
