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
//   { action: "suggest", fileName, excerpt?, mimeType? }
//     Proposes 3-5 content-aware actions for a file dropped into the AI chat
//     (legal risk score, clause extraction, summarise, …). Returns
//     { ok, suggestions: [{ label, prompt }] }; the client appends its own
//     "Other" escape hatch and falls back to a heuristic list on failure.
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
// last 12 turns so the request stays small. The per-message cap is generous
// because the AI chat inlines attached file contents (text/PDF/Word) into the
// user turn — a tight cap would chop a document mid-way.
const MAX_MSG_CHARS = 60000;
function normalizeMessages(raw: unknown): Msg[] {
  const arr = Array.isArray(raw) ? raw : [];
  const cleaned: Msg[] = arr
    .filter((m): m is { role?: string; content?: unknown } => !!m && typeof (m as { content?: unknown }).content === "string")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content).trim().slice(0, MAX_MSG_CHARS),
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
    "When the user attaches files, their full text contents are included inline in the user's message under a heading " +
    "such as 'The user attached the following file(s)'. Treat that text as the ACTUAL contents of those files — read it " +
    "and quote, summarise and reason over it directly to answer. (Long files may be marked '[content truncated]'.) " +
    "For any file you were given only the NAME of (its contents were not provided, e.g. an image or a scanned page), " +
    "do not invent quotes, dates, amounts or clauses — point to that file instead. Do not invent case law or " +
    "non-existent statutory articles; if you are unsure, say so plainly. Format the answer as plain text in short paragraphs.";

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

// ── suggest ─────────────────────────────────────────────────────────
// Given a dropped file (name + optional content excerpt + mime), return a
// small set of content-aware actions a lawyer might run on it. Used by the AI
// chat's drag-and-drop action sheet. Returns { ok, suggestions:[{label,prompt}] }.
function parseSuggestions(text: string): { label: string; prompt: string }[] {
  let raw = (text ?? "").trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) raw = raw.slice(start, end + 1);
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is { label?: unknown; prompt?: unknown } => !!x && typeof x === "object")
    .map((x) => ({
      label: String((x as { label?: unknown }).label ?? "").trim().slice(0, 40),
      prompt: String((x as { prompt?: unknown }).prompt ?? "").trim().slice(0, 400),
    }))
    .filter((x) => x.label && x.prompt)
    .slice(0, 5);
}

async function handleSuggest(body: {
  fileName?: string;
  excerpt?: string;
  mimeType?: string;
}): Promise<Response> {
  if (!ANTHROPIC_API_KEY) return jsonResponse({ ok: false, error: "ai_not_configured" });

  const fileName = (body.fileName && String(body.fileName).trim()) || "the file";
  const excerpt = body.excerpt ? String(body.excerpt).slice(0, 6000) : "";
  const mimeType = body.mimeType ? String(body.mimeType).slice(0, 120) : "";

  const system =
    "You are DocVex AI, a legal assistant embedded in a Romanian law firm's document app. " +
    "Given one file, propose 3 to 5 SHORT, high-value actions the lawyer is most likely to want to run on it. " +
    "Tailor them to the file's apparent content and type. Favour concrete legal-analysis actions such as risk " +
    "scoring, clause/obligation extraction, compliance or red-flag checks, summarisation, and plain-language " +
    "explanation. Respond with ONLY a JSON array — no prose, no code fences. Each element must be an object " +
    '{"label": "<2-4 word button label>", "prompt": "<one clear instruction sentence to send to the assistant about this file>"}.';

  const user =
    `File name: ${fileName}\n` +
    (mimeType ? `Type: ${mimeType}\n` : "") +
    (excerpt
      ? `\nExcerpt of contents:\n"""\n${excerpt}\n"""\n`
      : `\n(No text contents available — base the suggestions on the file name and type.)\n`) +
    `\nReturn the JSON array now.`;

  try {
    const text = await callClaude({ system, messages: [{ role: "user", content: user }], maxTokens: 600 });
    const suggestions = parseSuggestions(text);
    if (!suggestions.length) return jsonResponse({ ok: false, error: "ai_failed" }, 502);
    return jsonResponse({ ok: true, suggestions });
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
    case "suggest":
      return handleSuggest(body);
    case "generate":
      return handleGenerate(body);
    default:
      return jsonResponse({ error: "unknown_action" }, 400);
  }
});
