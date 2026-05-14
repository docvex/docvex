import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useReportProblem } from '../context/ReportProblemContext';
import { useNotifications } from '../context/NotificationsContext';
import { sendSupportReport } from '../lib/support';
// Reuse the shared .modal-btn / .modal-btn-cancel / .modal-btn-confirm
// rules — same pattern InviteMemberModal / DeleteAccountModal use.
import './ConfirmModal.css';
import './ReportProblemModal.css';

// Inline icon — close button in the top-right of the modal.
const CloseIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// Inline icon — Remove button on each attachment thumbnail.
const TrashIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

// Inline icon — plus on the "Add image or video" tile.
const PlusIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MB — mirrors the Edge Function cap

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Build a stable preview URL for a File (image or video) — we want one
// URL.createObjectURL per file across the modal's lifetime so the URL
// doesn't churn on every render. The cleanup effect revokes them on
// unmount / file removal so we don't leak.
function useFilePreviews(files) {
  const previewsRef = useRef(new Map()); // file → objectURL
  const previews = useMemo(() => {
    const next = new Map();
    for (const f of files) {
      const existing = previewsRef.current.get(f);
      next.set(f, existing ?? URL.createObjectURL(f));
    }
    // Revoke URLs for files no longer in the list.
    for (const [f, url] of previewsRef.current.entries()) {
      if (!next.has(f)) URL.revokeObjectURL(url);
    }
    previewsRef.current = next;
    return next;
  }, [files]);
  useEffect(() => {
    return () => {
      for (const url of previewsRef.current.values()) URL.revokeObjectURL(url);
      previewsRef.current = new Map();
    };
  }, []);
  return previews;
}

export default function ReportProblemModal() {
  const { open, screenshot, close, removeScreenshot } = useReportProblem();
  const { notify } = useNotifications();

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [extraFiles, setExtraFiles] = useState([]); // File[]
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const fileInputRef = useRef(null);
  const descriptionRef = useRef(null);

  // Reset form whenever the modal opens. Mirrors InviteMemberModal's
  // pattern — keeping the previous draft when closed-then-reopened
  // would be confusing because the captured screenshot is fresh.
  useEffect(() => {
    if (open) {
      setSubject('');
      setDescription('');
      setExtraFiles([]);
      setSending(false);
      setError(null);
      // Focus the description on open — the most important field.
      requestAnimationFrame(() => descriptionRef.current?.focus());
    }
  }, [open]);

  // Esc to close (when not mid-send). Backdrop click handled via
  // onMouseDown so clicking inside the card and dragging out doesn't
  // close — same pattern InviteMemberModal uses.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape' && !sending) close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, sending, close]);

  const filePreviews = useFilePreviews(extraFiles);

  // Total payload size = screenshot blob + every extra file. Hard cap at
  // 25 MB; the submit button disables and an inline error explains why
  // when crossed. Server-side guard re-checks (defence in depth).
  const totalBytes =
    (screenshot?.blob?.size ?? 0) +
    extraFiles.reduce((sum, f) => sum + f.size, 0);
  const tooLarge = totalBytes > MAX_TOTAL_BYTES;
  const tooMany = (screenshot ? 1 : 0) + extraFiles.length > 10;

  if (!open) return null;

  const handleBackdropMouseDown = (e) => {
    if (sending) return;
    if (e.target === e.currentTarget) close();
  };

  const handleFiles = (e) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length === 0) return;
    setExtraFiles((prev) => [...prev, ...picked]);
    // Reset the input so picking the same file twice in a row still
    // fires onChange the second time.
    e.target.value = '';
  };

  const removeExtra = (file) => {
    setExtraFiles((prev) => prev.filter((f) => f !== file));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    const trimmedDescription = description.trim();
    if (!trimmedDescription) {
      setError('Please describe what went wrong.');
      return;
    }
    if (tooLarge) {
      setError(`Attachments total ${formatBytes(totalBytes)} — max is 25 MB.`);
      return;
    }
    if (tooMany) {
      setError('Too many attachments — max is 10 files.');
      return;
    }

    const attachments = [];
    if (screenshot?.blob) {
      attachments.push({ filename: 'screenshot.png', blob: screenshot.blob });
    }
    for (const f of extraFiles) {
      attachments.push({ filename: f.name, blob: f });
    }

    setSending(true);
    const { data, error: sendErr } = await sendSupportReport({
      subject,
      description: trimmedDescription,
      attachments,
    });
    setSending(false);

    if (sendErr || !data?.ok) {
      setError(sendErr?.message || 'Could not send the report. Please try again.');
      return;
    }

    notify({
      category: 'support',
      variant: 'success',
      icon: 'send',
      title: 'Report sent',
      body: 'Support will reply by email.',
      dedupeKey: 'support-report-sent',
    });
    close();
  };

  return (
    <div
      className="report-modal-backdrop"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="report-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-modal-title"
      >
        <header className="report-modal-header">
          <h2 id="report-modal-title" className="report-modal-title">Report a problem</h2>
          <button
            type="button"
            className="report-modal-close"
            onClick={close}
            disabled={sending}
            aria-label="Close"
            title="Close"
          >
            {CloseIcon}
          </button>
        </header>

        <form className="report-modal-form" onSubmit={handleSubmit} noValidate>
          <label className="report-modal-field">
            <span className="report-modal-label">Subject <span className="report-modal-optional">(optional)</span></span>
            <input
              type="text"
              className="report-modal-input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Short title — we'll fill one in if you skip it"
              maxLength={140}
              disabled={sending}
            />
          </label>

          <label className="report-modal-field">
            <span className="report-modal-label">
              What went wrong? <span className="report-modal-required">*</span>
            </span>
            <textarea
              ref={descriptionRef}
              className="report-modal-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Steps to reproduce, what you expected, what happened. The more detail the better."
              rows={8}
              maxLength={5000}
              disabled={sending}
              required
            />
          </label>

          <div className="report-modal-field">
            <span className="report-modal-label">Attachments</span>
            <div className="report-modal-attachments">
              {/* Auto-captured screenshot — shown first so the user
                  notices it's there and can remove it before sending. */}
              {screenshot && (
                <div className="report-modal-attachment is-screenshot" title="Screenshot of the page behind the modal">
                  <img
                    src={screenshot.dataUrl}
                    alt="Captured screenshot"
                    className="report-modal-thumb"
                  />
                  <div className="report-modal-attachment-meta">
                    <span className="report-modal-attachment-name">screenshot.png</span>
                    <span className="report-modal-attachment-size">{formatBytes(screenshot.blob?.size ?? 0)}</span>
                  </div>
                  <button
                    type="button"
                    className="report-modal-attachment-remove"
                    onClick={removeScreenshot}
                    disabled={sending}
                    aria-label="Remove screenshot"
                    title="Remove screenshot"
                  >
                    {TrashIcon}
                  </button>
                </div>
              )}

              {/* User-uploaded files. Images render their thumbnail
                  directly; videos render a poster from the first frame
                  via preload=metadata. */}
              {extraFiles.map((f) => {
                const previewUrl = filePreviews.get(f);
                const isVideo = f.type.startsWith('video/');
                return (
                  <div className="report-modal-attachment" key={`${f.name}:${f.size}:${f.lastModified}`} title={f.name}>
                    {isVideo ? (
                      <video
                        src={previewUrl}
                        className="report-modal-thumb"
                        muted
                        playsInline
                        preload="metadata"
                      />
                    ) : (
                      <img src={previewUrl} alt={f.name} className="report-modal-thumb" />
                    )}
                    <div className="report-modal-attachment-meta">
                      <span className="report-modal-attachment-name">{f.name}</span>
                      <span className="report-modal-attachment-size">{formatBytes(f.size)}</span>
                    </div>
                    <button
                      type="button"
                      className="report-modal-attachment-remove"
                      onClick={() => removeExtra(f)}
                      disabled={sending}
                      aria-label={`Remove ${f.name}`}
                      title="Remove"
                    >
                      {TrashIcon}
                    </button>
                  </div>
                );
              })}

              {/* "Add" tile — proxies a hidden file input. accept
                  restricts to images and videos but the user can still
                  override via "All files" in the picker if needed. */}
              <button
                type="button"
                className="report-modal-attachment-add"
                onClick={() => fileInputRef.current?.click()}
                disabled={sending}
                title="Add image or video"
              >
                {PlusIcon}
                <span className="report-modal-attachment-add-label">Add image or video</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                onChange={handleFiles}
                style={{ display: 'none' }}
              />
            </div>

            <div className={`report-modal-size${tooLarge ? ' is-over' : ''}`}>
              <span>Max total size: 25 MB.</span>
              <span>Currently: {formatBytes(totalBytes)}</span>
            </div>
          </div>

          {error && (
            <div className="report-modal-error" role="alert">{error}</div>
          )}

          <div className="report-modal-actions">
            <button
              type="button"
              className="modal-btn modal-btn-cancel"
              onClick={close}
              disabled={sending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="modal-btn modal-btn-confirm"
              disabled={
                sending ||
                description.trim().length === 0 ||
                tooLarge ||
                tooMany
              }
            >
              {sending ? 'Sending…' : 'Send report'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
