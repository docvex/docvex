// export-my-data — "Download my data" (GDPR Art. 15 access / Art. 20 portability).
//
// JWT-gated: the caller is read from the token, never from the body, so a user
// can only ever export their own data. Everything is filtered by that user id
// (the service role is used only because some rows — invitations received,
// phone-upload file rows — sit behind policies written for other purposes).
// Mailbox access / refresh tokens are NEVER included: they are credentials,
// not data about the person, and a leaked export must not open the mailbox.
// Returns one JSON document; the app adds what is kept only on the computer.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user }, error: userErr } = await caller.auth.getUser();
  if (userErr || !user) return json({ error: "unauthenticated" }, 401);
  const uid = user.id;
  const email = (user.email ?? "").toLowerCase();
  // An exact, case-insensitive match: `_` and `%` in an address are literal.
  const emailPattern = email.replace(/[\\%_]/g, (c) => "\\" + c);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const errors: string[] = [];
  const rows = async (label: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
    const { data, error } = await q;
    if (error) { errors.push(`${label}: ${error.message}`); return []; }
    return data ?? [];
  };

  const memberships = await rows("memberships", admin.from("project_members")
    .select("project_id, role, custom_role_id, added_at, projects(name, description, created_at)").eq("user_id", uid));
  const sessions = await rows("phone_upload_sessions", admin.from("phone_upload_sessions")
    .select("id, project_id, created_at, expires_at, closed_at, file_count, byte_count").eq("user_id", uid)) as Array<{ id: string }>;
  const sessionIds = sessions.map((s) => s.id);

  const out = {
    format: "docvex-export/v1",
    exported_at: new Date().toISOString(),
    account: {
      id: uid,
      email: user.email,
      created_at: user.created_at,
      last_sign_in_at: user.last_sign_in_at,
      providers: user.app_metadata?.providers ?? [],
      profile: user.user_metadata ?? {},
    },
    memberships,
    chat_messages_written: await rows("chat_messages", admin.from("chat_messages")
      .select("id, project_id, body, mentions, parent_id, created_at, edited_at, deleted_at, pinned_at").eq("author_id", uid)),
    chat_reactions: await rows("chat_message_reactions", admin.from("chat_message_reactions")
      .select("message_id, project_id, emoji, created_at").eq("user_id", uid)),
    private_messages_sent: await rows("private_messages_sent", admin.from("private_messages")
      .select("id, project_id, recipient_id, body, created_at, edited_at, deleted_at").eq("sender_id", uid)),
    private_messages_received: await rows("private_messages_received", admin.from("private_messages")
      .select("id, project_id, sender_id, body, created_at, edited_at, deleted_at").eq("recipient_id", uid)),
    notifications: await rows("notifications", admin.from("notifications")
      .select("id, category, variant, priority, title, body, payload, created_at, read_at").eq("user_id", uid)),
    legal_feed_states: await rows("legal_update_states", admin.from("legal_update_states")
      .select("update_id, read_at, pinned_at, saved_at, updated_at").eq("user_id", uid)),
    writing_profile: await rows("writing_profiles", admin.from("writing_profiles")
      .select("profile, sample_count, model, enabled, generated_at, updated_at").eq("user_id", uid)),
    writing_samples: await rows("writing_samples", admin.from("writing_samples")
      .select("name, doc_kind, mime_type, char_count, excerpt, created_at").eq("user_id", uid)),
    ai_usage: await rows("project_ai_usage", admin.from("project_ai_usage")
      .select("project_id, action, model, input_tokens, output_tokens, created_at").eq("user_id", uid)),
    invitations_sent: await rows("invitations_sent", admin.from("project_invitations")
      .select("project_id, email, role, created_at, expires_at, accepted_at").eq("invited_by", uid)),
    invitations_received: email ? await rows("invitations_received", admin.from("project_invitations")
      .select("project_id, role, created_at, expires_at, accepted_at").ilike("email", emailPattern)) : [],
    connected_mailboxes: await rows("user_mail_connections", admin.from("user_mail_connections")
      .select("provider, email, scope, created_at, updated_at").eq("user_id", uid)),
    phone_upload_sessions: sessions,
    phone_upload_files: sessionIds.length ? await rows("phone_upload_files", admin.from("phone_upload_files")
      .select("session_id, name, size, mime, status, created_at, decided_at").in("session_id", sessionIds)) : [],
    // Added after the security audit (2026-10-01, GDPR Art. 15 / 20).
    public_keys: await rows("user_public_keys", admin.from("user_public_keys")
      .select("x25519, ed25519, created_at, updated_at").eq("user_id", uid)),
    key_backup: await rows("user_key_backups", admin.from("user_key_backups")
      .select("blob, updated_at").eq("user_id", uid)),
    newsletter: email ? await rows("newsletter_subscribers", admin.from("newsletter_subscribers")
      .select("email, status, consent_text, consent_source, requested_at, confirmed_at, last_sent_at").ilike("email", emailPattern)) : [],
    website_forms: email ? await rows("enrollments", admin.from("enrollments")
      .select("type, name, email, firm, message, created_at").ilike("email", emailPattern)) : [],
    ai_calls_last_two_days: await rows("ai_call_log", admin.from("ai_call_log")
      .select("fn, at").eq("user_id", uid)),
    notes: [
      "Values starting with 'e2e:v1:' are end-to-end encrypted: only a device holding the project's key can read them, and DocVex's servers cannot.",
      "The key backup is encrypted with your recovery passphrase.",
      "What DocVex keeps on your computer (documents, extracted text, conversations) is not on the server and is not in this file.",
    ],
    synced_private_data: [] as Array<{ name: string; content: unknown }>,
    errors,
  };

  // The user's private sync bundle (their own AI conversations, per project).
  try {
    const folder = `user-${uid}`;
    const { data: objs } = await admin.storage.from("project-sync").list(folder, { limit: 1000 });
    for (const o of objs ?? []) {
      if (!o.id) continue;
      const { data: blob } = await admin.storage.from("project-sync").download(`${folder}/${o.name}`);
      if (!blob) continue;
      const text = await blob.text();
      let content: unknown = text;
      try { content = JSON.parse(text); } catch { /* keep as text */ }
      out.synced_private_data.push({ name: o.name, content });
    }
  } catch (err) {
    errors.push(`synced_private_data: ${String((err as Error)?.message ?? err)}`);
  }

  return json(out);
});
