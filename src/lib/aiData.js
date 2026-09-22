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
// is an entry there plus someone calling `saveAiFacet` — the Data tab lists
// whatever it finds, and `listAiData` hands it to project-wide readers, so a new
// kind needs no new storage, no new cache key and no new UI plumbing.
//
// STALENESS: every facet carries the file's size + mtime at the time it was
// made. `getAiFacet(path, kind, stamp)` refuses a facet whose file has changed
// since (an edited photo, a re-saved PDF); `stampFor(path)` is that stat.
//
// WHERE IT LIVES: localStorage, one key per file — the same as every other
// per-file cache in the app, shared by every window (the Doc Viewer windows and
// the main app are one origin). That makes it project-wide ON THIS MACHINE.
// Callers never touch the storage, only the functions below, so the planned
// second backend — a mirror in the project folder, so the data travels with the
// case to another computer or a colleague — slots in behind them.
import { localFolderApi } from './localFolder';

const PREFIX = 'docvex:ai-data:v1:';
// Exposed for account sync (lib/projectSyncData), which carries these records.
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
};

const keyFor = (path) => `${PREFIX}${path}`;

function readRecord(path) {
  if (!path) return null;
  try {
    const rec = JSON.parse(localStorage.getItem(keyFor(path)) || 'null');
    return rec && typeof rec === 'object' && rec.facets && typeof rec.facets === 'object' ? rec : null;
  } catch { return null; }
}

// The oldest records go first when storage is full: AI data can always be made
// again, a failed write of NEW data is the worse outcome.
function evictOldest(except) {
  const all = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX) || k === except) continue;
      let at = 0;
      try {
        const rec = JSON.parse(localStorage.getItem(k) || 'null');
        at = Math.max(0, ...Object.values(rec?.facets || {}).map((f) => Number(f?.at) || 0));
      } catch { /* unreadable — oldest of all */ }
      all.push([k, at]);
    }
  } catch { return false; }
  if (!all.length) return false;
  all.sort((a, b) => a[1] - b[1]);
  for (const [k] of all.slice(0, Math.max(1, Math.ceil(all.length / 4)))) {
    try { localStorage.removeItem(k); } catch { /* keep going */ }
  }
  return true;
}

function writeRecord(path, rec) {
  const key = keyFor(path);
  const value = JSON.stringify(rec);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { localStorage.setItem(key, value); return true; } catch {
      if (!evictOldest(key)) return false;
    }
  }
  return false;
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

function stampMatches(saved, now) {
  if (!saved || !now) return true;   // only compare what both sides have
  if (saved.size != null && now.size != null && Number(saved.size) !== Number(now.size)) return false;
  if (saved.mtime != null && now.mtime != null && String(saved.mtime) !== String(now.mtime)) return false;
  return true;
}

// The whole record of a file, or null.
export function loadAiData(path) { return readRecord(path); }

// One facet, or null. Pass the file's current stamp to have a facet made from
// an older version of the file refused.
export function getAiFacet(path, kind, stamp = null) {
  const facet = readRecord(path)?.facets?.[kind];
  if (!facet || facet.data == null) return null;
  return stampMatches(facet.stamp, stamp) ? facet : null;
}

// Save (replace) one facet of a file. `file` = { path, name?, projectId? }.
export function saveAiFacet(file, kind, { data, engine = '', stamp = null } = {}) {
  const path = file?.path;
  if (!path || !kind || data == null) return false;
  const rec = readRecord(path) || { path, name: '', projectId: null, facets: {} };
  rec.path = path;
  rec.name = file.name || rec.name || String(path).split(/[\\/]/).pop();
  if (file.projectId) rec.projectId = file.projectId;
  rec.facets[kind] = {
    kind,
    at: Date.now(),
    engine,
    paid: !!AI_FACETS[kind]?.paid,
    stamp: stamp || null,
    data,
  };
  const ok = writeRecord(path, rec);
  if (ok) announce(path);
  return ok;
}

export function clearAiFacet(path, kind) {
  const rec = readRecord(path);
  if (!rec?.facets?.[kind]) return false;
  delete rec.facets[kind];
  try {
    if (Object.keys(rec.facets).length) localStorage.setItem(keyFor(path), JSON.stringify(rec));
    else localStorage.removeItem(keyFor(path));
  } catch { return false; }
  announce(path);
  return true;
}

// Project-wide read: every record whose file is one of `paths` (a project's
// listing) or that was saved under `projectId`. Newest first.
export function listAiData({ paths = null, projectId = null } = {}) {
  const wanted = paths ? new Set(paths) : null;
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      const rec = readRecord(k.slice(PREFIX.length));
      if (!rec) continue;
      const inProject = (wanted && wanted.has(rec.path)) || (projectId && rec.projectId === projectId);
      if ((wanted || projectId) && !inProject) continue;
      out.push(rec);
    }
  } catch { /* storage unavailable */ }
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

// Tell `fn(path)` whenever a file's AI data changes — in this window (custom
// event) or another one (the storage event). Returns the unsubscribe.
export function subscribeAiData(fn) {
  const onLocal = (e) => fn(e.detail?.path || '');
  const onStorage = (e) => { if (e.key && e.key.startsWith(PREFIX)) fn(e.key.slice(PREFIX.length)); };
  window.addEventListener(CHANGE_EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocal);
    window.removeEventListener('storage', onStorage);
  };
}
