// SOURCE CHECKS — every document the AI writes is checked against the official
// sources the app is connected to, and a draft that says something a source
// contradicts is corrected before the user is left with it.
//
// ONE REGISTRY, ONE ENTRY PER PLATFORM (`SOURCES`). An entry says:
//   id, label, tab      — the platform, and the Legislation tab that reads it
//                         (components/LegalTabs LEGAL_TABS id)
//   available()         — whether it can be asked right now (desktop only for
//                         the portals: they are called from the main process)
//   find(text)          — what in a text this source can check → refs
//                         [{ key, raw, … }] (key dedupes)
//   check(ref)          — ask the source → { status, title, detail, excerpt,
//                         facts, source: 'live' | 'archive' }
//                         status: 'ok' | 'warn' | 'error' | 'unknown'
//   plan                — for a platform NOT yet connected (`check` absent):
//                         what it will check. Its refs are still FOUND and the
//                         report lists them as waiting for it.
//
// CONNECTING A NEW PLATFORM = giving its entry a `check` (and dropping its
// `stub: true` in LEGAL_TABS). Nothing else changes: `checkText` runs every
// entry that has one, the Doc Viewer checks every AI-written version with it,
// the brief grounds the draft with it, the report card lists it, and the
// correction turn hands its evidence to the AI.
//
// Pure data + fetching; no UI. Answers are memoised for the session
// (`CHECK_TTL_MS`), so a corrected draft citing the same acts costs nothing.

import { isElectron } from './platform';
import { findLawRefs, findCaseRefs, findEntityRefs, lawRefDetails } from './lawRefs';
import { searchLegislation, legislationQueryFor, fold, actLabel } from './legislation';

const PER_SOURCE_MAX = 14;       // refs of one source checked per text
const CONCURRENCY = 3;
const CHECK_TTL_MS = 15 * 60 * 1000;
const EXCERPT_MAX = 900;

const clip = (s, n = EXCERPT_MAX) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const squash = (s) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim();

// ── legislatie.just.ro — Romanian normative acts ────────────────────────────
// The codes are cited by name; the portal knows them by the law that enacted
// them. (The Constitution has no number and is left to the reader.)
const CODES = [
  [/proc(edur[ăa])?\.?\s*civ|C\.?\s*proc\.?\s*civ|\bN?CPC\b/i, { tip: 'LEGE', numar: '134', an: '2010', name: 'Codul de procedură civilă' }],
  [/proc(edur[ăa])?\.?\s*pen|C\.?\s*pr\.?\s*pen|\bN?CPP\b/i, { tip: 'LEGE', numar: '135', an: '2010', name: 'Codul de procedură penală' }],
  [/proc(edur[ăa])?\s*fiscal/i, { tip: 'LEGE', numar: '207', an: '2015', name: 'Codul de procedură fiscală' }],
  [/civil|C\.?\s*civ/i, { tip: 'LEGE', numar: '287', an: '2009', name: 'Codul civil' }],
  [/penal|C\.?\s*pen/i, { tip: 'LEGE', numar: '286', an: '2009', name: 'Codul penal' }],
  [/munc/i, { tip: 'LEGE', numar: '53', an: '2003', name: 'Codul muncii' }],
  [/fiscal/i, { tip: 'LEGE', numar: '227', an: '2015', name: 'Codul fiscal' }],
  [/administrativ/i, { tip: 'ORDONANȚĂ DE URGENȚĂ', numar: '57', an: '2019', name: 'Codul administrativ' }],
];
// EU acts are not on the national portal — they wait for EUR-Lex.
const EU_ACT = /\b(directiv|regulamentul\s*\((?:ue|ce|cee)\)|decizia\s*\((?:ue|ce)\))|\/(?:ue|ce|cee|euratom)\b|\((?:ue|ce|cee)\)/i;

// "art. 1270 alin. (1)" → "1270". Code articles carry thousands dots in some
// texts ("art. 1.270").
function articleOf(element) {
  const m = /\bart(?:icolul|\.)?\s*(\d{1,2}(?:\.\d{3})|\d{1,5})(?:\s*\^?\s*(\d+))?/i.exec(String(element || ''));
  if (!m) return '';
  return m[1].replace(/\./g, '') + (m[2] ? `^${m[2]}` : '');
}

function legislationRefs(text) {
  const out = new Map();
  const add = (key, ref) => {
    const had = out.get(key);
    if (had) {
      for (const a of ref.articles) if (!had.articles.includes(a)) had.articles.push(a);
      if (!had.cited && ref.cited) { had.cited = ref.cited; had.raw = ref.raw; }
      return;
    }
    out.set(key, ref);
  };
  const hits = findLawRefs(text);
  hits.forEach((hit, i) => {
    if (hit.kind !== 'act' && hit.kind !== 'code') return;
    const d = lawRefDetails(hit);
    let art = articleOf(d.element || hit.raw);
    if (hit.kind === 'code') {
      const code = CODES.find(([re]) => re.test(hit.raw))?.[1];
      if (!code) return;
      // "art. 1270 C. civ." — the detector finds the article and the code as
      // two hits side by side; the article belongs to the code.
      const prev = hits[i - 1];
      if (!art && prev?.kind === 'element' && /^[\s,]*(?:din\s+)?$/iu.test(text.slice(prev.end, hit.start))) art = articleOf(prev.raw);
      const key = `${code.numar}/${code.an}`;
      add(key, { key, raw: code.name, query: code, cited: '', articles: art ? [art] : [] });
      return;
    }
    if (EU_ACT.test(hit.raw)) return;
    const q = legislationQueryFor(d);
    if (!q?.numar || !q?.an) return;
    const key = `${q.numar}/${q.an}`;
    add(key, { key, raw: d.heading || hit.raw, query: { tip: q.tip, numar: q.numar, an: q.an }, cited: d.title, articles: art ? [art] : [] });
  });
  return [...out.values()];
}

// The article's text, read off the act's own text: from its heading
// ("Articolul 1270" / "Art. 1270", a superscript as "1270^1") to the next
// article's. The portal's "+" unit separators are dropped.
function findArticle(text, art) {
  const [num, sup] = art.split('^');
  const t = String(text || '');
  const digits = num.length > 3 ? `${num.slice(0, -3)}\\.?${num.slice(-3)}` : num;
  const tail = sup ? `\\s*\\^\\s*${sup}` : '(?!\\s*\\^)';
  const head = new RegExp(`(?:^|\\n)\\s*(?:Articolul|Art\\.)\\s*${digits}${tail}(?!\\d|\\.\\d)`, 'iu');
  const m = head.exec(t);
  if (!m) return null;
  const rest = t.slice(m.index + m[0].length);
  const next = /\n\s*(?:Articolul|Art\.)\s*\d/iu.exec(rest);
  return rest.slice(0, next ? next.index : 4000).replace(/\n\s*\+\s*(?=\n)/g, '').trim();
}

async function checkLegislation(ref) {
  const res = await searchLegislation({ ...ref.query, perPage: 10 });
  if (!res?.ok) return { status: 'unknown', title: ref.raw, detail: 'The portal could not be reached and nothing is kept on this machine.' };
  const recs = res.records || [];
  const same = recs.filter((r) => r.numar === ref.query.numar && (!r.year || r.year === ref.query.an));
  if (!same.length) {
    if (res.source === 'archive') return { status: 'unknown', title: ref.raw, detail: 'The portal could not be reached, and the copy on this machine doesn’t have this act.' };
    return { status: 'error', title: ref.raw, detail: `No ${ref.query.tip ? ref.query.tip.toLowerCase() : 'act'} nr. ${ref.query.numar}/${ref.query.an} exists on legislatie.just.ro — the citation is probably wrong.`, source: res.source };
  }
  // The newest in-force version (the portal lists every consolidated version).
  const rec = [...same].sort((a, b) => String(b.dataVigoare).localeCompare(String(a.dataVigoare)))[0];
  const facts = [`Official title: ${actLabel(rec)} ${rec.title}`.trim()];
  if (rec.dataVigoare) facts.push(`Version in force from ${rec.dataVigoare}`);
  const issues = [];
  const head = `${rec.titlu} ${String(rec.text || '').slice(0, 600)}`;
  if (/\babrogat[ăa]?\b/i.test(head)) issues.push('the act appears to be REPEALED');
  // A title the document gives that shares almost nothing with the real one.
  if (ref.cited) {
    const a = new Set(squash(ref.cited).split(' ').filter((w) => w.length > 3));
    const b = new Set(squash(rec.title).split(' ').filter((w) => w.length > 3));
    const common = [...a].filter((w) => b.has(w)).length;
    if (a.size >= 2 && common / a.size < 0.34) issues.push(`the document calls it “${clip(ref.cited, 140)}”, but its title is “${clip(rec.title, 200)}”`);
  }
  const excerpts = [];
  for (const art of ref.articles.slice(0, 6)) {
    if (!rec.text) { excerpts.push({ art, text: null }); continue; }
    const body = findArticle(rec.text, art);
    if (body == null) issues.push(`art. ${art} was not found in the act`);
    else if (/^\s*\(?\s*abrogat/i.test(body)) issues.push(`art. ${art} is REPEALED`);
    excerpts.push({ art, text: body == null ? null : clip(body) });
  }
  return {
    status: issues.length ? 'warn' : 'ok',
    title: actLabel(rec),
    detail: issues.length ? `Check: ${issues.join('; ')}.` : 'Exists on the portal as cited.',
    facts,
    excerpts: excerpts.filter((e) => e.text),
    source: res.source,
  };
}

// ── anaf.ro — companies by CUI ──────────────────────────────────────────────
// Found by the catalogue's own `cui` pattern (lib/lawRefs findEntityRefs).
function cuiRefs(text) {
  const out = new Map();
  for (const h of findEntityRefs(text)) {
    if (h.kind !== 'cui') continue;
    const cui = (/(\d{2,10})\s*$/.exec(h.raw) || [])[1];
    if (cui && !out.has(cui)) out.set(cui, { key: cui, raw: h.raw, cui, text });
  }
  return [...out.values()];
}

const stripForm = (s) => squash(s).replace(/\b(s ?r ?l|s ?a|s ?n ?c|s ?c ?s|p ?f ?a|d)\b/g, ' ').replace(/\s+/g, ' ').trim();

async function checkAnaf(ref) {
  const { lookupCompaniesKept } = await import('./anaf');
  const res = await lookupCompaniesKept(ref.cui);
  if (!res?.ok) return { status: 'unknown', title: `CUI ${ref.cui}`, detail: 'ANAF could not be reached.' };
  const c = res.companies?.[0];
  if (!c && res.source === 'archive') return { status: 'unknown', title: `CUI ${ref.cui}`, detail: 'ANAF could not be reached.' };
  if (!c) return { status: 'error', title: `CUI ${ref.cui}`, detail: `ANAF has no company with CUI ${ref.cui} — the number is probably wrong.`, source: res.source };
  const facts = [`Name: ${c.name}`];
  if (c.regCom) facts.push(`Trade register: ${c.regCom}`);
  if (c.address) facts.push(`Registered office: ${c.address}`);
  if (c.registration) facts.push(`Status: ${c.registration}`);
  const issues = [];
  if (c.inactive?.on) issues.push('ANAF lists the company as INACTIVE');
  if (c.inactive?.deleted || /radiat|radiere/i.test(c.registration || '')) issues.push('the company is STRUCK OFF');
  const name = stripForm(c.name);
  if (name && !stripForm(ref.text).includes(name)) issues.push(`the document does not name it as ANAF does (“${c.name}”)`);
  if (c.regCom && !squash(ref.text).includes(squash(c.regCom))) issues.push(`its trade register number is ${c.regCom}`);
  return {
    status: issues.length ? 'warn' : 'ok',
    title: `${c.name} · CUI ${c.cui}`,
    detail: issues.length ? `Check: ${issues.join('; ')}.` : 'Active, and named as ANAF names it.',
    facts,
    source: res.source,
  };
}

// ── insse.ro — CAEN codes ───────────────────────────────────────────────────
function caenRefs(text) {
  const out = new Map();
  for (const h of findLawRefs(text)) {
    if (h.kind !== 'caen') continue;
    for (const code of h.codes || []) if (code.length === 4 && !out.has(code)) out.set(code, { key: code, raw: `CAEN ${code}`, code, rev: h.rev || 0 });
  }
  return [...out.values()];
}

async function checkCaen(ref) {
  const { loadCaen, resolveCaen } = await import('./caen');
  const data = await loadCaen();
  const r = resolveCaen(data, ref.code, ref.rev);
  if (!r.entry && !r.rev2) return { status: 'error', title: `CAEN ${ref.code}`, detail: `${ref.code} is not a class in CAEN Rev. 2 or Rev. 3.`, source: 'live' };
  if (r.rev === 2 || (!ref.rev && !r.entry)) {
    const to = (r.rev2?.to || []).map((t) => `${t.code} ${t.name || ''}`.trim()).join('; ');
    return { status: 'warn', title: `CAEN ${ref.code}`, detail: `A Rev. 2 class (“${r.rev2?.name || ''}”), no longer in force since 2025${to ? ` — now ${to}` : ''}.`, facts: [`Rev. 2: ${r.rev2?.name || ''}`], source: 'live' };
  }
  if (r.changed) {
    return { status: 'warn', title: `CAEN ${ref.code}`, detail: `In Rev. 3 it is “${r.entry.l}”; in Rev. 2 the same number meant “${r.rev2?.name || ''}”. Make sure the revision is the one meant.`, facts: [`Rev. 3: ${r.entry.l}`], source: 'live' };
  }
  return { status: 'ok', title: `CAEN ${ref.code}`, detail: r.entry.l, facts: [`Rev. 3: ${r.entry.l}`], source: 'live' };
}

// ── portal.just.ro — court files ────────────────────────────────────────────
function caseRefs(text) {
  const out = new Map();
  for (const h of findCaseRefs(text)) if (!out.has(h.number)) out.set(h.number, { key: h.number, raw: h.raw, numar: h.number });
  return [...out.values()];
}

async function checkCourts(ref) {
  const { searchCasesKept, courtLabel, lastSolution } = await import('./courts');
  const res = await searchCasesKept({ numar: ref.numar });
  if (!res?.ok) return { status: 'unknown', title: `Dosar ${ref.numar}`, detail: 'portal.just.ro could not be reached.' };
  const d = (res.dosare || [])[0];
  if (!d && res.source === 'archive') return { status: 'unknown', title: `Dosar ${ref.numar}`, detail: 'portal.just.ro could not be reached, and the file isn’t kept on this machine.' };
  if (!d) return { status: 'warn', title: `Dosar ${ref.numar}`, detail: `portal.just.ro has no file ${ref.numar} — check the number.`, source: res.source };
  const facts = [`Court: ${courtLabel(d.institutie)}`];
  if (d.obiect) facts.push(`Object: ${d.obiect}`);
  if (d.stadiu) facts.push(`Stage: ${d.stadiu}`);
  const parties = (d.parti || []).slice(0, 6).map((p) => `${p.nume}${p.calitate ? ` (${p.calitate})` : ''}`).join('; ');
  if (parties) facts.push(`Parties: ${parties}`);
  const sol = lastSolution(d);
  if (sol?.solutie) facts.push(`Last solution: ${sol.solutie}`);
  return { status: 'ok', title: `Dosar ${d.numar}`, detail: `${courtLabel(d.institutie)}${d.obiect ? ` · ${d.obiect}` : ''}`, facts, source: res.source };
}

// ── Platforms not connected yet ─────────────────────────────────────────────
// Their refs are found today; `plan` is what their `check` will do.
const entityRefs = (kinds) => (text) => {
  const out = new Map();
  for (const h of findEntityRefs(text)) if (kinds.includes(h.kind) && !out.has(h.raw)) out.set(h.raw, { key: h.raw, raw: h.raw });
  return [...out.values()];
};
const euRefs = (text) => {
  const out = new Map();
  for (const h of findLawRefs(text)) if (h.kind === 'act' && EU_ACT.test(h.raw)) out.set(h.raw, { key: h.raw, raw: lawRefDetails(h).heading || h.raw });
  for (const h of findEntityRefs(text)) if (['cjue', 'gdpr'].includes(h.kind)) out.set(h.raw, { key: h.raw, raw: h.raw });
  return [...out.values()];
};

export const SOURCES = [
  { id: 'legislation', tab: 'legislation', label: 'legislatie.just.ro', what: 'Acts and articles cited', available: () => isElectron, find: legislationRefs, check: checkLegislation },
  { id: 'anaf', tab: 'anaf', label: 'anaf.ro', what: 'Companies by CUI', available: () => isElectron, find: cuiRefs, check: checkAnaf },
  { id: 'caen', tab: 'caen', label: 'insse.ro', what: 'CAEN codes', available: () => true, find: caenRefs, check: checkCaen },
  { id: 'courts', tab: 'portal-just', label: 'portal.just.ro', what: 'Court files', available: () => isElectron, find: caseRefs, check: checkCourts },
  { id: 'eurlex', tab: 'eurlex', label: 'eur-lex.europa.eu', what: 'EU acts and CJEU cases', find: euRefs, plan: 'Check that each EU act exists, is in force and is named correctly; quote the articles cited.' },
  { id: 'bpi', tab: 'bpi', label: 'bpi.ro', what: 'Insolvency of the parties', find: cuiRefs, plan: 'Check whether a company named by CUI is in insolvency, reorganisation or bankruptcy.' },
  { id: 'firme', tab: 'firme', label: 'termene.ro - listafirme.ro', what: 'Company records', find: cuiRefs, plan: 'Check the directors, shareholders and share capital a document states for a company.' },
  { id: 'ancpi', tab: 'ancpi', label: 'ancpi.ro', what: 'Land register', find: entityRefs(['cf', 'cadastral', 'topo']), plan: 'Check each Carte Funciară and cadastral number: owner, encumbrances, area.' },
  { id: 'rejust', tab: 'rejust', label: 'rejust.ro', what: 'Case law', find: entityRefs(['decision', 'ccr', 'ril', 'hp']), plan: 'Check that each decision cited exists and says what the document relies on.' },
  { id: 'unbr', tab: 'unbr', label: 'unbr.ro', what: 'Lawyers', find: () => [], plan: 'Check that a lawyer named in the document is registered and practising.' },
];

export const connectedSources = () => SOURCES.filter((s) => typeof s.check === 'function' && (s.available?.() ?? true));

// ── Running them ────────────────────────────────────────────────────────────
const memo = new Map();   // `${source}:${key}` → { at, result }

async function runOne(source, ref) {
  // ANAF's check reads the whole text (the name as written), so its memo is
  // keyed by the text too.
  const mk = `${source.id}:${ref.key}:${source.id === 'anaf' ? ref.text.length : ''}`;
  const hit = memo.get(mk);
  if (hit && Date.now() - hit.at < CHECK_TTL_MS) return hit.result;
  let result;
  try { result = await source.check(ref); } catch { result = { status: 'unknown', title: ref.raw, detail: 'The check failed.' }; }
  if (result.status !== 'unknown') memo.set(mk, { at: Date.now(), result });
  return result;
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); }
  }));
  return out;
}

/**
 * Check `text` against every connected source.
 * → { at, items: [{ source, label, ref, result }], waiting: [{ source, label, plan, refs }],
 *     counts: { ok, warn, error, unknown } }
 * `waiting` lists what platforms not yet connected would have checked.
 */
export async function checkText(text, { onProgress } = {}) {
  const s = String(text || '');
  const jobs = [];
  const waiting = [];
  for (const source of SOURCES) {
    let refs = [];
    try { refs = source.find(s).slice(0, PER_SOURCE_MAX); } catch { refs = []; }
    if (!refs.length) continue;
    const live = typeof source.check === 'function' && (source.available?.() ?? true);
    if (!live) {
      waiting.push({ source: source.id, label: source.label, plan: source.plan || (source.check ? 'Available in the desktop app.' : ''), refs: refs.map((r) => r.raw) });
      continue;
    }
    for (const ref of refs) jobs.push({ source, ref });
  }
  let done = 0;
  const results = await pool(jobs.map((j) => async () => {
    const r = await runOne(j.source, j.ref);
    done += 1;
    onProgress?.(done, jobs.length);
    return r;
  }), CONCURRENCY);
  const items = jobs.map((j, k) => ({ source: j.source.id, label: j.source.label, ref: { key: j.ref.key, raw: j.ref.raw }, result: results[k] }));
  const counts = { ok: 0, warn: 0, error: 0, unknown: 0 };
  for (const it of items) counts[it.result.status] = (counts[it.result.status] || 0) + 1;
  return { at: Date.now(), items, waiting, counts };
}

export const reportHasProblems = (report) => !!report && (report.counts.warn + report.counts.error) > 0;

// What the AI is told. The evidence is the SOURCE's words, labelled with where
// it came from, so the model corrects to the source rather than to itself.
function evidenceLines(items) {
  const lines = [];
  for (const it of items) {
    lines.push(`- [${it.label}] ${it.ref.raw} → ${it.result.status.toUpperCase()}: ${it.result.detail || ''}`);
    for (const f of it.result.facts || []) lines.push(`    ${f}`);
    for (const e of it.result.excerpts || []) lines.push(`    Textul oficial al art. ${e.art}: „${e.text}”`);
  }
  return lines;
}

/** The instruction for the automatic correction turn. */
export function correctionPrompt(report) {
  const bad = report.items.filter((it) => it.result.status === 'warn' || it.result.status === 'error');
  const good = report.items.filter((it) => it.result.status === 'ok' && ((it.result.excerpts || []).length || (it.result.facts || []).length));
  return [
    'Am verificat documentul salvat față de sursele oficiale conectate în aplicație. Corectează-l și salvează o versiune nouă completă cu write_document.',
    '',
    'Probleme găsite:',
    ...evidenceLines(bad),
    ...(good.length ? ['', 'Confirmate (folosește-le ca referință, nu le schimba fără motiv):', ...evidenceLines(good)] : []),
    '',
    'Reguli: corectează doar ce contrazice sursele — o citare greșită (număr, an, titlu, articol), un act sau articol abrogat (înlocuiește-l cu norma în vigoare sau elimină trimiterea), datele unei firme așa cum le are ANAF, un cod CAEN din revizia în vigoare. Nu inventa trimiteri noi. Păstrează restul documentului neschimbat. În răspunsul scurt de după salvare, spune ce ai corectat.',
  ].join('\n');
}

/** A block for a drafting request: what the sources already say about what it names. */
export function groundingBlock(report) {
  if (!report?.items?.length) return '';
  return [
    '# Verificat în sursele oficiale (înainte de redactare)',
    'Folosește aceste date exact cum le dau sursele; unde o sursă arată o problemă, ține cont de ea.',
    ...evidenceLines(report.items),
  ].join('\n');
}
