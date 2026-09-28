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
import { askProjectAi, crossrefPassports, passportFiles } from './projectAi';
import { clearAiFacet, getAiFacet, saveAiFacet, stampFor } from './aiData';
import { extractImageText } from './textRegions';
import { readSourceText } from './identityExtract';
import { loadCaptions, saveCaptions } from './captionsHistory';
import { transcribeAudio } from './transcribe';
import { notifyFilesChanged } from './platform';
import { isScanTagged } from './scanTags';
import { DEFAULT_SCAN_FEATURES } from './scanFeatures';

export { SCAN_FEATURES, DEFAULT_SCAN_FEATURES, loadScanFeatures, saveScanFeatures } from './scanFeatures';
import { SETTINGS_STORES, settingsAvailable, loadSetting, putSetting, rememberProjectDir, hydrateProject, hydratePaths } from './projectIndexClient';
import { emptyIdentity, fieldsFor, parseIdentity, relativeSourcePath } from './identities';
import { normalizeRoId, roIdToRecordFields, sameAddress, mergeAddresses, hasMrzLines } from './roIdDocuments';
import { readMrzWithAi } from './mrzAi';
import { MRZ_PROMPT } from './roIdDocuments';
import { documentAuthority, AUTHORITY_RULE } from './docAuthority';
import { analyzeLegalHistory, compactLegalHistory, legalHistoryNote } from './legalHistory';

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
      const res = await transcribeAudio(localUrl(file.path), mime, file.name, { projectId });
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
const MRZ_RULES_TEXT = `MRZ rules (an identity document's strip of capitals and "<"): ${MRZ_PROMPT.split('\n').filter((l) => /^\d\./.test(l)).join(' ')} Schema: {"last_name","first_names","date_of_birth":"YYYY-MM-DD","gender":"M|F","expiration_date":"YYYY-MM-DD","nationality":"ROU"}.`;
export const UNDERSTAND_PROMPT = `You are reading files from a legal case folder (mostly Romanian). For EACH file below, say what it is and what it establishes.
Answer ONLY with JSON: {"files":[{"i":<file number>,"summary":"2-4 sentences: what the file is and what it says","subject":"the main person, company, property, event or matter it is about","facts":[{"label":"short name of the fact","value":"the fact, exactly as the file states it"}],"entities":["every person, company, institution, property or case number named"],"dates":[{"date":"DD.MM.YYYY or as written","event":"what happened then"}],"idDocument":null}]}
"idDocument": ONLY when the file IS an identity document carrying its holder's photo (carte electronică de identitate, carte de identitate, CIP, buletin de identitate booklet, an interwar identity paper, passport, driving licence, residence permit): {"holder":"the holder's full name as written","type":"CEI | CI | CIP | BI | passport | driving licence | residence permit | other","mrz":<its machine-readable zone parsed by the MRZ rules below, or null>}; otherwise null.
${MRZ_RULES_TEXT}
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
      idDocument: f.idDocument && str(f.idDocument.holder) ? { holder: str(f.idDocument.holder, 200), type: str(f.idDocument.type, 40), ...(f.idDocument.mrz && typeof f.idDocument.mrz === 'object' ? { mrz: f.idDocument.mrz } : {}) } : null,
    });
  }
  return out;
}

// The MAP step, as project-ai's `passport` action does it (fileGraph.ts): the
// file's PASSPORT — summary, subject, document type, facts, parties with their
// role and identifiers, dates, abstract THEMES, the holder of an identity
// document — in strict JSON. Kept as the file's `understanding` (the old shape,
// plus `documentType`, `parties`, `themes`), so everything that reads it keeps
// working. A file the model left out is answered by the older prompt above.
function understandingFromPassport(p) {
  const parties = cleanList(p.parties).map((x) => ({ name: str(x?.name, 200), kind: str(x?.kind, 20) || 'person', role: str(x?.role, 120), identifiers: cleanList(x?.identifiers).map((i) => str(i, 80)).filter(Boolean) })).filter((x) => x.name);
  return {
    text: str(p.summary, 1600),
    subject: str(p.subject, 200),
    documentType: str(p.document_type, 120),
    facts: cleanList(p.facts).slice(0, 40).map((x) => ({ label: str(x?.label, 120), value: str(x?.value, 600) })).filter((x) => x.label && x.value),
    entities: [...new Set(parties.map((x) => x.name))].slice(0, 30),
    parties: parties.slice(0, 30),
    dates: cleanList(p.dates).map((x) => ({ date: str(x?.date, 40), event: str(x?.event, 300) })).filter((x) => x.date && x.event).slice(0, 30),
    themes: cleanList(p.themes).map((t) => str(t, 80)).filter(Boolean).slice(0, 8),
    idDocument: p.id_document?.holder ? { holder: str(p.id_document.holder, 200), type: str(p.id_document.type, 40) } : null,
  };
}
async function passportBatch(batch, ctx) {
  const res = await passportFiles({
    files: batch.map((b, n) => ({ id: String(n + 1), name: b.file.name, method: b.method, text: b.text })),
    usageProject: ctx.projectId,
  });
  if (res.error) throw new Error(String(res.error?.message || res.error));
  const out = new Map();
  for (const p of res.passports) {
    const i = Number(p.id) - 1;
    if (batch[i] && p.summary) out.set(i, understandingFromPassport(p));
  }
  // Left out: the older prompt, for just those.
  const left = batch.map((b, i) => i).filter((i) => !out.has(i));
  if (left.length) {
    try {
      const got = await understandBatch(left.map((i) => batch[i]), ctx);
      left.forEach((i, k) => { if (got.has(k)) out.set(i, got.get(k)); });
    } catch { /* reported as not understood */ }
  }
  return out;
}

// ── The REDUCE step: typed links between files, project-wide ───────────
// project-ai's `crossref` (fileGraph.ts) reads PASSPORTS — never the files —
// and answers a unified timeline, unified facts and TYPED links between files
// (amends, supersedes, contradicts, same_party, same_subject, dependency,
// financial_link, evidence_for, references, chronological), each with an
// explanation, the evidence and a confidence.
//
// One call over hundreds of files would outrun the server function (the answer
// grows with the links: 5 files took ~24 s), so the files are split into GROUPS
// of related files (sharing a name or an identifier — `graphGroups`) of <=40,
// run two at a time; a group too big for one call is cut into pieces that all
// carry its best-connected files, so the pieces still meet. A group's answer is
// kept in the web under a signature of its files and their stamps and reused
// while none of them changes — an unchanged project costs no call at all.
const GRAPH_GROUP = 40;
const GRAPH_HUBS = 6;
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

const keysOf = (e) => {
  const u = e.understanding;
  const keys = new Set();
  for (const n of u.entities || []) { const k = foldName(n); if (k.length >= 3) keys.add(`n:${k}`); }
  for (const p of u.parties || []) for (const id of p.identifiers || []) { const d = String(id).replace(/\W+/g, '').toLowerCase(); if (d.length >= 5) keys.add(`i:${d}`); }
  if (u.idDocument?.holder) { const k = foldName(u.idDocument.holder); if (k.length >= 3) keys.add(`n:${k}`); }
  return keys;
};

// Entries -> groups (arrays of entries) of <= GRAPH_GROUP.
export function graphGroups(entries) {
  const parent = entries.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const owner = new Map();
  const keys = entries.map(keysOf);
  keys.forEach((ks, i) => { for (const k of ks) { if (owner.has(k)) parent[find(i)] = find(owner.get(k)); else owner.set(k, i); } });
  const comps = new Map();
  entries.forEach((e, i) => { const r = find(i); comps.set(r, [...(comps.get(r) || []), i]); });
  const groups = [];
  const small = [];
  for (const idx of [...comps.values()].sort((a, b) => b.length - a.length)) {
    if (idx.length <= GRAPH_GROUP) { small.push(idx); continue; }
    // Too big for one call: pieces, each carrying the component's hubs (the
    // files sharing the most keys with the others).
    const count = new Map();
    for (const i of idx) for (const k of keys[i]) count.set(k, (count.get(k) || 0) + 1);
    const degree = (i) => [...keys[i]].reduce((n, k) => n + (count.get(k) || 1) - 1, 0);
    const hubs = [...idx].sort((a, b) => degree(b) - degree(a)).slice(0, GRAPH_HUBS);
    const rest = idx.filter((i) => !hubs.includes(i));
    const room = GRAPH_GROUP - hubs.length;
    for (let at = 0; at < rest.length; at += room) groups.push([...hubs, ...rest.slice(at, at + room)]);
  }
  // Small components packed together (first fit): the model may still find
  // links between files that share no name (a theme, a sum).
  const bins = [];
  for (const idx of small) {
    const bin = bins.find((b) => b.length + idx.length <= GRAPH_GROUP);
    if (bin) bin.push(...idx); else bins.push([...idx]);
  }
  return [...groups, ...bins].filter((g) => g.length >= 2).map((g) => g.map((i) => entries[i]));
}

const djb2 = (text) => { let h = 5381; for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const groupSig = (group) => djb2(group.map((e) => `${e.rel}|${e.stamp?.size ?? ''}|${e.stamp?.mtime ?? ''}`).sort().join('\n'));

function passportOf(e, id) {
  const u = e.understanding;
  return {
    id, name: e.file.name,
    summary: u.text, subject: u.subject, document_type: u.documentType || '',
    facts: cleanList(u.facts).slice(0, 30),
    parties: cleanList(u.parties).length ? u.parties : cleanList(u.entities).map((name) => ({ name, kind: 'person' })),
    dates: cleanList(u.dates).slice(0, 20),
    themes: cleanList(u.themes),
    id_document: u.idDocument ? { holder: u.idDocument.holder, type: u.idDocument.type } : null,
  };
}

// -> { graph: { links, timeline, facts }, groups (for the web), calls, errors }
// A group that is an earlier group PLUS a few new or changed files is not
// cross-referenced whole again: the earlier answers stand for the files they
// covered (none of which changed), and only the new files go to the model,
// with the covered files they share the most names / identifiers with
// (`DELTA_MATES`). A file arriving in a 40-file group costs a call of ~12
// passports instead of 40 - the live network's usual case.
const DELTA_MAX = 8;
const DELTA_MATES = 12;
const stampKey = (e) => `${e.stamp?.size ?? ''}|${e.stamp?.mtime ?? ''}`;
function deltaPlan(g, prevGroups) {
  if (!prevGroups) return null;
  const stampOf = new Map(g.map((e) => [e.rel, stampKey(e)]));
  const parts = [];
  const covered = new Set();
  for (const part of Object.values(prevGroups)) {
    // Only answers that name their files, all still in this group and
    // unchanged since.
    if (!Array.isArray(part?.files) || !part.files.length) continue;
    if (!part.files.every((f) => stampOf.get(f.rel) === f.stamp)) continue;
    parts.push(part);
    part.files.forEach((f) => covered.add(f.rel));
  }
  if (!parts.length) return null;
  const fresh = g.filter((e) => !covered.has(e.rel));
  if (!fresh.length || fresh.length > DELTA_MAX) return null;
  const freshKeys = new Set(fresh.flatMap((e) => [...keysOf(e)]));
  const mates = g.filter((e) => covered.has(e.rel))
    .map((e) => ({ e, n: [...keysOf(e)].filter((k) => freshKeys.has(k)).length }))
    .sort((a, b) => b.n - a.n)
    .slice(0, DELTA_MATES)
    .map((x) => x.e);
  return { parts, ask: [...fresh, ...mates] };
}
const mergeParts = (parts) => ({
  links: parts.flatMap((p) => p.links || []),
  timeline: parts.flatMap((p) => p.timeline || []),
  facts: parts.flatMap((p) => p.facts || []),
});

async function crossReference(entries, prevGroups, ctx, { say, stop }) {
  const groups = graphGroups(entries);
  const kept = {};
  const todo = [];
  for (const g of groups) {
    const sig = groupSig(g);
    if (prevGroups?.[sig]) kept[sig] = prevGroups[sig]; else todo.push({ sig, g, plan: deltaPlan(g, prevGroups) });
  }
  let done = 0; let calls = 0;
  const errors = [];
  const run = async ({ sig, g, plan }) => {
    if (stop()) return;
    const ask = plan ? plan.ask : g;
    const ids = ask.map((e, n) => `F${n + 1}`);
    const relOf = new Map(ask.map((e, n) => [ids[n], e.rel]));
    const res = await crossrefPassports({ passports: ask.map((e, n) => passportOf(e, ids[n])), usageProject: ctx.projectId });
    calls += 1;
    done += 1;
    say({ stage: 'links', index: done, total: todo.length, overall: 0.78 + 0.17 * (done / Math.max(1, todo.length)), step: `Cross-referenced ${done} of ${todo.length} group${todo.length === 1 ? '' : 's'}`, fileFrac: done / Math.max(1, todo.length) });
    if (res.error) { errors.push(String(res.error?.message || res.error)); return; }
    const rels = (list) => cleanList(list).map((id) => relOf.get(id)).filter(Boolean);
    const answer = {
      links: cleanList(res.graph.links).map((l) => ({
        from: relOf.get(l.from_file_id), to: relOf.get(l.to_file_id), type: l.connection_type,
        why: str(l.explanation, 1200), evidence: cleanList(l.evidence).map((x) => str(x, 200)), confidence: Number(l.confidence) || 0,
      })).filter((l) => l.from && l.to && LINK_TYPES[l.type]),
      timeline: cleanList(res.graph.timeline).map((t) => ({ date: str(t?.date, 40), event: str(t?.event, 400), sources: rels(t?.file_ids) })).filter((t) => t.sources.length),
      facts: cleanList(res.graph.facts).map((f) => ({ subject: str(f?.subject, 200), label: str(f?.label, 120), value: str(f?.value, 600), sources: rels(f?.file_ids) })).filter((f) => f.sources.length),
    };
    const merged = plan ? mergeParts([...plan.parts, answer]) : answer;
    // The files it covers, with their stamps: what lets a later group that
    // only ADDS files reuse it (deltaPlan).
    kept[sig] = { ...merged, files: g.map((e) => ({ rel: e.rel, stamp: stampKey(e) })) };
  };
  if (todo.length) say({ stage: 'links', index: 0, total: todo.length, overall: 0.78, step: 'Cross-referencing the files', fileFrac: 0 });
  // Two at a time: each call is tens of seconds of the model writing.
  const queue = [...todo];
  await Promise.all([0, 1].map(async () => { while (queue.length && !stop()) await run(queue.shift()); }));
  // Merged across groups — a pair two groups both linked is one link.
  const seen = new Set();
  const links = [];
  for (const part of Object.values(kept)) {
    for (const l of part.links) {
      const sym = ['contradicts', 'same_party', 'same_subject'].includes(l.type);
      const key = `${sym ? [l.from, l.to].sort().join('|') : `${l.from}>${l.to}`}|${l.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(l);
    }
  }
  links.sort((a, b) => b.confidence - a.confidence);
  const dedupe = (list, keyOf) => { const s = new Set(); return list.filter((x) => { const k = keyOf(x); if (s.has(k)) return false; s.add(k); return true; }); };
  const parts = Object.values(kept);
  const timeline = dedupe(parts.flatMap((p) => p.timeline), (t) => `${t.date}|${t.event.toLowerCase()}`).sort((a, b) => a.date.localeCompare(b.date));
  const facts = dedupe(parts.flatMap((p) => p.facts), (f) => `${f.subject.toLowerCase()}|${f.label.toLowerCase()}|${f.value.toLowerCase()}`);
  return { graph: { links, timeline, facts }, groups: kept, calls, errors };
}

// For checks outside the app (scratch harness), nothing else.
export const scanInternals = { passportBatch, crossReference, graphGroups, connectChunked, chunkEntries, deltaPlan };

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
  // No store (or it refused): this machine's copy only, so the next run is
  // still cheap. It is never written into the case folder in clear any more —
  // the index writes it there sealed (projectIndex/folderSeal.js).
  try { localStorage.setItem(WEB_LS + projectDir, JSON.stringify(value)); } catch { /* full — the next scan redoes it */ }
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
export const RECORD_RULE = `For a collection about ONE person or ONE company add "record": {"kind":"person" or "org","fields":{"<key>":"value"}} using ONLY these keys, each value exactly as a file states it (dates as DD.MM.YYYY), leaving out what no file states: ${RECORD_KEYS}. ${AUTHORITY_RULE}`;

export const CONNECT_PROMPT = `Below is what was understood from each file of a legal case folder. Connect them: group the files into DATA COLLECTIONS — one per real-world subject (a person, a company, a property, a vehicle, a contract, an incident, a court case…) that two or more files are about, or that one file covers in depth. A file may belong to several collections. Do not invent anything: every fact must come from the listed files.
Answer ONLY with JSON: {"collections":[${COLLECTION_SHAPE}]}
${RECORD_RULE}
Write in the language most of the files are in. Order collections by importance.`;

const fileCard = (e, n) => {
  const u = e.understanding;
  const facts = cleanList(u.facts).slice(0, 10).map((f) => `${f.label}: ${f.value}`).join('; ');
  const dates = cleanList(u.dates).slice(0, 8).map((d) => `${d.date} ${d.event}`).join('; ');
  return `[${n + 1}] ${e.rel} (${METHOD_LABELS[e.method] || e.method}${u.documentType ? `, ${u.documentType}` : ''})\nAbout: ${u.subject}\nSummary: ${u.text}${cleanList(u.themes).length ? `\nThemes: ${u.themes.join(', ')}` : ''}${facts ? `\nFacts: ${facts}` : ''}${u.entities.length ? `\nNamed: ${u.entities.join(', ')}` : ''}${dates ? `\nDates: ${dates}` : ''}`;
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
  if (res?.error) {
    const why = String(res.error?.message || res.error);
    // 546 = the Edge Function ran out of memory / time on the request: say it
    // in words (the chunked connect below retries it smaller).
    throw new Error(/non-2xx|546|WORKER_LIMIT/i.test(why) ? 'The AI service ran out of resources on a request this size.' : why);
  }
  const parsed = parseJson(res.text);
  if (!parsed) throw new Error('The AI answered in a form that couldn’t be read.');
  return parsed;
}

async function connectFiles(entries, ctx) {
  const parsed = await askJson(`${CONNECT_PROMPT}\n\n${entries.map(fileCard).join('\n\n')}`, ctx);
  const at = (i) => entries[Number(i) - 1] || null;
  return cleanList(parsed.collections).map((c) => shapeCollection(c, at)).filter((c) => c.title && c.sources.length);
}

// CONNECTING IN CHUNKS. One request carrying every file's understanding grew
// past what the Edge Function can hold (a 546 — out of memory / time) on a
// project of any size. So the files go a CHUNK at a time (≤ CONNECT_CHUNK
// files, ≤ CONNECT_CHARS characters of cards): the first chunk makes the
// collections, every later one is FITTED into them (integrateFiles), as a later
// scan fits new files. A chunk that fails is tried once more, then split in
// half and each half tried — down to single files — so one oversized or
// troublesome file costs itself, not the scan.
const CONNECT_CHUNK = 16;
const CONNECT_CHARS = 24000;
function chunkEntries(list) {
  const out = [];
  let cur = []; let size = 0;
  for (const e of list) {
    const len = fileCard(e, cur.length + 1).length;
    if (cur.length && (cur.length >= CONNECT_CHUNK || size + len > CONNECT_CHARS)) { out.push(cur); cur = []; size = 0; }
    cur.push(e); size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}
// `step(done, total)` reports progress; `stop()` ends it early (→ null).
async function connectChunked(entries, cols, ctx, { stop, step } = {}) {
  const chunks = chunkEntries(entries);
  let created = [];
  const touched = new Set();
  const failed = [];
  let done = 0;
  const one = async (chunk) => {
    const all = [...cols, ...created];
    if (!all.length) { created = await connectFiles(chunk, ctx); return; }
    const r = await integrateFiles(chunk, all, ctx);
    r.touched.forEach((c) => touched.add(c));
    created.push(...r.created);
  };
  const attempt = async (chunk) => {
    for (let tries = 0; tries < 2; tries += 1) {
      if (stop?.()) return;
      try { await one(chunk); return; } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[scan] connecting ${chunk.length} file(s) failed (try ${tries + 1}):`, err?.message || err);
        if (tries === 0) await new Promise((r) => { setTimeout(r, 1500); });
        else if (chunk.length > 1) {
          const mid = Math.ceil(chunk.length / 2);
          await attempt(chunk.slice(0, mid));
          await attempt(chunk.slice(mid));
          return;
        } else { failed.push({ entry: chunk[0], error: err?.message || 'ai_failed' }); return; }
      }
    }
  };
  for (const chunk of chunks) {
    if (stop?.()) return null;
    await attempt(chunk);
    done += chunk.length;
    step?.(done, entries.length);
  }
  if (stop?.()) return null;
  return { created, touched, failed };
}

// ── Step 3b: a LATER run — fit the new files into the web ───────────────
// The AI sees only the new / changed files and a card per collection: its
// title, subject, the start of its summary and the names it holds. Collections
// sharing no name with the new files are listed by title alone.
export const INTEGRATE_PROMPT = `A legal case folder was already organised into DATA COLLECTIONS (one per real-world subject). New files were added. For each new file decide which existing collections it belongs to (it may belong to several, or none), and start NEW collections only for subjects no existing collection covers. Every fact must come from the new files. Do not repeat facts the collection already states.
Answer ONLY with JSON: {"updates":[{"collection":"C<number>","sources":[{"i":<new file number>,"role":"what it adds, one sentence"}],"facts":[{"label":"…","value":"…","sources":[<new file numbers>]}],"timeline":[{"date":"…","event":"…","sources":[<new file numbers>]}],"connections":[{"from":<new file number>,"to":<new file number>,"why":"…"}],"summary":"the collection's summary rewritten to include what the new files add — or \\"\\" when it needs no change"}],"created":[${COLLECTION_SHAPE}]}
In "created", file numbers are the new files' numbers. An update may also carry "record" with the fields the new files add. ${RECORD_RULE}
Write in the language of the collections.`;

async function integrateFiles(newEntries, cols, ctx) {
  const newNames = new Set(newEntries.flatMap((e) => e.understanding.entities.map(foldName)));
  const cards = cols.map((c, n) => {
    // A collection made moments ago (an earlier chunk of this scan) has no
    // names worked out yet — its summary is the card then.
    const ents = c.entities || [];
    const names = ents.map((e) => e.name);
    const touches = !c.entities || ents.some((e) => newNames.has(foldName(e.name)));
    return touches
      ? `C${n + 1} "${c.title}" (${c.subject}) — ${String(c.summary || '').slice(0, 220)}${names.length ? ` | Named: ${names.slice(0, 12).join(', ')}` : ''}`
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

// NOTHING MAY HOLD THE SCAN: every file's reading and every AI call runs
// against a time limit and against Stop. A file that runs out of time is
// skipped (not remembered — the next scan tries it again) and the scan goes
// on; Stop takes effect at once, not after the file in hand.
const READ_LIMIT_MS = { image: 120000, doc: 180000, video: 600000, audio: 600000 };
const AI_LIMIT_MS = 240000;
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
  const ctx = { projectId, projectName };
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
  // Files are understood a BATCH at a time as they are read (≤8 files / ~40k
  // characters), and each one's understanding is saved at once — so a scan
  // that is stopped, or a window that is closed, keeps what it has done and
  // the next scan picks up from there.
  const PER_FILE = 9000;
  let batch = []; let batchSize = 0; let understood = 0; let aiDown = null;
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
  let mediaDown = null;       // captions unavailable (no key, offline) — the rest of the media is skipped
  const flush = async () => {
    if (!batch.length) return;
    const list = batch; batch = []; batchSize = 0;
    if (aiDown) { list.forEach((b) => skipped.push({ name: b.file.name, error: 'ai_failed' })); return; }
    say({ stage: 'understand', index: understood, total: understood + list.length, name: list.length > 1 ? `${list.length} files` : list[0].file.name, step: `Understanding ${list.length} file${list.length === 1 ? '' : 's'}`, fileFrac: 0.8, overall: overallAt(at, 0.8), done: at, skipped: skipped.length, understood });
    let got;
    const t0 = Date.now();
    try {
      const r = await raceScan(passportBatch(list, ctx).catch(() => understandBatch(list, ctx)), AI_LIMIT_MS, stop);
      if (r.cancelled) { list.forEach((b) => skipped.push({ name: b.file.name, error: 'ai_failed' })); return; }
      if (r.timedOut) throw new Error('The AI took too long to answer.');
      got = r.value;
      // eslint-disable-next-line no-console
      console.info(`[scan] understood ${list.length} file(s) in ${Date.now() - t0} ms`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[scan] understanding failed:', err?.message || err);
      aiDown = err?.message || 'ai_failed';
      list.forEach((b) => skipped.push({ name: b.file.name, error: 'ai_failed' }));
      return;
    }
    for (const [i, b] of list.entries()) {
      const u = got.get(i);
      if (!u?.text) { skipped.push({ name: b.file.name, error: 'ai_failed' }); continue; }
      const data = { ...u, method: b.method, ...(b.legal ? { legalHistory: b.legal } : {}) };
      // An IDENTITY DOCUMENT is also read into the normalised shape
      // (lib/roIdDocuments — CNP decoded, strip checked, address split): free,
      // from the text already read, kept with the understanding.
      if (u.idDocument || ID_WORDS.test(`${u.documentType || ''} ${u.subject || ''} ${b.file.name}`)) {
        try {
          const src = b.raw || b.text;
          let roId = normalizeRoId(u.idDocument?.mrz ? { mrz: u.idDocument.mrz } : null, src);
          // A strip the local reader could not read (the OCR misread it):
          // the MRZ parser prompt reads it (lib/mrzAi).
          if ((!roId.mrz || roId.mrz.ok === false) && hasMrzLines(src)) {
            const m = await raceScan(readMrzWithAi(src, ctx).catch(() => null), 30000, stop).catch(() => null);
            if (m?.value) roId = normalizeRoId({ mrz: m.value }, src);
          }
          if (roId.cnp || roId.document_number || roId.passport_number || roId.mrz) data.roId = roId;
        } catch { /* not readable as one */ }
      }
      // Kept in the file's AI data — the Data tab shows it, the next scan reuses it.
      saveAiFacet({ path: b.file.path, name: b.file.name, projectId }, 'understanding', { data, engine: 'claude', stamp: b.stamp });
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
      if (!getAiFacet(file.path, 'understanding')) saveAiFacet({ path: file.path, name: file.name, projectId }, 'understanding', { data: { ...u, method: prev.method || 'text' }, engine: 'claude', stamp });
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
    if ((kind === 'video' || kind === 'audio') && mediaDown) { skipped.push({ name: file.name, error: mediaDown }); continue; }
    fileAt = Date.now();
    sayFile(n, file, kind === 'image' ? 'Extracting its text' : kind === 'video' || kind === 'audio' ? 'Transcribing' : 'Reading its text', 0.15);
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
      // Read in its legal era first (lib/legalHistory, local): a historical
      // document goes to the AI with a note on the law of its time — its terms,
      // the decrees it cites, its land measures converted.
      let legal = null;
      let note = '';
      try { const a = analyzeLegalHistory(res.text); legal = compactLegalHistory(a); note = legal ? legalHistoryNote(a, { max: 1400 }) : ''; } catch { /* read as it is */ }
      const body = res.text.length > PER_FILE ? `${res.text.slice(0, PER_FILE)}\n[…]` : res.text;
      const text = note ? `[Context juridic istoric, stabilit de DocVex]\n${note}\n[Textul fișierului]\n${body}` : body;
      if (batch.length && (batch.length >= 8 || batchSize + text.length > 40000)) await flush();
      batch.push({ file, rel, stamp, method: res.method, text, raw: res.text, legal }); batchSize += text.length;
    } catch (err) {
      const why = err?.message || 'unreadable';
      // Transcription not set up (or unreachable): every other recording
      // would fail the same way — don't load them all to find out.
      if ((kind === 'video' || kind === 'audio') && /configured|reach the AI|signed in|OpenAI|switched off/i.test(why)) mediaDown = why;
      skipped.push({ name: file.name, rel, stamp, error: why });
      sayFile(n, file, 'Skipped — couldn\u2019t be read', 1);
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
    if (firstRun) {
      say({ stage: 'connect', total: entries.length, overall: 0.72, step: 'Grouping the files into collections', fileFrac: 0 });
      const res = await connectChunked(entries, [], ctx, {
        stop,
        step: (d, t) => say({ stage: 'connect', total: t, overall: 0.72 + 0.05 * (d / Math.max(1, t)), step: `Grouped ${d} of ${t} files into collections`, fileFrac: d / Math.max(1, t) }),
      });
      if (!res) return { error: 'cancelled' };
      res.failed.forEach((f) => skipped.push({ name: f.entry.file.name, error: 'ai_failed' }));
      if (!res.created.length) return { error: res.failed[0]?.error || 'The AI couldn\u2019t connect the files. Try again.', skipped };
      created = res.created;
      cols = [];
      created.forEach((c) => fillRecord(c, c.recordIn));
    } else {
      cols = cols.map((c) => withoutFiles(c, changed));
      const incoming = fresh.filter((e) => byRel.has(e.rel));
      if (incoming.length) {
        say({ stage: 'connect', total: incoming.length, incremental: true, overall: 0.72, step: 'Fitting the new files into the collections', fileFrac: 0 });
        const res = await connectChunked(incoming, cols, ctx, {
          stop,
          step: (d, t) => say({ stage: 'connect', total: t, incremental: true, overall: 0.72 + 0.05 * (d / Math.max(1, t)), step: `Fitted ${d} of ${t} new files into the collections`, fileFrac: d / Math.max(1, t) }),
        });
        if (!res) return { error: 'cancelled' };
        res.failed.forEach((f) => skipped.push({ name: f.entry.file.name, error: 'ai_failed' }));
        ({ touched, created } = res);
        created.forEach((c) => fillRecord(c, c.recordIn));
      }
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
    const r = await raceScan(crossReference(entries, web?.graph?.groups, ctx, { say, stop }), AI_LIMIT_MS * 3, stop);
    if (r.cancelled) return { error: 'cancelled' };
    cross = r.timedOut ? { ...keptGraph, errors: ['the AI took too long'] } : r.value;
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
