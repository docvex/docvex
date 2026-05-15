import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationsContext';
import { useHasCapability } from '../hooks/useHasCapability';
import {
  createSignedDownloadUrl,
  fetchUploaderProfile,
  updateProjectFileDescription,
  deleteProjectFile,
} from '../lib/projectFiles';
import FilePreview from './FilePreview';
import StatusBadge from './StatusBadge';
import Tooltip from './Tooltip';
// Re-use the .modal-btn / .modal-btn-cancel / .modal-btn-destructive
// rules from the shared modal stylesheet so the action buttons inherit
// the same look the other modals use.
import './ConfirmModal.css';
import './FileDetailModal.css';

// Close (X) glyph in the modal header — same shape used elsewhere in
// the app's modals so the affordance is recognisable at a glance.
const CloseIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// External-link arrow for the View button — signals "opens in new tab".
const ExternalLinkIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

// Trash icon for the Delete button — same stroke recipe as other icons.
const TrashIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

// Format helpers — kept local to avoid a shared lib for what's only
// two callers today (this modal + the cards' meta line). Extract if a
// third consumer shows up.
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// Best-effort display name for the uploader profile row returned by
// get_member_profiles. Same precedence as the sidebar's getDisplayName:
// full_name > name > email-local-part > "Unknown".
function profileDisplayName(profile) {
  if (!profile) return 'Unknown';
  if (profile.full_name) return profile.full_name;
  if (profile.name)      return profile.name;
  if (profile.email) {
    const at = profile.email.indexOf('@');
    return at > 0 ? profile.email.slice(0, at) : profile.email;
  }
  return 'Unknown';
}

// Avatar fallback: real picture for OAuth-sourced profiles, initial-
// letter circle otherwise. Mirrors the AccountAvatar in Sidebar.jsx —
// duplicated here to keep this component self-contained (the sidebar
// version reads from auth user_metadata; this one reads from a
// get_member_profiles row, slightly different shape).
function UploaderAvatar({ profile }) {
  const url = profile?.avatar_url;
  const initial = (profile?.full_name || profile?.name || profile?.email || '?').charAt(0).toUpperCase();
  const status = profile?.status;
  const avatarEl = url ? (
    <img className="file-detail-avatar" src={url} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className="file-detail-avatar file-detail-avatar-fallback">{initial}</span>
  );
  return (
    <span className="file-detail-avatar-wrap">
      {avatarEl}
      <StatusBadge status={status} size="sm" ringColor="var(--bg-card)" />
    </span>
  );
}

export default function FileDetailModal({ file, onClose, onDeleted }) {
  const { session } = useAuth();
  const { notify } = useNotifications();

  const viewerId = session?.user?.id || null;
  // Delete-visibility uses the capability layer so a custom-role member
  // with `files.delete_any` granted on top of their base tier sees the
  // Delete button — and conversely, a custom-role Admin with
  // `files.delete_any` revoked DOESN'T see it. The RLS policy on
  // project_files (migration 008) gates on the same two capabilities, so
  // the UI and the server agree on who can act.
  const canDeleteAny = useHasCapability('files.delete_any');
  const canDeleteOwn = useHasCapability('files.delete_own');
  const isOwnFile   = Boolean(file) && file.uploaded_by === viewerId;
  const canDelete   = Boolean(file) && (canDeleteAny || (isOwnFile && canDeleteOwn));
  // The Delete button used to gate on viewerIsAdmin (computed from
  // selectedProject.role); the capability hook now answers the same
  // question more flexibly. If a future surface needs the raw tier,
  // re-import useSelectedProject and read selectedProject.role.

  // ── Local state ────────────────────────────────────────────────────────
  const [previewUrl, setPreviewUrl]   = useState(null);
  // Signed URL for the pre-baked _thumb.jpg (migration 004). FilePreview
  // uses this for the PDF first-page and video-thumbnail surfaces so we
  // don't pay the cost of running pdf.js / mounting a <video> just to
  // show a teaser. Null for text/images/legacy uploads — FilePreview
  // falls back to the source signedUrl in those cases.
  const [thumbnailUrl, setThumbnailUrl] = useState(null);
  const [uploader, setUploader]       = useState(null);
  // Description: edit-mode flag, the in-progress textarea value, and
  // the saved value. The prop's description.is the source of truth;
  // the textarea value diverges only while editing, and converges back
  // on save / cancel.
  const [editing, setEditing]               = useState(false);
  const [draftDescription, setDraftDescription] = useState('');
  const [saving, setSaving]                 = useState(false);
  const [saveError, setSaveError]           = useState(null);
  // Delete flow: a nested confirm-state (type the filename to confirm)
  // plus a pendingDelete flag so the buttons stay disabled while the
  // network call runs.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmText, setConfirmText]           = useState('');
  const [pendingDelete, setPendingDelete]       = useState(false);
  const [deleteError, setDeleteError]           = useState(null);

  const textareaRef = useRef(null);
  const confirmInputRef = useRef(null);

  // Reset / hydrate whenever the file prop changes id (different card
  // opened) OR the description on the same id changes (realtime echo,
  // another device's edit). Skipping the description reset while the
  // user is mid-edit prevents a concurrent UPDATE from clobbering
  // what they're typing — they see the remote change the next time
  // they exit edit mode.
  useEffect(() => {
    if (!file) return;
    if (!editing) setDraftDescription(file.description ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, file?.description, editing]);

  // Reset transient state when the file prop changes id.
  useEffect(() => {
    setEditing(false);
    setSaveError(null);
    setConfirmingDelete(false);
    setConfirmText('');
    setPendingDelete(false);
    setDeleteError(null);
  }, [file?.id]);

  // Fetch signed URL + uploader profile when a file is shown. 10-min
  // TTL on the URL so the user can sit reading the modal without the
  // video / PDF source going stale.
  useEffect(() => {
    if (!file?.storage_path) {
      setPreviewUrl(null);
      return undefined;
    }
    let cancelled = false;
    setPreviewUrl(null);
    createSignedDownloadUrl(file.storage_path, 600).then(({ data, error }) => {
      if (cancelled || error || !data?.signedUrl) return;
      setPreviewUrl(data.signedUrl);
    });
    return () => { cancelled = true; };
  }, [file?.storage_path]);

  // Sibling fetch for the pre-baked thumbnail (migration 004). Same
  // 10-minute TTL so it doesn't expire while the modal is open. Failures
  // are silent: FilePreview's PDF/video paths gracefully degrade to a
  // pdf.js render / a glyph fallback when thumbnailUrl is null.
  useEffect(() => {
    if (!file?.thumbnail_path) {
      setThumbnailUrl(null);
      return undefined;
    }
    let cancelled = false;
    setThumbnailUrl(null);
    createSignedDownloadUrl(file.thumbnail_path, 600).then(({ data, error }) => {
      if (cancelled || error || !data?.signedUrl) return;
      setThumbnailUrl(data.signedUrl);
    });
    return () => { cancelled = true; };
  }, [file?.thumbnail_path]);

  useEffect(() => {
    if (!file?.uploaded_by) {
      setUploader(null);
      return undefined;
    }
    let cancelled = false;
    fetchUploaderProfile(file.uploaded_by).then(({ data, error }) => {
      if (cancelled || error) return;
      setUploader(data || null);
    });
    return () => { cancelled = true; };
  }, [file?.uploaded_by]);

  // Esc closes the modal unless we're in a sub-state (editing /
  // confirming / deleting). The sub-states own Esc handling locally.
  useEffect(() => {
    if (!file) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (editing || confirmingDelete || pendingDelete) return;
      onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file, editing, confirmingDelete, pendingDelete, onClose]);

  // Auto-focus the description textarea on edit-open.
  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [editing]);

  // Auto-focus the confirm input on delete-confirm-open.
  useEffect(() => {
    if (confirmingDelete) {
      requestAnimationFrame(() => confirmInputRef.current?.focus());
    }
  }, [confirmingDelete]);

  if (!file) return null;

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleBackdropMouseDown = (e) => {
    // Backdrop click closes only when we're idle. Mid-edit / mid-confirm
    // requires explicit Cancel so the user doesn't lose their typing.
    if (e.target !== e.currentTarget) return;
    if (editing || confirmingDelete || pendingDelete) return;
    onClose?.();
  };

  const startEditing = () => {
    setEditing(true);
    setDraftDescription(file.description ?? '');
    setSaveError(null);
  };
  const cancelEditing = () => {
    setEditing(false);
    setDraftDescription(file.description ?? '');
    setSaveError(null);
  };
  const handleEditorKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelEditing(); }
    // Cmd/Ctrl-Enter saves — fast path for power users; the Save button
    // is also right there.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    const { error } = await updateProjectFileDescription(file.id, draftDescription);
    setSaving(false);
    if (error) {
      setSaveError(error.message || 'Could not save description.');
      // Keep the textarea open so the user doesn't lose their edit.
      return;
    }
    setEditing(false);
    // The realtime UPDATE echo will bring the new value back via the
    // page's subscription; the prop-driven reset in the effect above
    // will set draftDescription from the new prop value next render.
  };

  const handleView = async () => {
    // Fresh signed URL on click — the preview URL is 10 min, might be
    // close to expiring by the time the user clicks View. One extra
    // round-trip; imperceptible.
    const { data, error } = await createSignedDownloadUrl(file.storage_path, 300);
    if (error || !data?.signedUrl) {
      notify({
        category: 'file',
        variant: 'error',
        title: 'Could not open file',
        body: error?.message || 'Try again in a moment.',
        dedupeKey: `file-view-error:${file.id}`,
      });
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  };

  const handleDelete = async () => {
    if (pendingDelete) return;
    if (confirmText.trim() !== file.name) return;
    setPendingDelete(true);
    setDeleteError(null);
    const { error } = await deleteProjectFile({
      id: file.id,
      storagePath: file.storage_path,
      thumbnailPath: file.thumbnail_path,
      thumbnailFrames: file.thumbnail_frames,
    });
    setPendingDelete(false);
    if (error) {
      setDeleteError(error.message || 'Could not delete file.');
      return;
    }
    notify({
      category: 'file',
      variant: 'success',
      icon: 'trash',
      title: 'File deleted',
      body: file.name,
      dedupeKey: `file-deleted:${file.id}`,
    });
    // Optimistically tell the page to drop the row from its `files`
    // state so the card disappears instantly — independent of the
    // Realtime DELETE echo (which, without REPLICA IDENTITY FULL on
    // project_files, doesn't pass the project_id filter on the
    // postgres_changes channel and never reaches this client).
    // Migration 006 sets that replica identity so other devices also
    // get the live update via Realtime; this callback is the local
    // path that doesn't depend on the round-trip succeeding.
    onDeleted?.(file.id);
    onClose?.();
  };

  // ── Render ─────────────────────────────────────────────────────────────
  const hasDescription = Boolean((file.description || '').trim());

  return (
    <div
      className="file-detail-backdrop"
      onMouseDown={handleBackdropMouseDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-detail-title"
    >
      <div className="file-detail-card">
        <header className="file-detail-header">
          <Tooltip content={file.name}>
            <h2 id="file-detail-title" className="file-detail-title">
              {file.name}
            </h2>
          </Tooltip>
          <Tooltip content="Close">
            <button
              type="button"
              className="file-detail-close"
              onClick={onClose}
              disabled={pendingDelete}
              aria-label="Close"
            >
              {CloseIcon}
            </button>
          </Tooltip>
        </header>

        <div className="file-detail-body">
          {/* Left pane — preview. Background is darker than the right
              pane so image / PDF letterboxing has a deliberate frame.
              The preview itself is now a click-to-open surface — every
              sub-renderer wraps its content in a ClickablePreview that
              calls handleView (open the full file in a new tab). */}
          <div className="file-detail-pane file-detail-pane-preview">
            <FilePreview
              file={file}
              signedUrl={previewUrl}
              thumbnailUrl={thumbnailUrl}
              onOpen={handleView}
            />
          </div>

          {/* Right pane — metadata + actions. Stacked sections with a
              consistent gutter. */}
          <aside className="file-detail-pane file-detail-pane-meta">
            <section className="file-detail-section">
              <div className="file-detail-section-label">Description</div>
              {editing ? (
                <div className="file-detail-description-editor">
                  <textarea
                    ref={textareaRef}
                    className="file-detail-textarea"
                    value={draftDescription}
                    onChange={(e) => setDraftDescription(e.target.value)}
                    onKeyDown={handleEditorKeyDown}
                    placeholder="What's this file about?"
                    rows={5}
                    maxLength={2000}
                    disabled={saving}
                  />
                  {saveError && (
                    <div className="file-detail-inline-error" role="alert">{saveError}</div>
                  )}
                  <div className="file-detail-editor-actions">
                    <button
                      type="button"
                      className="modal-btn modal-btn-cancel"
                      onClick={cancelEditing}
                      disabled={saving}
                    >Cancel</button>
                    <button
                      type="button"
                      className="modal-btn modal-btn-confirm"
                      onClick={save}
                      disabled={saving}
                    >{saving ? 'Saving…' : 'Save'}</button>
                  </div>
                  <div className="file-detail-hint">Cmd/Ctrl+Enter to save · Esc to cancel</div>
                </div>
              ) : (
                <Tooltip content="Click to edit">
                  <button
                    type="button"
                    className={`file-detail-description-view${hasDescription ? '' : ' is-empty'}`}
                    onClick={startEditing}
                  >
                    {hasDescription ? file.description : 'Add a description…'}
                  </button>
                </Tooltip>
              )}
            </section>

            <section className="file-detail-section">
              <div className="file-detail-section-label">Details</div>
              <dl className="file-detail-dl">
                <div className="file-detail-dl-row">
                  <dt>Type</dt>
                  <dd><code>{file.mime_type || 'unknown'}</code></dd>
                </div>
                <div className="file-detail-dl-row">
                  <dt>Size</dt>
                  <dd>{formatBytes(file.size_bytes)}</dd>
                </div>
                <div className="file-detail-dl-row">
                  <dt>Added</dt>
                  <dd>{formatDateTime(file.uploaded_at)}</dd>
                </div>
                <div className="file-detail-dl-row file-detail-dl-row-uploader">
                  <dt>By</dt>
                  <dd className="file-detail-uploader">
                    <UploaderAvatar profile={uploader} />
                    <span className="file-detail-uploader-name">{profileDisplayName(uploader)}</span>
                  </dd>
                </div>
              </dl>
            </section>

            <div className="file-detail-actions">
              <Tooltip content="Open the file in a new tab">
                <button
                  type="button"
                  className="modal-btn modal-btn-cancel file-detail-action"
                  onClick={handleView}
                  disabled={pendingDelete}
                >
                  {ExternalLinkIcon}
                  <span>View</span>
                </button>
              </Tooltip>
              {canDelete && (
                <Tooltip content="Delete this file">
                  <button
                    type="button"
                    className="modal-btn modal-btn-destructive file-detail-action"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={pendingDelete}
                  >
                    {TrashIcon}
                    <span>Delete</span>
                  </button>
                </Tooltip>
              )}
            </div>
          </aside>
        </div>

        {/* Nested delete-confirm modal. Mirrors DeleteProjectModal's
            type-to-confirm pattern: user types the filename exactly to
            enable the destructive button. Sits as a child of the
            detail modal so it inherits z-index above it, and so
            closing the detail modal doesn't leave an orphaned
            confirm dialog floating. */}
        {confirmingDelete && (
          <div
            className="file-detail-confirm-backdrop"
            onMouseDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (pendingDelete) return;
              setConfirmingDelete(false);
              setConfirmText('');
            }}
          >
            <div className="file-detail-confirm-card" role="dialog" aria-modal="true" aria-labelledby="file-detail-confirm-title">
              <h3 id="file-detail-confirm-title" className="file-detail-confirm-title">Delete file?</h3>
              <p className="file-detail-confirm-body">
                This permanently deletes <strong>{file.name}</strong> and its preview.
                Type the file name to confirm.
              </p>
              <input
                ref={confirmInputRef}
                type="text"
                className="file-detail-confirm-input"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={file.name}
                disabled={pendingDelete}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && !pendingDelete) {
                    setConfirmingDelete(false);
                    setConfirmText('');
                  }
                  if (e.key === 'Enter' && confirmText.trim() === file.name && !pendingDelete) {
                    handleDelete();
                  }
                }}
              />
              {deleteError && (
                <div className="file-detail-inline-error" role="alert">{deleteError}</div>
              )}
              <div className="file-detail-confirm-actions">
                <button
                  type="button"
                  className="modal-btn modal-btn-cancel"
                  onClick={() => { setConfirmingDelete(false); setConfirmText(''); }}
                  disabled={pendingDelete}
                >Cancel</button>
                <button
                  type="button"
                  className="modal-btn modal-btn-destructive"
                  onClick={handleDelete}
                  disabled={pendingDelete || confirmText.trim() !== file.name}
                >{pendingDelete ? 'Deleting…' : 'Delete'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
