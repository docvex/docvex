import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useAuth } from '../../context/AuthContext';
import { glyphForFile } from '../../components/fileGlyph';
import FileThumbnail from '../../components/FileThumbnail';
import { extractFileText } from '../../lib/extractFileText';
import { recognizeCanvas, OCR_MAX_EDGE } from '../../lib/ocr';
import { transcribeAudio } from '../../lib/transcribe';
import { runTimelineCouncil, DISPUTE_OPTIONS } from '../../lib/timelineCouncil';
import { toLayoutPx } from '../../lib/appZoom';
import { openDocViewerWindow, pathForFile } from '../../lib/platform';
import { loadCaseTimeline, saveCaseTimeline } from '../../lib/caseTimeline';
import './ProjectScoped.css';
import './ProjectEvents.css';
// The council backdrop reuses the Files tab's fx-grid / fx-tile styling —
// imported here so the classes exist even before the Files page ever loads.
import '../../components/FilesWorkspace.css';

// Case Timeline — onboarding tab (Claude Design "Case Timeline Onboarding",
// option 1b with option 1a's masthead header + horizontal step rail). The
// flow walks the attorney through Upload → Scanning → Timeline → Review:
// upload/scanning/review render option 1a's step bodies; the Timeline step
// renders option 1b's "narrative dossier" (editorial drop-cap lede, date
// gutter + rail, AI flags as margin annotations).
//
// Everything below is STATIC SAMPLE DATA for the demo matter (Aedificia
// Construct SRL v. Veridian Logistics SA) — per the design-handoff
// convention: placeholder content, not omission.

// ── Icons (inline JSX per app convention — stroke: currentColor) ──────────
const IcoCheck = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M20 6 9 17l-5-5" /></svg>
);
const IcoX = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M18 6 6 18M6 6l12 12" /></svg>
);
const IcoUpload = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
);
const IcoDoc = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
);
const IcoArrow = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
const IcoAlert = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
);
const IcoPlay = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...props}><polygon points="5 3 19 12 5 21 5 3" /></svg>
);
// Council-chamber glyphs (Claude Design "AI Council" bundle).
const IcoUser = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5c1.4-3.4 4.2-5 7.5-5s6.1 1.6 7.5 5" /></svg>
);
const IcoGavel = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="m14 13-7.5 7.5a2.12 2.12 0 0 1-3-3L11 10" /><path d="m16 16 6-6" /><path d="m8 8 6-6" /><path d="m9 7 8 8" /><path d="m21 11-8-8" /></svg>
);
const IcoPen = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
);
const IcoChat = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
);
const IcoAsk = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
);
const IcoInfo = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="12" cy="12" r="10" /><path d="M12 16v-5M12 8h.01" /></svg>
);
const IcoSearch = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
);
// ── Sample data (verbatim from the design bundle) ─────────────────────────
const STEPS = [
  { id: 'upload', n: '1', label: 'Upload files' },
  { id: 'scan', n: '2', label: 'Scanning' },
  { id: 'timeline', n: '3', label: 'Timeline' },
  { id: 'review', n: '4', label: 'Review' },
];

// ── Council chamber (Scanning step) — Claude Design "AI Council" ──────────
// The Scanning step renders the council LIVE: files reading in on the left,
// the four members around the ring (Chair presiding, three analysts), the
// task rail on the right, a decision log below, and a real "the council needs
// your input" panel when the analysts' drafts disagree. Every bubble, stat
// and log entry is driven by real pipeline events (lib/timelineCouncil's
// onEvent stream) — no scripted theatre outside the debug simulator.

// Task rail — real pipeline milestones (statuses: queued / working / done).
const COUNCIL_TASKS = [
  { id: 'read', label: 'Read source files' },
  { id: 'extract', label: 'Extract key facts' },
  { id: 'draft', label: 'Analysts draft chronologies' },
  { id: 'vote', label: 'Debate & vote on beats' },
  { id: 'dispute', label: 'Cross-check disagreements' },
  { id: 'merge', label: 'Chair merges the story' },
  { id: 'save', label: 'Save & hand off' },
];

// Council seating + identity colours (fixed identities like the avatar
// palette — not theme tokens on purpose; the design keys each member to one
// colour across bubbles, fact chips and log dots). Seating follows the
// author's sketch: the Chair presides at the apex, the three analysts fan
// out below (left · bottom-centre · right); a dashed mesh (.cc-mesh)
// connects every seat to every other.
const COUNCIL_UI = [
  // The Chair wears the brand palette's yellow (sand); the analysts get
  // neon-leaning identities — cyan / pink / lime — picked to be instantly
  // distinguishable from each other, the chair, and the packet colours.
  { id: 'chair', name: 'The Chair', role: 'Presiding', color: '#DCC9A3', x: 280, y: 60, bubblePos: 'right' },
  { id: 'chronologist', name: 'Chronologist', role: 'Dates & record', color: '#06B6D4', x: 85, y: 330, bubblePos: 'top-left' },
  { id: 'narrator', name: 'Narrator', role: 'Causal story', color: '#EC4899', x: 475, y: 330, bubblePos: 'top-right' },
  { id: 'auditor', name: 'Auditor', role: 'Contradictions', color: '#84CC16', x: 280, y: 435, bubblePos: 'right' },
];
const COUNCIL_COLORS = Object.fromEntries(COUNCIL_UI.map((m) => [m.id, m.color]));
const MEMBER_BY_COLOR = Object.fromEntries(COUNCIL_UI.map((m) => [m.color, m.id]));
const COUNCIL_BY_ID = Object.fromEntries(COUNCIL_UI.map((m) => [m.id, m]));
// Member glyph — the presiding chair wears the gavel, analysts the person
// icon. Used everywhere a member marker renders (chamber avatar, decision
// log, proposal badges) so the chair reads the same across surfaces.
const memberIcon = (id) => (id === 'chair' ? IcoGavel : IcoUser);

// Packets must ride the DRAWN lines. Per the author's sketch the chair has
// DIRECT dashed diagonals to each side analyst plus the straight line down
// to the auditor (crossing the analysts' horizontal); only the two bottom
// edges are special — curves that bow downward like a table's near side.
const SPECIAL_EDGES = {
  'chronologist|auditor': { d: 'M 85 330 Q 172 452 280 435', start: 'chronologist' },
  'narrator|auditor': { d: 'M 475 330 Q 388 452 280 435', start: 'narrator' },
};
function packetPath(fromId, toId) {
  const edge = SPECIAL_EDGES[`${fromId}|${toId}`] || SPECIAL_EDGES[`${toId}|${fromId}`];
  if (edge) return { d: edge.d, reverse: edge.start !== fromId };
  const a = COUNCIL_BY_ID[fromId];
  const b = COUNCIL_BY_ID[toId];
  return { d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`, reverse: false };
}
// Every shape the "We have a question…" modal supports — mirrors the Doc
// Viewer ask_user panel's response types (single select, multi select,
// confirm, free text). The debug "ask variations" button cycles these.
const ASK_VARIATIONS = [
  {
    kind: 'single',
    question: 'The analysts disagree on the record.',
    context: 'Chronologist drafted 12 events (1 flag) · Narrator drafted 8 events (0 flags) · Auditor drafted 13 events (4 flags). How should the Chair weigh the drafts?',
    options: DISPUTE_OPTIONS,
  },
  {
    kind: 'multi',
    question: 'Which sources should the council lean on?',
    context: 'Pick every source the story may treat as authoritative — the rest stay corroborating material only.',
    options: [
      { id: 'contract', label: 'The framework agreement', desc: 'Signed 14 Mar 2023 · €120k scope.' },
      { id: 'emails', label: 'The email thread', desc: 'Tone shift and the 9 Jun escalation.' },
      { id: 'ledger', label: 'The invoice ledger', desc: 'Payment stops and invoice #204.' },
      { id: 'notes', label: 'The site notes', desc: 'Dated delay entries from 12 May.' },
    ],
  },
  {
    kind: 'confirm',
    question: 'Cut the unverified June beat from the story?',
    context: 'The Auditor could not reconcile the 9 Jun email against the ledger. The chair can cut the beat or keep it flagged.',
    options: [
      { id: 'yes', label: 'Yes, cut it', desc: 'The beat leaves the story until verified.' },
      { id: 'no', label: 'No, keep it flagged', desc: 'It stays, marked as unverified.' },
    ],
  },
  {
    kind: 'text',
    question: 'Anything the council should know before the merge?',
    context: 'Free direction — the chair reads your note verbatim while assembling the final cut.',
  },
];

// Legend for the mesh travellers — rendered as a vertical key to the right
// of the council graph.
const PACKET_LEGEND = [
  { icon: 'doc', label: 'Source material', desc: 'the brief or file pages handed out by the chair' },
  { icon: 'pen', label: 'Draft pages', desc: 'an analyst’s work riding back to the chair' },
  { icon: 'fact', label: 'Extracted fact', desc: 'a finding pulled out of a source file' },
  { icon: 'chat', label: 'Discussion', desc: 'direction, chatter and clarifications' },
  { icon: 'flag', label: 'Raised flag', desc: 'a gap or contradiction spotted in the record' },
  { icon: 'ask', label: 'Open question', desc: 'the council needs a call' },
  { icon: 'ok', label: 'Approved', desc: 'a draft or beat accepted' },
  { icon: 'no', label: 'Declined', desc: 'an objection or rejection' },
];

// Every packet type carries its own identity colour (like the council
// seats) — applied through the --pk-c custom property on both the
// travelling packets and the legend, so the two can never drift apart.
const PACKET_COLORS = {
  doc: 'var(--accent)',
  pen: '#4F46E5',
  fact: '#0D9488',
  chat: '#0369A1',
  flag: 'var(--warning)',
  ask: 'var(--text-muted)',
  ok: 'var(--success)',
  no: 'var(--danger)',
};
function packetGlyph(icon) {
  const Icon = icon === 'pen' ? IcoPen
    : icon === 'chat' ? IcoChat
    : icon === 'ask' ? IcoAsk
    : icon === 'ok' ? IcoCheck
    : icon === 'no' ? IcoX
    : icon === 'flag' ? IcoAlert
    : icon === 'fact' ? IcoSearch
    : IcoDoc;
  return { Icon, color: PACKET_COLORS[icon] || 'var(--accent)' };
}

// What each analyst "says" while their draft call is in flight.
const MEMBER_WORKING_LINE = {
  chronologist: 'Scanning the record for anchor dates…',
  narrator: 'Reading for tone and turning points…',
  auditor: 'Cross-checking amounts, dates and gaps…',
};
// Neutral log-dot colours (member entries use the member's own colour).
const LOG_INFO = '#64748B';
const LOG_OK = '#15803D';
const LOG_BAD = '#B91C1C';
const LOG_WARN = '#B45309';
const LOG_STEER = '#8B5E3C';

// Debug-scan fallback when nothing was uploaded — enough items (15) to
// spill past two grid rows and demo the multi-row layout.
const FALLBACK_SCAN_FILES = [
  'Framework agreement.pdf',
  'Annex 2 — delivery schedule.pdf',
  'Notice of default.docx',
  'Technical expert report.pdf',
  'Statement of defence — Veridian.pdf',
  'E-mail correspondence 2024.pdf',
  'Site_inspection_09122023.mp4',
  'Invoice AV-0442.pdf',
  'Acceptance report Lot 1.pdf',
  'Meeting minutes 2023-11-02.docx',
  'Penalty calculation.xlsx',
  'Photo_Lot2_cracks_01.jpg',
  'Photo_Lot2_cracks_02.jpg',
  'Witness statement — M. Radu.docx',
  'Call recording 2024-01-12.m4a',
].map((name) => ({ name, mime: '', url: '' }));

// Minimal extension → MIME guess so glyphForFile can pick the right icon for
// items that don't carry a real MIME (the debug fallback set). DOCX / XLSX /
// PPTX / audio are already extension-matched inside glyphForFile itself.
function guessMimeFromName(name) {
  const lc = (name || '').toLowerCase();
  if (lc.endsWith('.pdf')) return 'application/pdf';
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lc)) return 'image/*';
  if (/\.(mp4|mov|mkv|webm|avi)$/.test(lc)) return 'video/*';
  if (/\.(txt|md|csv)$/.test(lc)) return 'text/plain';
  return '';
}

// ── Real timeline pipeline ─────────────────────────────────────────────────
// Upload → per-file understanding (drives the scan grid):
//   documents  — text extraction (lib/extractFileText)
//   photos     — Claude vision reads the image (lib/ocr → doc-ai `ocr`)
//   videos     — the audio track is extracted in-renderer and captioned by
//                Whisper (lib/transcribe), then sampled into timestamped KEY
//                SECTIONS for the council
//   audio      — Whisper captions with timestamps
// → the AI COUNCIL (lib/timelineCouncil): three analysts draft independent
// chronologies in parallel, a chair merges them into one strict-JSON timeline
// (draft disagreements become Contradiction flags) → normalised + persisted
// per project. Media the AI can't understand (no key configured, no speech,
// unsupported codec) falls back to filename-as-context with a warning.

// Saved-timeline storage (one entry per project) lives in lib/caseTimeline.js
// — shared with the Files tab's virtual "Timeline" folder.

// Total character budget across every file excerpt sent to each council
// analyst (the chair reads the drafts, not the files).
const TOTAL_EXCERPT_CHARS = 60000;

// ── AI media understanding ─────────────────────────────────────────────────

// Photo → downscaled canvas → Claude vision (doc-ai `ocr`). Returns the AI's
// reading of the image (text content and/or description).
async function imageToAiText(file) {
  const url = objectUrlFor(file);
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('the image could not be decoded'));
    el.src = url;
  });
  const scale = Math.min(1, OCR_MAX_EDGE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
  canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return recognizeCanvas(canvas);
}

// Whisper transcript → timestamped KEY SECTIONS: caption lines sampled
// evenly across the runtime so long recordings stay within budget.
function segmentsToKeySections(tr) {
  const segs = tr.segments || [];
  if (segs.length === 0) return (tr.text || '').trim();
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const MAX_LINES = 40;
  const step = Math.max(1, Math.ceil(segs.length / MAX_LINES));
  return segs
    .filter((_, i) => i % step === 0)
    .map((sg) => `[${fmt(sg.start || 0)}] ${String(sg.text || '').trim()}`)
    .filter((line) => line.length > 8)
    .join('\n');
}

// One entry point for every media kind — returns { kind, text, segments }.
async function mediaToAiText(file, mime) {
  if (mime.startsWith('image/')) {
    const text = await imageToAiText(file);
    return { kind: 'image', text: text ? `AI reading of this image:\n${text}` : '', segments: 0 };
  }
  const tr = await transcribeAudio(objectUrlFor(file), mime, file.name);
  const sections = segmentsToKeySections(tr);
  return {
    kind: mime.startsWith('video/') ? 'video' : 'audio',
    text: sections ? `AI captions (timestamped key sections):\n${sections}` : '',
    segments: (tr.segments || []).length,
  };
}

// Event tags map to the notification category palette (--cat-*).
const EVENT_CATS = new Set(['project', 'file', 'update', 'member', 'role', 'system']);

// Clamp + validate the model's output into the shape the steps render.
// Returns null when there's nothing usable (caller surfaces an error).
function normalizeTimeline(parsed, fileCount) {
  if (!parsed || !Array.isArray(parsed.events)) return null;
  const events = parsed.events.slice(0, 40).map((e) => ({
    d: String(e?.date || '').slice(0, 12),
    y: String(e?.year || '').slice(0, 8),
    cat: EVENT_CATS.has(e?.cat) ? e.cat : 'file',
    kind: String(e?.kind || 'Document').slice(0, 28),
    title: String(e?.title || '').slice(0, 160),
    body: String(e?.body || '').slice(0, 500),
    // Filenames this event is based on. Legacy shape fallback: split the old
    // "source" string on the · separator and keep tokens that look like
    // filenames.
    files: Array.isArray(e?.files)
      ? e.files.map((n) => String(n).slice(0, 120)).filter(Boolean).slice(0, 4)
      : String(e?.source || '').split('·').map((s) => s.trim()).filter((s) => s.includes('.')).slice(0, 4),
    isVideo: !!e?.isVideo,
    flag: e?.flag && e.flag.text
      ? {
          sev: e.flag.sev === 'danger' ? 'danger' : 'warning',
          label: String(e.flag.label || 'Flag:').slice(0, 40),
          text: String(e.flag.text).slice(0, 300),
        }
      : null,
  })).filter((e) => e.title);
  if (events.length === 0) return null;
  const SEV_TONE = {
    High: { tone: 'danger', bars: 3 },
    Medium: { tone: 'warning', bars: 2 },
    Low: { tone: 'success', bars: 1 },
  };
  const flags = (Array.isArray(parsed.flags) ? parsed.flags : []).slice(0, 12).map((fl) => {
    const sev = ['High', 'Medium', 'Low'].includes(fl?.sev) ? fl.sev : 'Medium';
    return {
      type: String(fl?.type || 'Flag').slice(0, 40),
      sev,
      ...SEV_TONE[sev],
      title: String(fl?.title || '').slice(0, 160),
      detail: String(fl?.detail || '').slice(0, 500),
      sources: String(fl?.sources || '').slice(0, 120),
    };
  }).filter((fl) => fl.title);
  return {
    lede: String(parsed.lede || '').slice(0, 900),
    events,
    flags,
    meta: { fileCount, generatedAt: Date.now() },
  };
}

// ── Step bodies ────────────────────────────────────────────────────────────

// One object URL per picked File, shared by the Upload list and the Scanning
// grid so FileThumbnail resolves the same preview on both surfaces (and the
// resolver's contentKey-based cache actually hits). Revoked on file removal.
const _objectUrls = new WeakMap();
function objectUrlFor(file) {
  let url = _objectUrls.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    _objectUrls.set(file, url);
  }
  return url;
}

// Files state lives in the page (ProjectEvents) so the Scanning step can
// build its progress grid from the same picks.
function UploadStep({ files, addFiles, removeFile, onAnalyze, analyzing }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  return (
    <div>
      {/* Ready-count + the real "Analyze with AI" trigger — its own card
          section, leading the step above the drop bar. */}
      {files.length > 0 && (
        <div className="cto-upload-bar">
          <div className="cto-upload-bar-copy">
            <div className="cto-upload-bar-num">{files.length}</div>
            <div className="cto-upload-bar-text">
              <div className="cto-upload-bar-title">
                {files.length === 1 ? 'file ready' : 'files ready'}
              </div>
              <div className="cto-upload-bar-sub">
                DocVex will read them and reconstruct the case timeline.
              </div>
            </div>
          </div>
          <button type="button" className="cto-btn-ink" onClick={onAnalyze} disabled={analyzing}>
            {analyzing ? 'Analyzing…' : 'Analyze with AI'}
            <IcoArrow width="13" height="13" />
          </button>
        </div>
      )}
      <div
        className={`cto-dropzone${dragOver ? ' is-dragover' : ''}${files.length > 0 ? ' is-compact' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer?.files);
        }}
        onMouseMove={(e) => {
          // Cursor-tracked spotlight (same recipe as the sidebar's selected
          // tab): write zone-relative coords the ::before gradient reads.
          const r = e.currentTarget.getBoundingClientRect();
          e.currentTarget.style.setProperty('--drop-spot-x', `${toLayoutPx(e.clientX - r.left)}px`);
          e.currentTarget.style.setProperty('--drop-spot-y', `${toLayoutPx(e.clientY - r.top)}px`);
        }}
      >
        <span className="cto-drop-ico"><IcoUpload width="26" height="26" /></span>
        {/* display:contents while expanded (layout identical to before);
            becomes a stacked text column in the compact row. */}
        <div className="cto-drop-copy">
          <div className="cto-drop-title">Drop case files here</div>
          <div className="cto-drop-sub">
            {files.length > 0
              ? 'PDF, DOCX, images, audio & video — read securely on your machine.'
              : 'PDF, DOCX, images, audio & video. DocVex runs OCR on scans and transcribes recordings automatically — nothing leaves your machine unencrypted.'}
          </div>
        </div>
        <button type="button" className="cto-btn-accent" onClick={() => inputRef.current?.click()}>
          Import files
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.doc,.docx,.txt,image/*,audio/*,video/*"
          className="cto-file-input"
          onChange={(e) => {
            addFiles(e.target.files);
            // Reset so re-picking the same file fires onChange again.
            e.target.value = '';
          }}
        />
      </div>

      {files.length > 0 && (
        <>
          {/* Same tile grid as the Scanning step (thumbnail above name),
              minus the progress bars, plus a hover × to remove. */}
          <div className="cto-scan-grid">
            {files.map((f) => (
              <div key={`${f.name} ${f.size}`} className="cto-scan-tile">
                <span className="cto-scan-tile-ico">
                  <FileThumbnail
                    mimeType={f.type || guessMimeFromName(f.name)}
                    sourceUrl={objectUrlFor(f)}
                    glyph={glyphForFile(f.type || guessMimeFromName(f.name), f.name)}
                  />
                </span>
                <span className="cto-scan-tile-name">{f.name}</span>
                <button
                  type="button"
                  className="cto-tile-remove"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => removeFile(f)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Scanning step — the AI-council chamber. `items`/`progress` drive the faded
// file grid behind the ring (Files-tab tiles; the one currently being read
// carries the Files tab's selection styling), `council` is the live chamber
// state built from the pipeline's event stream. `onAnswer` resolves the
// dispute panel; the ending story card's button hands off to the Timeline
// step via `onReadStory`.
function CouncilStep({ items, progress, council, paused, user, error, onAnswer, onPacketDone, onReadStory, onRedo }) {
  // Keep the file currently being read in view — the rail scrolls (with its
  // native scrollbar hidden), so follow the reading head as it moves down
  // the grid.
  const railRef = useRef(null);
  const readingIdx = progress.findIndex((p) => p > 0 && p < 100);
  useEffect(() => {
    if (readingIdx < 0) return;
    const rail = railRef.current;
    const tile = rail?.querySelector(`[data-idx="${readingIdx}"]`);
    if (!rail || !tile) return;
    // Keep the file being read pinned as the SECOND visible row — one row
    // of already-read tiles stays above it for context. Scroll the rail's
    // own scrollTop (not scrollIntoView, which would also drag the page's
    // scroll container along).
    const railRect = rail.getBoundingClientRect();
    const tileRect = tile.getBoundingClientRect();
    const delta = toLayoutPx((tileRect.top - railRect.top) - (tileRect.height + 4));
    rail.scrollTo({ top: rail.scrollTop + delta, behavior: 'smooth' });
  }, [readingIdx]);
  // Display-only scroll indicator to the LEFT of the rail — size/position
  // mirror the rail's scroll state; it accepts no input (pointer-events off).
  const [bar, setBar] = useState({ size: 0, top: 0 });
  // Per-tile vertical offsets (rail coords) so the fact column to the RIGHT
  // of the rail can align each pill stack with its file — re-measured on
  // scroll so the stacks track the tiles.
  const [factTops, setFactTops] = useState({});
  const measureRail = () => {
    const el = railRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight > el.clientHeight + 1;
    setBar({
      size: scrollable ? el.clientHeight / el.scrollHeight : 0,
      top: scrollable ? el.scrollTop / el.scrollHeight : 0,
    });
    // Content-space offsets (the fact layer lives INSIDE the scroll
    // container, so it scrolls natively with the tiles — offsets only
    // change when the item set changes).
    const tops = {};
    el.querySelectorAll('[data-idx]').forEach((node) => {
      tops[node.dataset.idx] = node.offsetTop;
    });
    setFactTops(tops);
  };
  useEffect(measureRail, [items.length]);

  // Answer choreography: the clicked option wears the sidebar selected-tab
  // style for a beat, then the modal fades out, and only then does the
  // answer resolve (which glides the members back to their seats).
  const [picked, setPicked] = useState(null);
  const [askLeaving, setAskLeaving] = useState(false);
  // multi_select / free_text working state (Doc Viewer ask_user shapes).
  const [multiSel, setMultiSel] = useState([]);
  const [textVal, setTextVal] = useState('');
  // Packet colouring mode — per packet TYPE (identity colours from
  // PACKET_COLORS) or tinted by the SENDING member.
  const [tintBySender, setTintBySender] = useState(false);
  const answerTimers = useRef([]);
  useEffect(() => () => answerTimers.current.forEach(clearTimeout), []);
  useEffect(() => {
    // A new question resets the choreography state.
    setPicked(null);
    setAskLeaving(false);
    setMultiSel([]);
    setTextVal('');
  }, [council?.ask]);
  const pickOption = (o) => {
    if (picked) return;
    setPicked(o.id);
    answerTimers.current.push(setTimeout(() => {
      setAskLeaving(true);
      answerTimers.current.push(setTimeout(() => onAnswer(o), 320));
    }, 500));
  };

  if (!council || items.length === 0) {
    return (
      <p className="cto-scan-empty">
        Nothing scanned yet — pick files in the Upload step and press
        “Analyze with AI”.
      </p>
    );
  }
  const ending = council.endStage === 'gavel' || council.endStage === 'story';
  // While the council waits on the author the chamber reflows instead of
  // hiding: the mesh/bubbles/packets fade (`hidden`), the members glide into
  // a vertical list beside the files (chair on top) and the ask panel sits
  // to the right of that list. Files stay visible; only the end sequence
  // fades them.
  const asking = !!council.ask && !ending;
  const hidden = ending || asking;

  return (
    <div>
      <div className={`cc-card${paused ? ' is-paused' : ''}`}>
        <div className="cc-stage">
          {/* The scanned files — Files-tab tiles (fx-grid / fx-tile) in a
              3-wide grid to the left of the ring. The file currently being
              read lights up with the Files tab's selection styling. */}
          <div className={`cc-filewrap${ending ? ' is-out' : ''}`}>
            <div className="cc-log-kicker">Files</div>
            <div className="cc-filewrap-row">
              {bar.size > 0 && (
                <div className="cc-filebar" aria-hidden="true">
                  <span
                    className="cc-filebar-thumb"
                    style={{ top: `${bar.top * 100}%`, height: `${bar.size * 100}%` }}
                  />
                </div>
              )}
              <div className="cc-filerail" ref={railRef} onScroll={measureRail}>
                <div className="fx-grid cc-filerail-grid">
              {items.map((f, i) => {
                const pct = Math.round(progress[i] ?? 0);
                const reading = pct > 0 && pct < 100;
                return (
                  <div
                    key={`${f.name} ${i}`}
                    data-idx={i}
                    className={`fx-tile${reading ? ' cc-reading' : ''}${pct === 0 ? ' cc-unread' : ''}`}
                    // The icon IS the loading indicator: a vertical mask
                    // reveals it bottom-up with the file's real extraction
                    // progress (see .cc-reading in ProjectEvents.css).
                    style={reading ? { '--cc-read': `${pct}%` } : undefined}
                    role={reading ? 'progressbar' : undefined}
                    aria-valuenow={reading ? pct : undefined}
                    aria-label={reading ? `Reading ${f.name}` : undefined}
                  >
                    <span className="fx-tile-thumb">
                      <FileThumbnail
                        mimeType={f.mime || guessMimeFromName(f.name)}
                        sourceUrl={f.url || undefined}
                        glyph={glyphForFile(f.mime || guessMimeFromName(f.name), f.name)}
                      />
                    </span>
                    <span>
                      <span className="fx-tile-name">{f.name}</span>
                    </span>
                  </div>
                );
              })}
                </div>
                {/* Fact pills to the RIGHT of each file — what the analysts
                    pulled from it (design bundle's f.facts), left-border
                    tinted with the finding member's colour. The layer lives
                    INSIDE the scroll container so it scrolls in lockstep
                    with the tiles; stacks sit at their tile's content-space
                    offset and never squeeze the tile text. */}
                <div className="cc-factcol" aria-hidden="true">
                  {items.map((f, i) => {
                    const facts = (council.facts || {})[f.name];
                    const top = factTops[i];
                    if (!facts?.length || top == null) return null;
                    return (
                      <div key={`${f.name} ${i}`} className="cc-factstack" style={{ top }}>
                        {facts.map((ft, j) => (
                          <div key={`${ft.text} ${j}`} className="cc-fact">{ft.text}</div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* The chamber — spinning ring, orbiting artefacts, four members.
              While asking it narrows into the members' vertical list. */}
          <div className={`cc-ring-wrap${asking ? ' is-asking' : ''}`}>
            {/* Column header while the members stand as a vertical list. */}
            {asking && <div className="cc-log-kicker cc-members-kicker">Members</div>}
            {/* Dashed round-table mesh (the author's sketch): the chair fans
                out with direct diagonals to both side analysts plus the
                straight line down to the auditor — crossing the analysts'
                horizontal — and the bottom edges bow downward like a
                table's near side. */}
            <svg className={`cc-mesh${hidden ? ' is-out' : ''}`} viewBox="0 0 560 540" aria-hidden="true">
              <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="6 10">
                <path d="M 280 60 L 85 330" />
                <path d="M 280 60 L 475 330" />
                <path d="M 280 60 L 280 435" />
                <path d="M 85 330 L 475 330" />
                <path d="M 85 330 Q 172 452 280 435" />
                <path d="M 475 330 Q 388 452 280 435" />
              </g>
            </svg>
            {/* The open question — ONE big pulsing ?-mark at the crossing of
                the chair's line and the analysts' horizontal, heralding the
                ask panel. Always mounted so it can FADE in and out (a
                conditional mount would snap). */}
            <span
              className={`cc-askmark${council.askMark && !hidden ? ' is-on' : ''}`}
              aria-hidden="true"
            >
              <IcoAsk width="22" height="22" />
            </span>
            {/* Current phase — bare text at the centre of the ring (the end
                sequence takes the centre over). */}
            {!hidden && council.phase !== 'Story complete' && (
              <div className="cc-phase-center">{council.phase}</div>
            )}
            {/* Files & thoughts in transit — packets ride the mesh edges,
                spawned by real pipeline events: the brief going out to an
                analyst, draft pages shuttling back while a call is in
                flight, the filed draft, disagreement chatter, the author's
                steer relayed by the chair. */}
            {(council.packets || []).map((p) => {
              const path = packetPath(p.from, p.to);
              const { Icon, color } = packetGlyph(p.icon);
              const pkColor = tintBySender ? (COUNCIL_BY_ID[p.from]?.color || color) : color;
              return (
                <span
                  key={p.id}
                  className={`cc-packet${path.reverse ? ' is-rev' : ''}${hidden ? ' is-out' : ''}`}
                  style={{ offsetPath: `path("${path.d}")`, animationDuration: `${p.dur}ms`, '--pk-c': pkColor }}
                  onAnimationEnd={() => onPacketDone(p.id)}
                  aria-hidden="true"
                >
                  <Icon width="13" height="13" />
                </span>
              );
            })}
            {COUNCIL_UI.map((m, mi) => {
              const st = council.members[m.id] || {};
              const MIcon = memberIcon(m.id);
              // Seat position normally; while asking, a vertical list (the
              // COUNCIL_UI order already leads with the chair). left/top
              // transition in CSS so the members glide between the layouts.
              // List layout: starts below the "Members" kicker and runs a
              // single uniform 140px step so the gap between every pair of
              // members is identical (offsets account for the card's
              // translate(-50%, -29px) anchor).
              const pos = asking
                ? { left: 66, top: 62 + mi * 140 }
                : { left: m.x, top: m.y };
              return (
                <div key={m.id} className={`cc-member${ending ? ' is-out' : ''}${asking ? ' is-listed' : ''}`} style={pos}>
                  <div className="cc-avatar-wrap">
                    {/* Reaction ring — re-keyed per ping so sending or
                        receiving a packet restarts the burst. */}
                    {(st.ping || 0) > 0 && (
                      <span key={`ping-${st.ping}`} className="cc-avatar-ping" style={{ borderColor: m.color }} aria-hidden="true" />
                    )}
                    <span
                      className="cc-avatar-glow"
                      style={{
                        background: `radial-gradient(circle, ${m.color}55 0%, ${m.color}22 45%, transparent 70%)`,
                        opacity: st.active ? 1 : 0,
                      }}
                      aria-hidden="true"
                    />
                    <span
                      key={`pong-${st.pong || 0}`}
                      className={`cc-avatar${(st.pong || 0) > 0 ? ' is-pong' : ''}`}
                      style={{
                        borderColor: m.color,
                        color: m.color,
                        boxShadow: st.active ? `0 0 0 4px ${m.color}22, 0 6px 16px rgba(15, 23, 42, 0.12)` : undefined,
                      }}
                    >
                      <MIcon width="26" height="26" />
                    </span>
                  </div>
                  <div>
                    <span className="cc-member-name">{m.name}</span>
                    <span className="cc-member-role">{m.role}</span>
                    <span className="cc-member-stat" style={{ color: m.color }}>{st.stats || ''}</span>
                  </div>
                  <div className={`cc-bubble${st.bubble && !hidden ? ' is-on' : ''}`} data-pos={m.bubblePos}>
                    <span className="cc-bubble-name" style={{ color: m.color }}>{m.name}</span>
                    {st.bubble}
                  </div>
                </div>
              );
            })}

          </div>

          {/* Packet key — what each traveller on the mesh means. Collapses
              away (width + opacity) while the ask panel or the end sequence
              needs the room. */}
          <div className={`cc-legend${hidden ? ' is-out' : ''}`} aria-hidden={hidden || undefined}>
            <div className="cc-log-kicker">Packet key</div>
            {/* Colour mode — each packet type in its own colour, or every
                packet tinted by the member who sent it. */}
            <div className="cc-legend-toggle" role="radiogroup" aria-label="Packet colours">
              <button
                type="button"
                className={!tintBySender ? 'is-on' : ''}
                aria-checked={!tintBySender}
                role="radio"
                onClick={() => setTintBySender(false)}
              >
                By type
              </button>
              <button
                type="button"
                className={tintBySender ? 'is-on' : ''}
                aria-checked={tintBySender}
                role="radio"
                onClick={() => setTintBySender(true)}
              >
                By sender
              </button>
            </div>
            <div className="cc-legend-list">
              {PACKET_LEGEND.map((l) => {
                const { Icon, color } = packetGlyph(l.icon);
                return (
                  <div key={l.icon} className="cc-legend-row">
                    {/* In sender mode colour stops meaning "type", so the
                        key's icons go neutral. */}
                    <span className="cc-legend-ico" style={{ '--pk-c': tintBySender ? 'var(--accent)' : color }} aria-hidden="true">
                      <Icon width="13" height="13" />
                    </span>
                    <span className="cc-legend-main">
                      <span className="cc-legend-label">{l.label}</span>
                      <span className="cc-legend-desc">{l.desc}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* End sequence — gavel slam, then the ruling card with the real
              lede and the hand-off to the Timeline step. Direct children of
              the STAGE (not the ring wrap) so they centre on the full
              content width, in line with the step tabs above. */}
          {council.endStage === 'gavel' && (
            <div className="cc-gavel">
              <svg width="180" height="180" viewBox="0 0 200 200" aria-label="Gavel slam">
                <g fill="#DCC9A3" style={{ transformBox: 'view-box', transformOrigin: '57px 151px', animation: 'ccGvShake 1.8s 1' }}>
                  <path d="M 22.0,146.9 v-5.4 a6.5,6.5 0 0 1 6.5,-6.5 h56.4 a6.5,6.5 0 0 1 6.5,6.5 v5.4 z" />
                  <rect x="17.8" y="151.0" width="77.7" height="13.6" rx="2.6" />
                </g>
                <g fill="#DCC9A3" style={{ transformBox: 'view-box', transformOrigin: '179.9px 140.7px', animation: 'ccGvSlam 1.8s 1 forwards' }}>
                  <g transform="translate(83.8 74.9) rotate(124.4)">
                    <path d="M -10.4,-15.7 L -10.4,-115.0 A 10.5,10.5 0 0 1 10.5,-115.0 L 10.5,-15.7 Z" />
                    <rect x="-22.5" y="-21.6" width="44.9" height="43.2" rx="8.5" />
                    <rect x="-42.7" y="-26.8" width="16.1" height="53.6" rx="4.8" />
                    <rect x="26.6" y="-26.9" width="16.1" height="53.7" rx="4.8" />
                  </g>
                </g>
              </svg>
            </div>
          )}
          {council.endStage === 'story' && (
            <div className="cc-story">
              <div className="cc-story-eyebrow">Council ruling · {council.ruling}</div>
              <div className="cc-story-title">It is decided!</div>
              <p className="cc-story-lede">
                {council.lede || 'The council assembled the story — every beat sourced and merged.'}
              </p>
              <div className="cc-story-actions">
                <button type="button" className="cc-story-redo" onClick={onRedo}>
                  Run again
                </button>
                <button type="button" className="cc-story-btn" onClick={onReadStory}>
                  Read the whole story
                </button>
              </div>
            </div>
          )}

          {/* Real dispute panel — beside the ring while open; the picked
              option's rule steers the chair's merge. */}
          {council.ask && !ending && (
            <div className={`cc-ask${askLeaving ? ' is-leaving' : ''}`}>
              <div className="cc-ask-head">
                <span>We have a question…</span>
              </div>
              <p className="cc-ask-q">{council.ask.question}</p>
              <p className="cc-ask-ctx">{council.ask.context}</p>
              {/* single_select / confirm — one click answers. */}
              {council.ask.kind !== 'multi' && council.ask.kind !== 'text' && (
                <div className="cc-ask-opts">
                  {(council.ask.options || []).map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      className={`cc-ask-opt${picked === o.id ? ' is-picked' : ''}`}
                      onClick={() => pickOption(o)}
                    >
                      <span className="cc-ask-opt-label">{o.label}</span>
                      <span className="cc-ask-opt-desc">{o.desc}</span>
                    </button>
                  ))}
                </div>
              )}
              {/* multi_select — toggle any, then submit. */}
              {council.ask.kind === 'multi' && (
                <>
                  <div className="cc-ask-opts">
                    {(council.ask.options || []).map((o) => {
                      const on = multiSel.includes(o.id);
                      return (
                        <button
                          key={o.id}
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          className={`cc-ask-opt${on ? ' is-picked' : ''}`}
                          onClick={() => !picked && setMultiSel((prev) => (on ? prev.filter((x) => x !== o.id) : [...prev, o.id]))}
                        >
                          <span className="cc-ask-opt-label">{o.label}</span>
                          <span className="cc-ask-opt-desc">{o.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="cc-ask-submit"
                    disabled={multiSel.length === 0 || !!picked}
                    onClick={() => pickOption({
                      id: 'multi',
                      label: (council.ask.options || []).filter((o) => multiSel.includes(o.id)).map((o) => o.label).join(' · '),
                    })}
                  >
                    Submit
                  </button>
                </>
              )}
              {/* free_text — typed answer + submit. */}
              {council.ask.kind === 'text' && (
                <>
                  <textarea
                    className="cc-ask-text"
                    rows={3}
                    placeholder="Type your answer…"
                    value={textVal}
                    disabled={!!picked}
                    onChange={(e) => setTextVal(e.target.value)}
                  />
                  <button
                    type="button"
                    className="cc-ask-submit"
                    disabled={!textVal.trim() || !!picked}
                    onClick={() => pickOption({ id: 'text', label: textVal.trim().slice(0, 140) })}
                  >
                    Submit
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Standing proposal — the latest filed draft's actual reading of
            the story (its lede), drawn from its most-cited source; objection
            chips land when the drafts disagree, the chair's ruling when the
            merge completes. */}
        {council.prop && !ending && (() => {
          const by = COUNCIL_BY_ID[council.prop.by] || {};
          const r = council.prop.ruling;
          return (
            <div className="cc-prop">
              <div className="cc-log-kicker">Standing proposal</div>
              <div className="cc-prop-head">
                <span className="cc-prop-by" style={{ color: by.color }}>
                  {/* Same circular member badge as the decision log rows,
                      scaled down to the proposal row's rhythm. */}
                  {(() => { const ByIcon = memberIcon(by.id); return (
                    <span className="cc-log-ico cc-prop-member-ico" aria-hidden="true"><ByIcon /></span>
                  ); })()}
                  {by.name}
                </span>
                <span className="cc-prop-lead">proposes · drawn from</span>
                <span className="cc-prop-source">{council.prop.source}</span>
              </div>
              <div className="cc-prop-text">“{council.prop.text}”</div>
              {council.prop.votes.length > 0 && (
                <div className="cc-prop-votes">
                  {council.prop.votes.map((v) => {
                    const vm = COUNCIL_BY_ID[v.by] || {};
                    const VmIcon = memberIcon(vm.id);
                    return (
                      <span key={v.by} className="cc-prop-vote">
                        <span className="cc-log-ico cc-prop-member-ico" style={{ color: vm.color }} aria-hidden="true"><VmIcon /></span>
                        {vm.name} <span className="cc-prop-verb" data-ok={v.verb === 'agrees' || undefined}>{v.verb}</span>
                        {v.conf != null && <span className="cc-prop-conf">{v.conf}%</span>}
                      </span>
                    );
                  })}
                </div>
              )}
              {r && (
                <div className="cc-prop-ruling" data-ok={r.accepted || undefined}>
                  <strong>
                    {r.accepted ? <IcoCheck width="10" height="10" /> : <IcoX width="10" height="10" />}
                    {r.accepted ? ' Accepted by the Chair' : ' Rejected by the Chair'}
                  </strong> — {r.reason}
                </div>
              )}
            </div>
          );
        })()}

        {/* Under the chamber — decision log (left) + task rail (right),
            sharing the same kicker header, spacing and row rhythm. */}
        <div className="cc-below">
          <div className="cc-log">
            <div className="cc-log-kicker">Decision log</div>
            <div className="cc-log-list">
              {council.decisions.length === 0 && (
                <div className="cc-log-empty">Every ruling, vote and steer lands here.</div>
              )}
              {council.decisions.map((d) => (
                <div key={d.id} className="cc-log-row">
                  {/* Row marker — the signed-in user's avatar on "You
                      decided" rows, the board-member glyph in the member's
                      colour on their entries, and a semantic status icon
                      (✓ / ✕ / ⚠ / ? / i) everywhere else. */}
                  {(() => {
                    if (d.dot === 'user') {
                      return user?.avatarUrl ? (
                        <img className="cc-log-avatar" src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="cc-log-avatar cc-log-avatar-fallback" aria-hidden="true">{user?.initial || '?'}</span>
                      );
                    }
                    const member = COUNCIL_BY_ID[d.dot];
                    const Icon = member ? memberIcon(member.id)
                      : d.dot === LOG_OK ? IcoCheck
                      : d.dot === LOG_BAD ? IcoX
                      : d.dot === LOG_WARN ? IcoAlert
                      : d.dot === LOG_STEER ? IcoAsk
                      : IcoInfo;
                    return (
                      <span className="cc-log-ico" style={{ color: member ? member.color : d.dot }} aria-hidden="true">
                        <Icon width="14.4" height="14.4" />
                      </span>
                    );
                  })()}
                  <div className="cc-log-main">
                    <span><strong>{d.head}</strong> {d.text}</span>
                    {d.chips.length > 0 && (
                      <div className="cc-log-chips">
                        {d.chips.map((ch) => <span key={ch} className="cc-log-chip">{ch}</span>)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="cc-tasks">
            <div className="cc-log-kicker">Tasks</div>
            <div className="cc-tasks-list">
              {COUNCIL_TASKS.map((t) => {
                const state = council.tasks[t.id] || 'queued';
                return (
                  <div key={t.id} className="cc-task" data-state={state}>
                    <span className="cc-task-dot" aria-hidden="true">
                      {state === 'done' ? <IcoCheck width="14.4" height="14.4" /> : null}
                    </span>
                    <span className="cc-task-label">{t.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <p className="cto-scan-error">
          The analysis failed: {error} — go back to the Upload step and try again.
        </p>
      )}
    </div>
  );
}

// localfile:// URL for a stored path — same scheme the Files tab and the
// sidebar's open-file tabs use for previews.
function localFileUrl(path) {
  return path ? `localfile://local/${encodeURIComponent(path)}` : null;
}

// Source-file tile on a timeline event — a real Files-tab tile (fx-tile:
// thumbnail well with the name underneath) with the Files tab's interaction
// model: single click selects (is-selected ring, cleared on blur), double
// click opens the file in the Doc Viewer when we know its on-disk path
// (Electron). Tiles without a path render inert.
function EventFileChip({ name, fileRef }) {
  const [selected, setSelected] = useState(false);
  const mime = fileRef?.mime || guessMimeFromName(name);
  const openable = !!fileRef?.path;
  return (
    <button
      type="button"
      className={`cto-ev-file fx-tile${selected ? ' is-selected' : ''}`}
      disabled={!openable}
      onClick={() => setSelected((s) => !s)}
      onDoubleClick={() => openable && openDocViewerWindow({ path: fileRef.path, name, mime })}
      onBlur={() => setSelected(false)}
    >
      <span className="fx-tile-thumb">
        <FileThumbnail
          mimeType={mime}
          sourceUrl={localFileUrl(fileRef?.path) || undefined}
          glyph={glyphForFile(mime, name)}
        />
      </span>
      <span className="fx-tile-name">{name}</span>
    </button>
  );
}

// Option 1b's narrative dossier — editorial brief with the timeline as a
// margin rail and the AI flags as review annotations in the right gutter.
// Renders the AI-reconstructed `timeline`; empty state until one is built.
// (The lede renders in the page masthead, not here.)
function TimelineStep({ timeline }) {
  if (!timeline) {
    return (
      <p className="cto-scan-empty">
        No timeline yet — upload the case files and press “Analyze with AI”
        to reconstruct the story.
      </p>
    );
  }
  // Kind labels are free text from the model ("Correspondence", "Evidence",
  // "Filing"…), so several labels can share one data-cat and would all paint
  // the same. Colour by LABEL instead: each distinct kind gets the next hue
  // from the category palette in order of first appearance — stable within a
  // timeline, and distinct until the palette runs out.
  // Ordered for maximum hue separation between CONSECUTIVE picks (indigo →
  // amber → emerald → pink → cyan → cognac → violet), so the first few tags
  // — the common case — are unmistakably different at a glance.
  const KIND_COLORS = [
    'var(--cat-project)', 'var(--cat-file)', 'var(--cat-auth)', 'var(--cat-role)',
    'var(--cat-member)', 'var(--cat-support)', 'var(--cat-update)', 'var(--cat-system)',
  ];
  const kindColors = new Map();
  timeline.events.forEach((e) => {
    if (!kindColors.has(e.kind)) kindColors.set(e.kind, KIND_COLORS[kindColors.size % KIND_COLORS.length]);
  });
  return (
    <div className="cto-dossier">
      <div className="cto-events">
        {timeline.events.map((e) => (
          <div key={`${e.d} ${e.y} ${e.title}`} className="cto-event">
            <div className="cto-ev-date">
              <div className="cto-ev-d">{e.d}</div>
              <div className="cto-ev-y">{e.y}</div>
            </div>
            <div className="cto-ev-body">
              <span className="cto-ev-node" aria-hidden="true" />
              <div className="cto-ev-row">
                <div className="cto-ev-main">
                  <div className="cto-ev-tags">
                    <span className="cto-ev-kind" style={{ color: kindColors.get(e.kind) }}>{e.kind}</span>
                    {e.isVideo && (
                      <span className="cto-ev-ai"><IcoPlay width="8" height="8" />AI caption</span>
                    )}
                  </div>
                  <div className="cto-ev-title">{e.title}</div>
                  <p className="cto-ev-text">{e.body}</p>
                </div>
                {e.files?.length > 0 && (
                  <div className="cto-ev-files">
                    {e.files.map((name) => (
                      <EventFileChip key={name} name={name} fileRef={timeline.fileRefs?.[name]} />
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="cto-ev-margin">
              {e.flag && (
                <div className="cto-annot" data-sev={e.flag.sev}>
                  <div className="cto-annot-head"><IcoAlert width="10" height="10" strokeWidth="2.4" />{e.flag.label}</div>
                  <div className="cto-annot-text">{e.flag.text}</div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewStep({ timeline, goTimeline }) {
  if (!timeline) {
    return (
      <p className="cto-scan-empty">
        Nothing to review yet — build the timeline first (upload files and
        press “Analyze with AI”).
      </p>
    );
  }
  const flags = timeline.flags || [];
  const count = (sev) => flags.filter((fl) => fl.sev === sev).length;
  return (
    <div>
      <div className="cto-sev-cards">
        <div className="cto-sev-card" data-sev="danger">
          <div className="cto-sev-num">{count('High')}</div>
          <div className="cto-sev-label">High — resolve before filing</div>
        </div>
        <div className="cto-sev-card" data-sev="warning">
          <div className="cto-sev-num">{count('Medium')}</div>
          <div className="cto-sev-label">Medium — gaps in the record</div>
        </div>
        <div className="cto-sev-card" data-sev="success">
          <div className="cto-sev-num">{count('Low')}</div>
          <div className="cto-sev-label">Low — clarify wording</div>
        </div>
      </div>
      <div className="cto-kicker cto-flags-kicker">Flags to resolve</div>
      {flags.length === 0 && (
        <p className="cto-scan-empty">No open flags — the record reads clean.</p>
      )}
      <div className="cto-flag-list">
        {flags.map((fl) => (
          <div key={fl.title} className="cto-flag-row" data-sev={fl.tone}>
            <span className="cto-flag-bars" aria-hidden="true">
              <span data-on={fl.bars >= 1 || undefined} /><span data-on={fl.bars >= 2 || undefined} /><span data-on={fl.bars >= 3 || undefined} />
            </span>
            <div className="cto-flag-main">
              <div className="cto-flag-type">{fl.type} <span>· {fl.sev}</span></div>
              <div className="cto-flag-title">{fl.title}</div>
              <div className="cto-flag-detail">{fl.detail}</div>
              <div className="cto-ev-source"><IcoDoc width="11" height="11" />{fl.sources}</div>
            </div>
            <div className="cto-flag-actions">
              <button type="button" className="cto-btn-resolve">Resolve</button>
              <button type="button" className="cto-btn-dismiss">Dismiss</button>
            </div>
          </div>
        ))}
      </div>
      <div className="cto-review-foot">
        <button type="button" className="cto-btn-back" onClick={goTimeline}>← Back to timeline</button>
        <button type="button" className="cto-btn-ink">
          Finish &amp; open case dossier<IcoArrow width="13" height="13" />
        </button>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function ProjectEvents() {
  const { selectedProject, loading } = useSelectedProject();
  const { session } = useAuth();
  const [step, setStep] = useState('upload');
  // Signed-in identity for the decision log's "You decided" rows — Google
  // avatar when present, first-letter circle fallback (app convention).
  const logUser = {
    avatarUrl: session?.user?.user_metadata?.avatar_url || null,
    initial: (session?.user?.email || '?').charAt(0).toUpperCase(),
  };

  // Picked case files (File objects) — shared by the Upload list and the
  // Scanning grid. Held in memory only; the real pipeline isn't wired yet.
  const [files, setFiles] = useState([]);
  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    if (incoming.length === 0) return;
    setFiles((prev) => {
      // De-dupe re-picks of the same file (same name + size).
      const seen = new Set(prev.map((f) => `${f.name} ${f.size}`));
      return [...prev, ...incoming.filter((f) => !seen.has(`${f.name} ${f.size}`))];
    });
  };
  const removeFile = (file) => {
    const url = _objectUrls.get(file);
    if (url) {
      URL.revokeObjectURL(url);
      _objectUrls.delete(file);
    }
    setFiles((prev) => prev.filter((x) => x !== file));
  };

  // Scan-grid state — shared by the real pipeline and the debug simulator.
  // `scanning` covers the whole run (extraction AND the AI call: bars pin at
  // 100 while the model works, which the action log reads as the final
  // cross-checking phase). `debugRun` marks simulator runs so the fake
  // interval below never touches a real analysis.
  const [scanItems, setScanItems] = useState([]);
  const [scanProgress, setScanProgress] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [debugRun, setDebugRun] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);

  // ── Council-chamber state (Scanning step) — everything the chamber UI
  // renders: phase pill, task rail, per-member bubbles/stats/glows, the
  // decision log, the dispute panel and the gavel/story end sequence.
  const [council, setCouncil] = useState(null);
  // Pending resolveDispute() — resolved when the user picks an option.
  const askResolverRef = useRef(null);
  // End-sequence + debug-script timers, and the per-analyst packet shuttles.
  // Timers are entry objects ({ fn, remaining, startedAt, id }) rather than
  // bare timeout ids so the debug pause button can freeze them mid-flight
  // and resume with the leftover delay.
  const timersRef = useRef([]);
  const decisionSeq = useRef(0);
  const shuttleRef = useRef({});
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  // Which analysts had a live shuttle when the pause hit, so resume can
  // restart exactly those.
  const pausedShuttlesRef = useRef([]);
  // Simulator fact pills wait here (keyed by file index) until that file's
  // bar starts filling — the pill lands as its file starts loading.
  const pendingFactsRef = useRef({});
  // Remaining debug ask variations — answering one advances to the next.
  const askQueueRef = useRef([]);
  // Which variation the ask-variations button is currently showing.
  const askVarIdxRef = useRef(0);
  const clearTimers = () => {
    timersRef.current.forEach((t) => clearTimeout(t.id));
    timersRef.current = [];
    Object.values(shuttleRef.current).forEach(clearInterval);
    shuttleRef.current = {};
  };
  useEffect(() => clearTimers, []);
  const fireTimer = (entry) => {
    timersRef.current = timersRef.current.filter((t) => t !== entry);
    entry.fn();
  };
  const schedule = (ms, fn) => {
    const entry = { fn, remaining: ms, startedAt: Date.now(), id: null };
    if (!pausedRef.current) entry.id = setTimeout(() => fireTimer(entry), ms);
    timersRef.current.push(entry);
  };
  const resetCouncilPause = () => {
    pausedRef.current = false;
    pausedShuttlesRef.current = [];
    setPaused(false);
  };
  const freshCouncil = () => ({
    phase: 'Convening',
    tasks: Object.fromEntries(COUNCIL_TASKS.map((t) => [t.id, 'queued'])),
    members: Object.fromEntries(COUNCIL_UI.map((m) => [m.id, { active: false, bubble: '', stats: '' }])),
    decisions: [],
    packets: [],
    // Per-file fact pills (design bundle's `f.facts`) — filename → array of
    // { text, color }, rendered beside that file's tile in the rail.
    facts: {},
    prop: null,
    ask: null,
    // A single pulsing ?-mark at the mesh crossing — the council's open
    // question, shown for a beat before the ask panel takes over.
    askMark: false,
    endStage: '',
    lede: '',
    ruling: 'unanimous',
  });
  const patchCouncil = (patch) => setCouncil((c) => {
    const base = c || freshCouncil();
    return { ...base, ...(typeof patch === 'function' ? patch(base) : patch) };
  });
  const setPhase = (phase) => patchCouncil({ phase });
  const setTask = (id, st) => patchCouncil((c) => ({ tasks: { ...c.tasks, [id]: st } }));
  const say = (id, bubble, stats) => patchCouncil((c) => ({
    members: { ...c.members, [id]: { ...c.members[id], bubble, ...(stats !== undefined ? { stats } : {}) } },
  }));
  const setActive = (id, active) => patchCouncil((c) => ({
    members: { ...c.members, [id]: { ...c.members[id], active } },
  }));
  // Fact pill on a file tile — capped at 3 per file so the stack stays short.
  const addFact = (name, text, color) => patchCouncil((c) => ({
    facts: {
      ...(c.facts || {}),
      [name]: [...((c.facts || {})[name] || []).slice(-2), { text, color }],
    },
  }));
  const addDecision = (dot, head, text, chips) => patchCouncil((c) => ({
    decisions: [
      { id: (decisionSeq.current += 1), dot, head, text, chips: chips || [] },
      ...c.decisions,
    ].slice(0, 40),
  }));
  // Files/thoughts in transit along the mesh (rendered as .cc-packet).
  // Capped so a stuck animation can't grow the array unbounded.
  const packetSeq = useRef(0);
  // Bump a member's reaction counter — 'ping' fires the sender's ring burst,
  // 'pong' pulses the receiver's whole circle (counters key the animated
  // elements, restarting the animation each time).
  const pingMember = (id, field = 'ping') => patchCouncil((c) => ({
    members: { ...c.members, [id]: { ...c.members[id], [field]: (c.members[id]?.[field] || 0) + 1 } },
  }));
  const sendPacket = (from, to, icon = 'doc', dur = 1900) => {
    patchCouncil((c) => ({
      packets: [...(c.packets || []).slice(-11), { id: (packetSeq.current += 1), from, to, icon, dur }],
      // The sender reacts as the packet departs…
      members: { ...c.members, [from]: { ...c.members[from], ping: (c.members[from]?.ping || 0) + 1 } },
    }));
    // …and the receiver's whole circle pulses the moment the packet lands.
    schedule(dur, () => pingMember(to, 'pong'));
  };
  const removePacket = (id) => patchCouncil((c) => ({
    packets: (c.packets || []).filter((p) => p.id !== id),
  }));
  // While an analyst's draft call is genuinely in flight, material shuttles
  // between the chair and that analyst — brief pages out, notes back.
  const stopShuttle = (id) => { clearInterval(shuttleRef.current[id]); delete shuttleRef.current[id]; };
  const stopAllShuttles = () => { Object.keys(shuttleRef.current).forEach(stopShuttle); };
  const startShuttle = (id) => {
    stopShuttle(id);
    sendPacket('chair', id, 'doc');
    let back = false;
    shuttleRef.current[id] = setInterval(() => {
      back = !back;
      sendPacket(back ? id : 'chair', back ? 'chair' : id, back ? 'pen' : 'doc');
    }, 2800);
  };

  // ── Debug pause (the second button under the header) — freezes the council
  // process in place: pending step/end-sequence timers keep their leftover
  // delay, shuttles stop (and restart on resume), the fake progress interval
  // and extraction bar-creep hold via pausedRef, and CSS pauses every chamber
  // animation (.cc-card.is-paused). On a real run the in-flight AI calls
  // themselves can't be suspended — their results simply land while the
  // chamber stands still.
  const toggleCouncilPause = () => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (next) {
      timersRef.current.forEach((t) => {
        if (t.id == null) return;
        clearTimeout(t.id);
        t.id = null;
        t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
      });
      pausedShuttlesRef.current = Object.keys(shuttleRef.current);
      stopAllShuttles();
    } else {
      timersRef.current.forEach((t) => {
        if (t.id != null) return;
        t.startedAt = Date.now();
        t.id = setTimeout(() => fireTimer(t), t.remaining);
      });
      pausedShuttlesRef.current.forEach((id) => startShuttle(id));
      pausedShuttlesRef.current = [];
    }
  };

  // Map the council pipeline's event stream onto chamber state.
  const handleCouncilEvent = (e) => {
    switch (e.type) {
      case 'convene':
        setPhase('Deliberating');
        setTask('draft', 'working');
        say('chair', 'Drafts, please — each analyst reads the record through their own lens.');
        addDecision(LOG_INFO, 'Deliberation opened', '— the chair hands the brief to every analyst.');
        // The brief physically rides out to each seat.
        COUNCIL_UI.slice(1).forEach((m, i) => {
          schedule(250 + i * 350, () => sendPacket('chair', m.id, 'doc', 1800));
        });
        break;
      case 'member-start':
        setActive(e.member.id, true);
        say(e.member.id, MEMBER_WORKING_LINE[e.member.id] || 'Drafting…');
        addDecision(e.member.id, `${e.member.name} began drafting`, '— reading the record through their lens.');
        startShuttle(e.member.id);
        break;
      case 'member-done': {
        setActive(e.member.id, false);
        stopShuttle(e.member.id);
        // A filed draft opens the debate — the vote milestone lights up.
        setTask('vote', 'working');
        sendPacket(e.member.id, 'chair', 'pen', 1600);
        say(
          e.member.id,
          `Draft ready — ${e.events} events, ${e.flags} ${e.flags === 1 ? 'flag' : 'flags'}.`,
          `${e.events} events · ${e.flags} flags`,
        );
        {
          // Real citation counts — the analyst's most-cited source rides
          // along in the log entry and anchors their proposal card.
          const top = Object.entries(e.citations || {}).sort((a, b) => b[1] - a[1])[0];
          // The analyst's most-cited source earns a fact pill on its tile,
          // and the finding rides the mesh as a fact packet; drafts that
          // carry flags fire an amber ⚠ packet at the chair too.
          if (top) {
            addFact(top[0], `${e.member.name}: ${top[1]} ${top[1] === 1 ? 'citation' : 'citations'} in draft`, COUNCIL_COLORS[e.member.id]);
            schedule(500, () => sendPacket(e.member.id, 'chair', 'fact', 1800));
          }
          if (e.flags > 0) {
            schedule(1000, () => sendPacket(e.member.id, 'chair', 'flag', 2000));
          }
          addDecision(
            e.member.id,
            `${e.member.name} filed a draft`,
            `— ${e.events} events, ${e.flags} ${e.flags === 1 ? 'flag' : 'flags'}${top ? `; leans on ${top[0]} (${top[1]} ${top[1] === 1 ? 'citation' : 'citations'})` : ''}.`,
          );
          // Proposal card — the analyst's actual reading of the story (the
          // draft's lede), drawn from their most-cited source.
          patchCouncil({
            prop: {
              by: e.member.id,
              text: e.lede || `${e.events} datable events reconstructed from the record.`,
              source: top ? top[0] : 'the case files',
              votes: [],
              ruling: null,
            },
          });
        }
        break;
      }
      case 'member-error':
        setActive(e.member.id, false);
        stopShuttle(e.member.id);
        say(e.member.id, 'Could not complete a draft.', 'no draft');
        // A failed draft rides to the chair as a red ✕ decision packet.
        sendPacket(e.member.id, 'chair', 'no', 2000);
        addDecision(LOG_BAD, `${e.member.name} failed`, `— ${e.message}.`);
        break;
      case 'dispute': {
        setTask('draft', 'done');
        setTask('dispute', 'working');
        setActive('chair', true);
        say('chair', 'The council is split. I need direction from the author.');
        addDecision(LOG_STEER, 'The drafts disagree', `— ${e.drafts.map((d) => `${d.name}: ${d.events} ev, ${d.flags} fl`).join(' · ')}.`);
        // Decision packets: each objecting analyst fires a red ✕ at the
        // chair, then ONE big ?-mark pulses at the mesh crossing until the
        // ask panel opens — plus real objection chips on the proposal.
        // Votes and ✕ packets share one patch so both read the same prop.by.
        const ids = e.drafts.map((d) => d.id);
        patchCouncil((c) => {
          const objectors = c.prop ? ids.filter((id) => id !== c.prop.by) : ids;
          return {
            prop: c.prop && {
              ...c.prop,
              votes: objectors.map((id) => ({ by: id, verb: 'objects' })),
            },
            packets: [
              ...(c.packets || []).slice(-9),
              ...objectors.map((id) => ({ id: (packetSeq.current += 1), from: id, to: 'chair', icon: 'no', dur: 2200 })),
            ],
          };
        });
        schedule(1400, () => patchCouncil({ askMark: true }));
        break;
      }
      case 'steer':
        patchCouncil({ ask: null });
        setTask('dispute', 'done');
        addDecision('user', 'You decided', `— “${e.option.label}”.`);
        // The chair relays your approved direction as green ✓ packets.
        COUNCIL_UI.slice(1).forEach((m) => sendPacket('chair', m.id, 'ok', 1800));
        break;
      case 'chair-start':
        stopAllShuttles();
        // The merge begins — every analyst's draft rides back to the chair.
        COUNCIL_UI.slice(1).forEach((m) => sendPacket(m.id, 'chair', 'pen', 1600));
        patchCouncil((c) => ({
          tasks: { ...c.tasks, extract: 'done', draft: 'done', vote: 'done', dispute: 'done', merge: 'working' },
        }));
        setPhase('Final assembly');
        setActive('chair', true);
        say('chair', `Merging ${e.drafts} drafts into the final cut…`);
        addDecision(LOG_INFO, 'Merge begun', `— the chair weighs ${e.drafts} ${e.drafts === 1 ? 'draft' : 'drafts'} against each other.`);
        // Clarification chatter while the merge call is in flight.
        schedule(2000, () => COUNCIL_UI.slice(1).forEach((m, i) => {
          schedule(i * 600, () => sendPacket('chair', m.id, 'chat', 1800));
        }));
        break;
      case 'chair-done':
        setActive('chair', false);
        setTask('merge', 'done');
        setTask('save', 'working');
        // The accepted merge rides out to every analyst as a green ✓.
        COUNCIL_UI.slice(1).forEach((m) => sendPacket('chair', m.id, 'ok', 1800));
        addDecision(LOG_OK, 'Merged by the Chair', `— ${e.events} events kept, ${e.flags} ${e.flags === 1 ? 'flag' : 'flags'} raised.`);
        patchCouncil((c) => (c.prop
          ? { prop: { ...c.prop, ruling: { accepted: true, reason: `merged into the final story — ${e.events} events kept.` } } }
          : {}));
        break;
      case 'chair-skip':
        stopAllShuttles();
        patchCouncil((c) => ({
          tasks: { ...c.tasks, extract: 'done', draft: 'done', vote: 'done', dispute: 'done', merge: 'done', save: 'working' },
        }));
        addDecision(LOG_WARN, 'Merge skipped', '— a single draft survived; it stands as the record.');
        break;
      case 'chair-fallback':
        stopAllShuttles();
        setActive('chair', false);
        setTask('merge', 'done');
        setTask('save', 'working');
        addDecision(LOG_WARN, 'Chair unavailable', '— the richest draft stands in for the merge.');
        break;
      default:
        break;
    }
  };

  // Dispute panel resolution — resolves the pipeline's awaited promise on a
  // real run; on debug runs just logs the steer locally.
  const answerCouncil = (option) => {
    patchCouncil({ ask: null });
    const resolve = askResolverRef.current;
    if (resolve) {
      askResolverRef.current = null;
      resolve(option);
    } else {
      setTask('dispute', 'done');
      addDecision('user', 'You decided', `— “${option.label}”.`);
      // Debug ask-variations mode: the next question in the queue follows.
      const next = askQueueRef.current.shift();
      if (next) {
        askVarIdxRef.current += 1;
        schedule(700, () => {
          setTask('dispute', 'working');
          patchCouncil({ ask: next });
        });
      }
    }
  };

  // ── End-sequence gating ──
  // 'wait' holds the finale until the LAST travelling packet lands (packets
  // remove themselves onAnimationEnd); the gavel then slams, and the story
  // card follows at the slam's half mark.
  useEffect(() => {
    if (council?.endStage !== 'wait' || (council.packets || []).length > 0) return;
    schedule(250, () => patchCouncil((c) => (c.endStage === 'wait' ? { endStage: 'gavel' } : {})));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [council?.endStage, council?.packets?.length]);
  useEffect(() => {
    if (council?.endStage !== 'gavel') return;
    schedule(1050, () => patchCouncil((c) => (c.endStage === 'gavel' ? { endStage: 'story' } : {})));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [council?.endStage]);

  // The reconstructed story — { lede, events, flags, meta } — persisted per
  // project so reopening the tab lands straight on the built timeline.
  const [timeline, setTimeline] = useState(null);
  useEffect(() => {
    const pid = selectedProject?.id;
    if (!pid) return;
    const saved = loadCaseTimeline(pid);
    setTimeline(saved);
    setStep(saved ? 'timeline' : 'upload');
    setScanError(null);
  }, [selectedProject?.id]);

  // ── Real pipeline: extract text per file (the reading rail), then the AI
  // council (three analysts in parallel + the chair's merge) — every chamber
  // element updates from real pipeline events. Per-file bars ease while THAT
  // file's extraction is in flight (asymptotic toward 90, snap to 100 on
  // finish).
  const analyzeFiles = async () => {
    if (analyzing || files.length === 0) return;
    setAnalyzing(true);
    setDebugRun(false);
    setScanError(null);
    clearTimers();
    resetCouncilPause();
    pendingFactsRef.current = {};
    askQueueRef.current = [];
    askResolverRef.current = null;
    const items = files.map((f) => ({ name: f.name, mime: f.type || '', url: objectUrlFor(f) }));
    setScanItems(items);
    setScanProgress(items.map(() => 0));
    setScanning(true);
    setStep('scan');
    decisionSeq.current = 0;
    setCouncil({ ...freshCouncil(), phase: 'Reading sources' });
    setTask('read', 'working');
    setTask('extract', 'working');
    setActive('chair', true);
    say('chair', `Council convened. ${files.length === 1 ? 'One source' : `${files.length} sources`} on the table — read, then we draft.`);
    addDecision(LOG_INFO, 'Session opened', `— ${files.length} file${files.length === 1 ? '' : 's'} handed to the council.`);
    try {
      // Split the excerpt budget across the files (each also hard-capped by
      // extractFileText's own 16k limit).
      const perFileCap = Math.max(3000, Math.floor(TOTAL_EXCERPT_CHARS / files.length));
      const excerpts = [];
      for (let i = 0; i < files.length; i += 1) {
        // Ease this file's bar toward 90 while its extraction runs — an
        // honest in-flight indicator (extraction exposes no byte progress).
        const creep = setInterval(() => {
          if (pausedRef.current) return;
          setScanProgress((prev) => prev.map((p, j) => (j === i && p < 90 ? p + (90 - p) * 0.16 : p)));
        }, 120);
        const mime = files[i].type || guessMimeFromName(files[i].name);
        const isMedia = /^(image|video|audio)\//.test(mime);
        let res;
        try {
          // Sequential on purpose — keeps memory bounded and the rail readable.
          if (isMedia) {
            // Photos → AI vision; videos → key-section captions from the
            // extracted audio track; audio → Whisper captions.
            say('chair', mime.startsWith('image/')
              ? `Studying ${files[i].name} with AI vision…`
              : mime.startsWith('video/')
                ? `Watching ${files[i].name} — extracting key sections…`
                : `Listening to ${files[i].name}…`);
            // eslint-disable-next-line no-await-in-loop
            const m = await mediaToAiText(files[i], mime);
            res = m.text
              ? { text: m.text, media: m }
              : { error: m.kind === 'image' ? 'the AI found no readable content in the image' : 'no speech found' };
          } else {
            // eslint-disable-next-line no-await-in-loop
            res = await extractFileText(files[i], files[i].name);
          }
        } catch (mediaErr) {
          res = { error: String(mediaErr?.message ?? mediaErr) };
        } finally {
          clearInterval(creep);
        }
        excerpts.push(res.text
          ? { name: files[i].name, text: res.text.slice(0, perFileCap) }
          : { name: files[i].name, error: res.error || 'unreadable' });
        setScanProgress((prev) => prev.map((p, j) => (j === i ? 100 : p)));
        // Each finished file makes a visible hand-off — the chair passes it
        // around the table, one analyst at a time — and lands in the log
        // with what the AI made of it.
        const analyst = COUNCIL_UI[1 + (i % (COUNCIL_UI.length - 1))].id;
        sendPacket('chair', analyst, 'doc', 1800);
        if (res.text && res.media) {
          const m = res.media;
          addDecision(LOG_INFO, files[i].name, m.kind === 'image'
            ? `— image understood with AI vision (${(res.text.length / 1000).toFixed(1)}k characters).`
            : `— AI captions generated (${m.segments} timed ${m.segments === 1 ? 'segment' : 'segments'})${m.kind === 'video' ? '; key sections extracted' : ''}.`);
          addFact(files[i].name, m.kind === 'image'
            ? 'Understood with AI vision'
            : m.kind === 'video' ? 'Key sections captioned by AI' : 'Captions generated by AI', PACKET_COLORS.fact);
          // The finding rides back to the chair as a fact packet.
          schedule(900, () => sendPacket(analyst, 'chair', 'fact', 1800));
        } else if (res.text) {
          addDecision(LOG_INFO, files[i].name, `— read; ${(res.text.length / 1000).toFixed(1)}k characters extracted.`);
        } else {
          // Unreadable files still surface honestly — log + fact pill.
          addDecision(LOG_WARN, files[i].name, `— ${res.error || 'not readable in-app'}; filename used as context.`);
          addFact(files[i].name, 'Not readable — filename used as context', LOG_WARN);
        }
      }
      const readable = excerpts.filter((e) => e.text).length;
      setTask('read', 'done');
      setTask('extract', 'done');
      setActive('chair', false);
      addDecision(LOG_INFO, 'Intake complete', `— ${readable} of ${files.length} ${files.length === 1 ? 'file' : 'files'} readable as text.`);
      if (readable === 0) {
        throw new Error('none of the files could be understood — documents were unreadable and the AI couldn’t read the media (vision/transcription unavailable or no content found)');
      }

      const result = await runTimelineCouncil({
        projectName: selectedProject?.name,
        fileNames: files.map((f) => f.name),
        excerpts,
        onEvent: handleCouncilEvent,
        // Real dispute round — the chamber's ask panel resolves this promise;
        // the picked option's rule goes verbatim into the chair prompt.
        resolveDispute: (dispute) => new Promise((resolve) => {
          askResolverRef.current = resolve;
          // Let the objection ✕ packets and the pulsing ?-mark play on the
          // mesh before the ask panel fades the chamber out.
          schedule(2600, () => patchCouncil({
            askMark: false,
            ask: {
              question: 'The analysts disagree on the record.',
              context: `${dispute.drafts.map((d) => `${d.name} drafted ${d.events} events (${d.flags} ${d.flags === 1 ? 'flag' : 'flags'})`).join(' · ')}. How should the Chair weigh the drafts?`,
              options: dispute.options,
            },
          }));
        }),
      });
      const built = normalizeTimeline(result.parsed, files.length);
      if (!built) throw new Error('no datable events could be reconstructed from these files');
      // Council metadata rides along with the story (masthead credit line +
      // future surfaces).
      built.meta.council = result.council;
      // Filename → on-disk ref, so the timeline's file chips can open the
      // Doc Viewer (and paint real thumbnails) — persisted with the story.
      built.fileRefs = {};
      files.forEach((f) => {
        built.fileRefs[f.name] = { path: pathForFile(f), mime: f.type || '' };
      });
      setTimeline(built);
      saveCaseTimeline(selectedProject.id, built);
      setScanning(false);
      // End sequence — the story is saved; slam the gavel, then show the
      // ruling card with the real lede (its button opens the Timeline step).
      setTask('save', 'done');
      addDecision(LOG_INFO, 'Story saved', '— the reconstructed timeline is stored with this project.');
      setPhase('Story complete');
      say('chair', 'We have our story — every beat sourced and merged.');
      addDecision(LOG_OK, 'Final story approved', `— ${built.events.length} events, ${built.flags.length} open ${built.flags.length === 1 ? 'flag' : 'flags'}.`, [
        result.council.merged ? 'merged by the chair' : 'best draft stands',
        `${result.council.size} of ${COUNCIL_UI.length - 1} analysts filed`,
        ...(result.council.steer ? ['steered by you'] : []),
      ]);
      patchCouncil({
        ruling: result.council.merged && !result.council.degraded ? 'unanimous' : 'majority',
        lede: built.lede,
      });
      // Hold the finale until every travelling packet lands (the 'wait'
      // stage — see the end-sequence gating effects), with a fallback in
      // case a packet animation never finishes.
      schedule(400, () => patchCouncil({ endStage: 'wait' }));
      schedule(5000, () => patchCouncil((c) => (c.endStage === 'wait' ? { endStage: 'gavel' } : {})));
    } catch (err) {
      // Clears shuttles AND any scheduled dispute/ask timers, so a delayed
      // ask panel can't reopen over an adjourned session.
      clearTimers();
      setScanning(false);
      setScanError(String(err?.message ?? err));
      patchCouncil({ phase: 'Adjourned', ask: null, askMark: false });
      addDecision(LOG_BAD, 'Session adjourned', `— ${String(err?.message ?? err)}`);
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Debug simulator (the button under the header): fake bar progress on an
  // interval (files fill in waves) plus a scripted council session — same
  // event vocabulary as a real run, so the chamber can be demoed without
  // burning AI calls. Clearly fake data; never touches the saved timeline.
  const startDebugScan = () => {
    if (analyzing) return;
    clearTimers();
    resetCouncilPause();
    pendingFactsRef.current = {};
    askQueueRef.current = [];
    askResolverRef.current = null;
    const items = files.length > 0
      ? files.map((f) => ({ name: f.name, mime: f.type || '', url: objectUrlFor(f) }))
      : FALLBACK_SCAN_FILES;
    setScanItems(items);
    setScanProgress(items.map(() => 0));
    setScanning(true);
    setDebugRun(true);
    setScanError(null);
    setStep('scan');
    decisionSeq.current = 0;
    setCouncil({ ...freshCouncil(), phase: 'Reading sources' });
    // Every mechanic the chamber has, in one scripted session: read facts +
    // an unreadable file, three draft filings, TWO proposal rounds (one
    // accepted, one rejected), objection ✕ / question ? / verdict ✓ packets,
    // a dispute with the ask panel, a contradiction re-check, the merge and
    // the full end sequence — the maximal path, for debugging the UI.
    const fname = (i) => items[i % items.length].name;
    const vote = (by, verb, conf, packet) => {
      sendPacket(by, packet, verb === 'agrees' ? 'ok' : 'no', 1800);
      patchCouncil((c) => ({
        prop: c.prop && { ...c.prop, votes: [...c.prop.votes, { by, verb, conf }] },
      }));
      addDecision(by, `${COUNCIL_BY_ID[by].name} ${verb}`, `— confidence ${conf}%.`);
    };
    const script = [
      [400, () => {
        setTask('read', 'working');
        setTask('extract', 'working');
        setActive('chair', true);
        say('chair', `Council convened. ${items.length} sources on the table — read, then we draft.`);
        addDecision(LOG_INFO, 'Session opened', `— ${items.length} files handed to the council.`);
        // Read hand-offs — the chair passes finished files around the table
        // while the rail's bars fill — with per-file log entries recording
        // how much text each yielded.
        COUNCIL_UI.slice(1).forEach((m, i) => {
          schedule(1100 + i * 1400, () => sendPacket('chair', m.id, 'doc', 1800));
        });
        ['4.2', '1.8', '3.5'].forEach((kb, i) => {
          schedule(1500 + i * 1300, () => addDecision(LOG_INFO, fname(i), `— read; ${kb}k characters extracted.`));
        });
        // Fact pills for every file — queued per index and released the
        // moment THAT file's bar starts filling (see the release effect
        // below), so each finding lands as its file starts loading. Files
        // 0–3 carry the design bundle's verbatim facts, 4 the warning
        // path, the rest a rotating pool.
        const queueFact = (idx, text, color) => {
          const key = idx % items.length;
          (pendingFactsRef.current[key] = pendingFactsRef.current[key] || []).push({ text, color });
        };
        [
          [0, 'chronologist', 'Signed 14 Mar 2023 · €120k scope'],
          [0, 'auditor', 'Clause 9 sets late-payment penalties'],
          [1, 'narrator', 'Tone shifts sharply after 2 Jun'],
          [1, 'narrator', '9 Jun: escalation email sent'],
          [2, 'chronologist', 'Payments stop after 30 May'],
          [2, 'auditor', 'Invoice #204 unanswered'],
          [3, 'chronologist', 'Delays logged from 12 May'],
          [3, 'narrator', 'Client asked for a scope change'],
        ].forEach(([idx, member, text]) => queueFact(idx, text, COUNCIL_COLORS[member]));
        queueFact(4, 'Not readable — filename used as context', LOG_WARN);
        schedule(4400, () => {
          addDecision(LOG_WARN, fname(4), '— not readable in-app; filename used as context.');
        });
        const EXTRA_FACTS = [
          ['chronologist', 'Dated entries anchor the sequence'],
          ['narrator', 'Adds context to the June escalation'],
          ['auditor', 'Amounts reconcile with the ledger'],
          ['chronologist', 'Confirms the delivery window'],
          ['narrator', 'Names the counterparty’s signatory'],
          ['auditor', 'Flags a missing annex reference'],
        ];
        for (let i = 5; i < items.length; i += 1) {
          const [member, text] = EXTRA_FACTS[i % EXTRA_FACTS.length];
          queueFact(i, text, COUNCIL_COLORS[member]);
        }
      }],
      [5600, () => {
        setTask('read', 'done');
        setTask('extract', 'done');
        setActive('chair', false);
        addDecision(LOG_INFO, 'Intake complete', `— ${Math.max(items.length - 1, 1)} of ${items.length} files readable as text.`);
        addDecision(LOG_INFO, 'Deliberation opened', '— the chair hands the brief to every analyst.');
        setPhase('Deliberating');
        setTask('draft', 'working');
        COUNCIL_UI.slice(1).forEach((m, i) => {
          setActive(m.id, true);
          say(m.id, MEMBER_WORKING_LINE[m.id]);
          startShuttle(m.id);
          schedule(300 + i * 250, () => addDecision(m.id, `${m.name} began drafting`, '— reading the record through their lens.'));
        });
      }],
      // ── Round 1: Chronologist's opening proposal — ACCEPTED unanimously.
      [2600, () => {
        setActive('chronologist', false);
        stopShuttle('chronologist');
        sendPacket('chronologist', 'chair', 'pen', 1600);
        say('chronologist', 'Draft ready — 12 events, 1 flag.', '12 events · 1 flag');
        schedule(600, () => sendPacket('chronologist', 'chair', 'flag', 2000));
        setTask('vote', 'working');
        addDecision('chronologist', 'Chronologist filed a draft', `— 12 events, 1 flag; leans on ${fname(0)} (5 citations).`);
        patchCouncil({
          prop: {
            by: 'chronologist',
            text: 'Open at the framework agreement — 14 Mar 2023, €120k scope.',
            source: fname(0),
            votes: [],
            ruling: null,
          },
        });
      }],
      [1400, () => {
        say('auditor', 'Dates check out against the ledger. I agree.');
        vote('auditor', 'agrees', 84, 'chronologist');
      }],
      [1200, () => {
        say('narrator', 'A clean opening beat. Agreed.');
        vote('narrator', 'agrees', 76, 'chronologist');
      }],
      [1400, () => {
        say('chair', 'Accepted. Strong documentary anchor; both peers concur.');
        sendPacket('chair', 'chronologist', 'ok', 1800);
        addDecision(LOG_OK, 'Accepted by the Chair', '— strong documentary anchor; both peers concur.', ['proposed by Chronologist', `source: ${fname(0)}`, '2 agree · 0 object']);
        patchCouncil((c) => ({
          prop: c.prop && { ...c.prop, ruling: { accepted: true, reason: 'strong documentary anchor; both peers concur.' } },
        }));
      }],
      // ── Round 2: Narrator's turning point — objections, dispute, REJECTED.
      [1800, () => {
        setActive('narrator', false);
        stopShuttle('narrator');
        sendPacket('narrator', 'chair', 'pen', 1600);
        say('narrator', 'Draft ready — 8 events, 0 flags.', '8 events · 0 flags');
        addDecision('narrator', 'Narrator filed a draft', `— 8 events, 0 flags; leans on ${fname(1)} (3 citations).`);
        patchCouncil({
          prop: {
            by: 'narrator',
            text: 'Frame the June emails as the turning point of the story.',
            source: fname(1),
            votes: [],
            ruling: null,
          },
        });
      }],
      [1400, () => {
        say('auditor', 'Hold on — the email dates conflict with the invoice log.');
        vote('auditor', 'objects', 68, 'narrator');
      }],
      [1200, () => {
        say('chronologist', 'The 9 Jun email predates the payment stop? Sequence unclear.');
        vote('chronologist', 'objects', 55, 'narrator');
      }],
      [1400, () => {
        setActive('auditor', false);
        stopShuttle('auditor');
        sendPacket('auditor', 'chair', 'pen', 1600);
        say('auditor', 'Draft ready — 13 events, 4 flags.', '13 events · 4 flags');
        schedule(600, () => sendPacket('auditor', 'chair', 'flag', 2000));
        addDecision('auditor', 'Auditor filed a draft', '— 13 events, 4 flags.');
        setTask('draft', 'done');
        setTask('dispute', 'working');
        setActive('chair', true);
        say('chair', 'The council is split. I need direction from the author.');
        addDecision(LOG_STEER, 'The drafts disagree', '— Chronologist: 12 ev, 1 fl · Narrator: 8 ev, 0 fl · Auditor: 13 ev, 4 fl.');
        // The objectors fire red ✕ decision packets at the chair, then ONE
        // big ?-mark pulses at the mesh crossing; the ask panel waits so
        // both get their moment before the chamber fades.
        sendPacket('auditor', 'chair', 'no', 2200);
        sendPacket('chronologist', 'chair', 'no', 2200);
        schedule(1300, () => patchCouncil({ askMark: true }));
        schedule(2600, () => patchCouncil({
          askMark: false,
          ask: {
            question: 'The analysts disagree on the record.',
            context: 'Chronologist drafted 12 events (1 flag) · Narrator drafted 8 events (0 flags) · Auditor drafted 13 events (4 flags). How should the Chair weigh the drafts?',
            options: DISPUTE_OPTIONS,
          },
        }));
      }],
      // The simulator doesn't wait for an answer — an unanswered panel is
      // dismissed as the chair proceeds (answering earlier logs the steer).
      [6200, () => {
        patchCouncil({ ask: null });
        setTask('dispute', 'done');
        say('chair', 'Rejected for now — the dates get verified before this beat lands.');
        sendPacket('chair', 'narrator', 'no', 1800);
        addDecision(LOG_BAD, 'Rejected by the Chair', '— held until the Auditor reconciles the ledger dates.', ['proposed by Narrator', '0 agree · 2 object']);
        patchCouncil((c) => ({
          prop: c.prop && { ...c.prop, ruling: { accepted: false, reason: 'held until the ledger dates are reconciled.' } },
        }));
      }],
      // ── Contradiction re-check: the Auditor clears the mismatch.
      [1800, () => {
        setActive('auditor', true);
        say('auditor', 'Re-reading invoice #204 against the 9 Jun email…');
        startShuttle('auditor');
      }],
      [2400, () => {
        setActive('auditor', false);
        stopShuttle('auditor');
        say('auditor', 'Resolved: the ledger posting lagged. Narrator’s date stands.');
        sendPacket('auditor', 'chair', 'fact', 1800);
        addFact(fname(2), 'Ledger posting lagged — 9 Jun holds', COUNCIL_COLORS.auditor);
        addDecision(LOG_INFO, 'Contradiction resolved', '— invoice ledger posting lag explained the mismatch.');
      }],
      // ── Round 3: the beat returns verified — ACCEPTED.
      [1400, () => {
        sendPacket('narrator', 'chair', 'pen', 1600);
        say('narrator', 'Turning point: the 9 Jun escalation email — now cross-checked.');
        patchCouncil({
          prop: {
            by: 'narrator',
            text: 'Turning point: the 9 Jun escalation email — now cross-checked.',
            source: fname(1),
            votes: [],
            ruling: null,
          },
        });
      }],
      [1200, () => {
        say('auditor', 'Verified this round. Agreed.');
        vote('auditor', 'agrees', 88, 'narrator');
      }],
      [1000, () => vote('chronologist', 'agrees', 83, 'narrator')],
      [1300, () => {
        say('chair', 'Accepted. Second reading holds; the contradiction is cleared.');
        sendPacket('chair', 'narrator', 'ok', 1800);
        addDecision(LOG_OK, 'Accepted by the Chair', '— second reading holds; the contradiction is cleared.', ['proposed by Narrator', `source: ${fname(1)}`, '2 agree · 0 object', 'avg confidence 86%']);
        patchCouncil((c) => ({
          prop: c.prop && { ...c.prop, ruling: { accepted: true, reason: 'second reading holds; the contradiction is cleared.' } },
        }));
      }],
      // ── Merge + save + end sequence.
      [1800, () => {
        stopAllShuttles();
        setPhase('Final assembly');
        setTask('vote', 'done');
        setTask('merge', 'working');
        say('chair', 'Merging 3 drafts into the final cut…');
        addDecision(LOG_INFO, 'Merge begun', '— the chair weighs 3 drafts against each other.');
        // The merge begins — every analyst's draft rides back to the chair,
        // and clarification chatter flows while the cut is assembled.
        COUNCIL_UI.slice(1).forEach((m, i) => {
          sendPacket(m.id, 'chair', 'pen', 1600);
          schedule(1400 + i * 600, () => sendPacket('chair', m.id, 'chat', 1800));
        });
      }],
      [2000, () => {
        setActive('chair', false);
        setTask('merge', 'done');
        setTask('save', 'working');
        COUNCIL_UI.slice(1).forEach((m) => sendPacket('chair', m.id, 'ok', 1800));
        addDecision(LOG_OK, 'Merged by the Chair', '— 14 events kept, 4 flags raised.');
      }],
      [700, () => {
        setTask('save', 'done');
        setPhase('Story complete');
        addDecision(LOG_INFO, 'Story saved', '— the reconstructed timeline is stored with this project.');
        say('chair', 'We have our story — every beat sourced and voted on.');
        addDecision(LOG_OK, 'Final story approved', '— 14 events, 4 open flags.', ['merged by the chair', '3 of 3 analysts filed', '2 beats accepted · 1 held']);
        patchCouncil({
          ruling: 'majority',
          lede: 'A €120k framework deal signed in March 2023 unravels when payments stop and invoice #204 goes unanswered; a June escalation turns delay into dispute — until a scope change closes the loop in a revised deal.',
        });
      }],
      // The gavel waits for the last packet to land ('wait' stage + gating
      // effects), with a stuck-packet fallback; the story follows the slam's
      // half mark automatically.
      [700, () => {
        patchCouncil({ endStage: 'wait' });
        schedule(4300, () => patchCouncil((c) => (c.endStage === 'wait' ? { endStage: 'gavel' } : {})));
      }],
    ];
    let at = 0;
    script.forEach(([d, fn]) => { at += d; schedule(at, fn); });
  };

  // ── Debug finale (third button): skip the council thinking entirely and
  // jump straight to the end sequence — gavel slam (cut at its half mark),
  // then the ruling card. Same fake-data rules as the simulator.
  const startDebugGavel = () => {
    if (analyzing) return;
    clearTimers();
    resetCouncilPause();
    pendingFactsRef.current = {};
    askQueueRef.current = [];
    askResolverRef.current = null;
    const items = files.length > 0
      ? files.map((f) => ({ name: f.name, mime: f.type || '', url: objectUrlFor(f) }))
      : FALLBACK_SCAN_FILES;
    setScanItems(items);
    setScanProgress(items.map(() => 100));
    setScanning(false);
    setDebugRun(true);
    setScanError(null);
    setStep('scan');
    decisionSeq.current = 0;
    setCouncil({
      ...freshCouncil(),
      phase: 'Story complete',
      tasks: Object.fromEntries(COUNCIL_TASKS.map((t) => [t.id, 'done'])),
      ruling: 'unanimous',
      lede: 'A €120k framework deal signed in March 2023 unravels when payments stop and invoice #204 goes unanswered; a June escalation turns delay into dispute — until a scope change closes the loop in a revised deal.',
    });
    // No packets in this shortcut — 'wait' falls straight through to the
    // gavel via the gating effects, and the story follows automatically.
    schedule(200, () => patchCouncil({ endStage: 'wait' }));
  };

  // ── Debug ask variations (fourth button): step through every shape the
  // "We have a question…" modal supports — single select, multi select,
  // confirm, free text — advancing on each answer.
  const startDebugAsks = () => {
    if (analyzing) return;
    // Already showing a question in debug mode? Each press CYCLES to the
    // next shape (wrapping), without resetting the chamber.
    if (debugRun && council?.ask) {
      askVarIdxRef.current = (askVarIdxRef.current + 1) % ASK_VARIATIONS.length;
      askQueueRef.current = ASK_VARIATIONS.slice(askVarIdxRef.current + 1);
      patchCouncil({ ask: ASK_VARIATIONS[askVarIdxRef.current] });
      return;
    }
    clearTimers();
    resetCouncilPause();
    pendingFactsRef.current = {};
    askQueueRef.current = [];
    askResolverRef.current = null;
    const items = files.length > 0
      ? files.map((f) => ({ name: f.name, mime: f.type || '', url: objectUrlFor(f) }))
      : FALLBACK_SCAN_FILES;
    setScanItems(items);
    setScanProgress(items.map(() => 100));
    setScanning(false);
    setDebugRun(true);
    setScanError(null);
    setStep('scan');
    decisionSeq.current = 0;
    askVarIdxRef.current = 0;
    askQueueRef.current = ASK_VARIATIONS.slice(1);
    setCouncil({
      ...freshCouncil(),
      phase: 'Deliberating',
      tasks: {
        ...Object.fromEntries(COUNCIL_TASKS.map((t) => [t.id, 'done'])),
        dispute: 'working',
        merge: 'queued',
        save: 'queued',
      },
      ask: ASK_VARIATIONS[0],
    });
  };

  // Release queued simulator facts the moment their file starts loading —
  // each pill appears as its file's bar begins to fill (slightly staggered
  // when a file carries several).
  useEffect(() => {
    if (!debugRun) return;
    scanProgress.forEach((p, i) => {
      const queued = p > 0 && pendingFactsRef.current[i];
      if (!queued) return;
      delete pendingFactsRef.current[i];
      const name = scanItems[i]?.name;
      if (!name) return;
      queued.forEach((f, j) => schedule(150 + j * 450, () => {
        addFact(name, f.text, f.color);
        // The first finding of each file also rides the mesh: a fact packet
        // from its analyst (or an amber flag from the chair for warnings).
        if (j === 0) {
          const member = MEMBER_BY_COLOR[f.color];
          if (member) sendPacket(member, 'chair', 'fact', 1800);
          else sendPacket('chair', 'auditor', 'flag', 2000);
        }
      }));
    });
  }, [scanProgress, debugRun]);

  useEffect(() => {
    if (!scanning || !debugRun) return undefined;
    const id = setInterval(() => {
      if (pausedRef.current) return;
      setScanProgress((prev) => prev.map((p, i) => {
        if (p >= 100) return 100;
        if (i > 0 && prev[i - 1] < 45) return p;
        return Math.min(100, p + 1.2 + Math.random() * 2.8);
      }));
    }, 90);
    return () => clearInterval(id);
  }, [scanning, debugRun]);

  // Park the simulator once every file has finished (real runs end when the
  // AI response lands instead).
  useEffect(() => {
    if (scanning && debugRun && scanProgress.length > 0 && scanProgress.every((p) => p >= 100)) {
      setScanning(false);
    }
  }, [scanning, debugRun, scanProgress]);

  if (loading && !selectedProject) return null;

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to build its case timeline.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  const stepIdx = STEPS.findIndex((s) => s.id === step);

  // Step-switch enter animation (the Activity tab's feed treatment): the
  // body below the step rail fades/slides in from the side the rail just
  // travelled toward; the keyed remount replays it on every switch.
  const prevStepIdxRef = useRef(stepIdx);
  const stepEnterDir = stepIdx >= prevStepIdxRef.current ? 'right' : 'left';
  useEffect(() => { prevStepIdxRef.current = stepIdx; }, [stepIdx]);

  return (
    <div className="cto-root">
      {/* ── Masthead (option 1a) — eyebrow + editorial title + description.
          Once the timeline is built, the header switches to describe the
          reconstructed story instead of the upload prompt. */}
      <header className="cto-masthead">
        <div className="cto-mh-main">
          <div className="cto-mh-eyebrow">
            <span>Case chronology</span>
            <span className="cto-mh-ref">· built from your files</span>
          </div>
          {step === 'timeline' && timeline ? (
            <>
              <h1 className="cto-mh-title">The story, reconstructed</h1>
              <p className="cto-mh-kicker">
                {timeline.lede
                  || 'DocVex read every file and assembled the events into a single chronological narrative.'}
              </p>
              <div className="cto-story-meta">
                Reconstructed by {timeline.meta?.council
                  ? `a DocVex AI council (${timeline.meta.council.merged
                    ? `${timeline.meta.council.size} analysts + chair`
                    : `${timeline.meta.council.size} analyst${timeline.meta.council.size === 1 ? '' : 's'}`})`
                  : 'DocVex'} from {timeline.meta?.fileCount ?? timeline.events.length}{' '}
                {(timeline.meta?.fileCount ?? 0) === 1 ? 'file' : 'files'} ·{' '}
                {timeline.events.length} {timeline.events.length === 1 ? 'event' : 'events'} ·{' '}
                <span className="cto-story-flags">
                  {timeline.flags.length} open {timeline.flags.length === 1 ? 'flag' : 'flags'}
                </span>
              </div>
            </>
          ) : (
            <>
              <h1 className="cto-mh-title">Timeline</h1>
              <p className="cto-mh-kicker">
                Drop in every document, email and recording tied to the matter.
                DocVex reads, transcribes and cross-checks them, then assembles
                a chronological story — flagging gaps and contradictions for you
                to resolve.
              </p>
            </>
          )}
        </div>
      </header>

      {/* Dev affordances — the simulator seeds the Scanning grid from the
          uploaded files (or the fallback sample set) and animates their
          progress; the pause toggle freezes the council process in place. */}
      <div className="cto-debug-row">
        <button type="button" className="cto-debug-btn" onClick={startDebugScan}>
          Debug · simulate scan
        </button>
        <button
          type="button"
          className={`cto-debug-btn${paused ? ' is-on' : ''}`}
          onClick={toggleCouncilPause}
        >
          {paused ? 'Debug · resume council' : 'Debug · pause council'}
        </button>
        <button type="button" className="cto-debug-btn" onClick={startDebugGavel}>
          Debug · gavel finale
        </button>
        <button type="button" className="cto-debug-btn" onClick={startDebugAsks}>
          Debug · ask variations
        </button>
      </div>

      {/* ── Step rail (option 1a) — numbered circles + connector lines. */}
      <div className="cto-steps" role="tablist" aria-label="Onboarding steps">
        {STEPS.map((s, i) => {
          const state = i === stepIdx ? 'active' : i < stepIdx ? 'done' : 'todo';
          return (
            <div key={s.id} className="cto-step-cell">
              <button
                type="button"
                role="tab"
                aria-selected={state === 'active'}
                className="cto-step"
                onClick={() => setStep(s.id)}
              >
                <span className="cto-step-dot" data-state={state}>
                  {state === 'done' ? <IcoCheck width="14" height="14" /> : s.n}
                </span>
                <span className="cto-step-label">{s.label}</span>
              </button>
              {i < STEPS.length - 1 && <span className="cto-step-line" aria-hidden="true" />}
            </div>
          );
        })}
      </div>

      <div key={step} className={`cto-step-body is-enter-${stepEnterDir}`}>
      {step === 'upload' && (
        <UploadStep
          files={files}
          addFiles={addFiles}
          removeFile={removeFile}
          onAnalyze={analyzeFiles}
          analyzing={analyzing}
        />
      )}
      {step === 'scan' && (
        <CouncilStep
          items={scanItems}
          progress={scanProgress}
          council={council}
          paused={paused}
          user={logUser}
          error={scanError}
          onAnswer={answerCouncil}
          onPacketDone={removePacket}
          onReadStory={() => setStep('timeline')}
          // Redo — re-run the same kind of session that just finished: the
          // simulator for debug runs, the real analysis when files are in
          // hand (falls back to the Upload step otherwise).
          onRedo={() => {
            if (debugRun) startDebugScan();
            else if (files.length > 0) analyzeFiles();
            else setStep('upload');
          }}
        />
      )}
      {step === 'timeline' && <TimelineStep timeline={timeline} />}
      {step === 'review' && <ReviewStep timeline={timeline} goTimeline={() => setStep('timeline')} />}
      </div>
    </div>
  );
}
