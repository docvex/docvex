// legal-assist — Claude backend for the DocVex Legal AI Word add-in.
//
// The add-in (an Office.js taskpane that loads inside Microsoft Word —
// see docs/word-addin/) reads the open document's text via Office.js and
// POSTs it here with a `task`. Claude analyses it and returns markdown the
// taskpane renders. verify_jwt stays ON: the taskpane signs the user in
// with their DocVex (Supabase) credentials, so supabase-js attaches the
// session JWT and only DocVex users can spend the firm's Anthropic budget.
//
// Request body:
//   {
//     task: "summary" | "risks" | "romanian" | "ask",
//     documentText: string,          // full document body text
//     selectionText?: string,        // currently highlighted text, if any
//     question?: string              // free-form question (task === "ask")
//   }
// Response: { ok: true, answer: string } | { ok: false, error: string }
//
// Claude is called over raw REST (x-api-key), the same shape as legal-ai —
// no SDK to bundle into the Deno runtime. Model defaults to claude-opus-4-7
// and is overridable via LEGAL_ASSIST_MODEL / LEGAL_AI_MODEL.
//
// Required Edge Function secrets (shared with legal-ai, already configured):
//   ANTHROPIC_API_KEY — Claude API key
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
const MODEL =
  Deno.env.get("LEGAL_ASSIST_MODEL") ??
  Deno.env.get("LEGAL_AI_MODEL") ??
  "claude-opus-4-7";

// Keep the document payload bounded — generous enough for long contracts,
// capped so a runaway paste can't blow up cost / latency.
const MAX_DOC_CHARS = 40000;
const MAX_SELECTION_CHARS = 8000;
const MAX_QUESTION_CHARS = 2000;

type Task = "summary" | "risks" | "romanian" | "ask";
const VALID_TASKS: Task[] = ["summary", "risks", "romanian", "ask"];

// ── Claude Messages API (raw REST) ──────────────────────────────────
// The stable role/instructions prompt carries a cache_control breakpoint
// so the prefix is reused across calls; the volatile document text goes in
// the user message after the breakpoint.
async function callClaude(opts: { system: string; user: string; maxTokens: number }): Promise<string> {
  const body = {
    model: MODEL,
    max_tokens: opts.maxTokens,
    system: [
      { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: opts.user }],
  };

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
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

// Shared persona: a Romanian legal assistant. Each task layers its own
// instruction on top. Responses are markdown (the taskpane renders a small
// subset: headings, bold, lists, paragraphs).
const BASE_SYSTEM =
  "You are DocVex Legal AI, an assistant for a Romanian law firm working inside " +
  "Microsoft Word. You are given the text of a legal document the lawyer has open. " +
  "Be precise, neutral, and practical; cite concrete dates, parties, amounts, deadlines, " +
  "and article/clause references when they appear in the text. Never invent facts that are " +
  "not in the document — if something is missing or ambiguous, say so explicitly. " +
  "Write in clear Markdown (use ## headings, **bold**, and - bullet lists). " +
  "Answer in Romanian by default; if the user's question is written in another language, " +
  "answer in that language.";

function instructionFor(task: Task, question: string): string {
  switch (task) {
    case "summary":
      return (
        "Task: Summarise this document for a busy lawyer.\n" +
        "Produce: a one-paragraph overview, then a `## Puncte cheie` bullet list of the key terms " +
        "(parties, object, value, duration, governing law), then a `## Obligații & termene` list of " +
        "the concrete obligations and deadlines."
      );
    case "risks":
      return (
        "Task: Review this document for legal risk.\n" +
        "Produce: `## Clauze riscante` (risky / one-sided / unusual clauses, each with a short why and the " +
        "clause reference), `## Lipsuri` (important clauses or protections that appear to be MISSING), and " +
        "`## Clauze esențiale` (extract the key clauses: parties, termen/durată, valoare, penalități, " +
        "reziliere, jurisdicție). Rank risky clauses high→low."
      );
    case "romanian":
      return (
        "Task: Assess this document against Romanian law and compliance practice.\n" +
        "Produce: `## Conformitate` (does it align with relevant Romanian legislation — Codul civil, Codul " +
        "muncii, GDPR/Legea 190/2018, fiscal rules, etc., as applicable — note specific concerns), " +
        "`## Referințe legale` (the Romanian laws/articles that govern the matters in this document), and " +
        "`## Recomandări` (concrete suggested fixes). Flag anything that may be unenforceable or " +
        "non-compliant under Romanian law. Make clear this is informational, not formal legal advice."
      );
    case "ask":
    default:
      return (
        "Task: Answer the user's question about this document.\n" +
        `User question: ${question}`
      );
  }
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (!ANTHROPIC_API_KEY) return jsonResponse({ ok: false, error: "ai_not_configured" }, 500);

  let body: {
    task?: string;
    documentText?: string;
    selectionText?: string;
    question?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  const task = (body.task ?? "") as Task;
  if (!VALID_TASKS.includes(task)) {
    return jsonResponse({ ok: false, error: "unknown_task" }, 400);
  }

  const documentText = (body.documentText ?? "").trim().slice(0, MAX_DOC_CHARS);
  const selectionText = (body.selectionText ?? "").trim().slice(0, MAX_SELECTION_CHARS);
  const question = (body.question ?? "").trim().slice(0, MAX_QUESTION_CHARS);

  if (task === "ask" && !question) {
    return jsonResponse({ ok: false, error: "missing_question" }, 400);
  }
  if (!documentText) {
    return jsonResponse({ ok: false, error: "empty_document" }, 400);
  }

  const user =
    `${instructionFor(task, question)}\n\n` +
    (selectionText
      ? `The lawyer has highlighted this part of the document — focus on it where relevant:\n"""\n${selectionText}\n"""\n\n`
      : "") +
    `Full document text:\n"""\n${documentText}\n"""`;

  try {
    const answer = await callClaude({
      system: BASE_SYSTEM,
      user,
      maxTokens: task === "ask" ? 1200 : 1800,
    });
    return jsonResponse({ ok: true, answer });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) },
      502,
    );
  }
});
