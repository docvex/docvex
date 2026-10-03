// portal-proxy — the website's "APIs" tab (docvex.ro/apis.html) reads two
// public Romanian services through this function, because neither sends CORS
// headers and a browser page cannot call them itself:
//
//   anaf  { cuis: [..] }  → ANAF PlatitorTvaRest v9 (a company's fiscal record),
//                           ≤10 CUIs a request, as of today. Answer: ANAF's own
//                           `found` / `notFound`.
//   court { numar }       → portal.just.ro CautareDosare BY FILE NUMBER ONLY.
//                           No search by party name: a public page that turns a
//                           person's name into their court cases is exactly the
//                           searchable copy of personal data we decided not to
//                           offer. Answer: the files, parsed as the desktop app
//                           parses them (main.js courtsParseDosar).
//
// Public (verify_jwt = false). Guarded by: the allowed origins below, a
// per-IP rate limit (in memory, per isolate — best effort), input shapes
// checked before anything is sent on, and timeouts. Nothing is stored and
// nothing about the visitor is logged.
//
// legislatie.just.ro is NOT proxied: it refuses every connection from
// Supabase's servers. The CAEN nomenclature needs no server (bundled JSON).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ORIGINS = new Set([
  "https://docvex.ro",
  "https://www.docvex.ro",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
]);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function corsFor(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.has(origin) ? origin : "https://docvex.ro",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsFor(req), "content-type": "application/json" } });

// ── Rate limit: 20 requests a minute per IP (per isolate) ──
const PER_MIN = 20;
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (list.length >= PER_MIN) { hits.set(ip, list); return true; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return false;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── ANAF ──
async function anaf(cuisIn: unknown) {
  const raw = Array.isArray(cuisIn) ? cuisIn : [];
  const cuis = [...new Set(raw.map((c) => Number(String(c).replace(/\D/g, ""))).filter((n) => n > 0 && n < 1e10))].slice(0, 10);
  if (!cuis.length) return { ok: false, error: "empty_query" };
  const today = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetchWithTimeout("https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
      body: JSON.stringify(cuis.map((cui) => ({ cui, data: today }))),
    }, 25_000);
    if (res.status === 429) return { ok: false, error: "rate_limited" };
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") return { ok: false, error: "bad_answer" };
    if (data.cod && Number(data.cod) !== 200) return { ok: false, error: `anaf_${data.cod}` };
    return { ok: true, asOf: today, found: Array.isArray(data.found) ? data.found : [], notFound: Array.isArray(data.notFound) ? data.notFound : [] };
  } catch (e) {
    return { ok: false, error: (e as Error)?.name === "AbortError" ? "timeout" : "unreachable" };
  }
}

// ── Courts (portal.just.ro) ──
const COURTS_NS = "portalquery.just.ro";
const unxml = (s: string) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&");
const xmlField = (block: string, tag: string) => {
  const m = new RegExp(`<(?:\\w+:)?${tag}(?=[\\s/>])[^>]*?(/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`).exec(block);
  return m && m[1] !== "/>" ? unxml(m[2]) : "";
};
const xmlBlocks = (xml: string, tag: string) => {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
  return out;
};
const soapDate = (s: string) => String(s || "").replace(/\.\d+$/, "");

function parseDosar(block: string) {
  const own = block.replace(/<(parti|sedinte|caiAtac)>[\s\S]*?<\/\1>/g, "").replace(/<(parti|sedinte|caiAtac)\s*\/>/g, "");
  return {
    numar: xmlField(own, "numar"),
    numarVechi: xmlField(own, "numarVechi"),
    data: soapDate(xmlField(own, "data")),
    institutie: xmlField(own, "institutie"),
    departament: xmlField(own, "departament"),
    categorie: xmlField(own, "categorieCazNume") || xmlField(own, "categorieCaz"),
    stadiu: xmlField(own, "stadiuProcesualNume") || xmlField(own, "stadiuProcesual"),
    obiect: xmlField(own, "obiect"),
    modificat: soapDate(xmlField(own, "dataModificare")),
    parti: xmlBlocks(block, "DosarParte").map((p) => ({ nume: xmlField(p, "nume").trim(), calitate: xmlField(p, "calitateParte").trim() })),
    sedinte: xmlBlocks(block, "DosarSedinta").map((s) => ({
      complet: xmlField(s, "complet"),
      data: soapDate(xmlField(s, "data")),
      ora: xmlField(s, "ora"),
      solutie: xmlField(s, "solutie"),
      sumar: xmlField(s, "solutieSumar"),
      pronuntare: soapDate(xmlField(s, "dataPronuntare")),
      document: xmlField(s, "documentSedinta"),
    })),
    caiAtac: xmlBlocks(block, "DosarCaleAtac").map((c) => ({
      data: soapDate(xmlField(c, "dataDeclarare")),
      parte: xmlField(c, "parteDeclaratoare").trim().replace(/,\s*$/, ""),
      tip: xmlField(c, "tipCaleAtac"),
    })),
  };
}

// A court file number: 1234/3/2026, 1234/3/2026/a1, 12/87/2025* …
const FILE_RE = /^\d{1,7}\/\d{1,4}(?:\/\d{2,4})(?:\/[a-z0-9.*]{1,8})?\*?$/i;

async function court(numarIn: unknown) {
  const numar = String(numarIn || "").trim().replace(/\s+/g, "");
  if (!FILE_RE.test(numar)) return { ok: false, error: "bad_number" };
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
    + `<CautareDosare xmlns="${COURTS_NS}"><numarDosar>${numar}</numarDosar></CautareDosare>`
    + "</soap:Body></soap:Envelope>";
  const headers = { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${COURTS_NS}/CautareDosare"`, "User-Agent": UA };
  // HTTPS first; plain HTTP only when HTTPS cannot be reached at all (a file
  // NUMBER is not a person's name — the desktop app allows the same).
  for (const url of ["https://portalquery.just.ro/query.asmx", "http://portalquery.just.ro/query.asmx"]) {
    try {
      const res = await fetchWithTimeout(url, { method: "POST", headers, body }, 30_000);
      // 52x: the HTTPS front could not reach the service (its address
      // answered 525 on 2026-10-02) — as good as unreachable.
      if (res.status >= 520 && res.status <= 530 && url.startsWith("https:")) continue;
      const xml = await res.text();
      if (/<(?:\w+:)?Fault>/.test(xml)) return { ok: false, error: "service_fault" };
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      const blocks = xmlBlocks(xml, "Dosar");
      return { ok: true, insecure: url.startsWith("http:"), dosare: blocks.slice(0, 20).map(parseDosar) };
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return { ok: false, error: "timeout" };
      // unreachable → try the next endpoint
    }
  }
  return { ok: false, error: "unreachable" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "method" }, 405);
  const origin = req.headers.get("origin") || "";
  if (origin && !ORIGINS.has(origin)) return json(req, { ok: false, error: "origin" }, 403);
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return json(req, { ok: false, error: "rate_limited" }, 429);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json(req, { ok: false, error: "bad_json" }, 400); }
  if (body.action === "anaf") return json(req, await anaf(body.cuis));
  if (body.action === "court") return json(req, await court(body.numar));
  return json(req, { ok: false, error: "unknown_action" }, 400);
});
