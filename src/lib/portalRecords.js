// READING A PORTAL RECORD WHOLE — an act, a court file, a company, a CAEN
// code — from a search row (lib/legalSearch) or a query. Used by Research's
// drawer (to show it) and by the AI engine (lib/aiEngine, to hand it to the
// model). Moved out of pages/ResearchDrawer so a library can call it.
import { takeRecord } from './legalBrowser';
import { lawRefDetails } from './lawRefs';
import { legislationQueryFor } from './legislation';

export const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
export const paramsOf = (url) => new URLSearchParams(String(url || '').split('?')[1] || '');

/** The view a legislation reference (a lib/lawRefs hit) opens — the act,
 *  the CAEN code, the court file, the company. */
export function viewForRef(h) {
  if (!h) return null;
  if (h.kind === 'act' || h.kind === 'code') {
    let q = null;
    try { q = legislationQueryFor(lawRefDetails(h)); } catch { q = null; }
    return q && (q.numar || q.titlu) ? { type: 'act', q, label: String(h.raw || '').trim() } : null;
  }
  if (h.kind === 'caen' && h.codes?.length) return { type: 'caen', code: h.codes[0], label: `CAEN ${h.codes[0]}` };
  if (h.kind === 'case' && h.number) return { type: 'file', row: { page: { url: `/portal-just?nr=${encodeURIComponent(h.number)}` } }, label: `Dosar ${h.number}` };
  if (h.kind === 'cui' && h.cui) return { type: 'company', row: { page: { url: `/anaf?cui=${encodeURIComponent(h.cui)}` } }, label: `CUI ${h.cui}` };
  return null;
}

/** The view a search result row opens. */
export function viewForRow(row) {
  if (!row) return null;
  if (row.platform === 'legislation') return { type: 'act', row, label: row.kind };
  if (row.platform === 'portal-just') return { type: 'file', row, label: row.page?.title || row.title };
  if (row.platform === 'anaf') return { type: 'company', row, label: row.title };
  if (row.platform === 'caen') return { type: 'caen', row, label: row.title };
  return null;
}


// ── An act, WHOLE, laid out as the Legislation tab lays it out ──
export async function findAct(view) {
  const L = await import('./legislation');
  // 1. The record the search row handed over (this session only).
  const rid = view.row ? paramsOf(view.row.page?.url).get('rid') : null;
  let rec = rid ? takeRecord(rid) : null;
  // 2. Otherwise ask the portal again: by the row's number and year, or by
  // the citation's kind, number and year.
  if (!rec) {
    const p = view.row ? paramsOf(view.row.page?.url) : null;
    const q = view.q || { tip: p?.get('tip') || '', numar: p?.get('nr') || '', an: p?.get('an') || '', titlu: p?.get('titlu') || '' };
    if (!q.numar && !q.titlu) return { error: 'This citation has no number to look the act up by.' };
    const res = await withTimeout(L.searchLegislation({ tip: q.tip || '', numar: q.numar || '', an: q.an || '', titlu: q.numar ? '' : (q.titlu || ''), text: '', perPage: 20 }), 20_000);
    if (!res?.ok) return { error: res?.error ? `The portal did not answer (${res.error}).` : 'The portal did not answer.' };
    const list = res.records || [];
    const want = String(view.row?.kind || '').split(' nr.')[0].toUpperCase();
    rec = (want && list.find((r) => String(r.tipAct || '').toUpperCase() === want)) || list[0] || null;
    if (!rec) return { error: 'The portal has no act by that number.' };
  }
  const res = await withTimeout(L.loadAct(rec), 25_000);
  const act = res?.ok ? res.act : L.normalizeRecord(rec);
  if (!act.text) return { error: res?.error ? `The act's text could not be read (${res.error}).` : 'The portal sent no text for this act.' };
  return { act, head: L.actHeading(act), blocks: L.parseActText(act.text), source: res?.source || '' };
}

// The WHOLE record a view shows, as text an AI can read (Research's "AI
// summary"): an act's full text, a court file's parties and hearings, a
// company's ANAF record, a CAEN code with what it holds. → { text, label } or
// { error }.
const CAP = 60_000;
export async function recordText(view) {
  try {
    if (view.type === 'act') {
      const r = await findAct(view);
      if (r.error) return { error: r.error };
      const h = r.head;
      const head = [h.label, h.title, h.issued && `din ${h.issued}`, h.emitent, h.publicatie, h.inForce && `în vigoare ${h.inForce}`, h.republished && 'republicată'].filter(Boolean).join(' · ');
      const body = r.act.text.length > CAP ? `${r.act.text.slice(0, CAP)}\n[… the rest of the act is not included]` : r.act.text;
      return { text: `${head}\n\n${body}`, label: h.label };
    }
    if (view.type === 'file') {
      const C = await import('./courts');
      const p = paramsOf(view.row?.page?.url);
      let rec = p.get('rid') ? takeRecord(p.get('rid')) : null;
      if (!rec && p.get('nr')) { const res = await withTimeout(C.searchCasesKept({ numar: p.get('nr') }), 20_000); rec = res?.ok ? (res.dosare || [])[0] || null : null; }
      if (!rec) return { error: 'The court file could not be read.' };
      const lines = [
        `Dosar ${rec.numar} · ${C.courtLabel(rec.institutie)}${rec.departament ? ` · ${rec.departament}` : ''}`,
        rec.obiect && `Obiect: ${rec.obiect}`, rec.categorie && `Categorie: ${rec.categorie}`, rec.stadiu && `Stadiu: ${rec.stadiu}`,
        ...C.partiesByRole(rec).map((g) => `${g.role}: ${g.names.join(', ')}`),
        'Ședințe:',
        ...C.hearingsSorted(rec).map((x) => `- ${C.fmtDate(x.data)}${x.ora ? ` ${x.ora}` : ''}${x.complet ? ` (${x.complet})` : ''}: ${x.solutie || 'fără soluție'}${x.solutieSumar ? ` — ${x.solutieSumar}` : ''}`),
      ].filter(Boolean);
      return { text: lines.join('\n').slice(0, CAP), label: `Dosar ${rec.numar}` };
    }
    if (view.type === 'company') {
      const A = await import('./anaf');
      const cui = paramsOf(view.row?.page?.url).get('cui');
      const res = cui ? await withTimeout(A.lookupCompaniesKept(cui), 20_000) : null;
      const c = res?.ok ? res.companies?.[0] : null;
      if (!c) return { error: 'The company could not be read from anaf.ro.' };
      const { raw, ...rest } = c;
      return { text: JSON.stringify(rest, null, 1).slice(0, CAP), label: c.name || `CUI ${c.cui}` };
    }
    if (view.type === 'caen') {
      const K = await import('./caen');
      const data = await K.loadCaen();
      const code = view.code || paramsOf(view.row?.page?.url).get('code') || '';
      const e = K.caenEntry(data, code);
      if (!e) return { error: 'That CAEN code is not in Rev. 3.' };
      const lines = [
        `CAEN Rev. 3 ${e.code} — ${e.name}`,
        ...e.path.map((x) => `În: ${x.code} ${x.name}`),
        ...K.caenChildren(data, e.code).map((x) => `Conține: ${x.code} ${x.name}`),
      ];
      return { text: lines.join('\n'), label: `CAEN ${e.code}` };
    }
    return { error: 'Nothing to summarise.' };
  } catch (e) {
    return { error: e?.message || 'The record could not be read.' };
  }
}

