// AI data — everything the app has WORKED OUT about a file (as opposed to what
// the file says about itself, which is lib/metadataHistory): the text read off a
// picture, a paid transcription, later a summary or the parties found in it.
// Working something out costs time and often tokens, so it is done ONCE, kept
// here, and read by everything else — the Doc Viewer's Data tab shows it, the
// Advisor's project digest quotes it, the identity reader reuses it instead of
// paying for the same OCR twice.
//
// THE SHAPE
//   one RECORD per file   { path, name, projectId, facets: { [kind]: FACET } }
//   one FACET per kind    { kind, at, engine, paid, stamp: { size, mtime }, data }
//
// A facet is one kind of knowledge (`AI_FACETS` is the catalogue). Adding a kind
// is an entry there (and in lib/projectIndexClient's KNOWLEDGE_KINDS) plus
// someone calling `saveAiFacet` — the Data tab lists whatever it finds, and
// `listAiData` hands it to project-wide readers.
//
// STALENESS: every facet carries the file's size + mtime at the time it was
// made. `getAiFacet(path, kind, stamp)` refuses a facet whose file has changed
// since (an edited photo, a re-saved PDF); `stampFor(path)` is that stat. A
// facet served by the project index is already tied to the file's CURRENT
// content (main keys knowledge by the content hash), so for those only the
// size is compared — modified times differ between two machines holding the
// same bytes, and refusing a colleague's reading over that would be wrong.
//
// WHERE IT LIVES: the project index (lib/projectIndexClient; the contract is
// src/projectIndex/README.md) — in the machine index and, for every kind but
// the local ones, in `.docvex/knowledge/` beside the documents, so it travels
// with the case. Reads come from the client's in-memory copy (synchronous, as
// they always were); a file nobody has hydrated yet answers from its old
// localStorage record, if one is left, while it is hydrated in the background,
// and a change event follows. Without main's side (an older preload) this is
// the per-file record store it was: one key per file — now in the ENCRYPTED
// secure store (lib/secureStore), never localStorage (V5).
import { localFolderApi } from './localFolder';
import { secureStorage, secureKeys, subscribeSecureStore } from './secureStore';
import {
  KNOWLEDGE_KINDS, peekFacets, putFacet, clearFacet, cachedEntries, subscribeIndex,
  sameSize, normPath, indexAvailable,
} from './projectIndexClient';

const PREFIX = 'docvex:ai-data:v1:';
// Exposed for older readers of the localStorage records (lib/projectDataWipe).
export const AI_DATA_PREFIX = PREFIX;
const CHANGE_EVENT = 'docvex:ai-data-changed';

// The catalogue. `paid` = making it costs AI tokens (what the cache is saving).
export const AI_FACETS = {
  // lib/textRegions — a PICTURE's text: the AI transcription merged onto the
  // local engine's positions (`data.ai` says whether the AI part was available).
  text: { label: 'Extracted text', paid: true },
  // lib/identityExtract — Claude OCR of a picture / scanned PDF, as plain text.
  // The same reading `text` merges in; for a picture the Data tab shows ONE card.
  ocr: { label: 'Extracted text', paid: true },
  // lib/identityExtract — the record details READ OUT of this file (`{ kind,
  // fields }`): what an identity record's Sources tab fills from. Kept so that
  // reading the same document into a second record, or clicking a source again,
  // is free.
  identity: { label: 'Record details', paid: true },
  // lib/dataCollections — what the Files tab's AI scan understood of this file
  // (`{ text: summary, subject, facts, entities, dates, method }`): kept so the
  // next scan, and anything else that wants to know what a file is about,
  // reuses it instead of reading the file again.
  understanding: { label: 'What the AI understood', paid: true },
  // lib/faceMatch — the faces found in a picture, each as the local model's
  // 128-number description. Biometric data: made on this computer, kept on it
  // (`local` — never written to `.docvex/`, never synced) and never sent to an
  // AI service.
  faces: { label: 'Faces', paid: false, local: !!KNOWLEDGE_KINDS.faces?.local },
};
const AI_KINDS = new Set(Object.keys(AI_FACETS));

const keyFor = (path) => `${PREFIX}${path}`;

// The old localStorage record — the whole store without the index, and the
// fallback for a file the index hasn't answered for yet (or a put it refused).
function readLegacyRecord(path) {
  if (!path) return null;
  try {
    const rec = JSON.parse(secureStorage.getItem(keyFor(path)) || 'null');
    return rec && typeof rec === 'object' && rec.facets && typeof rec.facets === 'object' ? rec : null;
  } catch { return null; }
}

// The record as the app sees it: the index's facets laid over whatever
// localStorage still holds (nothing, once the file has been migrated).
function readRecord(path) {
  if (!path) return null;
  const legacy = readLegacyRecord(path);
  const facets = peekFacets(path);
  if (facets === undefined) return legacy;
  const mine = {};
  for (const [k, f] of Object.entries(facets)) {
    if (AI_KINDS.has(k) && f && f.data != null) mine[k] = { ...f, fromIndex: true };
  }
  if (!Object.keys(mine).length) return legacy;
  return {
    path,
    name: legacy?.name || String(path).split(/[\\/]/).pop(),
    projectId: legacy?.projectId || null,
    facets: { ...(legacy?.facets || {}), ...mine },
  };
}

// The oldest records go first when storage is full: AI data can always be made
// again, a failed write of NEW data is the worse outcome.
// EXTRACTED TEXT (`text` / `ocr` — paid for, and the thing people rely on) is
// never evicted while anything else can go: other records first, oldest first,
// one at a time until the write fits; only a store holding nothing BUT
// extracted text gives up its oldest reading.
const PRECIOUS = ['text', 'ocr'];
function evictOldest(except) {
  const all = [];
  try {
    for (const k of secureKeys(PREFIX)) {
      if (k === except) continue;
      let at = 0;
      let precious = false;
      try {
        const rec = JSON.parse(secureStorage.getItem(k) || 'null');
        at = Math.max(0, ...Object.values(rec?.facets || {}).map((f) => Number(f?.at) || 0));
        precious = PRECIOUS.some((kind) => rec?.facets?.[kind]?.data != null);
      } catch { /* unreadable — oldest of all */ }
      all.push([k, at, precious]);
    }
  } catch { return false; }
  if (!all.length) return false;
  const pool = all.filter((x) => !x[2]);
  const from = pool.length ? pool : all;
  from.sort((a, b) => a[1] - b[1]);
  for (const [k] of from.slice(0, pool.length ? Math.max(1, Math.ceil(pool.length / 4)) : 1)) {
    try { secureStorage.removeItem(k); } catch { /* keep going */ }
  }
  return true;
}

function writeRecord(path, rec) {
  const key = keyFor(path);
  const value = JSON.stringify(rec);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { secureStorage.setItem(key, value); return true; } catch {
      if (!evictOldest(key)) return false;
    }
  }
  return false;
}

// Save one facet into the localStorage record (the no-index path, and the
// safety copy when main refuses a put).
function writeLegacyFacet(file, kind, facet) {
  const path = file.path;
  const rec = readLegacyRecord(path) || { path, name: '', projectId: null, facets: {} };
  rec.path = path;
  rec.name = file.name || rec.name || String(path).split(/[\\/]/).pop();
  if (file.projectId) rec.projectId = file.projectId;
  rec.facets[kind] = facet;
  return writeRecord(path, rec);
}

function announce(path) {
  try { window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { path } })); } catch { /* no window */ }
}

// The file's current { size, mtime } — what a facet is stamped with and checked
// against. null when the file can't be stat'ed (then nothing is invalidated).
export async function stampFor(path) {
  if (!path) return null;
  try {
    const st = await localFolderApi.stat(path);
    if (st && !st.error) return { size: st.sizeBytes ?? null, mtime: st.mtimeIso ?? null };
  } catch { /* fall through */ }
  return null;
}

// SIZE only, as the index does: a file's modified time moves without its
// content changing (a sync client, an antivirus, a copy, restoring from the
// Trash), and comparing it hid readings that were perfectly good — the
// "extracted text keeps disappearing" bug. A changed size is a changed file.
function stampMatches(saved, now) {
  if (!saved || !now) return true;   // only compare what both sides have
  if (saved.size != null && now.size != null && Number(saved.size) !== Number(now.size)) return false;
  return true;
}

// Callers see the facet as it was saved, without the bookkeeping flag.
function bare(facet) {
  if (!facet?.fromIndex) return facet;
  const { fromIndex, ...rest } = facet;
  return rest;
}

// The whole record of a file, or null.
export function loadAiData(path) {
  const rec = readRecord(path);
  if (!rec) return null;
  const facets = {};
  for (const [k, f] of Object.entries(rec.facets)) facets[k] = bare(f);
  return { ...rec, facets };
}

// One facet, or null. Pass the file's current stamp to have a facet made from
// an older version of the file refused.
export function getAiFacet(path, kind, stamp = null) {
  const facet = readRecord(path)?.facets?.[kind];
  if (!facet || facet.data == null) return null;
  const fits = facet.fromIndex ? sameSize(facet.stamp, stamp) : stampMatches(facet.stamp, stamp);
  return fits ? bare(facet) : null;
}

// Save (replace) one facet of a file. `file` = { path, name?, projectId? }.
export function saveAiFacet(file, kind, { data, engine = '', stamp = null } = {}) {
  const path = file?.path;
  if (!path || !kind || data == null) return false;
  const facet = {
    kind,
    at: Date.now(),
    engine,
    paid: !!AI_FACETS[kind]?.paid,
    stamp: stamp || null,
    data,
  };
  const routed = putFacet(file, kind, facet, {
    // Main refused it — keep the work the old way; the next hydration of the
    // file moves it across.
    onFail: () => { writeLegacyFacet(file, kind, facet); },
  });
  if (routed) {
    // A stale localStorage copy of the same kind must not outlive the new one.
    const legacy = readLegacyRecord(path);
    if (legacy?.facets?.[kind]) {
      delete legacy.facets[kind];
      try {
        if (Object.keys(legacy.facets).length) secureStorage.setItem(keyFor(path), JSON.stringify(legacy));
        else secureStorage.removeItem(keyFor(path));
      } catch { /* the index copy wins on read anyway */ }
    }
    announce(path);
    return true;
  }
  const ok = writeLegacyFacet(file, kind, facet);
  if (ok) announce(path);
  return ok;
}

export function clearAiFacet(path, kind) {
  let had = false;
  if (indexAvailable()) had = clearFacet(path, kind) || had;
  const rec = readLegacyRecord(path);
  if (rec?.facets?.[kind]) {
    delete rec.facets[kind];
    try {
      if (Object.keys(rec.facets).length) secureStorage.setItem(keyFor(path), JSON.stringify(rec));
      else secureStorage.removeItem(keyFor(path));
      had = true;
    } catch { /* keep what we could */ }
  }
  if (had) announce(path);
  return had;
}

// Project-wide read: every record whose file is one of `paths` (a project's
// listing) or that was saved under `projectId`. Newest first. Files the index
// hasn't answered for yet appear once they are hydrated (subscribeAiData
// fires) — hydrate the project first for a complete answer.
export function listAiData({ paths = null, projectId = null } = {}) {
  const wanted = paths ? new Set(paths.map(normPath)) : null;
  const byPath = new Map();
  const take = (rec) => {
    if (!rec) return;
    const inProject = (wanted && wanted.has(normPath(rec.path))) || (projectId && rec.projectId === projectId);
    if ((wanted || projectId) && !inProject) return;
    byPath.set(normPath(rec.path), rec);
  };
  try {
    for (const k of secureKeys(PREFIX)) {
      take(readLegacyRecord(k.slice(PREFIX.length)));
    }
  } catch { /* storage unavailable */ }
  for (const e of cachedEntries()) {
    const facets = {};
    for (const [k, f] of Object.entries(e.facets)) if (AI_KINDS.has(k) && f?.data != null) facets[k] = f;
    if (!Object.keys(facets).length) continue;
    const cur = byPath.get(normPath(e.path));
    take({
      path: cur?.path || e.path,
      name: cur?.name || String(e.path).split(/[\\/]/).pop(),
      projectId: e.projectId || cur?.projectId || null,
      facets: { ...(cur?.facets || {}), ...facets },
    });
  }
  // Asking about specific files starts hydrating the ones not known yet.
  if (paths) for (const p of paths) peekFacets(p);
  const out = [...byPath.values()];
  const newest = (rec) => Math.max(0, ...Object.values(rec.facets).map((f) => Number(f?.at) || 0));
  return out.sort((a, b) => newest(b) - newest(a));
}

// The text a facet amounts to, whatever its kind — what a reader that only
// wants words (the Advisor digest, a search) asks for.
export function facetText(facet) {
  const d = facet?.data;
  if (!d) return '';
  if (typeof d === 'string') return d;
  return String(d.text || '');
}

// Best text known for a file: the AI transcription reads better than the local
// engine, so it wins when both exist (a merged `text` facet already carries it).
export function bestTextFor(path, stamp = null) {
  return facetText(getAiFacet(path, 'ocr', stamp)) || facetText(getAiFacet(path, 'text', stamp));
}

// Whether a file has EXTRACTED TEXT — a picture's or a scan's text (`text` /
// `ocr`) — with any words in it. Cheap enough to ask for every file on show:
// the index's copy first, the old record only when the index isn't answering.
export function hasExtractedText(path) {
  if (!path) return false;
  const words = (f) => !!String(typeof f?.data === 'string' ? f.data : f?.data?.text || '').trim();
  const facets = peekFacets(path);
  if (facets && (words(facets.text) || words(facets.ocr))) return true;
  const legacy = readLegacyRecord(path);
  return !!legacy && (words(legacy.facets?.text) || words(legacy.facets?.ocr));
}

// Tell `fn(path)` whenever a file's AI data changes — in this window (custom
// event), another one (the storage event, for the localStorage records) or
// through the index (a write anywhere, a hydration landing). Returns the
// unsubscribe.
export function subscribeAiData(fn) {
  const onLocal = (e) => fn(e.detail?.path || '');
  // Another window's write (or this window's store landing at sign-in):
  // `key: null` means everything may have changed.
  const offSecure = subscribeSecureStore(({ key, source }) => {
    if (source === 'local') return;                  // this window announces its own
    if (key == null) fn('');
    else if (key.startsWith(PREFIX)) fn(key.slice(PREFIX.length));
  });
  window.addEventListener(CHANGE_EVENT, onLocal);
  const offIndex = subscribeIndex((ev) => {
    if (ev.type !== 'knowledge' || !ev.path) return;
    if (ev.kind === '*' || AI_KINDS.has(ev.kind)) fn(ev.path);
  });
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocal);
    offSecure();
    offIndex();
  };
}
