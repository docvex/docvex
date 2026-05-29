// project-ai — live Claude for the project AI hub (the /ai surface).
//
// Two actions, dispatched on the request body's `action` field:
//
//   { action: "ask", messages: [{ role, content }, ...], projectName?,
//     fileNames?: string[] }
//     A Q&A turn over the matter. `messages` is the running conversation
//     (UI history mapped to Anthropic roles). Returns { ok, text } — a
//     real English answer from Claude. The model is told the matter name
//     and the list of file NAMES (not contents), so it grounds answers in
//     the matter without fabricating document-level citations.
//
//   { action: "generate", template, instructions?, projectName?,
//     fileNames?: string[] }
//     Drafts a legal document of the requested type. Returns { ok, text }
//     — a complete English draft for a lawyer to review and adapt.
//
// verify_jwt is on (default) — supabase-js attaches the caller's JWT, so
// only signed-in users reach this. Claude is called over raw REST, same
// shape as the legal-ai function. Model defaults to claude-opus-4-7,
// overridable via LEGAL_AI_MODEL (shared with legal-ai) or PROJECT_AI_MODEL.
//
// Required Edge Function secret:
//   ANTHROPIC_API_KEY — Claude API key. When unset, both actions return a
//   200 with { ok:false, error:"ai_not_configured" } so the client can
//   show a friendly message instead of treating it as a hard failure.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("PROJECT_AI_MODEL")
  ?? Deno.env.get("LEGAL_AI_MODEL")
  ?? "claude-opus-4-7";

type Msg = { role: "user" | "assistant"; content: string };

// ── Claude Messages API (raw REST) ──────────────────────────────────
// The stable system prompt carries a cache_control breakpoint so the
// prefix is reused across calls (a no-op below the model's minimum
// cacheable length). Volatile content rides in the messages array.
async function callClaude(opts: {
  system: string;
  messages: Msg[];
  maxTokens: number;
}): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens,
      system: [
        { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
      ],
      messages: opts.messages,
    }),
  });

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 400);
    throw new Error(`anthropic_${resp.status}: ${detail}`);
  }
  const data = await resp.json();
  return (data?.content ?? [])
    .filter((b: { type?: string }) => b?.type === "text")
    .map((b: { text?: string }) => b.text ?? "")
    .join("")
    .trim();
}

// Map the UI's message list to a clean Anthropic messages array: keep only
// non-empty string content, cap length, drop any leading assistant turns
// (the API requires the first message to be from the user), and keep the
// last 12 turns so the request stays small.
function normalizeMessages(raw: unknown): Msg[] {
  const arr = Array.isArray(raw) ? raw : [];
  const cleaned: Msg[] = arr
    .filter((m): m is { role?: string; content?: unknown } => !!m && typeof (m as { content?: unknown }).content === "string")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content).trim().slice(0, 6000),
    }))
    .filter((m) => m.content.length > 0);
  while (cleaned.length && cleaned[0].role === "assistant") cleaned.shift();
  return cleaned.slice(-12);
}

function matterContext(projectName?: string, fileNames?: unknown): string {
  const name = (projectName && String(projectName).trim()) || "this matter";
  const files = Array.isArray(fileNames)
    ? fileNames.filter((f) => typeof f === "string").slice(0, 40)
    : [];
  const filesLine = files.length
    ? `Files in the matter (names only, NOT their contents): ${files.join("; ")}.`
    : "No file names were provided for this matter.";
  return `Matter: ${name}. ${filesLine}`;
}

// ── ask ─────────────────────────────────────────────────────────────
async function handleAsk(body: {
  messages?: unknown;
  projectName?: string;
  fileNames?: unknown;
}): Promise<Response> {
  if (!ANTHROPIC_API_KEY) return jsonResponse({ ok: false, error: "ai_not_configured" });

  const messages = normalizeMessages(body.messages);
  if (messages.length === 0) return jsonResponse({ ok: false, error: "no_messages" }, 400);

  const system =
    "You are DocVex AI, a legal assistant embedded in a document-collaboration app used by a Romanian law firm. " +
    "You answer in English, professionally, concisely and practically. " +
    `${matterContext(body.projectName, body.fileNames)} ` +
    "Important: you only have access to the file NAMES, not their contents. When an answer would require a specific " +
    "fact from a document, point to the file that most likely contains that information rather than inventing " +
    "quotes, page numbers, dates or amounts. Do not invent case law or non-existent statutory articles; if you are " +
    "unsure, say so plainly. Format the answer as plain text in short paragraphs.";

  try {
    const text = await callClaude({ system, messages, maxTokens: 1024 });
    return jsonResponse({ ok: true, text });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) },
      502,
    );
  }
}

// ── generate ────────────────────────────────────────────────────────
async function handleGenerate(body: {
  template?: string;
  instructions?: string;
  projectName?: string;
  fileNames?: unknown;
}): Promise<Response> {
  if (!ANTHROPIC_API_KEY) return jsonResponse({ ok: false, error: "ai_not_configured" });

  const template = (body.template && String(body.template).trim()) || "legal document";
  const instructions = (body.instructions && String(body.instructions).trim()) || "";

  const system =
    "You are DocVex AI and you draft legal documents for a Romanian law firm. " +
    "You produce a complete, professional draft in English, in a formal legal register, ready for a lawyer to " +
    "review and adapt. Structure the document with a title on the first line (IN UPPERCASE), then numbered " +
    "paragraphs or clauses as appropriate. Use placeholders like [...] only where a specific fact is genuinely " +
    "unknown. Do not invent case numbers, dates or amounts that were not provided. " +
    "Respond with ONLY the document text — no markdown, no code blocks, no commentary before or after. " +
    `${matterContext(body.projectName, body.fileNames)}`;

  const user =
    `Document type: ${template}.\n` +
    (instructions ? `\nInstructions:\n${instructions}\n` : "") +
    `\nDraft the document now.`;

  try {
    const text = await callClaude({ system, messages: [{ role: "user", content: user }], maxTokens: 1600 });
    return jsonResponse({ ok: true, text });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) },
      502,
    );
  }
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  let body: { action?: string; [k: string]: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  switch (body.action) {
    case "ask":
      return handleAsk(body);
    case "generate":
      return handleGenerate(body);
    default:
      return jsonResponse({ error: "unknown_action" }, 400);
  }
});
