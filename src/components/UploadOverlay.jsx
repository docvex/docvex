import React, { useEffect } from 'react';
import { useUploads } from '../context/UploadsContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import Tooltip from './Tooltip';
import './UploadOverlay.css';

// Visual layer for the file-upload feature. ALL state lives in
// UploadsContext — this component is a pure renderer. Two surfaces, each
// independently visible:
//
//  1. Drop card  — centered over a dimmed full-bleed backdrop. Appears
//                  whenever the user is dragging files over the window
//                  (`dragActive`). The whole stack is pointer-events: none
//                  so the underlying window-level `drop` listener catches
//                  releases anywhere on screen.
//  2. Progress panel — bottom-right pill stack. Appears whenever there
//                  are any upload entries (in flight, queued, or just
//                  finished within the auto-dismiss window). Has its own
//                  pointer-events: auto because Cancel is clickable.
//
// Both surfaces can be on screen at the same time — a user can drag more
// files in while a previous batch is still uploading.

// Document-plus icon used in the drop-card center. Same stroke recipe as
// the sidebar icons so it inherits color via `currentColor`; the .css
// pins the color to the gold accent.
const DropIcon = (
  <svg
    width="56"
    height="56"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="12" x2="12" y2="18" />
    <line x1="9" y1="15" x2="15" y2="15" />
  </svg>
);

// Trash glyph for the per-row cancel button in the progress panel.
const CancelIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// Pretty-print bytes as B / KB / MB. Lifted from ReportProblemModal —
// no shared utility for this in the codebase yet; copy-paste keeps the
// file standalone for now (extract to lib/format if a third caller appears).
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Per-file row inside the progress panel. Tiny enough to keep inline.
function UploadRow({ upload }) {
  const { file, status, loaded, total, error } = upload;
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  return (
    <li className={`upload-row is-${status}`}>
      <div className="upload-row-line1">
        <Tooltip content={file.name}>
          <span className="upload-row-name">{file.name}</span>
        </Tooltip>
        <span className="upload-row-status">
          {status === 'uploading' && `${pct}%`}
          {status === 'pending'   && 'Queued'}
          {status === 'done'      && 'Done'}
          {status === 'canceled'  && 'Canceled'}
          {status === 'rejected'  && 'Rejected'}
          {status === 'error'     && 'Failed'}
        </span>
      </div>
      <div className="upload-row-line2">
        {/* Show the error message inline when present; otherwise show
            the size so the user can sanity-check what's being sent. */}
        {error ? (
          <span className="upload-row-error">{error}</span>
        ) : (
          <span className="upload-row-size">{formatBytes(file.size)}</span>
        )}
      </div>
      {/* Per-file progress track. Hidden via CSS for terminal statuses
          (done/rejected/error/canceled) — see .upload-row.is-done etc. */}
      <div className="upload-row-track" aria-hidden="true">
        <div className="upload-row-fill" style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}

export default function UploadOverlay() {
  const { dragActive, uploads, uploadingCount, overallProgress, cancelAllUploads } = useUploads();
  const { selectedProject } = useSelectedProject();

  // Esc cancels all uploads while the progress panel is showing in-flight
  // ones. Same affordance as the modals' Esc-to-close, scoped to this
  // panel's lifetime so it doesn't intercept Esc when nothing's going on.
  useEffect(() => {
    if (uploadingCount === 0) return;
    const onKey = (e) => {
      if (e.key === 'Escape') cancelAllUploads();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [uploadingCount, cancelAllUploads]);

  if (!dragActive && uploads.length === 0) return null;

  return (
    <>
      {dragActive && (
        <div className="upload-overlay-backdrop" aria-hidden="true">
          {/* The card is purely visual — pointer-events: none in CSS so
              the drop falls through to the window-level handler. The
              `data-mode` attribute drives the gold-vs-muted color swap
              via .upload-overlay-card[data-mode="locked"] in the CSS. */}
          <div
            className="upload-overlay-card"
            data-mode={selectedProject ? 'ready' : 'locked'}
          >
            <div className="upload-overlay-icon">{DropIcon}</div>
            <div className="upload-overlay-title">
              {selectedProject
                ? <>Drop files here to upload to <strong>{selectedProject.name}</strong></>
                : 'Select a project first to upload files'}
            </div>
            {selectedProject && (
              <div className="upload-overlay-types">
                PDFs · images · videos · text documents
              </div>
            )}
          </div>
        </div>
      )}

      {uploads.length > 0 && (
        <div className="upload-progress-panel" role="region" aria-label="File uploads">
          <header className="upload-progress-header">
            <span className="upload-progress-title">
              {uploadingCount > 0
                ? `Uploading ${uploadingCount} file${uploadingCount === 1 ? '' : 's'}`
                : 'Uploads'}
            </span>
            {uploadingCount > 0 && (
              <Tooltip content="Cancel all uploads (Esc)">
                <button
                  type="button"
                  className="upload-progress-cancel"
                  onClick={cancelAllUploads}
                >
                  {CancelIcon}
                  <span>Cancel</span>
                </button>
              </Tooltip>
            )}
          </header>
          {uploadingCount > 0 && (
            <div className="upload-progress-bar" aria-hidden="true">
              <div
                className="upload-progress-bar-fill"
                style={{ width: `${Math.round(overallProgress * 100)}%` }}
              />
            </div>
          )}
          <ul className="upload-progress-list">
            {uploads.map((u) => <UploadRow key={u.id} upload={u} />)}
          </ul>
        </div>
      )}
    </>
  );
}
