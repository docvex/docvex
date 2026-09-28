// Where Claude is reached from the Edge Functions — ONE place.
//
// CLAUDE_PROVIDER (secret) picks the route; everything else (prompts, tools,
// streaming, caching) is the same Messages API either way:
//
//   anthropic (default) — https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY.
//
//   bedrock — Claude in Amazon Bedrock, the Messages-API endpoint
//     https://bedrock-mantle.<region>.api.aws/anthropic/v1/messages
//     (same request body, same SSE stream; AWS runs it, Anthropic has no
//     access to the inference infrastructure). Secrets:
//       BEDROCK_REGION         default eu-west-1 (Ireland). On this endpoint
//                              only Ireland and Stockholm (eu-north-1) serve a
//                              request IN THAT ONE REGION; Frankfurt
//                              (eu-central-1) offers only global / EU-profile
//                              routing there, so it is not the default.
//       AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN) —
//                              an IAM user allowed bedrock-mantle:CreateInference;
//                              requests are SigV4-signed, service "bedrock-mantle".
//       or BEDROCK_API_KEY     a Bedrock API key, sent as x-api-key instead.
//       BEDROCK_MODEL_PREFIX   default "anthropic." (the endpoint's model ids).
//
// NOT on Bedrock: code execution, Agent Skills and the Files API — the
// project-ai `office` action answers office_unavailable there and the app
// builds the file with its local builders, as it already does when that
// path fails. Structured outputs (`output_config.format`) aren't there
// either: a JSON-schema answer is asked for through a `respond` tool with
// that schema instead, and the tool's input is handed back as the reply's
// text — so a caller that JSON.parses the text works on both providers
// (`asToolAnswer` / `fromToolAnswer`). Everything else (ask, stream, tools,
// caching, images, effort) is supported. Server-side `fallbacks` is
// Anthropic-only too; a caller adds it only when claudeProvider() says so.

export type ClaudeProvider = "anthropic" | "bedrock";

const env = (k: string) => (globalThis as any).Deno?.env?.get(k) ?? "";

export function claudeProvider(): ClaudeProvider {
  return env("CLAUDE_PROVIDER").trim().toLowerCase() === "bedrock" ? "bedrock" : "anthropic";
}

// Whether the provider has the credentials it needs.
export function claudeConfigured(): boolean {
  if (claudeProvider() === "anthropic") return !!env("ANTHROPIC_API_KEY");
  return !!env("BEDROCK_API_KEY") || (!!env("AWS_ACCESS_KEY_ID") && !!env("AWS_SECRET_ACCESS_KEY"));
}

// Server-side tools (code execution, Skills, Files API) — Anthropic's API only.
export function claudeHasServerTools(): boolean {
  return claudeProvider() === "anthropic";
}

// First-party model id → the id the provider knows. Bedrock serves a subset;
// a model it lacks goes to its nearest successor there.
const BEDROCK_SUBSTITUTE: Record<string, string> = {
  "claude-sonnet-4-6": "claude-sonnet-5",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
};
export function providerModel(model: string, provider = claudeProvider()): string {
  if (provider === "anthropic") return model;
  const base = BEDROCK_SUBSTITUTE[model] ?? model;
  const prefix = env("BEDROCK_MODEL_PREFIX") || "anthropic.";
  return base.startsWith(prefix) ? base : prefix + base;
}

// POST a Messages API payload. `beta` is the anthropic-beta header value.
// Returns the raw Response (JSON or an SSE stream when payload.stream is set).
export async function claudeMessages(payload: Record<string, unknown>, opts: { beta?: string } = {}): Promise<Response> {
  const provider = claudeProvider();
  const body = JSON.stringify({ ...payload, model: providerModel(String(payload.model ?? ""), provider) });
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (opts.beta) headers["anthropic-beta"] = opts.beta;

  if (provider === "anthropic") {
    headers["x-api-key"] = env("ANTHROPIC_API_KEY");
    return fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body });
  }

  const asTool = asToolAnswer(payload);
  if (asTool) {
    const resp = await bedrockFetch(JSON.stringify({ ...asTool, model: providerModel(String(payload.model ?? ""), provider) }), headers);
    if (!resp.ok) return resp;
    return new Response(JSON.stringify(fromToolAnswer(await resp.json())), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return bedrockFetch(body, headers);
}

async function bedrockFetch(body: string, headers: Record<string, string>): Promise<Response> {
  const region = env("BEDROCK_REGION") || "eu-west-1";
  const url = `https://bedrock-mantle.${region}.api.aws/anthropic/v1/messages`;
  const apiKey = env("BEDROCK_API_KEY");
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  } else {
    Object.assign(headers, await sigV4Headers({
      method: "POST",
      url,
      body,
      region,
      service: "bedrock-mantle",
      accessKeyId: env("AWS_ACCESS_KEY_ID"),
      secretAccessKey: env("AWS_SECRET_ACCESS_KEY"),
      sessionToken: env("AWS_SESSION_TOKEN") || undefined,
    }));
  }
  return fetch(url, { method: "POST", headers, body });
}

// ── Structured answers without structured outputs ──
const RESPOND = "respond";

// A payload asking for a JSON-schema answer, rewritten to ask for it through
// a tool; null when it asks for no such thing. The tool is offered, not
// forced (`auto`): forcing a tool is refused alongside thinking, which the
// newer models run by default — the system block says to call it instead.
export function asToolAnswer(payload: Record<string, unknown>): Record<string, unknown> | null {
  const oc = payload.output_config as Record<string, unknown> | undefined;
  const format = oc?.format as { type?: string; schema?: unknown } | undefined;
  if (!format || format.type !== "json_schema" || !format.schema) return null;
  if (payload.stream) throw new Error("structured answers can't be streamed on this provider");
  const { format: _drop, ...restConfig } = oc as Record<string, unknown>;
  const system = Array.isArray(payload.system)
    ? [...payload.system]
    : payload.system ? [{ type: "text", text: String(payload.system) }] : [];
  system.push({
    type: "text",
    text: `Give your answer by calling the ${RESPOND} tool exactly once, with the whole answer as its input. Write nothing else.`,
  });
  const out: Record<string, unknown> = {
    ...payload,
    system,
    tools: [...((payload.tools as unknown[]) ?? []), {
      name: RESPOND,
      description: "Deliver the final answer in the required structure.",
      input_schema: format.schema,
    }],
    tool_choice: { type: "auto" },
  };
  if (Object.keys(restConfig).length) out.output_config = restConfig;
  else delete out.output_config;
  return out;
}

// The response to an asToolAnswer request, reshaped into what a structured
// output returns: the tool's input as the one text block, the turn ended
// normally. A model that answered in plain text instead is left as it is.
export function fromToolAnswer(data: Record<string, any>): Record<string, any> {
  const call = (data?.content ?? []).find((b: any) => b?.type === "tool_use" && b?.name === RESPOND);
  if (!call) return data;
  return {
    ...data,
    content: [{ type: "text", text: JSON.stringify(call.input ?? {}) }],
    stop_reason: data.stop_reason === "tool_use" ? "end_turn" : data.stop_reason,
  };
}

// ── AWS Signature Version 4 (WebCrypto; no AWS SDK in the Edge runtime) ──
const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key: ArrayBuffer | Uint8Array, s: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(s));
}
// RFC 3986 encoding of each path segment, as SigV4 wants it.
const encodePath = (p: string) =>
  p.split("/").map((seg) => encodeURIComponent(decodeURIComponent(seg)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");

export async function sigV4Headers(o: {
  method: string;
  url: string;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  headers?: Record<string, string>;
  now?: Date;
}): Promise<Record<string, string>> {
  const u = new URL(o.url);
  const amzDate = (o.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const signed: Record<string, string> = { host: u.host, "x-amz-date": amzDate };
  if (o.sessionToken) signed["x-amz-security-token"] = o.sessionToken;
  for (const [k, v] of Object.entries(o.headers ?? {})) signed[k.toLowerCase()] = v;
  const names = Object.keys(signed).sort();
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    o.method.toUpperCase(),
    encodePath(u.pathname || "/"),
    query,
    names.map((n) => `${n}:${String(signed[n]).trim().replace(/\s+/g, " ")}\n`).join(""),
    names.join(";"),
    await sha256(o.body),
  ].join("\n");
  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key = await hmac(enc.encode("AWS4" + o.secretAccessKey), day);
  key = await hmac(key, o.region);
  key = await hmac(key, o.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, toSign));
  const out: Record<string, string> = {
    "x-amz-date": amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
  if (o.sessionToken) out["x-amz-security-token"] = o.sessionToken;
  return out;
}
