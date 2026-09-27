// THE LEGISLATION TAB'S ONE SEARCH — what a line typed into it IS, and which
// platform answers it. The tab used to be a row of platforms, each with its own
// form (Kind / Number / Year, a court and a period, a CUI box); it is one
// search bar now, like a browser's address bar: whatever is typed is read, and
// the platform that can answer it is opened with the query in its route.
//
//   "Legea 31/1990", "OUG nr. 195/2002", "HG 1383 2022"  → legislatie.just.ro, the act opened
//   "31/1990"                                             → legislatie.just.ro, by number and year
//   "1234/3/2026", "dosar 1234/3/2026"                    → portal.just.ro, the file
//   "dosare Popescu Ion", "parte SC Exemplu SRL"          → portal.just.ro, by party
//   "RO14399840", "14399840", "cui 6859662", a list       → anaf.ro
//   "6210", "caen 6210", "caen software"                  → insse.ro (CAEN)
//   anything else — words                                 → legislatie.just.ro, by title and text
//
// A prefix naming the platform ("anaf …", "caen …", "dosar …", "lege …")
// always wins. `detectQuery(text)` → { source, label, what, to } | null, `to`
// being the route (with a nonce, so the same search can be run twice).

import { findLawRefs, lawRefDetails, findCuiRefs } from './lawRefs';
import { legislationQueryFor, portalTypeFor } from './legislation';

export const OMNI_SOURCES = {
  legislation: { to: '/legislation', site: 'legislatie.just.ro' },
  caen: { to: '/caen', site: 'insse.ro' },
  'portal-just': { to: '/portal-just', site: 'portal.just.ro' },
  anaf: { to: '/anaf', site: 'anaf.ro' },
};

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// A CUI's check digit: the other digits (padded to nine) times 7 5 3 2 1 7 5 3 2,
// times ten, mod 11 (10 → 0).
const CUI_KEY = [7, 5, 3, 2, 1, 7, 5, 3, 2];
export function validCui(raw) {
  const s = String(raw || '').replace(/^ro/i, '').trim();
  if (!/^\d{2,10}$/.test(s)) return false;
  const body = s.slice(0, -1).padStart(9, '0').split('').map(Number);
  const sum = body.reduce((n, d, i) => n + d * CUI_KEY[i], 0);
  const c = (sum * 10) % 11;
  return (c === 10 ? 0 : c) === Number(s.slice(-1));
}

const route = (source, params) => {
  const p = new URLSearchParams(params);
  p.set('_', String(Date.now()));
  return `${OMNI_SOURCES[source].to}?${p.toString()}`;
};
const hit = (source, what, label, params) => ({ source, what, label, site: OMNI_SOURCES[source].site, params, get to() { return route(source, params); } });

const KIND_WORD = '(lege[a]?|l|o\\.?\\s?u\\.?\\s?g\\.?|o\\.?\\s?g\\.?|h\\.?\\s?g\\.?|ordonan[țţt][aă](?:\\s+de\\s+urgen[țţt][aă])?(?:\\s+a\\s+guvernului)?|hot[aă]r[aâ]re(?:a)?(?:\\s+(?:a\\s+)?guvernului)?|ordin(?:ul)?|decret(?:ul)?|decizi[ae]|regulament(?:ul)?|norm[aăe]|instruc[țţt]iuni(?:le)?)';
const ACT_RE = new RegExp(`^${KIND_WORD}\\.?\\s*(?:nr\\.?\\s*)?(\\d{1,5})\\s*(?:\\/|\\s+din\\s+|\\s+)\\s*((?:19|20)\\d{2}|\\d{2})\\b\\.?$`, 'iu');
const KIND_OF = (w) => {
  const f = fold(w).replace(/\s+/g, ' ').trim();
  if (f === 'l') return 'LEGE';
  return portalTypeFor(f);
};
const fullYear = (y) => (y.length === 2 ? (Number(y) > 40 ? `19${y}` : `20${y}`) : y);
const KIND_LABEL = {
  LEGE: 'Legea', 'ORDONANȚĂ DE URGENȚĂ': 'OUG', 'ORDONANȚĂ': 'OG', 'HOTĂRÂRE': 'HG', ORDIN: 'Ordinul',
  DECIZIE: 'Decizia', DECRET: 'Decretul', REGULAMENT: 'Regulamentul', 'NORMĂ': 'Norma', 'INSTRUCȚIUNI': 'Instrucțiunile',
};

/** What a line typed into the Legislation tab's search is, or null (empty). */
export function detectQuery(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const f = fold(text);

  // ── A prefix naming the platform wins ──
  let m = /^(?:anaf|cui|cif)\s*[:\-]?\s*(.+)$/i.exec(text);
  if (m) {
    const cuis = m[1].split(/[\s,;]+/).map((s) => s.replace(/^ro/i, '')).filter((s) => /^\d{2,10}$/.test(s));
    if (cuis.length) return hit('anaf', 'company', cuis.length === 1 ? `CUI ${cuis[0]}` : `${cuis.length} CUIs`, { cui: cuis.join(' ') });
  }
  m = /^caen\s*(?:rev\.?\s*([123]))?\s*[:\-]?\s*(.*)$/i.exec(text);
  if (m) {
    const rest = m[2].trim();
    const rev = m[1] || '';
    if (/^\d{2,4}$/.test(rest)) return hit('caen', 'code', `CAEN ${rest}${rev ? ` · Rev. ${rev}` : ''}`, { code: rest, open: '1', ...(rev && rev !== '3' ? { rev } : {}) });
    if (rest) return hit('caen', 'words', `CAEN “${rest}”`, { q: rest });
    return hit('caen', 'browse', 'The CAEN nomenclature', {});
  }
  m = /^(?:dosar(?:ul|e|ele)?|portal|instan[țţt][aăe])\s*(?:nr\.?)?\s*[:\-]?\s*(.+)$/i.exec(text);
  if (m) {
    const rest = m[1].trim();
    const nr = /^\d{1,7}\/\d{1,4}(?:\/\d{1,4})?\/(?:19|20)\d{2}(?:\/[a-z0-9.*]+)?$/i.exec(rest);
    if (nr) return hit('portal-just', 'file', `Dosar ${rest}`, { nr: rest });
    return hit('portal-just', 'party', `Files naming “${rest}”`, { parte: rest });
  }
  m = /^(?:parte|partea|p[aâ]r[țţt]i)\s*[:\-]?\s*(.+)$/i.exec(text);
  if (m) return hit('portal-just', 'party', `Files naming “${m[1].trim()}”`, { parte: m[1].trim() });

  // A fiscal code NAMED as one anywhere in the line — "Cod unic de
  // înregistrare : 54912561", "cod fiscal RO54912561" (every one, for a
  // list) — is a company, before anything else reads the words.
  const cuiHits = findCuiRefs(text);
  if (cuiHits.length) {
    const cuis = [...new Set(cuiHits.map((h) => h.cui))];
    return hit('anaf', 'company', cuis.length === 1 ? `CUI ${cuis[0]}` : `${cuis.length} CUIs`, { cui: cuis.join(' ') });
  }

  // ── By shape ──
  // A court file number: three or four parts, the year third ("1234/3/2026",
  // "1234/299/2021/a1"). An act's is two ("31/1990").
  if (/^(?:nr\.?\s*)?\d{1,7}\/\d{1,4}(?:\/\d{1,4})?\/(?:19|20)\d{2}(?:\/[a-z0-9.*]+)?$/i.test(text)) {
    const nr = text.replace(/^nr\.?\s*/i, '');
    return hit('portal-just', 'file', `Dosar ${nr}`, { nr });
  }
  // A CUI (or a list of them): RO + digits, or five-plus digits with a valid
  // check digit. Four digits or fewer are a CAEN code — a CUI is never that short.
  const parts = text.split(/[\s,;]+/);
  if (parts.every((p) => /^(?:ro)?\d{5,10}$/i.test(p)) && parts.every((p) => /^ro/i.test(p) || validCui(p))) {
    const cuis = parts.map((p) => p.replace(/^ro/i, ''));
    return hit('anaf', 'company', cuis.length === 1 ? `CUI ${cuis[0]}` : `${cuis.length} CUIs`, { cui: cuis.join(' ') });
  }
  if (/^\d{2,4}$/.test(text) && !/^(19|20)\d{2}$/.test(text)) return hit('caen', 'code', `CAEN ${text}`, { code: text, open: '1' });
  // A section letter and a class ("J 6210") is CAEN too.
  m = /^([a-v])\s?(\d{2,4})$/i.exec(text);
  if (m) return hit('caen', 'code', `CAEN ${m[2]}`, { code: m[2], open: '1' });

  // An act: "Legea 31/1990", "OUG nr. 195/2002", "HG 1383 2022", "Ordinul 228 din 2012".
  m = ACT_RE.exec(text);
  if (m) {
    const tip = KIND_OF(m[1]);
    const an = fullYear(m[3]);
    if (tip) return hit('legislation', 'act', `${KIND_LABEL[tip] || tip} nr. ${m[2]}/${an}`, { tip, nr: m[2], an, open: '1' });
  }
  // A citation the detector knows ("art. 5 din Legea nr. 24/2000 privind …",
  // "Codul civil").
  const refs = findLawRefs(text).filter((h) => h.kind === 'act' || h.kind === 'code');
  if (refs.length) {
    const q = legislationQueryFor(lawRefDetails(refs[0]));
    if (q?.tip && q.numar && q.an) return hit('legislation', 'act', `${KIND_LABEL[q.tip] || q.tip} nr. ${q.numar}/${q.an}`, { tip: q.tip, nr: q.numar, an: q.an, open: '1' });
    if (q?.titlu && refs[0].kind === 'code') return hit('legislation', 'words', `“${q.titlu}”`, { titlu: q.titlu });
  }
  // Just a number and a year: every act of that number that year.
  if (/^(?:19|20)\d{2}$/.test(text)) return hit('legislation', 'year', `Acts of ${text}`, { an: text });
  m = /^(?:nr\.?\s*)?(\d{1,5})\s*\/\s*((?:19|20)\d{2})$/.exec(text);
  if (m) return hit('legislation', 'number', `Acts nr. ${m[1]}/${m[2]}`, { nr: m[1], an: m[2] });
  // Only a kind named ("lege …words") — the words, narrowed to that kind.
  m = new RegExp(`^${KIND_WORD}\\s+(.{3,})$`, 'iu').exec(text);
  if (m && KIND_OF(m[1]) && !/\d/.test(m[2])) return hit('legislation', 'words', `${KIND_LABEL[KIND_OF(m[1])] || KIND_OF(m[1])} · “${m[2]}”`, { tip: KIND_OF(m[1]), titlu: m[2] });

  if (f.length < 2) return null;
  return hit('legislation', 'words', `“${text}”`, { titlu: text });
}

// ── The dice ──────────────────────────────────────────────────────────────
// Something THAT EXISTS, from one of the platforms, written into the search as
// it would be typed — nothing is run (pressing Enter is the user's). Each
// platform's draw is the one its page used to make.
const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function randomAct() {
  const { searchLegislation, LEGIS_TYPES } = await import('./legislation');
  const WORDS = ['privind', 'pentru', 'aprobarea', 'modificarea', 'completarea', 'organizarea', 'unor', 'masuri'];
  const now = new Date().getFullYear();
  for (let tries = 0; tries < 6; tries++) {
    const an = String(1990 + Math.floor(Math.random() * (now - 1990 + 1)));
    const res = await searchLegislation({ tip: '', numar: '', an, titlu: pick(WORDS), text: '', perPage: 30 });
    if (!res?.ok) return null;
    if (!res.records.length) continue;
    const r = pick(res.records);
    const kindOf = String(r.tipAct || '').toUpperCase();
    const tip = LEGIS_TYPES.find((t) => t.id && kindOf.startsWith(t.id))?.id || '';
    if (!tip || !r.numar) continue;
    return `${KIND_LABEL[tip] || tip} ${r.numar}/${r.year || an}`;
  }
  return null;
}

async function randomCaen() {
  const { loadCaen } = await import('./caen');
  const data = await loadCaen();
  const classes = Object.keys(data?.items || {}).filter((k) => data.items[k].l === 'c');
  return classes.length ? `caen ${pick(classes)}` : null;
}

async function randomCompany() {
  const { lookupCompanies } = await import('./anaf');
  const withCheck = (base) => {
    const digits = String(base).padStart(9, '0').split('').map(Number);
    const c = (digits.reduce((s, d, i) => s + d * CUI_KEY[i], 0) * 10) % 11;
    return `${base}${c === 10 ? 0 : c}`;
  };
  for (let tries = 0; tries < 3; tries++) {
    const cuis = [];
    while (cuis.length < 100) cuis.push(withCheck(100000 + Math.floor(Math.random() * 4400000)));
    const res = await lookupCompanies(cuis.join(' '));
    if (!res?.ok) return null;
    if (res.companies.length) return `RO${pick(res.companies).cui}`;
    await new Promise((r) => setTimeout(r, 1100));
  }
  return null;
}

async function randomCase() {
  const { COURTS, listHearings } = await import('./courts');
  const pool = COURTS.filter((c) => c.kind === 'jud' || c.kind === 'trib' || c.kind === 'ca');
  for (let tries = 0; tries < 4; tries++) {
    const court = pick(pool);
    const d = new Date();
    d.setDate(d.getDate() - Math.floor(Math.random() * 45));
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const res = await listHearings({ institutie: court.id, day });
    if (!res?.ok) return null;
    const numbers = (res.sedinte || []).flatMap((s) => (s.dosare || []).map((x) => x.numar)).filter(Boolean);
    if (numbers.length) return pick(numbers);
  }
  return null;
}

const DRAWS = { legislation: randomAct, caen: randomCaen, anaf: randomCompany, 'portal-just': randomCase };

/** A random query that exists — from `source`, else from any platform. */
export async function randomQuery(source = null) {
  const order = source && DRAWS[source] ? [source] : Object.keys(DRAWS).sort(() => Math.random() - 0.5);
  for (const s of order) {
    try {
      const q = await DRAWS[s]();
      if (q) return q;
    } catch { /* that platform could not be reached — try the next */ }
  }
  return null;
}
