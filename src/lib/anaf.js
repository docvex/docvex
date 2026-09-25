// ANAF's company record — the model behind pages/Anaf.
//
// The public service (webservicesp.anaf.ro, `PlatitorTvaRest` v9, called from
// main as `anaf:lookup`) answers, for a CUI as of today: the registration, the
// registered office, the CAEN code, and the fiscal states a contract turns on
// — VAT registered or not (and since when), VAT on collection, declared
// inactive, split VAT, e-Factura. This module turns CUIs into the question and
// the answer into one flat record per company.

import { anafLookup } from './platform';

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

/** "2002-01-23" → "23.01.2002". */
export const fmtDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
};
