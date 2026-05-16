import React, { useEffect, useState } from 'react';
import { useBranch } from '../context/BranchContext';
import { useNotifications } from '../context/NotificationsContext';
import { localFolderApi } from '../lib/localFolder';
import { deletePendingObject } from '../lib/branches';
import Tooltip from './Tooltip';
import './ConfirmModal.css';
import './CommitChangesModal.css';

// "Reset branch" — the user's "throw it all away and start over"
// affordance. Unlike Sync to main (which downloads cloud files to
// make local match main), Reset *only* deletes the local folder's
// contents. After it runs:
//   • Local folder is empty.
//   • computeBranchDiff treats an empty local folder as no-diff, so
//     the Commit changes button hides automatically.
//   • acknowledgeSync bumps branch.base_version to current
//     main_version, so the "behind main" dot also clears.
//
// The user can then click Download / individual missing-from-branch
// cards to repopulate with main's content, or start dropping new
// files in for a fresh branch of work.

const CloseIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ResetBranchModal({
  open,
  onClose,
  localFiles,
  localFolder,
  onLocalListChanged,
}) {
  const { acknowledgeSync, discardAll, pendingChanges } = useBranch();
  const { notify } = useNotifications();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !submitting) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const totalSize = localFiles.reduce((sum, f) => sum + (f.sizeBytes || 0), 0);
  const canSubmit = !submitting && localFolder;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      if (localFiles.length > 0) {
        const paths = localFiles.map((f) => f.path).filter(Boolean);
        const { results, error: delErr } = await localFolderApi.deleteFiles({
          dir: localFolder,
          paths,
        });
        if (delErr) throw new Error(delErr);
        const failed = (results || []).filter((r) => !r.ok);
        if (failed.length > 0) {
          throw new Error(`${failed.length} file${failed.length === 1 ? '' : 's'} could not be deleted: ${failed[0].error || ''}`);
        }
      }

      // Drop every queued branch_change for this project — without
      // this, modal-driven edits / deletes still show as pending
      // after reset and the Commit changes button stays lit. The
      // returned rows give us the chance to clean up any pending
      // bucket objects they referenced (current modal flows don't
      // create those, but the path is wired for future add/replace
      // intercepts).
      const { data: dropped } = await discardAll();
      if (Array.isArray(dropped)) {
        for (const c of dropped) {
          const p = c?.proposed?.pending_storage_path;
          if (p) deletePendingObject(p).catch(() => { /* swallow */ });
        }
      }

      // Bump base_version so the "behind main" dot clears too — the
      // user is starting fresh, no in-flight work to reconcile.
      await acknowledgeSync();
      onLocalListChanged?.();

      const fileMsg = localFiles.length === 0
        ? 'Branch was already empty.'
        : `Deleted ${localFiles.length} file${localFiles.length === 1 ? '' : 's'} from your branch folder.`;
      const queueMsg = pendingChanges.length > 0
        ? ` Cleared ${pendingChanges.length} queued change${pendingChanges.length === 1 ? '' : 's'}.`
        : '';
      notify?.({
        category: 'file',
        variant: 'success',
        icon: 'trash',
        title: 'Branch reset',
        body: fileMsg + queueMsg,
        dedupeKey: `reset-success:${Date.now()}`,
      });
      onClose?.();
    } catch (err) {
      setError(err?.message || String(err));
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
      aria-labelledby="reset-modal-title"
    >
      <div className="commit-modal-card">
        <header className="commit-modal-header">
          <h2 id="reset-modal-title" className="commit-modal-title">
            Reset branch
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
            {localFiles.length === 0 && pendingChanges.length === 0
              ? 'Branch is already clean — nothing to reset.'
              : (
                <>
                  {localFiles.length > 0 && (
                    <>
                      Delete <strong>{localFiles.length}</strong> file{localFiles.length === 1 ? '' : 's'}
                      {' '}({formatBytes(totalSize)}) from your branch folder
                    </>
                  )}
                  {localFiles.length > 0 && pendingChanges.length > 0 && ' + '}
                  {pendingChanges.length > 0 && (
                    <>
                      drop <strong>{pendingChanges.length}</strong> queued change{pendingChanges.length === 1 ? '' : 's'}
                    </>
                  )}
                  . Cloud files on main are untouched; you can re-download them after.
                </>
              )}
          </p>

          {localFiles.length > 0 && (
            <ul className="commit-modal-items">
              {localFiles.map((f) => (
                <li key={f.path} className="commit-modal-item">
                  <span className="commit-modal-kind is-delete">Delete</span>
                  <span className="commit-modal-item-name" title={f.name}>{f.name}</span>
                  <span className="commit-modal-item-size">{formatBytes(f.sizeBytes)}</span>
                </li>
              ))}
            </ul>
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
            className="modal-btn modal-btn-destructive"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? 'Resetting…' : 'Reset branch'}
          </button>
        </footer>
      </div>
    </div>
  );
}
