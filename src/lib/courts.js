// The courts' portal (portal.just.ro) — the model behind pages/PortalJust.
//
// The service (SOAP, called from main — `courts:*`) answers case FILES: a
// number, the court, the parties, every hearing with its solution, the appeals.
// This module shapes the questions and reads the answers; nothing here talks
// to the network directly.

import COURTS_LIST from './courts.json';
import { courtsSearch, courtsHearings } from './platform';
import { supabase } from './supabaseClient';
import {
  cacheGet, cachePut, cachePutMany, cacheList, cacheStats, cacheClear, onCacheChange, isUnreachable, queryKey, sameRecord, fold,
} from './sourceCache';

/** Every court the service knows: `[{ id, label, kind }]`, kind = iccj | ca | trib | jud. */
export const COURTS = COURTS_LIST;
const byId = new Map(COURTS.map((c) => [c.id, c]));
export const courtLabel = (id) => byId.get(id)?.label || String(id || '');

export const KIND_LABEL = { iccj: 'Înalta Curte', ca: 'Courts of appeal', trib: 'Tribunals', jud: 'District courts', other: 'Other' };

/** A case search needs a number, a party or an object — a court and a date alone would list a whole docket. */
export const hasCaseQuery = (q) => !!(String(q.numar || '').trim() || String(q.parte || '').trim() || String(q.obiect || '').trim());

/** `{ numar, parte, obiect, institutie, from, to }` → the service's answer, `{ ok, total, dosare }`. */
export async function searchCases(q) {
  const res = await courtsSearch({
    numarDosar: String(q.numar || '').trim(),
    numeParte: String(q.parte || '').trim(),
    obiectDosar: String(q.obiect || '').trim(),
    institutie: q.institutie || '',
    dataStart: q.from || '',
    dataStop: q.to || '',
  });
  return res?.ok ? { ...res, dosare: (res.dosare || []).map(repairDosar) } : res;
}

/** `{ institutie, day }` (yyyy-mm-dd) → `{ ok, sedinte }`. */
export async function listHearings(q) {
  const res = await courtsHearings({ institutie: q.institutie || '', dataSedinta: q.day || '' });
  return res?.ok ? { ...res, sedinte: (res.sedinte || []).map(cleanRecord) } : res;
}

// A value that came back with raw XML in it — an older main process read a
// tag by its prefix (`numar` caught `<numarDocument />` and everything up to
// the file's own `</numar>`) — is cut back to the text after the last tag,
// which is the value itself. Nothing with markup in it reaches the page.
const cleanValue = (v) => (typeof v === 'string' && v.includes('<') ? v.split('>').pop().trim() : v);
function cleanRecord(r) {
  if (!r || typeof r !== 'object') return r;
  const out = Array.isArray(r) ? [] : {};
  for (const [k, v] of Object.entries(r)) out[k] = v && typeof v === 'object' ? cleanRecord(v) : cleanValue(v);
  return out;
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

// ── The copy on this machine (lib/sourceCache) ─────────────────────────────
// Every answer the portal gives is kept, and every file opened; when the
// portal cannot be reached, the same question is answered from the copy —
// the Legislation tab's archive, for court files. Each answer says where it
// came from: `source: 'live' | 'archive'`, with `portalError` saying why.

// `:2` — files kept before main.js read the number and the date correctly
// (the number used to swallow raw XML, the date was the first hearing's) are
// dropped rather than shown.
const TAB = 'portal-just:2';
try { localStorage.removeItem('docvex:source-cache:portal-just:v1'); } catch { /* storage refused */ }

/** A file carried over from before that fix: its number cut back to the
 *  number itself (everything after the last tag). */
export function repairDosar(d) {
  return d && typeof d === 'object' ? cleanRecord(d) : d;
}
const fileKey = (d) => `f:${d.institutie}:${d.numar}`;

/** Keep a file (opened, or found by a search). */
export function keepFile(d) { if (d?.numar) cachePut(TAB, fileKey(d), d); }
/** How many files are kept, and what the copy weighs. */
export const keptStats = () => cacheStats(TAB, 'f:');
/** Forget everything kept. */
export const clearKept = () => cacheClear(TAB);
export const onKeptChange = (fn) => onCacheChange(TAB, fn);

// A search run against the kept files — what the portal would match, as far
// as the copy can say: the number, a party's name, the object (folded, so ș/ş
// and no diacritics all match), the court, the registration period.
function searchKept(q) {
  const nr = fold(q.numar); const parte = fold(q.parte); const obj = fold(q.obiect);
  return cacheList(TAB, 'f:').map((e) => repairDosar(e.data)).filter((d) => (
    (!nr || fold(d.numar).includes(nr))
    && (!parte || (d.parti || []).some((p) => fold(p.nume).includes(parte)))
    && (!obj || fold(d.obiect).includes(obj))
    && (!q.institutie || d.institutie === q.institutie)
    && (!q.from || String(d.data).slice(0, 10) >= q.from)
    && (!q.to || String(d.data).slice(0, 10) <= q.to)
  ));
}

// ── BACKUP SOURCES (2026-10-02) ──────────────────────────────────────────
// portal.just.ro is often offline — and when its HTTPS address fails, a
// search by a party's name is refused rather than sent in clear. Then the
// same question goes to the `court-files` function, which asks EasyAPI, then
// DosarJust (third parties — their keys stay on the server) and answers in the
// portal's own record shape. Only after that is the copy on this machine read.
// An answer from a backup says so: `source: 'backup:<provider>'`.
const BACKUP_ERRORS = new Set(['insecure_party_search']);
const wantsBackup = (error) => isUnreachable(error) || BACKUP_ERRORS.has(error);
// A court the backup names in words ("Tribunalul București") is matched back
// to the portal's id, so the page labels and filters it as one of its own.
const byFoldedLabel = new Map(COURTS_LIST.map((c) => [fold(c.label), c.id]));
const courtIdOf = (v) => (byId.has(v) ? v : byFoldedLabel.get(fold(v)) || v);
async function askBackup(action, q) {
  try {
    const { data, error } = await supabase.functions.invoke('court-files', {
      body: { action, q: { ...q, institutieLabel: q.institutie ? courtLabel(q.institutie) : '' } },
    });
    if (error || !data?.ok) return null;
    return data;
  } catch { return null; }
}
async function searchBackup(q) {
  const b = await askBackup('search', q);
  if (!b) return null;
  const dosare = (b.dosare || []).map((d) => repairDosar({ ...d, institutie: courtIdOf(d.institutie) }));
  return { ok: true, total: b.total ?? dosare.length, dosare, provider: b.provider };
}
async function hearingsBackup(q) {
  const b = await askBackup('hearings', q);
  return b ? { ok: true, sedinte: (b.sedinte || []).map(cleanRecord), provider: b.provider } : null;
}

/** `searchCases`, the portal first, then a backup service, then the copy
 *  kept on this machine. */
export async function searchCasesKept(q) {
  const res = await searchCases(q);
  if (res?.ok) {
    cachePutMany(TAB, [[`q:${queryKey(q)}`, res], ...(res.dosare || []).slice(0, 60).map((d) => [fileKey(d), d])]);
    return { ...res, source: 'live' };
  }
  if (!wantsBackup(res?.error)) return res;
  const b = await searchBackup(q);
  if (b) {
    cachePutMany(TAB, [[`q:${queryKey(q)}`, b], ...b.dosare.slice(0, 60).map((d) => [fileKey(d), d])]);
    return { ...b, source: `backup:${b.provider}`, portalError: res?.error || 'unreachable' };
  }
  if (!isUnreachable(res?.error)) return res;
  const saved = cacheGet(TAB, `q:${queryKey(q)}`)?.data;
  const dosare = saved?.dosare?.length ? saved.dosare.map(repairDosar) : searchKept(q);
  return { ok: true, total: saved?.total ?? dosare.length, dosare, source: 'archive', portalError: res?.error || 'unreachable' };
}

/** `listHearings`, the portal first and the copy when it cannot answer. */
export async function listHearingsKept(q) {
  const res = await listHearings(q);
  const key = `h:${queryKey(q)}`;
  if (res?.ok) { cachePut(TAB, key, res); return { ...res, source: 'live' }; }
  if (!wantsBackup(res?.error)) return res;
  const b = await hearingsBackup(q);
  if (b) { cachePut(TAB, key, b); return { ...b, source: `backup:${b.provider}`, portalError: res?.error || 'unreachable' }; }
  if (!isUnreachable(res?.error)) return res;
  const saved = cacheGet(TAB, key)?.data;
  return saved ? { ...saved, sedinte: (saved.sedinte || []).map(cleanRecord), ok: true, source: 'archive', portalError: res?.error } : res;
}

/** Whether a kept file is what the portal has NOW: `{ state: 'same' | 'differs' | '', live }`
 *  ('' = the portal could not say). */
export async function checkFile(d) {
  const res = await searchCases({ numar: d.numar, institutie: d.institutie });
  if (!res?.ok) return { state: '', live: null };
  const live = (res.dosare || []).find((x) => x.numar === d.numar && x.institutie === d.institutie);
  if (!live) return { state: '', live: null };
  keepFile(live);
  return { state: sameRecord(live, d) ? 'same' : 'differs', live };
}
