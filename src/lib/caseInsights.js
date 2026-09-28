// CASE INSIGHTS — what can be worked out from what the AI scan read.
//
// The Files tab's Insights view (components/CaseInsights) and the Graph's
// "People & things" map read the scan's WEB INDEX (lib/dataCollections
// `loadScanIndex`: every file read, with what the AI understood of it — its
// parties and their identifiers, facts, dates) and the files' own text, and
// check them against each other. Everything here is LOCAL and free unless it
// says otherwise:
//   • contradictions — two files disagreeing about one person / company /
//     matter (CNP, date of birth, address, an amount, a signature date), plus
//     the AI scan's own `contradicts` links;
//   • authenticity — CNP check digit and birth date, the machine-readable
//     strip (MRZ) of an identity card / passport against the printed fields,
//     expired documents, CUI check digits (and, on request, ANAF — network);
//   • plates and places — number plates read in the files, photos' EXIF date
//     and GPS, linked to people, collections and the timeline;
//   • the missing-document checklist per kind of case;
//   • duplicates — identical bytes, near-identical pictures (a difference
//     hash of the OS thumbnail), later versions of a text;
//   • signatures and stamps — the one PAID check: the pictures go to the AI,
//     which describes every signature and stamp and then compares those
//     attributed to one person or company;
//   • the question box — PAID: the collections and the files' understandings
//     go to the AI with the question, the answer names its source files;
//   • the relationship graph — people, companies, properties and vehicles.
import { localFolderApi, readLocalBlob } from './localFolder';
import { notifyFilesChanged } from './platform';
import { loadScanIndex, scanKindOf, resolveInProject, foldName, parseCollection } from './dataCollections';
import { bestTextFor } from './aiData';
import { readSourceText } from './identityExtract';
import { extractFileText } from './extractFileText';
import { loadCaptions } from './captionsHistory';
import { askProjectAi } from './projectAi';
import { readExif, gpsDecimal } from './fileMetadata';
import { cuiValid } from './lawRefs';
import { collectionToText } from './aiProjectContext';
import { loadSetting, putSetting, rememberProjectDir, settingsAvailable } from './projectIndexClient';
import { sha256Of, dhashOf, hamming, shingles, likeness } from './fileSimilarity';
import { decodeCnp, findCnps, parseMrz, isMrzLine, sameAddress, mergeAddresses } from './roIdDocuments';
import { documentAuthority, AUTHORITY_RULE } from './docAuthority';

const MODEL = 'claude-sonnet-4-6';
const localUrl = (path) => `localfile://local/${encodeURIComponent(path)}`;
const extOf = (name) => (/\.([a-z0-9]{1,8})$/i.exec(String(name || ''))?.[1] || '').toLowerCase();
// Lower case, no diacritics (ș ş ț ţ ă â î → s t a i).
export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const arr = (v) => (Array.isArray(v) ? v : []);
const uniq = (list) => [...new Set(list)];

// ── The data ─────────────────────────────────────────────────────────────
// → { dir, files: [{ rel, name, path, kind, size, mtime, method, u }],
//     all: [{ rel, name, path, kind, size, mtime }] (every file in the folder),
//     collections: [{ rel, name, path, doc }], timeline, links, scanned }
export async function loadCaseData(dir, { projectId } = {}) {
  const web = await loadScanIndex(dir, { projectId }).catch(() => null);
  const files = Object.entries(web?.files || {})
    .filter(([, f]) => f && !f.skipped && f.understanding)
    .map(([rel, f]) => ({
      rel, name: rel.split('/').pop(), path: resolveInProject(dir, rel), kind: scanKindOf(rel),
      size: Number(f.size) || 0, mtime: Number(f.mtime) || 0, method: f.method || '', u: f.understanding || {},
    }));
  let all = [];
  const collections = [];
  try {
    const listing = await localFolderApi.listAll(dir);
    const root = String(dir).replace(/[\\/]+$/, '');
    for (const f of listing?.files || []) {
      if (!f?.path) continue;
      const rel = f.path.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
      if (rel.split('/').some((seg) => seg.startsWith('.'))) continue;   // .docvex, .docvex-trash, dotfiles
      const kind = scanKindOf(f.name, f.mimeType);
      if (kind === 'collection') {
        try {
          const doc = parseCollection(await (await readLocalBlob(f.path)).text());
          if (doc) collections.push({ rel, name: f.name, path: f.path, doc });
        } catch { /* unreadable — left out */ }
        continue;
      }
      if (/\.docvex$/i.test(f.name)) continue;
      all.push({ rel, name: f.name, path: f.path, kind, size: Number(f.sizeBytes) || 0, mtime: Date.parse(f.mtimeIso || '') || 0 });
    }
  } catch { all = files.map((f) => ({ ...f })); }
  const timeline = arr(web?.graph?.timeline).map((t) => ({ date: t.date, event: t.event, files: arr(t.file_ids) }));
  for (const c of collections) for (const t of c.doc.timeline) timeline.push({ date: t.date, event: t.event, files: t.sources, collection: c.doc.title });
  const links = [];
  for (const g of Object.values(web?.graph?.groups || {})) for (const l of arr(g?.links)) links.push(l);
  return { dir, projectId, files, all, collections, timeline, links, scanned: files.length };
}

// The case data narrowed to ONE data collection (its `.dvc` path inside the
// project): only the files it was gathered from, that collection alone, the
// links and timeline events between its files. Every Insights check then
// runs per collection, and a resolution writes into that collection only.
const normRel = (r) => String(r || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
export function scopeToCollection(data, collectionRel) {
  const want = normRel(collectionRel);
  const c = data.collections.find((x) => normRel(x.rel) === want);
  if (!c) return { ...data, files: [], all: [], collections: [], timeline: [], links: [], scanned: 0, collection: null };
  const rels = new Set(c.doc.sources.map((x) => x.rel));
  const files = data.files.filter((f) => rels.has(f.rel));
  return {
    ...data,
    files,
    all: data.all.filter((f) => rels.has(f.rel)),
    collections: [c],
    timeline: data.timeline.filter((t) => t.collection === c.doc.title || arr(t.files).some((r) => rels.has(r))),
    links: data.links.filter((l) => rels.has(l.from) && rels.has(l.to)),
    scanned: files.length,
    collection: c,
  };
}

// Which collections hold a file.
export function collectionsOf(data, rel) {
  return data.collections.filter((c) => c.doc.sources.some((s) => s.rel === rel));
}

// ── The files' own text (local; kept for the session) ───────────────────
const textCache = new Map();
export async function textOfFile(f) {
  const key = `${f.path}|${f.size}|${f.mtime}`;
  if (textCache.has(key)) return textCache.get(key);
  let text = '';
  try {
    if (f.kind === 'image') text = bestTextFor(f.path) || '';
    else if (f.kind === 'video' || f.kind === 'audio') text = loadCaptions(f.path)?.text || '';
    else {
      // Never a PAID read: what was saved (a scan's transcription), else the
      // file's own text layer / Office text, extracted here.
      text = bestTextFor(f.path) || '';
      if (!text) {
        const blob = await readLocalBlob(f.path);
        text = extOf(f.name) === 'doc'
          ? (await readSourceText(blob, f.name, { path: f.path }))?.text || ''
          : (await extractFileText(blob, f.name))?.text || '';
      }
    }
  } catch { text = ''; }
  textCache.set(key, text);
  return text;
}
// Every scanned file's text: rel → text. `onProgress(done, total)`.
export async function loadTexts(data, { onProgress, isCancelled } = {}) {
  const out = {};
  let n = 0;
  for (const f of data.files) {
    if (isCancelled?.()) break;
    out[f.rel] = await textOfFile(f);
    n += 1;
    onProgress?.(n, data.files.length);
    if (n % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

// ── Values, normalised ──────────────────────────────────────────────────
const MONTHS = {
  ian: 1, ianuarie: 1, jan: 1, january: 1, feb: 2, februarie: 2, february: 2, mar: 3, martie: 3, march: 3,
  apr: 4, aprilie: 4, april: 4, mai: 5, may: 5, iun: 6, iunie: 6, jun: 6, june: 6, iul: 7, iulie: 7, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, septembrie: 9, september: 9, oct: 10, octombrie: 10, october: 10,
  noi: 11, nov: 11, noiembrie: 11, november: 11, dec: 12, decembrie: 12, december: 12,
};
const pad = (n) => String(n).padStart(2, '0');
const validYmd = (y, m, d) => {
  if (!(y >= 1850 && y <= 2150 && m >= 1 && m <= 12 && d >= 1)) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const fullYear = (y) => (y < 100 ? (y > (new Date().getFullYear() % 100) + 10 ? 1900 + y : 2000 + y) : y);
// The first date in `s` as YYYY-MM-DD, or null.
export function parseDate(s) {
  const t = fold(s);
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m && validYmd(+m[1], +m[2], +m[3])) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /(?<!\d)(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4}|\d{2})(?!\d)/.exec(t);
  if (m) {
    const y = fullYear(+m[3]);
    if (validYmd(y, +m[2], +m[1])) return `${y}-${pad(m[2])}-${pad(m[1])}`;
  }
  m = /(?<!\d)(\d{1,2})\s+([a-z]{3,10})\.?\s+(\d{4})/.exec(t);
  if (m && MONTHS[m[2]] && validYmd(+m[3], MONTHS[m[2]], +m[1])) return `${m[3]}-${pad(MONTHS[m[2]])}-${pad(m[1])}`;
  return null;
}
export const showDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

// An amount → { value, currency } (Romanian "1.234,56 lei" and English "1,234.56 EUR").
export function parseAmount(s) {
  const t = String(s || '');
  const m = /(\d{1,3}(?:[.,\s ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(lei|ron|eur(?:o)?|€|usd|\$|gbp|£)?/i.exec(t);
  if (!m) return null;
  let n = m[1].replace(/[\s ]/g, '');
  const lastDot = n.lastIndexOf('.');
  const lastComma = n.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    n = n.replace(dec === '.' ? /,/g : /\./g, '').replace(dec, '.');
  } else if (lastComma >= 0) {
    n = n.length - lastComma - 1 === 3 ? n.replace(/,/g, '') : n.replace(',', '.');
  } else if (lastDot >= 0 && n.length - lastDot - 1 === 3) {
    n = n.replace(/\./g, '');
  }
  const value = Number(n);
  if (!Number.isFinite(value)) return null;
  const c = fold(m[2] || '');
  const currency = c.startsWith('eur') || c === '€' ? 'EUR' : c === 'usd' || c === '$' ? 'USD' : c === 'gbp' || c === '£' ? 'GBP' : c ? 'RON' : '';
  return { value, currency };
}

// An address as a set of words (no diacritics, no "str." / "nr." noise).
const ADDRESS_NOISE = new Set(['str', 'strada', 'nr', 'numarul', 'bl', 'bloc', 'sc', 'scara', 'et', 'etaj', 'ap', 'apartament', 'jud', 'judetul', 'judet', 'mun', 'municipiul', 'oras', 'orasul', 'com', 'comuna', 'sat', 'satul', 'sector', 'sectorul', 'bd', 'bdul', 'bulevardul', 'calea', 'sos', 'soseaua', 'aleea', 'piata', 'romania', 'loc', 'localitatea', 'cod', 'postal', 'in', 'din', 'si']);
const addressWords = (s) => new Set(fold(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !ADDRESS_NOISE.has(w)));
// (Compared by their parts, whatever way each file writes them —
// lib/roIdDocuments sameAddress.)

// ── CNP ──────────────────────────────────────────────────────────────────
// lib/roIdDocuments decodes it; this is the short shape the checks use.
export function checkCnp(value) {
  const d = decodeCnp(value);
  return { cnp: d.cnp, valid: d.valid, problems: d.problems, birth: d.birth_date || null, sex: d.gender || null };
}
export { findCnps, parseMrz };

// ── CUI ──────────────────────────────────────────────────────────────────
// Every CUI named in a text — including those whose check digit FAILS (the
// point of the check), with the word required.
export function findCuis(text) {
  const out = new Set();
  const re = /(?:\bC\.?\s?U\.?\s?I\.?|\bC\.?\s?I\.?\s?F\.?|cod(?:ul)?\s+(?:unic\s+de\s+[iî]nregistrare|fiscal|de\s+[iî]nregistrare\s+fiscal[ăa]|de\s+identificare\s+fiscal[ăa]))\s*(?:nr\.?\s*)?[:\-–]?\s*(?:RO\s?)?(\d{2,10})(?!\d)/gi;
  for (const m of String(text || '').matchAll(re)) out.add(m[1]);
  return [...out];
}

// ── Number plates ────────────────────────────────────────────────────────
const COUNTY_CODES = 'AB|AR|AG|BC|BH|BN|BT|BV|BR|BZ|CS|CL|CJ|CT|CV|DB|DJ|GL|GR|GJ|HR|HD|IL|IS|IF|MM|MH|MS|NT|OT|PH|SM|SJ|SB|SV|TR|TM|TL|VS|VL|VN';
const PLATE_RE = new RegExp(`(?<![A-Z0-9])(?:(B)[\\s-]?(\\d{2,3})|(${COUNTY_CODES})[\\s-]?(\\d{2}))[\\s-]?([A-Z]{3})(?![A-Z0-9])`, 'g');
// Letters no Romanian plate uses in its three-letter group start: I and O
// ("I" / "O" are refused as the first letter, and "Q" anywhere).
export function findPlates(text) {
  const out = new Set();
  for (const m of String(text || '').toUpperCase().matchAll(PLATE_RE)) {
    const letters = m[5];
    if (/^[IO]/.test(letters) || letters.includes('Q')) continue;
    out.add(`${m[1] || m[3]} ${m[2] || m[4]} ${letters}`);
  }
  return [...out];
}

// ── Who a fact belongs to ────────────────────────────────────────────────
const PERSONISH = (p) => (p.kind || 'person') === 'person';
const partyKey = (p) => `${PERSONISH(p) ? 'p' : 'c'}:${foldName(p.name)}`;
const KIND_OF_FACT = [
  ['cnp', /\bcnp\b|cod numeric personal/],
  ['birth', /nast|birth|nascut|data nasterii/],
  ['address', /adres|domicil|resedin|sediu|address|locuieste/],
  ['signDate', /data (semnarii|incheierii|contractului|actului)|semnat|signed|incheiat (la|in data)|date of sign/],
  ['amount', /\bpret|\bsuma\b|valoare|amount|price|chiri|rent|onorariu|\btotal|avans|\brata\b|capital/],
];
const factKind = (label, value) => {
  const l = fold(label);
  for (const [k, re] of KIND_OF_FACT) if (re.test(l)) return k;
  if (/^\s*[1-8]\d{12}\s*$/.test(String(value)) && checkCnp(value).valid) return 'cnp';
  return null;
};
// The party a fact is about: the one whose role or name it names; else the
// identity document's holder; else the only person in the file.
function ownerOf(label, value, parties, u) {
  const text = ` ${fold(label)} ${fold(value)} `;
  const hits = parties.filter((p) => {
    const role = fold(p.role).replace(/[^a-z ]/g, ' ').trim();
    if (role.length >= 4 && role.split(/\s+/).some((w) => w.length >= 4 && text.includes(w.slice(0, Math.max(4, w.length - 2))))) return true;
    const words = foldName(p.name).split(' ').filter((w) => w.length >= 3);
    return words.length && words.every((w) => text.includes(w));
  });
  if (hits.length === 1) return hits[0];
  if (u.idDocument?.holder) return { name: u.idDocument.holder, kind: 'person' };
  const people = parties.filter(PERSONISH);
  if (people.length === 1) return people[0];
  if (parties.length === 1) return parties[0];
  return null;
}

// Every CLAIM the files make: { key, name, kind, value, norm, rel, label }.
export function collectClaims(data, texts = {}) {
  const claims = [];
  for (const f of data.files) {
    const u = f.u;
    const parties = arr(u.parties).length ? arr(u.parties) : arr(u.entities).map((name) => ({ name, kind: 'person' }));
    const add = (owner, kind, value, label) => {
      if (!owner?.name || value == null || value === '') return;
      let norm = null;
      if (kind === 'cnp') norm = String(value).replace(/\D/g, '');
      else if (kind === 'birth' || kind === 'signDate') norm = parseDate(value);
      else if (kind === 'amount') { const a = parseAmount(value); norm = a ? `${a.value}${a.currency ? ` ${a.currency}` : ''}` : null; }
      else norm = String(value).trim();
      if (!norm || (kind === 'cnp' && norm.length !== 13)) return;
      claims.push({ key: partyKey(owner), name: owner.name, kind, value: String(value).trim(), norm, rel: f.rel, label: label || '' });
    };
    for (const p of parties) {
      for (const id of arr(p.identifiers)) {
        const digits = String(id).replace(/\D/g, '');
        if (digits.length === 13 && /^[1-9]/.test(digits) && PERSONISH(p)) add(p, 'cnp', digits, 'CNP');
      }
    }
    for (const fact of arr(u.facts)) {
      const kind = factKind(fact.label, fact.value);
      if (!kind) continue;
      if (kind === 'amount' || kind === 'signDate') {
        // A matter's amount / signature date belongs to what the file is about.
        const cols = collectionsOf(data, f.rel);
        // The subject's head ("Apartament Cluj, str. …" → "Apartament Cluj"),
        // so two files wording the same matter a little differently meet.
        const subject = cols[0]?.doc.title || String(u.subject || '').split(/[,;(–-]/)[0].trim();
        if (subject) add({ name: subject, kind: 'matter' }, kind, fact.value, fact.label);
        continue;
      }
      add(ownerOf(fact.label, fact.value, parties, u), kind, fact.value, fact.label);
    }
    // A CNP printed in the text of a file about one person.
    const people = parties.filter(PERSONISH);
    const holder = u.idDocument?.holder ? { name: u.idDocument.holder, kind: 'person' } : people.length === 1 ? people[0] : null;
    if (holder) for (const cnp of findCnps(texts[f.rel])) add(holder, 'cnp', cnp, 'CNP');
  }
  return claims;
}

const KIND_LABELS = { cnp: 'CNP', birth: 'Date of birth', address: 'Address', amount: 'Amount', signDate: 'Signature date' };
export const claimKindLabel = (k) => KIND_LABELS[k] || k;

// ── Copies of one document ──────────────────────────────────────────────
// Two files that are the SAME document — a copy, an edited or re-saved
// picture, the same page scanned twice — read differently only because the
// OCR misread one of them; that is not a contradiction between documents.
// Grouped locally, at once: the name with its copy marks taken off
// ("IMG_0218 (edited).jpg", "scan (2).pdf", "contract - Copy.docx" → one
// stem), the same size and type, or texts that are nearly word for word the
// same. `dupes` = findDuplicates' answer when it has been run (identical
// bytes and near-identical pictures join too).
// → Map rel → group id (a file alone is its own group).
const COPY_MARK = /\s*(\((edited|scan|frame|copy|copie|\d{1,3})\)|[-_ ]+(copy|copie|edited))\s*$/i;
function copyStem(name) {
  let st = fold(String(name || '').replace(/\.[a-z0-9]{1,8}$/i, '')).trim();
  for (let i = 0; i < 3; i += 1) { const next = st.replace(COPY_MARK, '').replace(/^copy of\s+/i, '').trim(); if (next === st) break; st = next; }
  return st;
}
const wordSet = (t) => new Set(fold(t).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const x of a) if (b.has(x)) common += 1;
  return common / (a.size + b.size - common);
}
export function copyGroups(data, texts = {}, dupes = null) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const join = (a, b) => { if (!parent.has(a) || !parent.has(b)) return; const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const files = data.files;
  for (const f of files) parent.set(f.rel, f.rel);
  const by = (keyOf) => {
    const m = new Map();
    for (const f of files) { const k = keyOf(f); if (!k) continue; if (m.has(k)) join(m.get(k), f.rel); else m.set(k, f.rel); }
  };
  by((f) => { const st = copyStem(f.name); return st ? `${st}|${f.kind}` : ''; });
  by((f) => (f.size > 2048 ? `${f.size}|${extOf(f.name)}` : ''));
  const sets = files.map((f) => ({ f, w: wordSet(texts[f.rel] || '') })).filter((x) => x.w.size >= 8);
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const a = sets[i]; const b = sets[j];
      if (Math.min(a.w.size, b.w.size) / Math.max(a.w.size, b.w.size) < 0.7) continue;
      if (jaccard(a.w, b.w) >= 0.8) join(a.f.rel, b.f.rel);
    }
  }
  for (const g of arr(dupes?.exact)) for (let i = 1; i < g.length; i += 1) join(g[0].rel, g[i].rel);
  for (const x of arr(dupes?.similar)) join(x.files[0].rel, x.files[1].rel);
  const out = new Map();
  for (const f of files) out.set(f.rel, find(f.rel));
  return out;
}

// ── 1. Contradictions ───────────────────────────────────────────────────
// → [{ id, source: 'local' | 'ai', subject, kind, values: [{ value, files }],
//      why?, files, severity: 'error' | 'warn', note? }]
// A contradiction whose files are all copies of ONE document is marked
// `copiesOnly` (a misreading, not a disagreement) — the tab folds those away;
// every value says how many DIFFERENT documents state it (`documents`).
export function findContradictions(data, texts = {}, { dupes = null } = {}) {
  const claims = collectClaims(data, texts);
  const group = copyGroups(data, texts, dupes);
  const docOf = (rel) => group.get(rel) || rel;
  const docCount = (rels) => new Set(rels.map(docOf)).size;
  // How official each file is (lib/docAuthority) — versions are ranked by it.
  const authorityOf = (rel) => documentAuthority(data.files.find((f) => f.rel === rel) || { name: rel });
  const by = new Map();
  for (const c of claims) {
    const k = `${c.key}|${c.kind}${c.kind === 'amount' ? `|${fold(c.label).replace(/[^a-z]/g, '').slice(0, 12)}` : ''}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(c);
  }
  // Files that amend / supersede one another may differ on purpose.
  const revises = new Set(data.links.filter((l) => l.type === 'amends' || l.type === 'supersedes').flatMap((l) => [`${l.from}|${l.to}`, `${l.to}|${l.from}`]));
  const out = [];
  for (const [k, list] of by) {
    const groups = [];
    for (const c of list) {
      const g = groups.find((x) => (c.kind === 'address' ? sameAddress(x.norm, c.norm) : x.norm === c.norm));
      // `said`: where each file states it, in its own words (the fact's label
      // and the value exactly as written) — what the Contradictions tab shows.
      const said = { rel: c.rel, label: c.label, raw: c.value };
      if (g) {
        if (!g.files.includes(c.rel)) g.files.push(c.rel);
        if (!g.said.some((x) => x.rel === c.rel && x.label === c.label)) g.said.push(said);
        // Equal addresses written differently: one fuller address out of all of them.
        if (c.kind === 'address') g.value = mergeAddresses(g.said.map((x) => ({ value: x.raw, authority: authorityOf(x.rel).score })));
      } else groups.push({ norm: c.norm, value: c.value, files: [c.rel], said: [said] });
    }
    if (groups.length < 2) continue;
    // Two readings in ONE file are the file's own business (a price and a
    // deposit) — a contradiction needs two files.
    const files = uniq(groups.flatMap((g) => g.files));
    if (files.length < 2) continue;
    const kind = list[0].kind;
    const revised = files.some((a) => files.some((b) => a !== b && revises.has(`${a}|${b}`)));
    // Every file here a copy of one document: the OCR read the copies
    // differently — not a contradiction between documents.
    const copiesOnly = docCount(files) < 2;
    // Copies of one document on BOTH sides: that document itself was misread.
    const misread = !copiesOnly && groups.some((g, i) => groups.some((h, j) => i !== j && g.files.some((a) => h.files.some((b) => docOf(a) === docOf(b)))));
    out.push({
      id: `l:${k}`, source: 'local', subject: list[0].name, kind,
      values: groups.map((g) => {
        const best = g.files.map(authorityOf).sort((a, b) => b.score - a.score)[0];
        return { value: kind === 'birth' || kind === 'signDate' ? showDate(g.norm) : g.value, files: g.files, said: g.said, authority: best, documents: docCount(g.files) };
      }).sort((a, b) => b.authority.score - a.authority.score),
      files, severity: kind === 'cnp' || kind === 'birth' ? 'error' : 'warn', copiesOnly,
      note: copiesOnly
        ? 'These files are copies of one document (the same file saved twice, or an edited / re-saved copy) — the difference is a misreading of one copy, not a disagreement between documents.'
        : misread
          ? 'Some of these files are copies of one document that were read differently — part of this is a misreading, not a disagreement.'
          : revised ? 'One of these files amends or replaces the other, so the change may be intended.' : '',
    });
  }
  for (const l of data.links.filter((x) => x.type === 'contradicts')) {
    const fa = documentAuthority(data.files.find((f) => f.rel === l.from) || { name: l.from });
    const fb = documentAuthority(data.files.find((f) => f.rel === l.to) || { name: l.to });
    out.push({
      id: `a:${l.from}|${l.to}`, source: 'ai', subject: '', kind: 'ai', values: [], authorities: { [l.from]: fa, [l.to]: fb },
      why: l.why || '', evidence: arr(l.evidence), confidence: Number(l.confidence) || 0,
      files: [l.from, l.to], severity: 'warn', copiesOnly: docOf(l.from) === docOf(l.to),
      note: docOf(l.from) === docOf(l.to) ? 'These two files are copies of one document.' : '',
    });
  }
  const rank = { error: 0, warn: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.source === 'local' ? -1 : 1));
}

// ── 2. Authenticity ─────────────────────────────────────────────────────
// → [{ id, status: 'ok' | 'warn' | 'error', kind, title, detail, lines?, files }]
const ID_DOC_WORDS = /carte de identitate|buletin|pasaport|passport|permis de conducere|driving licen|identity card|romania.*identity|document de calatorie/;
export function checkAuthenticity(data, texts = {}) {
  const out = [];
  const today = new Date().toISOString().slice(0, 10);
  const claims = collectClaims(data, texts);
  // CNPs: the check digit, the date, the county — and the birth date the
  // files give for the same person.
  const cnps = new Map();
  for (const c of claims.filter((x) => x.kind === 'cnp')) {
    const cur = cnps.get(c.norm) || { name: c.name, key: c.key, files: [] };
    if (!cur.files.includes(c.rel)) cur.files.push(c.rel);
    cnps.set(c.norm, cur);
  }
  for (const [cnp, info] of cnps) {
    const r = checkCnp(cnp);
    const births = claims.filter((x) => x.kind === 'birth' && x.key === info.key);
    const clash = r.birth ? births.filter((b) => b.norm !== r.birth) : [];
    const problems = [...r.problems, ...clash.map((b) => `The birth date given in ${b.rel.split('/').pop()} (${showDate(b.norm)}) is not the one the CNP holds (${showDate(r.birth)})`)];
    out.push({
      id: `cnp:${cnp}`, kind: 'cnp', status: problems.length ? 'error' : 'ok',
      title: `CNP ${cnp} · ${info.name}`,
      detail: problems.length ? problems.join('. ') + '.' : `Check digit and date hold: born ${showDate(r.birth)}, ${r.sex === 'F' ? 'female' : 'male'}.${births.length ? ' Matches the birth date the files give.' : ''}`,
      files: uniq([...info.files, ...clash.map((b) => b.rel)]),
    });
  }
  // Identity documents: the machine-readable strip against the printed fields,
  // and the expiry date.
  for (const f of data.files) {
    const text = texts[f.rel] || '';
    const u = f.u;
    const isId = !!u.idDocument || ID_DOC_WORDS.test(fold(`${u.documentType} ${u.subject} ${f.name}`));
    const mrz = parseMrz(text);
    if (!isId && !mrz) continue;
    const who = u.idDocument?.holder || u.subject || f.name;
    if (mrz) {
      const problems = [];
      const notes = [];
      if (!mrz.docOk) problems.push(`the document number's check digit fails (${mrz.docNumber})`);
      if (!mrz.birthOk) problems.push('the birth date’s check digit fails');
      if (!mrz.expiryOk) problems.push('the expiry date’s check digit fails');
      if (!mrz.finalOk) problems.push('the overall check digit fails');
      // The printed side: every line but the strip's own.
      const printedText = text.split(/\r?\n/).filter((l) => !isMrzLine(l)).join('\n');
      const flat = printedText.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (mrz.docNumber && mrz.docNumber.length >= 6 && !flat.includes(mrz.docNumber)) {
        // Romanian ID cards print the series and the number apart ("SERIA SV NR 123456").
        const series = mrz.docNumber.slice(0, 2); const num = mrz.docNumber.slice(2);
        if (!(new RegExp(`${series}.{0,6}${num}`)).test(flat)) notes.push(`the number in the strip (${mrz.docNumber}) is not found printed on the card`);
      }
      const printedCnp = findCnps(printedText)[0];
      if (printedCnp && mrz.birth) {
        const r = checkCnp(printedCnp);
        if (r.birth && r.birth !== mrz.birth) problems.push(`the strip's birth date (${showDate(mrz.birth)}) is not the printed CNP's (${showDate(r.birth)})`);
        if (r.sex && mrz.sex && r.sex !== mrz.sex) problems.push(`the strip says sex ${mrz.sex}, the CNP says ${r.sex}`);
        // The older Romanian card carries the CNP's first digit and last six in the strip.
        const opt = mrz.format === 'TD2' ? mrz.optional : '';
        if (opt && /^\d{7}$/.test(opt) && opt !== printedCnp[0] + printedCnp.slice(7)) problems.push(`the strip's CNP digits (${opt}) are not the printed CNP's`);
      }
      if (mrz.surname) {
        const printed = fold(printedText);
        const sur = fold(mrz.surname).split(' ').filter((w) => w.length >= 3);
        if (sur.length && !sur.every((w) => printed.includes(w))) notes.push(`the surname in the strip (${mrz.surname}) is not found in the printed text`);
      }
      out.push({
        id: `mrz:${f.rel}`, kind: 'mrz', status: problems.length ? 'error' : notes.length ? 'warn' : 'ok',
        title: `Machine-readable strip · ${who}`,
        detail: problems.length || notes.length
          ? `${[...problems, ...notes].join('; ').replace(/^./, (c) => c.toUpperCase())}.`
          : `${mrz.format} strip reads cleanly: ${mrz.surname} ${mrz.given}, no. ${mrz.docNumber}, born ${showDate(mrz.birth)}, valid until ${showDate(mrz.expiry)}. Every check digit holds.`,
        lines: mrz.lines, files: [f.rel],
      });
    }
    // Expiry: the strip's, else a fact about validity.
    let expiry = mrz?.expiryOk ? mrz.expiry : null;
    if (!expiry) {
      for (const fact of arr(u.facts)) {
        if (!/valab|expir|valid|until|pana la/.test(fold(fact.label))) continue;
        const dates = [...String(fact.value).matchAll(/\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{2,4}/g)].map((m) => parseDate(m[0])).filter(Boolean);
        if (dates.length) { expiry = dates.sort().pop(); break; }
      }
    }
    if (!expiry && isId) {
      // The card's own "Valabilitate 01.01.15-01.01.25" line: its later date.
      for (const line of text.split(/\r?\n/)) {
        if (!/valab|valid|expir|pana la/.test(fold(line))) continue;
        const dates = [...line.matchAll(/\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{2,4}/g)].map((m) => parseDate(m[0])).filter(Boolean);
        if (dates.length) { expiry = dates.sort().pop(); break; }
      }
    }
    if (expiry) {
      const expired = expiry < today;
      out.push({
        id: `exp:${f.rel}`, kind: 'expiry', status: expired ? 'error' : 'ok',
        title: `${expired ? 'Expired' : 'Valid'} · ${u.idDocument?.type || u.documentType || 'identity document'} of ${who}`,
        detail: expired ? `It expired on ${showDate(expiry)}. An act signed after that date on the strength of it may be challenged.` : `Valid until ${showDate(expiry)}.`,
        files: [f.rel],
      });
    } else if (isId && !mrz) {
      out.push({ id: `exp:${f.rel}`, kind: 'expiry', status: 'warn', title: `No expiry date read · ${who}`, detail: 'The file looks like an identity document, but no expiry date or machine-readable strip could be read from it. Check it by eye.', files: [f.rel] });
    }
  }
  // CUIs: the check digit (ANAF on request — `checkCuisWithAnaf`).
  const cuis = new Map();
  for (const f of data.files) {
    const found = new Set(findCuis(texts[f.rel]));
    for (const p of arr(f.u.parties)) for (const id of arr(p.identifiers)) {
      const m = /(?:cui|cif|cod fiscal|RO)\s*[:\-]?\s*(?:RO\s?)?(\d{2,10})\b/i.exec(id);
      if (m) found.add(m[1]);
    }
    for (const cui of found) {
      const cur = cuis.get(cui) || { files: [], names: new Set() };
      if (!cur.files.includes(f.rel)) cur.files.push(f.rel);
      arr(f.u.parties).filter((p) => !PERSONISH(p)).forEach((p) => cur.names.add(p.name));
      cuis.set(cui, cur);
    }
  }
  for (const [cui, info] of cuis) {
    const ok = cuiValid(cui);
    out.push({
      id: `cui:${cui}`, kind: 'cui', cui, status: ok ? 'ok' : 'error',
      title: `CUI ${cui}${info.names.size === 1 ? ` · ${[...info.names][0]}` : ''}`,
      detail: ok ? 'The check digit holds. Check with ANAF to see whether the company exists and is active.' : 'The check digit is wrong: no company can have this CUI. A digit was probably mistyped.',
      names: [...info.names], files: info.files,
    });
  }
  const rank = { error: 0, warn: 1, ok: 2 };
  return out.sort((a, b) => rank[a.status] - rank[b.status]);
}

// ANAF's answer for the CUIs that pass the check digit → the same rows,
// updated: not found, inactive, struck off, or named differently.
export async function checkCuisWithAnaf(rows) {
  const { lookupCompanies } = await import('./anaf');
  const list = rows.filter((r) => r.kind === 'cui' && r.status === 'ok').map((r) => r.cui);
  if (!list.length) return { rows, asked: 0 };
  const res = await lookupCompanies(list.slice(0, 100).join(' '));
  if (!res?.ok) return { rows, error: res?.error || 'unreachable' };
  const by = new Map(res.companies.map((c) => [String(Number(c.cui)), c]));
  const next = rows.map((r) => {
    if (r.kind !== 'cui' || r.status !== 'ok') return r;
    const c = by.get(String(Number(r.cui)));
    if (!c) return { ...r, status: 'error', anaf: 'missing', detail: 'ANAF has no company with this CUI.' };
    const flags = [];
    if (c.inactive?.on) flags.push(`declared INACTIVE by ANAF${c.inactive.since ? ` since ${c.inactive.since}` : ''}`);
    if (c.inactive?.deleted || /radiat/i.test(c.registration || '')) flags.push('STRUCK OFF the register');
    const named = c.name || '';
    const differs = (r.names || []).filter((n) => { const k = foldName(n); return k && !foldName(named).includes(k) && !k.includes(foldName(named)); });
    const status = flags.length ? 'error' : differs.length ? 'warn' : 'ok';
    const detail = [
      `ANAF: ${c.name || 'the company'}${c.address ? `, ${c.address}` : ''}.`,
      flags.length ? ` It is ${flags.join(' and ')}.` : ' Active.',
      differs.length ? ` The files name it "${differs[0]}".` : '',
    ].join('');
    return { ...r, status, anaf: 'found', detail };
  });
  return { rows: next, asked: list.length, asOf: res.asOf };
}

// ── 3. Plates and places ────────────────────────────────────────────────
// Plates: → [{ plate, files, people, collections, dates }]
export function findVehicles(data, texts = {}) {
  const by = new Map();
  for (const f of data.files) {
    const hay = `${texts[f.rel] || ''}\n${arr(f.u.facts).map((x) => `${x.label}: ${x.value}`).join('\n')}`;
    for (const plate of findPlates(hay)) {
      const cur = by.get(plate) || { plate, files: [], people: new Set(), collections: new Set(), dates: [] };
      if (!cur.files.includes(f.rel)) cur.files.push(f.rel);
      arr(f.u.parties).forEach((p) => cur.people.add(p.name));
      collectionsOf(data, f.rel).forEach((c) => cur.collections.add(c.doc.title));
      arr(f.u.dates).forEach((d) => { const iso = parseDate(d.date); if (iso) cur.dates.push({ date: iso, event: d.event, rel: f.rel }); });
      by.set(plate, cur);
    }
  }
  return [...by.values()].map((v) => ({ ...v, people: [...v.people], collections: [...v.collections], dates: v.dates.sort((a, b) => a.date.localeCompare(b.date)) }))
    .sort((a, b) => b.files.length - a.files.length);
}

// Photos' EXIF: when and where each was taken (the first 256 KB are read —
// the metadata sits at the head of a JPEG). → [{ rel, name, path, taken,
// lat, lon, camera, sameDay: [timeline events], near: [rel] }]
export async function readPhotoPlaces(data, { onProgress, isCancelled } = {}) {
  const photos = data.all.filter((f) => /^(jpe?g)$/.test(extOf(f.name)));
  const out = [];
  let n = 0;
  for (const f of photos.slice(0, 600)) {
    if (isCancelled?.()) break;
    n += 1;
    onProgress?.(n, Math.min(600, photos.length));
    try {
      const res = await fetch(localUrl(f.path), { headers: { Range: 'bytes=0-262143' } });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const exif = readExif(bytes);
      if (!exif) continue;
      const lat = gpsDecimal(exif.GPSLatitude, exif.GPSLatitudeRef);
      const lon = gpsDecimal(exif.GPSLongitude, exif.GPSLongitudeRef);
      const raw = String(exif.DateTimeOriginal || exif.DateTime || '');
      const m = /^(\d{4}):(\d{2}):(\d{2})[ T]?(\d{2}:\d{2})?/.exec(raw);
      const taken = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
      if (!taken && !lat) continue;
      out.push({ rel: f.rel, name: f.name, path: f.path, taken, time: m?.[4] || '', lat: lat ? Number(lat) : null, lon: lon ? Number(lon) : null, camera: [exif.Make, exif.Model].filter(Boolean).join(' ') });
    } catch { /* unreadable — skipped */ }
    if (n % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  // Linked to the timeline (same day) and to each other (within 200 m).
  for (const p of out) {
    p.sameDay = p.taken ? data.timeline.filter((t) => parseDate(t.date) === p.taken).slice(0, 4) : [];
    p.near = p.lat != null ? out.filter((q) => q !== p && q.lat != null && metres(p, q) < 200).map((q) => q.rel) : [];
  }
  return out.sort((a, b) => String(a.taken || '').localeCompare(String(b.taken || '')));
}
function metres(a, b) {
  const R = 6371000; const r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat); const dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const mapUrl = (lat, lon) => `https://www.google.com/maps?q=${lat},${lon}`;

// ── 4. The missing-document checklist ───────────────────────────────────
// Per kind of case, what a file for it normally holds; each item is found by
// words in the file's name, its document type, subject and summary (folded).
export const CASE_TYPES = [
  {
    id: 'sale', label: 'Property sale', items: [
      { id: 'title', label: 'Title deed of the seller', hint: 'An earlier sale contract, an inheritance certificate or another title', re: /titlu de proprietate|contract de vanzare|certificat de mostenitor|act de proprietate|contract de donatie|title deed/ },
      { id: 'cf', label: 'Land-registry extract (for authentication)', hint: 'Extras de carte funciară, requested by the notary on the day', re: /carte funciar|extras cf|land.?regist/ },
      { id: 'cadastre', label: 'Cadastral documentation', hint: 'Plan de amplasament și delimitare, releveu', re: /cadastr|plan de amplasament|releveu/ },
      { id: 'fiscal', label: 'Tax certificate from the town hall', hint: 'Certificat de atestare fiscală for the property', re: /certificat (de atestare )?fiscal|atestare fiscal/ },
      { id: 'energy', label: 'Energy performance certificate', hint: 'Certificat de performanță energetică', re: /performanta energetic|energy performance/ },
      { id: 'hoa', label: 'Owners’ association statement (flats)', hint: 'Adeverință de la asociația de proprietari that nothing is owed', re: /asociati(a|ei) de proprietari|adeverinta.*asociat/, optional: true },
      { id: 'ids', label: 'Identity documents of the parties', hint: 'Every seller and buyer', re: /carte de identitate|buletin|pasaport|passport|identity card/, idDoc: true },
      { id: 'contract', label: 'The sale contract or the preliminary contract', hint: 'Antecontract / promisiune de vânzare', re: /antecontract|promisiun|contract de vanzare|sale contract/ },
    ],
  },
  {
    id: 'inheritance', label: 'Inheritance', items: [
      { id: 'death', label: 'Death certificate', hint: 'Certificat de deces', re: /certificat de deces|death certificate/ },
      { id: 'civil', label: 'Heirs’ civil-status documents', hint: 'Birth and marriage certificates proving the kinship', re: /certificat de nastere|certificat de casatorie|birth certificate|marriage certificate/ },
      { id: 'ids', label: 'Identity documents of the heirs', hint: '', re: /carte de identitate|buletin|pasaport|passport|identity card/, idDoc: true },
      { id: 'title', label: 'Title deeds of the estate', hint: 'For every property and vehicle left', re: /titlu de proprietate|contract de vanzare|certificat de mostenitor|act de proprietate|title deed/ },
      { id: 'cf', label: 'Land-registry extract', hint: 'Extras de carte funciară for each property', re: /carte funciar|extras cf/ },
      { id: 'fiscal', label: 'Tax certificate', hint: 'Certificat fiscal for the deceased’s properties', re: /certificat (de atestare )?fiscal|atestare fiscal/ },
      { id: 'rnneprt', label: 'Wills-register certificate', hint: 'From the national notarial register (RNNEPR)', re: /rnnep|registrul national notarial|evidenta (a )?testament/ },
      { id: 'will', label: 'Will', hint: 'Only if there is one', re: /testament/, optional: true },
      { id: 'bank', label: 'Bank statements', hint: 'Accounts in the deceased’s name', re: /extras de cont|bank statement|cont bancar/, optional: true },
    ],
  },
  {
    id: 'company', label: 'Company setup (SRL)', items: [
      { id: 'name', label: 'Name reservation', hint: 'Dovada de disponibilitate / rezervare a denumirii', re: /rezervar.*denumir|disponibilitate.*denumir|dovada de rezervare|name reservation/ },
      { id: 'act', label: 'Articles of association', hint: 'Act constitutiv', re: /act constitutiv|statut|articles of association/ },
      { id: 'seat', label: 'Proof of the registered office', hint: 'Contract de comodat or închiriere, with the land-registry extract', re: /comodat|contract de inchiriere|sediu social|dovada.*sediu|lease/ },
      { id: 'decl', label: 'Sworn statements of the associates and administrators', hint: 'Declarații pe propria răspundere', re: /declarati[ea] pe propri[ae] raspunder/ },
      { id: 'specimen', label: 'Signature specimen', hint: 'Of each administrator', re: /specimen de semnatur/ },
      { id: 'ids', label: 'Identity documents of the associates', hint: '', re: /carte de identitate|buletin|pasaport|passport|identity card/, idDoc: true },
      { id: 'capital', label: 'Proof the share capital was paid', hint: 'Extras de cont or a deposit slip', re: /capital social|varsar|extras de cont|deposit/ },
      { id: 'onrc', label: 'Registration application (ONRC)', hint: 'Cerere de înregistrare', re: /cerere de inregistrare|onrc|registrul comertului/ },
      { id: 'hoa', label: 'Owners’ association consent', hint: 'Only when the office is a flat', re: /acord.*asociati|asociatia de proprietari/, optional: true },
    ],
  },
  {
    id: 'lease', label: 'Lease', items: [
      { id: 'contract', label: 'Lease contract', hint: 'Contract de închiriere', re: /contract de inchiriere|lease/ },
      { id: 'title', label: 'Landlord’s title deed', hint: 'Or the land-registry extract', re: /titlu de proprietate|carte funciar|contract de vanzare|certificat de mostenitor/ },
      { id: 'ids', label: 'Identity documents of the parties', hint: '', re: /carte de identitate|buletin|pasaport|passport|identity card/, idDoc: true },
      { id: 'handover', label: 'Hand-over report', hint: 'Proces-verbal de predare-primire, with the meter readings', re: /predare.?primire|hand.?over/ },
      { id: 'anaf', label: 'Registration with ANAF', hint: 'The lease registered with the tax office', re: /anaf.*inregistr|inregistrare.*contract|form(ularul)? c168/, optional: true },
    ],
  },
  {
    id: 'car', label: 'Vehicle sale', items: [
      { id: 'contract', label: 'Vehicle sale contract', hint: 'Contract de vânzare-cumpărare auto', re: /contract.*(auto|autovehicul|autoturism)|vanzare.*(autoturism|autovehicul)/ },
      { id: 'civ', label: 'Vehicle identity card (CIV)', hint: 'Cartea de identitate a vehiculului', re: /carte(a)? de identitate a vehiculului|\bciv\b/ },
      { id: 'reg', label: 'Registration certificate', hint: 'Certificat de înmatriculare (talon)', re: /certificat de inmatriculare|talon/ },
      { id: 'fiscal', label: 'Tax certificate / deregistration', hint: 'Certificat fiscal and scoaterea din evidență', re: /certificat (de atestare )?fiscal|scoatere din evidenta/ },
      { id: 'rca', label: 'Insurance (RCA)', hint: '', re: /\brca\b|asigurare|insurance/ },
      { id: 'itp', label: 'Roadworthiness test (ITP)', hint: '', re: /\bitp\b|inspecti(a|e) tehnic/ },
      { id: 'ids', label: 'Identity documents of the parties', hint: '', re: /carte de identitate|buletin|pasaport|passport|identity card/, idDoc: true },
    ],
  },
  {
    id: 'lawsuit', label: 'Civil lawsuit', items: [
      { id: 'claim', label: 'Statement of claim', hint: 'Cererea de chemare în judecată', re: /cerere(a)? de chemare in judecata|statement of claim/ },
      { id: 'power', label: 'Lawyer’s power of attorney', hint: 'Împuternicire avocațială and the assistance contract', re: /imputernicire avocatial|contract de asistenta juridica|power of attorney/ },
      { id: 'fee', label: 'Proof the court fee was paid', hint: 'Taxa judiciară de timbru', re: /taxa judiciar|timbru|court fee/ },
      { id: 'notice', label: 'Prior notice to the other side', hint: 'Notificare / somație, where the law asks for one', re: /notificar|somati|punere in intarziere/, optional: true },
      { id: 'evidence', label: 'The documents relied on', hint: 'Contracts, invoices, correspondence', re: /contract|factur|invoice|corespondent|email/ },
      { id: 'ids', label: 'Client’s identity document or company record', hint: '', re: /carte de identitate|buletin|certificat de inregistrare|identity card/, idDoc: true },
    ],
  },
];
// → { type, guessed, items: [{ ...item, found: [rel] }] }
export function checklist(data, typeId = null) {
  const hayOf = (f) => fold(`${f.name} ${f.u.documentType || ''} ${f.u.subject || ''} ${f.u.text || ''} ${arr(f.u.themes).join(' ')}`);
  const hays = data.files.map((f) => ({ f, hay: hayOf(f) }));
  const score = (t) => t.items.map((it) => hays.filter(({ f, hay }) => it.re.test(hay) || (it.idDoc && f.u.idDocument)).map(({ f }) => f.rel))
    .map((found, i) => ({ ...t.items[i], found }));
  let type = CASE_TYPES.find((t) => t.id === typeId);
  let guessed = false;
  if (!type) {
    guessed = true;
    let best = null;
    for (const t of CASE_TYPES) {
      const items = score(t);
      const s = items.filter((x) => x.found.length && x.id !== 'ids').length / t.items.length;
      if (!best || s > best.s) best = { t, s };
    }
    type = best.t;
  }
  return { type, guessed, items: score(type) };
}

// ── 5. Duplicates ───────────────────────────────────────────────────────
// → { exact: [[file…]], similar: [{ files, distance }], versions: [{ older,
//     newer, likeness }] }. Local, may take a while on a big folder.
export async function findDuplicates(data, texts = {}, { onProgress, isCancelled } = {}) {
  const say = (step, frac) => onProgress?.(step, frac);
  // Identical bytes: same size first, then the hash.
  const bySize = new Map();
  for (const f of data.all) if (f.size > 0) { if (!bySize.has(f.size)) bySize.set(f.size, []); bySize.get(f.size).push(f); }
  const candidates = [...bySize.values()].filter((g) => g.length > 1).flat().filter((f) => f.size <= 300 * 1024 * 1024);
  const byHash = new Map();
  let n = 0;
  for (const f of candidates) {
    if (isCancelled?.()) return null;
    say(`Comparing files byte by byte · ${f.name}`, 0.4 * (++n / Math.max(1, candidates.length)));
    try {
      const h = await sha256Of(f.path);
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(f);
    } catch { /* unreadable */ }
  }
  const exact = [...byHash.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a.mtime - b.mtime));
  const inExact = new Set(exact.flat().map((f) => f.rel));
  // Near-identical pictures: a 64-bit difference hash of the OS thumbnail.
  const pics = data.all.filter((f) => f.kind === 'image').slice(0, 800);
  const hashes = [];
  n = 0;
  for (const f of pics) {
    if (isCancelled?.()) return null;
    say(`Looking at the pictures · ${f.name}`, 0.4 + 0.4 * (++n / Math.max(1, pics.length)));
    try { const h = await dhashOf(f.path); if (h != null) hashes.push({ f, h }); } catch { /* not decodable */ }
    if (n % 6 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const similar = [];
  for (let i = 0; i < hashes.length; i += 1) {
    for (let j = i + 1; j < hashes.length; j += 1) {
      const a = hashes[i]; const b = hashes[j];
      if (inExact.has(a.f.rel) && inExact.has(b.f.rel)) continue;
      const d = hamming(a.h, b.h);
      if (d <= 6) similar.push({ files: [a.f, b.f].sort((x, y) => x.mtime - y.mtime), distance: d });
    }
  }
  // Versions of one text: 5-word shingles, Jaccard likeness.
  say('Comparing the texts', 0.85);
  const docs = data.files.filter((f) => f.kind === 'doc' && !inExact.has(f.rel)).map((f) => ({ f, s: shingles(texts[f.rel] || '') })).filter((x) => x.s.size >= 20).slice(0, 400);
  const versions = [];
  for (let i = 0; i < docs.length; i += 1) {
    if (i % 20 === 0) { if (isCancelled?.()) return null; await new Promise((r) => setTimeout(r, 0)); }
    for (let j = i + 1; j < docs.length; j += 1) {
      const a = docs[i]; const b = docs[j];
      if (Math.min(a.s.size, b.s.size) / Math.max(a.s.size, b.s.size) < 0.5) continue;
      const alike = likeness(a.s, b.s);
      if (alike >= 0.6) {
        const [older, newer] = [a.f, b.f].sort((x, y) => x.mtime - y.mtime);
        versions.push({ older, newer, likeness: alike });
      }
    }
  }
  say('Done', 1);
  return { exact, similar, versions: versions.sort((a, b) => b.likeness - a.likeness) };
}

// ── 6. Signatures and stamps (AI — paid) ────────────────────────────────
// Every picture / PDF page that may carry one goes to the AI in batches;
// it describes each signature and stamp and whose it is. Then, per person /
// company with marks in two files or more, those pictures go again with the
// question whether they match. Kept per folder with the files' stamps, so a
// second look at unchanged files costs nothing.
const SIG_KEY = 'docvex:insights:signatures:v1:';
export function loadSignatureReport(dir) {
  try { return JSON.parse(localStorage.getItem(SIG_KEY + dir) || 'null'); } catch { return null; }
}
async function imagePayload(f, page = null) {
  let blob;
  if (page) {
    const { pdfPageImage } = await import('./pdfConvert');
    const { dataUrl } = await pdfPageImage({ path: f.path, page, dpi: 110 });
    blob = await (await fetch(dataUrl)).blob();
  } else {
    blob = await readLocalBlob(f.path);
    if (/heic|heif/i.test(extOf(f.name))) { const { heicJpeg } = await import('./heic'); blob = await heicJpeg(blob, 1600); }
  }
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const url = c.toDataURL('image/jpeg', 0.82);
  c.width = 0;
  return url.slice(url.indexOf(',') + 1);
}
const parseJson = (text) => { const m = /\{[\s\S]*\}/.exec(String(text || '')); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } };
const SIG_WORDS = /semnat|semnatur|stampil|l\.s\.|sign|stamp|seal|contract|proces.?verbal|declarati|imputernicire|procura|factur|chitant|adeverint|certificat/;
export async function compareSignatures(data, { projectId, onProgress, isCancelled } = {}) {
  const say = (step, frac) => onProgress?.(step, frac);
  const pages = [];
  for (const f of data.files) {
    if (!SIG_WORDS.test(fold(`${f.name} ${f.u.documentType} ${f.u.text}`))) continue;
    if (f.kind === 'image') pages.push({ f, page: null, label: f.name });
    else if (extOf(f.name) === 'pdf') {
      try {
        const { getCachedPdf } = await import('./pdfCache');
        const pdf = await getCachedPdf(f.path, localUrl(f.path));
        const count = pdf.numPages;
        // Signatures are on the last page; a short act may carry them on each.
        const want = count <= 2 ? Array.from({ length: count }, (_, i) => i + 1) : [1, count];
        want.forEach((p) => pages.push({ f, page: p, label: `${f.name}, page ${p}` }));
      } catch { /* not a readable PDF */ }
    }
  }
  const list = pages.slice(0, 30);
  if (!list.length) return { error: 'nothing', marks: [], groups: [] };
  const marks = [];
  const BATCH = 5;
  for (let i = 0; i < list.length; i += BATCH) {
    if (isCancelled?.()) return null;
    const batch = list.slice(i, i + BATCH);
    say(`Finding signatures and stamps · ${i + 1}–${i + batch.length} of ${list.length}`, 0.6 * (i / list.length));
    const content = [];
    for (let k = 0; k < batch.length; k += 1) {
      try {
        content.push({ type: 'text', text: `IMAGE ${k + 1}: ${batch[k].label}` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await imagePayload(batch[k].f, batch[k].page) } });
      } catch { content.push({ type: 'text', text: '(could not be read)' }); }
    }
    content.push({ type: 'text', text: `Find every handwritten SIGNATURE and every STAMP / SEAL on these images of legal documents (mostly Romanian).
Answer ONLY with JSON: {"images":[{"i":<image number>,"marks":[{"kind":"signature"|"stamp","owner":"whose it is — the person or company named beside it, under it, or inside the stamp; \\"\\" if not stated","stamp_text":"the stamp's legible words and numbers, else \\"\\"","description":"what it looks like: shape, colour, size, strokes, letters, slant, legibility"}]}]}
Rules: only marks really present. Use the name as the document writes it. A printed name alone is not a signature.` });
    const res = await askProjectAi({ messages: [{ role: 'user', content }], tools: false, model: MODEL, usageProject: projectId, usageAction: 'insights-signatures' });
    if (res?.error) return { error: String(res.error), marks, groups: [] };
    for (const img of arr(parseJson(res.text)?.images)) {
      const src = batch[Number(img?.i) - 1];
      if (!src) continue;
      for (const m of arr(img.marks)) {
        if (!['signature', 'stamp'].includes(m?.kind)) continue;
        marks.push({ kind: m.kind, owner: String(m.owner || '').trim(), stampText: String(m.stamp_text || '').trim(), description: String(m.description || '').trim(), rel: src.f.rel, page: src.page, label: src.label, at: list.indexOf(src) });
      }
    }
  }
  // Per owner and kind, marks in two files or more are compared, pictures side by side.
  const by = new Map();
  for (const m of marks) {
    const k = foldName(m.owner);
    if (!k) continue;
    const key = `${m.kind}|${k}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(m);
  }
  const groups = [];
  const todo = [...by.entries()].filter(([, ms]) => new Set(ms.map((m) => m.label)).size >= 2);
  let g = 0;
  for (const [key, ms] of todo) {
    if (isCancelled?.()) return null;
    g += 1;
    const owner = ms[0].owner; const kind = ms[0].kind;
    say(`Comparing the ${kind === 'stamp' ? 'stamps' : 'signatures'} of ${owner}`, 0.6 + 0.4 * (g / todo.length));
    const seen = new Map();
    ms.forEach((m) => { if (!seen.has(m.label)) seen.set(m.label, m); });
    const shown = [...seen.values()].slice(0, 6);
    const content = [];
    for (let k = 0; k < shown.length; k += 1) {
      const src = list[shown[k].at];
      try {
        content.push({ type: 'text', text: `IMAGE ${k + 1}: ${shown[k].label}` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await imagePayload(src.f, src.page) } });
      } catch { /* left out */ }
    }
    content.push({ type: 'text', text: `Each image carries a ${kind} attributed to "${owner}". Compare that ${kind} across the images — ${kind === 'stamp' ? 'shape, size, border, text, numbers, colour, layout' : 'letter forms, proportions, slant, pressure, rhythm, flourishes'} — and say which look DIFFERENT from the rest (a possible forgery, another signer, another stamp).
Answer ONLY with JSON: {"consistent":true|false,"outliers":[{"i":<image number>,"why":"what differs"}],"note":"one or two sentences on the comparison"}
Be careful: natural variation between genuine signatures is normal; flag only clear differences. You are giving a first look, not an expert opinion.` });
    const res = await askProjectAi({ messages: [{ role: 'user', content }], tools: false, model: MODEL, usageProject: projectId, usageAction: 'insights-signatures' });
    const ans = res?.error ? null : parseJson(res.text);
    groups.push({
      key, owner, kind, marks: shown,
      consistent: ans ? ans.consistent !== false && !arr(ans.outliers).length : null,
      outliers: arr(ans?.outliers).map((o) => ({ label: shown[Number(o?.i) - 1]?.label, rel: shown[Number(o?.i) - 1]?.rel, why: String(o?.why || '') })).filter((o) => o.rel),
      note: ans ? String(ans.note || '') : 'The comparison could not be made.',
    });
  }
  const report = { at: Date.now(), pages: list.length, marks, groups: groups.sort((a, b) => (a.consistent === false ? -1 : 0) - (b.consistent === false ? -1 : 0)) };
  try { localStorage.setItem(SIG_KEY + data.dir, JSON.stringify(report)); } catch { /* too big — shown this time only */ }
  say('Done', 1);
  return report;
}

// ── 7. The question box (AI — paid) ─────────────────────────────────────
function caseDigest(data, max = 150000) {
  const parts = [];
  for (const c of data.collections) parts.push(collectionToText(c.doc, c.rel).slice(0, 7000));
  for (const f of data.files) {
    const u = f.u;
    parts.push([
      `<file path="${f.rel}" official="${documentAuthority(f).label}">`,
      u.documentType ? `Type: ${u.documentType}` : '',
      u.subject ? `About: ${u.subject}` : '',
      u.text ? `Summary: ${u.text}` : '',
      arr(u.parties).length ? `Parties: ${arr(u.parties).map((p) => `${p.name}${p.role ? ` (${p.role})` : ''}${arr(p.identifiers).length ? ` [${p.identifiers.join(', ')}]` : ''}`).join('; ')}` : '',
      arr(u.facts).length ? `Facts: ${arr(u.facts).map((x) => `${x.label}: ${x.value}`).join('; ')}` : '',
      arr(u.dates).length ? `Dates: ${arr(u.dates).map((x) => `${x.date} ${x.event}`).join('; ')}` : '',
      '</file>',
    ].filter(Boolean).join('\n'));
  }
  let out = '';
  for (const p of parts) { if (out.length + p.length > max) break; out += `${p}\n\n`; }
  return out;
}
// → { answer, sources: [{ rel, why }], found } or { error }
export async function askCase(data, question, { projectId, history = [] } = {}) {
  const known = new Set(data.files.map((f) => f.rel).concat(data.collections.map((c) => c.rel)));
  const prior = history.slice(-4).map((h) => `Q: ${h.question}\nA: ${h.answer}`).join('\n\n');
  const prompt = `You answer questions about a legal case from what an AI scan read in its files. Below are the case's Data collections and every file's reading.
${`<case>\n${caseDigest(data)}</case>`}
${prior ? `\nEarlier in this conversation:\n${prior}\n` : ''}
QUESTION: ${question}

Answer from these files only — never from general knowledge or guesses. ${AUTHORITY_RULE} Each <file> says how official it is (official="…"). Answer in the language of the question, plainly, in 1–5 sentences; name people, amounts, dates and identifiers exactly as the files write them. If the files disagree, say so. If the files do not answer it, say that and what is missing.
Answer ONLY with JSON: {"answer":"…","found":true|false,"sources":[{"file":"the path exactly as in <file path=…> or the collection's file name","why":"what this file says that answers it"}]}`;
  const res = await askProjectAi({ messages: [{ role: 'user', content: prompt }], tools: false, model: MODEL, usageProject: projectId, usageAction: 'insights-ask' });
  if (res?.error) return { error: String(res.error?.message || res.error) };
  const ans = parseJson(res.text);
  if (!ans?.answer) return { answer: String(res.text || '').trim(), sources: [], found: true };
  const sources = arr(ans.sources).map((s) => {
    const want = String(s?.file || '').trim();
    const rel = known.has(want) ? want : [...known].find((k) => k.endsWith(`/${want}`) || k.split('/').pop() === want.split('/').pop());
    return rel ? { rel, why: String(s?.why || '') } : null;
  }).filter(Boolean);
  return { answer: String(ans.answer), found: ans.found !== false, sources };
}

// ── 8. The relationship graph ───────────────────────────────────────────
// People, companies, properties and vehicles as nodes, drawn by FileGraph:
// → { files: [{ id, name, type, path: '', detail, sources }], connections:
//   [{ from_file_id, to_file_id, connection_type, label, explanation,
//      evidence, confidence, sources: [rel] }] }
const REP_ROLE = /administrator|asociat|director|reprezentant|imputernicit|actionar|shareholder|manager|presedinte|fondator|titular/;
const PROPERTY_LABEL = /imobil|apartament|teren|casa\b|constructi|carte funciar|nr\.? cadastral|numar cadastral|proprietat|property|spatiu/;
const LOOKS_COMPANY = /\b(s\.?r\.?l|s\.?a\.?|srl|pfa|ong|asociatia|fundatia|banca|bank|ltd|gmbh|primaria|institutia|agentia|ministerul|tribunalul|judecatoria)\b/;
export function buildEntityGraph(data, texts = {}) {
  const nodes = new Map();
  const alias = new Map();   // a person's key → the key they are merged into (same CNP)
  const cnpOwner = new Map();
  const node = (key, name, type, rel, extra = {}) => {
    const k = alias.get(key) || key;
    const cur = nodes.get(k) || { id: k, name, type, path: '', sources: [], ids: new Set(), roles: new Set() };
    if (name.length > cur.name.length && type !== 'vehicle') cur.name = name;
    if (rel && !cur.sources.includes(rel)) cur.sources.push(rel);
    (extra.ids || []).forEach((x) => cur.ids.add(x));
    if (extra.role) cur.roles.add(extra.role);
    nodes.set(k, cur);
    return k;
  };
  const edges = new Map();
  const edge = (a, b, type, label, rel) => {
    if (!a || !b || a === b) return;
    const sym = type === 'same_document';
    const [x, y] = sym ? [a, b].sort() : [a, b];
    const key = `${x}|${y}|${type}|${fold(label)}`;
    const cur = edges.get(key) || { from_file_id: x, to_file_id: y, connection_type: type, label, sources: [] };
    if (!cur.sources.includes(rel)) cur.sources.push(rel);
    edges.set(key, cur);
  };
  // Merge people by CNP first.
  for (const f of data.files) {
    for (const p of arr(f.u.parties)) {
      if (!PERSONISH(p)) continue;
      const cnp = arr(p.identifiers).map((i) => String(i).replace(/\D/g, '')).find((d) => d.length === 13);
      if (!cnp) continue;
      const k = `p:${foldName(p.name)}`;
      if (cnpOwner.has(cnp) && cnpOwner.get(cnp) !== k) alias.set(k, cnpOwner.get(cnp)); else cnpOwner.set(cnp, k);
    }
  }
  for (const f of data.files) {
    const u = f.u;
    const parties = arr(u.parties).length ? arr(u.parties) : arr(u.entities).map((name) => ({ name, kind: LOOKS_COMPANY.test(fold(name)) ? 'company' : 'person' }));
    const here = [];
    for (const p of parties) {
      if (!foldName(p.name)) continue;
      const company = !PERSONISH(p) || LOOKS_COMPANY.test(fold(p.name));
      const type = company ? (p.kind === 'institution' ? 'institution' : 'company') : 'person';
      const k = node(`${company ? 'c' : 'p'}:${foldName(p.name)}`, p.name, type, f.rel, { ids: arr(p.identifiers), role: p.role });
      here.push({ k, p, type });
    }
    // Properties named in the facts; vehicles by plate.
    const things = [];
    for (const fact of arr(u.facts)) {
      const l = fold(fact.label);
      if (!PROPERTY_LABEL.test(l) || /domicil|sediu|resedin/.test(l)) continue;
      const cad = /(?:cadastral|cf|carte funciar)[^0-9]{0,20}(\d{3,8})/.exec(fold(`${fact.label} ${fact.value}`));
      const key = cad ? `r:${cad[1]}` : `r:${[...addressWords(fact.value)].sort().join(' ').slice(0, 80)}`;
      if (key.length < 6) continue;
      things.push(node(key, String(fact.value).slice(0, 90), 'property', f.rel));
    }
    const plates = findPlates(`${texts[f.rel] || ''}\n${arr(u.facts).map((x) => x.value).join('\n')}`);
    plates.forEach((pl) => things.push(node(`v:${pl}`, pl, 'vehicle', f.rel)));
    // Edges: a person's role in a company, a party's role toward a thing, and
    // people named in one document.
    for (const a of here) {
      for (const b of here) {
        if (a === b) continue;
        if (a.type === 'person' && b.type === 'company' && REP_ROLE.test(fold(a.p.role))) edge(a.k, b.k, 'represents', a.p.role, f.rel);
      }
      for (const t of new Set(things)) edge(a.k, t, t.startsWith('v:') ? 'vehicle' : 'property', a.p.role || '', f.rel);
    }
    if (here.length <= 6) {
      for (let i = 0; i < here.length; i += 1) for (let j = i + 1; j < here.length; j += 1) {
        const a = here[i]; const b = here[j];
        const already = [...edges.values()].some((e) => e.connection_type === 'represents' && ((e.from_file_id === a.k && e.to_file_id === b.k) || (e.from_file_id === b.k && e.to_file_id === a.k)));
        if (!already) edge(a.k, b.k, 'same_document', '', f.rel);
      }
    }
  }
  const nameOf = (rel) => rel.split('/').pop();
  const files = [...nodes.values()].map((n) => ({
    id: n.id, name: n.name, type: n.type, path: '',
    detail: [n.roles.size ? `Named as ${[...n.roles].filter(Boolean).slice(0, 3).join(', ')}` : '', n.ids.size ? [...n.ids].slice(0, 3).join(' · ') : ''].filter(Boolean).join(' · '),
    sources: n.sources,
  }));
  const connections = [...edges.values()].map((e) => ({
    ...e,
    explanation: e.connection_type === 'same_document'
      ? `Named together in ${e.sources.length} document${e.sources.length === 1 ? '' : 's'}.`
      : e.label ? `${e.label} — in ${e.sources.map(nameOf).slice(0, 3).join(', ')}.` : `Named in ${e.sources.map(nameOf).slice(0, 3).join(', ')}.`,
    evidence: e.sources.map(nameOf).slice(0, 6),
    confidence: Math.min(1, 0.35 + 0.2 * e.sources.length),
  }));
  return { files, connections };
}

// ── Resolving a contradiction ───────────────────────────────────────────
// A contradiction is settled by the user: which value is RIGHT (a local one),
// which file is right (the AI's), or that both are right (a change that was
// intended). The decision is kept with the project (settings store
// `insight-resolutions`, `.docvex/settings/` — it travels with the case; a
// localStorage copy when there is no project index) under the contradiction's
// id and a signature of its values: when a new file brings another value, the
// signature changes and the contradiction is open again.
// A value picked as right is also WRITTEN INTO THE DATA COLLECTIONS the files
// belong to — the person's record field (CNP → nationalId, date of birth,
// address) and a "… (confirmed)" fact — so the Advisor, autofill and every
// later reading use it. Undo puts those files back exactly as they were.
const RES_STORE = 'insight-resolutions';
const RES_LS = 'docvex:insight-resolutions:v1:';
export function contradictionSig(r) {
  if (r.source === 'ai') return `ai|${[...r.files].sort().join('|')}`;
  return r.values.map((v) => `${v.value}=${[...v.files].sort().join(',')}`).sort().join('||');
}
export async function loadResolutions(dir, projectId) {
  if (projectId && settingsAvailable()) {
    rememberProjectDir(projectId, dir);
    const v = await loadSetting(projectId, RES_STORE);
    if (v && typeof v === 'object') return v;
  }
  try { return JSON.parse(localStorage.getItem(RES_LS + dir) || '{}') || {}; } catch { return {}; }
}
async function saveResolutions(dir, projectId, map) {
  try { localStorage.setItem(RES_LS + dir, JSON.stringify(map)); } catch { /* full — the store copy stands */ }
  if (projectId && settingsAvailable()) await putSetting(projectId, RES_STORE, map);
}
// The resolution that still applies to a contradiction, or null.
export function resolutionFor(map, r) {
  const x = map?.[r.id];
  return x && x.sig === contradictionSig(r) ? x : null;
}

const RECORD_KEY = { cnp: 'nationalId', birth: 'dateOfBirth', address: 'address' };
// The Data collections a contradiction is about: those holding one of its
// files — and, for a person's detail, the ones named after that person.
function collectionsFor(data, r) {
  const files = new Set(r.files);
  const key = foldName(r.subject || '');
  return data.collections.filter((c) => {
    if (!c.doc.sources.some((s) => files.has(s.rel))) return false;
    if (!r.subject || r.kind === 'amount' || r.kind === 'signDate' || r.source === 'ai') return true;
    const names = [c.doc.title, c.doc.record?.name, c.doc.record?.legalName].map((n) => foldName(n || '')).filter(Boolean);
    return names.some((n) => n === key || n.includes(key) || key.includes(n));
  });
}
async function rewriteCollection(c, change) {
  const before = await (await readLocalBlob(c.path)).text();
  const doc = JSON.parse(before);
  change(doc);
  const text = JSON.stringify(doc, null, 2);
  if (text === before) return null;
  const cut = Math.max(c.path.lastIndexOf('/'), c.path.lastIndexOf('\\'));
  const res = await localFolderApi.writeFiles({ dir: c.path.slice(0, cut), files: [{ filename: c.path.slice(cut + 1), blob: new Blob([text], { type: 'application/json' }) }] });
  if (res?.error || !res?.results?.[0]?.ok) throw new Error(res?.error || 'write_failed');
  notifyFilesChanged();   // the collection's page re-reads itself
  return { path: c.path, before };
}

// `choice` = { type: 'value', value, files } | { type: 'file', rel } |
// { type: 'both' } | { type: 'dismiss' }. → the saved map.
export async function resolveContradiction(data, r, choice, { projectId } = {}) {
  const changed = [];
  const at = new Date().toISOString();
  const cols = collectionsFor(data, r);
  const nameOf = (rel) => String(rel).split('/').pop();
  try {
    if (choice.type === 'value') {
      const label = `${claimKindLabel(r.kind)} (confirmed)`;
      for (const c of cols) {
        const ch = await rewriteCollection(c, (doc) => {
          doc.facts = (Array.isArray(doc.facts) ? doc.facts : []).filter((f) => f?.label !== label);
          doc.facts.unshift({ label, value: choice.value, sources: choice.files, confirmedAt: at, note: `Chosen over: ${r.values.filter((v) => v.value !== choice.value).map((v) => v.value).join('; ')}` });
          const key = RECORD_KEY[r.kind];
          if (key && doc.record && typeof doc.record === 'object' && doc.record.kind !== 'org') doc.record[key] = choice.value;
        });
        if (ch) changed.push(ch);
      }
    } else if (choice.type === 'file') {
      const other = r.files.find((f) => f !== choice.rel);
      for (const c of cols) {
        const ch = await rewriteCollection(c, (doc) => {
          doc.facts = Array.isArray(doc.facts) ? doc.facts : [];
          doc.facts.unshift({ label: 'Contradiction resolved', value: `${nameOf(choice.rel)} is correct${other ? `, not ${nameOf(other)}` : ''}${r.why ? ` — ${r.why}` : ''}`, sources: r.files, confirmedAt: at });
        });
        if (ch) changed.push(ch);
      }
    }
  } catch (err) {
    // Put back whatever was written before the failure.
    await revertChanges(changed);
    throw err;
  }
  const map = await loadResolutions(data.dir, projectId);
  map[r.id] = { sig: contradictionSig(r), choice, at, changed };
  await saveResolutions(data.dir, projectId, map);
  return map;
}
async function revertChanges(changed) {
  for (const ch of [...(changed || [])].reverse()) {
    try {
      const cut = Math.max(ch.path.lastIndexOf('/'), ch.path.lastIndexOf('\\'));
      await localFolderApi.writeFiles({ dir: ch.path.slice(0, cut), files: [{ filename: ch.path.slice(cut + 1), blob: new Blob([ch.before], { type: 'application/json' }) }] });
    } catch { /* keep going */ }
  }
  if (changed?.length) notifyFilesChanged();
}
// Undo a resolution: the collections as they were, the contradiction open again.
export async function unresolveContradiction(data, r, { projectId } = {}) {
  const map = await loadResolutions(data.dir, projectId);
  const x = map[r.id];
  if (x?.changed?.length) await revertChanges(x.changed);
  delete map[r.id];
  await saveResolutions(data.dir, projectId, map);
  return map;
}
// The AI's view on which value is right — the question box, asked about this
// contradiction (PAID). → { answer, sources } or { error }.
export function suggestResolution(data, r, { projectId } = {}) {
  const off = (rel) => documentAuthority(data.files.find((f) => f.rel === rel) || { name: rel }).label.toLowerCase();
  const q = r.source === 'ai'
    ? `These two files seem to contradict each other: ${r.files.map((rel) => `${rel} (${off(rel)})`).join(' and ')}${r.why ? ` — ${r.why}` : ''}. Which one is right, and why? FAVOUR THE MOST OFFICIAL DOCUMENT: ${AUTHORITY_RULE} Then consider which is more recent.`
    : `The files disagree about the ${claimKindLabel(r.kind).toLowerCase()} of ${r.subject}: ${r.values.map((v) => `"${v.value}" in ${v.files.map((rel) => `${rel} (${off(rel)})`).join(', ')}`).join('; ')}. Which value is right, and why? FAVOUR THE MOST OFFICIAL DOCUMENT: ${AUTHORITY_RULE} For an address, the identity document or the state record states the legal address. Then consider which is more recent and whether one reads like a typo.`;
  return askCase(data, q, { projectId });
}
