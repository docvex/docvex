import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationsContext';
import { useHasCapability } from '../hooks/useHasCapability';
import { useBranch } from '../context/BranchContext';
import {
  createSignedDownloadUrl,
  fetchUploaderProfile,
  updateProjectFile,
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

export default function FileDetailModal({ file, onClose, onDeleted, readOnly = false, onLocalRename }) {
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

  // Branch context — when the user is viewing their private branch
  // ('mine'), every edit/delete is intercepted and queued as a
  // branch_changes row instead of mutating project_files directly.
  // On 'main' view the existing direct-mutation path runs unchanged.
  const { view: branchView, queueChange, overlayByFileId } = useBranch();
  const branchOverlay = file ? overlayByFileId.get(file.id) || null : null;
  const isOnMineBranch = branchView === 'mine';

  // `readOnly` is a caller-side override (Files page sets it true when
  // the modal is opened from the Cloud tab / Main branch — main is the
  // canonical surface, no edits allowed there). It collapses the
  // editable + delete affordances regardless of RLS / capability.
  //
  // Edit/delete gates have TWO modes:
  //   • Main view  — direct project_files mutation, RLS-gated to the
  //     uploader or admin. Mirrors `has_project_role + uploaded_by`
  //     in migration 005.
  //   • My branch  — every member can edit/delete ANY file because
  //     the action just queues a branch_change for admin review. RLS
  //     on branch_changes is row-owner-only and doesn't depend on
  //     project_files ownership.
  const canDelete = !readOnly && Boolean(file) && (
    isOnMineBranch
      || canDeleteAny
      || (isOwnFile && canDeleteOwn)
  );
  // Disable inputs when the file is already queued for delete — the
  // file is logically gone from the branch, further edits don't make
  // sense until the user discards or pushes the delete.
  const isQueuedForDelete = isOnMineBranch && branchOverlay?.kind === 'delete';
  // The Delete button used to gate on viewerIsAdmin (computed from
  // selectedProject.role); the capability hook now answers the same
  // question more flexibly. If a future surface needs the raw tier,
  // re-import useSelectedProject and read selectedProject.role.

  // ── Local state ────────────────────────────────────────────────────────
  const [previewUrl, setPreviewUrl]   = useState(null);
  const [uploader, setUploader]       = useState(null);
  // Editable fields — drafts shadow the props so the user can type
  // freely; on blur we diff against the prop and fire a save if
  // changed. The prop is the source of truth (realtime UPDATE events
  // from other devices flow through it), so we re-sync the draft on
  // prop change EXCEPT for the field currently focused — see the sync
  // effect below.
  const [draftName, setDraftName]               = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [nameFocused, setNameFocused]           = useState(false);
  const [descFocused, setDescFocused]           = useState(false);
  // 'name' | 'description' | null — which field is mid-save right now,
  // so we can disable that input without freezing the other one.
  const [savingField, setSavingField] = useState(null);
  const [saveError, setSaveError]     = useState(null);
  // Orientation — driven by an image file's natural aspect ratio.
  // Adjusts the preview pane's flex-basis in the side panel: portrait
  // images get more vertical space, landscape less. Non-image files
  // stay on the default ('horizontal' = portrait-leaning preview).
  const [orientation, setOrientation] = useState('horizontal');
  // Delete flow: a nested confirm-state (type the filename to confirm)
  // plus a pendingDelete flag so the buttons stay disabled while the
  // network call runs.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmText, setConfirmText]           = useState('');
  const [pendingDelete, setPendingDelete]       = useState(false);
  const [deleteError, setDeleteError]           = useState(null);

  const confirmInputRef = useRef(null);

  // Edit gate — mirrors the project_files UPDATE RLS policy (migration
  // 005: uploader OR admin). `canDeleteAny` returning true is the
  // capability layer's way of saying "this viewer is admin-or-better
  // on the project", so it doubles as the admin signal for editing.
  // Edit gate — same split as canDelete above:
  //   • Main view  — uploader or admin per RLS.
  //   • My branch  — anyone (the edit just queues a branch_change
  //     for admin review; no direct project_files mutation).
  const canEdit = !readOnly && Boolean(file) && (
    isOnMineBranch
      || canDeleteAny
      || isOwnFile
  );

  // Effective name/description for display:
  //   • On 'main', the project_files row is the truth.
  //   • On 'mine', any queued edit/replace overlay's proposed values
  //     win — so the modal mirrors what the card shows AND what the
  //     branch will look like after approval. Without this, the
  //     modal would re-paint the old main-branch name even after the
  //     user's queued rename, contradicting the card.
  // `in` (not ??) so an explicit null/"" in proposed (the user
  // cleared a field) wins over the main value.
  const overlayProposed = (isOnMineBranch && branchOverlay?.proposed) || null;
  const effectiveName = overlayProposed && 'name' in overlayProposed
    ? (overlayProposed.name ?? '')
    : (file?.name ?? '');
  const effectiveDescription = overlayProposed && 'description' in overlayProposed
    ? (overlayProposed.description ?? '')
    : (file?.description ?? '');

  // Sync drafts from the effective values on mount / changes / focus.
  // Skipping the sync for a focused field prevents a concurrent UPDATE
  // (realtime echo from another device, or local optimistic update)
  // from clobbering what the user is currently typing — they'll see
  // the remote change the next time they blur out of the field.
  useEffect(() => {
    if (!file) return;
    if (!nameFocused) setDraftName(effectiveName);
    if (!descFocused) setDraftDescription(effectiveDescription);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, effectiveName, effectiveDescription, nameFocused, descFocused]);

  // Reset transient state when the file prop changes id.
  useEffect(() => {
    setSavingField(null);
    setSaveError(null);
    setConfirmingDelete(false);
    setConfirmText('');
    setPendingDelete(false);
    setDeleteError(null);
    // Reset orientation to the default while the new file's aspect
    // is being probed — keeps the layout from snapping between the
    // last file's orientation and the new file's mid-load.
    setOrientation('horizontal');
  }, [file?.id]);

  // Probe natural aspect ratio for image / video files. Choose layout:
  // landscape (width > height) → vertical (preview on top, taking the
  // wide horizontal space); portrait (height >= width) → horizontal
  // (preview on left, taking the tall vertical space). Either way the
  // preview gets the dimension it actually wants. PDF / text / files
  // with no probe source stay on the default horizontal layout (PDF
  // pages are portrait by convention; text has no preview aspect).
  useEffect(() => {
    if (!file) return undefined;
    const mime = file.mime_type || '';
    // Only images probe via signedUrl — exact native dimensions, no
    // thumbnail interpolation. Video/PDF/text stay on the default
    // horizontal orientation; they don't need an aspect-aware layout.
    if (!mime.startsWith('image/') || !previewUrl) return undefined;

    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      if (!img.naturalWidth || !img.naturalHeight) return;
      setOrientation(img.naturalWidth > img.naturalHeight ? 'vertical' : 'horizontal');
    };
    img.src = previewUrl;
    return () => { cancelled = true; };
  }, [file?.id, file?.mime_type, previewUrl]);

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

  // Esc closes the modal — unless a sub-state owns it. Mid-edit Esc
  // reverts the focused field's draft and blurs (handled in each
  // input's onKeyDown below); we don't intercept that here. Delete-
  // confirm and active deletes hold Esc too so the user doesn't
  // accidentally cancel a destructive flow.
  useEffect(() => {
    if (!file) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (confirmingDelete || pendingDelete) return;
      if (nameFocused || descFocused) return;
      onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file, confirmingDelete, pendingDelete, nameFocused, descFocused, onClose]);

  // Auto-focus the confirm input on delete-confirm-open.
  useEffect(() => {
    if (confirmingDelete) {
      requestAnimationFrame(() => confirmInputRef.current?.focus());
    }
  }, [confirmingDelete]);

  if (!file) return null;

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleBackdropMouseDown = (e) => {
    // Backdrop click closes only when we're idle. Active focus on a
    // field or a mid-confirm requires explicit interaction first so
    // the user doesn't lose typing or accidentally cancel a destructive
    // flow.
    if (e.target !== e.currentTarget) return;
    if (confirmingDelete || pendingDelete) return;
    if (nameFocused || descFocused) return;
    onClose?.();
  };

  // Generic save — sends the patch and reconciles the draft on
  // success/failure. On RLS rejection (.single() returns no rows)
  // or DB constraint violation we revert the draft so the input
  // snaps back to the last-known-good prop value. On 'mine' branch
  // the patch is routed to queueChange (creates / extends a
  // branch_changes row) instead of mutating project_files directly.
  const persistPatch = async (field, patch, revertValue) => {
    setSavingField(field);
    setSaveError(null);
    let error = null;
    if (isOnMineBranch) {
      // Queue the edit as a branch change. The branch UI overlay
      // applies the proposed values on top of the main row.
      const res = await queueChange({
        kind: 'edit',
        targetFileId: file.id,
        proposed: patch,
      });
      error = res.error;
      // ALSO rename the file on disk if this patch carries a new
      // name. computeBranchDiff's rename-pair detection (matching
      // by content_hash) keeps the resulting filesystem move from
      // showing up as add+delete in the diff, so the rename intent
      // remains represented by the branch_change above only.
      // Best-effort: a disk-rename failure leaves the metadata
      // queue intact — the user just won't see the new name in
      // File Explorer until they refresh / rename manually.
      if (!error && field === 'name' && patch?.name && typeof onLocalRename === 'function') {
        try { await onLocalRename(patch.name); }
        catch { /* swallow — toast'd elsewhere if needed */ }
      }
    } else {
      const res = await updateProjectFile(file.id, patch);
      error = res.error;
    }
    setSavingField(null);
    if (error) {
      setSaveError(error.message || 'Could not save changes.');
      if (field === 'name') setDraftName(revertValue);
      else if (field === 'description') setDraftDescription(revertValue);
    }
    // On main: realtime UPDATE echo refreshes file.* via the page's
    // subscription. On mine: realtime INSERT echoes the branch_changes
    // row into BranchContext.pendingChanges, and the page's overlay
    // re-renders the card with the queued kind.
  };

  const commitName = () => {
    if (!file) return;
    const trimmed = draftName.trim();
    if (!trimmed) {
      // Empty after trim — revert to the effective value without a
      // round-trip. The DB's `length(trim(name)) > 0` check would
      // reject this anyway; surfacing it instantly is friendlier
      // than the "constraint violation" toast.
      setDraftName(effectiveName);
      return;
    }
    // Compare against the currently-displayed value, not just
    // file.name — on 'mine' an overlay may already carry a proposed
    // name, and we don't want to re-queue an identical edit.
    if (trimmed === effectiveName) return;
    persistPatch('name', { name: trimmed }, effectiveName);
  };

  const commitDescription = () => {
    if (!file) return;
    // Normalise both sides the same way the lib does before comparing,
    // so a draft of "" vs an effective of null reads as "no change".
    const trimmed = draftDescription.trim();
    const draftNormal = trimmed || null;
    const effNormal   = (effectiveDescription || '').trim() || null;
    if (draftNormal === effNormal) return;
    persistPatch('description', { description: draftDescription }, effectiveDescription);
  };

  const handleNameKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setDraftName(effectiveName);
      e.currentTarget.blur();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur(); // triggers commitName via onBlur
    }
  };
  const handleDescriptionKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setDraftDescription(effectiveDescription);
      e.currentTarget.blur();
    }
    // Cmd/Ctrl-Enter saves; plain Enter inserts a newline.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.blur();
    }
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
    // Branch routing: on 'mine' the delete is queued as a
    // branch_changes row (reversible by discarding the change before
    // pushing). On 'main' the delete hits project_files + storage
    // immediately (the existing direct path).
    if (isOnMineBranch) {
      const { error } = await queueChange({
        kind: 'delete',
        targetFileId: file.id,
        proposed: null,
      });
      setPendingDelete(false);
      if (error) {
        setDeleteError(error.message || 'Could not queue delete.');
        return;
      }
      notify({
        category: 'file',
        variant: 'success',
        icon: 'trash',
        title: 'Delete queued',
        body: `${file.name} will be removed when an admin approves your push.`,
        dedupeKey: `branch-delete-queued:${file.id}`,
      });
      // Close the modal but don't tell the page to drop the row —
      // the file still exists on main; the branch overlay will paint
      // a "DELETED" pill on the card via BranchContext.
      onClose?.();
      return;
    }
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
    onDeleted?.(file.id);
    onClose?.();
  };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div
      className="file-detail-backdrop"
      onMouseDown={handleBackdropMouseDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-detail-title"
    >
      <div className={`file-detail-card is-${orientation}`}>
        {/* Header — close button only. The filename moved into the meta
            pane as an editable input (under the title section). */}
        <header className="file-detail-header">
          <span id="file-detail-title" className="file-detail-sr-title">
            {file.name}
          </span>
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
          {/* Preview pane — sits at the top of the side panel. The
              .is-horizontal / .is-vertical class on the card adjusts
              its flex-basis (portrait files get more vertical space).
              Every FilePreview sub-renderer wraps its content in a
              ClickablePreview that calls handleView to open the full
              file in a new tab. */}
          <div className="file-detail-pane file-detail-pane-preview">
            <FilePreview
              file={file}
              signedUrl={previewUrl}
              onOpen={handleView}
            />
          </div>

          {/* Meta pane — title input + description textarea + Details
              + actions. Scrolls its own overflow so long descriptions
              don't push the action buttons off-screen. */}
          <aside className="file-detail-pane file-detail-pane-meta">
            {/* Branch-state banner — shown only on 'mine' branch when
                this file has a queued change. Calls out the queued
                kind so the user understands why later edits are
                getting routed differently / why the file looks struck
                through on its card. */}
            {isOnMineBranch && branchOverlay && (
              <div className={`file-detail-branch-banner is-${branchOverlay.kind}`}>
                {branchOverlay.kind === 'edit'    && 'Edit queued — will apply on approval.'}
                {branchOverlay.kind === 'delete'  && 'Delete queued — file will be removed on approval.'}
                {branchOverlay.kind === 'replace' && 'Replace queued — bytes will be swapped on approval.'}
              </div>
            )}
            <section className="file-detail-section file-detail-section-title">
              <label className="file-detail-section-label" htmlFor="file-detail-name-input">
                Title
              </label>
              <input
                id="file-detail-name-input"
                type="text"
                className="file-detail-name-input"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onFocus={() => setNameFocused(true)}
                onBlur={() => { setNameFocused(false); commitName(); }}
                onKeyDown={handleNameKeyDown}
                placeholder="File name"
                disabled={!canEdit || savingField === 'name' || isQueuedForDelete}
                spellCheck={false}
                maxLength={200}
                aria-label="File name"
              />
            </section>

            <section className="file-detail-section">
              <label className="file-detail-section-label" htmlFor="file-detail-description-input">
                Description
              </label>
              <textarea
                id="file-detail-description-input"
                className="file-detail-description-input"
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                onFocus={() => setDescFocused(true)}
                onBlur={() => { setDescFocused(false); commitDescription(); }}
                onKeyDown={handleDescriptionKeyDown}
                placeholder={canEdit ? "What's this file about?" : 'No description'}
                disabled={!canEdit || savingField === 'description' || isQueuedForDelete}
                rows={3}
                maxLength={2000}
                aria-label="File description"
              />
            </section>

            {saveError && (
              <div className="file-detail-inline-error" role="alert">{saveError}</div>
            )}

            <section className="file-detail-section">
              <div className="file-detail-section-label">Details</div>
              <div className="file-detail-details">
                <div className="file-detail-details-row">
                  <span className="file-detail-details-label">Type</span>
                  <span className="file-detail-details-value">{file.mime_type || 'unknown'}</span>
                </div>
                <div className="file-detail-details-row">
                  <span className="file-detail-details-label">Size</span>
                  <span className="file-detail-details-value">{formatBytes(file.size_bytes)}</span>
                </div>
                <div className="file-detail-details-row">
                  <span className="file-detail-details-label">Added</span>
                  <span className="file-detail-details-value">{formatDateTime(file.uploaded_at)}</span>
                </div>
                <div className="file-detail-details-row file-detail-details-row-uploader">
                  <span className="file-detail-details-label">By</span>
                  <div className="file-detail-details-value file-detail-uploader">
                    <UploaderAvatar profile={uploader} />
                    <span className="file-detail-uploader-name">{profileDisplayName(uploader)}</span>
                  </div>
                </div>
              </div>
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
