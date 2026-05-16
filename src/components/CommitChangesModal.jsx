import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useNotifications } from '../context/NotificationsContext';
import { useBranch } from '../context/BranchContext';
import {
  computeBranchDiff,
  uploadBlobToPending,
  createOrMergeChangeRequest,
  deletePendingObject,
  discardBranchChange,
} from '../lib/branches';
import { readLocalBlob } from '../lib/localFolder';
import Tooltip from './Tooltip';
import './ConfirmModal.css';
import './CommitChangesModal.css';

// "Commit changes" modal — the push step. Computes the diff between
// the user's local folder and the canonical project_files list at
// open time, lists every add / replace / delete item, asks for a
// title + optional description, and on confirm:
//   1. Uploads every add/replace's bytes to the projects-pending
//      bucket (via fetch on the localfile:// protocol → Supabase
//      signed PUT).
//   2. Inserts a change_requests row + change_request_items pointing
//      at the freshly-uploaded pending paths.
// The admin's Approve RPC (migration 013) then copies those pending
// objects to canonical project_files storage_paths atomically with
// the row writes.

const CloseIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const KIND_LABEL = {
  add:     'Added',
  edit:    'Edited',
  delete:  'Deleted',
  replace: 'Replaced',
};

const KIND_TONE = {
  add:     'add',
  edit:    'edit',
  replace: 'replace',
  delete:  'delete',
};

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function CommitChangesModal({
  open,
  onClose,
  localFiles,
  cloudFiles,
  pendingChanges = [],
}) {
  const { session } = useAuth();
  const { selectedProject } = useSelectedProject();
  const { notify } = useNotifications();
  const {
    requests: changeRequests,
    openOwnRequestItems,
    refreshOpenRequestItems,
  } = useBranch();
  const userId    = session?.user?.id || null;
  const projectId = selectedProject?.id || null;
  // Existing open request from THIS user on THIS project. When set,
  // the submit will fold items into it (instead of trying to insert
  // a new one and tripping the one-open-per-author unique index).
  // Surfaces in the intro copy + button label so the user knows.
  const openOwnRequest = useMemo(
    () => (changeRequests || []).find(
      (r) => r.status === 'open' && r.author_id === userId && r.project_id === projectId,
    ),
    [changeRequests, userId, projectId],
  );

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(null);   // { current, total, name } while uploading
  const [error, setError] = useState(null);
  const titleRef = useRef(null);

  // Snapshot the diff on open so the displayed list doesn't shift if
  // the user happens to save a file in another app while the modal is
  // up. Re-snapshot when the modal opens again.
  //
  // Two sources are merged:
  //   • `source: 'fs'`     — entries from the filesystem diff
  //                          (computeBranchDiff). Carry `local` /
  //                          `cloud` references for upload.
  //   • `source: 'modal'`  — entries from the branch_changes table
  //                          (queued via FileDetailModal). Carry
  //                          `_branchChangeId` so we can discard the
  //                          row after successful commit.
  const [snapshot, setSnapshot] = useState([]);
  useEffect(() => {
    if (open) {
      // Pass the open-request items to the diff so we only display
      // NEW work in the modal. Anything already in flight (existing
      // submitted items) is filtered out — pushing a duplicate
      // would just no-op via createOrMergeChangeRequest, but
      // showing it would be misleading.
      const fsDiff = computeBranchDiff(
        localFiles,
        cloudFiles,
        undefined,
        undefined,
        openOwnRequestItems,
      ).map((it) => ({ ...it, source: 'fs' }));
      const cloudById = new Map();
      for (const c of cloudFiles || []) cloudById.set(c.id, c);
      const modalEdits = (pendingChanges || []).map((c) => ({
        source: 'modal',
        kind: c.kind,
        _branchChangeId: c.id,
        target_file_id: c.target_file_id,
        proposed: c.proposed,
        cloud: c.target_file_id ? cloudById.get(c.target_file_id) : null,
      }));

      // A modal-driven rename creates BOTH a queued edit (proposed.name)
      // AND — because the disk file was renamed too — an fs add(new name)
      // + fs delete(old name). The hash-based pair detection in
      // computeBranchDiff is skipped above (no hash maps passed), so we
      // dedupe here using the authoritative overlay data instead:
      //   • Drop fs 'add' items whose name matches a queued edit's
      //     proposed.name (that's the new disk filename).
      //   • Drop fs 'delete' items whose cloud row is the target of a
      //     queued edit (that's the cloud file being renamed).
      // Result: a rename surfaces as a single "Edited" entry.
      //
      // Extension-tolerant comparison: proposed.name is often the
      // base ("bar") because the user typed it without the extension,
      // while the on-disk filename is the base+ext ("bar.png"). Each
      // name is normalised to a Set of {full, base} variants so a
      // match in either form drops the fs phantom.
      const stripExt = (s) => {
        const lc = (s || '').toLowerCase();
        const dot = lc.lastIndexOf('.');
        return dot > 0 ? lc.slice(0, dot) : lc;
      };
      const renamedNameVariants = new Set();
      const renamedCloudIds = new Set();
      for (const c of pendingChanges || []) {
        if (c.kind !== 'edit' && c.kind !== 'replace') continue;
        if (!c.target_file_id) continue;
        const proposedName = c.proposed?.name;
        if (!proposedName) continue;
        renamedNameVariants.add(proposedName.toLowerCase());
        renamedNameVariants.add(stripExt(proposedName));
        renamedCloudIds.add(c.target_file_id);
      }
      const nameMatchesRename = (name) => {
        const lc = (name || '').toLowerCase();
        return renamedNameVariants.has(lc) || renamedNameVariants.has(stripExt(lc));
      };
      const filteredFsDiff = fsDiff.filter((it) => {
        if (it.kind === 'add' && it.local && nameMatchesRename(it.local.name)) return false;
        if (it.kind === 'delete' && it.cloud
            && renamedCloudIds.has(it.cloud.id)) return false;
        return true;
      });

      setSnapshot([...filteredFsDiff, ...modalEdits]);
      setTitle('');
      setDescription('');
      setError(null);
      setProgress(null);
      setSubmitting(false);
      requestAnimationFrame(() => titleRef.current?.focus());
    }
  }, [open, localFiles, cloudFiles, pendingChanges, openOwnRequestItems]);

  // Esc closes when not mid-upload — interrupting an upload mid-PUT
  // would leak the partial pending object until the next reject.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !submitting) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  // Grouped counts for the intro line / disabled state.
  const counts = useMemo(() => {
    const c = { add: 0, edit: 0, replace: 0, delete: 0 };
    for (const it of snapshot) c[it.kind] = (c[it.kind] || 0) + 1;
    return c;
  }, [snapshot]);

  if (!open) return null;

  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0 && snapshot.length > 0 && !submitting && projectId && userId;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    // Track every pending object we upload so we can clean up on
    // failure — without this, an aborted submit leaks orphan blobs
    // in the pending bucket.
    const uploadedPendingPaths = [];
    try {
      // Upload bytes only for filesystem-sourced adds + replaces —
      // modal-driven edits carry just metadata patches in `proposed`
      // and don't need any byte transfer.
      const uploadable = snapshot.filter((it) =>
        it.source === 'fs' && (it.kind === 'add' || it.kind === 'replace'),
      );
      const uploadedById = new Map();  // snapshot index → upload metadata
      for (let i = 0; i < uploadable.length; i++) {
        const it = uploadable[i];
        setProgress({ current: i + 1, total: uploadable.length, name: it.local.name });
        // Read the bytes via the unified API — Electron streams via
        // `localfile://`, web pulls from the cached FileSystemFileHandle.
        let blob;
        try {
          blob = await readLocalBlob(it.local.path);
        } catch (err) {
          throw new Error(`Could not read ${it.local.name}: ${err?.message || err}`);
        }
        const { data: meta, error: upErr } = await uploadBlobToPending({
          projectId,
          userId,
          blob,
          fileName: it.local.name,
          mimeType: it.local.mimeType,
        });
        if (upErr || !meta) throw upErr || new Error('Upload failed');
        uploadedPendingPaths.push(meta.pendingPath);
        uploadedById.set(it, meta);
      }
      setProgress(null);

      // Build the items list — order preserved from the snapshot.
      // `content_hash` rides on the proposed payload so the approve
      // RPC can write it into project_files.content_hash on merge —
      // future diffs (UI + sync) compare hashes when both sides have
      // them, catching same-size content edits.
      const items = snapshot.map((it) => {
        // Filesystem-sourced add: new bytes that were just uploaded.
        if (it.source === 'fs' && it.kind === 'add') {
          const meta = uploadedById.get(it);
          return {
            kind: 'add',
            target_file_id: null,
            proposed: {
              id: meta.fileId,
              name: meta.name,
              description: null,
              mime_type: meta.mimeType,
              size_bytes: meta.sizeBytes,
              content_hash: meta.contentHash,
              storage_path: meta.canonicalPath,
              pending_storage_path: meta.pendingPath,
            },
          };
        }
        // Filesystem-sourced replace: bytes for an existing file
        // changed. Uploaded to pending; canonical path will be
        // rewritten on approve.
        if (it.source === 'fs' && it.kind === 'replace') {
          const meta = uploadedById.get(it);
          return {
            kind: 'replace',
            target_file_id: it.cloud.id,
            proposed: {
              id: meta.fileId,
              name: meta.name,
              mime_type: meta.mimeType,
              size_bytes: meta.sizeBytes,
              content_hash: meta.contentHash,
              storage_path: meta.canonicalPath,
              pending_storage_path: meta.pendingPath,
            },
          };
        }
        // Filesystem-sourced delete: file is missing locally; the
        // approve RPC will drop the project_files row.
        if (it.source === 'fs' && it.kind === 'delete') {
          return {
            kind: 'delete',
            target_file_id: it.cloud.id,
            proposed: null,
          };
        }
        // Modal-sourced (any kind): proposed already carries the
        // patch (name / description / etc). target_file_id is the
        // file the modal targeted. Shape is already what
        // change_request_items wants.
        return {
          kind: it.kind,
          target_file_id: it.target_file_id ?? null,
          proposed: it.proposed ?? null,
        };
      });

      const { data: result, error: reqErr } = await createOrMergeChangeRequest({
        projectId,
        authorId: userId,
        title: trimmedTitle,
        description,
        items,
      });
      if (reqErr) throw reqErr;
      const { request, merged } = result || {};

      // Discard the modal-sourced branch_changes rows we just
      // snapshotted — they're now living inside the request's
      // immutable items, so leaving them in the queue would
      // duplicate the pill on the card and inflate next commit's
      // count. Best-effort: a discard failure leaves stale rows
      // but doesn't compromise the request itself.
      const consumedModalIds = snapshot
        .filter((it) => it.source === 'modal' && it._branchChangeId)
        .map((it) => it._branchChangeId);
      for (const id of consumedModalIds) {
        discardBranchChange(id).catch(() => { /* swallow */ });
      }

      // Refresh the open-request items so the parent's branchDiff
      // recomputes — items we just inserted will filter out matching
      // filesystem diff entries, hiding the Commit button. Without
      // this, the diff would keep showing post-push (the filesystem
      // hasn't changed) until admin approval.
      await refreshOpenRequestItems?.();

      notify?.({
        category: 'file',
        variant: 'success',
        title: merged ? 'Changes merged into open commit' : 'Changes submitted',
        body: merged
          ? `${items.length} item${items.length === 1 ? '' : 's'} added to the existing review.`
          : `${items.length} item${items.length === 1 ? '' : 's'} sent for review.`,
        dedupeKey: `push-success:${request?.id || projectId}`,
      });
      onClose?.();
    } catch (err) {
      setError(err?.message || String(err));
      setProgress(null);
      // Best-effort cleanup of any pending bytes already uploaded —
      // leaving them around would silently rack up storage.
      for (const p of uploadedPendingPaths) {
        deletePendingObject(p).catch(() => { /* swallow */ });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleBackdropMouseDown = (e) => {
    if (e.target !== e.currentTarget) return;
    if (submitting) return;
    onClose?.();
  };

  return (
    <div
      className="commit-modal-backdrop"
      onMouseDown={handleBackdropMouseDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="commit-modal-title"
    >
      <div className="commit-modal-card">
        <header className="commit-modal-header">
          <h2 id="commit-modal-title" className="commit-modal-title">
            Commit changes
          </h2>
          <Tooltip content="Close">
            <button
              type="button"
              className="commit-modal-close"
              onClick={onClose}
              disabled={submitting}
              aria-label="Close"
            >
              {CloseIcon}
            </button>
          </Tooltip>
        </header>

        <div className="commit-modal-body">
          <p className="commit-modal-intro">
            {snapshot.length === 0
              ? 'No changes to commit — your branch matches main.'
              : (
                <>
                  {counts.add     > 0 && <>{counts.add} added · </>}
                  {counts.edit    > 0 && <>{counts.edit} edited · </>}
                  {counts.replace > 0 && <>{counts.replace} modified · </>}
                  {counts.delete  > 0 && <>{counts.delete} deleted · </>}
                  ready for review.
                </>
              )}
          </p>
          {openOwnRequest && snapshot.length > 0 && (
            <p className="commit-modal-intro" style={{ color: 'var(--text-muted)' }}>
              You already have an open request <strong>"{openOwnRequest.title}"</strong>{' '}
              — these changes will merge into it.
            </p>
          )}

          <ul className="commit-modal-items">
            {snapshot.map((it, i) => {
              // Resolve a display name + size that works for both
              // fs-sourced items (carry `local` / `cloud`) and modal-
              // sourced items (carry `proposed` + a cloud lookup).
              const file = it.local || it.cloud;
              const name = file?.name
                || it.proposed?.name
                || `Item ${i + 1}`;
              const size = it.local?.sizeBytes ?? it.cloud?.size_bytes ?? null;
              return (
                <li key={`${it.source || 'fs'}:${it.kind}:${name}:${i}`} className="commit-modal-item">
                  <span className={`commit-modal-kind is-${KIND_TONE[it.kind] || 'edit'}`}>
                    {KIND_LABEL[it.kind] || it.kind}
                  </span>
                  <span className="commit-modal-item-name" title={name}>{name}</span>
                  {size != null && (
                    <span className="commit-modal-item-size">{formatBytes(size)}</span>
                  )}
                </li>
              );
            })}
          </ul>

          <label className="commit-modal-field">
            <span className="commit-modal-field-label">Title</span>
            <input
              ref={titleRef}
              type="text"
              className="commit-modal-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short summary of these changes"
              maxLength={120}
              disabled={submitting}
            />
          </label>

          <label className="commit-modal-field">
            <span className="commit-modal-field-label">
              Description <span className="commit-modal-field-hint">(optional)</span>
            </span>
            <textarea
              className="commit-modal-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What did you change, and why?"
              rows={3}
              maxLength={2000}
              disabled={submitting}
            />
          </label>

          {progress && (
            <div className="commit-modal-progress" role="status" aria-live="polite">
              Uploading {progress.current}/{progress.total} · {progress.name}
            </div>
          )}

          {error && (
            <div className="commit-modal-error" role="alert">{error}</div>
          )}
        </div>

        <footer className="commit-modal-footer">
          <button
            type="button"
            className="modal-btn modal-btn-cancel"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn modal-btn-confirm"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting
              ? (progress ? `Uploading ${progress.current}/${progress.total}…` : 'Pushing…')
              : (openOwnRequest ? 'Merge into open commit' : 'Push for review')}
          </button>
        </footer>
      </div>
    </div>
  );
}
