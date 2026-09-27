// ANAF's company record — the model behind pages/Anaf.
//
// The public service (webservicesp.anaf.ro, `PlatitorTvaRest` v9, called from
// main as `anaf:lookup`) answers, for a CUI as of today: the registration, the
// registered office, the CAEN code, and the fiscal states a contract turns on
// — VAT registered or not (and since when), VAT on collection, declared
// inactive, split VAT, e-Factura. This module turns CUIs into the question and
// the answer into one flat record per company.

import { anafLookup, anafBilant } from './platform';
import { cacheGet, cachePut, cachePutMany, cacheStats, cacheClear, onCacheChange, isUnreachable, sameRecord } from './sourceCache';

export const ANAF_MAX = 100;

/** The CUIs in a text — "RO 14399840", "14399840, 123", one per line — unique, in order, at most 100. */
export function parseCuis(text) {
  const out = [];
  for (const tok of String(text || '').split(/[\s,;]+/)) {
    const n = Number(tok.replace(/^ro/i, '').replace(/\D/g, ''));
    if (n > 0 && !out.includes(n)) out.push(n);
  }
  return out.slice(0, ANAF_MAX);
}

// ANAF writes ş/ţ with a cedilla; Romanian is written with a comma below.
const ro = (s) => String(s || '').replace(/ş/g, 'ș').replace(/ţ/g, 'ț').replace(/Ş/g, 'Ș').replace(/Ţ/g, 'Ț').trim();
const yes = (v) => v === true || v === 'true';

function address(a, p) {
  if (!a) return '';
  const g = (k) => ro(a[`${p}${k}`]);
  const street = [g('denumire_Strada'), g('numar_Strada') ? `nr. ${g('numar_Strada')}` : ''].filter(Boolean).join(' ');
  const parts = [street, g('detalii_Adresa'), g('denumire_Localitate'), g('denumire_Judet'), g('cod_Postal') ? `cod poștal ${g('cod_Postal')}` : ''];
  return parts.filter(Boolean).join(', ');
}

/** One `found` record → the flat company the page shows. */
export function normalizeCompany(rec) {
  const g = rec?.date_generale || {};
  const vat = rec?.inregistrare_scop_Tva || {};
  const cash = rec?.inregistrare_RTVAI || {};
  const inactive = rec?.stare_inactiv || {};
  const split = rec?.inregistrare_SplitTVA || {};
  const periods = (Array.isArray(vat.perioade_TVA) ? vat.perioade_TVA : [])
    .map((p) => ({ from: p.data_inceput_ScpTVA || '', to: p.data_sfarsit_ScpTVA || '', note: ro(p.mesaj_ScpTVA) }))
    .filter((p) => p.from || p.to);
  return {
    cui: g.cui,
    asOf: g.data || '',
    name: ro(g.denumire),
    address: ro(g.adresa),
    regCom: ro(g.nrRegCom),
    phone: ro(g.telefon),
    postal: ro(g.codPostal),
    registration: ro(g.stare_inregistrare),
    registered: g.data_inregistrare || '',
    caen: String(g.cod_CAEN || '').replace(/\D/g, ''),
    iban: ro(g.iban),
    legalForm: ro(g.forma_juridica),
    organisation: ro(g.forma_organizare),
    ownership: ro(g.forma_de_proprietate),
    fiscalOrgan: ro(g.organFiscalCompetent),
    eFactura: yes(g.statusRO_e_Factura),
    eFacturaSince: g.data_inreg_Reg_RO_e_Factura || '',
    vat: { registered: yes(vat.scpTVA), periods },
    vatCash: { on: yes(cash.statusTvaIncasare), from: cash.dataInceputTvaInc || '', to: cash.dataSfarsitTvaInc || '', act: ro(cash.tipActTvaInc) },
    inactive: { on: yes(inactive.statusInactivi), since: inactive.dataInactivare || '', reactivated: inactive.dataReactivare || '', deleted: inactive.dataRadiere || '' },
    split: { on: yes(split.statusSplitTVA), from: split.dataInceputSplitTVA || '', to: split.dataAnulareSplitTVA || '' },
    hq: address(rec?.adresa_sediu_social, 's'),
    fiscalAddress: address(rec?.adresa_domiciliu_fiscal, 'd'),
  };
}

/** Look up every CUI in `text`. `{ ok, asOf, companies, notFound, error }`. */
export async function lookupCompanies(text) {
  const cuis = parseCuis(text);
  if (!cuis.length) return { ok: false, error: 'empty_query', companies: [], notFound: [] };
  const res = await anafLookup({ cuis });
  if (!res?.ok) return { ok: false, error: res?.error || 'unreachable', companies: [], notFound: [] };
  const companies = res.found.map(normalizeCompany);
  // The service's notFound rows are `{ cui, data }`; a CUI it neither found nor
  // listed (it happens under load) is reported as not found too.
  const seen = new Set(companies.map((c) => Number(c.cui)));
  const notFound = cuis.filter((c) => !seen.has(c));
  return { ok: true, asOf: res.asOf, companies, notFound };
}

/** The CAEN a company declared in its financial statement for `an` (the last
 *  finished year by default): `{ ok, an, caen, caenName, found }`. Cached per
 *  CUI and year for the session — a filed statement does not change. */
const bilantCache = new Map();
export function companyBilant(cui, an = new Date().getFullYear() - 1) {
  const key = `${cui}:${an}`;
  if (!bilantCache.has(key)) {
    bilantCache.set(key, anafBilant({ cui, an }).then((r) => {
      if (!r?.ok) bilantCache.delete(key);
      return r;
    }));
  }
  return bilantCache.get(key);
}

/** The company's EU identifier (EUID): the trade-register number behind
 *  ROONRC. — "J2026039101008" → "ROONRC.J2026039101008". */
export const euidOf = (regCom) => {
  const r = String(regCom || '').trim();
  return r ? `ROONRC.${r.replace(/\s+/g, '')}` : '';
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2026-06-16" → "16 June 2026". */
export const longDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(iso || '');
};
/** How long the company has existed: "0 years, registered in 2026". */
export const ageOf = (iso, now = new Date()) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  let years = now.getFullYear() - Number(m[1]);
  if (now.getMonth() + 1 < Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[3]))) years -= 1;
  years = Math.max(0, years);
  return `${years} ${years === 1 ? 'year' : 'years'}, registered in ${m[1]}`;
};

/** "2002-01-23" → "23.01.2002". */
export const fmtDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
};

// ── The copy on this machine (lib/sourceCache) ─────────────────────────────
// Every company ANAF describes is kept; when ANAF cannot be reached, a lookup
// is answered from the copy for the CUIs it holds — the Legislation tab's
// archive, for company records. Each answer says where it came from:
// `source: 'live' | 'archive'`, with `portalError` saying why.

const TAB = 'anaf';
// Fields that change on every answer without the record changing.
const VOLATILE = ['asOf'];

/** How many companies are kept, and what the copy weighs. */
export const keptStats = () => cacheStats(TAB, 'c:');
/** Forget everything kept. */
export const clearKept = () => cacheClear(TAB);
export const onKeptChange = (fn) => onCacheChange(TAB, fn);

/** `lookupCompanies`, ANAF first and the copy when it cannot answer. */
export async function lookupCompaniesKept(text) {
  const res = await lookupCompanies(text);
  if (res.ok) {
    cachePutMany(TAB, res.companies.map((c) => [`c:${c.cui}`, c]));
    return { ...res, source: 'live' };
  }
  if (!isUnreachable(res.error)) return res;
  const cuis = parseCuis(text);
  const companies = []; const notFound = []; let asOf = '';
  for (const cui of cuis) {
    const hit = cacheGet(TAB, `c:${cui}`);
    if (hit) { companies.push(hit.data); if (!asOf || hit.data.asOf < asOf) asOf = hit.data.asOf; } else notFound.push(cui);
  }
  if (!companies.length) return res;
  return { ok: true, asOf, companies, notFound, source: 'archive', portalError: res.error };
}

/** Whether a kept company is what ANAF says NOW: `{ state: 'same' | 'differs' | '', live }`. */
export async function checkCompany(c) {
  const res = await lookupCompanies(String(c.cui));
  const live = res.ok ? res.companies[0] : null;
  if (!live) return { state: '', live: null };
  cachePut(TAB, `c:${live.cui}`, live);
  return { state: sameRecord(live, c, VOLATILE) ? 'same' : 'differs', live };
}
