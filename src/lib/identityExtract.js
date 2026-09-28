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
import { isCloudMediaAllowed } from './cloudMedia';
import { getAiFacet, saveAiFacet, stampFor, bestTextFor } from './aiData';
import { loadPdfModule } from './pdfWorker';
import { extractFileText } from './extractFileText';
import { extractDocText } from './platform';
import {
  isIdentityFile, normalizeIdType, ID_TYPE_RULE, normalizePeople,
} from './identities';
import { normalizeNationality } from './nationalities';
import { RO_ID_PROMPT, normalizeRoId, roIdToRecordFields } from './roIdDocuments';
import { AUTHORITY_RULE } from './docAuthority';

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

async function ocrImageBlob(blob, { cloud = false } = {}) {
  const canvas = await decodeToCanvas(blob);
  return recognizeCanvas(canvas, undefined, { cloud });
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
  'email', 'phone', 'phoneLandline', 'fax', 'website',
];

// The people behind a firm, asked for alongside its own details. A Romanian
// company document states them in a table (asociați / acționari with their cota
// and the value of their shares) or in a clause of the articles; either way it
// is the part a lawyer copies out by hand today, which is exactly what is worth
// reading for them.
const PEOPLE_SPEC = [
  '- people: the persons and companies BEHIND this firm, as a JSON array. One object per person:',
  '    { "role": "", "name": "", "nationalId": "", "sharePct": "", "shareValue": "", "shares": "" }',
  '    role is what they are to the firm, in Romanian: Asociat, Asociat unic, Acționar, Administrator, Asociat administrator, Director, Cenzor, Auditor, Împuternicit, Beneficiar real.',
  '    name is written as the document writes it. nationalId is the CNP for a person or the CUI for a company — whichever the document gives, verbatim.',
  '    sharePct is the participation in the capital ("cota de participare"), digits only ("60" for 60%). shareValue is the value of their shares in lei, EXACTLY as printed ("30.000"). shares is the number of părți sociale / acțiuni.',
  '    Leave a key "" when the document does not state it, and return [] when it names nobody. Never invent a person, a CNP or a percentage.',
  '- phone is the mobile number, phoneLandline the fixed one ("telefon fix"), fax the fax number, email the GENERAL address, website the site. Keep each number as printed.',
  '- contacts: every OTHER way of reaching the company, as a JSON array of { "label": "", "value": "" } — a departmental e-mail ("Email departament financiar"), a second telephone ("Telefon secretariat"), another fax. label is the document\'s own wording without its letter or number, value is the address or number. Return [] when there are none, and never repeat one already given as email / phone / phoneLandline / fax / website.',
].join('\n');

function autofillPrompt(kind, text) {
  const shape = Object.fromEntries(AUTOFILL_KEYS.map((k) => [k, '']));
  if (kind === 'org') { shape.people = []; shape.contacts = []; } else shape.ro_id = {};
  return [
    kind === 'org'
      ? 'The text below was read off a Romanian company document — a certificat de înregistrare, a CUI certificate, an act constitutiv / articles of association, a trade-register extract (furnizare de informații) or similar.'
      : 'The text below was read off a photograph of a Romanian identity or travel document (carte de identitate, passport, permis de ședere or similar).',
    '',
    'Return ONE JSON object, nothing else — no prose, no code fence. Use exactly these keys:',
    JSON.stringify(shape, null, 0),
    '',
    'Rules:',
    ...(kind === 'org' ? [PEOPLE_SPEC] : [RO_ID_PROMPT]),
    '- Copy values VERBATIM. Leave a key as "" when the text does not state it. Never guess.',
    `- ${AUTHORITY_RULE}`,
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

// A PERSON's reading, checked and completed (lib/roIdDocuments): the model's
// `ro_id`, the text's own labels, the CNP and the machine-readable strip read
// against each other. What the record lacks is filled from it — the birth date
// and sex from the CNP, the series and number from the strip — and every
// disagreement comes back in `roId.warnings`.
function completePerson(parsed, text, fields) {
  const roId = normalizeRoId(parsed?.ro_id, text);
  for (const [k, v] of Object.entries(roIdToRecordFields(roId))) {
    if (!fields[k]) fields[k] = readValue(k, v);
  }
  return roId;
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
    text = await ocrImageBlob(imageBlob, { cloud: isCloudMediaAllowed(projectId || undefined) });
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
  const roId = (record?.kind || 'person') === 'person' ? completePerson(parsed, text, fields) : null;
  // EVERYTHING it read, including values the record already has. Nothing here
  // is applied: the form shows each reading under the field it belongs to and
  // waits to be told. So a value that DISAGREES with what is already typed is
  // the most useful thing this can hand back — dropping it, as this used to,
  // hid the one case worth a person's attention. The caller decides what to
  // show; overwriting is still never automatic.
  return { fields, text, roId };
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

async function ocrPdfPages(blob, { cloud = false } = {}) {
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
      const text = await recognizeCanvas(canvas, undefined, { cloud });
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
// `cloudOcr` — send pictures and scanned pages to the AI's OCR. Left out, the
// project's cloud-media switch decides (lib/cloudMedia, OFF by default): off,
// they are read on this computer by PaddleOCR.
export async function readSourceText(blob, name, { path, force = false, projectId, cloudOcr } = {}) {
  const cloud = cloudOcr ?? isCloudMediaAllowed(projectId || undefined);
  if (!blob) return { error: 'no_image' };
  const kind = identitySourceKind(name, blob.type || '');
  if (kind === 'media') return { error: 'media' };
  if (kind === 'identity') return { error: 'identity' };
  const stamp = path ? await stampFor(path) : null;
  const saved = path && !force ? bestTextFor(path, stamp) : '';
  const keep = (text) => {
    if (path && text.trim()) saveAiFacet({ path, name, projectId }, 'ocr', { data: { text }, engine: cloud ? 'claude' : 'paddleocr', stamp });
    return text.trim() ? { text } : { error: 'no_text' };
  };
  try {
    if (kind === 'image') {
      if (saved) return { text: saved, cached: true };
      return keep(await ocrImageBlob(blob, { cloud }));
    }
    if (kind === 'pdf') {
      const layer = await extractFileText(blob, name);
      if (layer?.text && layer.text.replace(/\s+/g, '').length > 40) return { text: layer.text };
      // No text layer worth the name: it is a scan.
      if (saved) return { text: saved, cached: true };
      return keep(await ocrPdfPages(blob, { cloud }));
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
      return {
        fields: known.data.fields,
        people: normalizePeople(known.data.people),
        contacts: Array.isArray(known.data.contacts) ? known.data.contacts : [],
        read: [only.name],
        skipped: [],
        cached: true,
      };
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
  // The firm's people come back as their own list, not as a field: they are
  // rows of a table, and the pane offers them one by one like every other
  // reading rather than writing them into the record behind the reader.
  const people = kind === 'org' ? normalizePeople(parsed.people) : [];
  const roId = kind === 'person' ? completePerson(parsed, joined, fields) : null;
  // The further ways to reach them, in the document's own words.
  const contacts = kind === 'org' && Array.isArray(parsed.contacts)
    ? parsed.contacts
      .filter((c) => c && typeof c === 'object')
      .map((c, i) => ({ id: `k${i}_${Math.random().toString(36).slice(2, 7)}`, label: String(c.label || '').trim(), value: String(c.value || '').trim() }))
      .filter((c) => c.value)
    : [];
  // Saved for next time: this file, read into a record of this kind, said this.
  if (only && (Object.keys(fields).length || people.length || contacts.length)) {
    saveAiFacet({ path: only.path, name: only.name, projectId }, 'identity',
      { data: { kind, fields, people, contacts, roId }, engine: 'claude', stamp: await stampFor(only.path) });
  }
  return { fields, people, contacts, roId, text: joined, read: texts.map((t) => t.name), skipped };
}
