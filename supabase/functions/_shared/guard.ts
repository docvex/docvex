// Who may make an AI call (security fix, 2026-10-01). The AI functions used to
// rely on the gateway's JWT check alone: any valid token — including the
// public anon key the app ships with — could spend the AI budget, with any
// text, for any "project". Now every call is checked HERE, in the function:
//
//   1. a SIGNED-IN user — the bearer token is resolved to a user by
//      supabase.auth.getUser (the anon key, an expired or a forged token is
//      refused, 401);
//   2. when the call names a project (`projectId`), that user is a MEMBER of
//      it — has_project_role(…, 'viewer') asked AS the user, so RLS decides
//      exactly as it does for the project's own rows (403 otherwise);
//   3. a RATE LIMIT per user (public.ai_call_log, migration 049):
//      AI_RATE_PER_MIN (default 60) and AI_RATE_PER_DAY (default 5000) calls,
//      counted across every AI function and every edge isolate (429 otherwise).
//
// A function calls `guardAiCall(req, body, fn)` before anything else and
// returns the Response it gives back when it gives one.

import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GuardOk = { user: User; client: SupabaseClient; projectId: string | null };

function deny(status: number, error: string, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

// The rate limit, counted in public.ai_call_log (migration 049) with the
// service-role key, which never leaves the function: no client can read or
// write that table. Answers "ok", "over" or "error"; a table that does not
// exist yet (049 not applied) answers "ok", so deploying this before the
// migration does not take the AI down.
async function overRateLimit(userId: string, fn: string, perMin: number, perDay: number): Promise<"ok" | "over" | "error"> {
  const url = env("SUPABASE_URL");
  const service = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !service) return "ok";
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  const count = async (ms: number) => {
    const { count: n, error } = await admin.from("ai_call_log")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gt("at", since(ms));
    return { n: n ?? 0, error };
  };
  const [minute, day] = await Promise.all([count(60_000), count(86_400_000)]);
  const err = minute.error || day.error;
  if (err) return /does not exist|PGRST205|42P01/.test(`${err.code} ${err.message}`) ? "ok" : "error";
  if (minute.n >= perMin || day.n >= perDay) return "over";
  const { error: insertError } = await admin.from("ai_call_log").insert({ user_id: userId, fn: fn.slice(0, 40) });
  if (insertError) return "error";
  // Keep the log small: this caller's rows older than two days go.
  admin.from("ai_call_log").delete().eq("user_id", userId).lt("at", since(2 * 86_400_000)).then(() => {}, () => {});
  return "ok";
}

export async function guardAiCall(
  req: Request,
  body: Record<string, unknown>,
  fn: string,
  headers: Record<string, string> = {},
): Promise<GuardOk | Response> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const url = env("SUPABASE_URL");
  const anon = env("SUPABASE_ANON_KEY");
  if (!token || !url || !anon) return deny(401, "not_signed_in", headers);
  // The anon key is a JWT too, but it names no user: getUser refuses it.
  const client = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  const user = data?.user;
  if (error || !user) return deny(401, "not_signed_in", headers);
  if (user.is_anonymous) return deny(403, "account_required", headers);

  let projectId: string | null = null;
  const raw = body?.projectId;
  if (raw != null && raw !== "") {
    if (typeof raw !== "string" || !UUID.test(raw)) return deny(400, "bad_project", headers);
    const { data: member, error: rpcError } = await client.rpc("has_project_role", {
      p_project_id: raw,
      p_min_role: "viewer",
    });
    if (rpcError || member !== true) return deny(403, "not_a_member", headers);
    projectId = raw;
  }

  const perMin = Number(env("AI_RATE_PER_MIN")) || 60;
  const perDay = Number(env("AI_RATE_PER_DAY")) || 5000;
  const limited = await overRateLimit(user.id, fn, perMin, perDay);
  if (limited === "over") return deny(429, "rate_limited", headers);
  if (limited === "error") return deny(503, "rate_check_failed", headers);
  return { user, client, projectId };
}
