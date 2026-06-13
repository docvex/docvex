// mail-sync — live mailbox integration for the personal Mail tab.
//
// Proxies the Gmail (Google) and Outlook (Microsoft Graph) REST APIs on behalf
// of the signed-in user, so the renderer never touches OAuth tokens.
//
// Production hardening:
//   • Tokens are AES-GCM encrypted at rest (key = MAIL_TOKEN_KEY edge secret,
//     separate from the DB) — a DB/service-role leak alone can't read mailboxes.
//   • OAuth uses a single-use, user-bound CSRF nonce (public.mail_oauth_states):
//     a returned code only completes a connection for the user who started it.
//   • A revoked/expired refresh token (invalid_grant) drops the connection and
//     surfaces `reauth_required` so the client re-prompts instead of looping.
//   • Disconnect revokes the Google token before deleting the row; account
//     deletion cascades the row away via the user_id FK.
//
// Actions (POST body `{ action, ... }`):
//   authorize  { provider, redirectUri, target }      → { ok, url }
//   connect    { provider, code, redirectUri, nonce }  → { ok, email, provider }
//   status     {}                                      → { ok, connected, provider, email }
//   list       {}                                      → { ok, messages } | { ok:false, error:"reauth_required" }
//   send       { to, subject, body, threadId?, … }     → { ok }            | reauth_required
//   disconnect {}                                      → { ok }
//
// Required Edge Function secrets:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   (Gmail)
//   MS_CLIENT_ID / MS_CLIENT_SECRET           (Outlook / Microsoft 365)
//   MAIL_TOKEN_KEY                            (base64 of 32 random bytes —
//                                              `openssl rand -base64 32`)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const MS_CLIENT_ID = Deno.env.get("MS_CLIENT_ID") ?? "";
const MS_CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET") ?? "";
const MAIL_TOKEN_KEY = Deno.env.get("MAIL_TOKEN_KEY") ?? "";

const GOOGLE_SCOPES = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");
const MS_SCOPES = [
  "offline_access", "openid", "email", "profile",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/User.Read",
].join(" ");

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

const NONCE_TTL_MS = 10 * 60 * 1000;
const REAUTH = "reauth_required";

type Provider = "gmail" | "outlook";
interface Conn {
  user_id: string;
  provider: Provider;
  email: string | null;
  access_token: string | null;   // plaintext after loadConn() decrypts
  refresh_token: string | null;
  token_expiry: string | null;
  scope: string | null;
}

// ── base64 / base64url ──────────────────────────────────────────────────
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64urlDecode(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return b64ToBytes(b64);
}
function b64urlEncode(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder().decode(bytes); } catch { return ""; }
}

// ── Token encryption at rest (AES-256-GCM) ──────────────────────────────
// Stored format: "v1:" + base64(iv[12] ++ ciphertext). Values without the
// prefix are treated as legacy plaintext (so an unkeyed dev instance keeps
// working and a key can be added later without a data migration).
let cryptoKeyPromise: Promise<CryptoKey> | null = null;
function getCryptoKey(): Promise<CryptoKey> | null {
  if (!MAIL_TOKEN_KEY) return null;
  if (!cryptoKeyPromise) {
    const raw = b64ToBytes(MAIL_TOKEN_KEY);
    cryptoKeyPromise = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  return cryptoKeyPromise;
}
async function encToken(plain: string | null): Promise<string | null> {
  if (!plain) return plain;
  const keyP = getCryptoKey();
  if (!keyP) return plain; // no key configured (dev) → store as-is
  const key = await keyP;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return `v1:${bytesToB64(out)}`;
}
async function decToken(stored: string | null): Promise<string | null> {
  if (!stored || !stored.startsWith("v1:")) return stored; // legacy plaintext
  const keyP = getCryptoKey();
  if (!keyP) throw new Error("token_key_missing");
  const key = await keyP;
  const raw = b64ToBytes(stored.slice(3));
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ── HTML → text (for message bodies) ────────────────────────────────────
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function adminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Token lifecycle ─────────────────────────────────────────────────────
async function refreshAccessToken(conn: Conn): Promise<Conn> {
  if (!conn.refresh_token) throw new Error(REAUTH);
  const isG = conn.provider === "gmail";
  const params = new URLSearchParams({
    client_id: isG ? GOOGLE_CLIENT_ID : MS_CLIENT_ID,
    client_secret: isG ? GOOGLE_CLIENT_SECRET : MS_CLIENT_SECRET,
    refresh_token: conn.refresh_token,
    grant_type: "refresh_token",
  });
  if (!isG) params.set("scope", MS_SCOPES);
  const resp = await fetch(isG ? GOOGLE_TOKEN : MS_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 300);
    // A revoked / expired grant is unrecoverable — drop the dead connection so
    // the client re-prompts instead of erroring on every poll.
    if (resp.status === 400 || resp.status === 401 || /invalid_grant/i.test(detail)) {
      await adminClient().from("user_mail_connections").delete().eq("user_id", conn.user_id);
      throw new Error(REAUTH);
    }
    throw new Error(`refresh_failed_${resp.status}: ${detail}`);
  }
  const tok = await resp.json();
  const expiry = new Date(Date.now() + (Number(tok.expires_in ?? 3600) - 60) * 1000).toISOString();
  const next: Conn = {
    ...conn,
    access_token: tok.access_token ?? conn.access_token,
    refresh_token: tok.refresh_token ?? conn.refresh_token, // MS rotates; Google keeps
    token_expiry: expiry,
  };
  await adminClient().from("user_mail_connections").update({
    access_token: await encToken(next.access_token),
    refresh_token: await encToken(next.refresh_token),
    token_expiry: next.token_expiry,
  }).eq("user_id", conn.user_id);
  return next;
}

async function getValidToken(conn: Conn): Promise<string> {
  const stillValid = conn.access_token && conn.token_expiry &&
    new Date(conn.token_expiry).getTime() > Date.now() + 30_000;
  const live = stillValid ? conn : await refreshAccessToken(conn);
  if (!live.access_token) throw new Error(REAUTH);
  return live.access_token;
}

// Loads a connection and DECRYPTS its tokens for in-process use.
async function loadConn(userId: string): Promise<Conn | null> {
  const { data } = await adminClient()
    .from("user_mail_connections").select("*").eq("user_id", userId).maybeSingle();
  if (!data) return null;
  const c = data as Conn;
  return { ...c, access_token: await decToken(c.access_token), refresh_token: await decToken(c.refresh_token) };
}

// ── authorize (issue CSRF nonce + build consent URL) ────────────────────
async function handleAuthorize(userId: string, provider: Provider, redirectUri: string, target: string): Promise<Response> {
  if (!redirectUri) return jsonResponse({ ok: false, error: "missing_redirect" }, 400);
  const configured = provider === "gmail" ? !!GOOGLE_CLIENT_ID : !!MS_CLIENT_ID;
  if (!configured) return jsonResponse({ ok: false, error: "provider_not_configured" });

  const db = adminClient();
  // Best-effort cleanup of expired nonces; then mint a fresh one for this user.
  await db.from("mail_oauth_states").delete().lt("expires_at", new Date().toISOString());
  const nonce = crypto.randomUUID();
  const { error: nErr } = await db.from("mail_oauth_states").insert({
    nonce, user_id: userId, provider,
    expires_at: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
  });
  if (nErr) return jsonResponse({ ok: false, error: "state_failed", detail: nErr.message }, 500);

  // state = nonce ~ provider ~ target  (target last; it may be a URL).
  const state = `${nonce}~${provider}~${target || "electron"}`;
  const common = { client_id: provider === "gmail" ? GOOGLE_CLIENT_ID : MS_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", state };
  const u = new URL(provider === "gmail" ? GOOGLE_AUTH : MS_AUTH);
  if (provider === "gmail") {
    u.search = new URLSearchParams({ ...common, scope: GOOGLE_SCOPES, access_type: "offline", include_granted_scopes: "true", prompt: "consent" }).toString();
  } else {
    u.search = new URLSearchParams({ ...common, scope: MS_SCOPES, response_mode: "query", prompt: "consent" }).toString();
  }
  return jsonResponse({ ok: true, url: u.toString() });
}

// Verify + consume a nonce (single use, user-bound, unexpired).
async function consumeNonce(userId: string, provider: Provider, nonce: string): Promise<boolean> {
  if (!nonce) return false;
  const db = adminClient();
  const { data } = await db.from("mail_oauth_states").select("*").eq("nonce", nonce).maybeSingle();
  // Always delete (single use), even on mismatch.
  await db.from("mail_oauth_states").delete().eq("nonce", nonce);
  if (!data) return false;
  if (data.user_id !== userId || data.provider !== provider) return false;
  if (new Date(data.expires_at).getTime() < Date.now()) return false;
  return true;
}

// ── connect (code → tokens → encrypted store) ───────────────────────────
async function handleConnect(userId: string, provider: Provider, code: string, redirectUri: string, nonce: string): Promise<Response> {
  if (!code || !redirectUri) return jsonResponse({ ok: false, error: "missing_params" }, 400);
  if (!(await consumeNonce(userId, provider, nonce))) return jsonResponse({ ok: false, error: "invalid_state" }, 400);

  const isG = provider === "gmail";
  if (isG && !GOOGLE_CLIENT_ID) return jsonResponse({ ok: false, error: "provider_not_configured" });
  if (!isG && !MS_CLIENT_ID) return jsonResponse({ ok: false, error: "provider_not_configured" });

  const params = new URLSearchParams({
    client_id: isG ? GOOGLE_CLIENT_ID : MS_CLIENT_ID,
    client_secret: isG ? GOOGLE_CLIENT_SECRET : MS_CLIENT_SECRET,
    code, grant_type: "authorization_code", redirect_uri: redirectUri,
  });
  if (!isG) params.set("scope", MS_SCOPES);

  const resp = await fetch(isG ? GOOGLE_TOKEN : MS_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!resp.ok) {
    return jsonResponse({ ok: false, error: "token_exchange_failed", detail: (await resp.text()).slice(0, 300) }, 502);
  }
  const tok = await resp.json();
  const accessToken: string = tok.access_token;
  const refreshToken: string | undefined = tok.refresh_token;
  const expiry = new Date(Date.now() + (Number(tok.expires_in ?? 3600) - 60) * 1000).toISOString();

  let email = "";
  try {
    if (isG) {
      const pr = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${accessToken}` } });
      if (pr.ok) email = (await pr.json()).emailAddress ?? "";
    } else {
      const pr = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${accessToken}` } });
      if (pr.ok) { const p = await pr.json(); email = p.mail ?? p.userPrincipalName ?? ""; }
    }
  } catch { /* email best-effort */ }

  const existing = await loadConn(userId); // decrypted; keep its refresh token if none returned
  const row: Record<string, unknown> = {
    user_id: userId,
    provider,
    email,
    access_token: await encToken(accessToken),
    refresh_token: await encToken(refreshToken ?? existing?.refresh_token ?? null),
    token_expiry: expiry,
    scope: isG ? GOOGLE_SCOPES : MS_SCOPES,
  };
  const { error } = await adminClient().from("user_mail_connections").upsert(row, { onConflict: "user_id" });
  if (error) return jsonResponse({ ok: false, error: "store_failed", detail: error.message }, 500);
  return jsonResponse({ ok: true, email, provider });
}

// ── list ─────────────────────────────────────────────────────────────────
interface MailMsg {
  id: string; threadId: string;
  from: { name: string; email: string };
  subject: string; snippet: string; body: string;
  receivedAt: number; unread: boolean;
}
function parseFromHeader(v: string): { name: string; email: string } {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim() };
  return { name: v.trim(), email: v.trim() };
}
function pickGmailPart(pl: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }, mime: string): string {
  if (!pl) return "";
  if (pl.mimeType === mime && pl.body?.data) {
    const txt = decodeText(b64urlDecode(pl.body.data));
    return mime === "text/html" ? htmlToText(txt) : txt;
  }
  for (const p of (pl.parts ?? []) as typeof pl[]) {
    const r = pickGmailPart(p, mime);
    if (r) return r;
  }
  return "";
}
function gmailBody(payload: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }): string {
  if (!payload) return "";
  return pickGmailPart(payload, "text/plain") || pickGmailPart(payload, "text/html");
}

async function listGmail(token: string): Promise<MailMsg[]> {
  const idsResp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=12&labelIds=INBOX",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!idsResp.ok) throw new Error(`gmail_list_${idsResp.status}: ${(await idsResp.text()).slice(0, 200)}`);
  const ids = (await idsResp.json()).messages ?? [];
  const out: MailMsg[] = [];
  for (const { id } of ids) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) continue;
    const m = await r.json();
    const headers: { name: string; value: string }[] = m.payload?.headers ?? [];
    const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    const body = gmailBody(m.payload) || (m.snippet ?? "");
    out.push({
      id: m.id, threadId: m.threadId,
      from: parseFromHeader(h("From")),
      subject: h("Subject") || "(no subject)",
      snippet: m.snippet ?? "",
      body,
      receivedAt: Number(m.internalDate) || Date.now(),
      unread: Array.isArray(m.labelIds) && m.labelIds.includes("UNREAD"),
    });
  }
  return out;
}

async function listOutlook(token: string): Promise<MailMsg[]> {
  const r = await fetch(
    "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=12&$select=id,conversationId,subject,from,receivedDateTime,bodyPreview,isRead,body",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`graph_list_${r.status}: ${(await r.text()).slice(0, 200)}`);
  const items = (await r.json()).value ?? [];
  return items.map((m: Record<string, any>): MailMsg => {
    const addr = m.from?.emailAddress ?? {};
    const isHtml = (m.body?.contentType ?? "").toLowerCase() === "html";
    const body = m.body?.content ? (isHtml ? htmlToText(m.body.content) : m.body.content) : (m.bodyPreview ?? "");
    return {
      id: m.id, threadId: m.conversationId ?? m.id,
      from: { name: addr.name || addr.address || "", email: addr.address || "" },
      subject: m.subject || "(no subject)",
      snippet: m.bodyPreview ?? "",
      body,
      receivedAt: m.receivedDateTime ? new Date(m.receivedDateTime).getTime() : Date.now(),
      unread: m.isRead === false,
    };
  });
}

async function handleList(userId: string): Promise<Response> {
  const conn = await loadConn(userId);
  if (!conn) return jsonResponse({ ok: false, error: "not_connected" }, 400);
  try {
    const token = await getValidToken(conn);
    const messages = conn.provider === "gmail" ? await listGmail(token) : await listOutlook(token);
    messages.sort((a, b) => b.receivedAt - a.receivedAt);
    return jsonResponse({ ok: true, messages });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (msg === REAUTH) return jsonResponse({ ok: false, error: REAUTH }, 400);
    return jsonResponse({ ok: false, error: "list_failed", detail: msg.slice(0, 300) }, 502);
  }
}

// ── send ──────────────────────────────────────────────────────────────────
async function sendGmail(token: string, to: string, subject: string, body: string, threadId?: string, inReplyTo?: string, references?: string): Promise<void> {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
  ];
  const raw = `${headers.join("\r\n")}\r\n\r\n${body}`;
  const encoded = b64urlEncode(new TextEncoder().encode(raw));
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(threadId ? { raw: encoded, threadId } : { raw: encoded }),
  });
  if (!r.ok) throw new Error(`gmail_send_${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function sendOutlook(token: string, to: string, subject: string, body: string): Promise<void> {
  const r = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: { subject, body: { contentType: "Text", content: body }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: true,
    }),
  });
  if (!r.ok) throw new Error(`graph_send_${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function handleSend(userId: string, b: Record<string, unknown>): Promise<Response> {
  const to = String(b.to ?? "").trim();
  const subject = String(b.subject ?? "").trim() || "(no subject)";
  const body = String(b.body ?? "");
  if (!to || !body) return jsonResponse({ ok: false, error: "missing_params" }, 400);
  const conn = await loadConn(userId);
  if (!conn) return jsonResponse({ ok: false, error: "not_connected" }, 400);
  try {
    const token = await getValidToken(conn);
    if (conn.provider === "gmail") {
      await sendGmail(token, to, subject, body, b.threadId as string | undefined, b.inReplyTo as string | undefined, b.references as string | undefined);
    } else {
      await sendOutlook(token, to, subject, body);
    }
    return jsonResponse({ ok: true });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (msg === REAUTH) return jsonResponse({ ok: false, error: REAUTH }, 400);
    return jsonResponse({ ok: false, error: "send_failed", detail: msg.slice(0, 300) }, 502);
  }
}

// ── status / disconnect ─────────────────────────────────────────────────
async function handleStatus(userId: string): Promise<Response> {
  const { data } = await adminClient().from("user_mail_connections").select("provider,email").eq("user_id", userId).maybeSingle();
  return jsonResponse({ ok: true, connected: !!data, provider: data?.provider ?? null, email: data?.email ?? null });
}

async function handleDisconnect(userId: string): Promise<Response> {
  const conn = await loadConn(userId);
  // Best-effort: revoke at the provider so access really ends (not just our copy).
  if (conn?.provider === "gmail" && conn.refresh_token) {
    try {
      await fetch(GOOGLE_REVOKE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: conn.refresh_token }).toString(),
      });
    } catch { /* revoke is best-effort */ }
  }
  await adminClient().from("user_mail_connections").delete().eq("user_id", userId);
  return jsonResponse({ ok: true });
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  let body: { action?: string; [k: string]: unknown };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "invalid_json" }, 400); }

  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: "unauthenticated" }, 401);

  const provider = (body.provider === "outlook" ? "outlook" : "gmail") as Provider;

  switch (body.action) {
    case "authorize":
      return handleAuthorize(user.id, provider, String(body.redirectUri ?? ""), String(body.target ?? ""));
    case "connect":
      return handleConnect(user.id, provider, String(body.code ?? ""), String(body.redirectUri ?? ""), String(body.nonce ?? ""));
    case "status":
      return handleStatus(user.id);
    case "list":
      return handleList(user.id);
    case "send":
      return handleSend(user.id, body);
    case "disconnect":
      return handleDisconnect(user.id);
    default:
      return jsonResponse({ error: "unknown_action" }, 400);
  }
});
