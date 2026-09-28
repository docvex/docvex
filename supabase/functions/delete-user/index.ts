// delete-user — self-service "delete my account" endpoint.
//
// Flow:
//   1. Auto JWT verification (verify_jwt = true at deploy time) — only the
//      authenticated caller can trigger their own deletion.
//   2. No body. The user_id to delete is taken from the JWT's `sub` claim,
//      not from a request parameter — that way a leaked token can't be
//      misused to delete an unrelated account, and we don't need a
//      separate same-user check on top.
//   3. Projects the user is the only member of are deleted (with their
//      project-sync copy), their phone-upload leftovers and their private
//      sync bundle (project-sync/user-<uid>/) are erased.
//   4. Service-role admin.auth.deleteUser(uid). FK cascades (project_members,
//      notifications, …) and FK set-nulls (projects.created_by,
//      project_invitations.invited_by) run as part of the delete.
//   5. Return { ok: true }. The renderer is expected to call supabase.auth
//      .signOut() and route to /auth right after — the deleted user's
//      access token is invalid from this point on anyway.
//
// Note for callers: a project the user owned but SHARED with others is kept
// for the team (created_by = null, no owner-role member). A future enhancement
// could auto-promote a co-admin.
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

  // Empty a storage folder (flat or not: every listed entry is removed; a
  // sub-folder shows up as an entry with no id and is walked into).
  const emptyFolder = async (bucket: string, folder: string) => {
    for (let guard = 0; guard < 200; guard++) {
      const { data: objs, error } = await admin.storage.from(bucket).list(folder, { limit: 1000 });
      if (error || !objs || objs.length === 0) return;
      const files = objs.filter((o) => o.id).map((o) => `${folder}/${o.name}`);
      for (const sub of objs.filter((o) => !o.id)) await emptyFolder(bucket, `${folder}/${sub.name}`);
      if (!files.length) return;
      const { error: rmErr } = await admin.storage.from(bucket).remove(files);
      if (rmErr) return;
    }
  };

  // Projects where the user is the ONLY member would be left with nobody able
  // to reach them — their rows, chat and synced case files kept forever. They
  // are deleted now (rows cascade), their project-sync copy with them. A project
  // shared with others is the team's and stays.
  try {
    const { data: mine } = await admin.from("project_members").select("project_id").eq("user_id", user.id);
    for (const { project_id } of mine ?? []) {
      const { count } = await admin.from("project_members")
        .select("user_id", { count: "exact", head: true })
        .eq("project_id", project_id);
      if (count !== 1) continue;
      await emptyFolder("project-sync", project_id);
      await admin.from("projects").delete().eq("id", project_id);
    }
  } catch (_) { /* best effort — the account is still deleted */ }

  // Phone uploads still waiting in the hand-off bucket.
  try {
    const { data: sessions } = await admin.from("phone_upload_sessions").select("id").eq("user_id", user.id);
    for (const { id } of sessions ?? []) await emptyFolder("phone-upload", id);
  } catch (_) { /* best effort */ }

  // Erase the user's PRIVATE sync bundle (project-sync/user-<uid>/, their own
  // advisor threads and chats — lib/projectSyncData). Storage objects are not
  // covered by the FK cascades, so without this they would outlive the account.
  // Best effort: a storage failure must not block the account deletion.
  try {
    const folder = `user-${user.id}`;
    for (;;) {
      const { data: objs, error: listErr } = await admin.storage.from("project-sync").list(folder, { limit: 1000 });
      if (listErr || !objs || objs.length === 0) break;
      const { error: rmErr } = await admin.storage.from("project-sync").remove(objs.map((o) => `${folder}/${o.name}`));
      if (rmErr || objs.length < 1000) break;
    }
  } catch (_) { /* keep going — the account still gets deleted */ }

  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) {
    return jsonResponse({ error: "delete_failed", detail: delErr.message }, 500);
  }

  return jsonResponse({ ok: true });
});
