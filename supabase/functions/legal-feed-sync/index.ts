// legal-feed-sync — fills the Legal Newsfeed from Monitorul Oficial.
//
// WHO READS THE PORTAL. Not this function: legislatie.just.ro refuses Supabase's
// servers (it geo-checks every caller — its nginx stamps `X-Country` and
// `X-Block` on each answer — and from the eu-west-1 region every connection is
// dropped, even for its public home page). The DESKTOP APP reads it instead,
// over the user's own Romanian connection, through the same main-process
// channel the Legislation tab uses (`lib/legalFeedSync.js`): it asks this
// function where to start (`plan`), walks the new Monitorul Oficial issues,
// and hands the records over (`submit`). Everything that needs judgement or
// money happens here:
//
//   1. forget the acts already judged (`legal_feed_acts`);
//   2. drop, for free, what the record alone shows to concern no client — a
//      citizenship decree, a rectification, one school's accreditation
//      (portal.freeVerdict) — and fold an act's annexes into it;
//   3. ask a small model which of the rest a Romanian business-law practice
//      needs to know about (one call per 40 acts, titles only);
//   4. for each of those, have Claude read the act and write the feed row:
//      a headline, a Romanian brief, category, impact, affected areas;
//   5. record every verdict, so nothing is judged or paid for twice and any
//      "why isn't X in the feed?" has an answer in the table.
//
// Summaries are capped per submission (MAX_INGEST); what doesn't fit waits in
// `legal_feed_acts` as `relevant`, WITH its text (`body`), and goes first next
// time. A failure is retried on later submissions, three times at most.
//
// WHO MAY SUBMIT: app admins (`is_app_admin`), and an operator holding the
// Vault key `legal_feed_operator_key` as the `x-feed-key` header (migration
// 039 — for backfills and checks without the app). The feed is global and
// presented as the law; accepting records from any account would let anyone
// publish invented legislation to every user. The records are also checked to
// be what the portal sends (a legislatie.just.ro document link, an issue of
// the year being walked).
//
// Actions (POST, with the user's JWT):
//   { action: "plan" }
//       → { ok, busy?, years: [{ year, start }] } — where to start walking
//         (`start` null = nothing remembered; the app takes its own bearing).
//         Takes a 10-minute lease so two open apps don't both walk.
//   { action: "submit", year, lastIssue, records, dryRun?, final? }
//       → 202 { started } — judged in the background; `final` releases the
//         lease and records `lastIssue`. With dryRun: the decisions, nothing
//         written, nothing summarised (still one screening call).
//
// Secrets: ANTHROPIC_API_KEY (shared with legal-ai). Optional: LEGAL_FEED_MODEL
// (summaries, default claude-opus-5), LEGAL_FEED_TRIAGE_MODEL (default
// claude-sonnet-5 — Haiku let through acts the screen excludes by name).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type PortalAct, type PortalRecord, actFromRecord, actLabel, attachAnnexes, freeVerdict, mapLimit, mergeJointActs, uniqueActs,
} from "./portal.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUMMARY_MODEL = Deno.env.get("LEGAL_FEED_MODEL") ?? "claude-opus-5";
const TRIAGE_MODEL = Deno.env.get("LEGAL_FEED_TRIAGE_MODEL") ?? "claude-sonnet-5";

const MAX_INGEST = 10;
const MAX_ATTEMPTS = 3;
const TRIAGE_BATCH = 40;
const SUMMARY_CHARS = 24000;  // what Claude reads of an act (+ its annexes)
const BODY_CHARS = 60000;     // what is kept of a waiting act's text
const MAX_RECORDS = 400;      // per submission
const RECHECK = 6;            // issues re-read behind the last one found
const LEASE_MS = 10 * 60 * 1000;

const CATEGORIES = ["employment", "corporate", "gdpr", "litigation", "tax", "compliance"] as const;
const IMPACTS = ["low", "medium", "high"] as const;

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-feed-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// ── Claude (raw REST, like the other functions) ─────────────────────────
type ClaudeOpts = {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  schema: Record<string, unknown>;
  effort?: "low" | "medium" | "high";
};

async function claudeJson<T>(o: ClaudeOpts): Promise<T> {
  const isOpus5 = o.model.startsWith("claude-opus-5");
  const body: Record<string, unknown> = {
    model: o.model,
    max_tokens: o.maxTokens,
    system: [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: o.user }],
    output_config: {
      format: { type: "json_schema", schema: o.schema },
      ...(o.effort && !o.model.startsWith("claude-haiku") ? { effort: o.effort } : {}),
    },
  };
  const headers: Record<string, string> = {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  // Opus 5 can decline on a safety classifier; let the API retry the same
  // request on its chosen fallback rather than losing the act.
  if (isOpus5) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`anthropic_${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  if (data?.stop_reason === "refusal") throw new Error("refused");
  if (data?.stop_reason === "max_tokens") throw new Error("max_tokens");
  const text = (data?.content ?? [])
    .filter((b: { type?: string }) => b?.type === "text")
    .map((b: { text?: string }) => b.text ?? "")
    .join("");
  return JSON.parse(text) as T;
}

// ── Screening: which acts matter ────────────────────────────────────────
const TRIAGE_SYSTEM =
  "You screen the acts published in Romania's Monitorul Oficial for the newsfeed of a Romanian " +
  "business-law firm. Its clients are companies and professionals; its practice covers employment, " +
  "corporate and commercial law, data protection, litigation and procedure, tax, and regulatory " +
  "compliance (financial services, energy, telecoms, competition, consumer protection, public " +
  "procurement, environment, health, AML, cybersecurity).\n\n" +
  "RELEVANT means the act changes what a company or professional must do, may do, pays, reports or " +
  "risks, or how courts decide: laws and ordinances of general application; government decisions " +
  "that set or change rules; regulators' orders, regulations, norms and methodologies (ANAF, MF, ASF, " +
  "BNR, ANSPDCP, ONRC, ANRE, ANCOM, ANPC, Consiliul Concurenței, DNSC, CNAS…); High Court (ICCJ) " +
  "decisions in the interest of the law or on a question of law; Constitutional Court decisions that " +
  "admit an exception; ratified treaties that bind businesses; changes to thresholds, rates, " +
  "deadlines, forms or procedures that businesses use.\n\n" +
  "NOT RELEVANT: acts about one named person, company, school, building, plot or project; budgets, " +
  "staffing and internal organisation of a single institution; public-property transfers; " +
  "individual authorisations, licences and their withdrawal; grant-scheme guides for a single call; " +
  "technical lists with no legal consequence for businesses; academic and school administration; " +
  "military and diplomatic appointments; sector-technical rules that bind only public bodies or a " +
  "narrow trade (agricultural and land registers, seed and veterinary testing fees, school curricula, " +
  "forestry or fishing quotas) unless they create obligations for businesses generally.\n\n" +
  "When unsure, prefer NOT relevant: the feed is read by busy lawyers and a missed minor act costs " +
  "less than a feed full of noise. For each act give `relevant`, the best `category` (for relevant " +
  "ones), and a `reason` of at most twelve words.";

const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    acts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          relevant: { type: "boolean" },
          category: { type: "string", enum: [...CATEGORIES] },
          reason: { type: "string" },
        },
        required: ["id", "relevant", "category", "reason"],
      },
    },
  },
  required: ["acts"],
};

type Triage = { id: string; relevant: boolean; category: string; reason: string };

async function triage(acts: PortalAct[]): Promise<Map<string, Triage>> {
  const out = new Map<string, Triage>();
  for (let i = 0; i < acts.length; i += TRIAGE_BATCH) {
    const batch = acts.slice(i, i + TRIAGE_BATCH);
    const list = batch.map((a) => {
      // A title like "pentru modificarea Ordinului nr. 1.234/2019" says little;
      // the opening of the text says what is being changed.
      const opening = a.text.replace(/\s+/g, " ").slice(0, 280);
      return `[${a.portalId}] ${actLabel(a)} — ${a.issuer}\n  ${a.title}\n  Text: ${opening}`;
    }).join("\n\n");
    const res = await claudeJson<{ acts: Triage[] }>({
      model: TRIAGE_MODEL,
      system: TRIAGE_SYSTEM,
      user: `Screen these ${batch.length} acts. Answer for every id.\n\n${list}`,
      maxTokens: 16000,
      schema: TRIAGE_SCHEMA,
      effort: "low",
    });
    for (const t of res.acts ?? []) out.set(String(t.id).replace(/\D/g, ""), t);
  }
  return out;
}

// ── The feed row ────────────────────────────────────────────────────────
const SUMMARY_SYSTEM =
  "You are a legal-intelligence analyst for a Romanian law firm. You receive the text of an act just " +
  "published in Monitorul Oficial and write its entry in the firm's internal newsfeed. Return JSON:\n" +
  "`headline` — IN ROMANIAN, at most 110 characters, what the act DOES for businesses, in plain words " +
  "(e.g. \"Plafonul microîntreprinderilor scade la 100.000 EUR din 2027\"). Do not repeat the act's " +
  "number or kind; it is added separately.\n" +
  "`summary` — IN ROMANIAN, 2-4 sentences, neutral and practical: who is affected, what changes, from " +
  "when, and any thresholds, deadlines or sanctions.\n" +
  "`category` — one of employment, corporate, gdpr, litigation, tax, compliance.\n" +
  "`impact` — low, medium or high: how broadly and urgently it affects the firm's clients. High is " +
  "for changes most companies must act on soon.\n" +
  "`areas` — 2-5 short Romanian labels for the affected practice areas or workflows.\n" +
  "`citations` — the acts and articles it amends or relies on, as one string.\n" +
  "Use only what the text says. If the text does not state an effective date, do not invent one.";

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    category: { type: "string", enum: [...CATEGORIES] },
    impact: { type: "string", enum: [...IMPACTS] },
    areas: { type: "array", items: { type: "string" } },
    citations: { type: "string" },
  },
  required: ["headline", "summary", "category", "impact", "areas", "citations"],
};

type Summary = {
  headline: string; summary: string; category: string; impact: string; areas: string[]; citations: string;
};

// The text an act is summarised from: its own, then the rules it approves.
const fullText = (a: PortalAct) =>
  `${a.text}${a.annexText ? `\n\n--- ANEXĂ / NORME APROBATE ---\n${a.annexText}` : ""}`;

async function summarise(a: PortalAct): Promise<Summary> {
  const body = fullText(a);
  return await claudeJson<Summary>({
    model: SUMMARY_MODEL,
    system: SUMMARY_SYSTEM,
    user:
      `${actLabel(a)} — ${a.issuer}\n${a.title}\n${a.moRef}\n` +
      (a.inForce ? `În vigoare de la: ${a.inForce}\n` : "") +
      `\nText:\n${body.slice(0, SUMMARY_CHARS)}` +
      (body.length > SUMMARY_CHARS ? "\n[… textul continuă]" : ""),
    maxTokens: 8000,
    schema: SUMMARY_SCHEMA,
    effort: "medium",
  });
}

// When the act appeared. Monitorul Oficial is dated, not timed; an issue of
// today is stamped "now" (so the feed says "just now", not "8 hours ago"), an
// older one at 09:00 Bucharest time of its day.
function publishedAt(moDate: string): string {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
  if (!moDate || moDate >= today) return new Date().toISOString();
  return `${moDate}T06:00:00Z`;
}

function feedRow(a: PortalAct, s: Summary) {
  const category = (CATEGORIES as readonly string[]).includes(s.category) ? s.category : "compliance";
  const impact = (IMPACTS as readonly string[]).includes(s.impact) ? s.impact : "medium";
  const year = a.issuedYear || a.moDate.slice(0, 4);
  return {
    slug: `mo-${a.portalId}`,
    portal_id: a.portalId,
    origin: "portal",
    act_type: a.type,
    act_number: a.number && a.number !== "0" ? a.number : null,
    act_year: year || null,
    source_url: a.link,
    category,
    impact,
    title: `${actLabel(a)} — ${s.headline.trim()}`.slice(0, 240),
    source: [a.moRef || "Monitorul Oficial", a.issuer].filter(Boolean).join(" · "),
    citations: s.citations || null,
    summary: s.summary,
    areas: Array.isArray(s.areas) ? s.areas.slice(0, 6) : [],
    raw_content: `${a.title}\n\n${a.text}`.slice(0, 20000),
    ai_status: "done",
    published_at: publishedAt(a.moDate),
    updated_at: new Date().toISOString(),
  };
}

// ── Records ↔ rows ──────────────────────────────────────────────────────
function actRecord(a: PortalAct, status: string, extra: Record<string, unknown> = {}) {
  return {
    portal_id: a.portalId,
    act_type: a.type,
    act_number: a.number && a.number !== "0" ? a.number : null,
    title: a.title.slice(0, 1000),
    issuer: a.issuer || null,
    mo_ref: a.moRef || null,
    mo_date: a.moDate || null,
    in_force: /^\d{4}-\d{2}-\d{2}$/.test(a.inForce) ? a.inForce : null,
    link: a.link || null,
    status,
    updated_at: new Date().toISOString(),
    ...extra,
  };
}

// A waiting act, rebuilt from its row — the portal can't be asked again from
// here, which is why a relevant act's text is kept (`body`).
type ActRow = {
  portal_id: string; act_type: string; act_number: string | null; title: string; issuer: string | null;
  mo_ref: string | null; mo_date: string | null; in_force: string | null; link: string | null;
  body: string | null; status: string; attempts: number;
};
function actFromRow(r: ActRow): PortalAct {
  const mo = /nr\.\s*([\d.]+)/.exec(r.mo_ref || "");
  const issued = /\bdin\s+\d{1,2}\s+\S+\s+(\d{4})/i.exec(r.title);
  return {
    portalId: r.portal_id,
    type: r.act_type,
    number: r.act_number || "",
    issuer: r.issuer || "",
    title: r.title,
    moRef: r.mo_ref || "",
    moNumber: mo ? Number(mo[1].replace(/\./g, "")) : 0,
    moBis: /\bbis\b/.test(r.mo_ref || ""),
    moDate: r.mo_date || "",
    issuedYear: issued ? issued[1] : "",
    inForce: r.in_force || "",
    link: r.link || "",
    text: r.body || "",
  };
}

// ── Submission ──────────────────────────────────────────────────────────
type SubmitOpts = { year: number; lastIssue: number; dryRun: boolean; final: boolean };

async function judge(db: SupabaseClient, records: PortalRecord[], o: SubmitOpts) {
  const started = Date.now();
  const report: Record<string, unknown> = { startedAt: new Date(started).toISOString(), dryRun: o.dryRun, year: o.year };

  // What the portal sends, and nothing else: a document on legislatie.just.ro,
  // printed in an issue of the year being walked.
  const acts = uniqueActs(records.slice(0, MAX_RECORDS)
    .map((r) => actFromRecord({ ...r, text: String(r.text || "").slice(0, BODY_CHARS) }))
    .filter((a): a is PortalAct =>
      !!a && /^https:\/\/legislatie\.just\.ro\//.test(a.link) && a.moNumber > 0 && a.moDate.startsWith(String(o.year))));
  const absorbed = attachAnnexes(acts);
  const joint = mergeJointActs(acts.filter((a) => !absorbed.has(a.portalId)));
  report.received = records.length;
  report.accepted = acts.length;

  // Already judged?
  const ids = acts.map((a) => a.portalId);
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from("legal_feed_acts").select("portal_id").in("portal_id", ids.slice(i, i + 200));
    for (const r of data ?? []) known.add(r.portal_id);
  }
  const fresh = acts.filter((a) => !known.has(a.portalId));
  report.new = fresh.length;

  // The free rules.
  const records2: Record<string, unknown>[] = [];
  const candidates: PortalAct[] = [];
  for (const a of fresh) {
    if (absorbed.has(a.portalId)) {
      records2.push(actRecord(a, "skipped", { reason: `annex of ${absorbed.get(a.portalId)}` }));
      continue;
    }
    if (joint.has(a.portalId)) {
      records2.push(actRecord(a, "skipped", { reason: `co-signature of ${joint.get(a.portalId)}` }));
      continue;
    }
    const v = freeVerdict(a);
    if (v.keep) candidates.push(a);
    else records2.push(actRecord(a, "skipped", { reason: v.reason }));
  }
  report.skippedByRules = records2.length;

  // The model's screen. A relevant act keeps its text: it may wait for a later
  // submission to be summarised, and the portal can't be asked from here.
  const verdicts = candidates.length ? await triage(candidates) : new Map<string, Triage>();
  for (const a of candidates) {
    const t = verdicts.get(a.portalId);
    if (!t) continue; // unanswered → unrecorded → judged again next time
    records2.push(actRecord(a, t.relevant ? "relevant" : "rejected", {
      category: t.category,
      reason: (t.reason || "").slice(0, 300),
      body: t.relevant ? fullText(a).slice(0, BODY_CHARS) : null,
    }));
  }
  report.screened = candidates.length;
  report.relevant = records2.filter((r) => r.status === "relevant").length;

  if (!o.dryRun) {
    for (let i = 0; i < records2.length; i += 100) {
      const { error } = await db.from("legal_feed_acts").upsert(records2.slice(i, i + 100), { onConflict: "portal_id" });
      if (error) throw new Error(`record_failed: ${error.message}`);
    }
    if (o.final && o.lastIssue > 0) {
      const key = `mo_issue:${o.year}`;
      const { data: st } = await db.from("legal_feed_state").select("value").eq("key", key).maybeSingle();
      if (o.lastIssue > (Number(st?.value?.issue) || 0)) {
        await db.from("legal_feed_state").upsert({ key, value: { issue: o.lastIssue }, updated_at: new Date().toISOString() });
      }
    }
  }

  if (o.dryRun) {
    const byId = new Map(acts.map((a) => [a.portalId, a]));
    report.decisions = records2.map((r) => ({
      id: r.portal_id, status: r.status, reason: r.reason, category: r.category,
      label: actLabel(byId.get(r.portal_id as string)!), title: String(r.title).slice(0, 140),
    }));
    report.ms = Date.now() - started;
    return report;
  }

  // The feed rows: whatever is waiting, newest issue first — this
  // submission's relevant acts included, since they were just recorded.
  const { data: waiting } = await db.from("legal_feed_acts")
    .select("portal_id, act_type, act_number, title, issuer, mo_ref, mo_date, in_force, link, body, status, attempts")
    .or(`status.eq.relevant,and(status.eq.failed,attempts.lt.${MAX_ATTEMPTS})`)
    .order("mo_date", { ascending: false })
    .limit(MAX_INGEST);
  const todo = ((waiting ?? []) as ActRow[]).filter((r) => r.body);
  report.queued = todo.length;

  const results = await mapLimit(todo, 3, async (row) => {
    const a = actFromRow(row);
    try {
      const s = await summarise(a);
      const { error } = await db.from("legal_updates").upsert(feedRow(a, s), { onConflict: "slug" });
      if (error) throw new Error(error.message);
      await db.from("legal_feed_acts").update({
        status: "ingested", category: s.category, attempts: row.attempts + 1, error: null, body: null,
        updated_at: new Date().toISOString(),
      }).eq("portal_id", a.portalId);
      return true;
    } catch (err) {
      await db.from("legal_feed_acts").update({
        status: "failed", attempts: row.attempts + 1, error: String((err as Error)?.message ?? err).slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq("portal_id", a.portalId);
      return false;
    }
  });
  report.ingested = results.filter(Boolean).length;
  report.failed = results.length - (report.ingested as number);
  report.ms = Date.now() - started;
  return report;
}

// ── The lease: one walker at a time ─────────────────────────────────────
async function takeLease(db: SupabaseClient, holder: string): Promise<boolean> {
  const { data } = await db.from("legal_feed_state").select("value").eq("key", "lease").maybeSingle();
  const at = Date.parse(data?.value?.at || "");
  if (data?.value?.holder && data.value.holder !== holder && Date.now() - at < LEASE_MS) return false;
  await db.from("legal_feed_state").upsert({
    key: "lease", value: { holder, at: new Date().toISOString() }, updated_at: new Date().toISOString(),
  });
  return true;
}
async function dropLease(db: SupabaseClient, holder: string) {
  const { data } = await db.from("legal_feed_state").select("value").eq("key", "lease").maybeSingle();
  if (data?.value?.holder === holder) await db.from("legal_feed_state").delete().eq("key", "lease");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // An app admin (see the header), or an operator holding the Vault key
  // (migration 039) — for a backfill or a check run without the app.
  let userId = "";
  const feedKey = req.headers.get("x-feed-key") ?? "";
  if (feedKey) {
    const { data: keyOk } = await db.rpc("legal_feed_operator_check", { p_key: feedKey });
    if (keyOk !== true) return json({ ok: false, error: "forbidden" }, 403);
    userId = "operator";
  } else {
    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    userId = userData?.user?.id ?? "";
    if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
    const { data: isAdmin } = await asUser.rpc("is_app_admin");
    if (isAdmin !== true) return json({ ok: false, error: "forbidden" }, 403);
  }

  let body: {
    action?: string; year?: number; lastIssue?: number; records?: PortalRecord[]; dryRun?: boolean; final?: boolean;
  } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }

  if (body.action === "plan") {
    if (!(await takeLease(db, userId))) return json({ ok: true, busy: true, years: [] });
    const now = new Date();
    const year = now.getUTCFullYear();
    // Numbering restarts every January; the old year's last issues are still
    // being indexed through its first weeks.
    const years = now.getUTCMonth() === 0 && now.getUTCDate() <= 20 ? [year - 1, year] : [year];
    const out = [];
    for (const y of years) {
      const { data: st } = await db.from("legal_feed_state").select("value").eq("key", `mo_issue:${y}`).maybeSingle();
      const last = Number(st?.value?.issue) || 0;
      out.push({ year: y, start: last ? Math.max(1, last - RECHECK) : null });
    }
    return json({ ok: true, years: out });
  }

  // A walk that failed hands its lease back, so a retry needn't wait it out.
  if (body.action === "release") {
    await dropLease(db, userId);
    return json({ ok: true });
  }

  if (body.action === "submit") {
    if (!ANTHROPIC_API_KEY) return json({ ok: false, error: "ai_not_configured" }, 500);
    const year = Number(body.year);
    if (!Number.isInteger(year) || year < 2000) return json({ ok: false, error: "bad_year" }, 400);
    const records = Array.isArray(body.records) ? body.records : [];
    const opts: SubmitOpts = {
      year,
      lastIssue: Math.max(0, Number(body.lastIssue) || 0),
      dryRun: body.dryRun === true,
      final: body.final === true,
    };
    if (opts.dryRun) {
      try { return json({ ok: true, ...(await judge(db, records, opts)) }); } catch (err) {
        return json({ ok: false, error: String((err as Error)?.message ?? err) }, 500);
      } finally {
        if (opts.final) await dropLease(db, userId);
      }
    }
    // Judged after answering: summaries take a minute or two, and the app has
    // nothing to wait for.
    const task = judge(db, records, opts)
      .then((report) => db.from("legal_feed_state").upsert({ key: "last_run", value: report, updated_at: new Date().toISOString() }))
      .catch((err) => db.from("legal_feed_state").upsert({
        key: "last_run",
        value: { failedAt: new Date().toISOString(), error: String((err as Error)?.message ?? err).slice(0, 500) },
        updated_at: new Date().toISOString(),
      }))
      .finally(() => (opts.final ? dropLease(db, userId) : undefined));
    EdgeRuntime.waitUntil(task);
    return json({ ok: true, started: true }, 202);
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
