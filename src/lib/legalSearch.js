// ONE SEARCH, EVERY PLATFORM — the Legislation tab's results page. A line
// typed in the address bar is read (lib/legalOmni's detectQuery): something
// exact (an act by kind, number and year; a court file number; one CUI; a CAEN
// code) opens straight away (`pageForQuery`); anything else is asked of every
// platform that can answer it, each on its own, their answers listed in
// groups (`searchPlatform`). Answers are kept per platform and query for the
// session, so moving between tabs, scopes and back costs nothing.
//
// A result row = { platform, kind, title, meta: [...], tags: [{ label, tone }],
// page } — `page` being the tab page it opens (lib/legalBrowser).

import { detectQuery } from './legalOmni';
import { findCuiRefs } from './lawRefs';
import { PLATFORMS, handRecord } from './legalBrowser';

const ACT_SHORT = { LEGE: 'Legea', 'ORDONANȚĂ DE URGENȚĂ': 'OUG', 'ORDONANȚĂ': 'OG', 'HOTĂRÂRE': 'HG', ORDIN: 'Ordinul', DECRET: 'Decretul', DECIZIE: 'Decizia' };
const shortKind = (k) => ACT_SHORT[String(k || '').toUpperCase()] || k || 'Act';

/** What Enter does with a line: `{ page }` to open, or null (nothing typed). */
export function pageForQuery(raw) {
  const q = String(raw || '').trim();
  const d = detectQuery(q);
  if (!d) return null;
  const item = (route, title) => ({ page: { type: 'item', route, url: d.to.replace(/[?&]_=\d+/, ''), itemId: null, kind: '', title, addr: q } });
  if (d.what === 'act') return item('/legislation', d.label);
  if (d.what === 'file') return item('/portal-just', d.params.nr);
  if (d.what === 'company' && !String(d.params.cui).includes(' ')) return item('/anaf', d.label);
  if (d.what === 'code') return item('/caen', d.label);
  const generic = d.source === 'legislation' && d.what === 'words' && !d.params.tip;
  return { page: { type: 'serp', q, scope: generic ? 'all' : d.source } };
}

/** Which platforms a query is asked of when every platform is searched. */
export function platformsFor(q) {
  const d = detectQuery(q);
  if (!d) return [];
  const generic = d.source === 'legislation' && d.what === 'words' && !d.params.tip;
  if (!generic) return [d.source];
  return ['legislation', 'portal-just', 'caen', ...(findCuiRefs(q).length ? ['anaf'] : [])];
}

// THE BRANCH OF LAW a result belongs to — 'penal' | 'civil' | 'other' — for
// the results page's second switch. A court file says it itself (the
// portal's category); an act is read off its kind and title (a criminal
// code, "infracțiuni", criminal procedure — or the civil code, civil
// procedure); a company and a CAEN code belong to neither.
const fold = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function branchOfText(text) {
  const t = fold(text);
  if (/penal|infractiun|contraventi[ei] penal|procedur[a-z]* penal/.test(t)) return 'penal';
  if (/civil|procedur[a-z]* civil/.test(t)) return 'civil';
  return 'other';
}
// THE SECOND SWITCH'S CHOICES depend on the platform picked — each narrows
// by what THAT platform is about. Every option: { id, label, tone, tip, test
// (row) }; a row carries what the tests read (`branch`, `attrs`). 'all' is
// always first and narrows nothing.
const ALL = { id: 'all', label: 'All', tone: 'var(--accent)', tip: 'Everything', test: () => true };
const other = (label, test, tip) => ({ id: 'other', label, tone: 'var(--cat-system)', tip, test });
const ACT_KINDS = ['lege', 'oug', 'og', 'hg', 'ordin'];
const COURT_CATS = ['penal', 'civil', 'admin', 'munca', 'pro'];
export const FACETS = {
  // Every platform at once: the branch of law.
  all: [
    ALL,
    { id: 'penal', label: 'Penal', tone: 'var(--danger)', tip: 'Criminal law only', test: (r) => r.branch === 'penal' },
    { id: 'civil', label: 'Civil', tone: 'var(--cat-project)', tip: 'Civil law only', test: (r) => r.branch === 'civil' },
    other('Other', (r) => !r.branch || r.branch === 'other', 'Neither criminal nor civil — administrative, fiscal, companies, CAEN codes…'),
  ],
  // Acts: the kind of act.
  legislation: [
    ALL,
    { id: 'lege', label: 'Laws', tone: 'var(--cat-update)', tip: 'Laws (Lege)', test: (r) => r.attrs?.act === 'lege' },
    { id: 'oug', label: 'Emergency ordinances', tone: 'var(--danger)', tip: 'Government emergency ordinances (OUG)', test: (r) => r.attrs?.act === 'oug' },
    { id: 'og', label: 'Ordinances', tone: 'var(--cat-role)', tip: 'Government ordinances (OG)', test: (r) => r.attrs?.act === 'og' },
    { id: 'hg', label: 'Decisions', tone: 'var(--cat-project)', tip: 'Government decisions (HG)', test: (r) => r.attrs?.act === 'hg' },
    { id: 'ordin', label: 'Orders', tone: 'var(--cat-member)', tip: 'Ministers’ and authorities’ orders', test: (r) => r.attrs?.act === 'ordin' },
    other('Other', (r) => !ACT_KINDS.includes(r.attrs?.act), 'Decrees, decisions of other bodies, regulations…'),
  ],
  // Court files: the portal's own category (materie).
  'portal-just': [
    ALL,
    { id: 'penal', label: 'Penal', tone: 'var(--danger)', tip: 'Criminal cases', test: (r) => r.attrs?.cat === 'penal' },
    { id: 'civil', label: 'Civil', tone: 'var(--cat-project)', tip: 'Civil cases', test: (r) => r.attrs?.cat === 'civil' },
    { id: 'admin', label: 'Administrative', tone: 'var(--cat-member)', tip: 'Contencios administrativ și fiscal', test: (r) => r.attrs?.cat === 'admin' },
    { id: 'munca', label: 'Labour', tone: 'var(--cat-file)', tip: 'Labour disputes and social insurance', test: (r) => r.attrs?.cat === 'munca' },
    { id: 'pro', label: 'Business', tone: 'var(--cat-auth)', tip: 'Disputes with professionals, insolvency', test: (r) => r.attrs?.cat === 'pro' },
    other('Other', (r) => !COURT_CATS.includes(r.attrs?.cat), 'Family and minors, and the rest'),
  ],
  // Companies: their fiscal standing.
  anaf: [
    ALL,
    { id: 'vat', label: 'VAT payers', tone: 'var(--success)', tip: 'Registered for VAT', test: (r) => r.attrs?.vat === true },
    { id: 'novat', label: 'Not VAT payers', tone: 'var(--cat-system)', tip: 'Not registered for VAT', test: (r) => r.attrs?.vat === false },
    { id: 'inactive', label: 'Inactive', tone: 'var(--danger)', tip: 'Declared inactive by ANAF', test: (r) => r.attrs?.inactive === true },
  ],
  // CAEN codes: the level of the nomenclature.
  caen: [
    ALL,
    { id: 's', label: 'Sections', tone: 'var(--cat-update)', tip: 'Sections (A…U)', test: (r) => r.attrs?.level === 's' },
    { id: 'd', label: 'Divisions', tone: 'var(--cat-project)', tip: 'Divisions (two digits)', test: (r) => r.attrs?.level === 'd' },
    { id: 'g', label: 'Groups', tone: 'var(--cat-member)', tip: 'Groups (three digits)', test: (r) => r.attrs?.level === 'g' },
    { id: 'c', label: 'Classes', tone: 'var(--warning)', tip: 'Classes (four digits)', test: (r) => r.attrs?.level === 'c' },
  ],
};
export const facetsFor = (scope) => FACETS[scope] || FACETS.all;

// THE RESULTS' PILLS WEAR THE FACETS' COLOURS — the tone a choice has in the
// second switch (Penal red, Civil, Laws, VAT payers, Classes…), so a row
// says in the same colour which of those choices it belongs to.
export const facetTone = (scope, id) => (FACETS[scope] || []).find((f) => f.id === id)?.tone || 'var(--cat-system)';
const ACT_PILL = { lege: 'Law', oug: 'Emergency ordinance', og: 'Ordinance', hg: 'Decision', ordin: 'Order' };
const COURT_PILL = { penal: 'Penal', civil: 'Civil', admin: 'Administrative', munca: 'Labour', pro: 'Business' };
const LEVEL_PILL = { s: 'Section', d: 'Division', g: 'Group', c: 'Class' };
// The branch of law under All (Penal · Civil), when a row has one.
const branchPill = (branch) => (branch === 'penal' || branch === 'civil'
  ? { label: branch === 'penal' ? 'Penal' : 'Civil', tone: facetTone('all', branch) } : null);
/** An answer narrowed to one of the scope's facets (the rows, and the count
 *  with them). Under All, the facet is the branch of law. */
export function inBranch(a, facet, scope = 'all') {
  if (!facet || facet === 'all' || !a || a === 'loading' || !a.ok) return a;
  const opt = facetsFor(scope).find((f) => f.id === facet);
  if (!opt) return a;
  const rows = a.rows.filter((r) => opt.test(r));
  return { ...a, rows, total: rows.length };
}

// What kind of act a record is, for the Legislation facet.
function actKind(tipAct) {
  const t = fold(tipAct);
  if (/urgent/.test(t)) return 'oug';
  if (/^ordonant/.test(t)) return 'og';
  if (/^lege/.test(t)) return 'lege';
  if (/^hotarar/.test(t)) return 'hg';
  if (/^ordin/.test(t)) return 'ordin';
  return 'other';
}
// A court file's category, from the portal's own words.
function courtCat(categorie) {
  const t = fold(categorie);
  if (/penal/.test(t)) return 'penal';
  if (/contencios|administrativ|fiscal/.test(t)) return 'admin';
  if (/munca|asigurari sociale/.test(t)) return 'munca';
  if (/profesionist|comercial|faliment|insolvent/.test(t)) return 'pro';
  if (/civil/.test(t)) return 'civil';
  return 'other';
}

const cache = new Map();   // `${platform}|${q}` → Promise<answer>
// The answers that have ARRIVED, readable synchronously: a results page shown
// again paints them on its first frame instead of a "searching" one.
const settled = new Map(); // same key → answer

/** One platform's answer to `q`: `{ ok, source, rows, total, error, note }`. */
export function searchPlatform(platform, q) {
  const key = `${platform}|${q}`;
  if (!cache.has(key)) {
    const p = RUN[platform](q).catch((e) => ({ ok: false, rows: [], total: 0, error: e?.message || 'failed' }));
    cache.set(key, p);
    p.then((r) => {
      if (cache.get(key) !== p) return;   // forgotten (a refresh) meanwhile
      settled.set(key, r);
      if (settled.size > 200) settled.delete(settled.keys().next().value);
      if (!r?.ok) cache.delete(key);
    });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}
export const peekPlatform = (platform, q) => cache.get(`${platform}|${q}`) || null;
export const peekAnswer = (platform, q) => settled.get(`${platform}|${q}`) || null;
/** A REFRESH of a results page: its answers are asked again. */
export async function forgetAnswers(q) {
  for (const k of [...cache.keys()]) if (k.endsWith(`|${q}`)) cache.delete(k);
  for (const k of [...settled.keys()]) if (k.endsWith(`|${q}`)) settled.delete(k);
  try { (await import('./legislation')).forgetLegislationSession(); } catch { /* not loaded */ }
}

const RUN = {
  async legislation(q) {
    const { searchLegislation, searchLegislationPlain } = await import('./legislation');
    const d = detectQuery(q);
    const p = d?.source === 'legislation' ? d.params : { titlu: q };
    let res;
    if (d?.what === 'act' || d?.what === 'number' || d?.what === 'year') {
      res = await searchLegislation({ tip: p.tip || '', numar: p.nr || '', an: p.an || '', titlu: '', text: '', perPage: 40 });
    } else {
      res = await searchLegislationPlain({ words: p.titlu || q, tip: p.tip || '', perPage: 40 });
    }
    if (!res?.ok) return { ok: false, rows: [], total: 0, error: res?.error || 'unreachable' };
    const rows = (res.records || []).map((r) => {
      const qs = new URLSearchParams({ rid: handRecord(r) });
      if (r.numar) { qs.set('nr', r.numar); if (r.year) qs.set('an', r.year); qs.set('open', '1'); }
      return {
        platform: 'legislation',
        kind: `${r.tipAct || 'Act'}${r.numar ? ` nr. ${r.numar}${r.year ? `/${r.year}` : ''}` : ''}`,
        title: r.title || r.titlu,
        meta: [r.emitent, (r.publicatie || '').replace(/MONITORUL OFICIAL/i, 'Monitorul Oficial')].filter(Boolean),
        branch: branchOfText(`${r.tipAct || ''} ${r.title || r.titlu || ''}`),
        attrs: { act: actKind(r.tipAct) },
        tags: [
          ACT_PILL[actKind(r.tipAct)] ? { label: ACT_PILL[actKind(r.tipAct)], tone: facetTone('legislation', actKind(r.tipAct)) } : null,
          branchPill(branchOfText(`${r.tipAct || ''} ${r.title || r.titlu || ''}`)),
          r.republished ? { label: 'republicată', tone: 'var(--info)' } : null,
        ].filter(Boolean),
        page: { type: 'item', route: '/legislation', url: `/legislation?${qs.toString()}`, itemId: null, kind: r.tipAct || '', title: r.numar ? `nr. ${r.numar}${r.year ? `/${r.year}` : ''}` : (r.title || ''), addr: r.numar ? `${shortKind(r.tipAct)} ${r.numar}/${r.year}` : q },
      };
    });
    return { ok: true, source: res.source, rows, total: rows.length, note: res.mode === 'text' ? 'Found in the acts’ text' : '' };
  },

  async 'portal-just'(q) {
    const { searchCasesKept, courtLabel, nextHearing, fmtDate } = await import('./courts');
    const d = detectQuery(q);
    const query = d?.what === 'file' ? { numar: d.params.nr } : { parte: d?.what === 'party' ? d.params.parte : q };
    if (!query.numar && String(query.parte || '').trim().length < 3) return { ok: true, rows: [], total: 0 };
    const res = await searchCasesKept(query);
    if (!res?.ok) return { ok: false, rows: [], total: 0, error: res?.error || 'unreachable' };
    const rows = (res.dosare || []).slice(0, 60).map((x) => {
      const next = nextHearing(x);
      const parties = (x.parti || []).slice(0, 2).map((p) => p.nume).filter(Boolean).join(' c. ');
      return {
        platform: 'portal-just',
        kind: `${courtLabel(x.institutie)}${x.departament ? ` · ${x.departament}` : ''}`,
        title: `${x.numar} — ${x.obiect || '—'}`,
        meta: [parties, next ? `Next hearing ${fmtDate(next.data)}` : ''].filter(Boolean),
        tags: [
          x.categorie ? { label: x.categorie, tone: facetTone('portal-just', courtCat(x.categorie)) } : null,
          x.stadiu ? { label: x.stadiu, tone: 'var(--text-muted)' } : null,
        ].filter(Boolean),
        // The portal's own category decides; failing it, the object's words.
        branch: x.categorie ? branchOfText(x.categorie) : branchOfText(x.obiect),
        attrs: { cat: courtCat(x.categorie) },
        page: { type: 'item', route: '/portal-just', url: `/portal-just?rid=${handRecord(x)}&nr=${encodeURIComponent(x.numar)}`, itemId: null, kind: courtLabel(x.institutie), title: x.numar, addr: x.numar },
      };
    });
    return { ok: true, source: res.source, rows, total: res.total ?? rows.length };
  },

  async anaf(q) {
    const { lookupCompaniesKept } = await import('./anaf');
    const d = detectQuery(q);
    const text = d?.source === 'anaf' ? d.params.cui : findCuiRefs(q).map((h) => h.cui).join(' ');
    if (!text) return { ok: true, rows: [], total: 0 };
    const res = await lookupCompaniesKept(text);
    if (!res?.ok) return { ok: false, rows: [], total: 0, error: res?.error || 'unreachable' };
    const rows = res.companies.map((c) => ({
      platform: 'anaf',
      kind: `CUI ${c.vat?.registered ? 'RO' : ''}${c.cui}${c.hq ? ` · ${String(c.hq).split(',').pop().trim()}` : ''}`,
      title: c.name || `CUI ${c.cui}`,
      meta: [c.regCom].filter(Boolean),
      branch: 'other',
      attrs: { vat: !!c.vat?.registered, inactive: !!c.inactive?.on },
      tags: [
        c.inactive?.on ? { label: 'Inactive', tone: facetTone('anaf', 'inactive') } : null,
        c.vat?.registered ? { label: 'VAT payer', tone: facetTone('anaf', 'vat') } : { label: 'Not a VAT payer', tone: facetTone('anaf', 'novat') },
      ].filter(Boolean),
      page: { type: 'item', route: '/anaf', url: `/anaf?cui=${c.cui}`, itemId: null, kind: c.legalForm || 'Company', title: c.name || '', addr: String(c.cui) },
    }));
    return { ok: true, source: res.source, rows, total: rows.length };
  },

  async caen(q) {
    const { loadCaen, searchCaen, LEVEL_LABEL_RO, sentenceCase } = await import('./caen');
    const data = await loadCaen();
    const d = detectQuery(q);
    const words = d?.source === 'caen' ? (d.params.code || d.params.q || '') : q;
    if (!words) return { ok: true, rows: [], total: 0 };
    const hits = searchCaen(data, words, { limit: 40 });
    const rows = hits.map((h) => ({
      platform: 'caen',
      kind: `${LEVEL_LABEL_RO[h.level] || 'Cod'} · CAEN Rev. 3`,
      title: `${h.code} — ${sentenceCase(h.name)}`,
      meta: [],
      tags: LEVEL_PILL[h.level] ? [{ label: LEVEL_PILL[h.level], tone: facetTone('caen', h.level) }] : [],
      branch: 'other',
      attrs: { level: h.level },
      page: { type: 'item', route: '/caen', url: `/caen?code=${encodeURIComponent(h.code)}&open=1`, itemId: null, kind: 'Rev. 3', title: `${h.code} ${sentenceCase(h.name)}`, addr: `caen ${h.code}` },
    }));
    return { ok: true, source: 'bundled', rows, total: rows.length };
  },
};

export const PLATFORM_INFO = PLATFORMS;
