// court-files — BACKUP SOURCES for the Legislation entry's portal.just.ro tab
// (2026-10-02). The courts' own SOAP service (portalquery.just.ro, called by
// the desktop app's main process) is unstable and often offline, and when its
// HTTPS address fails a search by a party's NAME is refused outright (it is
// never sent in clear). When that happens the app asks HERE, and this
// function asks, in order:
//
//   1. EasyAPI (easyapi.ro, `EASYAPI_KEY`) — ECRIS cases and hearings. It
//      leaves criminal cases out (GDPR art. 10), so an EMPTY answer goes on
//      to the next source rather than being taken as "no such file".
//   2. DosarJust (dosarjust.ro, `DOSARJUST_KEY`) — a daily mirror of ECRIS
//      (may be up to a day behind).
//
// The keys are this function's secrets: they never reach the app. A source
// without a key is skipped; with neither the answer is `no_backup` and the
// app falls back to the copies it keeps. Every answer is converted into the
// SAME record the app reads from the SOAP service (main.js
// courtsParseDosar), so the page shows a backup's file exactly as a live one,
// and says where it came from (`provider`).
//
// Who may call: a signed-in user, rate-limited with the AI calls
// (_shared/guard.ts). The queries — a file number, a party's name, an object —
// are passed to the third party; the privacy policy and the DPA say so.
//
// Request: { action: 'search', q: { numar, parte, obiect, institutie,
// institutieLabel, from, to } } | { action: 'hearings', q: { institutie,
// institutieLabel, day } }.
// Answer: { ok: true, provider, total, dosare } | { ok: true, provider,
// sedinte } | { ok: false, error }.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guardAiCall } from "../_shared/guard.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const TIMEOUT_MS = 15_000;
const MAX_FILES = 60;      // files returned for one search
const MAX_DETAILS = 10;    // DosarJust: summaries fetched whole (they carry no parties)

type Rec = Record<string, unknown>;
type Dosar = {
  numar: string; numarVechi: string; data: string; institutie: string; departament: string;
  categorie: string; stadiu: string; obiect: string; modificat: string;
  parti: { nume: string; calitate: string }[];
  sedinte: { complet: string; data: string; ora: string; solutie: string; sumar: string; pronuntare: string; document: string; numarDocument: string; dataDocument: string }[];
  caiAtac: { data: string; parte: string; tip: string }[];
};

const str = (v: unknown) => (v == null ? "" : String(v)).trim();
const pick = (o: Rec | null | undefined, ...keys: string[]) => {
  for (const k of keys) { const v = o?.[k]; if (v != null && v !== "") return str(v); }
  return "";
};
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") as Rec[] : []);
// A list out of whatever envelope a service wraps it in.
const listOf = (j: unknown, ...keys: string[]): Rec[] => {
  if (Array.isArray(j)) return arr(j);
  const o = (j ?? {}) as Rec;
  for (const k of keys) if (Array.isArray(o[k])) return arr(o[k]);
  return [];
};

async function getJson(url: string, headers: Record<string, string>): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: ctl.signal });
    if (res.status === 404) return { ok: true, data: null };
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: (err as Error)?.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// ── EasyAPI ────────────────────────────────────────────────────────────────
const EASY = "https://easyapi.ro/v1/justice";
function easyDosar(c: Rec): Dosar {
  return {
    numar: pick(c, "number", "numar"),
    numarVechi: pick(c, "oldNumber"),
    data: pick(c, "date", "registeredAt", "createdAt"),
    institutie: pick(c, "court", "courtName"),
    departament: pick(c, "department", "section"),
    categorie: pick(c, "category", "caseCategory"),
    stadiu: pick(c, "stage"),
    obiect: pick(c, "subject", "object"),
    modificat: pick(c, "modifiedAt", "updatedAt"),
    parti: arr(c.parties).map((p) => ({ nume: pick(p, "name"), calitate: pick(p, "role", "quality") })),
    sedinte: arr(c.hearings).map((h) => ({
      complet: pick(h, "panel", "complet"), data: pick(h, "date"), ora: pick(h, "time"),
      solutie: pick(h, "solution"), sumar: pick(h, "solutionSummary", "summary"),
      pronuntare: pick(h, "pronouncedAt", "pronouncementDate"),
      document: pick(h, "document"), numarDocument: pick(h, "documentNumber"), dataDocument: pick(h, "documentDate"),
    })),
    caiAtac: arr(c.appeals).map((a) => ({ data: pick(a, "date"), parte: pick(a, "party"), tip: pick(a, "type") })),
  };
}
async function easySearch(q: Rec, key: string) {
  const u = new URL(`${EASY}/cases`);
  if (str(q.numar)) u.searchParams.set("number", str(q.numar));
  if (str(q.parte)) u.searchParams.set("party", str(q.parte));
  if (str(q.obiect)) u.searchParams.set("subject", str(q.obiect));
  if (str(q.institutieLabel)) u.searchParams.set("court", str(q.institutieLabel));
  const r = await getJson(u.toString(), { Authorization: `Bearer ${key}` });
  if (!r.ok) return r;
  let dosare = listOf(r.data, "data", "cases", "items", "results").map(easyDosar).filter((d) => d.numar);
  // EasyAPI takes no period: applied here, on the file's registration date.
  if (str(q.from)) dosare = dosare.filter((d) => !d.data || d.data.slice(0, 10) >= str(q.from));
  if (str(q.to)) dosare = dosare.filter((d) => !d.data || d.data.slice(0, 10) <= str(q.to));
  return { ok: true as const, total: dosare.length, dosare: dosare.slice(0, MAX_FILES) };
}
async function easyHearings(q: Rec, key: string) {
  const u = new URL(`${EASY}/hearings`);
  u.searchParams.set("court", str(q.institutieLabel) || str(q.institutie));
  u.searchParams.set("date", str(q.day));
  const r = await getJson(u.toString(), { Authorization: `Bearer ${key}` });
  if (!r.ok) return r;
  return { ok: true as const, sedinte: groupHearings(listOf(r.data, "data", "hearings", "items", "results"), {
    panel: ["panel", "complet"], department: ["department", "section"], date: ["date"], time: ["time"],
    cases: ["cases"], number: ["number", "caseNumber"], category: ["category"], stage: ["stage"],
  }) };
}

// ── DosarJust ──────────────────────────────────────────────────────────────
const DJ = "https://dosarjust.ro/api/public";
function djDosar(c: Rec): Dosar {
  return {
    numar: pick(c, "numar"),
    numarVechi: pick(c, "numar_vechi"),
    data: pick(c, "data_dosar"),
    institutie: pick(c, "institutie"),
    departament: pick(c, "departament"),
    categorie: pick(c, "categorie_caz"),
    stadiu: pick(c, "stadiu_procesual"),
    obiect: pick(c, "obiect"),
    modificat: pick(c, "data_modificare"),
    parti: arr(c.parti).map((p) => ({ nume: pick(p, "nume"), calitate: pick(p, "calitate") })),
    sedinte: arr(c.sedinte ?? c.solutii_recente).map((h) => ({
      complet: pick(h, "complet"), data: pick(h, "data_sedinta", "data"), ora: pick(h, "ora"),
      solutie: pick(h, "solutie"), sumar: pick(h, "solutie_sumar"), pronuntare: pick(h, "data_pronuntare"),
      document: pick(h, "document_sedinta"), numarDocument: pick(h, "numar_document"), dataDocument: pick(h, "data_document"),
    })),
    caiAtac: arr(c.cai_atac).map((a) => ({ data: pick(a, "data_declarare", "data"), parte: pick(a, "parte_declaratoare", "parte"), tip: pick(a, "tip_cale_atac", "tip") })),
  };
}
async function djDetail(numar: string, key: string): Promise<Dosar | null> {
  const r = await getJson(`${DJ}/dosar/${encodeURIComponent(numar)}`, { "X-Api-Key": key });
  return r.ok && r.data ? djDosar(r.data as Rec) : null;
}
async function djSearch(q: Rec, key: string) {
  // A number names one file: read it whole.
  if (str(q.numar) && !str(q.parte) && !str(q.obiect)) {
    const r = await getJson(`${DJ}/dosar/${encodeURIComponent(str(q.numar))}`, { "X-Api-Key": key });
    if (!r.ok) return r;
    const dosare = r.data ? [djDosar(r.data as Rec)] : [];
    return { ok: true as const, total: dosare.length, dosare };
  }
  const u = new URL(`${DJ}/search`);
  u.searchParams.set("q", [str(q.numar), str(q.parte), str(q.obiect)].filter(Boolean).join(" "));
  if (str(q.institutie)) u.searchParams.set("institutie", str(q.institutie));
  if (str(q.from)) u.searchParams.set("dataStart", str(q.from));
  if (str(q.to)) u.searchParams.set("dataStop", str(q.to));
  u.searchParams.set("limit", String(MAX_FILES));
  const r = await getJson(u.toString(), { "X-Api-Key": key });
  if (!r.ok) return r;
  const o = (r.data ?? {}) as Rec;
  const summaries = listOf(o, "data");
  const total = Number((o.pagination as Rec | undefined)?.total) || summaries.length;
  // The summaries carry no parties: the first few are read whole, the rest
  // stand as summaries (the page reads them again when one is opened).
  const whole = await Promise.all(summaries.slice(0, MAX_DETAILS).map((s) => djDetail(pick(s, "numar"), key)));
  const dosare = summaries.map((s, i) => whole[i] || djDosar(s)).filter((d) => d.numar).slice(0, MAX_FILES);
  return { ok: true as const, total, dosare };
}
async function djHearings(q: Rec, key: string) {
  const u = new URL(`${DJ}/sedinte`);
  u.searchParams.set("data", str(q.day));
  if (str(q.institutie)) u.searchParams.set("institutie", str(q.institutie));
  u.searchParams.set("include_fara_dosare", "false");
  const r = await getJson(u.toString(), { "X-Api-Key": key });
  if (!r.ok) return r;
  return { ok: true as const, sedinte: groupHearings(listOf(r.data, "data", "sedinte", "items", "results"), {
    panel: ["complet"], department: ["departament"], date: ["data", "data_sedinta"], time: ["ora"],
    cases: ["dosare"], number: ["numar"], category: ["categorie_caz", "categorie"], stage: ["stadiu_procesual", "stadiu"],
  }) };
}

// A day's hearings, as the app reads them: one entry per panel and time, its
// files under it. A service that lists one row per FILE is grouped here.
type HearingKeys = { panel: string[]; department: string[]; date: string[]; time: string[]; cases: string[]; number: string[]; category: string[]; stage: string[] };
function groupHearings(rows: Rec[], k: HearingKeys) {
  const out = new Map<string, { departament: string; complet: string; data: string; ora: string; dosare: Rec[] }>();
  for (const r of rows) {
    const key = `${pick(r, ...k.panel)}|${pick(r, ...k.time)}|${pick(r, ...k.department)}`;
    if (!out.has(key)) out.set(key, { departament: pick(r, ...k.department), complet: pick(r, ...k.panel), data: pick(r, ...k.date), ora: pick(r, ...k.time), dosare: [] });
    const g = out.get(key)!;
    const files = k.cases.flatMap((c) => arr(r[c]));
    const one = files.length ? files : [r];
    for (const f of one) {
      const numar = pick(f, ...k.number);
      if (numar) g.dosare.push({ numar, data: pick(f, ...k.date) || g.data, ora: pick(f, ...k.time) || g.ora, categorie: pick(f, ...k.category), stadiu: pick(f, ...k.stage) });
    }
  }
  return [...out.values()].filter((g) => g.dosare.length);
}

// ── The order ──────────────────────────────────────────────────────────────
type Answer = { ok: true; total?: number; dosare?: Dosar[]; sedinte?: unknown[] } | { ok: false; error: string };
const empty = (a: Answer) => a.ok && !((a.dosare?.length ?? 0) || (a.sedinte?.length ?? 0));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  let body: Rec = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const guard = await guardAiCall(req, body, "court-files", corsHeaders);
  if (guard instanceof Response) return guard;

  const action = str(body.action);
  const q = (body.q && typeof body.q === "object" ? body.q : {}) as Rec;
  if (action === "search" && !str(q.numar) && !str(q.parte) && !str(q.obiect)) return json({ ok: false, error: "empty_query" }, 400);
  if (action === "hearings" && (!str(q.day) || !(str(q.institutie) || str(q.institutieLabel)))) return json({ ok: false, error: "empty_query" }, 400);
  if (action !== "search" && action !== "hearings") return json({ ok: false, error: "unknown_action" }, 400);

  const sources: { name: string; run: () => Promise<Answer> }[] = [];
  const easyKey = env("EASYAPI_KEY");
  const djKey = env("DOSARJUST_KEY");
  if (easyKey) sources.push({ name: "EasyAPI", run: () => (action === "search" ? easySearch(q, easyKey) : easyHearings(q, easyKey)) });
  if (djKey) sources.push({ name: "DosarJust", run: () => (action === "search" ? djSearch(q, djKey) : djHearings(q, djKey)) });
  if (!sources.length) return json({ ok: false, error: "no_backup" });

  let fallback: { name: string; answer: Answer } | null = null;
  let lastError = "backup_failed";
  for (const s of sources) {
    let a: Answer;
    try { a = await s.run(); } catch { a = { ok: false, error: "backup_failed" }; }
    if (!a.ok) { lastError = a.error; continue; }
    // An empty answer may only mean this source leaves such files out
    // (EasyAPI: criminal cases) — the next one is asked too.
    if (empty(a)) { fallback = fallback || { name: s.name, answer: a }; continue; }
    return json({ ...a, provider: s.name });
  }
  if (fallback) return json({ ...fallback.answer, provider: fallback.name });
  return json({ ok: false, error: lastError });
});
