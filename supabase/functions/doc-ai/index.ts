// doc-ai — Claude backend for the in-app Legal AI document viewer.
//
// When a user opens a file in DocVex it shows in a dedicated window
// (src/pages/DocViewer.jsx): the document preview + a Legal AI task pane
// with Draft / Review / Ask tabs. The pane extracts the document's text in
// the renderer and POSTs it here; Claude responds and the pane renders /
// applies the result.
//
// verify_jwt stays ON: the viewer window shares the user's DocVex
// (Supabase) session, so supabase-js attaches the JWT and only DocVex
// users can spend the firm's Anthropic budget.
//
// Actions (dispatched on `task`):
//   "ask"      { documentText, question }              -> { ok, answer }   (markdown)
//   "summary" | "risks" | "romanian" { documentText }  -> { ok, answer }   (markdown)
//   "draft"    { documentText, instruction, clause? }  -> { ok, text }     (revised/new clause)
//   "review"   { playbook, paragraphs: string[] }      -> { ok, findings } (JSON)
//        findings: [{ paragraphIndex, issue, severity:"high"|"medium"|"low", suggestion }]
//   "ocr"      { image: base64, mediaType }            -> { ok, text }     (exact transcription)
//        backs the DocViewer's "Extract text" selection tool on photos /
//        paused video frames; runs on a cheap fast model (DOC_AI_OCR_MODEL).
// Claude is reached through ../_shared/claudeTransport.ts — Anthropic's API
// (ANTHROPIC_API_KEY) or, with CLAUDE_PROVIDER=bedrock, Amazon Bedrock in an
// EU region. Model defaults to claude-opus-4-7 (override via DOC_AI_MODEL /
// LEGAL_AI_MODEL). There is no audio transcription: it was OpenAI's (Whisper)
// and OpenAI was removed from the stack.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { claudeConfigured, claudeMessages } from "../_shared/claudeTransport.ts";

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

const MODEL =
  Deno.env.get("DOC_AI_MODEL") ??
  Deno.env.get("LEGAL_AI_MODEL") ??
  "claude-opus-4-7";
// OCR is plain transcription — a fast cheap model does it as well as Opus.
const OCR_MODEL = Deno.env.get("DOC_AI_OCR_MODEL") ?? "claude-haiku-4-5-20251001";

const MAX_DOC_CHARS = 40000;
const MAX_QUESTION_CHARS = 2000;
const MAX_PLAYBOOK_CHARS = 4000;
const MAX_PARAGRAPHS = 200;

// ── Claude Messages API (raw REST) ──────────────────────────────────
async function callClaude(opts: {
  system: string;
  // A plain string, or an array of content blocks (the OCR task sends an
  // image block + a text block).
  user: string | unknown[];
  maxTokens: number;
  jsonSchema?: Record<string, unknown>;
  model?: string;
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model ?? MODEL,
    max_tokens: opts.maxTokens,
    system: [
      { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: opts.user }],
  };
  if (opts.jsonSchema) {
    body.output_config = { format: { type: "json_schema", schema: opts.jsonSchema } };
  }

  const resp = await claudeMessages(body);

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

const BASE_SYSTEM =
  "You are DocVex Legal AI, an assistant for a Romanian law firm. You work with the text of a " +
  "legal document a lawyer has open. Be precise, neutral, and practical; cite concrete dates, " +
  "parties, amounts, deadlines, and article/clause references when they appear in the text. Never " +
  "invent facts that are not in the document — if something is missing or ambiguous, say so. " +
  "Answer in Romanian by default; if the user writes in another language, answer in that language.";

// ── ask / summary / risks / romanian (markdown answers) ─────────────
function instructionFor(task: string, question: string): string {
  switch (task) {
    case "summary":
      return "Task: Summarise this document for a busy lawyer. Use Markdown: a one-paragraph overview, " +
        "then `## Puncte cheie` (key terms), then `## Obligații & termene` (obligations + deadlines).";
    case "risks":
      return "Task: Review for legal risk. Markdown: `## Clauze riscante`, `## Lipsuri` (missing protections), " +
        "`## Clauze esențiale`. Rank risky clauses high→low.";
    case "romanian":
      return "Task: Assess against Romanian law/compliance. Markdown: `## Conformitate`, `## Referințe legale`, " +
        "`## Recomandări`. Flag anything potentially unenforceable. This is informational, not formal legal advice.";
    case "ask":
    default:
      return `Task: Answer the user's question about this document.\nUser question: ${question}`;
  }
}

async function handleText(task: string, body: Record<string, string>): Promise<Response> {
  const documentText = (body.documentText ?? "").trim().slice(0, MAX_DOC_CHARS);
  const question = (body.question ?? "").trim().slice(0, MAX_QUESTION_CHARS);
  if (task === "ask" && !question) return jsonResponse({ ok: false, error: "missing_question" }, 400);
  if (!documentText) return jsonResponse({ ok: false, error: "empty_document" }, 400);

  const user =
    `${instructionFor(task, question)}\n\nWrite in clear Markdown (## headings, **bold**, - lists).\n\n` +
    `Document text:\n"""\n${documentText}\n"""`;
  try {
    const answer = await callClaude({ system: BASE_SYSTEM, user, maxTokens: task === "ask" ? 1200 : 1800 });
    return jsonResponse({ ok: true, answer });
  } catch (err) {
    return jsonResponse({ ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }
}

// ── draft (rewrite the given clause, or draft a new one) ────────────
async function handleDraft(body: Record<string, string>): Promise<Response> {
  const documentText = (body.documentText ?? "").trim().slice(0, MAX_DOC_CHARS);
  const instruction = (body.instruction ?? "").trim().slice(0, MAX_QUESTION_CHARS);
  const clause = (body.clause ?? "").trim().slice(0, 8000);
  if (!instruction) return jsonResponse({ ok: false, error: "missing_instruction" }, 400);

  const user = clause
    ? `You are a meticulous legal drafting assistant. Rewrite the clause per the instruction. Return ONLY ` +
      `the revised clause text — no preamble, no quotes, no markdown.\n\nInstruction: ${instruction}\n\nClause to rewrite:\n${clause}`
    : `You are a meticulous legal drafting assistant. Draft a single clause from the instruction, consistent ` +
      `with the surrounding agreement. Return ONLY the clause text — no preamble, no markdown.\n\n` +
      `Existing agreement:\n${documentText}\n\nDraft a clause: ${instruction}`;
  try {
    const text = await callClaude({ system: BASE_SYSTEM, user, maxTokens: 900 });
    return jsonResponse({ ok: true, text });
  } catch (err) {
    return jsonResponse({ ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }
}

// ── review (playbook → structured findings) ─────────────────────────
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          paragraphIndex: { type: "integer" },
          issue: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          suggestion: { type: "string" },
        },
        required: ["paragraphIndex", "issue", "severity", "suggestion"],
      },
    },
  },
  required: ["findings"],
};

async function handleReview(body: { playbook?: string; paragraphs?: unknown }): Promise<Response> {
  const playbook = (body.playbook ?? "").trim().slice(0, MAX_PLAYBOOK_CHARS);
  const paragraphs = Array.isArray(body.paragraphs)
    ? (body.paragraphs as unknown[]).slice(0, MAX_PARAGRAPHS).map((p) => String(p ?? ""))
    : [];
  if (paragraphs.length === 0) return jsonResponse({ ok: false, error: "empty_document" }, 400);

  const numbered = paragraphs.map((p, i) => `[${i}] ${p}`).join("\n\n").slice(0, MAX_DOC_CHARS);
  const system =
    BASE_SYSTEM +
    " You are acting as a contract-review engine. Check the document against the playbook and return ONLY " +
    "the findings. For each problematic paragraph: `paragraphIndex` (the [n] index), a one-sentence `issue` " +
    "in Romanian, a `severity` (high/medium/low), and a `suggestion` — a FULL revised version of that " +
    "paragraph, in Romanian, ready to drop in. Omit compliant paragraphs.";
  const user = `PLAYBOOK:\n${playbook}\n\nDOCUMENT (paragraphs indexed):\n${numbered}`;
  try {
    const raw = await callClaude({ system, user, maxTokens: 2500, jsonSchema: REVIEW_SCHEMA });
    let parsed: { findings?: unknown };
    try { parsed = JSON.parse(raw); } catch { parsed = { findings: [] }; }
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    return jsonResponse({ ok: true, findings });
  } catch (err) {
    return jsonResponse({ ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }
}

// ── ocr (image region → exact text transcription) ───────────────────
const OCR_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// Claude caps images at ~5 MB binary; reject oversized uploads before paying
// for the round-trip (base64 inflates ~4/3).
const MAX_IMAGE_B64 = 7_000_000;

async function handleOcr(body: { image?: string; mediaType?: string }): Promise<Response> {
  const image = String(body.image ?? "").trim();
  const mediaType = OCR_MEDIA_TYPES.has(String(body.mediaType)) ? String(body.mediaType) : "image/jpeg";
  if (!image) return jsonResponse({ ok: false, error: "missing_image" }, 400);
  if (image.length > MAX_IMAGE_B64) return jsonResponse({ ok: false, error: "image_too_large" }, 400);

  const system =
    "You are a precise OCR engine. Transcribe the text visible in the image exactly as written — " +
    "same language, same casing, same punctuation, preserving line breaks and reading order. Do not " +
    "translate, correct, summarise, or describe the image. Output ONLY the transcribed text. If no " +
    "readable text is present, output exactly: [no text]";
  const user = [
    { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
    { type: "text", text: "Transcribe all text in this image." },
  ];
  try {
    const answer = await callClaude({ system, user, maxTokens: 2000, model: OCR_MODEL });
    const text = /^\[no text\]$/i.test(answer.trim()) ? "" : answer;
    return jsonResponse({ ok: true, text });
  } catch (err) {
    return jsonResponse({ ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  const task = String(body.task ?? "");

  if (!claudeConfigured()) return jsonResponse({ ok: false, error: "ai_not_configured" }, 500);

  switch (task) {
    case "ask":
    case "summary":
    case "risks":
    case "romanian":
      return handleText(task, body as Record<string, string>);
    case "draft":
      return handleDraft(body as Record<string, string>);
    case "review":
      return handleReview(body as { playbook?: string; paragraphs?: unknown });
    case "ocr":
      return handleOcr(body as { image?: string; mediaType?: string });
    default:
      return jsonResponse({ ok: false, error: "unknown_task" }, 400);
  }
});
