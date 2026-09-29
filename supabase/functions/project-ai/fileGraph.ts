// project-ai — THE FILE GRAPH: the AI scan's map and reduce steps, server side.
//
// The desktop app reads every file to text ON THE COMPUTER (OCR, captions, PDF
// / Word extraction) and caches what the AI makes of it per file. Only these
// two steps reach the model, and both go through here, where the Anthropic key
// lives:
//
//   { action: "passport", files: [{ id, name, text, method? }], jurisdiction?, model? }
//     MAP — one file's text (or a batch of ≤8) → its PASSPORT: summary, subject,
//     explicit facts, the people and companies named, dates, abstract themes
//     and concepts, what kind of document it is, and — for an identity document
//     — whose it is. Returns { ok, passports: [{ id, ...passport }], usage }.
//
//   { action: "crossref", passports: [{ id, name, ...passport }], jurisdiction?, model? }
//     REDUCE — every passport in the project AT ONCE (across collections) →
//     { ok, graph: { timeline, facts, links }, usage, dropped? }. A link is
//       { from_file_id, to_file_id, connection_type, explanation, confidence, evidence }
//     with `connection_type` one of CONNECTION_TYPES. The model never sees a
//     file's full text here — only passports — so a project of hundreds of
//     files fits one call.
//
// STRICT JSON: each call exposes ONE tool whose input_schema IS the answer's
// shape and pins `tool_choice` to it, so the model can only answer by filling
// that schema (no prose, no code fences to strip). What comes back is still
// VALIDATED here (`cleanPassport` / `cleanGraph`): unknown ids, self-links,
// types outside the enum, duplicates and empty strings are dropped, lengths
// capped — the client receives data it can store without checking again.
//
// PROMPTS: the stable instructions are the SYSTEM prompt with a cache_control
// breakpoint (reused across a scan's calls); the volatile data rides in the
// user turn inside XML tags — <file id name method>…</file> for the map step,
// <passport id name>…</passport> inside <passports> for the reduce step — with
// the task restated AFTER the data (long-context prompts answer better with
// the question at the end).
import { jurisdictionPrompt } from "../_shared/jurisdictions.ts";
import { callClaude } from "../_shared/claude.ts";

type Json = Record<string, unknown>;
export type GraphDeps = {
  configured: boolean;
  pickModel: (requested: unknown, fallback: string) => string;
  json: (body: unknown, status?: number) => Response;
};

// Sonnet 5 by default: fast enough for a scan of many batches, and the reduce
// step is judgement over short structured records, not long drafting.
const SCAN_MODEL = Deno.env.get("PROJECT_AI_SCAN_MODEL") ?? "claude-sonnet-5";

export const CONNECTION_TYPES = [
  "amends",          // changes, supplements or annexes the other (an addendum, an act amending a contract)
  "supersedes",      // replaces the other (a newer version, a renewed contract)
  "contradicts",     // states something incompatible with the other (different sums, dates, names, facts)
  "same_party",      // the same person or company appears in both
  "same_subject",    // about the same property, vehicle, case, contract or event
  "dependency",      // one only makes sense / is only valid with the other (a power of attorney used in a contract)
  "financial_link",  // money flows between them (an invoice paying a contract, a receipt, a bank transfer)
  "evidence_for",    // one proves or documents what the other claims
  "references",      // one cites the other explicitly (by number, date or title)
  "chronological",   // consecutive steps of one process (notice → reply → lawsuit)
] as const;
type ConnectionType = typeof CONNECTION_TYPES[number];

// ── Limits ────────────────────────────────────────────────────────────────
const MAX_BATCH = 8;                 // files per passport call
const MAX_FILE_CHARS = 40_000;       // text per file sent to the map step
const MAX_BATCH_CHARS = 120_000;     // text per passport call
const MAX_PASSPORTS = 400;           // passports per crossref call
const MAX_CROSSREF_CHARS = 220_000;  // serialised passports per crossref call

// ── The two tools (= the two answer shapes) ─────────────────────────────
const str = (description: string) => ({ type: "string", description });
const strList = (description: string) => ({ type: "array", items: { type: "string" }, description });

const PASSPORT_SCHEMA = {
  type: "object",
  properties: {
    id: str("The file's id exactly as given in its <file id=…> tag."),
    summary: str("ONE sentence: what this file is and what it establishes."),
    subject: str("Who or what the file is mainly about, named (\"SC Alfa SRL\", \"Apartamentul 21, Carmen Sylva\", \"dosar 1234/3/2026\")."),
    document_type: str("What kind of document it is, in a few words (\"lease contract\", \"identity card\", \"invoice\", \"court summons\", \"WhatsApp conversation\", \"photo of a receipt\")."),
    facts: {
      type: "array",
      description: "Facts the file states EXPLICITLY — never inferred. Numbers, sums, addresses, identifiers, obligations, deadlines.",
      items: {
        type: "object",
        properties: { label: str("What the fact is (\"Rent\", \"CNP\", \"Registered office\")."), value: str("The value, as written in the file.") },
        required: ["label", "value"],
      },
    },
    parties: {
      type: "array",
      description: "Every person and company the file names.",
      items: {
        type: "object",
        properties: {
          name: str("The name as written (full, with legal form for a company)."),
          kind: { type: "string", enum: ["person", "company", "institution"] },
          role: str("Their role in this file (\"landlord\", \"buyer\", \"witness\", \"issuing authority\"); \"\" when none."),
          identifiers: strList("CNP, CUI, registration numbers, ID card series — as written."),
        },
        required: ["name", "kind"],
      },
    },
    dates: {
      type: "array",
      description: "Dated events the file states.",
      items: {
        type: "object",
        properties: { date: str("ISO YYYY-MM-DD when the day is known, else YYYY-MM or YYYY."), event: str("What happened / is due on that date.") },
        required: ["date", "event"],
      },
    },
    themes: strList("3–8 ABSTRACT themes or legal concepts the file turns on (\"residential tenancy\", \"security deposit\", \"early termination\", \"identity verification\", \"debt recovery\") — what it is ABOUT, not what it names."),
    id_document: {
      type: "object",
      description: "ONLY when the file IS an identity document (ID card, passport, driving licence, residence permit); omit otherwise.",
      properties: { holder: str("The holder's full name."), type: str("Which document.") },
      required: ["holder"],
    },
  },
  required: ["id", "summary", "subject", "document_type", "facts", "parties", "dates", "themes"],
};

const PASSPORT_TOOL = {
  name: "record_passports",
  description: "Record the passport of every file in the request. Call it exactly once with one passport per <file>.",
  input_schema: {
    type: "object",
    properties: { passports: { type: "array", items: PASSPORT_SCHEMA } },
    required: ["passports"],
  },
};

const GRAPH_TOOL = {
  name: "record_cross_reference",
  description: "Record the project-wide cross-reference of the passports: the unified timeline, the unified facts and every typed link between files.",
  input_schema: {
    type: "object",
    properties: {
      timeline: {
        type: "array",
        description: "Every dated event across the files, merged (one entry per real event, even when several files mention it), oldest first.",
        items: {
          type: "object",
          properties: {
            date: str("ISO YYYY-MM-DD, or YYYY-MM / YYYY when that is all that is known."),
            event: str("What happened."),
            file_ids: strList("The ids of every file that states it."),
          },
          required: ["date", "event", "file_ids"],
        },
      },
      facts: {
        type: "array",
        description: "Facts that hold ACROSS files, unified per subject (the same value stated by several files is ONE fact). A fact the files disagree on is listed once per value.",
        items: {
          type: "object",
          properties: {
            subject: str("Who or what the fact is about."),
            label: str("What the fact is."),
            value: str("The value."),
            file_ids: strList("The ids of every file that states this value."),
          },
          required: ["subject", "label", "value", "file_ids"],
        },
      },
      links: {
        type: "array",
        description: "Typed links between two files. Only links the passports support; not every pair.",
        items: {
          type: "object",
          properties: {
            from_file_id: str("The id of the file the link starts from (for amends / supersedes / references / evidence_for / financial_link: the one that acts on the other)."),
            to_file_id: str("The id of the other file."),
            connection_type: { type: "string", enum: [...CONNECTION_TYPES] },
            explanation: str("The analytical insight: WHY these two files are linked and what the link means for the matter — concrete, naming the facts that tie them (\"The addendum of 12.03.2025 raises the rent set in art. 4 of the lease from 450 to 500 EUR\"), 1–3 sentences."),
            evidence: strList("The specific values from the passports that establish the link (a shared CUI, a matching sum, a cited number)."),
            confidence: { type: "number", minimum: 0, maximum: 1, description: "How sure the link is: ≥0.9 stated outright, 0.6–0.9 strongly implied, below 0.6 plausible only." },
          },
          required: ["from_file_id", "to_file_id", "connection_type", "explanation", "confidence"],
        },
      },
    },
    required: ["timeline", "facts", "links"],
  },
};

// ── Prompts ───────────────────────────────────────────────────────────────
const PASSPORT_SYSTEM = `You build the PASSPORT of case files for a law firm's document system: a compact, exact record of what each file is and says, used later to connect files across the whole project without reading them again.

<rules>
- Record only what the file itself states. Never infer, complete, correct or translate a value; copy names, numbers, identifiers and addresses exactly as written, diacritics included (Romanian ă â î ș ț).
- The text may come from OCR of a photograph or from an audio transcript: tolerate noise, but do not record a value you cannot read with confidence.
- Themes are abstract (the legal concepts and situations the file turns on); facts, parties and dates are concrete.
- Write summaries, labels, roles and themes in English; keep quoted values in the file's own language.
- A file with no usable text still gets a passport: say so in the summary and leave the lists empty.
</rules>

Answer ONLY by calling record_passports, once, with one passport per <file>, each carrying that file's id.`;

const GRAPH_SYSTEM = `You are a senior litigation analyst cross-referencing EVERY document of one legal matter at once. You receive one PASSPORT per file (a compact record of what the file states) and find how the files connect — including deep, non-obvious links a reader of any single file would miss: the same company under two spellings, a sum in an invoice matching a contract clause, an addendum changing an earlier term, two documents disagreeing about a date, a power of attorney a later contract depends on.

<connection_types>
${CONNECTION_TYPES.join(", ")}
- amends: changes, supplements or annexes the other.   - supersedes: replaces it (newer version, renewal).
- contradicts: states something incompatible with it.   - same_party: the same person or company is in both.
- same_subject: same property / vehicle / case / contract / event.   - dependency: only valid or meaningful with the other.
- financial_link: money flows between them.   - evidence_for: proves or documents what the other claims.
- references: cites the other explicitly.   - chronological: consecutive steps of one process.
</connection_types>

<rules>
- Every link must be supported by the passports; put the values that establish it in "evidence". Do not link files merely for being in the same matter.
- Treat names as the same party when they plainly are (diacritics, case, legal form, word order, an identifier in common) — and say so in the explanation.
- Prefer the most specific type; when two files are linked in two different ways, give two links.
- A contradiction is always worth reporting, with both values.
- Timeline and facts are UNIFIED: one entry per real event or fact, listing every file that states it.
- Use only the file ids given. Write explanations in English, quoting values as the files write them.
</rules>

Answer ONLY by calling record_cross_reference, once.`;

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: unknown) => esc(s).replace(/"/g, "&quot;");

// ── The call ─────────────────────────────────────────────────────────────
async function callTool(deps: GraphDeps, opts: { system: string; user: string; tool: Json; model: string; maxTokens: number }) {
  // Through the shared transport (Vertex AI EU, or api.anthropic.com as fallback).
  const resp = await callClaude({
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    tools: [opts.tool],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: [{ role: "user", content: opts.user }],
  });
  if (!resp.ok) throw new Error(`anthropic_${resp.status}: ${(await resp.text()).slice(0, 400)}`);
  const data = await resp.json();
  const block = (data?.content ?? []).find((b: Json) => b?.type === "tool_use" && b?.name === opts.tool.name);
  const u = (data?.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  return {
    input: (block?.input ?? null) as Json | null,
    truncated: data?.stop_reason === "max_tokens",
    usage: { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 },
  };
}

// ── Cleaning what came back ──────────────────────────────────────────────
const s = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ids = (v: unknown, known: Set<string>) => [...new Set(arr(v).map((x) => s(x, 200)).filter((x) => known.has(x)))];

function cleanPassport(p: Json) {
  const idDoc = p.id_document as Json | undefined;
  const holder = s(idDoc?.holder, 200);
  return {
    summary: s(p.summary, 600),
    subject: s(p.subject, 200),
    document_type: s(p.document_type, 120),
    facts: arr(p.facts).map((f) => ({ label: s((f as Json)?.label, 120), value: s((f as Json)?.value, 600) })).filter((f) => f.label && f.value).slice(0, 80),
    parties: arr(p.parties).map((x) => {
      const q = x as Json;
      const kind = ["person", "company", "institution"].includes(String(q?.kind)) ? String(q.kind) : "person";
      return { name: s(q?.name, 200), kind, role: s(q?.role, 120), identifiers: arr(q?.identifiers).map((i) => s(i, 80)).filter(Boolean).slice(0, 10) };
    }).filter((q) => q.name).slice(0, 40),
    dates: arr(p.dates).map((d) => ({ date: s((d as Json)?.date, 20), event: s((d as Json)?.event, 300) })).filter((d) => d.date && d.event).slice(0, 60),
    themes: [...new Set(arr(p.themes).map((t) => s(t, 80).toLowerCase()).filter(Boolean))].slice(0, 8),
    id_document: holder ? { holder, type: s(idDoc?.type, 80) } : null,
  };
}

function cleanGraph(g: Json, known: Set<string>) {
  const timeline = arr(g.timeline).map((x) => {
    const t = x as Json;
    return { date: s(t?.date, 20), event: s(t?.event, 400), file_ids: ids(t?.file_ids, known) };
  }).filter((t) => t.date && t.event && t.file_ids.length)
    .sort((a, b) => a.date.localeCompare(b.date));
  const facts = arr(g.facts).map((x) => {
    const f = x as Json;
    return { subject: s(f?.subject, 200), label: s(f?.label, 120), value: s(f?.value, 600), file_ids: ids(f?.file_ids, known) };
  }).filter((f) => f.label && f.value && f.file_ids.length);
  const seen = new Set<string>();
  const links = arr(g.links).map((x) => {
    const l = x as Json;
    const type = String(l?.connection_type) as ConnectionType;
    const conf = typeof l?.confidence === "number" && Number.isFinite(l.confidence) ? Math.min(1, Math.max(0, l.confidence)) : 0.5;
    return {
      from_file_id: s(l?.from_file_id, 200),
      to_file_id: s(l?.to_file_id, 200),
      connection_type: (CONNECTION_TYPES as readonly string[]).includes(type) ? type : null,
      explanation: s(l?.explanation, 1200),
      evidence: arr(l?.evidence).map((e) => s(e, 200)).filter(Boolean).slice(0, 8),
      confidence: Math.round(conf * 100) / 100,
    };
  }).filter((l) => {
    if (!l.connection_type || !l.explanation) return false;
    if (!known.has(l.from_file_id) || !known.has(l.to_file_id) || l.from_file_id === l.to_file_id) return false;
    // One link per pair and type; a symmetric type counts either way round.
    const symmetric = ["contradicts", "same_party", "same_subject"].includes(l.connection_type as string);
    const pair = symmetric ? [l.from_file_id, l.to_file_id].sort().join("|") : `${l.from_file_id}>${l.to_file_id}`;
    const key = `${pair}|${l.connection_type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.confidence - a.confidence);
  return { timeline, facts, links };
}

// ── passport (MAP) ───────────────────────────────────────────────────────
export async function handlePassport(body: Json, deps: GraphDeps): Promise<Response> {
  if (!deps.configured) return deps.json({ ok: false, error: "ai_not_configured" });
  const files = arr(body.files).map((f) => {
    const q = f as Json;
    return { id: s(q?.id, 200), name: s(q?.name, 300), method: s(q?.method, 40), text: typeof q?.text === "string" ? q.text.slice(0, MAX_FILE_CHARS) : "" };
  }).filter((f) => f.id);
  if (!files.length) return deps.json({ ok: false, error: "no_files" }, 400);
  if (files.length > MAX_BATCH) return deps.json({ ok: false, error: "too_many_files", max: MAX_BATCH }, 400);
  if (new Set(files.map((f) => f.id)).size !== files.length) return deps.json({ ok: false, error: "duplicate_ids" }, 400);
  // The batch shares one budget: an oversized file is cut to its share.
  const total = files.reduce((n, f) => n + f.text.length, 0);
  const share = total > MAX_BATCH_CHARS ? Math.floor(MAX_BATCH_CHARS / files.length) : Infinity;

  const user = [
    "<files>",
    ...files.map((f) => `<file id="${attr(f.id)}" name="${attr(f.name)}" method="${attr(f.method || "text")}">\n${esc(share < f.text.length ? `${f.text.slice(0, share)}\n[…]` : f.text)}\n</file>`),
    "</files>",
    jurisdictionPrompt(body.jurisdiction),
    `Record the passport of each of the ${files.length} file(s) above.`,
  ].filter(Boolean).join("\n");

  try {
    const res = await callTool(deps, {
      system: PASSPORT_SYSTEM,
      user,
      tool: PASSPORT_TOOL,
      model: deps.pickModel(body.model, SCAN_MODEL),
      maxTokens: Math.min(32_000, 3_000 * files.length + 2_000),
    });
    const byId = new Map<string, Json>();
    for (const p of arr(res.input?.passports)) {
      const id = s((p as Json)?.id, 200);
      if (id && !byId.has(id)) byId.set(id, p as Json);
    }
    const passports = files.filter((f) => byId.has(f.id)).map((f) => ({ id: f.id, name: f.name, ...cleanPassport(byId.get(f.id)!) }));
    // A file the model left out is reported, not invented: the client retries it.
    const missing = files.filter((f) => !byId.has(f.id)).map((f) => f.id);
    return deps.json({ ok: true, passports, missing, truncated: res.truncated || undefined, usage: res.usage });
  } catch (err) {
    return deps.json({ ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }
}

// ── crossref (REDUCE) ────────────────────────────────────────────────────
// A passport as the model reads it: compact, one XML element per file. Themes
// and parties lead — they are what links are made of.
function passportXml(p: Json) {
  const parties = arr(p.parties).map((x) => {
    const q = x as Json;
    const idsTxt = arr(q?.identifiers).map((i) => s(i, 80)).filter(Boolean).join(", ");
    return `${s(q?.name, 200)} (${s(q?.kind, 20) || "person"}${s(q?.role, 80) ? `, ${s(q?.role, 80)}` : ""}${idsTxt ? `; ${idsTxt}` : ""})`;
  }).filter((t) => !t.startsWith(" ("));
  const lines = [
    `type: ${s(p.document_type, 120)}`,
    `subject: ${s(p.subject, 200)}`,
    `summary: ${s(p.summary, 600)}`,
    `themes: ${arr(p.themes).map((t) => s(t, 80)).filter(Boolean).join("; ")}`,
    parties.length ? `parties: ${parties.join("; ")}` : "",
    ...arr(p.facts).slice(0, 40).map((f) => `fact: ${s((f as Json)?.label, 120)} = ${s((f as Json)?.value, 400)}`),
    ...arr(p.dates).slice(0, 30).map((d) => `date: ${s((d as Json)?.date, 20)} — ${s((d as Json)?.event, 300)}`),
    (p.id_document as Json)?.holder ? `identity document of: ${s((p.id_document as Json).holder, 200)}` : "",
  ].filter((l) => l && !/: $/.test(l));
  return `<passport id="${attr(p.id)}" name="${attr(p.name)}">\n${esc(lines.join("\n"))}\n</passport>`;
}

export async function handleCrossref(body: Json, deps: GraphDeps): Promise<Response> {
  if (!deps.configured) return deps.json({ ok: false, error: "ai_not_configured" });
  const seenIds = new Set<string>();
  const all = arr(body.passports).map((p) => p as Json).filter((p) => {
    const id = s(p?.id, 200);
    if (!id || seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
  if (all.length < 2) return deps.json({ ok: true, graph: { timeline: [], facts: [], links: [] }, usage: { input_tokens: 0, output_tokens: 0 } });
  // Within the budget, in the order given (the client sends the most relevant
  // first); what doesn't fit is reported back, never silently lost.
  const kept: Json[] = [];
  const dropped: string[] = [];
  let size = 0;
  for (const p of all) {
    const xml = passportXml(p);
    if (kept.length >= MAX_PASSPORTS || size + xml.length > MAX_CROSSREF_CHARS) { dropped.push(s(p.id, 200)); continue; }
    kept.push({ ...p, __xml: xml });
    size += xml.length;
  }
  const known = new Set(kept.map((p) => s(p.id, 200)));

  const user = [
    `<passports count="${kept.length}">`,
    ...kept.map((p) => p.__xml as string),
    "</passports>",
    jurisdictionPrompt(body.jurisdiction),
    `Cross-reference all ${kept.length} passports above: the unified timeline, the unified facts, and every typed link between files that they support — the deep and non-obvious ones included.`,
  ].filter(Boolean).join("\n");

  try {
    const res = await callTool(deps, {
      system: GRAPH_SYSTEM,
      user,
      tool: GRAPH_TOOL,
      model: deps.pickModel(body.model, SCAN_MODEL),
      maxTokens: 32_000,
    });
    if (!res.input) return deps.json({ ok: false, error: "no_answer", usage: res.usage }, 502);
    const graph = cleanGraph(res.input, known);
    return deps.json({ ok: true, graph, dropped: dropped.length ? dropped : undefined, truncated: res.truncated || undefined, usage: res.usage });
  } catch (err) {
    return deps.json({ ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) }, 502);
  }
}
