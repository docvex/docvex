// Data collections — what the AI makes of a WHOLE project folder.
//
// The Files tab's AI scan (the button beside its search) reads every file in
// the project, has the AI understand each one, and then connects them: files
// about the same subject (a person, a company, a property, an incident, a
// contract) become ONE Data collection — a `.dvc` file of its own, written into
// the project folder, listed in the Files tab and opened by the Doc Viewer,
// which shows the sources and what was understood from each.
//
// HOW EACH KIND IS READ (nothing is read twice — every step reuses what is
// already saved about the file):
//   picture  → Extract text (lib/textRegions, the `text` facet)
//   audio    → Generate captions (lib/transcribe, cached in lib/captionsHistory)
//   video    → Generate captions ONLY: the audio track is transcribed, the
//              pictures of the video are never looked at
//   anything else → its text (lib/identityExtract readSourceText: the text
//              layer, Office extraction, or OCR for a scan)
//
// WHAT IS KEPT PER FILE: what the AI understood of it is saved in the file's AI
// data (lib/aiData, facet `understanding`, stamped with the file's size + mtime)
// — shown in the Doc Viewer's Data tab and reused by the next scan, so an
// unchanged file is never sent to the AI again. Only the connecting step runs
// every time, over those short per-file understandings.
//
// THE FILE: JSON, `{ type: 'docvex/data-collection', version: 1, title,
// subject, summary, createdAt, projectId, sources: [{ name, rel, kind, method,
// role, understood }], facts: [{ label, value, sources: [rel] }], timeline:
// [{ date, event, sources: [rel] }], connections: [{ from, to, why }] }` —
// `rel` is the source's path inside the project, so a collection still finds
// its files on another machine.
import { localFolderApi, readLocalBlob } from './localFolder';
import { askProjectAi } from './projectAi';
import { getAiFacet, saveAiFacet, stampFor } from './aiData';
import { extractImageText } from './textRegions';
import { readSourceText } from './identityExtract';
import { loadCaptions, saveCaptions } from './captionsHistory';
import { transcribeAudio } from './transcribe';
import { notifyFilesChanged } from './platform';
import { isScanTagged } from './scanTags';
import { emptyIdentity, fieldsFor, parseIdentity, relativeSourcePath } from './identities';

export const COLLECTION_EXT = 'dvc';
export const COLLECTION_TYPE = 'docvex/data-collection';
const MODEL = 'claude-sonnet-4-6';
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function isCollectionFile(name) {
  return /\.dvc$/i.test(String(name || '').trim());
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif'];
const VIDEO_EXT = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'wma', 'weba', 'aif', 'aiff'];
const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wma: 'audio/x-ms-wma', weba: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff' };

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

const localUrl = (path) => `localfile://local/${encodeURIComponent(path)}`;

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
  const e = extOf(file.name);
  if (kind === 'image') {
    const res = await extractImageText({ path: file.path, name: file.name, projectId }, { force });
    const text = String(res?.data?.text || '').trim();
    if (text) return { text, method: 'image-text' };
    // The measured reading failed (engine couldn't start): the AI transcription.
    try {
      const blob = await readLocalBlob(file.path);
      const r = await readSourceText(blob, file.name, { path: file.path, projectId, force });
      if (r?.text) return { text: r.text, method: 'image-text' };
    } catch { /* fall through */ }
    return { error: res?.error || 'no_text' };
  }
  if (kind === 'video' || kind === 'audio') {
    // Captions only — for a video the pictures are never looked at.
    let cap = force ? null : loadCaptions(file.path);
    // Transcribing loads the WHOLE file and decodes its sound in the app, and
    // Whisper takes ~13 minutes of speech at most: a recording bigger than
    // this is refused before it is loaded (a 1 GB video would stall the window).
    const limit = kind === 'video' ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES;
    if (!cap?.text && Number(file.sizeBytes) > limit) return { error: 'too_large' };
    if (!cap?.text) {
      const mime = kind === 'video'
        ? (String(file.mimeType || '').startsWith('video/') ? file.mimeType : 'video/mp4')
        : (String(file.mimeType || '').startsWith('audio/') ? file.mimeType : (AUDIO_MIME[e] || 'audio/mpeg'));
      const res = await transcribeAudio(localUrl(file.path), mime, file.name);
      const createdAt = Date.now();
      cap = { text: res.text, segments: res.segments, language: res.language, createdAt, original: { text: res.text, segments: res.segments } };
      saveCaptions(file.path, cap);
    }
    const text = String(cap?.text || '').trim();
    return text ? { text, method: 'captions' } : { error: 'no_speech' };
  }
  const blob = await readLocalBlob(file.path);
  const r = await readSourceText(blob, file.name, { path: file.path, projectId, force });
  if (r?.text) return { text: r.text, method: 'text' };
  return { error: r?.error || 'no_text' };
}

function parseJson(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const cleanList = (v) => (Array.isArray(v) ? v : []);
const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max);

// ── Step 2: understand each file (batched; kept per file) ───────────────
const UNDERSTAND_PROMPT = `You are reading files from a legal case folder (mostly Romanian). For EACH file below, say what it is and what it establishes.
Answer ONLY with JSON: {"files":[{"i":<file number>,"summary":"2-4 sentences: what the file is and what it says","subject":"the main person, company, property, event or matter it is about","facts":[{"label":"short name of the fact","value":"the fact, exactly as the file states it"}],"entities":["every person, company, institution, property or case number named"],"dates":[{"date":"DD.MM.YYYY or as written","event":"what happened then"}],"idDocument":null}]}
"idDocument": ONLY when the file IS an identity document carrying its holder's photo (carte de identitate / buletin, CIP, passport, driving licence, residence permit): {"holder":"the holder's full name as written","type":"CI | CIP | passport | driving licence | residence permit | other"}; otherwise null.
Rules: facts must be stated by the file itself — never guess. Keep names, numbers, CNP/CUI, addresses and amounts exactly as written. Up to 12 facts per file. Write the summary in the language of the file.`;

async function understandBatch(batch, { projectId, projectName }) {
  const body = batch.map((b, n) => `=== FILE ${n + 1}: ${b.file.name} (read by: ${METHOD_LABELS[b.method] || b.method}) ===\n${b.text}`).join('\n\n');
  const res = await askProjectAi({
    messages: [{ role: 'user', content: `${UNDERSTAND_PROMPT}\n\n${body}` }],
    tools: false, model: MODEL, projectName, usageProject: projectId, usageAction: 'files-scan',
  });
  if (res?.error) throw new Error(String(res.error));
  const parsed = parseJson(res.text);
  const out = new Map();
  for (const f of cleanList(parsed?.files)) {
    const i = Number(f?.i) - 1;
    if (!batch[i]) continue;
    out.set(i, {
      text: str(f.summary, 1600),
      subject: str(f.subject, 200),
      facts: cleanList(f.facts).slice(0, 16).map((x) => ({ label: str(x?.label, 120), value: str(x?.value, 600) })).filter((x) => x.label && x.value),
      entities: cleanList(f.entities).map((x) => str(x, 160)).filter(Boolean).slice(0, 30),
      dates: cleanList(f.dates).map((x) => ({ date: str(x?.date, 40), event: str(x?.event, 300) })).filter((x) => x.date && x.event).slice(0, 16),
      idDocument: f.idDocument && str(f.idDocument.holder) ? { holder: str(f.idDocument.holder, 200), type: str(f.idDocument.type, 40) } : null,
    });
  }
  return out;
}

// ── The web of information ──────────────────────────────────────────────
// What the scan knows is kept in the project folder itself, in a hidden index
// beside the files (`.docvex-web.json` — a dotfile, so the Files tab never lists
// it; it travels with the folder like the `.docvex.json` sidecar):
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

async function readWeb(projectDir) {
  let web = null;
  try {
    // Asked for only when it exists — before the first scan there is none, and
    // reading it anyway put a 404 in the console on every first run.
    const path = resolveInProject(projectDir, WEB_FILE);
    const st = await localFolderApi.stat(path);
    if (st && !st.error) web = JSON.parse(await (await readLocalBlob(path)).text());
  } catch { /* none yet, or the web build — try the machine's copy */ }
  if (!web) {
    try { web = JSON.parse(localStorage.getItem(WEB_LS + projectDir) || 'null'); } catch { web = null; }
  }
  if (!web || typeof web !== 'object' || !web.files) return null;
  return { version: 1, files: web.files || {}, collections: cleanList(web.collections) };
}

async function writeWeb(projectDir, web) {
  const text = JSON.stringify({ ...web, updatedAt: Date.now() });
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

// ── Step 3a: the FIRST run — connect everything ─────────────────────────
const COLLECTION_SHAPE = `{"title":"short name of the subject","subject":"person | company | property | vehicle | contract | case | event | other","summary":"3-6 sentences: what is known about this subject across the files and how the files relate","sources":[{"i":<file number>,"role":"what this file contributes, one sentence"}],"facts":[{"label":"…","value":"…","sources":[<file numbers>]}],"timeline":[{"date":"…","event":"…","sources":[<file numbers>]}],"connections":[{"from":<file number>,"to":<file number>,"why":"how the two files are linked"}]}`;
// A person or company collection carries the party's RECORD (lib/identities —
// what a contract's clauses are filled from). The AI fills it from the files,
// with only these keys; a value already in the record is never overwritten.
const RECORD_KEYS = `person: ${fieldsFor('person').map((f) => `${f.key} (${f.label})`).join(', ')}; org: ${fieldsFor('org').map((f) => `${f.key} (${f.label})`).join(', ')}`;
const RECORD_RULE = `For a collection about ONE person or ONE company add "record": {"kind":"person" or "org","fields":{"<key>":"value"}} using ONLY these keys, each value exactly as a file states it (dates as DD.MM.YYYY), leaving out what no file states: ${RECORD_KEYS}.`;

const CONNECT_PROMPT = `Below is what was understood from each file of a legal case folder. Connect them: group the files into DATA COLLECTIONS — one per real-world subject (a person, a company, a property, a vehicle, a contract, an incident, a court case…) that two or more files are about, or that one file covers in depth. A file may belong to several collections. Do not invent anything: every fact must come from the listed files.
Answer ONLY with JSON: {"collections":[${COLLECTION_SHAPE}]}
${RECORD_RULE}
Write in the language most of the files are in. Order collections by importance.`;

const fileCard = (e, n) => {
  const u = e.understanding;
  const facts = cleanList(u.facts).slice(0, 10).map((f) => `${f.label}: ${f.value}`).join('; ');
  const dates = cleanList(u.dates).slice(0, 8).map((d) => `${d.date} ${d.event}`).join('; ');
  return `[${n + 1}] ${e.rel} (${METHOD_LABELS[e.method] || e.method})\nAbout: ${u.subject}\nSummary: ${u.text}${facts ? `\nFacts: ${facts}` : ''}${u.entities.length ? `\nNamed: ${u.entities.join(', ')}` : ''}${dates ? `\nDates: ${dates}` : ''}`;
};

// One AI collection → the file's shape; `at(i)` maps a file number to its entry.
function shapeCollection(c, at) {
  const rels = (list) => [...new Set(cleanList(list).map(at).filter(Boolean).map((e) => e.rel))];
  const sources = [];
  for (const s of cleanList(c?.sources)) {
    const e = at(s?.i);
    if (!e || sources.some((x) => x.rel === e.rel)) continue;
    sources.push(sourceOf(e, s?.role));
  }
  return {
    title: str(c?.title, 120),
    subject: str(c?.subject, 40) || 'other',
    summary: str(c?.summary, 3000),
    sources,
    facts: shapeFacts(c?.facts, rels),
    timeline: shapeTimeline(c?.timeline, rels),
    connections: shapeConnections(c?.connections, at),
    recordIn: c?.record && typeof c.record === 'object' ? c.record : null,
  };
}
const sourceOf = (e, role) => ({
  name: e.file.name, rel: e.rel, kind: scanKindOf(e.file.name, e.file.mimeType), method: e.method,
  role: str(role, 400), understood: e.understanding.text,
});
const shapeFacts = (list, rels) => cleanList(list).map((f) => ({ label: str(f?.label, 120), value: str(f?.value, 800), sources: rels(f?.sources) })).filter((f) => f.label && f.value);
const shapeTimeline = (list, rels) => cleanList(list).map((t) => ({ date: str(t?.date, 40), event: str(t?.event, 400), sources: rels(t?.sources) })).filter((t) => t.date && t.event);
const shapeConnections = (list, at) => cleanList(list).map((k) => ({ from: at(k?.from)?.rel || '', to: at(k?.to)?.rel || '', why: str(k?.why, 400) })).filter((k) => k.from && k.to && k.from !== k.to);

async function askJson(prompt, { projectId, projectName }) {
  const res = await askProjectAi({
    messages: [{ role: 'user', content: prompt }],
    tools: false, model: MODEL, projectName, usageProject: projectId, usageAction: 'files-scan',
  });
  if (res?.error) throw new Error(String(res.error));
  const parsed = parseJson(res.text);
  if (!parsed) throw new Error('The AI answered in a form that couldn’t be read.');
  return parsed;
}

async function connectFiles(entries, ctx) {
  const parsed = await askJson(`${CONNECT_PROMPT}\n\n${entries.map(fileCard).join('\n\n')}`, ctx);
  const at = (i) => entries[Number(i) - 1] || null;
  return cleanList(parsed.collections).map((c) => shapeCollection(c, at)).filter((c) => c.title && c.sources.length);
}

// ── Step 3b: a LATER run — fit the new files into the web ───────────────
// The AI sees only the new / changed files and a card per collection: its
// title, subject, the start of its summary and the names it holds. Collections
// sharing no name with the new files are listed by title alone.
const INTEGRATE_PROMPT = `A legal case folder was already organised into DATA COLLECTIONS (one per real-world subject). New files were added. For each new file decide which existing collections it belongs to (it may belong to several, or none), and start NEW collections only for subjects no existing collection covers. Every fact must come from the new files. Do not repeat facts the collection already states.
Answer ONLY with JSON: {"updates":[{"collection":"C<number>","sources":[{"i":<new file number>,"role":"what it adds, one sentence"}],"facts":[{"label":"…","value":"…","sources":[<new file numbers>]}],"timeline":[{"date":"…","event":"…","sources":[<new file numbers>]}],"connections":[{"from":<new file number>,"to":<new file number>,"why":"…"}],"summary":"the collection's summary rewritten to include what the new files add — or \\"\\" when it needs no change"}],"created":[${COLLECTION_SHAPE}]}
In "created", file numbers are the new files' numbers. An update may also carry "record" with the fields the new files add. ${RECORD_RULE}
Write in the language of the collections.`;

async function integrateFiles(newEntries, cols, ctx) {
  const newNames = new Set(newEntries.flatMap((e) => e.understanding.entities.map(foldName)));
  const cards = cols.map((c, n) => {
    const names = c.entities.map((e) => e.name);
    const touches = c.entities.some((e) => newNames.has(foldName(e.name)));
    return touches
      ? `C${n + 1} "${c.title}" (${c.subject}) — ${c.summary.slice(0, 220)}${names.length ? ` | Named: ${names.slice(0, 12).join(', ')}` : ''}`
      : `C${n + 1} "${c.title}" (${c.subject})`;
  });
  const parsed = await askJson(`${INTEGRATE_PROMPT}\n\nEXISTING COLLECTIONS\n${cards.join('\n')}\n\nNEW FILES\n${newEntries.map(fileCard).join('\n\n')}`, ctx);
  const at = (i) => newEntries[Number(i) - 1] || null;
  const rels = (list) => [...new Set(cleanList(list).map(at).filter(Boolean).map((e) => e.rel))];
  const touched = new Set();
  for (const u of cleanList(parsed.updates)) {
    const idx = Number(String(u?.collection || '').replace(/\D+/g, '')) - 1;
    const c = cols[idx];
    if (!c) continue;
    for (const s of cleanList(u?.sources)) {
      const e = at(s?.i);
      if (e && !c.sources.some((x) => x.rel === e.rel)) c.sources.push(sourceOf(e, s?.role));
    }
    c.facts.push(...shapeFacts(u?.facts, rels));
    c.timeline.push(...shapeTimeline(u?.timeline, rels));
    c.connections.push(...shapeConnections(u?.connections, at));
    if (str(u?.summary)) c.summary = str(u.summary, 3000);
    fillRecord(c, u?.record);
    touched.add(c);
  }
  const created = cleanList(parsed.created).map((c) => shapeCollection(c, at)).filter((c) => c.title && c.sources.length);
  return { touched, created };
}

// Fill a collection's record from what the AI read (`{ kind, fields }`). Only
// empty fields are filled — a value the user typed, or an earlier reading, is
// never replaced — and only the record's own keys are taken. A person or
// company collection without a record gets one.
function fillRecord(c, rec) {
  if (!rec || typeof rec !== 'object') return;
  const kind = c.record?.kind || (rec.kind === 'org' || c.subject === 'company' ? 'org' : 'person');
  if (!c.record && !['person', 'company'].includes(c.subject) && !['person', 'org'].includes(rec.kind)) return;
  const allowed = new Set(fieldsFor(kind).map((f) => f.key));
  const base = c.record ? { ...c.record } : { ...emptyIdentity(kind), name: c.title };
  let filled = false;
  for (const [k, v] of Object.entries(rec.fields || {})) {
    if (!allowed.has(k) || typeof v !== 'string' || !v.trim()) continue;
    if (String(base[k] ?? '').trim()) continue;
    base[k] = v.trim();
    filled = true;
  }
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

// ── The scan ────────────────────────────────────────────────────────────
// `onProgress({ stage, index, total, name })` — stage: list | read | understand | connect | save.
// `force` starts the web over (every file read and understood again).
// → { collections, created, updated, removed, read, added, upToDate, skipped } or { error }
// `tags` (lib/scanTags) — the files tagged for the scan: only those are read,
// and a file untagged since the last scan leaves the collections as if removed.
export async function scanProjectFiles(projectDir, { projectId, projectName, force = false, onProgress, isCancelled, tags = null } = {}) {
  if (!projectDir) return { error: 'no_folder' };
  const say = (p) => { try { onProgress?.(p); } catch { /* ignore */ } };
  const stop = () => !!isCancelled?.();
  const ctx = { projectId, projectName };
  say({ stage: 'list' });
  const listing = await localFolderApi.listAll(projectDir);
  if (listing?.error) return { error: listing.error };
  const files = (listing.files || []).filter((f) => f?.path && scanKindOf(f.name, f.mimeType) !== 'collection'
    && (!tags || isScanTagged(tags, relInProject(projectDir, f.path))));
  if (!files.length) return { error: tags ? 'none_tagged' : 'empty' };

  const web = force ? null : await readWeb(projectDir);
  const known = web?.files || {};

  // 1 + 2. What each file is — from the web, from the file's AI data, or read
  // and understood now. Only the last costs anything.
  const entries = [];
  const fresh = [];          // entries whose file is new or changed since the web was made
  const skipped = [];
  const listed = new Set();
  // Files are understood a BATCH at a time as they are read (≤8 files / ~40k
  // characters), and each one's understanding is saved at once — so a scan
  // that is stopped, or a window that is closed, keeps what it has done and
  // the next scan picks up from there.
  const PER_FILE = 9000;
  let batch = []; let batchSize = 0; let understood = 0; let aiDown = null;
  let mediaDown = null;       // captions unavailable (no key, offline) — the rest of the media is skipped
  const flush = async () => {
    if (!batch.length) return;
    const list = batch; batch = []; batchSize = 0;
    if (aiDown) { list.forEach((b) => skipped.push({ name: b.file.name, error: 'ai_failed' })); return; }
    say({ stage: 'understand', index: understood, total: understood + list.length, name: list[0].file.name });
    let got;
    try { got = await understandBatch(list, ctx); } catch (err) {
      aiDown = err?.message || 'ai_failed';
      list.forEach((b) => skipped.push({ name: b.file.name, error: 'ai_failed' }));
      return;
    }
    list.forEach((b, i) => {
      const u = got.get(i);
      if (!u?.text) { skipped.push({ name: b.file.name, error: 'ai_failed' }); return; }
      const data = { ...u, method: b.method };
      // Kept in the file's AI data — the Data tab shows it, the next scan reuses it.
      saveAiFacet({ path: b.file.path, name: b.file.name, projectId }, 'understanding', { data, engine: 'claude', stamp: b.stamp });
      const e = { file: b.file, rel: b.rel, stamp: b.stamp, method: b.method, understanding: normalizeUnderstanding(data) };
      entries.push(e); fresh.push(e);
    });
    understood += list.length;
  };
  let readCount = 0;
  for (let n = 0; n < files.length; n += 1) {
    if (stop()) return { error: 'cancelled' };
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
      if (!getAiFacet(file.path, 'understanding')) saveAiFacet({ path: file.path, name: file.name, projectId }, 'understanding', { data: { ...u, method: prev.method || 'text' }, engine: 'claude', stamp });
      continue;
    }
    if (same && prev.skipped) { skipped.push({ name: file.name, error: prev.skipped, earlier: true }); continue; }
    const saved = force ? null : getAiFacet(file.path, 'understanding', stamp);
    if (saved?.data?.text) {
      const e = { file, rel, stamp, method: saved.data.method || 'text', understanding: normalizeUnderstanding(saved.data) };
      entries.push(e); fresh.push(e);
      continue;
    }
    const kind = scanKindOf(file.name, file.mimeType);
    if ((kind === 'video' || kind === 'audio') && mediaDown) { skipped.push({ name: file.name, error: mediaDown }); continue; }
    say({ stage: 'read', index: n, total: files.length, name: file.name });
    try {
      const res = await readFileForScan(file, { projectId, force });
      if (res.error) { skipped.push({ name: file.name, rel, stamp, error: res.error }); continue; }
      readCount += 1;
      const text = res.text.length > PER_FILE ? `${res.text.slice(0, PER_FILE)}\n[…]` : res.text;
      if (batch.length && (batch.length >= 8 || batchSize + text.length > 40000)) await flush();
      batch.push({ file, rel, stamp, method: res.method, text }); batchSize += text.length;
    } catch (err) {
      const why = err?.message || 'unreadable';
      // Transcription not set up (or unreachable): every other recording
      // would fail the same way — don't load them all to find out.
      if ((kind === 'video' || kind === 'audio') && /configured|reach the AI|signed in|OpenAI/i.test(why)) mediaDown = why;
      skipped.push({ name: file.name, rel, stamp, error: why });
    }
  }
  await flush();
  if (!entries.length) return { error: aiDown || 'nothing_read', skipped };


  const byRel = new Map(entries.map((e) => [e.rel, e]));
  const removed = Object.keys(known).filter((rel) => !listed.has(rel));
  const changed = new Set([...fresh.map((e) => e.rel), ...removed]);

  // Every collection in the project, read back from its file. `filename` is
  // its path inside the project.
  let cols = [];
  for (const f of (listing.files || []).filter((x) => x?.path && scanKindOf(x.name) === 'collection')) {
    try {
      const doc = parseCollection(await (await readLocalBlob(f.path)).text());
      if (doc) cols.push({ ...doc, filename: relInProject(projectDir, f.path), raw: null });
    } catch { /* unreadable — left alone */ }
  }
  const firstRun = !cols.length;
  const upToDate = !firstRun && !changed.size;

  let created = [];
  let touched = new Set();
  // What each collection said before, to write only the ones that change.
  const signature = (c) => JSON.stringify({ t: c.title, s: c.summary, so: c.sources, f: c.facts, ti: c.timeline, co: c.connections, e: c.entities, r: c.related, fm: c.faceMatches || [], fr: c.faceReference || [], rc: c.record || null });
  const before = new Map(cols.map((c) => [c.filename, signature(c)]));
  if (!upToDate) {
    if (stop()) return { error: 'cancelled' };
    if (firstRun) {
      say({ stage: 'connect', total: entries.length });
      try { created = await connectFiles(entries, ctx); } catch (err) { return { error: err?.message || 'ai_failed', skipped }; }
      cols = [];
      created.forEach((c) => fillRecord(c, c.recordIn));
    } else {
      cols = cols.map((c) => withoutFiles(c, changed));
      const incoming = fresh.filter((e) => byRel.has(e.rel));
      if (incoming.length) {
        say({ stage: 'connect', total: incoming.length, incremental: true });
        try { ({ touched, created } = await integrateFiles(incoming, cols, ctx)); } catch (err) { return { error: err?.message || 'ai_failed', skipped }; }
        created.forEach((c) => fillRecord(c, c.recordIn));
      }
    }
  }

  // 3c. Faces — the identity documents' photos against the pictures. Local:
  // no tokens, no face leaves the computer (lib/faceMatch). Redone every run
  // from the saved face descriptions, so a new picture is matched at once.
  say({ stage: 'faces' });
  const faces = await faceStage(entries, { projectId, onProgress: (p) => say({ stage: 'faces', ...p }), isCancelled: stop });
  if (stop()) return { error: 'cancelled' };
  applyFaces(cols, created, faces, byRel);

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

  // 5. Write what changed.
  say({ stage: 'save', total: all.length });
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
  for (const s of skipped) if (s.rel && s.stamp && s.error !== 'ai_failed') nextFiles[s.rel] = { size: s.stamp.size, mtime: s.stamp.mtime, skipped: String(s.error) };
  const nextWeb = { version: 1, files: nextFiles, collections: all.map((c) => ({ file: c.filename, title: c.title })) };
  // Nothing new: the index is left as it is (no write, no watcher wake-up).
  if (!web || JSON.stringify({ f: web.files, c: web.collections }) !== JSON.stringify({ f: nextWeb.files, c: nextWeb.collections })) {
    await writeWeb(projectDir, nextWeb);
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
    origin: str(doc.origin, 20) || undefined,
    self: str(doc.self, 1000) || undefined,
  };
}

function boxOf(b) {
  const n = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  return b && typeof b === 'object' ? { x: n(b.x), y: n(b.y), w: n(b.w), h: n(b.h) } : null;
}
