// phone-upload — upload files from a phone into a project, through the cloud.
//
// The Files tab's Import shows two QR codes; this is the one for a phone that
// is NOT on the desktop's network (the other goes straight to the desktop app
// over Wi-Fi and never reaches here). See migration 040.
//
// The phone is not signed in. It holds a random token (in the QR code; only its
// SHA-256 is stored) and this function, with the service role, does everything
// on its behalf — and nothing else:
//
//   create  (user JWT)  { projectId?, projectName?, token? } → { token, sessionId, expiresAt }
//                       Mints a session for the signed-in user — or, given a
//                       KEPT token of theirs, REOPENS that session (the same
//                       address every time, as the Wi-Fi route; migration 041).
//                       Also clears the user's sessions that ended a day ago.
//   status  (token)     { ids } → { ok, status: { id: waiting|accepted|rejected|unknown } }
//                       what the desktop decided about this session's files.
//   info    (token)     → { ok, projectName, expiresAt, files, maxBytes }
//   sign    (token)     { name, size, type } → { signedUrl, path }
//                       A signed upload URL for ONE file: <session>/<uuid>.
//   done    (token)     { path, name, size, type } → { ok }
//                       The phone says the upload finished; the file is
//                       checked to be in the bucket and a row is written,
//                       which the desktop hears over Realtime.
//   close   (user JWT)  { sessionId } → { ok }   PAUSES a session (the Import
//                       window closed); `create` with its token reopens it.
//
// Deployed with verify_jwt OFF (the phone has no JWT); `create` / `close`
// check the caller's JWT themselves.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const BUCKET = "phone-upload";
const SESSION_DAYS = 7;                   // sliding: every reopen pushes it back
const MAX_BYTES = 50 * 1024 * 1024;       // the bucket's own cap
const MAX_FILES = 300;                    // per session
const MAX_SESSION_BYTES = 2 * 1024 * 1024 * 1024;

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
const cleanName = (n: unknown) => String(n || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "file";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const action = String(body.action || "");

  // ── Sweep (run hourly by pg_cron, migration 044) ─────────────────────────
  // Files nobody collected must not wait in the bucket for the owner's next
  // `create`: every session that ended a day ago loses its objects and its
  // row, and a folder whose session row is already gone is emptied too. It
  // only ever deletes data that has already lapsed, so it needs no caller
  // identity; calling it more often changes nothing.
  if (action === "sweep") {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const emptyFolder = async (folder: string) => {
      for (let guard = 0; guard < 50; guard++) {
        const { data: objs } = await db.storage.from(BUCKET).list(folder, { limit: 1000 });
        if (!objs?.length) return;
        const { error } = await db.storage.from(BUCKET).remove(objs.map((x) => `${folder}/${x.name}`));
        if (error) return;
      }
    };
    let sessions = 0, orphans = 0;
    const { data: old } = await db.from("phone_upload_sessions").select("id").lt("expires_at", dayAgo).limit(200);
    for (const o of old || []) {
      await emptyFolder(o.id);
      await db.from("phone_upload_sessions").delete().eq("id", o.id);
      sessions++;
    }
    const { data: folders } = await db.storage.from(BUCKET).list("", { limit: 1000 });
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = (folders || []).filter((f) => !f.id && UUID.test(f.name)).map((f) => f.name);
    if (ids.length) {
      const { data: live, error: liveErr } = await db.from("phone_upload_sessions").select("id").in("id", ids);
      // Never guess: without a clean answer about which sessions exist, no
      // folder is treated as an orphan.
      if (liveErr || !live) return json({ ok: true, sessions, orphans });
      const keep = new Set((live || []).map((r) => r.id));
      for (const id of ids) if (!keep.has(id)) { await emptyFolder(id); orphans++; }
    }
    return json({ ok: true, sessions, orphans });
  }

  // ── Signed-in actions ─────────────────────────────────────────────────────
  if (action === "create" || action === "close") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
    const { data: u } = await asUser.auth.getUser(jwt);
    const user = u?.user;
    if (!user) return json({ ok: false, error: "not_signed_in" }, 401);

    if (action === "close") {
      const id = String(body.sessionId || "");
      const { data: s } = await db.from("phone_upload_sessions").select("id").eq("id", id).eq("user_id", user.id).maybeSingle();
      if (!s) return json({ ok: true });
      await db.from("phone_upload_sessions").update({ closed_at: new Date().toISOString() }).eq("id", id);
      return json({ ok: true });
    }

    // A project the caller is a member of (RLS decides, as the user).
    const projectId = body.projectId ? String(body.projectId) : null;
    let projectName = String(body.projectName || "").slice(0, 200);
    if (projectId) {
      const { data: p } = await asUser.from("projects").select("id,name").eq("id", projectId).maybeSingle();
      if (!p) return json({ ok: false, error: "no_project" }, 403);
      projectName = p.name || projectName;
    }

    // Housekeeping: the user's sessions that ended a day ago — their leftover
    // objects (a desktop closed before taking them) and the rows.
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: old } = await db.from("phone_upload_sessions").select("id").eq("user_id", user.id).lt("expires_at", dayAgo).limit(50);
    for (const o of old || []) {
      const { data: objs } = await db.storage.from(BUCKET).list(o.id, { limit: 1000 });
      if (objs?.length) await db.storage.from(BUCKET).remove(objs.map((x) => `${o.id}/${x.name}`));
      await db.from("phone_upload_sessions").delete().eq("id", o.id);
    }

    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
    // A kept token of THIS user's: reopen that session — same address.
    const kept = typeof body.token === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(body.token) ? body.token : "";
    if (kept) {
      const { data: k } = await db.from("phone_upload_sessions").select("id")
        .eq("token_hash", await sha256(kept)).eq("user_id", user.id).maybeSingle();
      if (k) {
        await db.from("phone_upload_sessions").update({ closed_at: null, expires_at: expiresAt, project_id: projectId }).eq("id", k.id);
        return json({ ok: true, token: kept, sessionId: k.id, expiresAt, projectName, reopened: true });
      }
    }
    const token = newToken();
    const { data: s, error } = await db.from("phone_upload_sessions")
      .insert({ user_id: user.id, project_id: projectId, token_hash: await sha256(token), expires_at: expiresAt })
      .select("id").single();
    if (error || !s) return json({ ok: false, error: "create_failed" }, 500);
    return json({ ok: true, token, sessionId: s.id, expiresAt, projectName });
  }

  // ── Token actions (the phone) ─────────────────────────────────────────────
  const token = String(body.token || "");
  if (!token) return json({ ok: false, error: "no_token" }, 401);
  const { data: s } = await db.from("phone_upload_sessions")
    .select("id,project_id,expires_at,closed_at,file_count,byte_count")
    .eq("token_hash", await sha256(token)).maybeSingle();
  if (!s) return json({ ok: false, error: "unknown" }, 404);
  if (s.closed_at || new Date(s.expires_at).getTime() < Date.now()) return json({ ok: false, error: "expired" }, 410);

  if (action === "info") {
    let projectName = "";
    if (s.project_id) {
      const { data: p } = await db.from("projects").select("name").eq("id", s.project_id).maybeSingle();
      projectName = p?.name || "";
    }
    return json({ ok: true, projectName, expiresAt: s.expires_at, files: s.file_count, maxBytes: MAX_BYTES });
  }

  if (action === "sign") {
    const size = Number(body.size) || 0;
    if (size > MAX_BYTES) return json({ ok: false, error: "too_large", maxBytes: MAX_BYTES }, 413);
    if (s.file_count >= MAX_FILES) return json({ ok: false, error: "too_many" }, 429);
    if (s.byte_count + size > MAX_SESSION_BYTES) return json({ ok: false, error: "session_full" }, 413);
    const path = `${s.id}/${crypto.randomUUID()}`;
    const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) return json({ ok: false, error: "sign_failed" }, 500);
    return json({ ok: true, signedUrl: data.signedUrl, path });
  }

  if (action === "done") {
    const path = String(body.path || "");
    if (!path.startsWith(`${s.id}/`) || path.includes("..")) return json({ ok: false, error: "bad_path" }, 400);
    const leaf = path.slice(s.id.length + 1);
    const { data: objs } = await db.storage.from(BUCKET).list(s.id, { search: leaf, limit: 1 });
    const obj = (objs || []).find((o) => o.name === leaf);
    if (!obj) return json({ ok: false, error: "not_uploaded" }, 409);
    const size = Number((obj.metadata as Record<string, unknown> | null)?.size) || Number(body.size) || 0;
    const { data: row, error } = await db.from("phone_upload_files").insert({
      session_id: s.id, path, name: cleanName(body.name), size, mime: String(body.type || "").slice(0, 120) || null,
    }).select("id").single();
    if (error || !row) return json({ ok: false, error: "record_failed" }, 500);
    await db.from("phone_upload_sessions").update({ file_count: s.file_count + 1, byte_count: s.byte_count + size }).eq("id", s.id);
    // It WAITS for approval on the computer; the phone follows it by id.
    return json({ ok: true, id: row.id, held: true });
  }

  if (action === "status") {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 200);
    const status: Record<string, string> = {};
    for (const id of ids) status[id] = "unknown";
    if (ids.length) {
      const { data: rows } = await db.from("phone_upload_files").select("id,status").eq("session_id", s.id).in("id", ids);
      for (const r of rows || []) status[r.id] = r.status || "waiting";
    }
    return json({ ok: true, status });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
