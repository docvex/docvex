// mail-callback — public OAuth redirect bridge for the Mail tab.
//
// Google / Microsoft will not redirect an OAuth response straight to a custom
// URI scheme (docvex://), so — exactly like Supabase's own hosted auth callback
// — we register THIS https endpoint as the OAuth redirect_uri, and it serves a
// tiny HTML page that hops the `code` onward to the app:
//
//   • Electron:  docvex://mail/callback?provider=…&code=…   (custom scheme)
//   • Web:       <app /mail url>?provider=…&mailcode=…
//
// The hop target is carried in the OAuth `state` param, formatted as
// `${nonce}~${provider}~${target}` where target is the literal "electron" or
// the URL-encoded web /mail URL. The nonce is forwarded back to the app so it
// can complete the CSRF-checked token exchange.
//
// verify_jwt MUST be false: the browser hits this after the consent screen with
// no Authorization header. No secrets are read or exposed here — it only relays
// the opaque authorization code, which is useless without the server-side
// client secret (held by mail-sync).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// The web hop target is carried in the OAuth `state`, which an attacker can
// craft and providers echo back verbatim. Without validation this endpoint is
// an open redirect that bounces the authorization code to any host. Only ever
// redirect to an app-owned origin (exact scheme+host+port match). Override the
// defaults with MAIL_WEB_ORIGINS (comma-separated) if the app moves domains.
const ALLOWED_WEB_ORIGINS = (
  Deno.env.get("MAIL_WEB_ORIGINS")
  ?? "https://docvex.ro,https://www.docvex.ro,https://petreluca1105-dotcom.github.io"
).split(",").map((s) => s.trim()).filter(Boolean);

function isAllowedWebTarget(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  // Localhost over http is the web dev server — safe (points at the victim's
  // own machine, not an attacker host).
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
  return u.protocol === "https:" && ALLOWED_WEB_ORIGINS.includes(u.origin);
}

function htmlPage(redirectTo: string, message: string): Response {
  const safe = redirectTo.replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DocVex Mail</title>
<style>
  body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#F5F2EA;color:#0F172A;
    display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
  .card{max-width:420px;padding:32px}
  .dot{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#8B5E3C,#DCC9A3);margin:0 auto 18px}
  h1{font-size:20px;margin:0 0 8px} p{color:#6B7280;font-size:14px;line-height:1.5;margin:0 0 18px}
  a{color:#8B5E3C;font-weight:600}
</style></head>
<body><div class="card"><div class="dot"></div>
<h1>${message}</h1>
<p>You can return to DocVex now. If nothing happens, <a href="${safe}">click here to continue</a>.</p>
<script>setTimeout(function(){ window.location.replace(${JSON.stringify(redirectTo)}); }, 250);</script>
</div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

Deno.serve((req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const oauthError = url.searchParams.get("error") ?? "";

  // state = nonce ~ provider ~ target  (target last; it may contain '~').
  const i1 = state.indexOf("~");
  const nonce = i1 >= 0 ? state.slice(0, i1) : "";
  const rest = i1 >= 0 ? state.slice(i1 + 1) : state;
  const i2 = rest.indexOf("~");
  const provider = (i2 >= 0 ? rest.slice(0, i2) : rest) || "gmail";
  const target = i2 >= 0 ? rest.slice(i2 + 1) : "electron";

  const q = (extra: string) =>
    `provider=${encodeURIComponent(provider)}&nonce=${encodeURIComponent(nonce)}&${extra}`;

  const isElectron = target === "electron" || !target;
  // Resolve the redirect base up front, validating any web target against the
  // origin allowlist. An unrecognised target is refused (never bounced onward)
  // so a crafted `state` can't turn this into an open redirect / code leak.
  const webTarget = isElectron ? null : decodeURIComponent(target);
  if (!isElectron && !isAllowedWebTarget(webTarget!)) {
    return htmlPage(
      `docvex://mail/callback?${q("error=bad_target")}`,
      "Couldn't connect your mailbox",
    );
  }
  const base = isElectron ? "docvex://mail/callback" : webTarget!;
  const join = base.includes("?") ? "&" : "?";

  if (oauthError || !code) {
    return htmlPage(`${base}${join}${q(`error=${encodeURIComponent(oauthError || "no_code")}`)}`,
      "Couldn't connect your mailbox");
  }
  // Electron gets `code`, web gets `mailcode` (its historical param name).
  const codeParam = isElectron
    ? `code=${encodeURIComponent(code)}`
    : `mailcode=${encodeURIComponent(code)}`;
  return htmlPage(`${base}${join}${q(codeParam)}`, "Mailbox connected");
});
