import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { glyphForFile } from '../../components/fileGlyph';
import FileThumbnail from '../../components/FileThumbnail';
import { extractFileText } from '../../lib/extractFileText';
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
const IcoPen = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
);
const IcoChat = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
);
const IcoAsk = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
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
  { id: 'draft', label: 'Analysts draft chronologies' },
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
  { id: 'chair', name: 'The Chair', role: 'Presiding', color: '#8B5E3C', x: 280, y: 60, bubblePos: 'right' },
  { id: 'chronologist', name: 'Chronologist', role: 'Dates & record', color: '#4F46E5', x: 85, y: 330, bubblePos: 'top-left' },
  { id: 'narrator', name: 'Narrator', role: 'Causal story', color: '#BE185D', x: 475, y: 330, bubblePos: 'top-right' },
  { id: 'auditor', name: 'Auditor', role: 'Contradictions', color: '#B45309', x: 280, y: 435, bubblePos: 'right' },
];
const COUNCIL_COLORS = Object.fromEntries(COUNCIL_UI.map((m) => [m.id, m.color]));
const COUNCIL_BY_ID = Object.fromEntries(COUNCIL_UI.map((m) => [m.id, m]));

// Packets must ride the DRAWN lines. The chair has a single line (straight
// down to the auditor) crossing the analysts' horizontal at the (280,330)
// intersection — chair ↔ side-analyst traffic turns at that junction. The
// two bottom edges are curves (they bow downward).
const SPECIAL_EDGES = {
  'chair|chronologist': { d: 'M 280 60 L 280 330 L 85 330', start: 'chair' },
  'chair|narrator': { d: 'M 280 60 L 280 330 L 475 330', start: 'chair' },
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
// Upload → per-file text extraction (lib/extractFileText, drives the scan
// grid) → the AI COUNCIL (lib/timelineCouncil): three analysts draft
// independent chronologies in parallel, a chair merges them into one strict-
// JSON timeline (draft disagreements become Contradiction flags) → normalised
// + persisted per project. Media files can't be read in-renderer (no
// transcription wired here), so they contribute their filename as context
// only.

// Saved-timeline storage (one entry per project) lives in lib/caseTimeline.js
// — shared with the Files tab's virtual "Timeline" folder.

// Total character budget across every file excerpt sent to each council
// analyst (the chair reads the drafts, not the files).
const TOTAL_EXCERPT_CHARS = 60000;

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
function CouncilStep({ items, progress, council, error, onAnswer, onPacketDone, onReadStory }) {
  // Keep the file currently being read in view — the rail scrolls (with its
  // native scrollbar hidden), so follow the reading head as it moves down
  // the grid.
  const railRef = useRef(null);
  const readingIdx = progress.findIndex((p) => p > 0 && p < 100);
  useEffect(() => {
    if (readingIdx < 0) return;
    railRef.current
      ?.querySelector(`[data-idx="${readingIdx}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [readingIdx]);
  // Display-only scroll indicator to the LEFT of the rail — size/position
  // mirror the rail's scroll state; it accepts no input (pointer-events off).
  const [bar, setBar] = useState({ size: 0, top: 0 });
  const measureRail = () => {
    const el = railRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight > el.clientHeight + 1;
    setBar({
      size: scrollable ? el.clientHeight / el.scrollHeight : 0,
      top: scrollable ? el.scrollTop / el.scrollHeight : 0,
    });
  };
  useEffect(measureRail, [items.length]);

  if (!council || items.length === 0) {
    return (
      <p className="cto-scan-empty">
        Nothing scanned yet — pick files in the Upload step and press
        “Analyze with AI”.
      </p>
    );
  }
  const ending = council.endStage === 'gavel' || council.endStage === 'story';
  // While the council waits on the author, the chamber and files fade out
  // and the input panel fades in centered above them.
  const asking = !!council.ask && !ending;
  const hidden = ending || asking;

  return (
    <div>
      <div className="cc-card">
        <div className="cc-stage">
          {/* The scanned files — Files-tab tiles (fx-grid / fx-tile) in a
              3-wide grid to the left of the ring. The file currently being
              read lights up with the Files tab's selection styling. */}
          <div className={`cc-filewrap${hidden ? ' is-out' : ''}`}>
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
              </div>
            </div>
          </div>

          {/* The chamber — spinning ring, orbiting artefacts, four members. */}
          <div className="cc-ring-wrap">
            {/* Dashed round-table mesh: the chair holds a SINGLE line —
                straight down to the auditor — crossing the analysts'
                horizontal at the (280,330) intersection. The bottom edges
                bow downward like a table's near side. */}
            <svg className={`cc-mesh${hidden ? ' is-out' : ''}`} viewBox="0 0 560 540" aria-hidden="true">
              <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="6 10">
                <path d="M 280 60 L 280 435" />
                <path d="M 85 330 L 475 330" />
                <path d="M 85 330 Q 172 452 280 435" />
                <path d="M 475 330 Q 388 452 280 435" />
              </g>
              {/* Junction node where the chair's line crosses the analysts'. */}
              <circle cx="280" cy="330" r="7" fill="currentColor" />
            </svg>
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
              const Icon = p.icon === 'pen' ? IcoPen : p.icon === 'chat' ? IcoChat : IcoDoc;
              return (
                <span
                  key={p.id}
                  className={`cc-packet${path.reverse ? ' is-rev' : ''}${hidden ? ' is-out' : ''}`}
                  style={{ offsetPath: `path("${path.d}")`, animationDuration: `${p.dur}ms` }}
                  onAnimationEnd={() => onPacketDone(p.id)}
                  aria-hidden="true"
                >
                  <Icon width="15" height="15" />
                </span>
              );
            })}
            {COUNCIL_UI.map((m) => {
              const st = council.members[m.id] || {};
              return (
                <div key={m.id} className={`cc-member${hidden ? ' is-out' : ''}`} style={{ left: m.x, top: m.y }}>
                  <div className="cc-avatar-wrap">
                    <span
                      className="cc-avatar-glow"
                      style={{
                        background: `radial-gradient(circle, ${m.color}55 0%, ${m.color}22 45%, transparent 70%)`,
                        opacity: st.active ? 1 : 0,
                      }}
                      aria-hidden="true"
                    />
                    <span
                      className="cc-avatar"
                      style={{
                        borderColor: m.color,
                        color: m.color,
                        boxShadow: st.active ? `0 0 0 4px ${m.color}22, 0 6px 16px rgba(15, 23, 42, 0.12)` : undefined,
                      }}
                    >
                      <IcoUser width="26" height="26" />
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

            {/* End sequence — gavel slam, then the ruling card with the real
                lede and the hand-off to the Timeline step. */}
            {council.endStage === 'gavel' && (
              <div className="cc-gavel">
                <svg width="180" height="180" viewBox="0 0 200 200" aria-label="Gavel slam">
                  <g fill="#8B5E3C" style={{ transformBox: 'view-box', transformOrigin: '57px 151px', animation: 'ccGvShake 1.8s 1' }}>
                    <path d="M 22.0,146.9 v-5.4 a6.5,6.5 0 0 1 6.5,-6.5 h56.4 a6.5,6.5 0 0 1 6.5,6.5 v5.4 z" />
                    <rect x="17.8" y="151.0" width="77.7" height="13.6" rx="2.6" />
                  </g>
                  <g fill="#8B5E3C" style={{ transformBox: 'view-box', transformOrigin: '179.9px 140.7px', animation: 'ccGvSlam 1.8s 1 forwards' }}>
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
                <button type="button" className="cc-story-btn" onClick={onReadStory}>
                  Read the whole story →
                </button>
              </div>
            )}
          </div>

          {/* Real dispute panel — beside the ring while open; the picked
              option's rule steers the chair's merge. */}
          {council.ask && !ending && (
            <div className="cc-ask">
              <div className="cc-ask-head">
                <span className="cc-ask-ico"><IcoAsk width="13" height="13" /></span>
                <span>The council needs your input</span>
              </div>
              <p className="cc-ask-q">{council.ask.question}</p>
              <p className="cc-ask-ctx">{council.ask.context}</p>
              <div className="cc-ask-opts">
                {council.ask.options.map((o) => (
                  <button key={o.id} type="button" className="cc-ask-opt" onClick={() => onAnswer(o)}>
                    <span className="cc-ask-opt-label">{o.label}</span>
                    <span className="cc-ask-opt-desc">{o.desc}</span>
                  </button>
                ))}
              </div>
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
              <div className="cc-prop-head">
                <span className="cc-prop-by" style={{ color: by.color }}>
                  <span className="cc-prop-dot" style={{ background: by.color }} aria-hidden="true" />
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
                    return (
                      <span key={v.by} className="cc-prop-vote">
                        <span className="cc-prop-dot" style={{ background: vm.color }} aria-hidden="true" />
                        {vm.name} <span className="cc-prop-verb" data-ok={v.verb === 'agrees' || undefined}>{v.verb}</span>
                        {v.conf != null && <span className="cc-prop-conf">{v.conf}%</span>}
                      </span>
                    );
                  })}
                </div>
              )}
              {r && (
                <div className="cc-prop-ruling" data-ok={r.accepted || undefined}>
                  <strong>{r.accepted ? '✓ Accepted by the Chair' : '✕ Rejected by the Chair'}</strong> — {r.reason}
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
                  <span className="cc-log-dot" style={{ background: d.dot }} aria-hidden="true" />
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
                    <span className="cc-task-dot" aria-hidden="true">{state === 'done' ? '✓' : ''}</span>
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

// Source-file chip on a timeline event — thumbnail + name, Files-tab style.
// Clicking opens the file in the Doc Viewer when we know its on-disk path
// (Electron); chips without a path render inert.
function EventFileChip({ name, fileRef }) {
  const mime = fileRef?.mime || guessMimeFromName(name);
  const openable = !!fileRef?.path;
  return (
    <button
      type="button"
      className="cto-ev-file"
      disabled={!openable}
      onClick={() => openable && openDocViewerWindow({ path: fileRef.path, name, mime })}
    >
      <span className="cto-ev-file-thumb">
        <FileThumbnail
          mimeType={mime}
          sourceUrl={localFileUrl(fileRef?.path) || undefined}
          glyph={glyphForFile(mime, name)}
        />
      </span>
      <span className="cto-ev-file-name">{name}</span>
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
                    <span className="cto-ev-kind" data-cat={e.cat}>{e.kind}</span>
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
  const [step, setStep] = useState('upload');

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
  const timersRef = useRef([]);
  const decisionSeq = useRef(0);
  const shuttleRef = useRef({});
  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    Object.values(shuttleRef.current).forEach(clearInterval);
    shuttleRef.current = {};
  };
  useEffect(() => clearTimers, []);
  const schedule = (ms, fn) => { timersRef.current.push(setTimeout(fn, ms)); };
  const freshCouncil = () => ({
    phase: 'Convening',
    tasks: Object.fromEntries(COUNCIL_TASKS.map((t) => [t.id, 'queued'])),
    members: Object.fromEntries(COUNCIL_UI.map((m) => [m.id, { active: false, bubble: '', stats: '' }])),
    decisions: [],
    packets: [],
    prop: null,
    ask: null,
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
  const addDecision = (dot, head, text, chips) => patchCouncil((c) => ({
    decisions: [
      { id: (decisionSeq.current += 1), dot, head, text, chips: chips || [] },
      ...c.decisions,
    ].slice(0, 40),
  }));
  // Files/thoughts in transit along the mesh (rendered as .cc-packet).
  // Capped so a stuck animation can't grow the array unbounded.
  const packetSeq = useRef(0);
  const sendPacket = (from, to, icon = 'doc', dur = 1900) => patchCouncil((c) => ({
    packets: [...(c.packets || []).slice(-11), { id: (packetSeq.current += 1), from, to, icon, dur }],
  }));
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

  // Map the council pipeline's event stream onto chamber state.
  const handleCouncilEvent = (e) => {
    switch (e.type) {
      case 'convene':
        setPhase('Deliberating');
        setTask('draft', 'working');
        say('chair', 'Drafts, please — each analyst reads the record through their own lens.');
        break;
      case 'member-start':
        setActive(e.member.id, true);
        say(e.member.id, MEMBER_WORKING_LINE[e.member.id] || 'Drafting…');
        startShuttle(e.member.id);
        break;
      case 'member-done': {
        setActive(e.member.id, false);
        stopShuttle(e.member.id);
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
          addDecision(
            COUNCIL_COLORS[e.member.id],
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
        addDecision(LOG_BAD, `${e.member.name} failed`, `— ${e.message}.`);
        break;
      case 'dispute': {
        setTask('draft', 'done');
        setTask('dispute', 'working');
        setActive('chair', true);
        say('chair', 'The council is split. I need direction from the author.');
        addDecision(LOG_STEER, 'The drafts disagree', `— ${e.drafts.map((d) => `${d.name}: ${d.events} ev, ${d.flags} fl`).join(' · ')}.`);
        // Disagreement chatter along the analyst-to-analyst edges, and real
        // objection chips on the standing proposal from the OTHER analysts.
        const ids = e.drafts.map((d) => d.id);
        ids.forEach((a, i) => {
          const b = ids[(i + 1) % ids.length];
          if (b !== a) sendPacket(a, b, 'chat', 2200);
        });
        patchCouncil((c) => (c.prop
          ? {
            prop: {
              ...c.prop,
              votes: ids.filter((id) => id !== c.prop.by).map((id) => ({ by: id, verb: 'objects' })),
            },
          }
          : {}));
        break;
      }
      case 'steer':
        patchCouncil({ ask: null });
        setTask('dispute', 'done');
        addDecision(LOG_STEER, 'You decided', `— “${e.option.label}”.`);
        // The chair relays your direction to every analyst.
        COUNCIL_UI.slice(1).forEach((m) => sendPacket('chair', m.id, 'chat', 1800));
        break;
      case 'chair-start':
        stopAllShuttles();
        patchCouncil((c) => ({
          tasks: { ...c.tasks, draft: 'done', dispute: 'done', merge: 'working' },
        }));
        setPhase('Final assembly');
        setActive('chair', true);
        say('chair', `Merging ${e.drafts} drafts into the final cut…`);
        break;
      case 'chair-done':
        setActive('chair', false);
        setTask('merge', 'done');
        setTask('save', 'working');
        addDecision(LOG_OK, 'Merged by the Chair', `— ${e.events} events kept, ${e.flags} ${e.flags === 1 ? 'flag' : 'flags'} raised.`);
        patchCouncil((c) => (c.prop
          ? { prop: { ...c.prop, ruling: { accepted: true, reason: `merged into the final story — ${e.events} events kept.` } } }
          : {}));
        break;
      case 'chair-skip':
        stopAllShuttles();
        patchCouncil((c) => ({
          tasks: { ...c.tasks, draft: 'done', dispute: 'done', merge: 'done', save: 'working' },
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
      addDecision(LOG_STEER, 'You decided', `— “${option.label}”.`);
    }
  };

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
    askResolverRef.current = null;
    const items = files.map((f) => ({ name: f.name, mime: f.type || '', url: objectUrlFor(f) }));
    setScanItems(items);
    setScanProgress(items.map(() => 0));
    setScanning(true);
    setStep('scan');
    decisionSeq.current = 0;
    setCouncil({ ...freshCouncil(), phase: 'Reading sources' });
    setTask('read', 'working');
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
          setScanProgress((prev) => prev.map((p, j) => (j === i && p < 90 ? p + (90 - p) * 0.16 : p)));
        }, 120);
        let res;
        try {
          // Sequential on purpose — keeps memory bounded and the rail readable.
          // eslint-disable-next-line no-await-in-loop
          res = await extractFileText(files[i], files[i].name);
        } finally {
          clearInterval(creep);
        }
        excerpts.push(res.text
          ? { name: files[i].name, text: res.text.slice(0, perFileCap) }
          : { name: files[i].name, error: res.error || 'unreadable' });
        setScanProgress((prev) => prev.map((p, j) => (j === i ? 100 : p)));
        // Unreadable files still surface honestly, via the decision log.
        if (!res.text) addDecision(LOG_WARN, files[i].name, '— not readable in-app; filename used as context.');
      }
      const readable = excerpts.filter((e) => e.text).length;
      setTask('read', 'done');
      setActive('chair', false);
      addDecision(LOG_INFO, 'Intake complete', `— ${readable} of ${files.length} ${files.length === 1 ? 'file' : 'files'} readable as text.`);
      if (readable === 0) {
        throw new Error('none of the files could be read as text (media files need transcription, which isn’t wired into this tab yet)');
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
          patchCouncil({
            ask: {
              question: 'The analysts disagree on the record.',
              context: `${dispute.drafts.map((d) => `${d.name} drafted ${d.events} events (${d.flags} ${d.flags === 1 ? 'flag' : 'flags'})`).join(' · ')}. How should the Chair weigh the drafts?`,
              options: dispute.options,
            },
          });
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
      schedule(700, () => patchCouncil({ endStage: 'gavel' }));
      schedule(2800, () => patchCouncil({ endStage: 'story' }));
    } catch (err) {
      stopAllShuttles();
      setScanning(false);
      setScanError(String(err?.message ?? err));
      patchCouncil({ phase: 'Adjourned', ask: null });
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
    const script = [
      [400, () => {
        setTask('read', 'working');
        setActive('chair', true);
        say('chair', `Council convened. ${items.length} sources on the table — read, then we draft.`);
        addDecision(LOG_INFO, 'Session opened', `— ${items.length} files handed to the council.`);
      }],
      [5200, () => {
        setTask('read', 'done');
        setActive('chair', false);
        addDecision(LOG_INFO, 'Intake complete', `— ${items.length} of ${items.length} files readable as text.`);
        setPhase('Deliberating');
        setTask('draft', 'working');
        COUNCIL_UI.slice(1).forEach((m) => {
          setActive(m.id, true);
          say(m.id, MEMBER_WORKING_LINE[m.id]);
          startShuttle(m.id);
        });
      }],
      [2600, () => {
        setActive('chronologist', false);
        stopShuttle('chronologist');
        sendPacket('chronologist', 'chair', 'pen', 1600);
        say('chronologist', 'Draft ready — 12 events, 1 flag.', '12 events · 1 flag');
        addDecision(COUNCIL_COLORS.chronologist, 'Chronologist filed a draft', `— 12 events, 1 flag; leans on ${items[0].name} (5 citations).`);
      }],
      [800, () => {
        setActive('narrator', false);
        stopShuttle('narrator');
        sendPacket('narrator', 'chair', 'pen', 1600);
        say('narrator', 'Draft ready — 8 events, 0 flags.', '8 events · 0 flags');
        addDecision(COUNCIL_COLORS.narrator, 'Narrator filed a draft', `— 8 events, 0 flags; leans on ${items[1 % items.length].name} (3 citations).`);
        patchCouncil({
          prop: {
            by: 'narrator',
            text: 'Frame the June emails as the turning point of the story.',
            source: 'Emails_Mar-Jun.eml',
            votes: [],
            ruling: null,
          },
        });
      }],
      [800, () => {
        setActive('auditor', false);
        stopShuttle('auditor');
        sendPacket('auditor', 'chair', 'pen', 1600);
        say('auditor', 'Draft ready — 13 events, 4 flags.', '13 events · 4 flags');
        addDecision(COUNCIL_COLORS.auditor, 'Auditor filed a draft', '— 13 events, 4 flags.');
        setTask('draft', 'done');
        setTask('dispute', 'working');
        setActive('chair', true);
        say('chair', 'The council is split. I need direction from the author.');
        addDecision(LOG_STEER, 'The drafts disagree', '— Chronologist: 12 ev, 1 fl · Narrator: 8 ev, 0 fl · Auditor: 13 ev, 4 fl.');
        sendPacket('auditor', 'narrator', 'chat', 2200);
        sendPacket('chronologist', 'auditor', 'chat', 2200);
        patchCouncil((c) => ({
          prop: c.prop && {
            ...c.prop,
            votes: [
              { by: 'auditor', verb: 'objects', conf: 68 },
              { by: 'chronologist', verb: 'objects', conf: 55 },
            ],
          },
          ask: {
            question: 'The analysts disagree on the record.',
            context: 'Chronologist drafted 12 events (1 flag) · Narrator drafted 8 events (0 flags) · Auditor drafted 13 events (4 flags). How should the Chair weigh the drafts?',
            options: DISPUTE_OPTIONS,
          },
        }));
      }],
      // The simulator doesn't wait for an answer — an unanswered panel is
      // dismissed as the chair proceeds (answering earlier logs the steer).
      [5200, () => {
        stopAllShuttles();
        patchCouncil({ ask: null });
        setTask('dispute', 'done');
        setPhase('Final assembly');
        setTask('merge', 'working');
        say('chair', 'Merging 3 drafts into the final cut…');
      }],
      [2000, () => {
        setActive('chair', false);
        setTask('merge', 'done');
        setTask('save', 'working');
        addDecision(LOG_OK, 'Merged by the Chair', '— 14 events kept, 4 flags raised.');
        patchCouncil((c) => ({
          prop: c.prop && {
            ...c.prop,
            ruling: { accepted: true, reason: 'merged into the final story — 14 events kept.' },
          },
        }));
      }],
      [700, () => {
        setTask('save', 'done');
        setPhase('Story complete');
        say('chair', 'We have our story — every beat sourced and merged.');
        addDecision(LOG_OK, 'Final story approved', '— 14 events, 4 open flags.', ['merged by the chair', '3 of 3 analysts filed']);
        patchCouncil({
          ruling: 'unanimous',
          lede: 'A €120k framework deal signed in March 2023 unravels when payments stop and invoice #204 goes unanswered; a June escalation turns delay into dispute — until a scope change closes the loop in a revised deal.',
        });
      }],
      [700, () => patchCouncil({ endStage: 'gavel' })],
      [2100, () => patchCouncil({ endStage: 'story' })],
    ];
    let at = 0;
    script.forEach(([d, fn]) => { at += d; schedule(at, fn); });
  };

  useEffect(() => {
    if (!scanning || !debugRun) return undefined;
    const id = setInterval(() => {
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

      {/* Dev affordance — seeds the Scanning grid from the uploaded files
          (or the fallback sample set) and animates their progress. */}
      <button type="button" className="cto-debug-btn" onClick={startDebugScan}>
        Debug · simulate scan
      </button>

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
          error={scanError}
          onAnswer={answerCouncil}
          onPacketDone={removePacket}
          onReadStory={() => setStep('timeline')}
        />
      )}
      {step === 'timeline' && <TimelineStep timeline={timeline} />}
      {step === 'review' && <ReviewStep timeline={timeline} goTimeline={() => setStep('timeline')} />}
    </div>
  );
}
