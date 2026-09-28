// Data collections — what the scan makes of a WHOLE project folder.
//
// The Files tab's scan (the button beside its search) reads every tagged file
// in the project, understands each one and then connects them: files about
// the same subject (a person, a company, a property, a vehicle) become ONE
// Data collection — a `.dvc` file of its own, written into the project folder,
// listed in the Files tab and opened by the Doc Viewer.
//
// NO AI: every step runs on this computer (lib/localNetwork) — names,
// identifiers, dates and amounts are read off each file's text by the app's
// detectors, and files are linked by what they share. No model is called, no
// tokens are spent, nothing leaves the machine.
//
// HOW EACH KIND IS READ (nothing is read twice — every step reuses what is
// already saved about the file):
//   picture  → Extract text (lib/textRegions, local engine, the `text` facet)
//   audio / video → the captions ALREADY made for it (lib/captionsHistory);
//              a recording with none is skipped — transcribing is an AI service
//   anything else → its text (lib/identityExtract readSourceText: the text
//              layer, Office extraction, or local OCR for a scan)
//
// WHAT IS KEPT PER FILE: what was understood of it is saved in the file's AI
// data (lib/aiData, facet `understanding`, stamped with the file's size +
// mtime) — shown in the Doc Viewer's Data tab and reused by the next scan.
//
// THE FILE: JSON, `{ type: 'docvex/data-collection', version: 1, title,
// subject, summary, createdAt, projectId, sources: [{ name, rel, kind, method,
// role, understood }], facts: [{ label, value, sources: [rel] }], timeline:
// [{ date, event, sources: [rel] }], connections: [{ from, to, why }] }` —
// `rel` is the source's path inside the project, so a collection still finds
// its files on another machine.
import { localFolderApi, readLocalBlob } from './localFolder';
import { clearAiFacet, getAiFacet, saveAiFacet, stampFor } from './aiData';
import { extractImageText } from './textRegions';
import { readSourceText } from './identityExtract';
import { loadCaptions } from './captionsHistory';
import { notifyFilesChanged } from './platform';
import { isScanTagged } from './scanTags';
import { DEFAULT_SCAN_FEATURES } from './scanFeatures';

export { SCAN_FEATURES, DEFAULT_SCAN_FEATURES, loadScanFeatures, saveScanFeatures } from './scanFeatures';
import { SETTINGS_STORES, settingsAvailable, loadSetting, putSetting, rememberProjectDir, hydrateProject, hydratePaths } from './projectIndexClient';
import { emptyIdentity, fieldsFor, parseIdentity, relativeSourcePath } from './identities';
import { roIdToRecordFields, sameAddress, mergeAddresses } from './roIdDocuments';
import { documentAuthority } from './docAuthority';
import { analyzeLegalHistory, compactLegalHistory } from './legalHistory';

export const COLLECTION_EXT = 'dvc';
export const COLLECTION_TYPE = 'docvex/data-collection';

export function isCollectionFile(name) {
  return /\.dvc$/i.test(String(name || '').trim());
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif'];
const VIDEO_EXT = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'wma', 'weba', 'aif', 'aiff'];

const extOf = (name) => {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};

// 'image' | 'video' | 'audio' | 'collection' | 'doc'
export function scanKindOf(name, mime = '') {
  const e = extOf(name);
  const m = String(mime || '').toLowerCase();
  if (e === COLLECTION_EXT) return 'collection';
  if (m.startsWith('image/') || IMAGE_EXT.includes(e)) return 'image';
  if (m.startsWith('video/') || VIDEO_EXT.includes(e)) return 'video';
  if (m.startsWith('audio/') || AUDIO_EXT.includes(e)) return 'audio';
  return 'doc';
}

export const METHOD_LABELS = {
  'image-text': 'Extract text',
  captions: 'Captions',
  text: 'Text',
  record: 'Identity record',
};

// The path of a file inside the project, with forward slashes.
export function relInProject(projectDir, path) {
  const root = String(projectDir || '').replace(/[\\/]+$/, '');
  const p = String(path || '');
  if (root && p.toLowerCase().startsWith(root.toLowerCase())) return p.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  return p.split(/[\\/]/).pop();
}

// A source's full path, from the folder the collection sits in.
export function resolveInProject(dir, rel) {
  if (!rel) return '';
  const sep = String(dir).includes('\\') ? '\\' : '/';
  return `${String(dir).replace(/[\\/]+$/, '')}${sep}${String(rel).split('/').join(sep)}`;
}

// ── Step 1: the file's words ────────────────────────────────────────────
// → { text, method } or { error }
async function readFileForScan(file, { projectId, force }) {
  const kind = scanKindOf(file.name, file.mimeType);
  if (kind === 'image') {
    // A picture is its EXTRACTED TEXT and nothing more: the text Extract text
    // saved for it (any reading of this version of the file), else the local
    // engine's reading made now — Local mode, so no part of the picture is sent
    // to the AI to be re-read, and no AI transcription of the whole picture
    // either. From here on it is plain text, like any document. (Reading every
    // picture as a picture made the scan far too slow.)
    const res = await extractImageText({ path: file.path, name: file.name, projectId }, { mode: { result: 'local' }, reuseAny: true });
    const text = String(res?.data?.text || '').trim();
    if (text) return { text, method: 'image-text' };
    return { error: res?.error || 'no_text' };
  }
  if (kind === 'video' || kind === 'audio') {
    // The captions already made for it (the Doc Viewer's Generate captions).
    // Transcribing is an AI service, so the scan never does it itself.
    const cap = loadCaptions(file.path);
    const text = String(cap?.text || '').trim();
    return text ? { text, method: 'captions' } : { error: 'no_captions' };
  }
  const blob = await readLocalBlob(file.path);
  const r = await readSourceText(blob, file.name, { path: file.path, projectId, force, cloudOcr: false });
  if (r?.text) return { text: r.text, method: 'text' };
  return { error: r?.error || 'no_text' };
}

const cleanList = (v) => (Array.isArray(v) ? v : []);
const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max);

// ── Step 2 + the REDUCE step: understanding and links, WITHOUT AI ─────
// Each file is understood on this computer from its own text, and the files
// are cross-referenced by what they share — lib/localNetwork. No model, no
// tokens, nothing leaves the machine.
export const LINK_TYPES = {
  amends: 'Amends',
  supersedes: 'Supersedes',
  contradicts: 'Contradicts',
  same_party: 'Same party',
  same_subject: 'Same subject',
  dependency: 'Depends on',
  financial_link: 'Financial link',
  evidence_for: 'Evidence for',
  references: 'References',
  chronological: 'Next step',
};

const loadLocalNetwork = () => import('./localNetwork');

// -> { graph: { links, timeline, facts }, groups (for the web), calls, errors }
async function crossReference(entries, say) {
  say({ stage: 'links', index: 0, total: 1, overall: 0.8, step: 'Cross-referencing the files', fileFrac: 0 });
  const { crossReferenceLocally } = await loadLocalNetwork();
  const graph = crossReferenceLocally(entries);
  graph.links = graph.links.filter((l) => LINK_TYPES[l.type]);
  say({ stage: 'links', index: 1, total: 1, overall: 0.95, step: 'Cross-referenced the files', fileFrac: 1 });
  const groups = { local: { ...graph, files: entries.map((e) => ({ rel: e.rel, stamp: `${e.stamp?.size ?? ''}|${e.stamp?.mtime ?? ''}` })) } };
  return { graph, groups, calls: 0, errors: [] };
}

// ── The web of information ──────────────────────────────────────────────
// What the scan knows is kept with the project, in its settings store `web`
// (`.docvex/settings/web.json`, lib/projectIndexClient — it travels with the
// folder and with account sync). It used to be a hidden `.docvex-web.json`
// beside the files plus a localStorage copy; both are read ONCE when the store
// has nothing, moved into it, and removed:
//   files:       { [rel]: { size, mtime, method, understanding } } — every file
//                scanned and what the AI understood of it
//   collections: [{ file, title }] — the `.dvc` files the scan wrote
// That index is what makes a SECOND run cheap:
//   • nothing added, changed or removed → no AI call at all
//   • files removed → handled locally (dropped from the collections)
//   • files added or changed → ONLY those are read and understood, and the AI is
//     shown just them plus a one-line card per existing collection, and says
//     which collections they join and which new ones they start; the answer is
//     merged into the `.dvc` files here.
// The WEB itself — which collections are related and why — is worked out
// locally, for free: two collections are linked when they share a source file
// or name the same person / company / place (`entities`, from the per-file
// understandings, names folded so "SC Alfa SRL" and "ALFA S.R.L." meet).
const WEB_FILE = '.docvex-web.json';
const WEB_LS = 'docvex:data-web:v1:';

const shapeWeb = (web) => (web && typeof web === 'object' && web.files
  ? { version: 1, files: web.files || {}, collections: cleanList(web.collections), graph: web.graph && typeof web.graph === 'object' ? web.graph : null }
  : null);

async function readWeb(projectDir, projectId) {
  if (projectId && settingsAvailable()) {
    rememberProjectDir(projectId, projectDir);
    const stored = await loadSetting(projectId, SETTINGS_STORES.web);
    if (stored !== undefined) {
      if (stored) return shapeWeb(stored);
      // Nothing in the store yet: the old homes, once.
      const legacy = await readLegacyWeb(projectDir);
      if (legacy && await putSetting(projectId, SETTINGS_STORES.web, { ...legacy, updatedAt: Date.now() })) {
        try { localStorage.removeItem(WEB_LS + projectDir); } catch { /* harmless leftover */ }
        try { await localFolderApi.deleteFiles({ dir: projectDir, paths: [resolveInProject(projectDir, WEB_FILE)] }); } catch { /* harmless leftover */ }
      }
      return legacy;
    }
  }
  return readLegacyWeb(projectDir);
}

async function readLegacyWeb(projectDir) {
  let web = null;
  try {
    // Asked for only when it exists — before the first scan there is none, and
    // reading it anyway put a 404 in the console on every first run.
    const path = resolveInProject(projectDir, WEB_FILE);
    const st = await localFolderApi.stat(path);
    if (st && !st.error) web = JSON.parse(await (await readLocalBlob(path)).text());
  } catch { /* none yet — try the machine's copy */ }
  if (!web) {
    try { web = JSON.parse(localStorage.getItem(WEB_LS + projectDir) || 'null'); } catch { web = null; }
  }
  return shapeWeb(web);
}

async function writeWeb(projectDir, web, projectId) {
  const value = { ...web, updatedAt: Date.now() };
  if (projectId && settingsAvailable() && await putSetting(projectId, SETTINGS_STORES.web, value)) return;
  // No store (or it refused): the old homes, so the next run is still cheap.
  const text = JSON.stringify(value);
  try { localStorage.setItem(WEB_LS + projectDir, text); } catch { /* full — the file is what counts */ }
  try {
    await localFolderApi.writeFiles({ dir: projectDir, files: [{ filename: WEB_FILE, blob: new Blob([text], { type: 'application/json' }) }] });
  } catch { /* the machine's copy stands */ }
}

// A name as it can be compared: no diacritics, no case, no punctuation, no
// legal form ("SC … SRL"), no titles.
const STOP = new Set(['sc', 'srl', 'sa', 'sca', 'snc', 'pfa', 'ii', 'if', 'ong', 'sl', 'd', 'dl', 'dna', 'dra', 'domnul', 'doamna', 'the', 'ltd', 'llc', 'inc', 'gmbh']);
export function foldName(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/s\.\s*r\.\s*l\.?|s\.\s*a\.(?=\s|$)|s\.\s*c\.(?=\s|$)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !STOP.has(w)).sort().join(' ');
}

// The collection's entities, each with the files that name it.
function entitiesOf(sources, understandingOf) {
  const by = new Map();
  for (const s of sources) {
    for (const name of understandingOf(s.rel)?.entities || []) {
      const key = foldName(name);
      if (key.length < 3) continue;
      const cur = by.get(key) || { name, sources: [] };
      if (!cur.sources.includes(s.rel)) cur.sources.push(s.rel);
      by.set(key, cur);
    }
  }
  return [...by.values()].sort((a, b) => b.sources.length - a.sources.length).slice(0, 60);
}

// Links between collections — shared files and shared names. Local, no AI.
function relateCollections(cols) {
  for (const c of cols) {
    c._files = new Set(c.sources.map((s) => s.rel));
    c._names = new Map(c.entities.map((e) => [foldName(e.name), e.name]));
  }
  for (const c of cols) {
    const related = [];
    for (const o of cols) {
      if (o === c) continue;
      const files = [...c._files].filter((r) => o._files.has(r));
      const names = [...c._names.keys()].filter((k) => o._names.has(k)).map((k) => c._names.get(k));
      if (!files.length && !names.length) continue;
      related.push({ file: o.filename, title: o.title, files: files.slice(0, 8), names: names.slice(0, 8), weight: files.length * 2 + names.length });
    }
    c.related = related.sort((a, b) => b.weight - a.weight).slice(0, 12).map(({ weight, ...r }) => r);
  }
  for (const c of cols) { delete c._files; delete c._names; }
}

const sourceOf = (e, role) => ({
  name: e.file.name, rel: e.rel, kind: scanKindOf(e.file.name, e.file.mimeType), method: e.method,
  role: str(role, 400), understood: e.understanding.text,
});

// Fill a collection's record from what the AI read (`{ kind, fields }`). Only
// empty fields are filled — a value the user typed, or an earlier reading, is
// never replaced — and only the record's own keys are taken. A person or
// company collection without a record gets one.
// `from` = { authority, rel } — the document a reading comes from. A field
// is filled when empty; one filled from a LESS official document is
// REPLACED by a more official one (an identity card's CNP over a contract's);
// `recordSources` on the collection remembers where each field came from.
// Readings with no known source (the AI's merged answer) count as 2.
function fillRecord(c, rec, from = {}) {
  if (!rec || typeof rec !== 'object') return;
  const kind = c.record?.kind || (rec.kind === 'org' || c.subject === 'company' ? 'org' : 'person');
  if (!c.record && !['person', 'company'].includes(c.subject) && !['person', 'org'].includes(rec.kind)) return;
  const allowed = new Set(fieldsFor(kind).map((f) => f.key));
  const base = c.record ? { ...c.record } : { ...emptyIdentity(kind), name: c.title };
  let filled = false;
  const authority = Number(from.authority) || 2;
  const sources = { ...(c.recordSources || {}) };
  const had = (k) => Number(sources[k]?.authority) || (String(base[k] ?? '').trim() ? 3 : 0);
  for (const [k, v] of Object.entries(rec.fields || {})) {
    if (!allowed.has(k) || typeof v !== 'string' || !v.trim()) continue;
    // The same address written another way makes the one kept fuller — the
    // more official spelling winning where the two really disagree.
    if (k === 'address' && String(base.address ?? '').trim() && sameAddress(base.address, v)) {
      const merged = mergeAddresses([{ value: base.address, authority: had(k) }, { value: v, authority }]);
      if (merged && merged !== base.address) { base.address = merged; filled = true; }
      if (authority > had(k)) sources[k] = { authority, rel: from.rel || null };
      continue;
    }
    if (String(base[k] ?? '').trim() && authority <= had(k)) continue;
    if (String(base[k] ?? '').trim() === v.trim()) { if (authority > had(k)) sources[k] = { authority, rel: from.rel || null }; continue; }
    base[k] = v.trim();
    sources[k] = { authority, rel: from.rel || null };
    filled = true;
  }
  c.recordSources = sources;
  if (!filled) return;
  const parsed = parseIdentity(JSON.stringify(base));
  if (!parsed) return;
  if (!String(parsed.name || '').trim()) parsed.name = parsed.legalName || c.title;
  c.record = parsed;
}

// A file that changed or went: everything it contributed is taken out, so a
// changed file can be fitted back in as it is now.
function withoutFiles(c, gone) {
  const keep = (list) => cleanList(list).filter((x) => !gone.has(x));
  return {
    ...c,
    // The documents a record was filled from stay, whatever the scan does.
    sources: c.sources.filter((s) => s.method === 'record' || !gone.has(s.rel)),
    // Dropped only when every file it came from is gone.
    facts: c.facts.filter((f) => !f.sources.length || keep(f.sources).length).map((f) => ({ ...f, sources: keep(f.sources) })),
    timeline: c.timeline.filter((t) => !t.sources.length || keep(t.sources).length).map((t) => ({ ...t, sources: keep(t.sources) })),
    connections: c.connections.filter((k) => !gone.has(k.from) && !gone.has(k.to)),
  };
}

// ── Faces ───────────────────────────────────────────────────────────────
// Identity documents = pictures the AI said are one (`idDocument`), or whose
// reading names one. Only pictures carry a face this can read.
const ID_WORDS = /carte de identitate|cartea de identitate|buletin|pa[sș]aport|passport|permis de (conducere|[sș]edere)|identity card|romania\s*roumanie/i;
async function faceStage(entries, { projectId, onProgress, isCancelled }) {
  const pictures = entries.filter((e) => scanKindOf(e.file.name, e.file.mimeType) === 'image');
  const documents = pictures
    .filter((e) => e.understanding.idDocument || (e.method === 'image-text' && ID_WORDS.test(`${e.understanding.subject} ${e.understanding.text}`)))
    .map((e) => ({ path: e.file.path, name: e.file.name, rel: e.rel, holder: e.understanding.idDocument?.holder || e.understanding.subject || e.file.name }));
  if (!documents.length) return { references: [], matches: [], errors: [] };
  try {
    const { matchFaces } = await import('./faceMatch');
    return await matchFaces(documents, pictures.map((e) => ({ path: e.file.path, name: e.file.name, rel: e.rel })), { projectId, onProgress, isCancelled });
  } catch (err) {
    return { references: [], matches: [], errors: [{ name: '', error: err?.message || 'The face model couldn\u2019t start.' }] };
  }
}

// Put the matches into the collections: every document's holder has a
// collection (the one holding the document, else one naming the holder, else a
// new one made here without the AI), and each picture showing the same face
// joins it as a source, with the score. Face-made sources are taken out and
// put back every run, so a match that no longer holds goes.
const REF_ROLE = 'The identity document \u2014 the reference photo.';
function applyFaces(cols, created, faces, byRel) {
  for (const c of [...cols, ...created]) {
    c.sources = c.sources.filter((s) => s.method !== 'face');
    c.connections = c.connections.filter((k) => !k.face);
    delete c.faceMatches;
    delete c.faceReference;
  }
  if (!faces.references.length) return;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const all = () => [...cols, ...created];
  for (const ref of faces.references) {
    const mine = faces.matches.filter((m) => m.idRel === ref.rel);
    let home = all().find((c) => c.sources.some((s) => s.rel === ref.rel))
      || all().find((c) => c.record && foldName(c.record.name || c.record.legalName) === foldName(ref.holder))
      || all().find((c) => (c.entities || []).some((e) => foldName(e.name) === foldName(ref.holder)));
    const idEntry = byRel.get(ref.rel);
    if (!home) {
      if (!mine.length || !idEntry) continue;
      home = {
        title: ref.holder, subject: 'person',
        summary: `${ref.holder}: the identity document \u201c${idEntry.file.name}\u201d and the pictures in which the same face appears (matched on this computer).`,
        sources: [sourceOf(idEntry, REF_ROLE)],
        facts: [], timeline: [], connections: [],
      };
      created.push(home);
    }
    if (idEntry && !home.sources.some((s) => s.rel === ref.rel)) home.sources.push(sourceOf(idEntry, REF_ROLE));
    // The document's face is kept too, to be shown beside each match.
    home.faceReference = [...(home.faceReference || []), { rel: ref.rel, holder: ref.holder, box: ref.box }];
    home.faceMatches = [...(home.faceMatches || []), ...mine.map((m) => ({
      kind: m.kind, idRel: m.idRel, holder: m.holder, rel: m.rel, box: m.box, idBox: m.idBox, confidence: m.confidence,
    }))];
    for (const m of mine) {
      const e = byRel.get(m.rel);
      if (!e || home.sources.some((s) => s.rel === m.rel)) continue;
      home.sources.push({
        ...sourceOf(e, m.kind === 'document'
          ? `Another identity document with the same face \u2014 ${pct(m.confidence)} face match.`
          : `Shows ${m.holder} \u2014 ${pct(m.confidence)} face match with \u201c${byRel.get(m.idRel)?.file.name || m.idRel}\u201d.`),
        method: 'face',
        confidence: m.confidence,
      });
    }
    home.connections.push(...mine.map((m) => ({ from: ref.rel, to: m.rel, why: `Same face as the identity document\u2019s photo (${pct(m.confidence)} confidence, compared on this computer).`, face: true })));
  }
}

const safeName = (title) => String(title || 'Data collection')
  .replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').replace(/\.+$/, '').trim().slice(0, 90) || 'Data collection';

// ── What the scan does (the scan button's card, FilesWorkspace) ─────────
const featureOfKind = (kind) => (kind === 'image' ? 'pictures' : kind === 'video' || kind === 'audio' ? 'recordings' : 'documents');

// NOTHING MAY HOLD THE SCAN: every file's reading runs
// against a time limit and against Stop. A file that runs out of time is
// skipped (not remembered — the next scan tries it again) and the scan goes
// on; Stop takes effect at once, not after the file in hand.
const READ_LIMIT_MS = { image: 120000, doc: 180000, video: 600000, audio: 600000 };
function raceScan(promise, ms, stop) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); clearInterval(poll); fn(v); };
    const timer = setTimeout(() => finish(resolve, { timedOut: true }), ms);
    const poll = setInterval(() => { if (stop()) finish(resolve, { cancelled: true }); }, 250);
    Promise.resolve(promise).then((value) => finish(resolve, { value }), (err) => finish(reject, err));
  });
}
const NOT_REMEMBERED = new Set(['ai_failed', 'timed_out']);
const COLLECTION_CACHE = new Map();   // path -> { stamp: 'size|mtime', value: parsed collection }

// ── The KNOWLEDGE GRAPH (the Files tab's Graph view, components/FileGraph) ──
// Every file the scan has read as a node, every typed link it found as an
// edge — read back from the web index (each cross-referenced group keeps its
// links there), in the shape the graph takes:
// { files: [{ id, name, type, path }], connections: [{ from_file_id,
//   to_file_id, connection_type, explanation, evidence, confidence }] }
// `id` is the file's path inside the project. Collections written by a scan
// made before the web kept its groups give their links instead.
const GRAPH_TYPE = { image: 'image', video: 'video', audio: 'audio', collection: 'collection', doc: 'document' };
export async function loadScanGraph(projectDir, { projectId } = {}) {
  if (!projectDir) return { files: [], connections: [] };
  const web = await readWeb(projectDir, projectId);
  const seen = new Set();
  const connections = [];
  const add = (l) => {
    if (!l?.from || !l?.to || l.from === l.to) return;
    const sym = ['contradicts', 'same_party', 'same_subject'].includes(l.type);
    const key = `${sym ? [l.from, l.to].sort().join('|') : `${l.from}>${l.to}`}|${l.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    connections.push({
      from_file_id: l.from, to_file_id: l.to, connection_type: l.type,
      explanation: l.why || '', evidence: Array.isArray(l.evidence) ? l.evidence : [], confidence: Number(l.confidence) || 0,
    });
  };
  for (const g of Object.values(web?.graph?.groups || {})) (g?.links || []).forEach(add);
  if (!connections.length) {
    try {
      const listing = await localFolderApi.listAll(projectDir);
      for (const f of (listing?.files || []).filter((x) => x?.path && scanKindOf(x.name) === 'collection')) {
        try { (parseCollection(await (await readLocalBlob(f.path)).text())?.links || []).forEach(add); } catch { /* unreadable */ }
      }
    } catch { /* no listing — no links */ }
  }
  const files = new Map();
  const node = (rel) => {
    if (!rel || files.has(rel)) return;
    const name = String(rel).split('/').pop();
    files.set(rel, { id: rel, name, type: GRAPH_TYPE[scanKindOf(name)] || 'document', path: resolveInProject(projectDir, rel) });
  };
  for (const [rel, f] of Object.entries(web?.files || {})) if (!f?.skipped) node(rel);
  connections.forEach((c) => { node(c.from_file_id); node(c.to_file_id); });
  connections.sort((a, b) => b.confidence - a.confidence);
  return { files: [...files.values()], connections };
}

// The web index as the scan left it — every file read (with what the AI
// understood of it), the collections, the project-wide graph. For the Files
// tab's Insights (lib/caseInsights), which reads it and never writes it.
export async function loadScanIndex(projectDir, { projectId } = {}) {
  if (!projectDir) return null;
  if (projectId) await hydrateProject(projectId, { dir: projectDir }).catch(() => {});
  return readWeb(projectDir, projectId);
}

// ── Erase the scan's memory ─────────────────────────────────────────────
// The Data collections (to the Trash), the links and the web index, and what
// the AI UNDERSTOOD of each file — so the next scan connects everything
// afresh. What was READ out of the files (a picture's extracted text, a
// recording's captions, a scan's transcription) is kept: the next scan reads
// nothing again, it only asks the AI again.
export async function eraseScanMemory(projectDir, { projectId } = {}) {
  if (!projectDir) return { error: 'no_folder' };
  const listing = await localFolderApi.listAll(projectDir);
  if (listing?.error) return { error: listing.error };
  const all = (listing.files || []).filter((f) => f?.path);
  let collections = 0;
  for (const f of all.filter((x) => scanKindOf(x.name) === 'collection')) {
    try {
      const res = await localFolderApi.trashFile({ dir: projectDir, path: f.path });
      if (!res?.error) collections += 1;
    } catch { /* left where it is */ }
  }
  if (projectId) await hydrateProject(projectId, { dir: projectDir }).catch(() => {});
  let understood = 0;
  for (const f of all) {
    try { if (getAiFacet(f.path, 'understanding')) { clearAiFacet(f.path, 'understanding'); understood += 1; } } catch { /* next one */ }
  }
  // The web index, in every home it has had.
  const empty = { version: 1, files: {}, collections: [], graph: null, updatedAt: Date.now() };
  if (projectId && settingsAvailable()) await putSetting(projectId, SETTINGS_STORES.web, empty).catch(() => {});
  try { localStorage.removeItem(WEB_LS + projectDir); } catch { /* harmless */ }
  try {
    const st = await localFolderApi.stat(resolveInProject(projectDir, WEB_FILE));
    if (st && !st.error) await localFolderApi.deleteFiles({ dir: projectDir, paths: [resolveInProject(projectDir, WEB_FILE)] });
  } catch { /* harmless leftover */ }
  notifyFilesChanged();
  return { collections, understood };
}

// ── The scan ────────────────────────────────────────────────────────────
// `onProgress({ stage, index, total, name })` — stage: list | read | understand | connect | save.
// `force` starts the web over (every file read and understood again).
// → { collections, created, updated, removed, read, added, upToDate, skipped } or { error }
// `tags` (lib/scanTags) — the files tagged for the scan: only those are read,
// and a file untagged since the last scan leaves the collections as if removed.
// `only` (a Set of paths inside the project) - the LIVE network's pass
// (lib/liveNetwork): of the files not yet known to the web, only these are
// read; files the web knows are still checked, so edits and removals count.
export async function scanProjectFiles(projectDir, { projectId, projectName, force = false, onProgress, isCancelled, tags = null, only = null, features: askedFeatures = null } = {}) {
  const features = { ...DEFAULT_SCAN_FEATURES, ...(askedFeatures || {}) };
  if (!projectDir) return { error: 'no_folder' };
  const say = (p) => { try { onProgress?.(p); } catch { /* ignore */ } };
  const stop = () => !!isCancelled?.();
  say({ stage: 'list', overall: 0.01, step: 'Listing the files', fileFrac: 0 });
  const listing = await localFolderApi.listAll(projectDir);
  if (listing?.error) return { error: listing.error };
  const web = force ? null : await readWeb(projectDir, projectId);
  const known = web?.files || {};
  const files = (listing.files || []).filter((f) => {
    if (!f?.path || scanKindOf(f.name, f.mimeType) === 'collection') return false;
    const rel = relInProject(projectDir, f.path);
    if (tags && !isScanTagged(tags, rel)) return false;
    return !only || !!known[rel] || only.has(rel);
  });
  if (!files.length) return { error: tags ? 'none_tagged' : 'empty' };

  // FAST PATH: every listed file is known to the web with the same stamp and
  // no known file has gone - nothing to read, connect or cross-reference, and
  // no collection to read back (the live network runs this after changes in
  // the folder, most of which don't touch the scanned files).
  if (web && !force && !features.faces && (web.graph || !features.links)) {
    const rels = new Set(files.map((f) => relInProject(projectDir, f.path)));
    const unchanged = files.every((f) => {
      const k = known[relInProject(projectDir, f.path)];
      return k && k.size === (f.sizeBytes ?? null) && k.mtime === (f.mtimeIso ?? null);
    });
    if (unchanged && Object.keys(known).every((rel) => rels.has(rel))) {
      return {
        collections: cleanList(web.collections).map((c) => ({ title: c.title, filename: c.file, path: resolveInProject(projectDir, c.file) })),
        created: 0, updated: 0, removed: 0, read: 0, added: 0, upToDate: true, faceMatches: 0, faceErrors: [], links: null, linkCalls: 0, linkErrors: [], skipped: [],
      };
    }
  }

  // What was saved about each file is read synchronously below, from the
  // index's copy - which knows the project's files once it has been hydrated.
  if (projectId) await hydrateProject(projectId, { dir: projectDir }).catch(() => {});
  else await hydratePaths(files.map((f) => f.path)).catch(() => {});

  // 1 + 2. What each file is — from the web, from the file's AI data, or read
  // and understood now. Only the last costs anything.
  const entries = [];
  const fresh = [];          // entries whose file is new or changed since the web was made
  const skipped = [];
  const listed = new Set();
  // Files are understood a BATCH at a time as they are read (≤8 files), and
  // each one's understanding is saved at once — so a scan that is stopped, or
  // a window that is closed, keeps what it has done and the next scan picks up
  // from there.
  let batch = []; let batchSize = 0; let understood = 0;
  // PROGRESS for the scan button's gauges (FilesWorkspace ScanGauges): every
  // event carries `overall` (0…1, the whole scan — reading and understanding
  // the files is 2–70%, connecting 72%, cross-referencing 78–95%, writing 97%)
  // and, while files are read, the FILE being worked on: its `step` in words and
  // `fileFrac` (0…1 through its own steps: opening → extracting / transcribing /
  // reading → read, waiting to be understood → understood).
  let at = 0;
  const overallAt = (n, frac) => 0.02 + 0.68 * Math.min(1, (n + frac) / Math.max(1, files.length));
  let fileAt = Date.now();   // when the file in hand was started (the gauge counts from it)
  const held = [];          // files of a kind switched off — left as they are
  const sayFile = (n, file, step, fileFrac, extra = {}) => say({
    stage: 'read', index: n, total: files.length, name: file.name, step, fileFrac, fileAt,
    overall: overallAt(n, fileFrac), done: n + (fileFrac >= 1 ? 1 : 0), skipped: skipped.length, understood, ...extra,
  });
  const flush = async () => {
    if (!batch.length) return;
    const list = batch; batch = []; batchSize = 0;
    say({ stage: 'understand', index: understood, total: understood + list.length, name: list.length > 1 ? `${list.length} files` : list[0].file.name, step: `Understanding ${list.length} file${list.length === 1 ? '' : 's'}`, fileFrac: 0.8, overall: overallAt(at, 0.8), done: at, skipped: skipped.length, understood });
    const { understandLocally } = await loadLocalNetwork();
    for (const b of list) {
      let u;
      try { u = understandLocally(b.text, { name: b.file.name, method: b.method }); } catch (err) {
        skipped.push({ name: b.file.name, rel: b.rel, stamp: b.stamp, error: err?.message || 'unreadable' });
        continue;
      }
      const data = { ...u, method: b.method, ...(b.legal ? { legalHistory: b.legal } : {}) };
      // Kept in the file's AI data — the Data tab shows it, the next scan reuses it.
      saveAiFacet({ path: b.file.path, name: b.file.name, projectId }, 'understanding', { data, engine: 'docvex-local', stamp: b.stamp });
      const e = { file: b.file, rel: b.rel, stamp: b.stamp, method: b.method, understanding: normalizeUnderstanding(data) };
      entries.push(e); fresh.push(e);
    }
    understood += list.length;
    say({ stage: 'understand', index: understood, total: understood, name: list.length > 1 ? `${list.length} files` : list[0].file.name, step: 'Understood', fileFrac: 1, overall: overallAt(at, 1), done: at, skipped: skipped.length, understood });
  };
  let readCount = 0;
  for (let n = 0; n < files.length; n += 1) {
    if (stop()) return { error: 'cancelled' };
    at = n;
    const file = files[n];
    const rel = relInProject(projectDir, file.path);
    listed.add(rel);
    const stamp = { size: file.sizeBytes ?? null, mtime: file.mtimeIso ?? null };
    const prev = known[rel];
    const same = prev && prev.size === stamp.size && prev.mtime === stamp.mtime;
    if (same && prev.understanding?.text) {
      const u = normalizeUnderstanding(prev.understanding);
      entries.push({ file, rel, stamp, method: prev.method || 'text', understanding: u });
      // Another machine: the file's AI data is filled from the web, for free.
      if (!getAiFacet(file.path, 'understanding')) saveAiFacet({ path: file.path, name: file.name, projectId }, 'understanding', { data: { ...u, method: prev.method || 'text' }, engine: 'docvex-local', stamp });
      sayFile(n, file, 'Already known — unchanged', 1, { quiet: true });
      continue;
    }
    if (same && prev.skipped) { skipped.push({ name: file.name, error: prev.skipped, earlier: true }); sayFile(n, file, 'Skipped earlier — unchanged', 1, { quiet: true }); continue; }
    const saved = force ? null : getAiFacet(file.path, 'understanding', stamp);
    if (saved?.data?.text) {
      const e = { file, rel, stamp, method: saved.data.method || 'text', understanding: normalizeUnderstanding(saved.data) };
      entries.push(e); fresh.push(e);
      sayFile(n, file, 'Already understood', 1, { quiet: true });
      continue;
    }
    const kind = scanKindOf(file.name, file.mimeType);
    if (!features[featureOfKind(kind)]) { held.push(rel); sayFile(n, file, 'Left out \u2014 switched off', 1, { quiet: true }); continue; }
    fileAt = Date.now();
    sayFile(n, file, kind === 'image' ? 'Extracting its text' : kind === 'video' || kind === 'audio' ? 'Reading its captions' : 'Reading its text', 0.15);
    // Let the window breathe between files (paint the progress, answer clicks):
    // reading one is a chain of work that otherwise never gives the thread back.
    await new Promise((r) => { setTimeout(r, 0); });
    try {
      const race = await raceScan(readFileForScan(file, { projectId, force }), READ_LIMIT_MS[kind] || 180000, stop);
      // eslint-disable-next-line no-console
      console.info(`[scan] ${file.name} (${kind}): ${Date.now() - fileAt} ms${race.timedOut ? ' \u2014 timed out' : race.cancelled ? ' \u2014 stopped' : race.value?.error ? ` \u2014 ${race.value.error}` : ''}`);
      if (race.cancelled) return { error: 'cancelled' };
      if (race.timedOut) { skipped.push({ name: file.name, rel, stamp, error: 'timed_out' }); sayFile(n, file, 'Skipped \u2014 took too long', 1); continue; }
      const res = race.value;
      if (res.error) { skipped.push({ name: file.name, rel, stamp, error: res.error }); sayFile(n, file, 'Skipped — nothing to read', 1); continue; }
      readCount += 1;
      sayFile(n, file, `Read — ${res.text.length.toLocaleString()} characters, waiting to be understood`, 0.6, { chars: res.text.length });
      // Read in its legal era (lib/legalHistory, local): a historical
      // document keeps its era, the decrees it cites and its land measures.
      let legal = null;
      try { legal = compactLegalHistory(analyzeLegalHistory(res.text)); } catch { /* read as it is */ }
      if (batch.length && (batch.length >= 8 || batchSize + res.text.length > 200000)) await flush();
      batch.push({ file, rel, stamp, method: res.method, text: res.text, legal }); batchSize += res.text.length;
    } catch (err) {
      const why = err?.message || 'unreadable';
      skipped.push({ name: file.name, rel, stamp, error: why });
      sayFile(n, file, 'Skipped — couldn\u2019t be read', 1);
    }
  }
  await flush();
  if (!entries.length) return { error: 'nothing_read', skipped };


  const byRel = new Map(entries.map((e) => [e.rel, e]));
  const removed = Object.keys(known).filter((rel) => !listed.has(rel));
  const changed = new Set([...fresh.map((e) => e.rel), ...removed]);

  // Every collection in the project, read back from its file. `filename` is
  // its path inside the project.
  let cols = [];
  // Read through a cache keyed by each file's size + modified time: the live
  // network runs often and most collections haven't changed since the last
  // pass. A copy is handed out - the scan changes the objects it gets.
  for (const f of (listing.files || []).filter((x) => x?.path && scanKindOf(x.name) === 'collection')) {
    try {
      const stamp = `${f.sizeBytes ?? ''}|${f.mtimeIso ?? ''}`;
      let doc = COLLECTION_CACHE.get(f.path);
      if (!doc || doc.stamp !== stamp) {
        doc = { stamp, value: parseCollection(await (await readLocalBlob(f.path)).text()) };
        COLLECTION_CACHE.set(f.path, doc);
        if (COLLECTION_CACHE.size > 800) COLLECTION_CACHE.delete(COLLECTION_CACHE.keys().next().value);
      }
      if (doc.value) cols.push({ ...structuredClone(doc.value), filename: relInProject(projectDir, f.path), raw: null });
    } catch { /* unreadable - left alone */ }
  }
  const firstRun = !cols.length;
  const upToDate = !firstRun && !changed.size;

  let created = [];
  let touched = new Set();
  // What each collection said before, to write only the ones that change.
  const signature = (c) => JSON.stringify({ t: c.title, s: c.summary, so: c.sources, f: c.facts, ti: c.timeline, co: c.connections, l: c.links || [], e: c.entities, r: c.related, fm: c.faceMatches || [], fr: c.faceReference || [], rc: c.record || null });
  const before = new Map(cols.map((c) => [c.filename, signature(c)]));
  if (!upToDate) {
    if (stop()) return { error: 'cancelled' };
    // Grouped on this computer (lib/localNetwork): one collection per person,
    // company, property or vehicle the files name.
    const { connectLocally } = await loadLocalNetwork();
    if (!firstRun) cols = cols.map((c) => withoutFiles(c, changed));
    const incoming = firstRun ? entries : fresh.filter((e) => byRel.has(e.rel));
    if (incoming.length) {
      say({ stage: 'connect', total: incoming.length, incremental: !firstRun, overall: 0.72, step: firstRun ? 'Grouping the files into collections' : 'Fitting the new files into the collections', fileFrac: 0 });
      ({ touched, created } = connectLocally(incoming, cols, { allEntries: entries, sourceOf }));
      for (const c of [...touched, ...created]) fillRecord(c, c.recordIn);
      say({ stage: 'connect', total: incoming.length, incremental: !firstRun, overall: 0.77, step: `Grouped ${incoming.length} file${incoming.length === 1 ? '' : 's'} into collections`, fileFrac: 1 });
    }
  }

  // 3c. Faces — the identity documents' photos against the pictures. Local:
  // no tokens, no face leaves the computer (lib/faceMatch). Redone every run
  // from the saved face descriptions, so a new picture is matched at once.
  // NOT RUN BY THE SCAN any more (at the user's request): the scan treats a
  // picture as its extracted text only and never looks at it as a picture —
  // comparing faces meant decoding and analysing every picture in the project.
  // What earlier scans found stays in the collections (applyFaces isn't called,
  // so nothing is cleared). `faceStage` / `applyFaces` are kept for a separate
  // action.
  let faces = { references: [], matches: [], errors: [] };
  if (stop()) return { error: 'cancelled' };
  // …unless FACIAL RECOGNITION is switched on in the scan's card.
  if (features.faces) {
    say({ stage: 'faces', overall: 0.74, step: 'Comparing faces with the identity documents', fileFrac: 0 });
    faces = await faceStage(entries, {
      projectId,
      isCancelled: stop,
      onProgress: (p) => say({ stage: 'faces', ...p, overall: 0.74 + 0.03 * ((p.index || 0) / Math.max(1, p.total || 1)), step: p.total ? `Comparing faces \u2014 ${Math.min((p.index || 0) + 1, p.total)} of ${p.total}` : 'Comparing faces', fileFrac: (p.index || 0) / Math.max(1, p.total || 1) }),
    });
    if (stop()) return { error: 'cancelled' };
    applyFaces(cols, created, faces, byRel);
  }

  // 4. The web: names per collection, links between collections — all local.
  const understandingOf = (rel) => byRel.get(rel)?.understanding;
  // A collection holding a record is kept even with no source left: the
  // record is the user's (typed, converted, filled) and autofill reads it.
  const keptCols = cols.filter((c) => c.sources.length || c.record);
  const emptied = cols.filter((c) => !c.sources.length && !c.record);
  const used = new Set(cols.map((c) => c.filename.toLowerCase()));
  for (const c of created) {
    let base = safeName(c.title);
    for (let k = 2; used.has(`${base}.${COLLECTION_EXT}`.toLowerCase()); k += 1) base = `${safeName(c.title)} ${k}`;
    c.filename = `${base}.${COLLECTION_EXT}`;
    used.add(c.filename.toLowerCase());
  }
  const all = [...keptCols, ...created];
  // A person's collection holding their identity document takes the
  // document's checked reading into its record (empty fields only).
  for (const c of all) {
    if (c.subject === 'company' || c.record?.kind === 'org') continue;
    for (const s of c.sources) {
      const roId = byRel.get(s.rel)?.understanding?.roId;
      if (roId && (roId.cnp || roId.last_name)) {
        const e = byRel.get(s.rel);
        fillRecord(c, { kind: 'person', fields: roIdToRecordFields(roId) }, { authority: documentAuthority({ name: e?.file?.name || s.name, u: e?.understanding }).score, rel: s.rel });
      }
    }
  }
  for (const c of all) {
    // Refresh what each source was understood as (a changed file reads anew).
    c.sources = c.sources.map((s) => (byRel.get(s.rel) ? { ...s, understood: byRel.get(s.rel).understanding.text } : s));
    c.entities = entitiesOf(c.sources, understandingOf);
    if (c.record) {
      // The record names its documents too (its Sources tab reads them), as
      // paths relative to the collection file.
      const at = resolveInProject(projectDir, c.filename);
      const names = new Set(c.record.sources || []);
      const links = { ...(c.record.sourceLinks || {}) };
      let moved = false;
      for (const src of c.sources) {
        if (src.method === 'face' || names.has(src.name)) continue;
        names.add(src.name);
        const rel = relativeSourcePath(at, resolveInProject(projectDir, src.rel));
        if (rel) links[src.name] = rel;
        moved = true;
      }
      if (moved) c.record = { ...c.record, sources: [...names], sourceLinks: links };
    }
    delete c.recordIn;
  }
  relateCollections(all);

  // 4b. Typed links between files, project-wide (the REDUCE step) — each
  // collection keeps the links touching its files, the other end possibly in
  // another collection.
  if (stop()) return { error: 'cancelled' };
  // Switched off: the links earlier scans made stay as they are.
  const keptGraph = { groups: web?.graph?.groups || {}, graph: { timeline: web?.graph?.timeline || [], facts: web?.graph?.facts || [], links: [] }, calls: 0, errors: [] };
  let cross = keptGraph;
  if (features.links) {
    cross = await crossReference(entries, say);
  }
  if (stop()) return { error: 'cancelled' };
  if (features.links && cross !== keptGraph) {
    for (const c of all) {
      const mine = new Set(c.sources.map((x) => x.rel));
      c.links = cross.graph.links.filter((l) => mine.has(l.from) || mine.has(l.to)).slice(0, 80);
    }
  }

  // 5. Write what changed.
  say({ stage: 'save', total: all.length, overall: 0.97, step: `Writing ${all.length} collection${all.length === 1 ? '' : 's'}`, fileFrac: 0.5 });
  const now = Date.now();
  const toWrite = [];
  for (const c of all) {
    const isNew = created.includes(c);
    const { filename, raw, ...rest } = c;   // eslint-disable-line no-unused-vars
    const doc = { type: COLLECTION_TYPE, version: 1, projectId: projectId || null, origin: c.origin || 'scan', ...rest, self: filename, createdAt: isNew ? now : (c.createdAt || now), updatedAt: now };
    if (!isNew && before.get(filename) === signature(c)) continue;
    toWrite.push({ filename, blob: new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }) });
  }
  // A collection is written where it sits (a record may live in a subfolder).
  const byDir = new Map();
  for (const w of toWrite) {
    const cut = w.filename.lastIndexOf('/');
    const dir = cut >= 0 ? resolveInProject(projectDir, w.filename.slice(0, cut)) : projectDir;
    byDir.set(dir, [...(byDir.get(dir) || []), { filename: w.filename.slice(cut + 1), blob: w.blob }]);
  }
  for (const [dir, list] of byDir) {
    const res = await localFolderApi.writeFiles({ dir, files: list });
    if (res?.error) return { error: res.error, skipped };
  }
  for (const c of emptied) {
    try { await localFolderApi.trashFile({ dir: projectDir, path: resolveInProject(projectDir, c.filename) }); } catch { /* leave it */ }
  }

  const nextFiles = {};
  for (const e of entries) nextFiles[e.rel] = { size: e.stamp.size, mtime: e.stamp.mtime, method: e.method, understanding: { ...e.understanding } };
  // A file nothing could be read from is remembered too, so it isn't retried
  // (and paid for) on every run — until it changes.
  for (const s of skipped) if (s.rel && s.stamp && !NOT_REMEMBERED.has(s.error)) nextFiles[s.rel] = { size: s.stamp.size, mtime: s.stamp.mtime, skipped: String(s.error) };
  // Files of a kind switched off keep what the index knew of them.
  for (const rel of held) if (known[rel] && !nextFiles[rel]) nextFiles[rel] = known[rel];
  // The project-wide graph: the groups' answers (reused while their files
  // don't change) + the merged timeline and facts.
  const nextGraph = cross === keptGraph ? (web?.graph || null) : { groups: cross.groups, timeline: cross.graph.timeline, facts: cross.graph.facts, links: cross.graph.links.length };
  const nextWeb = { version: 1, files: nextFiles, collections: all.map((c) => ({ file: c.filename, title: c.title })), graph: nextGraph };
  // Nothing new: the index is left as it is (no write, no watcher wake-up).
  if (!web || JSON.stringify({ f: web.files, c: web.collections, g: web.graph || null }) !== JSON.stringify({ f: nextWeb.files, c: nextWeb.collections, g: nextWeb.graph })) {
    await writeWeb(projectDir, nextWeb, projectId);
  }
  if (toWrite.length || emptied.length) notifyFilesChanged();

  return {
    collections: all.map((c) => ({ title: c.title, filename: c.filename, path: resolveInProject(projectDir, c.filename) })),
    created: created.length,
    updated: [...touched].filter((c) => c.sources.length).length,
    removed: emptied.length,
    read: readCount,
    added: fresh.length,
    upToDate,
    faceMatches: faces.matches.length,
    faceErrors: faces.errors,
    links: cross === keptGraph ? null : cross.graph.links.length,
    linkCalls: cross.calls,
    linkErrors: cross.errors,
    skipped: skipped.filter((s) => !s.earlier),
  };
}

function normalizeUnderstanding(d) {
  return {
    text: str(d?.text, 1600),
    subject: str(d?.subject, 200),
    facts: cleanList(d?.facts),
    entities: cleanList(d?.entities),
    dates: cleanList(d?.dates),
    idDocument: d?.idDocument?.holder ? { holder: str(d.idDocument.holder, 200), type: str(d.idDocument.type, 40) } : null,
    documentType: str(d?.documentType, 120),
    parties: cleanList(d?.parties),
    themes: cleanList(d?.themes),
    // Read locally (lib/localNetwork): the document numbers the file states
    // or cites, its amounts, cadastral numbers and plates — what links files.
    numbers: cleanList(d?.numbers),
    amounts: cleanList(d?.amounts),
    property: cleanList(d?.property),
    vehicles: cleanList(d?.vehicles),
    // An identity document's normalised reading (lib/roIdDocuments), and a
    // historical document's legal era, risks and converted surfaces
    // (lib/legalHistory).
    ...(d?.roId && typeof d.roId === 'object' ? { roId: d.roId } : {}),
    ...(d?.legalHistory && typeof d.legalHistory === 'object' ? { legalHistory: d.legalHistory } : {}),
  };
}

// ── Reading a collection back ───────────────────────────────────────────
export function parseCollection(text) {
  let doc;
  try { doc = JSON.parse(String(text || '')); } catch { return null; }
  if (!doc || typeof doc !== 'object') return null;
  return {
    title: str(doc.title, 200) || 'Data collection',
    subject: str(doc.subject, 40) || 'other',
    summary: str(doc.summary, 6000),
    createdAt: Number(doc.createdAt) || 0,
    sources: cleanList(doc.sources).map((s) => ({
      name: str(s?.name, 300), rel: str(s?.rel, 1000), kind: str(s?.kind, 20) || scanKindOf(s?.name),
      method: str(s?.method, 20), role: str(s?.role, 600), understood: str(s?.understood, 3000),
      confidence: Number.isFinite(Number(s?.confidence)) && s?.confidence != null ? Number(s.confidence) : undefined,
    })).filter((s) => s.name),
    facts: cleanList(doc.facts).map((f) => ({ label: str(f?.label, 200), value: str(f?.value, 1200), sources: cleanList(f?.sources).map((x) => str(x, 1000)) })).filter((f) => f.label),
    timeline: cleanList(doc.timeline).map((t) => ({ date: str(t?.date, 60), event: str(t?.event, 600), sources: cleanList(t?.sources).map((x) => str(x, 1000)) })).filter((t) => t.event),
    connections: cleanList(doc.connections).map((k) => ({ from: str(k?.from, 1000), to: str(k?.to, 1000), why: str(k?.why, 600), face: k?.face ? true : undefined })).filter((k) => k.from && k.to),
    // Typed links (the scan's cross-reference): this collection's files to any
    // file of the project.
    links: cleanList(doc.links).map((l) => ({
      from: str(l?.from, 1000), to: str(l?.to, 1000), type: str(l?.type, 40), why: str(l?.why, 1200),
      evidence: cleanList(l?.evidence).map((x) => str(x, 200)).filter(Boolean),
      confidence: Math.max(0, Math.min(1, Number(l?.confidence) || 0)),
    })).filter((l) => l.from && l.to && LINK_TYPES[l.type]),
    // The web: the names this collection holds (and which files name them) and
    // the collections it is linked to.
    entities: cleanList(doc.entities).map((e) => ({ name: str(e?.name, 200), sources: cleanList(e?.sources).map((x) => str(x, 1000)) })).filter((e) => e.name),
    related: cleanList(doc.related).map((r) => ({ file: str(r?.file, 300), title: str(r?.title, 200), files: cleanList(r?.files).map((x) => str(x, 1000)), names: cleanList(r?.names).map((x) => str(x, 200)) })).filter((r) => r.file),
    // Faces (lib/faceMatch): the identity documents' face boxes and every
    // picture matched to them, with its confidence. Boxes are 0…1 of the picture.
    faceReference: cleanList(doc.faceReference).map((r) => ({ rel: str(r?.rel, 1000), holder: str(r?.holder, 200), box: boxOf(r?.box) })).filter((r) => r.rel && r.box),
    faceMatches: cleanList(doc.faceMatches).map((m) => ({
      kind: m?.kind === 'document' ? 'document' : 'photo', idRel: str(m?.idRel, 1000), holder: str(m?.holder, 200), rel: str(m?.rel, 1000),
      box: boxOf(m?.box), idBox: boxOf(m?.idBox), confidence: Math.max(0, Math.min(1, Number(m?.confidence) || 0)),
    })).filter((m) => m.rel && m.idRel),
    updatedAt: Number(doc.updatedAt) || 0,
    // The party's record (lib/identities) — kept exactly as written.
    record: doc.record && typeof doc.record === 'object' ? doc.record : undefined,
    // Which document each record field was taken from, and how official it is.
    recordSources: doc.recordSources && typeof doc.recordSources === 'object' ? doc.recordSources : undefined,
    origin: str(doc.origin, 20) || undefined,
    self: str(doc.self, 1000) || undefined,
  };
}

function boxOf(b) {
  const n = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  return b && typeof b === 'object' ? { x: n(b.x), y: n(b.y), w: n(b.w), h: n(b.h) } : null;
}
