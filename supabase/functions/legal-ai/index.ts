// legal-ai — AI for the Legal Newsfeed (Newsletter tab).
//
// Two actions, dispatched on the request body's `action` field:
//
//   { action: "digest" }
//     Generates the "AI weekly" briefing shown at the top of the
//     Newsletter — a live Claude summary across the most recent feed
//     items. Read-only. Any authenticated caller (verify_jwt is on).
//     The renderer caches the result in sessionStorage for an hour.
//
//   { action: "ingest", items: [{ title, source?, citations?,
//     published_at?, raw_content, slug? }, ...] }
//     For each item, asks Claude to classify the update (category +
//     impact), write a Romanian brief, and extract affected practice
//     areas, then inserts a `legal_updates` row (service role, bypasses
//     RLS). This is the data-population path — a cron, scraper, or
//     operator calls it. Gated on the `x-ingest-secret` header matching
//     LEGAL_INGEST_SECRET so the global feed can't be polluted by any
//     signed-in user. Disabled (403) when the secret env var is unset.
//
// Claude is called over raw REST (x-api-key) — same shape as the Resend
// calls in the other functions, no SDK to bundle into the Deno runtime.
// Model defaults to claude-opus-4-7 and is overridable via LEGAL_AI_MODEL.
//
// Required Edge Function secrets:
//   ANTHROPIC_API_KEY      — Claude API key (digest + ingest)
//   LEGAL_INGEST_SECRET    — shared secret guarding the ingest action
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — set automatically
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ingest-secret",
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
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const LEGAL_INGEST_SECRET = Deno.env.get("LEGAL_INGEST_SECRET") ?? "";
// Default to the most capable model; operators can switch to a cheaper
// one (e.g. claude-haiku-4-5) via env without a redeploy of logic.
const MODEL = Deno.env.get("LEGAL_AI_MODEL") ?? "claude-opus-4-7";

const VALID_CATEGORIES = [
  "employment",
  "corporate",
  "gdpr",
  "litigation",
  "tax",
  "compliance",
] as const;
const VALID_IMPACT = ["low", "medium", "high"] as const;

// ── Claude Messages API (raw REST) ──────────────────────────────────
// The stable system prompt carries a cache_control breakpoint so the
// prefix can be reused across calls. (Below the model's minimum
// cacheable prefix it's a silent no-op — harmless.) Volatile content
// (the feed items / raw text) goes in the user message, after the
// breakpoint. No `temperature`/`top_p`/`thinking` — those are removed on
// Opus 4.7 and unnecessary for this summarisation task.
async function callClaude(opts: {
  system: string;
  user: string;
  maxTokens: number;
  jsonSchema?: Record<string, unknown>;
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: opts.maxTokens,
    system: [
      { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: opts.user }],
  };
  if (opts.jsonSchema) {
    body.output_config = {
      format: { type: "json_schema", schema: opts.jsonSchema },
    };
  }

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
  const text = (data?.content ?? [])
    .filter((b: { type?: string }) => b?.type === "text")
    .map((b: { text?: string }) => b.text ?? "")
    .join("")
    .trim();
  return text;
}

// ── digest ──────────────────────────────────────────────────────────
async function handleDigest(): Promise<Response> {
  if (!ANTHROPIC_API_KEY) {
    // 200 + ok:false so the client falls back to a computed line instead
    // of treating it as a hard error.
    return jsonResponse({ ok: false, error: "ai_not_configured" });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: rows, error } = await admin
    .from("legal_updates")
    .select("category, impact, title, summary, source, published_at")
    .order("published_at", { ascending: false })
    .limit(15);

  if (error) return jsonResponse({ ok: false, error: "fetch_failed", detail: error.message }, 500);
  const updates = rows ?? [];
  if (updates.length === 0) {
    return jsonResponse({ ok: true, summary: "", highImpactCount: 0, total: 0, generatedAt: new Date().toISOString() });
  }

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const highImpactCount = updates.filter(
    (u) => u.impact === "high" && new Date(u.published_at).getTime() >= weekAgo,
  ).length;

  const list = updates
    .map((u) => {
      const summary = (u.summary ?? "").slice(0, 320);
      return `- [${u.impact}] (${u.category}) ${u.title} — ${summary} (Source: ${u.source ?? "n/a"})`;
    })
    .join("\n");

  const system =
    "You are the legal-intelligence editor for DocVex, a Romanian law firm's internal newsfeed. " +
    "You write a concise weekly briefing in English that orients busy lawyers to the most important " +
    "recent Romanian legislative and regulatory changes. Be specific, neutral, and practical. " +
    "Write 2-3 sentences as a single paragraph: lead with the count and the dominant practice areas, " +
    "then call out the single most time-sensitive change and its effective date. " +
    "No preamble, no markdown, no bullet points, no headings — just the paragraph.";

  const user =
    `Here are the most recent legal updates (newest first):\n\n${list}\n\n` +
    `Write the weekly briefing paragraph now.`;

  try {
    const summary = await callClaude({ system, user, maxTokens: 400 });
    return jsonResponse({
      ok: true,
      summary,
      highImpactCount,
      total: updates.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "ai_failed", detail: String((err as Error)?.message ?? err).slice(0, 400) },
      502,
    );
  }
}

// ── ingest ──────────────────────────────────────────────────────────
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const INGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    category: { type: "string", enum: [...VALID_CATEGORIES] },
    impact: { type: "string", enum: [...VALID_IMPACT] },
    summary: { type: "string" },
    areas: { type: "array", items: { type: "string" } },
    citations: { type: "string" },
  },
  required: ["category", "impact", "summary", "areas", "citations"],
};

type IngestItem = {
  title?: string;
  source?: string;
  citations?: string;
  published_at?: string;
  raw_content?: string;
  slug?: string;
};

async function handleIngest(req: Request, items: IngestItem[]): Promise<Response> {
  // Gate: secret must be configured AND match. Without it, ingest is off.
  if (!LEGAL_INGEST_SECRET) {
    return jsonResponse({ ok: false, error: "ingest_disabled" }, 403);
  }
  if (req.headers.get("x-ingest-secret") !== LEGAL_INGEST_SECRET) {
    return jsonResponse({ ok: false, error: "forbidden" }, 403);
  }
  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ ok: false, error: "ai_not_configured" }, 500);
  }
  if (!Array.isArray(items) || items.length === 0) {
    return jsonResponse({ ok: false, error: "no_items" }, 400);
  }
  if (items.length > 20) {
    return jsonResponse({ ok: false, error: "too_many_items", detail: "max 20 per call" }, 413);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const system =
    "You are a legal-intelligence analyst for a Romanian law firm. Given the raw text of a Romanian " +
    "legal or regulatory update, you classify and summarise it for the firm's internal newsfeed. " +
    "Return ONLY a JSON object with: " +
    "`category` (one of employment, corporate, gdpr, litigation, tax, compliance — pick the best fit); " +
    "`impact` (low, medium, or high — how broadly and urgently this affects the firm's clients); " +
    "`summary` (2-4 sentences IN ROMANIAN, neutral and practical, naming concrete dates, thresholds, " +
    "and obligations); `areas` (3-5 short Romanian labels for the affected practice areas / workflows); " +
    "`citations` (the law/article references mentioned, as a single string). Do not invent facts not in the source.";

  const results: Array<{ slug: string; ok: boolean; error?: string }> = [];

  for (const item of items) {
    const title = (item.title ?? "").trim();
    const raw = (item.raw_content ?? "").trim();
    if (!title || !raw) {
      results.push({ slug: item.slug ?? slugify(title) ?? "unknown", ok: false, error: "missing_title_or_content" });
      continue;
    }
    const slug = (item.slug && item.slug.trim()) || slugify(title);

    let parsed: {
      category: string;
      impact: string;
      summary: string;
      areas: string[];
      citations: string;
    };
    try {
      const user =
        `Title: ${title}\n` +
        (item.source ? `Source: ${item.source}\n` : "") +
        `\nRaw text:\n${raw.slice(0, 8000)}`;
      const out = await callClaude({ system, user, maxTokens: 700, jsonSchema: INGEST_SCHEMA });
      parsed = JSON.parse(out);
    } catch (err) {
      results.push({ slug, ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) });
      continue;
    }

    // Defensive validation — the schema constrains the model, but guard
    // against drift before it hits the table's CHECK constraints.
    const category = VALID_CATEGORIES.includes(parsed.category as typeof VALID_CATEGORIES[number])
      ? parsed.category
      : "compliance";
    const impact = VALID_IMPACT.includes(parsed.impact as typeof VALID_IMPACT[number])
      ? parsed.impact
      : "medium";

    const { error } = await admin
      .from("legal_updates")
      .upsert(
        {
          slug,
          category,
          impact,
          title,
          source: item.source ?? null,
          citations: parsed.citations ?? item.citations ?? null,
          summary: parsed.summary ?? null,
          areas: Array.isArray(parsed.areas) ? parsed.areas.slice(0, 8) : [],
          raw_content: raw.slice(0, 20000),
          ai_status: "done",
          published_at: item.published_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "slug", ignoreDuplicates: false },
      );

    results.push({ slug, ok: !error, error: error?.message });
  }

  return jsonResponse({ ok: true, results });
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  let body: { action?: string; items?: IngestItem[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  switch (body.action) {
    case "digest":
      return handleDigest();
    case "ingest":
      return handleIngest(req, body.items ?? []);
    default:
      return jsonResponse({ error: "unknown_action" }, 400);
  }
});
