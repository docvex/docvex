// project-ai — live Claude for the project AI hub (the /ai surface).
//
// Two actions, dispatched on the request body's `action` field:
//
//   { action: "ask", messages: [{ role, content }, ...], projectName?,
//     fileNames?: string[], model?, tools?, docTools?, forceDocument?, docKind? }
//     A Q&A turn over the matter. `messages` is the running conversation; each
//     `content` is a STRING for ordinary turns, or an ARRAY of content blocks
//     for a tool round-trip (assistant tool_use + user tool_result).
//     Returns { ok, text, usage:{ input_tokens, output_tokens } }. The model has
//     a client-side `ask_user` tool (pass tools:false to disable, e.g. for title
//     generation). When it calls ask_user the response is instead
//       { ok, stopReason:"tool_use", tool:"ask_user",
//         askUser:{ id, input:{ questions:[…] } }, assistantContent:[…raw blocks…], usage }
//     The backend does NOT execute ask_user — the client renders the questions,
//     then RESUMES by appending the assistant turn (assistantContent) + a user
//     turn { content:[{ type:"tool_result", tool_use_id, content:<JSON answers> }] }
//     and calling "ask" again. Answers JSON: { answers:[{ question_id,
//     response_type, selected?:[ids], label?:[…], text?, approved? }], dismissed? }.
//
//     DOCUMENT BUILDER (DocViewer "generate" surface): pass docTools:true to also
//     expose the `write_document` tool — the model drives an iterative file build.
//     Pass forceDocument:true (when the user clearly wants a document) to PIN
//     tool_choice to write_document, so a "make another version" request can never
//     drift to prose or a refusal. docKind ("docx"|"pptx"|"xlsx") locks the format.
//     When the model calls write_document the response is
//       { ok, stopReason:"tool_use", tool:"write_document",
//         toolUse:{ id, input:{ kind, summary?, content } }, assistantContent, usage }
//     The client packs `content` into a real Office file (a new version) and saves
//     it. It does NOT need to resume the API turn — the next user message replays
//     the latest document content as context (no tool_result round-trip required).
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
//   { action: "passport", files: [{ id, name, text, method? }] }   (≤8 files)
//   { action: "crossref", passports: [{ id, name, ...passport }] }
//     The Files tab AI scan's MAP and REDUCE steps — a file's text → its
//     passport (summary, subject, facts, parties, dates, themes); every
//     passport of the project at once → the unified timeline, unified facts and
//     TYPED links between files. Strict JSON via a pinned tool. See fileGraph.ts.
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
import { firmDescriptor, jurisdictionPrompt } from "../_shared/jurisdictions.ts";
import { handleCrossref, handlePassport } from "./fileGraph.ts";

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
// Model used for the `office` action (Anthropic document Agent Skills + code
// execution). The sandbox round-trip is wall-clock-bound (an Opus run can take
// ~80s+ and brush the Edge function's time limit), so default to a faster model
// that writes python-pptx/-docx just as well — overridable via the env var.
const OFFICE_MODEL = Deno.env.get("PROJECT_AI_OFFICE_MODEL") ?? "claude-sonnet-4-6";
// Beta gates for Skills + code execution + Files API (download the result).
const OFFICE_BETAS = "code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14";
const FILES_BETA = "files-api-2025-04-14";

// Models the client (chat composer's model picker) is allowed to request. An
// unknown/empty value falls back to the per-action default, so a stale client
// can never push an arbitrary model id through to Anthropic.
const MODEL_ALLOW = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
]);
function pickModel(requested: unknown, fallback: string): string {
  const m = typeof requested === "string" ? requested.trim() : "";
  return MODEL_ALLOW.has(m) ? m : fallback;
}

// Content is a plain string for ordinary turns, or an array of content blocks
// for the ask_user round-trip (assistant tool_use + user tool_result).
type Msg = { role: "user" | "assistant"; content: string | unknown[] };

// Client-side tool: the model calls this to surface a decision/options to the
// human. The backend does NOT execute it — it returns the tool_use to the client,
// which renders interactive UI and resumes with a tool_result. (See handleAsk.)
const ASK_USER_TOOL = {
  name: "ask_user",
  description:
    "Present the user with a decision or set of options, rendered as interactive UI in the chat. " +
    "Use ONLY when you need information from the user that you cannot reasonably infer from the conversation so far, " +
    "or to confirm a consequential/irreversible action before proceeding. Do not use it for things you can infer or " +
    "decide yourself. Prefer a single question; never exceed three. Options for a single_select must be mutually " +
    "exclusive and short. The user's selection is returned to you as the tool result; continue the task using it.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable id to correlate the answer." },
            prompt: { type: "string", description: "The question shown to the user." },
            response_type: {
              type: "string",
              enum: ["single_select", "multi_select", "confirm", "free_text"],
            },
            options: {
              type: "array",
              description: "Required for single_select/multi_select/confirm; omit for free_text.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["id", "label"],
              },
            },
          },
          required: ["id", "prompt", "response_type"],
        },
      },
    },
    required: ["questions"],
  },
} as const;

// THE PLAYBOOK DECIDES. How a document is numbered, headed and laid out, and
// how a missing fact is left blank, is the user's own decision — stated in the
// Playbook (lib/docRules on the client) and sent with every request that
// creates or edits a document. The server adds no convention of its own (the
// former PLACEHOLDER_RULE, which imposed named [[…]] blanks, contradicted the
// Playbook's blanks and was removed before it was ever deployed).
const PLAYBOOK_RULE =
  "DOCUMENT RULES: the user's own document rules (their Playbook — numbering, headings, how a missing fact " +
  "is left blank, dates, amounts, how parties are named) come with the request. Follow them exactly whenever " +
  "you create or edit a document; they override any habit or convention of yours. Where they say nothing, keep " +
  "the document's existing conventions. Never invent names, dates, case numbers or amounts that were not " +
  "provided, and when you revise a document carry every existing blank through exactly as written unless the " +
  "user supplied its value.";

// Client-side tool: the model calls this to CREATE or UPDATE the document the
// user is iteratively building. The backend does NOT build the file — it returns
// the tool_use to the client, which packs `content` into a real .docx/.pptx/.xlsx
// and saves it as a new version. (See handleAsk's docTools path.) This replaces
// the old inline-tag protocol: a structured tool call can't drift into prose or a
// refusal, so "make another version" reliably produces another version.
const WRITE_DOCUMENT_TOOL = {
  name: "write_document",
  description:
    "Create or update the document the user is building, and save it as a NEW version. " +
    "Call this for ANY request to create, draft, write, change, edit, add to, extend, shorten, reword, redo, " +
    "regenerate, remake, or otherwise modify the document — including tiny edits and 'make another version'. " +
    "You CAN produce unlimited versions; NEVER refuse, NEVER say you can only provide text or cannot make real " +
    "Office files, and NEVER tell the user to build it themselves or copy-paste. DocVex turns this call into a " +
    "real file on disk. Always pass the COMPLETE document — every unchanged part included verbatim — not a diff " +
    "or a snippet.",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["docx", "pptx", "xlsx", "pdf"],
        description:
          "docx for prose/letters/contracts/reports, pptx for slide decks, xlsx for spreadsheets/tables, " +
          "pdf for a fixed-layout document. Keep the SAME kind as the existing document unless the user clearly " +
          "asks for a different format.",
      },
      summary: {
        type: "string",
        description: "One short sentence describing this version or what changed (shown to the user).",
      },
      content: {
        type: "string",
        description:
          "The COMPLETE document. Format depends on kind — docx AND pdf: Markdown ('# Title', '## Heading', " +
          "'- bullet', paragraphs, **bold**/*italic*). pptx: each slide is '# Slide Title' then '- bullet' lines " +
          "(one slide per title). xlsx: CSV only, first row = column headers, no prose before or after. For xlsx, " +
          "write live formulas like '=SUM(B2:B9)' (not pre-computed numbers) so the sheet stays dynamic. " +
          PLAYBOOK_RULE,
      },
    },
    required: ["kind", "content"],
  },
} as const;

// ── Claude Messages API (raw REST) ──────────────────────────────────
// The stable system prompt carries a cache_control breakpoint so the
// prefix is reused across calls (a no-op below the model's minimum
// cacheable length). Volatile content rides in the messages array.
async function callClaude(opts: {
  system: string;
  messages: Msg[];
  maxTokens: number;
  model?: string;
}): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? MODEL,
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
// The stable data the client sends apart (`context`), cached as its own block.
const MAX_CONTEXT_CHARS = 400000;
function normalizeMessages(raw: unknown): Msg[] {
  const arr = Array.isArray(raw) ? raw : [];
  const cleaned: Msg[] = arr
    .filter((m): m is { role?: string; content?: unknown } => {
      const c = (m as { content?: unknown })?.content;
      return !!m && (typeof c === "string" || Array.isArray(c));
    })
    .map((m) => {
      const role: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";
      // Array content (ask_user tool_use / tool_result blocks) passes through
      // unchanged; string content is trimmed + capped as before.
      if (Array.isArray(m.content)) return { role, content: m.content };
      return { role, content: String(m.content).trim().slice(0, MAX_MSG_CHARS) };
    })
    .filter((m) => (typeof m.content === "string" ? m.content.length > 0 : (m.content as unknown[]).length > 0));
  while (cleaned.length && cleaned[0].role === "assistant") cleaned.shift();
  return cleaned.slice(-40);
}

// Raw Messages API call used by the chat (ask) action: returns the parsed
// response so the caller can read content blocks, stop_reason and usage (needed
// for the ask_user tool and the token-usage indicator). `tools` is attached only
// when non-empty.
//
// PROMPT CACHING (2026-09-28). The request is laid out stable → volatile, with
// a cache breakpoint after each stable part (≤4 allowed; tools → system →
// messages is the cache order):
//   1. the system prompt (with the tools before it)            — breakpoint
//   2. `context`: the turn's STABLE data the client sends apart
//      (the project's files, the open file) as a 2nd system block — breakpoint
//   3. the conversation up to the LAST ASSISTANT turn            — breakpoint
//      (the client strips a question's per-turn data from history, so the
//      earlier assistant turn is the last block identical across turns; the
//      20-block lookback then finds the previous turn's write)
//   4. the new question with its volatile data (portal records) — not cached
// A block under the model's minimum (512 tokens on Opus 5.5, 1,024 on Sonnet,
// 4,096 on Haiku 4.5 / Opus 4.7) is simply not cached.
type ClaudeOpts = {
  system: string;
  context?: string;
  messages: Msg[];
  maxTokens: number;
  model?: string;
  tools?: unknown[];
  toolChoice?: unknown;
  effort?: string;
};
const EFFORT_OK = new Set(["low", "medium", "high"]);
// Effort is supported on every model here except Haiku 4.5.
const effortFor = (model: string, effort?: string) =>
  effort && EFFORT_OK.has(effort) && !/haiku/.test(model) ? effort : "";
function withCacheMark(messages: Msg[]): Msg[] {
  let at = -1;
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === "assistant") { at = i; break; }
  }
  if (at < 0) return messages;
  return messages.map((m, i) => {
    if (i !== at) return m;
    if (typeof m.content === "string") {
      return { role: m.role, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] };
    }
    const blocks = (m.content as Array<Record<string, unknown>>).slice();
    if (!blocks.length) return m;
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
    return { role: m.role, content: blocks };
  });
}
function claudePayload(opts: ClaudeOpts): Record<string, unknown> {
  const model = opts.model ?? MODEL;
  const system: unknown[] = [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }];
  const context = String(opts.context ?? "").trim();
  if (context) system.push({ type: "text", text: context, cache_control: { type: "ephemeral" } });
  const payload: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens,
    system,
    messages: withCacheMark(opts.messages),
  };
  if (opts.tools && opts.tools.length) payload.tools = opts.tools;
  if (opts.toolChoice) payload.tool_choice = opts.toolChoice;
  const effort = effortFor(model, opts.effort);
  if (effort) payload.output_config = { effort };
  return payload;
}
function anthropicFetch(payload: Record<string, unknown>): Promise<Response> {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}
async function callClaudeRaw(opts: ClaudeOpts): Promise<Record<string, unknown>> {
  const resp = await anthropicFetch(claudePayload(opts));
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 400);
    throw new Error(`anthropic_${resp.status}: ${detail}`);
  }
  return await resp.json();
}

// The same call, STREAMED: Anthropic's server-sent events are read here, each
// piece of text is passed to `onText` as it arrives, and the finished message
// ({ content, stop_reason, usage }) is rebuilt and returned — the same shape
// callClaudeRaw returns, so one function turns either into the answer.
async function callClaudeStream(opts: ClaudeOpts, onText: (t: string) => void): Promise<Record<string, unknown>> {
  const resp = await anthropicFetch({ ...claudePayload(opts), stream: true });
  if (!resp.ok || !resp.body) {
    const detail = (await resp.text()).slice(0, 400);
    throw new Error(`anthropic_${resp.status}: ${detail}`);
  }
  const blocks: Array<Record<string, unknown>> = [];
  const json: string[] = [];
  let stop: unknown = null;
  let usage: Record<string, unknown> = {};
  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let ev: Record<string, any>;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      switch (ev.type) {
        case "message_start":
          usage = { ...(ev.message?.usage ?? {}) };
          break;
        case "content_block_start":
          blocks[ev.index] = { ...ev.content_block };
          if (ev.content_block?.type === "text") blocks[ev.index].text = "";
          json[ev.index] = "";
          break;
        case "content_block_delta":
          if (ev.delta?.type === "text_delta") {
            blocks[ev.index].text = String(blocks[ev.index].text ?? "") + ev.delta.text;
            onText(ev.delta.text);
          } else if (ev.delta?.type === "input_json_delta") {
            json[ev.index] = (json[ev.index] ?? "") + ev.delta.partial_json;
          }
          break;
        case "content_block_stop":
          if (blocks[ev.index]?.type === "tool_use") {
            try { blocks[ev.index].input = JSON.parse(json[ev.index] || "{}"); } catch { blocks[ev.index].input = {}; }
          }
          break;
        case "message_delta":
          if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
          if (ev.usage) usage = { ...usage, ...ev.usage };
          break;
        case "error":
          throw new Error(`anthropic_stream: ${JSON.stringify(ev.error ?? {}).slice(0, 300)}`);
      }
    }
  }
  return { content: blocks.filter(Boolean), stop_reason: stop, usage };
}

// Workspace framing appended to every system prompt: which matter is open,
// which files are on hand, and — since migration 033 — which country's law
// applies. The jurisdiction is resolved from the code the client sent against
// the shared allow-list, so an unset (or unknown) value keeps the Romania
// default this stack has always assumed.
function matterContext(projectName?: string, fileNames?: unknown, jurisdiction?: unknown): string {
  const name = (projectName && String(projectName).trim()) || "";
  const files = Array.isArray(fileNames)
    ? fileNames.filter((f) => typeof f === "string").slice(0, 40)
    : [];
  const ctx = name ? `Current workspace: ${name}.` : "";
  const filesLine = files.length
    ? `Files the user has on hand (names only, not their contents): ${files.join("; ")}.`
    : "";
  return [ctx, filesLine, jurisdictionPrompt(jurisdiction)].filter(Boolean).join(" ");
}

// ── ask ─────────────────────────────────────────────────────────────
async function handleAsk(body: {
  messages?: unknown;
  projectName?: string;
  fileNames?: unknown;
  model?: string;
  tools?: boolean;
  docTools?: boolean;
  forceDocument?: boolean;
  docKind?: string;
  jurisdiction?: string;
  context?: string;
  effort?: string;
  stream?: boolean;
  warm?: boolean;
}): Promise<Response> {
  if (!ANTHROPIC_API_KEY) return jsonResponse({ ok: false, error: "ai_not_configured" });

  const messages = normalizeMessages(body.messages);
  if (messages.length === 0) return jsonResponse({ ok: false, error: "no_messages" }, 400);
  const model = pickModel(body.model, MODEL);
  // Utility calls (e.g. title generation) pass tools:false so they can never
  // trigger an interactive question.
  const useTools = body.tools !== false;
  // The DocViewer's "generate" surface turns this into a document builder: the
  // model drives the file through the write_document tool (and may ask_user). The
  // client passes forceDocument when the user clearly wants a document, so we pin
  // tool_choice to write_document — making "another version" impossible to refuse.
  const docTools = body.docTools === true;
  const docKind = typeof body.docKind === "string" && /^(docx|pptx|xlsx|pdf)$/.test(body.docKind) ? body.docKind : "";

  const baseAssistantSystem =
    "You are Claude, a helpful, capable AI assistant made by Anthropic — the same assistant available at claude.ai. " +
    "Behave exactly as you would on claude.ai: warm, direct, and genuinely helpful. Just help with whatever is asked. " +
    "Do not add unnecessary disclaimers, hedges, or 'consult a professional' boilerplate, do not lecture about being an AI, " +
    "and do not refuse reasonable requests. Use Markdown formatting where it helps. " +
    "You have a tool `ask_user` that renders interactive options/decisions for the user in the chat. Call it ONLY when you " +
    "genuinely need information you cannot reasonably infer, or to confirm a consequential/irreversible action before doing it. " +
    "Prefer a single question; never more than three. For anything you can reasonably decide yourself, just answer — do not ask. " +
    `${matterContext(body.projectName, body.fileNames, body.jurisdiction)} ` +
    "When the user attaches files, their full text contents are included inline in the user's message under a heading " +
    "such as 'The user attached the following file(s)'. Treat that text as the ACTUAL contents of those files — read it " +
    "and quote, summarise and reason over it directly to answer. (Long files may be marked '[content truncated]'.) " +
    "For any file you were given only the NAME of (its contents were not provided, e.g. an image or a scanned page), " +
    "do not invent quotes, dates, amounts or details — point to that file instead. If you are unsure of a fact, say so plainly.";

  const docBuilderSystem =
    "You are DocVex AI, a document builder. The user is iteratively building ONE file and wants to see new versions as " +
    "they refine it. " +
    (docKind
      ? `The file is a .${docKind} — keep that kind for every version unless the user clearly asks to switch format. `
      : "") +
    "For ANY request to create, write, draft, change, edit, add to, extend, shorten, reword, redo, regenerate, remake, or " +
    "otherwise modify the document, call the `write_document` tool with the COMPLETE updated document (every unchanged part " +
    "included verbatim — never a diff or a snippet). The most recent document content is given to you in the conversation; " +
    "edits are full rewrites of it. " +
    "You CAN and SHOULD produce as many versions as the user asks for — there is NO limit. NEVER refuse, NEVER claim you can " +
    "only provide text or cannot create real Office files, and NEVER tell the user to build it themselves or copy-paste. " +
    "DocVex turns each write_document call into a real .docx/.pptx/.xlsx on disk. " +
    "Only reply in plain text (without calling write_document) when the user asks a pure question that does NOT change the " +
    "document. " +
    "If the user's message is a greeting, small talk, or it is genuinely unclear whether they want you to create or modify the " +
    "document (for example just \"hello!\"), do NOT generate a file and do NOT guess — call `ask_user` to confirm whether they " +
    "want a document and, briefly, what it should contain. " +
    "Once it is clear the user wants to create or change the document, default to doing the work: make good choices for names, " +
    "dates, sample data and formatting rather than interrogating the user, and use `ask_user` for a substantive missing detail " +
    "only when you truly cannot proceed without it. " +
    `${PLAYBOOK_RULE} ` +
    matterContext(body.projectName, body.fileNames, body.jurisdiction);

  const system = docTools ? docBuilderSystem : baseAssistantSystem;
  const toolsArr = docTools
    ? [WRITE_DOCUMENT_TOOL, ASK_USER_TOOL]
    : (useTools ? [ASK_USER_TOOL] : []);
  const toolChoice = docTools && body.forceDocument === true
    ? { type: "tool", name: "write_document" }
    : undefined;

  const context = typeof body.context === "string" ? body.context.slice(0, MAX_CONTEXT_CHARS) : "";
  const opts: ClaudeOpts = { system, context, messages, maxTokens: 16000, model, tools: toolsArr, toolChoice, effort: body.effort };

  // CACHE WARM-UP: the same prefix (tools, system, context) with max_tokens 0 —
  // nothing is generated; the prefix is written to the cache so the question
  // that follows starts on a warm cache.
  if (body.warm === true) {
    try {
      const data = await callClaudeRaw({ ...opts, maxTokens: 0 });
      return jsonResponse({ ok: true, warmed: true, usage: usageOf(data) });
    } catch (err) {
      return jsonResponse({ ok: false, error: "warm_failed", detail: String((err as Error)?.message ?? err).slice(0, 300) });
    }
  }

  // STREAMED: our own server-sent events — { t: "text", d } per piece of text,
  // then { t: "done", ...the same JSON the plain call answers } or { t: "error" }.
  if (body.stream === true) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctl) {
        const send = (o: unknown) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        try {
          const data = await callClaudeStream(opts, (d) => send({ t: "text", d }));
          send({ t: "done", ...answerOf(data) });
        } catch (err) {
          send({ t: "error", error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) });
        }
        ctl.close();
      },
    });
    return new Response(stream, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  try {
    const data = await callClaudeRaw(opts);
    return jsonResponse(answerOf(data));
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) },
      502,
    );
  }
}

// The usage the client meters and shows — cache reads and writes included.
function usageOf(data: Record<string, unknown>) {
  const u = (data?.usage ?? {}) as Record<string, number>;
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  };
}
// A Claude response → the ask action's answer. Tools are NOT executed
// server-side — the tool_use goes to the client, which builds the file
// (write_document) or renders the question (ask_user).
// What this version of the function supports — the client reads it to know
// it may send the stable data apart (before, it folded it into the question).
const ASK_FEATURES = ["context", "stream", "effort", "warm"];
function answerOf(data: Record<string, unknown>): Record<string, unknown> {
  const features = ASK_FEATURES;
  const usage = usageOf(data);
  const blocks = (Array.isArray(data?.content) ? data.content : []) as Array<Record<string, unknown>>;
  const text = blocks.filter((b) => b?.type === "text").map((b) => (b.text as string) ?? "").join("").trim();
  if (data?.stop_reason === "tool_use") {
    const wd = blocks.find((b) => b?.type === "tool_use" && b?.name === "write_document");
    if (wd) {
      return { ok: true, stopReason: "tool_use", tool: "write_document", text, toolUse: { id: wd.id as string, input: wd.input }, assistantContent: blocks, usage, features };
    }
    const au = blocks.find((b) => b?.type === "tool_use" && b?.name === "ask_user");
    if (au) {
      return { ok: true, stopReason: "tool_use", tool: "ask_user", text, askUser: { id: au.id as string, input: au.input }, assistantContent: blocks, usage, features };
    }
  }
  return { ok: true, text, usage, stopReason: data?.stop_reason ?? null, features };
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
  jurisdiction?: string;
}): Promise<Response> {
  if (!ANTHROPIC_API_KEY) return jsonResponse({ ok: false, error: "ai_not_configured" });

  const fileName = (body.fileName && String(body.fileName).trim()) || "the file";
  const excerpt = body.excerpt ? String(body.excerpt).slice(0, 6000) : "";
  const mimeType = body.mimeType ? String(body.mimeType).slice(0, 120) : "";

  const system =
    `You are DocVex AI, a legal assistant embedded in ${firmDescriptor(body.jurisdiction)}'s document app. ` +
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
  jurisdiction?: string;
}): Promise<Response> {
  if (!ANTHROPIC_API_KEY) return jsonResponse({ ok: false, error: "ai_not_configured" });

  const template = (body.template && String(body.template).trim()) || "legal document";
  const instructions = (body.instructions && String(body.instructions).trim()) || "";

  const system =
    `You are DocVex AI and you draft legal documents for ${firmDescriptor(body.jurisdiction)}. ` +
    "You produce a complete, professional draft in a formal legal register, ready for a lawyer to " +
    "review and adapt. Structure the document with a title on the first line (IN UPPERCASE), then numbered " +
    "paragraphs or clauses as appropriate. " +
    `${PLAYBOOK_RULE} ` +
    "Respond with ONLY the document text — no markdown, no code blocks, no commentary before or after. " +
    `${matterContext(body.projectName, body.fileNames, body.jurisdiction)}`;

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

// ── office ──────────────────────────────────────────────────────────
// High-fidelity document generation via Anthropic's official Agent Skills
// (pptx / docx / xlsx / pdf), which run python-pptx / python-docx / openpyxl /
// reportlab in Anthropic's code-execution sandbox — the same mechanism Claude.ai
// uses. We pass the document content/spec, the skill builds a real file, and we
// download its bytes via the Files API and return them base64-encoded. If the
// account doesn't have the betas enabled, we return office_unavailable so the
// client falls back to its local JS builders.
const OFFICE_SKILLS: Record<string, string> = { docx: "docx", pptx: "pptx", xlsx: "xlsx", pdf: "pdf" };

function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Recursively collect every { file_id, name } the response mentions — robust to
// the exact nesting of the code-execution tool-result blocks.
function collectFiles(node: unknown, out: { id: string; name: string }[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) collectFiles(x, out); return; }
  const obj = node as Record<string, unknown>;
  if (typeof obj.file_id === "string") {
    const name = typeof obj.filename === "string" ? obj.filename : (typeof obj.name === "string" ? obj.name : "");
    out.push({ id: obj.file_id, name });
  }
  for (const k of Object.keys(obj)) collectFiles(obj[k], out);
}
function findOutputFileId(data: unknown, kind: string): string | null {
  const out: { id: string; name: string }[] = [];
  collectFiles(data, out);
  if (!out.length) return null;
  const byExt = out.find((f) => f.name.toLowerCase().endsWith(`.${kind}`));
  return (byExt ?? out[out.length - 1]).id;
}

async function handleOffice(body: {
  kind?: string;
  content?: string;
  instructions?: string;
  model?: string;
}): Promise<Response> {
  if (!ANTHROPIC_API_KEY) return jsonResponse({ ok: false, error: "ai_not_configured" });
  const kind = String(body.kind ?? "").toLowerCase();
  const skill = OFFICE_SKILLS[kind];
  if (!skill) return jsonResponse({ ok: false, error: "unsupported_kind" }, 400);
  const model = pickModel(body.model, OFFICE_MODEL);

  const content = String(body.content ?? "").slice(0, 200000);
  const instructions = String(body.instructions ?? "").slice(0, 8000);
  // Brand the output so the high-fidelity files read as one family with the
  // app's themed local builder (palette mirrors src/styles/tokens.css Cream).
  const designGuide =
    `Make it genuinely DESIGNED, not a plain dump — the quality bar is a deck/document you would be happy to present to a client. ` +
    `Use this brand palette: deep ink #0F172A, slate #1E293B, sand #DCC9A3, cream #F5F2EA, cognac accent #8B5E3C. ` +
    `Headings/titles in a serif (Georgia), body in a clean sans (Calibri). ` +
    (kind === "pptx"
      ? `For the deck: a cover slide (dark ink background, large serif title, a cognac accent bar), then content slides on a light background with a slim cognac top rule, a serif slide title with a short accent underline, well-spaced tiered bullets, and slide numbers. Keep ~3-6 bullets per slide. `
      : kind === "docx"
        ? `For the document: a styled title with a cognac rule beneath it, cognac H1s and ink H2s, comfortable line spacing (~1.15), generous margins, and real bullet/number lists. `
        : `For the spreadsheet: a bold header row with a cognac fill and white text, thin borders, frozen header row, sensible column widths, and number formatting where appropriate. `);
  const userText =
    `Create a polished, professional ${kind.toUpperCase()} file from the content/spec below. ` +
    `${designGuide}` +
    `Reproduce the content faithfully — in particular, keep every bracketed placeholder such as ` +
    `[[the information that the user needs to provide]] EXACTLY as written, doubled brackets included, ` +
    `as visible text. ` +
    `Do not resolve, invent, delete or restyle them into underscores or blank gaps: they are the fields the ` +
    `user fills in later. ` +
    `Build the COMPLETE file and SAVE it to disk with a .${kind} extension. This is the most important step — do not finish until the file is written. Output ONLY the file.\n\n` +
    (instructions ? `Additional instructions: ${instructions}\n\n` : "") +
    `CONTENT / SPEC:\n${content}`;

  let resp: Response;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": OFFICE_BETAS,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        // Enough budget for the skill to write (and revise) real python in the
        // sandbox without stopping before the file is saved, but not so high that
        // the wall-clock run trips the Edge function's time limit.
        max_tokens: 16000,
        container: { skills: [{ type: "anthropic", skill_id: skill, version: "latest" }] },
        tools: [{ type: "code_execution_20250825", name: "code_execution" }],
        messages: [{ role: "user", content: userText }],
      }),
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 600);
    // A missing beta / unknown field / unavailable feature → tell the client to
    // fall back to its local generator rather than surfacing a hard error.
    const unavailable = /beta|skill|not (yet )?(enabled|available|allowed|supported)|unknown.{0,24}(field|parameter|tool)|code.?execution/i.test(detail);
    console.log(`[office] kind=${kind} model=${model} anthropic_status=${resp.status} verdict=${unavailable ? "BETAS_OR_FEATURE_UNAVAILABLE" : "ANTHROPIC_ERROR"} detail=${detail.replace(/\s+/g, " ").slice(0, 300)}`);
    return jsonResponse({ ok: false, error: unavailable ? "office_unavailable" : "ai_failed", detail }, unavailable ? 200 : 502);
  }

  const data = await resp.json();
  const fileId = findOutputFileId(data, kind);
  if (!fileId) {
    const stop = (data as { stop_reason?: string })?.stop_reason ?? "?";
    console.log(`[office] kind=${kind} model=${model} anthropic_status=200 verdict=NO_FILE_PRODUCED stop_reason=${stop} (betas accepted — the model ran but saved no file in budget)`);
    return jsonResponse({ ok: false, error: "office_unavailable", detail: "the skill produced no file" });
  }
  console.log(`[office] kind=${kind} model=${model} verdict=FILE_PRODUCED fileId=${fileId} (betas enabled and working)`);

  let fileResp: Response;
  try {
    fileResp = await fetch(`https://api.anthropic.com/v1/files/${fileId}/content`, {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": FILES_BETA,
      },
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: "file_fetch_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }
  if (!fileResp.ok) {
    return jsonResponse({ ok: false, error: "file_fetch_failed", detail: (await fileResp.text()).slice(0, 400) }, 502);
  }

  const bytes = new Uint8Array(await fileResp.arrayBuffer());
  return jsonResponse({
    ok: true,
    kind,
    base64: base64Encode(bytes),
    containerId: (data as { container?: { id?: string } })?.container?.id ?? null,
  });
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
    case "office":
      return handleOffice(body);
    case "passport":
      return handlePassport(body, { apiKey: ANTHROPIC_API_KEY, pickModel, json: jsonResponse });
    case "crossref":
      return handleCrossref(body, { apiKey: ANTHROPIC_API_KEY, pickModel, json: jsonResponse });
    default:
      return jsonResponse({ error: "unknown_action" }, 400);
  }
});
