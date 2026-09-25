// The courts' portal (portal.just.ro) — the model behind pages/PortalJust.
//
// The service (SOAP, called from main — `courts:*`) answers case FILES: a
// number, the court, the parties, every hearing with its solution, the appeals.
// This module shapes the questions and reads the answers; nothing here talks
// to the network directly.

import COURTS_LIST from './courts.json';
import { courtsSearch, courtsHearings } from './platform';

/** Every court the service knows: `[{ id, label, kind }]`, kind = iccj | ca | trib | jud. */
export const COURTS = COURTS_LIST;
const byId = new Map(COURTS.map((c) => [c.id, c]));
export const courtLabel = (id) => byId.get(id)?.label || String(id || '');

export const KIND_LABEL = { iccj: 'Înalta Curte', ca: 'Courts of appeal', trib: 'Tribunals', jud: 'District courts', other: 'Other' };

/** A case search needs a number, a party or an object — a court and a date alone would list a whole docket. */
export const hasCaseQuery = (q) => !!(String(q.numar || '').trim() || String(q.parte || '').trim() || String(q.obiect || '').trim());

/** `{ numar, parte, obiect, institutie, from, to }` → the service's answer, `{ ok, total, dosare }`. */
export function searchCases(q) {
  return courtsSearch({
    numarDosar: String(q.numar || '').trim(),
    numeParte: String(q.parte || '').trim(),
    obiectDosar: String(q.obiect || '').trim(),
    institutie: q.institutie || '',
    dataStart: q.from || '',
    dataStop: q.to || '',
  });
}

/** `{ institutie, day }` (yyyy-mm-dd) → `{ ok, sedinte }`. */
export function listHearings(q) {
  return courtsHearings({ institutie: q.institutie || '', dataSedinta: q.day || '' });
}

// ── Reading a file ────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
/** "2026-06-25T00:00:00" → "25.06.2026"; with `time`, "25.06.2026 12:00" when the time is not midnight. */
export function fmtDate(iso, time = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(iso || ''));
  if (!m) return '';
  const d = `${m[3]}.${m[2]}.${m[1]}`;
  return time && m[4] && !(m[4] === '00' && m[5] === '00') ? `${d} ${m[4]}:${m[5]}` : d;
}
const dayOf = (iso) => String(iso || '').slice(0, 10);
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** Hearings newest first. */
export const hearingsSorted = (dosar) => [...(dosar?.sedinte || [])].sort((a, b) => dayOf(b.data).localeCompare(dayOf(a.data)));

/** The next hearing from today on, or null. */
export function nextHearing(dosar) {
  const today = todayIso();
  const ahead = (dosar?.sedinte || []).filter((s) => dayOf(s.data) >= today);
  ahead.sort((a, b) => dayOf(a.data).localeCompare(dayOf(b.data)));
  return ahead[0] || null;
}

/** The latest hearing that reached a solution, or null. */
export function lastSolution(dosar) {
  return hearingsSorted(dosar).find((s) => s.solutie) || null;
}

/** Parties grouped by their role, in the order the file lists them. */
export function partiesByRole(dosar) {
  const groups = new Map();
  for (const p of dosar?.parti || []) {
    const k = p.calitate || 'Parte';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p.nume);
  }
  return [...groups.entries()].map(([role, names]) => ({ role, names }));
}

/** Files newest-modified first. */
export const casesSorted = (list) => [...(list || [])].sort((a, b) => String(b.modificat).localeCompare(String(a.modificat)));

/** The portal's own page for a file (no deep link exists; the search page takes the number). */
export const portalCaseUrl = (numar) => `https://portal.just.ro/SitePages/cautare.aspx?k=${encodeURIComponent(numar || '')}`;
