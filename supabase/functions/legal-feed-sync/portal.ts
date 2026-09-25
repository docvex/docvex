// legislatie.just.ro — the Ministry of Justice's free web service, and the
// rules for what in it is worth a lawyer's attention.
//
// Pure: no Deno APIs, no database. Kept apart from index.ts so it can be
// compiled and run under Node against the live portal (see the README).
//
// The service: SOAP, `GetToken` (anonymous) then `Search`. What it does and
// does not do, measured rather than documented (there are no docs):
//   · At most 10 records per page, whatever `RezultatePagina` asks for.
//   · `SearchAn` lists what is IN FORCE that year, not what was issued in it.
//   · That year listing is NOT STABLE: the same page asked twice answers
//     different acts, the same act turns up on two pages, and where the list
//     "ends" moves by a dozen pages between calls. Three reads of its newest
//     thirty pages each saw only 50-65% of what the three saw together. It is
//     no way to find what is new, and is used here only for a rough bearing.
//   · What IS stable is a search on the title, and every record's title ends
//     with the Monitorul Oficial issue it was printed in ("… PUBLICAT ÎN
//     Monitorul Oficial nr. 803 din 22 septembrie 2026"). Issues are numbered
//     1, 2, 3… through the year, so new acts are found ISSUE BY ISSUE
//     (`issue`), which answers the same thing every time and misses nothing.
//   · A past-the-end page answers an empty list.
//   · nginx answers 403 to a non-browser user agent.

const ENDPOINT = "https://legislatie.just.ro/apiws/FreeWebService.svc/SOAP";
const NS = "http://tempuri.org/IFreeWebService";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const TIMEOUT_MS = 30000;
export const PAGE_SIZE = 10;

export type PortalAct = {
  portalId: string;
  type: string;        // TipAct, as the portal writes it: "HOTĂRÂRE", "ORDIN"…
  number: string;
  issuer: string;
  title: string;       // the act's own title, masthead trailer cut off
  moRef: string;       // "Monitorul Oficial nr. 803 din 22 septembrie 2026"
  moNumber: number;    // 803 (0 when the title names no issue)
  moBis: boolean;      // a "bis" supplement to that issue
  moDate: string;      // ISO date of that issue, or ""
  issuedYear: string;  // the year in "nr. 721 din 11 septembrie 2026"
  inForce: string;     // DataVigoare, ISO date
  link: string;
  text: string;
  annexText?: string;  // the rules this act approves, when published as a separate record
};

// ── Transport ───────────────────────────────────────────────────────────
// The service is a single, old server: fifteen requests at once get 503s. So
// callers keep to a couple at a time (`mapLimit`), and a 503/429/timeout is
// retried after a pause rather than failing the run.
const RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The server's HTTP/2 is broken — "stream error: unspecific protocol error"
// on the first request — and a runtime that negotiates HTTP/2 (Supabase's
// Deno does, Node's fetch doesn't) cannot talk to it at all. So the caller may
// hand in a fetch pinned to HTTP/1.1 (index.ts does); this file stays free of
// any one runtime's API.
let portalFetch: typeof fetch = (...args) => fetch(...args);
export function setPortalFetch(fn: typeof fetch) { portalFetch = fn; }

async function post(action: string, body: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await postOnce(action, body);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient = /portal_http_(?:5\d\d|429)|abort|http2|SendRequest|connection|reset/i.test(msg);
      if (!transient || attempt >= RETRIES) throw err;
      await sleep(1500 * 2 ** attempt);
    }
  }
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function postOnce(action: string, body: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await portalFetch(ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `"${NS}/${action}"`,
        "User-Agent": UA,
      },
      body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`,
    });
    if (!res.ok) throw new Error(`portal_http_${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unxml(s: string): string {
  return s.replace(/&(?:#(x?)([0-9a-fA-F]+)|([a-z]+));/g, (m, hex, num, name) => {
    if (num) {
      try { return String.fromCodePoint(parseInt(num, hex ? 16 : 10)); } catch { return m; }
    }
    return name in ENTITIES ? ENTITIES[name] : m;
  });
}
function field(block: string, tag: string): string {
  const m = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(block);
  return m ? unxml(m[1]) : "";
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class Portal {
  private token = "";

  private async auth(force = false): Promise<string> {
    if (this.token && !force) return this.token;
    const xml = await post("GetToken", '<GetToken xmlns="http://tempuri.org/"/>');
    const key = field(xml, "GetTokenResult");
    if (!key) throw new Error("portal_no_token");
    this.token = key;
    return key;
  }

  /** One page of the year listing (unstable — see the header), or of a title search. */
  async page(year: number, page: number, q: { titlu?: string } = {}): Promise<PortalAct[]> {
    const body = (token: string) =>
      '<Search xmlns="http://tempuri.org/">' +
      '<SearchModel xmlns:d="http://schemas.datacontract.org/2004/07/FreeWebService">' +
      `<d:NumarPagina>${page}</d:NumarPagina><d:RezultatePagina>${PAGE_SIZE}</d:RezultatePagina>` +
      `<d:SearchAn>${year}</d:SearchAn>` +
      (q.titlu ? `<d:SearchTitlu>${esc(q.titlu)}</d:SearchTitlu>` : "") +
      `</SearchModel><tokenKey>${esc(token)}</tokenKey></Search>`;
    let xml = await post("Search", body(await this.auth()));
    // An expired token comes back as a SOAP fault, not an empty list.
    if (/<(?:\w+:)?Fault>/.test(xml)) xml = await post("Search", body(await this.auth(true)));
    if (/<(?:\w+:)?Fault>/.test(xml)) throw new Error("portal_fault");
    return parseActs(xml);
  }

  /**
   * Every act printed in issue `n` of the year's Monitorul Oficial (Part I),
   * with its "bis" supplement. The title search also matches acts whose OWN
   * title mentions "Monitorul Oficial nr. 803 din…" (an amendment citing where
   * the amended act was published), so results are kept only when the issue
   * they were printed in is `n`.
   */
  async issue(year: number, n: number): Promise<PortalAct[]> {
    const out: PortalAct[] = [];
    for (const titlu of [`Monitorul Oficial nr. ${n} din`, `Monitorul Oficial nr. ${n} bis din`]) {
      for (let p = 1; p <= 10; p++) {
        const rows = await this.page(year, p, { titlu });
        out.push(...rows.filter((a) => a.moNumber === n && a.moDate.startsWith(String(year))));
        if (rows.length < PAGE_SIZE) break;
      }
    }
    return uniqueActs(out);
  }

  /**
   * A recent issue number, for a job with nothing remembered: the highest
   * issue among the acts at the end of the year listing. That listing is
   * unstable, but any bearing within a few issues of the end will do — the
   * walk forward from it is what finds the actual end.
   */
  async recentIssue(year: number): Promise<number> {
    const last = await this.lastPage(year, 1);
    if (!last) return 0;
    const rows = (await mapLimit([last - 1, last].filter((p) => p > 0), 2, (p) => this.page(year, p))).flat();
    return Math.max(0, ...rows.filter((a) => a.moDate.startsWith(String(year))).map((a) => a.moNumber));
  }

  /** The last non-empty page of the year listing (a rough bearing only). */
  async lastPage(year: number, hint = 1): Promise<number> {
    const has = async (p: number) => (await this.page(year, p)).length > 0;
    let lo = Math.max(1, hint);
    if (!(await has(lo))) {
      // Shrank (a new year, or a bad hint): gallop down.
      let step = 8;
      let hi = lo;
      lo = Math.max(1, lo - step);
      while (lo > 1 && !(await has(lo))) { hi = lo; step *= 2; lo = Math.max(1, lo - step); }
      if (lo === 1 && !(await has(1))) return 0;
      return bisect(lo, hi, has);
    }
    let step = 8;
    let hi = lo + step;
    while (await has(hi)) { lo = hi; step *= 2; hi = lo + step; }
    return bisect(lo, hi, has);
  }
}

// `lo` has results, `hi` has none.
async function bisect(lo: number, hi: number, has: (p: number) => Promise<boolean>): Promise<number> {
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await has(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

// ── Reading a record ────────────────────────────────────────────────────
const MONTHS: Record<string, number> = {
  ianuarie: 1, februarie: 2, martie: 3, aprilie: 4, mai: 5, iunie: 6,
  iulie: 7, august: 8, septembrie: 9, octombrie: 10, noiembrie: 11, decembrie: 12,
};
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function roDate(day: string, month: string, year: string): string {
  const m = MONTHS[fold(month)];
  if (!m) return "";
  return `${year}-${String(m).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function parseActs(xml: string): PortalAct[] {
  const out: PortalAct[] = [];
  const re = /<(?:\w+:)?Legi>([\s\S]*?)<\/(?:\w+:)?Legi>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const b = m[1];
    const act = actFromRecord({
      link: field(b, "LinkHtml"),
      tipAct: field(b, "TipAct"),
      numar: field(b, "Numar"),
      emitent: field(b, "Emitent"),
      titlu: field(b, "Titlu"),
      dataVigoare: field(b, "DataVigoare"),
      text: field(b, "Text"),
    });
    if (act) out.push(act);
  }
  return out;
}

/** The portal's record fields, as its SOAP answer names them (and as the
 * desktop app's `legislation:search` hands them over). */
export type PortalRecord = {
  link?: string; tipAct?: string; numar?: string; emitent?: string;
  titlu?: string; dataVigoare?: string; text?: string;
};

// The portal writes the old cedilla letters (ş, ţ); Romanian is written with
// the comma below (ș, ț), which is what the rest of the app uses.
const commaBelow = (s: string) =>
  s.replace(/ş/g, "ș").replace(/Ş/g, "Ș").replace(/ţ/g, "ț").replace(/Ţ/g, "Ț");

/** One record → an act, or null when it carries no portal document id. */
export function actFromRecord(r: PortalRecord): PortalAct | null {
  const link = String(r.link || "").replace(/^http:\/\//i, "https://");
  const portalId = (/DetaliiDocument(?:Afis)?\/(\d+)/i.exec(link) || [])[1] || "";
  if (!portalId) return null;
  // `Titlu` is the printed act's whole masthead run together: the title,
  // then "EMITENT <body> PUBLICAT ÎN Monitorul Oficial nr. X din <date>".
  const raw = String(r.titlu || "").replace(/\s+/g, " ").replace(/^\uFEFF/, "").trim();
  const cut = raw.search(/\s+EMITENT\s/);
  const title = (cut > 0 ? raw.slice(0, cut) : raw).trim();
  const mo = /Monitorul Oficial\s+nr\.\s*([\d.]+)(\s*bis)?\s+din\s+(\d{1,2})\s+([a-zăâîșşțţ]+)\s+(\d{4})/i.exec(raw);
  const issued = /\bdin\s+\d{1,2}\s+[a-zăâîșşțţ]+\s+(\d{4})/i.exec(title);
  // The portal's `Emitent` field loses ș and ț ("Banca Na?ională"); the same
  // name in the title's masthead ("EMITENT Banca Naţională PUBLICAT ÎN …")
  // keeps them, so it is read from there when it is there.
  const fromTitle = /\sEMITENT\s+(.+?)\s+PUBLICAT\s/.exec(raw)?.[1]?.trim();
  return {
    portalId,
    type: String(r.tipAct || "").trim(),
    number: String(r.numar || "").trim(),
    issuer: commaBelow(fromTitle || String(r.emitent || "").trim()),
    title: commaBelow(title),
    moRef: mo ? `Monitorul Oficial nr. ${mo[1]}${mo[2] ? " bis" : ""} din ${mo[3]} ${mo[4]} ${mo[5]}` : "",
    moNumber: mo ? Number(mo[1].replace(/\./g, "")) : 0,
    moBis: !!mo?.[2],
    moDate: mo ? roDate(mo[3], mo[4], mo[5]) : "",
    issuedYear: issued ? issued[1] : "",
    inForce: String(r.dataVigoare || "").trim(),
    link,
    text: String(r.text || ""),
  };
}

// ── What is worth a lawyer's attention ──────────────────────────────────
// The free first pass. It only ever DROPS, and only what can be told from the
// record's shape with certainty — anything it is unsure of goes to the model.
// Measured over a week of issues: about four acts in five fall here.

// Kinds of record that never change what a client must do.
const SKIP_TYPES = [
  "DECRET",        // decorations, citizenship, pardons, promulgation (the LAW itself arrives separately)
  "RECTIFICARE",   // typo corrections to an act already published
  "ERATĂ",
  "RAPORT",        // activity / audit reports
  "COMUNICAT",     // exchange rates, notices
  "LISTĂ",
  "AVIZ",          // Legislative Council / ESC opinions on drafts
  "PUNCT DE VEDERE",
  "MOȚIUNE",
];

// Individual acts, by the words their titles are built from.
const SKIP_TITLE = [
  /\bnumirea\b/, /\beliberarea din funct/, /\bincetarea (?:mandatului|exercitarii)/,
  /\bdelegarea atributiilor\b/, /\bexercitarea,? (?:cu caracter temporar|temporara)/,
  /\bacordarea (?:titlului|statutului|cetateniei|distinctiei|gradului|ordinului|medaliei)/,
  /\bconferirea\b/, /\bretragerea (?:cetateniei|ordinului|decoratiei)/,
  /\bredobandirea cetateniei\b/, /\bgratier/,
  /\bindicatorilor tehnico-economici\b/,
  /\btrecerea (?:unor|unui|a unor)?\s*(?:imobil|bunuri|teren)/, /\btransmiterea (?:unor|unui)?\s*(?:imobil|bunuri|teren)/,
  /\bdin domeniul public al statului\b.*\bin domeniul public al\b/,
  /\bschimbarea (?:denumirii|destinatiei) (?:unui|unor)\b/,
  /\bsuplimentarea bugetului\b/, /\balocarea unei sume\b/, /\bdin fondul de rezerva bugetara\b/,
  /\bnumarului maxim de posturi\b/, /\bstatului de functii\b/,
  /\bdeclararea ca zi de doliu\b/, /\bconstituirea comisiei\b/,
  // One institution, one company, one building.
  /\bacordarea (?:autorizatiei|acreditarii)\b/, /\b(?:infiintarea|desfiintarea) unitatii\b/,
  /\bautorizarea de functionare a (?:societatii|unitatii)\b/, /\bla cerere,? a retragerii\b/,
  /\bbugetului de venituri si cheltuieli\b/, /\bcontul de executie\b/,
  /\bvacantarea\b/, /\bvalidarea (?:unui|unor) mandat/,
  /\bvalori(?:i|lor) de inventar\b/, /\bdescrierii tehnice\b/,
  /\bdomeniului de doctorat\b/, /\bamplasamentului\b/, /\bexpropriere\b/,
  /\bnormativelor de cheltuieli\b/, /\bdeclararea (?:ca )?de utilitate publica\b/,
  /\binventarul centralizat\b/, /\bdin domeniul public\b/, /\bin domeniul public\b/,
  /\binchirierea unor\b/, /\balegerea presedintelui\b/,
];

// Records that are the BODY of another act published in the same issue: an
// order "pentru aprobarea Instrucțiunilor…" and the Instructions themselves are
// two records. The rules belong to the order, so they are attached to it
// (their text is what a summary needs) and not listed on their own.
const ANNEX_TYPES = /^(norm|instructiuni|metodologie|regulament|procedur|contract-cadru|anexa|ghid|cod|amendament|acord|conventie|protocol|tratat)/;

/** Moves each unnumbered annex's text onto the act that approves it. Returns the ids absorbed. */
export function attachAnnexes(acts: PortalAct[]): Map<string, string> {
  const absorbed = new Map<string, string>(); // annex id → parent id
  for (const annex of acts) {
    const kind = fold(annex.type);
    if ((annex.number && annex.number !== "0") || !ANNEX_TYPES.test(kind) || !annex.moRef) continue;
    // Four letters: the parent names the annex in the genitive ("aprobarea
    // Normelor" for a NORMĂ record), so only the stem is shared.
    const stem = kind.slice(0, 4);
    const parent = acts.find((a) =>
      a !== annex && a.moRef === annex.moRef && a.number && a.number !== "0"
      && /\b(?:aprob|ratific)/.test(fold(a.title)) && fold(a.title).includes(stem));
    if (!parent) continue;
    parent.annexText = `${parent.annexText ? parent.annexText + "\n\n" : ""}${annex.title}\n${annex.text}`;
    absorbed.set(annex.portalId, parent.portalId);
  }
  return absorbed;
}

// One act, several records: a JOINT order is signed by several ministries and
// the portal lists it once per signatory — same issue, same subject, a
// different number and issuer on each. Seven records of "the agricultural
// register's technical norms" are one piece of news. Grouped by issue and by
// the title after its number and date; the record with the longest text is
// kept and the others are marked as its co-signatures.
const subjectOf = (a: PortalAct) =>
  fold(a.title).replace(/^.*?\bdin\s+\d{1,2}\s+\S+\s+\d{4}\s*/, "").replace(/\s+/g, " ").trim();

/** Returns the ids of co-signature records, each mapped to the record kept for the act. */
export function mergeJointActs(acts: PortalAct[]): Map<string, string> {
  const groups = new Map<string, PortalAct[]>();
  for (const a of acts) {
    const subject = subjectOf(a);
    if (!a.moRef || subject.length < 25) continue; // too short to be sure it's the same act
    const key = `${a.moRef}|${a.type}|${subject}`;
    groups.set(key, [...(groups.get(key) || []), a]);
  }
  const merged = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = group.reduce((best, a) => (a.text.length > best.text.length ? a : best));
    for (const a of group) if (a !== keep) merged.set(a.portalId, keep.portalId);
  }
  return merged;
}

export type Verdict = { keep: boolean; reason: string };

export function freeVerdict(a: PortalAct): Verdict {
  const type = a.type.toUpperCase();
  if (SKIP_TYPES.some((t) => type.startsWith(t))) return { keep: false, reason: `kind: ${a.type}` };
  // A chamber's own decisions — its budget, its members' mandates, its opinion
  // on a Commission communication — bind no one outside it.
  if (/^HOT/.test(type) && /^(senatul|camera deputatilor|parlamentul)/.test(fold(a.issuer))) {
    return { keep: false, reason: `parliamentary decision (${a.issuer})` };
  }
  const t = fold(a.title);
  for (const re of SKIP_TITLE) if (re.test(t)) return { keep: false, reason: `individual act (${re.source.replace(/\\b/g, "")})` };
  // A Constitutional Court decision on an exception matters only when the
  // exception was ADMITTED — the great majority are rejected, which changes
  // nothing. The operative part says which.
  if (/exceptia de neconstitutionalitate/.test(t)) {
    const body = fold(a.text);
    if (/\badmite\s+exceptia\b/.test(body)) return { keep: true, reason: "CCR: exception admitted" };
    return { keep: false, reason: "CCR: exception rejected" };
  }
  return { keep: true, reason: "" };
}

// ── Labels ──────────────────────────────────────────────────────────────
// How a lawyer writes the act in a headline: "HG 721/2026", "OUG 12/2026",
// "Legea 138/2026", "Ordinul ANAF 1.238/2026".
/** The same record can come back on two pages (the paging overlaps). */
export function uniqueActs(acts: PortalAct[]): PortalAct[] {
  const seen = new Set<string>();
  return acts.filter((a) => !seen.has(a.portalId) && seen.add(a.portalId));
}

const SHORT: Array<[RegExp, string]> = [
  [/^ordonanta de urgenta/, "OUG"],
  [/^ordonanta/, "OG"],
  [/^hotarare/, "HG"],
  [/^lege/, "Legea"],
  [/^ordin/, "Ordinul"],
  [/^decizie/, "Decizia"],
  [/^regulament/, "Regulamentul"],
  [/^norm/, "Normele"],
  [/^instructiuni/, "Instrucțiunile"],
  [/^metodologie/, "Metodologia"],
  [/^circulara/, "Circulara"],
];
const ISSUER_SHORT: Array<[RegExp, string]> = [
  [/agentia nationala de administrare fiscala/, "ANAF"],
  [/autoritatea de supraveghere financiara/, "ASF"],
  [/banca nationala/, "BNR"],
  [/curtea constitutionala/, "CCR"],
  [/inalta curte de casatie/, "ICCJ"],
  [/protectia datelor/, "ANSPDCP"],
  [/registrul comertului/, "ONRC"],
  [/ministerul finantelor/, "MF"],
  [/ministerul muncii/, "MMSS"],
  [/ministerul justitiei/, "MJ"],
  [/consiliul concurentei/, "Consiliul Concurenței"],
  [/reglementare in domeniul energiei/, "ANRE"],
  [/administrare si reglementare in comunicatii/, "ANCOM"],
  [/protectia consumatorilor/, "ANPC"],
  [/sanitare veterinare/, "ANSVSA"],
  [/solutionarea contestatiilor/, "CNSC"],
  [/casa nationala de asigurari de sanatate/, "CNAS"],
];

// An issuer with no established abbreviation: the initials of its capitalised
// words, which is how Romanian writes the ministries ("Ministerul Educației și
// Cercetării" → MEC). Only for ministries — elsewhere initials invent names.
function issuerShort(issuer: string): string {
  const f = fold(issuer);
  const known = ISSUER_SHORT.find(([re]) => re.test(f));
  if (known) return known[1];
  if (!/^ministerul\b/.test(f)) return "";
  return issuer.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w)).map((w) => w[0]).join("").toUpperCase();
}

export function actLabel(a: PortalAct): string {
  const f = fold(a.type);
  let short = (SHORT.find(([re]) => re.test(f)) || [null, a.type.charAt(0) + a.type.slice(1).toLowerCase()])[1];
  const year = a.issuedYear || (a.moDate || "").slice(0, 4);
  const num = a.number && a.number !== "0" ? `${a.number}${year ? `/${year}` : ""}` : year;
  // "HG" is a GOVERNMENT decision; anyone else's is "Hotărârea …" of its body.
  if (short === "HG" && !/^guvernul/.test(fold(a.issuer))) {
    return [`Hotărârea ${num}`, issuerShort(a.issuer) || a.issuer].filter(Boolean).join(" · ");
  }
  // Government decisions and ordinances name their issuer by their kind; an
  // order or a decision needs it, or "Ordinul 1.238/2026" is one of forty.
  const needsIssuer = /^(ordin|decizie|regulament|norm|instructiuni|metodologie|circulara)/.test(f);
  const iss = needsIssuer ? issuerShort(a.issuer) : "";
  return [short, iss, num].filter(Boolean).join(" ");
}
