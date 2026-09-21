// Party extraction for the case timeline.
//
// By the time the council has reconstructed the story it has read every file in
// the case, and it knows exactly who is in it — the client, the other side, the
// witnesses, the companies behind them. That knowledge used to evaporate with
// the run. This turns it into one identity file per party, written into the
// project's Identities/ folder, so the Files tab ends up with a record for
// everybody involved instead of just the documents they appear in.
//
// Merge, never clobber: a party the user has already filled in by hand keeps
// every field they typed. Only blanks are completed, and the source filenames
// are unioned so a disputed detail can be traced back to the document it came
// out of.

import { askProjectAi } from './projectAi';
import { recognizeCanvas, OCR_MAX_EDGE } from './ocr';
import { getAiFacet, saveAiFacet, stampFor, bestTextFor } from './aiData';
import { loadPdfModule } from './pdfWorker';
import { extractFileText } from './extractFileText';
import { extractDocText } from './platform';
import {
  emptyIdentity, identityKey, mergeIdentity, listIdentities, writeIdentity, isIdentityFile, normalizeIdType, ID_TYPE_RULE,
  settlePersonName,
} from './identities';
import { normalizeNationality } from './nationalities';

const EXTRACT_MODEL = 'claude-sonnet-4-6';

// How much of each file the extractor sees. Parties are named in the opening
// paragraphs and the signature block far more often than in the middle, so a
// generous per-file slice matters less than covering every file.
const PER_FILE_CHARS = 3500;
const TOTAL_CHARS = 60000;

const JSON_SPEC = `Respond with ONLY a JSON object — no prose, no markdown fences — in exactly this shape:
{
  "identities": [
    {
      "name": "Popescu Ion",
      "kind": "person",
      "legalName": "Popescu Ion-Marian",
      "lastName": "Popescu", "firstName": "Ion-Marian",
      "nationalId": "",
      "dateOfBirth": "",
      "nationality": "",
      "idSeries": "",
      "idNumber": "",
      "taxId": "",
      "regNo": "",
      "legalForm": "",
      "representative": "",
      "address": "",
      "email": "",
      "phone": "",
      "sources": ["contract.pdf"]
    }
  ]
}

Field rules:
- "kind" is "person" for a natural person, "org" for a company, authority, court or any other legal entity.
- "name" is how the party is referred to day to day — it becomes the record's title. Keep it short and use the same spelling throughout.
- Person-only fields (nationalId = CNP, dateOfBirth, nationality, idSeries + idNumber) stay empty for organisations; organisation-only fields (taxId = CUI/VAT, regNo = trade register number, legalForm, representative) stay empty for people.
- An act of identity is TWO values: "seria RX nr. 456789" is idSeries "RX" and idNumber "456789". Never put both in one field.
- Copy the address as ONE line, in the order the document writes it: "Str. Mihai Eminescu nr. 12, bl. A3, sc. B, ap. 15, București, sector 3". DocVex splits it into its parts; keeping the "str." / "nr." / "bl." markers is what makes that split reliable.
- "sources" lists the EXACT filenames, verbatim from the set provided, that each detail was read out of.
- Copy values VERBATIM from the documents. Leave a field as "" when the documents do not state it. Never guess a CNP, a registration number, an address or a date.
- Include every named party that matters to the story. Skip people mentioned only in passing with no bearing on it, and skip the law firm's own software or systems.
- Keep names, company names and identifiers exactly as they appear in the source.
- If there are no identifiable parties, return {"identities": []}.`;

function excerptBlock(excerpts) {
  let budget = TOTAL_CHARS;
  const out = [];
  for (const f of excerpts || []) {
    if (budget <= 0) break;
    const text = (f.text || '').slice(0, Math.min(PER_FILE_CHARS, budget));
    if (!text) continue;
    budget -= text.length;
    out.push(`--- FILE: ${f.name} ---\n${text}`);
  }
  return out.join('\n\n') || '(no readable file contents)';
}

// Ask the model for every party in the case. Returns `{ identities }` — always
// an array, empty on any failure, because this runs as a side-effect of the
// timeline and must never be able to fail the story it rides along with.
export async function extractIdentities({ projectName, timeline, excerpts, jurisdiction, usageProject }) {
  const story = [
    timeline?.lede ? `STORY SUMMARY:\n${timeline.lede}` : '',
    Array.isArray(timeline?.events) && timeline.events.length
      ? `EVENTS:\n${timeline.events.slice(0, 80).map((e) => `- ${e.d || ''} ${e.y || ''} — ${e.title || ''}: ${e.body || ''}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

  const prompt = [
    `You are reading a case file${projectName ? ` for the matter "${projectName}"` : ''} and listing every party involved — the people and the organisations.`,
    '',
    story || '(no reconstructed story available)',
    '',
    'FILE CONTENTS:',
    excerptBlock(excerpts),
    '',
    JSON_SPEC,
  ].join('\n');

  try {
    const res = await askProjectAi({
      messages: [{ role: 'user', content: prompt }],
      projectName,
      fileNames: (excerpts || []).map((f) => f.name),
      model: EXTRACT_MODEL,
      tools: false,
      jurisdiction,
      usageProject,
      usageAction: 'identity-extract',
    });
    if (res.error) return { identities: [], error: res.error };
    return { identities: parseIdentities(res.text || ''), usage: res.usage };
  } catch (err) {
    return { identities: [], error: err };
  }
}

// Pull the identities array out of a model reply. Bare JSON is asked for; a
// fenced block or a sentence of preamble is the usual failure mode, so fall
// back to the outermost braces before giving up.
export function parseIdentities(text) {
  const tryParse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text || '');
  const first = (text || '').indexOf('{');
  const last = (text || '').lastIndexOf('}');
  const candidates = [text, fenced?.[1], first >= 0 && last > first ? text.slice(first, last + 1) : null];
  for (const c of candidates) {
    const obj = c ? tryParse(String(c).trim()) : null;
    const list = Array.isArray(obj?.identities) ? obj.identities : Array.isArray(obj) ? obj : null;
    if (!list) continue;
    return list
      .filter((r) => r && typeof r.name === 'string' && r.name.trim())
      .map((r) => {
        const base = emptyIdentity(r.kind === 'org' ? 'org' : 'person');
        const out = { ...base, origin: 'timeline' };
        for (const key of Object.keys(base)) {
          if (key === 'sources') continue;
          if (typeof r[key] === 'string') out[key] = r[key].trim();
        }
        out.idType = normalizeIdType(out.idType);
        out.nationality = normalizeNationality(out.nationality) || out.nationality;
        out.name = r.name.trim();
        out.kind = r.kind === 'org' ? 'org' : 'person';
        out.sources = Array.isArray(r.sources) ? r.sources.filter((sv) => typeof sv === 'string') : [];
        return settlePersonName(out);
      });
  }
  return [];
}

// Write the extracted parties into the project's Identities/ folder, folding
// each into whatever is already there. Returns what actually changed, so the
// caller can report "4 added, 2 updated" rather than a bare count.
export async function saveExtractedIdentities(projectDir, identities, { dir } = {}) {
  if (!projectDir || !identities?.length) return { added: 0, updated: 0, names: [] };
  const existing = await listIdentities(projectDir);
  const byKey = new Map(existing.map((e) => [identityKey(e), e]));
  let added = 0;
  let updated = 0;
  const names = [];
  const paths = [];
  for (const incoming of identities) {
    const key = identityKey(incoming);
    if (!key) continue;
    const prior = byKey.get(key);
    // A record the user has already opened and filled in keeps everything they
    // typed; only its blanks get completed.
    const record = prior ? mergeIdentity(prior, incoming) : incoming;
    // A record that already exists is rewritten where it is; a new one goes to
    // `dir` — beside the files it was read from — or the project root.
    const res = await writeIdentity(projectDir, record, {
      previousFileName: prior?._fileName, previousPath: prior?._path, dir,
    });
    if (res.error) continue;
    if (prior) updated += 1; else added += 1;
    names.push(record.name);
    byKey.set(key, { ...record, _fileName: res.filename, _path: res.path });
    paths.push(res.path);
  }
  return { added, updated, names, paths };
}

// Read an image file with the OCR the Doc Viewer already uses. The lasso tool
// hands `recognizeCanvas` a cropped canvas; here the whole picture is the crop,
// scaled down to the edge Claude works at so the upload stays small.
//
// Two decode paths on purpose. `createImageBitmap` is the fast one but throws
// on formats the browser will still happily paint — HEIC from an iPhone above
// all, which is exactly what a photo of an ID card arrives as. An <img> decode
// covers those, so a picture the viewer can SHOW is a picture this can read.
async function decodeToCanvas(blob) {
  let width = 0;
  let height = 0;
  let source = null;
  try {
    source = await createImageBitmap(blob);
    width = source.width; height = source.height;
  } catch {
    source = null;
  }
  if (!source) {
    const url = URL.createObjectURL(blob);
    try {
      source = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('decode_failed'));
        img.src = url;
      });
      width = source.naturalWidth; height = source.naturalHeight;
    } finally {
      // Revoked after draw, below — an <img> still needs its src while painting.
      source && (source._objectUrl = url);
      if (!source) URL.revokeObjectURL(url);
    }
  }
  if (!width || !height) throw new Error('decode_failed');

  const scale = Math.min(1, OCR_MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  // A white ground: a photo with transparency would otherwise reach the model
  // as text on black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  try { source.close?.(); } catch { /* not all engines expose close() */ }
  if (source._objectUrl) URL.revokeObjectURL(source._objectUrl);
  return canvas;
}

async function ocrImageBlob(blob) {
  const canvas = await decodeToCanvas(blob);
  return recognizeCanvas(canvas);
}

// ── Reading a record off a photograph ───────────────────────────────────
// An identity card, a passport page, a company certificate: the details are
// already written down, and typing them again is the kind of work a computer
// should be doing. So the record can be filled from a picture of the document
// it came from.
//
// Two steps, both already built: `doc-ai`'s OCR reads the image, and the field
// extraction below turns that text into this record's shape. Kept as two calls
// rather than one vision prompt because the OCR step is the one that has to be
// accurate — a transcription can be checked, an inference can't.
//
// It NEVER overwrites: a value already on the record was put there on purpose,
// and a photograph is not grounds to replace it. What it can offer is what the
// record is still missing, and the caller is told exactly which fields moved.
const AUTOFILL_KEYS = [
  'legalName', 'lastName', 'firstName', 'nationalId', 'dateOfBirth', 'placeOfBirth', 'nationality', 'gender',
  'idType', 'idSeries', 'idNumber', 'idIssuer', 'idIssuedAt',
  'taxId', 'regNo', 'legalForm', 'representative',
  'address', 'city', 'county', 'country',
];

function autofillPrompt(kind, text) {
  return [
    kind === 'org'
      ? 'The text below was read off a photograph of a Romanian company document (certificat de înregistrare, CUI certificate, or similar).'
      : 'The text below was read off a photograph of a Romanian identity or travel document (carte de identitate, passport, permis de ședere or similar).',
    '',
    'Return ONE JSON object, nothing else — no prose, no code fence. Use exactly these keys:',
    JSON.stringify(Object.fromEntries(AUTOFILL_KEYS.map((k) => [k, ''])), null, 0),
    '',
    'Rules:',
    '- Copy values VERBATIM. Leave a key as "" when the text does not state it. Never guess.',
    '- legalName is the full name exactly as printed (surname first, as Romanian documents write it).',
    '- For a person also give the two parts: lastName is the surname (Nume / Nom / Last name), firstName the given names (Prenume / Prenom / First name). Leave both "" for a company.',
    '- "SERIA RX NR 456789" is idSeries "RX" and idNumber "456789" — two separate keys, never one.',
    ID_TYPE_RULE,
    '- CNP is the 13-digit personal code. Do not confuse it with the document number.',
    '- gender: "male" for M / masculin, "female" for F / feminin, "" if not stated.',
    '- dateOfBirth and idIssuedAt in the document\'s own format (e.g. 12.04.1990).',
    '- address is the full domiciliu line as printed, in one string, keeping its "str." / "nr." / "bl." markers.',
    '- city is the locality, county is the județ or sector.',
    '',
    'TEXT:',
    text,
  ].join('\n');
}

// One value out of a model reply. The act of identity is held to the supported
// list (`IDENTITY_ID_TYPES`): anything else is no reading at all.
function readValue(key, raw) {
  const value = String(raw ?? '').trim();
  if (key === 'idType') return normalizeIdType(value);
  if (key === 'nationality') return normalizeNationality(value) || value;
  return value;
}

// Pull the JSON object out of a model reply that may have wrapped it.
function parseAutofill(reply) {
  const raw = String(reply || '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const braced = /\{[\s\S]*\}/.exec(raw);
  for (const candidate of [fenced?.[1], braced?.[0], raw]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* try the next shape */ }
  }
  return null;
}

// Read `imageBlob` and return the fields it can offer for `record`.
//   { fields: { key: value }, error?: string }
// `fields` holds only keys the record is MISSING — what the caller may fill in.
export async function readIdentityFromImage(imageBlob, record, { jurisdiction, projectId } = {}) {
  if (!imageBlob) return { fields: {}, error: 'no_image' };
  let text = '';
  try {
    text = await ocrImageBlob(imageBlob);
  } catch (e) {
    // Distinguish "the browser could not decode this picture" from "the AI
    // could not read it" — they have completely different remedies, and the
    // one message that covered both sent people off sharpening photographs
    // that were never the problem.
    const why = String(e?.message || '');
    if (why === 'decode_failed') return { fields: {}, error: 'decode_failed' };
    return { fields: {}, error: 'ocr_failed', detail: why };
  }
  if (!text.trim()) return { fields: {}, error: 'no_text' };

  const res = await askProjectAi({
    messages: [{ role: 'user', content: autofillPrompt(record?.kind || 'person', text) }],
    jurisdiction,
    usageProject: projectId,
    usageAction: 'identity-autofill',
  });
  if (res?.error) {
    return { fields: {}, error: 'ai_failed', detail: String(res.error?.message || res.error) };
  }
  const parsed = parseAutofill(res?.text);
  // The OCR worked and the model answered — it just did not answer in the shape
  // asked for. Hand back the transcription so the caller can say as much.
  if (!parsed) return { fields: {}, error: 'unreadable', text };

  const fields = {};
  for (const key of AUTOFILL_KEYS) {
    const value = readValue(key, parsed[key]);
    if (!value) continue;
    fields[key] = value;
  }
  // EVERYTHING it read, including values the record already has. Nothing here
  // is applied: the form shows each reading under the field it belongs to and
  // waits to be told. So a value that DISAGREES with what is already typed is
  // the most useful thing this can hand back — dropping it, as this used to,
  // hid the one case worth a person's attention. The caller decides what to
  // show; overwriting is still never automatic.
  return { fields, text };
}

// ── Reading a record off ANY file ───────────────────────────────────────
// A photograph is only one of the ways an identity reaches a project. The same
// card arrives as a scanned PDF from the client, the company's details sit in a
// certificate exported to PDF or in the opening clause of a Word contract. So
// the reader takes whatever it is given and finds the route to its text:
//
//   picture            → OCR (as above)
//   PDF with text      → its text layer
//   PDF without text   → a scan: its first pages are rendered and OCR'd
//   Word / Excel / text→ extracted in the renderer
//   legacy .doc        → extracted by the main process (needs the file's path)
//   anything else      → read as text if that is what the bytes turn out to be
//
// What cannot be read says why, in the caller's terms, rather than failing as
// "unsupported": audio and video have no page to read, an identity record is
// already one.
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|heic|heif|bmp|tiff?|gif|avif)$/i;
const MEDIA_EXT_RE = /\.(mp3|wav|m4a|ogg|opus|flac|aac|mp4|mov|mkv|webm|avi|wmv)$/i;
// How many pages of a text-less PDF are OCR'd. An identity document is one or
// two pages; past that a scan is a contract, and each page is a paid call.
const SCAN_PDF_PAGES = 4;

export function identitySourceKind(name, mime = '') {
  const n = String(name || '').toLowerCase();
  if (isIdentityFile(n)) return 'identity';
  if (IMAGE_EXT_RE.test(n) || mime.startsWith('image/')) return 'image';
  if (/\.pdf$/.test(n) || mime === 'application/pdf') return 'pdf';
  if (MEDIA_EXT_RE.test(n) || mime.startsWith('audio/') || mime.startsWith('video/')) return 'media';
  if (/\.doc$/.test(n)) return 'doc';
  return 'document';
}

// Can this file be offered for a scan at all? Everything can except what has
// no text to give — so the pickers dim only those.
export function canScanForIdentity(name, mime = '') {
  const kind = identitySourceKind(name, mime);
  return kind !== 'media' && kind !== 'identity';
}

async function ocrPdfPages(blob) {
  const pdfjs = await loadPdfModule();
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const out = [];
    const pages = Math.min(doc.numPages, SCAN_PDF_PAGES);
    for (let p = 1; p <= pages; p += 1) {
      const page = await doc.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, OCR_MAX_EDGE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const text = await recognizeCanvas(canvas);
      if (text) out.push(text);
    }
    return out.join('\n\n');
  } finally {
    try { doc.destroy(); } catch { /* ignore */ }
  }
}

// Bytes that are text without saying so — a .eml, a .vcf, an extensionless
// export. Decoded strictly, and rejected if it is mostly control characters.
async function sniffText(blob) {
  try {
    const buf = await blob.slice(0, 200000).arrayBuffer();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    // eslint-disable-next-line no-control-regex
    const odd = (text.match(/[\u0000-\u0008\u000e-\u001f]/g) || []).length;
    return odd > text.length * 0.02 ? '' : text;
  } catch {
    return '';
  }
}

// `{ text }` or `{ error, detail? }`. Errors: decode_failed, ocr_failed,
// no_text, media, identity, unsupported.
// WHAT IS ALREADY KNOWN COMES FIRST. Whatever has been read out of this file
// before is in its AI data (lib/aiData) and is shown in the Doc Viewer's Data
// tab: the `ocr` facet (this transcription) and the `text` facet (what the image
// pane's Extract text read — the same Claude OCR, laid on the measured pieces).
// Either answers "what does this file say", so a file on disk is transcribed
// ONCE and every later reading — this record, another record, another window —
// is free until the file changes. Only with nothing saved does the scan run.
// `force` reads it again (the Data tab's Recapture).
export async function readSourceText(blob, name, { path, force = false, projectId } = {}) {
  if (!blob) return { error: 'no_image' };
  const kind = identitySourceKind(name, blob.type || '');
  if (kind === 'media') return { error: 'media' };
  if (kind === 'identity') return { error: 'identity' };
  const stamp = path ? await stampFor(path) : null;
  const saved = path && !force ? bestTextFor(path, stamp) : '';
  const keep = (text) => {
    if (path && text.trim()) saveAiFacet({ path, name, projectId }, 'ocr', { data: { text }, engine: 'claude', stamp });
    return text.trim() ? { text } : { error: 'no_text' };
  };
  try {
    if (kind === 'image') {
      if (saved) return { text: saved, cached: true };
      return keep(await ocrImageBlob(blob));
    }
    if (kind === 'pdf') {
      const layer = await extractFileText(blob, name);
      if (layer?.text && layer.text.replace(/\s+/g, '').length > 40) return { text: layer.text };
      // No text layer worth the name: it is a scan.
      if (saved) return { text: saved, cached: true };
      return keep(await ocrPdfPages(blob));
    }
    if (kind === 'doc') {
      const res = path ? await extractDocText(path) : null;
      const text = String(res?.text || '').trim();
      return text ? { text } : { error: res?.error ? 'unsupported' : 'no_text' };
    }
    const res = await extractFileText(blob, name);
    if (res?.text) return { text: res.text };
    if (res?.error === 'empty') return { error: 'no_text' };
    const sniffed = (await sniffText(blob)).trim();
    return sniffed ? { text: sniffed.slice(0, 16000) } : { error: 'unsupported' };
  } catch (e) {
    const why = String(e?.message || '');
    if (why === 'decode_failed') return { error: 'decode_failed' };
    return { error: 'ocr_failed', detail: why };
  }
}

// Fill ONE record from one or several files — the front and the back of a card,
// a certificate and the act that goes with it. Every file is read, the texts go
// to the model together, and the answer comes back in the same shape as
// readIdentityFromImage: `{ fields, text, read, skipped }`.
export async function readIdentityFromFiles(files, record, { jurisdiction, projectId, force = false, onProgress } = {}) {
  const list = (files || []).filter((f) => f?.blob);
  if (!list.length) return { fields: {}, error: 'no_image' };
  // ONE file that has been read into a record before: what it said is saved
  // (`identity`), so showing it again costs nothing. Only the same kind of
  // record counts — a company is read out of a document differently.
  const only = list.length === 1 && list[0].path ? list[0] : null;
  const kind = record?.kind || 'person';
  if (only && !force) {
    const known = getAiFacet(only.path, 'identity', await stampFor(only.path));
    if (known?.data?.kind === kind && known.data.fields) {
      return { fields: known.data.fields, read: [only.name], skipped: [], cached: true };
    }
  }
  const texts = [];
  const skipped = [];
  let lastError = null;
  for (let i = 0; i < list.length; i += 1) {
    const f = list[i];
    onProgress?.({ index: i, total: list.length, name: f.name });
    const res = await readSourceText(f.blob, f.name, { path: f.path, force, projectId });
    if (res.text) texts.push({ name: f.name, text: res.text });
    else { skipped.push({ name: f.name, error: res.error }); lastError = res; }
  }
  if (!texts.length) return { fields: {}, error: lastError?.error || 'no_text', detail: lastError?.detail, skipped };

  const joined = texts.length === 1
    ? texts[0].text
    : texts.map((t) => `--- ${t.name} ---\n${t.text}`).join('\n\n');
  const res = await askProjectAi({
    messages: [{ role: 'user', content: autofillPrompt(record?.kind || 'person', joined.slice(0, 24000)) }],
    jurisdiction,
    usageProject: projectId,
    usageAction: 'identity-autofill',
  });
  if (res?.error) return { fields: {}, error: 'ai_failed', detail: String(res.error?.message || res.error), skipped };
  const parsed = parseAutofill(res?.text);
  if (!parsed) return { fields: {}, error: 'unreadable', text: joined, skipped };
  const fields = {};
  for (const key of AUTOFILL_KEYS) {
    const value = readValue(key, parsed[key]);
    if (value) fields[key] = value;
  }
  // Saved for next time: this file, read into a record of this kind, said this.
  if (only && Object.keys(fields).length) {
    saveAiFacet({ path: only.path, name: only.name, projectId }, 'identity',
      { data: { kind, fields }, engine: 'claude', stamp: await stampFor(only.path) });
  }
  return { fields, text: joined, read: texts.map((t) => t.name), skipped };
}

// ── Files → identity records ────────────────────────────────────────────
// The Files tab's "Create identity": scan the selected documents and write a
// record for each party found in them. Several files about ONE party — the two
// sides of a card, a card and a proof of address — come back as one record,
// because the model is shown them together and told so; a contract yields a
// record per party. Existing records are merged into, never overwritten.
const SCAN_SPEC = `Respond with ONLY a JSON object — no prose, no markdown fences — in exactly this shape:
{
  "identities": [
    {
      "name": "Popescu Ion",
      "kind": "person",
      "legalName": "Popescu Ion-Marian",
      "lastName": "Popescu", "firstName": "Ion-Marian",
      "nationalId": "", "dateOfBirth": "", "placeOfBirth": "", "nationality": "", "gender": "",
      "idType": "", "idSeries": "", "idNumber": "", "idIssuer": "", "idIssuedAt": "",
      "taxId": "", "regNo": "", "legalForm": "", "representative": "", "repCapacity": "",
      "iban": "", "bank": "",
      "address": "", "city": "", "county": "", "country": "",
      "email": "", "phone": "",
      "sources": ["carte-identitate.pdf"]
    }
  ]
}

Rules:
- One entry per PARTY, not per file. Several files about the same person or company — the front and back of a card, a certificate and its annex — are ONE entry, with every filename in "sources".
- An identity document (carte de identitate, passport, certificat de înregistrare) yields exactly the person or company it belongs to — not the authority that issued it.
- A contract, a power of attorney or a letter yields each party it identifies. Skip courts, notaries, banks and authorities unless they are a party to the act.
- "kind" is "person" for a natural person, "org" for a company or other legal entity.
- "name" is the short everyday name and becomes the record's title; "legalName" is the full name exactly as printed. For a person also give "lastName" (the surname — Nume) and "firstName" (the given names — Prenume); leave both "" for a company.
- Person-only fields (nationalId = CNP, dateOfBirth, placeOfBirth, nationality, gender, id*) stay "" for organisations; organisation-only fields (taxId = CUI, regNo, legalForm, representative, repCapacity) stay "" for people.
- "SERIA RX NR 456789" is idSeries "RX" and idNumber "456789" — two keys, never one.
${ID_TYPE_RULE}
- gender: "male" for M / masculin, "female" for F / feminin, "" if not stated.
- address is the full line as printed, in one string, keeping its "str." / "nr." / "bl." markers; city is the locality, county the județ or sector.
- Copy values VERBATIM. Leave a key as "" when the documents do not state it. Never guess a CNP, a number, an address or a date.
- If no party can be identified, return {"identities": []}.`;

// Returns `{ added, updated, names, read, skipped, error? }`.
// `dir` is where NEW records are written — the folder the files were picked in.
export async function createIdentitiesFromFiles(projectDir, files, { projectName, projectId, jurisdiction, onProgress, dir } = {}) {
  const list = (files || []).filter((f) => f?.blob);
  const out = { added: 0, updated: 0, names: [], read: [], skipped: [] };
  if (!projectDir) return { ...out, error: 'no_folder' };
  if (!list.length) return { ...out, error: 'no_files' };

  const excerpts = [];
  for (let i = 0; i < list.length; i += 1) {
    const f = list[i];
    onProgress?.({ stage: 'read', index: i, total: list.length, name: f.name });
    const res = await readSourceText(f.blob, f.name, { path: f.path, projectId });
    if (res.text) { excerpts.push({ name: f.name, text: res.text }); out.read.push(f.name); }
    else out.skipped.push({ name: f.name, error: res.error, detail: res.detail });
  }
  if (!excerpts.length) return { ...out, error: 'nothing_read' };

  onProgress?.({ stage: 'extract', total: list.length });
  // A wider slice per file than the timeline uses: here the files ARE the
  // subject, and an address on page two is the point rather than noise.
  let budget = TOTAL_CHARS;
  const blocks = [];
  for (const f of excerpts) {
    if (budget <= 0) break;
    const text = f.text.slice(0, Math.min(8000, budget));
    budget -= text.length;
    blocks.push(`--- FILE: ${f.name} ---\n${text}`);
  }
  const prompt = [
    'The files below were selected by a lawyer to create identity records from. Each was read by OCR or text extraction, so expect stray characters and broken lines.',
    '',
    'FILE CONTENTS:',
    blocks.join('\n\n'),
    '',
    SCAN_SPEC,
  ].join('\n');

  let identities = [];
  try {
    const res = await askProjectAi({
      messages: [{ role: 'user', content: prompt }],
      projectName,
      fileNames: excerpts.map((f) => f.name),
      model: EXTRACT_MODEL,
      tools: false,
      jurisdiction,
      usageProject: projectId,
      usageAction: 'identity-scan',
    });
    if (res?.error) return { ...out, error: 'ai_failed', detail: String(res.error?.message || res.error) };
    // Scanned in on purpose by the user, not inferred by the timeline.
    identities = parseIdentities(res.text || '').map((r) => ({ ...r, origin: 'manual' }));
  } catch (e) {
    return { ...out, error: 'ai_failed', detail: String(e?.message || e) };
  }
  if (!identities.length) return { ...out, error: 'no_party' };

  onProgress?.({ stage: 'save', total: identities.length });
  const saved = await saveExtractedIdentities(projectDir, identities, { dir });
  return { ...out, ...saved };
}
