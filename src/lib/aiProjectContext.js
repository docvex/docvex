// Full-project context for the AI advisor (/ai) — gathers EVERYTHING the app
// knows about a project into one compact text digest the model can read:
//
//   • the project card (name, description, admin AI notes from ai_context)
//   • members + roles                     (Supabase)
//   • the local-folder file inventory     (names, folders, sizes, dates)
//   • cached per-file AI descriptions     (lib/aiFileIndex)
//   • the team chat                       (chat_messages; DMs stay private)
//   • the case timeline                   (lib/caseTimeline)
//   • OCR text snippets                   (lib/extractionHistory)
//   • audio/video captions (transcripts)  (lib/captionsHistory)
//   • extracted file metadata             (lib/metadataHistory)
//   • saved AI data — text read off pictures / scans (lib/aiData)
//   • every DATA COLLECTION (.dvc) in full — summary, facts, the record,
//     timeline, sources, connections, the web of names and linked collections
//   • what the AI scan UNDERSTOOD of each file (the `understanding` facet)
//
// The advisor is meant to answer ANY question about the project's files from
// this — "I don't have access to that file" must never be the answer to
// something the app has already read.
//
// Everything is size-capped per section and overall, so the digest stays a
// bounded prefix on the model turn rather than an unbounded dump. Sources
// that fail (offline, RLS, quota) are skipped silently — the digest is
// best-effort by design.

import { listChatMessages } from './chat';
import { listMembers } from './projects';
import { loadCaseTimeline } from './caseTimeline';
import { listOcrHistories } from './extractionHistory';
import { loadCaptions } from './captionsHistory';
import { loadMetadata } from './metadataHistory';
import { describedText } from './aiFileIndex';
import { bestTextFor, getAiFacet } from './aiData';
import { documentAuthority } from './docAuthority';
import { readLocalBlob } from './localFolder';

// Per-section character budgets (≈ tokens ÷ 4). Generous but bounded.
const CAP = {
  files: 5000,
  chat: 6000,
  timeline: 5000,
  snippets: 4000,
  captions: 6000,
  metadata: 3000,
  aiData: 12000,
  collections: 40000,
  understanding: 20000,
  total: 110000,
};

const clip = (s, n) => {
  const t = String(s || '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const day = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return ''; }
};
const dayTime = (iso) => {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch { return ''; }
};
const fmtBytes = (b) => {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
const profileName = (p) => p?.full_name || p?.name || p?.email || null;

// Build one "# Heading" section, truncated to its budget. Returns '' when the
// body is empty so absent sources vanish instead of leaving hollow headings.
function section(title, body, cap) {
  const text = String(body || '').trim();
  if (!text) return '';
  const cut = text.length > cap;
  return `# ${title}\n${cut ? `${text.slice(0, cap)}\n…[section truncated]` : text}`;
}

function filesSection(files) {
  if (!files?.length) return '';
  const lines = files.map((f) => {
    const loc = f.folderPath ? `${f.folderPath}/` : '';
    const desc = describedText(f);
    const bits = [fmtBytes(f.sizeBytes), f.mtimeIso ? `modified ${day(f.mtimeIso)}` : null].filter(Boolean).join(', ');
    return `- ${loc}${f.name} (${bits})${desc ? ` — ${clip(desc, 200)}` : ''}`;
  });
  return `${files.length} file(s) in the project's local folder:\n${lines.join('\n')}`;
}

function membersSection(members) {
  if (!members?.length) return '';
  return members
    .map((m) => `- ${profileName(m.profile) || m.user_id} — ${m.role}`)
    .join('\n');
}

function chatSection(messages, nameById) {
  const live = (messages || []).filter((m) => !m.deleted_at && (m.body || '').trim());
  if (!live.length) return '';
  const lines = live.map((m) => {
    const who = nameById.get(m.author_id) || 'Member';
    const pin = m.pinned_at ? ' [pinned]' : '';
    return `[${dayTime(m.created_at)}] ${who}${pin}: ${clip(m.body, 280)}`;
  });
  return `Last ${live.length} team-chat message(s), oldest first (private DMs are not shared):\n${lines.join('\n')}`;
}

function timelineSection(timeline) {
  if (!timeline?.events?.length) return '';
  const out = [];
  if (timeline.lede) out.push(clip(timeline.lede, 400));
  for (const ev of timeline.events.slice(0, 40)) {
    const when = [ev.d, ev.y].filter(Boolean).join(' ');
    const files = Array.isArray(ev.files) && ev.files.length ? ` (files: ${ev.files.slice(0, 4).join(', ')})` : '';
    out.push(`- ${when ? `[${when}] ` : ''}${ev.title || ''}${ev.body ? ` — ${clip(ev.body, 220)}` : ''}${files}`);
  }
  return out.join('\n');
}

function snippetsSection(projectFiles) {
  // OCR histories are keyed by full file path — keep only this project's.
  const byPath = new Set(projectFiles.map((f) => f.path).filter(Boolean));
  const byName = new Set(projectFiles.map((f) => f.name));
  const all = listOcrHistories().filter((h) => byPath.has(h.filePath) || byName.has(h.fileName));
  if (!all.length) return '';
  const out = [];
  for (const h of all.slice(0, 12)) {
    out.push(`## ${h.fileName}`);
    for (const e of h.entries.slice(0, 4)) out.push(`- "${clip(e.text, 400)}"`);
  }
  return `Text the user extracted from files with the OCR tool:\n${out.join('\n')}`;
}

function captionsSection(projectFiles) {
  const out = [];
  for (const f of projectFiles) {
    if (!f.path) continue;
    const cap = loadCaptions(f.path);
    if (!cap?.text) continue;
    out.push(`## ${f.name}${cap.language ? ` (${cap.language})` : ''}\n${clip(cap.text, 1800)}`);
    if (out.length >= 8) break;
  }
  return out.length ? `AI transcripts (captions) of the project's audio/video files:\n${out.join('\n')}` : '';
}

// What has already been read off the project's pictures and scans (the Doc
// Viewer's Extract text, the identity reader's transcriptions) — saved once in
// lib/aiData, quoted here for free.
function aiDataSection(projectFiles) {
  const out = [];
  for (const f of projectFiles) {
    if (!f.path) continue;
    const text = bestTextFor(f.path);
    if (!text) continue;
    out.push(`## ${f.name}\n${clip(text, 1200)}`);
    if (out.length >= 12) break;
  }
  return out.length ? `Text already read from the project's pictures and scanned documents:\n${out.join('\n')}` : '';
}

function metadataSection(projectFiles) {
  const out = [];
  for (const f of projectFiles) {
    if (!f.path) continue;
    const meta = loadMetadata(f.path);
    if (!meta?.groups?.length) continue;
    const facts = [];
    for (const g of meta.groups) {
      for (const r of (g.rows || [])) {
        if (r?.label && r.value != null && r.value !== '') facts.push(`${r.label}: ${clip(r.value, 80)}`);
        if (facts.length >= 12) break;
      }
      if (facts.length >= 12) break;
    }
    if (facts.length) out.push(`## ${f.name}\n${facts.join(' · ')}`);
    if (out.length >= 15) break;
  }
  return out.length ? `Extracted file metadata:\n${out.join('\n')}` : '';
}

// ── Data collections ─────────────────────────────────────────────────────
// A collection file (.dvc, JSON — lib/dataCollections) rendered as READABLE
// TEXT, whole: what the AI gathered about one subject and where each thing came
// from. Read here straight off the file (no dependency on the scan module).
const isCollectionName = (name) => /\.dvc$/i.test(String(name || ''));
const RECORD_SKIP = new Set(['kind', 'id', 'people', 'contacts', 'photo', 'photos', 'avatar']);
export function collectionToText(doc, name = '') {
  if (!doc || typeof doc !== 'object') return '';
  const out = [];
  out.push(`## ${doc.title || name || 'Data collection'}${name ? ` (file: ${name})` : ''}`);
  if (doc.subject) out.push(`Subject: ${doc.subject}`);
  if (doc.summary) out.push(`Summary: ${doc.summary}`);
  const rec = doc.record && typeof doc.record === 'object' ? doc.record : null;
  if (rec) {
    const bits = Object.entries(rec)
      .filter(([k, v]) => !RECORD_SKIP.has(k) && v != null && typeof v !== 'object' && String(v).trim())
      .map(([k, v]) => `${k}: ${String(v).trim()}`);
    out.push(`Record (${rec.kind === 'org' ? 'company / persoană juridică' : 'person / persoană fizică'}): ${bits.join(' · ') || '(empty)'}`);
    const people = Array.isArray(rec.people) ? rec.people.filter((pp) => pp?.name) : [];
    if (people.length) out.push(`People in the company: ${people.map((pp) => `${pp.name}${pp.role ? ` (${pp.role})` : ''}${pp.sharePct ? ` ${pp.sharePct}%` : ''}`).join('; ')}`);
    const contacts = Array.isArray(rec.contacts) ? rec.contacts.filter((c) => c?.value) : [];
    if (contacts.length) out.push(`Contacts: ${contacts.map((c) => `${c.label || 'contact'}: ${c.value}`).join('; ')}`);
  }
  const facts = Array.isArray(doc.facts) ? doc.facts : [];
  if (facts.length) {
    out.push('Facts:');
    for (const f of facts) if (f?.label) out.push(`- ${f.label}: ${f.value || ''}${Array.isArray(f.sources) && f.sources.length ? ` [from ${f.sources.slice(0, 3).join(', ')}]` : ''}`);
  }
  const tl = Array.isArray(doc.timeline) ? doc.timeline : [];
  if (tl.length) {
    out.push('Timeline:');
    for (const t of tl) if (t?.event) out.push(`- ${t.date ? `[${t.date}] ` : ''}${t.event}`);
  }
  const src = Array.isArray(doc.sources) ? doc.sources : [];
  if (src.length) {
    out.push('Source files:');
    for (const x of src) if (x?.name) out.push(`- ${x.rel || x.name}${x.role ? ` — ${x.role}` : ''}${x.understood ? ` — understood: ${clip(x.understood, 600)}` : ''}`);
  }
  const con = Array.isArray(doc.connections) ? doc.connections : [];
  if (con.length) {
    out.push('How the files connect:');
    for (const k of con) if (k?.from && k?.to) out.push(`- ${k.from} <-> ${k.to}${k.why ? `: ${k.why}` : ''}`);
  }
  const ents = Array.isArray(doc.entities) ? doc.entities.map((e) => e?.name).filter(Boolean) : [];
  if (ents.length) out.push(`Names held: ${ents.join(', ')}`);
  const rel = Array.isArray(doc.related) ? doc.related : [];
  if (rel.length) out.push(`Linked collections: ${rel.map((r) => `${r.title || r.file}${Array.isArray(r.names) && r.names.length ? ` (shared: ${r.names.slice(0, 4).join(', ')})` : ''}`).join('; ')}`);
  // Face matches (biometric, V12) are never sent to the AI.
  return out.join('\n');
}

export async function readCollectionText(path, name) {
  try {
    const blob = await readLocalBlob(path);
    if (!blob) return '';
    return collectionToText(JSON.parse(await blob.text()), name);
  } catch { return ''; }
}

async function collectionsSection(projectFiles) {
  const cols = projectFiles.filter((f) => f.path && isCollectionName(f.name)).slice(0, 40);
  const out = [];
  for (const f of cols) {
    const text = await readCollectionText(f.path, f.name);
    if (text) out.push(clip(text, 6000));
  }
  return out.length ? `The project's DATA COLLECTIONS — everything the AI scan gathered, one subject each:\n${out.join('\n\n')}` : '';
}

// What the AI scan understood of each file (summary, facts, names, dates).
function understandingSection(projectFiles) {
  const out = [];
  for (const f of projectFiles) {
    if (!f.path) continue;
    const u = getAiFacet(f.path, 'understanding')?.data;
    if (!u) continue;
    const bits = [];
    // How official the document is (lib/docAuthority) — what decides between
    // files that disagree about a person or a company.
    bits.push(`Official: ${documentAuthority({ name: f.name, u }).label}${u.documentType ? ` · ${u.documentType}` : ''}`);
    if (u.summary) bits.push(clip(u.summary, 500));
    const facts = Array.isArray(u.facts) ? u.facts : [];
    if (facts.length) bits.push(`Facts: ${facts.slice(0, 12).map((x) => (typeof x === 'string' ? x : `${x?.label || ''}${x?.value ? `: ${x.value}` : ''}`)).filter(Boolean).join('; ')}`);
    const ents = Array.isArray(u.entities) ? u.entities : [];
    if (ents.length) bits.push(`Names: ${ents.slice(0, 12).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean).join(', ')}`);
    const dates = Array.isArray(u.dates) ? u.dates : [];
    if (dates.length) bits.push(`Dates: ${dates.slice(0, 8).map((x) => (typeof x === 'string' ? x : [x?.date, x?.event].filter(Boolean).join(' '))).filter(Boolean).join('; ')}`);
    if (u.idDocument?.holder) bits.push(`Identity document of ${u.idDocument.holder}${u.idDocument.type ? ` (${u.idDocument.type})` : ''}`);
    // The checked reading of an identity document (lib/roIdDocuments).
    const r = u.roId;
    if (r && (r.cnp || r.document_number || r.passport_number)) {
      bits.push(`ID reading: ${[r.document_type, r.document_series && `seria ${r.document_series}`, r.document_number && `nr. ${r.document_number}`, r.passport_number && `pașaport ${r.passport_number}`, r.cnp && `CNP ${r.cnp}`, r.birth_date && `născut ${r.birth_date}`, r.expiry_date && `valabil până la ${r.expiry_date}${r.expired ? ' (EXPIRAT)' : ''}`].filter(Boolean).join(', ')}${Array.isArray(r.warnings) && r.warnings.length ? ` — warnings: ${r.warnings.slice(0, 4).join(' ')}` : ''}`);
    }
    // The law of the document's time (lib/legalHistory).
    const h = u.legalHistory;
    if (h?.detected_era) {
      bits.push(`Legal era: ${h.era_label}${h.year ? ` (dated ${h.year})` : ''}${h.property_status_risks?.length ? ` — title risks: ${h.property_status_risks.map((x) => x.risk_type).join(', ')}` : ''}${h.decrees?.length ? ` — cites ${h.decrees.map((d) => d.key).join(', ')}` : ''}${h.surface_conversions?.length ? ` — surfaces: ${h.surface_conversions.slice(0, 4).map((x) => `${x.original_value} ≈ ${x.calculated_square_meters} m²`).join('; ')}` : ''}`);
    }
    if (bits.length) out.push(`## ${f.folderPath ? `${f.folderPath}/` : ''}${f.name}\n${bits.join('\n')}`);
    if (out.length >= 80) break;
  }
  return out.length ? `What the AI scan understood of each file:\n${out.join('\n')}` : '';
}

// Build the digest. `project` is the selected project row; `files` is the
// recursive local-folder listing ({ name, path, folderPath, sizeBytes,
// mtimeIso }). Network sources load in parallel; every source is optional.
export async function buildProjectDigest({ project, files = [] }) {
  if (!project?.id) return '';
  const [membersRes, chatRes] = await Promise.all([
    listMembers(project.id).catch(() => ({ data: [] })),
    listChatMessages(project.id, { limit: 60 }).catch(() => ({ data: [] })),
  ]);
  const members = membersRes?.data || [];
  const nameById = new Map(members.map((m) => [m.user_id, profileName(m.profile)]));

  const projectCard = [
    `Name: ${project.name || 'Untitled'}`,
    project.description ? `Description: ${clip(project.description, 600)}` : null,
    project.created_at ? `Created: ${day(project.created_at)}` : null,
    project.ai_context ? `Admin notes for the AI:\n${clip(project.ai_context, 1500)}` : null,
  ].filter(Boolean).join('\n');

  const sections = [
    section('Project', projectCard, 2500),
    section('Members', membersSection(members), 1500),
    section('Files', filesSection(files), CAP.files),
    section('Team chat', chatSection(chatRes?.data, nameById), CAP.chat),
    section('Case timeline', timelineSection(loadCaseTimeline(project.id)), CAP.timeline),
    section('Extracted text snippets (OCR)', snippetsSection(files), CAP.snippets),
    section('Audio/video captions', captionsSection(files), CAP.captions),
    section('File metadata', metadataSection(files), CAP.metadata),
    section('Text read from pictures and scans', aiDataSection(files), CAP.aiData),
    section('Data collections', await collectionsSection(files), CAP.collections),
    section('File understandings (AI scan)', understandingSection(files), CAP.understanding),
  ].filter(Boolean);

  const body = sections.join('\n\n');
  return body.length > CAP.total ? `${body.slice(0, CAP.total)}\n…[context truncated]` : body;
}

// ── Only what the question needs (V9, 2026-09-29) ─────────────────────────
// The full digest (up to 110k characters — every collection, every file's
// understanding, the team chat) used to ride on every question. GDPR Art.
// 5(1)(c): send what the question needs. `focusDigest` keeps the project card
// and a short file list, then the ITEMS (a `## ` block, or a chat line) that
// share words, names or numbers with the question, best first, within
// `budget`. A question naming nothing in particular ("rezumă dosarul") gets
// the collections' and understandings' opening lines instead of everything.
const STOP = new Set('care este sunt pentru despre dintre acest aceasta aceste acesta unde cand cine cum ceva toate toti dosar dosarul fisier fisierul fisiere document documentul documente proiect proiectul what which where when with from that this have about into their there file files document documents project please spune zice poti vreau'.split(' '));
const foldWord = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function termsOf(text) {
  const out = new Set();
  for (const w of foldWord(text).match(/[\p{L}\p{N}]{3,}/gu) || []) if (!STOP.has(w)) out.add(w);
  return out;
}
function scoreItem(item, terms) {
  if (!terms.size) return 0;
  const words = termsOf(item);
  let s = 0;
  for (const t of terms) {
    if (words.has(t)) s += /\d/.test(t) ? 3 : 1;
    else if (t.length >= 5) for (const w of words) if (w.startsWith(t.slice(0, 5))) { s += 0.5; break; }
  }
  return s;
}
export function focusDigest(digest, question, { budget = 28000 } = {}) {
  const text = String(digest || '');
  if (!text || text.length <= budget) return text;
  const terms = termsOf(question);
  const sections = text.split(/\n(?=# )/);
  const keep = [];
  const items = [];
  for (const sec of sections) {
    const nl = sec.indexOf('\n');
    const head = nl < 0 ? sec : sec.slice(0, nl);
    const body = nl < 0 ? '' : sec.slice(nl + 1);
    if (head === '# Project') { keep.push(sec); continue; }
    if (head === '# Files') { keep.push(`${head}\n${body.slice(0, 2500)}${body.length > 2500 ? '\n…[list shortened]' : ''}`); continue; }
    const parts = head === '# Team chat' ? body.split('\n') : body.split(/\n(?=## )/);
    parts.forEach((p, i) => { if (p.trim()) items.push({ head, p, i, s: scoreItem(p, terms) }); });
  }
  let used = keep.join('\n\n').length;
  const chosen = [];
  const matched = items.filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const pool = matched.length ? matched
    // Nothing named: the openings of what the AI worked out, not the raw text.
    : items.filter((x) => x.head === '# Data collections' || x.head === '# File understandings (AI scan)')
      .map((x) => ({ ...x, p: x.p.slice(0, 600) }));
  for (const x of pool) {
    if (used + x.p.length + 2 > budget) continue;
    chosen.push(x);
    used += x.p.length + 2;
  }
  const byHead = new Map();
  for (const x of chosen.sort((a, b) => a.i - b.i)) {
    if (!byHead.has(x.head)) byHead.set(x.head, []);
    byHead.get(x.head).push(x.p);
  }
  const out = [...keep];
  for (const [head, ps] of byHead) out.push(`${head}\n${ps.join(head === '# Team chat' ? '\n' : '\n\n')}`);
  out.push('[Only the parts of the project relevant to this question are included.]');
  return out.join('\n\n');
}
