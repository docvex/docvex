// newsletter — the website's newsletter sign-up, with double opt-in.
//
// Public (verify_jwt = false): the footer form on docvex.ro calls it with no
// account. Actions:
//   subscribe   { email, source? }  → a PENDING row + a confirmation email.
//                                     Nothing else is ever sent to the address
//                                     until the link in that email is followed
//                                     (Legea 506/2004 art. 12; GDPR art. 7(1) —
//                                     the confirmation is the proof of consent).
//   confirm     { token }           → pending → confirmed (link valid 7 days).
//   unsubscribe { token }           → the row is deleted. The token is in every
//                                     email, so leaving takes one click.
//
// The answer to `subscribe` is the same whether the address was new, pending
// or already confirmed, so the form can't be used to find out who reads the
// newsletter. A pending address is re-sent its email at most every 10 minutes.
// Unconfirmed rows are deleted by run_retention_cleanup after 7 days
// (migration 044).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { APP_URL, newsletterConfirmEmail } from "../_shared/emailTemplates.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

// What the subscriber agreed to — stored with the row as the record of consent.
const CONSENT_TEXT =
  "Legal updates, summarized for your practice, sent weekly by email. Unsubscribe with the link in any email.";
const RESEND_EVERY_MS = 10 * 60 * 1000;
const CONFIRM_DAYS = 7;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

async function sendConfirm(email: string, confirmToken: string, unsubscribeToken: string) {
  if (!RESEND_API_KEY) {
    console.warn("[newsletter] RESEND_API_KEY not set — confirmation not sent");
    return false;
  }
  const { subject, html, text } = newsletterConfirmEmail({
    confirmUrl: `${APP_URL}/newsletter.html?confirm=${confirmToken}`,
    unsubscribeUrl: `${APP_URL}/newsletter.html?unsubscribe=${unsubscribeToken}`,
  });
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Docvex <newsletter@docvex.ro>", to: [email], subject, html, text }),
    });
    if (!r.ok) console.warn("[newsletter] resend rejected", r.status);
    return r.ok;
  } catch (err) {
    console.warn("[newsletter] resend failed", String((err as Error)?.message ?? err).slice(0, 200));
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const action = String(body.action || "");

  if (action === "subscribe") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "bad_email" }, 400);
    const source = String(body.source || "website").slice(0, 40);
    const { data: row } = await db.from("newsletter_subscribers")
      .select("id,status,last_sent_at,unsubscribe_token").eq("email", email).maybeSingle();
    if (row?.status === "confirmed") return json({ ok: true, pending: true });
    if (row?.last_sent_at && Date.now() - new Date(row.last_sent_at).getTime() < RESEND_EVERY_MS) {
      return json({ ok: true, pending: true });
    }
    const confirmToken = newToken();
    const unsubscribeToken = row?.unsubscribe_token || newToken();
    const now = new Date().toISOString();
    const fields = {
      email, status: "pending", confirm_hash: await sha256(confirmToken),
      unsubscribe_token: unsubscribeToken, consent_text: CONSENT_TEXT, consent_source: source,
      requested_at: now, last_sent_at: now,
    };
    const { error } = row
      ? await db.from("newsletter_subscribers").update(fields).eq("id", row.id)
      : await db.from("newsletter_subscribers").insert(fields);
    if (error) return json({ ok: false, error: "store_failed" }, 500);
    const sent = await sendConfirm(email, confirmToken, unsubscribeToken);
    return json({ ok: true, pending: true, sent });
  }

  const token = String(body.token || "");
  if (!TOKEN_RE.test(token)) return json({ ok: false, error: "bad_token" }, 400);

  if (action === "confirm") {
    const { data: row } = await db.from("newsletter_subscribers")
      .select("id,status,requested_at").eq("confirm_hash", await sha256(token)).maybeSingle();
    if (!row) return json({ ok: false, error: "unknown" }, 404);
    if (row.status !== "confirmed") {
      if (Date.now() - new Date(row.requested_at).getTime() > CONFIRM_DAYS * 24 * 3600 * 1000) {
        return json({ ok: false, error: "expired" }, 410);
      }
      await db.from("newsletter_subscribers")
        .update({ status: "confirmed", confirmed_at: new Date().toISOString() }).eq("id", row.id);
    }
    return json({ ok: true });
  }

  if (action === "unsubscribe") {
    await db.from("newsletter_subscribers").delete().eq("unsubscribe_token", token);
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
