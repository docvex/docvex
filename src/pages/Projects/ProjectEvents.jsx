import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { glyphForFile } from '../../components/fileGlyph';
import FileThumbnail from '../../components/FileThumbnail';
import { extractFileText } from '../../lib/extractFileText';
import { askProjectAi } from '../../lib/projectAi';
import { toLayoutPx } from '../../lib/appZoom';
import { openDocViewerWindow, pathForFile } from '../../lib/platform';
import './ProjectScoped.css';
import './ProjectEvents.css';

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
// ── Sample data (verbatim from the design bundle) ─────────────────────────
const STEPS = [
  { id: 'upload', n: '1', label: 'Upload files' },
  { id: 'scan', n: '2', label: 'Scanning' },
  { id: 'timeline', n: '3', label: 'Timeline' },
  { id: 'review', n: '4', label: 'Review' },
];

// AI pipeline phases, surfaced under the scan grid as "what the AI is doing
// right now" — resolved from the overall scan progress.
const SCAN_ACTIONS = [
  'Extracting text (OCR)',
  'Transcribing video & AI captions',
  'Detecting dates, parties & amounts',
  'Building the chronology',
  'Cross-checking gaps & contradictions',
];

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
// grid) → one project-ai `ask` call that reconstructs the chronology as
// strict JSON → normalised + persisted per project. Media files can't be
// read in-renderer (no transcription wired here), so they contribute their
// filename as context only.

// Saved-timeline storage, one entry per project.
const TIMELINE_KEY_PREFIX = 'docvex:case-timeline:v1:';

// Total character budget across every file excerpt sent to the model.
const TOTAL_EXCERPT_CHARS = 60000;

// Event tags map to the notification category palette (--cat-*).
const EVENT_CATS = new Set(['project', 'file', 'update', 'member', 'role', 'system']);

function buildTimelinePrompt(projectName, excerpts) {
  const filesBlock = excerpts.map((f, i) => (f.text
    ? `--- FILE ${i + 1}: ${f.name} ---\n${f.text}`
    : `--- FILE ${i + 1}: ${f.name} --- (contents not readable in-app${f.error === 'unsupported' ? ' — media/binary file, use the filename as context' : `: ${f.error}`})`
  )).join('\n\n');
  return `You are a legal case analyst. Reconstruct the chronological story of a matter${projectName ? ` for the project "${projectName}"` : ''} from the files below.

Cross-check the sources against each other: flag contradictions (dates or amounts that disagree between documents), gaps in the record (long unexplained intervals, missing referenced documents or signatures), and ambiguities.

Respond with ONLY a JSON object — no prose, no markdown fences — in exactly this shape:
{
  "lede": "2-4 sentence narrative summary of the story",
  "events": [
    {
      "date": "14 Mar",
      "year": "2023",
      "kind": "Contract",
      "cat": "project",
      "title": "Framework agreement signed",
      "body": "1-2 sentence description of what happened",
      "files": ["filename.pdf"],
      "isVideo": false,
      "flag": null
    }
  ],
  "flags": [
    { "type": "Contradiction", "sev": "High", "title": "...", "detail": "...", "sources": "file A · file B" }
  ]
}

Field rules:
- "date" is a short day+month ("14 Mar"); "year" the 4-digit year. Order events chronologically.
- "kind" is a short document/event label (Contract, Correspondence, Evidence, Invoice, Filing, …).
- "cat" is one of: project, file, update, member, role.
- "files" lists the EXACT filename(s), verbatim from the provided set, the event is based on. Set "isVideo" true only for events sourced from video/audio.
- An event's "flag" is either null or { "sev": "danger"|"warning", "label": "Contradiction:", "text": "…" } — use it only for issues tied to that moment.
- List EVERY issue in "flags" too. "sev": "High" = must resolve before filing, "Medium" = gap in the record, "Low" = wording/ambiguity.
- Only include events supported by the files; do not invent facts. Write in English (translate foreign-language content; keep short quotes in the original followed by a translation).
- If the files contain no datable events, return {"lede": "", "events": [], "flags": []}.

${filesBlock}`;
}

// Tolerant JSON extraction — strips markdown fences and grabs the outermost
// object so a stray preamble doesn't sink the parse.
function parseTimelineJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

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

// Scanning step — the uploaded files laid out on a 6-wide grid, rows growing
// downward as needed. Each tile carries its own progress bar; under the
// grid, the AI's current pipeline phase (resolved from overall progress).
function ScanStep({ items, progress, scanning, error, overall: overallProp }) {
  if (items.length === 0) {
    return (
      <p className="cto-scan-empty">
        Nothing scanned yet — pick files in the Upload step and press
        “Analyze with AI”.
      </p>
    );
  }

  // Real runs pass a staged overall (extraction 0–60%, AI phase 60–100%);
  // the debug simulator falls back to the plain per-file average.
  const overall = overallProp ?? (progress.reduce((sum, p) => sum + p, 0) / items.length);
  const done = !scanning && !error && overall >= 99.5;
  // Current pipeline phase + its history, both derived from overall progress:
  // every phase before the current one has completed and lists below it,
  // fading with age.
  const phaseIdx = done
    ? SCAN_ACTIONS.length
    : Math.min(SCAN_ACTIONS.length - 1, Math.floor((overall / 100) * SCAN_ACTIONS.length));
  const action = done ? 'Scan complete' : SCAN_ACTIONS[phaseIdx];
  const pastActions = SCAN_ACTIONS.slice(0, phaseIdx).reverse(); // newest first

  return (
    <div>
      <div className="cto-scan-grid">
        {items.map((f, i) => {
          const pct = Math.round(progress[i] ?? 0);
          return (
            <div key={`${f.name} ${i}`} className="cto-scan-tile">
              <span className={`cto-scan-tile-ico${pct < 100 ? ' is-loading' : ''}`}>
                <FileThumbnail
                  mimeType={f.mime || guessMimeFromName(f.name)}
                  sourceUrl={f.url || undefined}
                  glyph={glyphForFile(f.mime || guessMimeFromName(f.name), f.name)}
                />
              </span>
              <span className="cto-scan-tile-name">{f.name}</span>
              <div className={`cto-scan-track${pct >= 100 ? ' is-done' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Scanning ${f.name}`}>
                <span className="cto-scan-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      {/* Overall progress as a hairline divider under the grid. */}
      <div
        className="cto-scan-divider"
        role="progressbar"
        aria-valuenow={Math.round(overall)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Overall scan progress"
      >
        <span className="cto-scan-divider-fill" style={{ width: `${overall}%` }} />
      </div>
      <div className="cto-scan-status">
        {/* Left: the action log — current phase on top, past phases fading. */}
        <div className="cto-scan-actions">
          {/* Keyed on the text so a phase change remounts the row and replays
              its entrance animation. */}
          <div key={action} className="cto-scan-action is-current">
            <span className="cto-scan-action-text">{action}</span>
          </div>
          {pastActions.map((a) => (
            <div key={a} className="cto-scan-action is-past">
              <span className="cto-scan-past-check"><IcoCheck width="9" height="9" /></span>
              <span className="cto-scan-past-text">{a}</span>
            </div>
          ))}
        </div>
        {/* Right: spinner + overall progress. */}
        <div className="cto-scan-overall">
          {done && <span className="cto-scan-action-check"><IcoCheck width="16" height="16" /></span>}
          {!done && !error && <span className="cto-spinner" />}
          {!done && error && <span className="cto-scan-overall-alert"><IcoAlert width="14" height="14" /></span>}
          <span className="cto-scan-overall-pct">{Math.round(overall)}%</span>
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
  // AI-phase progress (0–100) for real runs — eases toward 95 while the
  // model call is in flight, snaps to 100 when the response lands.
  const [aiProgress, setAiProgress] = useState(0);

  // The reconstructed story — { lede, events, flags, meta } — persisted per
  // project so reopening the tab lands straight on the built timeline.
  const [timeline, setTimeline] = useState(null);
  useEffect(() => {
    const pid = selectedProject?.id;
    if (!pid) return;
    let saved = null;
    try {
      const raw = localStorage.getItem(TIMELINE_KEY_PREFIX + pid);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.events) && parsed.events.length > 0) saved = parsed;
    } catch { /* corrupt entry — treat as absent */ }
    setTimeline(saved);
    setStep(saved ? 'timeline' : 'upload');
    setScanError(null);
  }, [selectedProject?.id]);

  // ── Real pipeline: extract text per file, then one project-ai call that
  // reconstructs the chronology. Per-file bars ease while THAT file's
  // extraction is in flight (asymptotic toward 90, snap to 100 on finish);
  // the AI phase drives `aiProgress` the same way until the response lands.
  const analyzeFiles = async () => {
    if (analyzing || files.length === 0) return;
    setAnalyzing(true);
    setDebugRun(false);
    setScanError(null);
    setAiProgress(0);
    const items = files.map((f) => ({ name: f.name, mime: f.type || '', url: objectUrlFor(f) }));
    setScanItems(items);
    setScanProgress(items.map(() => 0));
    setScanning(true);
    setStep('scan');
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
          // Sequential on purpose — keeps memory bounded and the grid readable.
          // eslint-disable-next-line no-await-in-loop
          res = await extractFileText(files[i], files[i].name);
        } finally {
          clearInterval(creep);
        }
        excerpts.push(res.text
          ? { name: files[i].name, text: res.text.slice(0, perFileCap) }
          : { name: files[i].name, error: res.error || 'unreadable' });
        setScanProgress((prev) => prev.map((p, j) => (j === i ? 100 : p)));
      }
      if (!excerpts.some((e) => e.text)) {
        throw new Error('none of the files could be read as text (media files need transcription, which isn’t wired into this tab yet)');
      }
      // AI phase — ease aiProgress toward 95 while the request is in flight.
      setAiProgress(4);
      const aiTick = setInterval(() => {
        setAiProgress((p) => Math.min(95, p + (95 - p) * 0.05));
      }, 250);
      let res;
      try {
        res = await askProjectAi({
          messages: [{ role: 'user', content: buildTimelinePrompt(selectedProject?.name, excerpts) }],
          projectName: selectedProject?.name,
          fileNames: files.map((f) => f.name),
          tools: false,
        });
      } finally {
        clearInterval(aiTick);
      }
      setAiProgress(100);
      if (res.error) throw new Error(res.error.message || 'the AI service is unavailable');
      const built = normalizeTimeline(parseTimelineJson(res.text), files.length);
      if (!built) throw new Error('no datable events could be reconstructed from these files');
      // Filename → on-disk ref, so the timeline's file chips can open the
      // Doc Viewer (and paint real thumbnails) — persisted with the story.
      built.fileRefs = {};
      files.forEach((f) => {
        built.fileRefs[f.name] = { path: pathForFile(f), mime: f.type || '' };
      });
      setTimeline(built);
      try {
        localStorage.setItem(TIMELINE_KEY_PREFIX + selectedProject.id, JSON.stringify(built));
      } catch { /* quota — the in-memory timeline still renders */ }
      setScanning(false);
      setStep('timeline');
    } catch (err) {
      setScanning(false);
      setScanError(String(err?.message ?? err));
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Debug simulator (the button under the header): fake progress on an
  // interval; files run as a loose pipeline — each starts once its
  // predecessor is ~45% through, so the grid fills in waves.
  const startDebugScan = () => {
    if (analyzing) return;
    const items = files.length > 0
      ? files.map((f) => ({ name: f.name, mime: f.type || '', url: objectUrlFor(f) }))
      : FALLBACK_SCAN_FILES;
    setScanItems(items);
    setScanProgress(items.map(() => 0));
    setScanning(true);
    setDebugRun(true);
    setScanError(null);
    setStep('scan');
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
                Reconstructed by DocVex from {timeline.meta?.fileCount ?? timeline.events.length}{' '}
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
        <ScanStep
          items={scanItems}
          progress={scanProgress}
          scanning={scanning}
          error={scanError}
          // Real runs: staged overall — extraction is 60% of the journey,
          // the AI reconstruction the remaining 40%. Debug runs derive
          // overall from the bars alone.
          overall={debugRun ? undefined : (
            (scanProgress.length
              ? scanProgress.reduce((a, b) => a + b, 0) / scanProgress.length
              : 0) * 0.6 + aiProgress * 0.4
          )}
        />
      )}
      {step === 'timeline' && <TimelineStep timeline={timeline} />}
      {step === 'review' && <ReviewStep timeline={timeline} goTimeline={() => setStep('timeline')} />}
    </div>
  );
}
