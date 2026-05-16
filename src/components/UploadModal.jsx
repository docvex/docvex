import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useUploads } from '../context/UploadsContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { generateThumbnail, extractVideoDuration } from '../lib/thumbnails';
import './UploadModal.css';

// Full-screen upload modal launched from the Files-page FAB. Owns the
// click-to-browse entry point AND the live upload list — preview
// thumbnail on the left; name + status description + type/size meta +
// trash on the right.
//
// Two-step upload flow: picking files STAGES them locally (no network,
// no DB row) — they appear in the list with status `staged`
// ("Ready to send"). The user clicks the footer "Send" button to push
// the staged files through the upload pipeline. The modal opens
// either via the FAB on the Files page OR via a window-level drag of
// any file into the renderer (handler lives in UploadsContext).
//
// Renders OUTSIDE the sidebar/banner stacking context via position:
// fixed + z-index 1000 (matches ConfirmModal's recipe), so the dimmed
// backdrop covers everything in the app — sidebar (z:50), picker panel
// (z:40), and the project content surface beneath them.

const CloseIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// Cloud-with-arrow icon — universally reads as "upload". Same stroke
// recipe as the other inline icons so it inherits color via
// `currentColor`; the .css pins the color to the brand accent.
const CloudUploadIcon = (
  <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15a4 4 0 0 1-4 4H7a5 5 0 1 1 .9-9.9A5.5 5.5 0 0 1 18 11.5a3.5 3.5 0 0 1 3 3.5z" />
    <polyline points="16 16 12 12 8 16" />
    <line x1="12" y1="12" x2="12" y2="21" />
  </svg>
);

const TrashIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </svg>
);

// File-type glyphs for the preview column when no image thumbnail is
// available. Stroke icons inherit color via `currentColor` so the
// per-row tint comes from .upload-modal-item-preview's color rule.
const PdfPreviewIcon = (
  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <text x="7" y="18" fontSize="5" fontWeight="700" fill="currentColor" stroke="none">PDF</text>
  </svg>
);

const VideoPreviewIcon = (
  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="6" width="14" height="12" rx="2" ry="2" />
    <polygon points="23 7 16 12 23 17 23 7" />
  </svg>
);

const TextPreviewIcon = (
  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="14" y2="17" />
  </svg>
);

const GenericPreviewIcon = (
  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

function pickPreviewIcon(mime) {
  if (!mime) return GenericPreviewIcon;
  if (mime === 'application/pdf') return PdfPreviewIcon;
  if (mime.startsWith('video/')) return VideoPreviewIcon;
  if (mime.startsWith('text/')) return TextPreviewIcon;
  return GenericPreviewIcon;
}

// Pretty-print bytes as B / KB / MB. Same helper UploadOverlay used to
// own — copied here rather than extracted to a shared util since it's
// the only other caller in the app right now.
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Format a number of seconds as M:SS or H:MM:SS. Used for the video
// duration badge. Duplicated between this file and ProjectFiles.jsx
// (matches the codebase's convention of inlining tiny helpers rather
// than extracting a shared util — see Account.jsx / Sidebar.jsx in
// CLAUDE.md). Defensive against non-finite inputs so we don't render
// "NaN:NaN" if the metadata probe ever yielded a weird value.
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n) => n.toString().padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(mins)}:${pad(secs)}`;
  return `${mins}:${pad(secs)}`;
}

// Human label for the MIME type — drops the leading `application/` so
// long MIMEs read as the format name alone ("pdf" instead of
// "application/pdf"). Image / video / text use the subtype only too.
function prettyMime(mime) {
  if (!mime) return 'File';
  if (mime === 'application/pdf') return 'PDF';
  const slash = mime.indexOf('/');
  if (slash > 0) return mime.slice(slash + 1).toUpperCase();
  return mime.toUpperCase();
}

// Status → short status line. Mirrors the labels the old progress
// panel used so users who'd seen the prior UI keep their mental model.
function statusDescription(upload) {
  const { status, loaded, total, error, prepReady } = upload;
  switch (status) {
    case 'staged':    return prepReady === false ? 'Preparing…' : 'Ready';
    case 'pending':   return 'Queued';
    case 'uploading': {
      const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      return `Uploading… ${pct}%`;
    }
    case 'done':      return 'Uploaded';
    case 'canceled':  return 'Canceled';
    case 'rejected':  return error || 'Unsupported file type';
    case 'error':     return error || 'Upload failed';
    default:          return '';
  }
}

// Per-row preview thumbnail. Three rendering paths by MIME family:
//   • image/*  — instant blob URL of the original File (no async).
//   • application/pdf + video/*  — async thumbnail generation via
//     src/lib/thumbnails.js, the same generator the upload pipeline
//     uses post-upload. Shows the glyph fallback until generation
//     resolves, then swaps to the real thumb. PDFs render page 1;
//     videos render a frame ~10% into the clip.
//   • text/* and everything else — type-specific glyph forever
//     (no visual content to extract).
//
// We intentionally do NOT revoke either blob URL on unmount — React
// StrictMode's double-effect cycle in dev would revoke a URL while
// the <img> still references it (causing ERR_FILE_NOT_FOUND console
// spam + a flash of broken-image). The leak is bounded by what the
// user actively stages (typically < 20 files at once) so the cost is
// negligible; the GC reclaims on page unload.
function UploadItemPreview({ file }) {
  const isImage = file.type.startsWith('image/');
  const isVideo = (file.type || '').startsWith('video/');
  // Image path is synchronous: the File is already in memory so
  // URL.createObjectURL is cheap. Lazy initializer runs once per
  // component instance.
  const [imageUrl] = useState(() => (isImage ? URL.createObjectURL(file) : null));
  // PDF/video thumbnail — async. Null until the generator resolves
  // (or forever if generation fails / times out / the MIME isn't
  // supported by the generator).
  const [generatedUrl, setGeneratedUrl] = useState(null);
  // Video duration in seconds, extracted via a separate metadata-only
  // probe (the thumbnail generator decodes a frame, but we want the
  // duration even when the frame extraction fails). Null until the
  // probe resolves; null forever if extraction fails.
  const [durationSec, setDurationSec] = useState(null);

  useEffect(() => {
    if (isImage) return undefined;
    const mime = file.type || '';
    // generateThumbnail() handles image/PDF/video and returns null
    // for everything else. We pre-gate here so we don't even start
    // a generator promise for text files etc. — same end result,
    // cheaper.
    const canGenerate = mime === 'application/pdf' || mime.startsWith('video/');
    if (!canGenerate) return undefined;

    let cancelled = false;
    generateThumbnail(file).then((blob) => {
      if (cancelled || !blob) return;
      setGeneratedUrl(URL.createObjectURL(blob));
    });
    return () => { cancelled = true; };
  }, [file, isImage]);

  useEffect(() => {
    if (!isVideo) return undefined;
    let cancelled = false;
    extractVideoDuration(file).then((seconds) => {
      if (cancelled || !seconds) return;
      setDurationSec(seconds);
    });
    return () => { cancelled = true; };
  }, [file, isVideo]);

  // Resolve the visual: image first (synchronous), then generated
  // thumbnail (PDF/video), then MIME glyph as fallback. The duration
  // badge floats on top of any of these via .upload-modal-item-preview
  // being position:relative in CSS.
  const visual =
    isImage && imageUrl
      ? <img className="upload-modal-item-thumb" src={imageUrl} alt="" />
      : generatedUrl
        ? <img className="upload-modal-item-thumb" src={generatedUrl} alt="" />
        : <span className="upload-modal-item-glyph">{pickPreviewIcon(file.type)}</span>;

  return (
    <>
      {visual}
      {isVideo && durationSec && (
        <span className="upload-modal-item-duration" aria-hidden="true">
          {formatDuration(durationSec)}
        </span>
      )}
    </>
  );
}

function UploadItem({ upload, onDismiss, onNameChange, onDescriptionChange }) {
  const { id, file, status, loaded, total } = upload;
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  const isInFlight = status === 'uploading' || status === 'pending';
  // Only the staged state is editable. Once the user clicks Send the
  // row transitions to pending → uploading → done, and the name +
  // description become read-only (the upload is in flight or the row
  // already exists in the DB). Falls back to file.name when an
  // in-flight entry didn't carry a display name (e.g. drag-drop path
  // that bypassed the modal's inputs).
  const isStaged = status === 'staged';
  const displayName = upload.name ?? file.name;

  return (
    <li className={`upload-modal-item is-${status}`}>
      <div className="upload-modal-item-preview">
        <UploadItemPreview file={file} />
      </div>
      <div className="upload-modal-item-details">
        {isStaged ? (
          <>
            <input
              type="text"
              className="upload-modal-item-name-input"
              value={displayName}
              onChange={(e) => onNameChange?.(id, e.target.value)}
              placeholder="File name"
              aria-label="File name"
              spellCheck={false}
            />
            <textarea
              className="upload-modal-item-description-input"
              value={upload.description ?? ''}
              onChange={(e) => onDescriptionChange?.(id, e.target.value)}
              placeholder="Add a description (optional)"
              aria-label="File description"
              rows={2}
            />
          </>
        ) : (
          <div className="upload-modal-item-name" title={displayName}>
            {displayName}
          </div>
        )}
        <div className="upload-modal-item-status">
          {statusDescription(upload)}
        </div>
        {/* Progress track — only rendered while bytes are moving.
            Terminal statuses (done / error / canceled / rejected)
            don't need it; the status line carries the result. */}
        {isInFlight && (
          <div className="upload-modal-item-progress" aria-hidden="true">
            <div
              className="upload-modal-item-progress-fill"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        {/* Meta is the LAST child so `margin-top: auto` in CSS can
            push it to the bottom of the details column. The status
            pill (when applied to staged rows) is absolute-positioned
            to the bottom-right of the item, so meta's bottom-left
            position and the pill's bottom-right position don't
            collide. */}
        <div className="upload-modal-item-meta">
          <span className="upload-modal-item-type">{prettyMime(file.type)}</span>
          <span className="upload-modal-item-meta-sep" aria-hidden="true">·</span>
          <span className="upload-modal-item-size">{formatBytes(file.size)}</span>
        </div>
      </div>
      <button
        type="button"
        className="upload-modal-item-trash"
        onClick={() => onDismiss(id)}
        aria-label={isInFlight ? `Cancel ${file.name}` : `Remove ${file.name} from list`}
      >
        {TrashIcon}
      </button>
    </li>
  );
}

export default function UploadModal() {
  // State lives in UploadsContext — the modal is a pure renderer
  // reading open-state / staged / uploads from the context and
  // dispatching back via its actions.
  const {
    modalOpen,
    closeModal,
    staged,
    stageFiles,
    removeStaged,
    sendStaged,
    updateStagedName,
    updateStagedDescription,
    uploads,
    dismissUpload,
    dragActive,
    sending,
  } = useUploads();
  const { selectedProject } = useSelectedProject();
  const inputRef = useRef(null);

  // Esc dismisses; listener only mounts while the modal is open so a
  // stale closed modal never absorbs the key. Skipped in drag-only
  // mode — the user is mid-drag, can't reach Esc cleanly, and the
  // drag-leave handler closes it automatically when they exit the
  // window.
  useEffect(() => {
    if (!modalOpen) return;
    const handler = (e) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modalOpen, closeModal]);

  // Synthetic "upload-shaped" view of staged files so the same
  // UploadItem renderer can display both staged + in-flight entries
  // without a separate component. status: 'staged' drives the
  // "Ready to send" description + the brand-accent surface tint.
  const stagedItems = useMemo(
    () => staged.map(({ id, file, name, description, prepReady }) => ({
      id,
      file,
      name,
      description,
      prepReady,
      status: 'staged',
      loaded: 0,
      total: file.size,
      error: null,
    })),
    [staged],
  );

  // Combined ordered list so React reconciles by key across the
  // staged → uploads transition without a remount: when sendStaged()
  // reuses the staged row's id for the new upload entry, the <li>
  // moves from `stagedItems` to `uploads` but its key stays the
  // same, so the same DOM node is updated in place (status flips
  // from 'staged' to 'pending', description text changes, etc.).
  // Doing it as one `.map` instead of two avoids React treating the
  // entry as "removed from array A, added to array B". Computed
  // before the early return below so the hook order stays stable
  // across renders (Rules of Hooks).
  const allItems = useMemo(() => [...stagedItems, ...uploads], [stagedItems, uploads]);

  // Total bytes across all staged files — shown next to the file
  // count in the Send button so the user has a sense of how much
  // they're about to upload before hitting it. MUST live above the
  // early return below to keep hook order stable across renders
  // (Rules of Hooks): when the modal is closed `useMemo` would be
  // skipped, then mounted on next open with a different total hook
  // count than the previous render.
  const stagedTotalBytes = useMemo(
    () => staged.reduce((sum, s) => sum + (s.file?.size || 0), 0),
    [staged],
  );

  // Target card height — computed from the number of rows in the
  // list, then applied as a CSS variable on the card so the height
  // transition fires on staging/sending without waiting for the
  // inner rows to fully render (thumbnail generation can take a
  // second or two — the modal shouldn't visually lurch into shape
  // mid-render). Bumped to a viewport-aware cap further down via
  // CSS `max-height: min(80vh, 720px)`, so this number can safely
  // exceed the visible cap; the existing `flex: 1 1 auto; overflow:
  // auto` on the list scrolls anything past the cap.
  //   0 items: header + full dropzone + footer ≈ 400
  //   N items: header + compact dropzone + N rows (~180 each) + footer ≈ 280 + N*180
  const targetCardHeight = useMemo(() => {
    const itemCount = allItems.length;
    if (itemCount === 0) return 400;
    return 280 + itemCount * 180;
  }, [allItems.length]);

  // Render for either state: drag-only (user is mid-drag, modal closed)
  // OR fully open (FAB click, or post-drop). Skipping the null bail-out
  // for dragActive lets the dropzone appear as a teaser while the user
  // hovers a file over the renderer.
  if (!modalOpen && !dragActive) return null;

  // Drag-only mode = drag is happening AND the modal wasn't already
  // open. Drives a className that hides header/list/footer via CSS so
  // the dropzone DOM node stays mounted across the drop transition
  // (no remount → no animation replay, no layout flash).
  const isDragOnly = dragActive && !modalOpen;

  // Backdrop click only fires when the mousedown started on the backdrop
  // itself — prevents a click-and-drag that ended outside the card from
  // dismissing the modal mid-interaction.
  const handleBackdropMouseDown = (e) => {
    if (e.target === e.currentTarget) closeModal();
  };

  const handlePick = () => inputRef.current?.click();

  const handleFiles = (e) => {
    const files = Array.from(e.target.files || []);
    // Clear the input's value so the same file can be re-picked later
    // (the change event won't fire on a no-op selection otherwise).
    e.target.value = '';
    if (files.length === 0) return;
    // Staging lives in context (MIME pre-filter + rejection toast).
    stageFiles(files);
  };

  const stagedCount = staged.length;
  const hasAnyRows = allItems.length > 0;

  return (
    <div
      className={`upload-modal-backdrop${isDragOnly ? ' is-drag-only' : ''}`}
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className={`upload-modal-card${isDragOnly ? ' is-drag-only' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-modal-title"
        style={{ '--upload-modal-target-h': `${targetCardHeight}px` }}
      >
        <header className="upload-modal-header">
          <h2 id="upload-modal-title" className="upload-modal-title">
            Upload to {selectedProject?.name || 'project'}
          </h2>
          <button
            type="button"
            className="upload-modal-close"
            onClick={closeModal}
            aria-label="Close upload"
          >
            {CloseIcon}
          </button>
        </header>

        {/* Dropzone button — the entire surface is a single clickable
            target that triggers the hidden file input. Visually
            treated as a dashed-border drop card so the affordance
            reads as "upload area" even though we're using a file
            picker (drag-and-drop is no longer supported). */}
        <button
          type="button"
          className={`upload-modal-dropzone${hasAnyRows ? ' is-compact' : ''}`}
          onClick={handlePick}
        >
          <span className="upload-modal-dropzone-icon">{CloudUploadIcon}</span>
          <span className="upload-modal-dropzone-title">Click to choose files</span>
          <span className="upload-modal-dropzone-hint">
            Files are added to the list below — nothing is sent until you click Send
          </span>
          <span className="upload-modal-dropzone-types">
            PDF · images · video · text
          </span>
        </button>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/*,video/*,text/*"
          onChange={handleFiles}
          className="upload-modal-input"
        />

        {/* Combined list: staged rows first (awaiting Send), then any
            in-flight or recently-finished upload entries from
            UploadsContext. Single `.map` over the combined array so
            React keys reconcile cleanly when a row transitions from
            staged → pending (same id, no remount). Hidden when the
            array is empty so the modal stays tidy before the user
            picks anything. */}
        {hasAnyRows && (
          <ul className="upload-modal-list">
            {allItems.map((item) => (
              <UploadItem
                key={item.id}
                upload={item}
                onDismiss={item.status === 'staged' ? removeStaged : dismissUpload}
                onNameChange={updateStagedName}
                onDescriptionChange={updateStagedDescription}
              />
            ))}
          </ul>
        )}

        {/* Footer with the Send button — always rendered so the modal's
            footer chrome stays put. Disabled state communicates
            "nothing to send yet" without the layout twitching when the
            count transitions between 0 and 1. */}
        <footer className="upload-modal-footer">
          <button
            type="button"
            className="upload-modal-send"
            onClick={sendStaged}
            disabled={stagedCount === 0 || sending}
          >
            {sending ? (
              <>
                <span className="upload-modal-send-spinner" aria-hidden="true" />
                <span>Preparing…</span>
              </>
            ) : stagedCount === 0
              ? 'Send'
              : `Send ${stagedCount} file${stagedCount === 1 ? '' : 's'} · ${formatBytes(stagedTotalBytes)}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
