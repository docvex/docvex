import React, { useEffect, useMemo, useState } from 'react';
import { useBranch } from '../context/BranchContext';
import { useNotifications } from '../context/NotificationsContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { createSignedDownloadUrl } from '../lib/projectFiles';
import { localFolderApi } from '../lib/localFolder';
import Tooltip from './Tooltip';
import './ConfirmModal.css';
import './CommitChangesModal.css';

// "Sync to main" — pulls main's current state into the user's local
// branch folder. Shows the diff (cloud → local) before acting so the
// user can see what's about to change, then orchestrates:
//   1. Download any cloud files that are missing locally (add).
//   2. Re-download cloud files whose hash / size differs from local
//      (replace — overwrites the local copy).
//   3. Delete local files that aren't on main anymore (delete).
// On success, bumps the user's branch.base_version to the current
// main_version via acknowledgeSync() — the "behind main" indicator
// clears.
//
// For the "throw away my local edits" flow (different operation —
// pure delete, no re-download) see `ResetBranchModal`.

const CloseIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const KIND_LABEL = {
  add:     'Will be added',
  replace: 'Will replace yours',
  rename:  'Will be renamed',
  delete:  'Will be deleted',
};
const KIND_TONE = {
  add:     'add',
  replace: 'replace',
  rename:  'replace',
  delete:  'delete',
};

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Snapshot is now computed upstream by computeSyncState (src/lib/
// syncState.js) and passed in via the `snapshot` prop. The old
// local computeSyncDiff is gone — every surface (this modal, the
// status pills, the per-card "modified" badge) reads the same diff
// from one source so they can't drift.

export default function SyncToMainModal({
  open,
  onClose,
  snapshot: snapshotProp = [],
  localFolder,
  onLocalListChanged,
  onSyncComplete,
}) {
  const { acknowledgeSync, mainVersion, discardAll, pendingChanges } = useBranch();
  const { notify } = useNotifications();
  useSelectedProject();

  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(null);  // { current, total, name, kind }
  const [error, setError] = useState(null);
  // Freeze the snapshot at open time so a parent-driven diff update
  // (a watcher tick during the user's "are you sure?" pause) doesn't
  // change the row list out from under them mid-confirm.
  const [snapshot, setSnapshot] = useState([]);

  useEffect(() => {
    if (open) {
      setSnapshot(Array.isArray(snapshotProp) ? snapshotProp : []);
      setError(null);
      setProgress(null);
      setSubmitting(false);
    }
  }, [open, snapshotProp]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !submitting) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  const counts = useMemo(() => {
    const c = { add: 0, replace: 0, delete: 0, rename: 0 };
    for (const it of snapshot) c[it.kind] = (c[it.kind] || 0) + 1;
    return c;
  }, [snapshot]);

  if (!open) return null;

  const canSubmit = !submitting && localFolder;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // 1+2. Batch the downloads (add + replace go through the same
      // download IPC; replace just overwrites whatever's at the
      // target path).
      const downloadable = snapshot.filter((it) => it.kind === 'add' || it.kind === 'replace');
      if (downloadable.length > 0) {
        const signed = await Promise.all(
          downloadable.map(async (it) => {
            const { data, error: signErr } = await createSignedDownloadUrl(it.cloud.storage_path, 600);
            if (signErr || !data?.signedUrl) return null;
            const filename = (it.cloud.storage_path || '').split('/').pop() || it.cloud.name;
            // subdir = the cloud file's folder_path so the download
            // recreates the team's folder structure locally.
            return { url: data.signedUrl, filename, subdir: it.targetFolder || it.cloud.folder_path || '' };
          }),
        );
        const filesPayload = signed.filter(Boolean);
        setProgress({ current: 1, total: filesPayload.length, kind: 'download' });
        const { results, error: dlErr } = await localFolderApi.download({
          dir: localFolder,
          files: filesPayload,
        });
        if (dlErr) throw new Error(dlErr);
        const failed = results?.filter((r) => !r.ok) || [];
        if (failed.length > 0) {
          throw new Error(`${failed.length} download${failed.length === 1 ? '' : 's'} failed: ${failed[0].error || ''}`);
        }
      }

      // 3. Delete locally-only files. Skipped on web when there are
      // no deletes — avoids the IPC round-trip.
      const deletables = snapshot.filter((it) => it.kind === 'delete');
      if (deletables.length > 0) {
        setProgress({ current: 1, total: deletables.length, kind: 'delete' });
        const paths = deletables.map((it) => it.local.path).filter(Boolean);
        const { results, error: delErr } = await localFolderApi.deleteFiles({
          dir: localFolder,
          paths,
        });
        if (delErr) throw new Error(delErr);
        const failed = results?.filter((r) => !r.ok) || [];
        if (failed.length > 0) {
          throw new Error(`${failed.length} delete${failed.length === 1 ? '' : 's'} failed: ${failed[0].error || ''}`);
        }
      }

      // 3a. Rename locally — same bytes, wrong filename. Reverting
      // here means matching main's canonical name. Done one-by-one
      // (no batch rename IPC); typically just a few items.
      const renames = snapshot.filter((it) => it.kind === 'rename');
      for (let i = 0; i < renames.length; i++) {
        const it = renames[i];
        setProgress({ current: i + 1, total: renames.length, kind: 'rename', name: it.targetName });
        const { error: renErr } = await localFolderApi.renameFile({
          dir: localFolder,
          fromName: it.local.name,
          toName: it.targetName,
        });
        // Non-fatal per-file: a rename collision with an unrelated
        // file just leaves that one out of sync. Surface as soft
        // error and continue so the rest of the revert can land.
        if (renErr) {
          throw new Error(`Rename failed for ${it.local.name} → ${it.targetName}: ${renErr}`);
        }
      }

      // 3b. Discard every queued branch_change too — "Revert to main"
      // wipes ALL local divergence, including unpushed metadata edits.
      // Best-effort: a failure here doesn't unwind the byte sync. The
      // realtime DELETE echoes will reconcile the UI either way.
      if ((pendingChanges || []).length > 0) {
        await discardAll();
      }

      // 4. Bump the cursor. The component refreshes its local list
      // via the parent's `onLocalListChanged` so the new state shows
      // immediately.
      await acknowledgeSync();

      // Prime the parent's hash map with the known-good cloud hashes
      // for everything we just downloaded/overwrote, and drop entries
      // for files we deleted. Without this the "Modified" badge keeps
      // showing post-sync until the parent's background re-hash effect
      // catches up — which can take seconds on big files. With this,
      // the badge clears in the same render as the modal closes.
      //
      // syncedFileIds maps the on-disk filename to the cloud row's
      // id. Parent uses it to populate the per-folder sidecar so
      // post-sync matching skips the hash-bootstrap window.
      const syncedHashes = new Map();
      const syncedFileIds = new Map();
      for (const it of snapshot) {
        if (it.kind !== 'add' && it.kind !== 'replace') continue;
        const filename = (it.cloud?.storage_path || '').split('/').pop();
        if (!filename) continue;
        const lcName = filename.toLowerCase();
        const hash = it.cloud?.content_hash;
        if (hash) syncedHashes.set(lcName, hash);
        if (it.cloud?.id) syncedFileIds.set(filename, it.cloud.id);
      }
      const deletedNames = new Set(
        snapshot
          .filter((it) => it.kind === 'delete' && it.local?.name)
          .map((it) => it.local.name.toLowerCase()),
      );
      onSyncComplete?.({ syncedHashes, deletedNames, syncedFileIds });

      onLocalListChanged?.();
      notify?.({
        category: 'file',
        variant: 'success',
        icon: 'check',
        title: 'Folder matches the cloud',
        body: `Your folder is now up to date.`,
        dedupeKey: `sync-success:${mainVersion}`,
      });
      onClose?.();
    } catch (err) {
      setError(err?.message || String(err));
      setProgress(null);
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
      aria-labelledby="sync-modal-title"
    >
      <div className="commit-modal-card">
        <header className="commit-modal-header">
          <h2 id="sync-modal-title" className="commit-modal-title">
            Use the cloud version
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
            {snapshot.length === 0 && (pendingChanges || []).length === 0
              ? 'Your folder already matches the cloud — nothing to change.'
              : (
                <>
                  This will change your folder to match the cloud:
                  {' '}
                  {counts.add     > 0 && <>{counts.add} new file{counts.add === 1 ? '' : 's'} added · </>}
                  {counts.replace > 0 && <>{counts.replace} file{counts.replace === 1 ? '' : 's'} replaced · </>}
                  {counts.rename  > 0 && <>{counts.rename} renamed · </>}
                  {counts.delete  > 0 && <>{counts.delete} file{counts.delete === 1 ? '' : 's'} deleted · </>}
                  {(pendingChanges || []).length > 0 && (
                    <>{(pendingChanges || []).length} of your unsent edits discarded · </>
                  )}
                </>
              )}
          </p>

          {counts.delete > 0 && (
            <div className="commit-modal-error" role="alert" style={{ color: 'var(--text-secondary)', background: 'color-mix(in srgb, var(--accent) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)' }}>
              Files you've added locally but not yet sent for review will be
              deleted. If you want to keep them, cancel and let the cloud sync
              your edits first.
            </div>
          )}

          <ul className="commit-modal-items">
            {snapshot.map((it, i) => {
              const file = it.cloud || it.local;
              const name = it.kind === 'rename'
                ? `${it.local?.name || ''} → ${it.targetName || ''}`
                : (file?.name || `Item ${i + 1}`);
              const size = it.kind === 'delete' ? it.local?.sizeBytes : it.cloud?.size_bytes;
              return (
                <li key={`${it.kind}:${name}:${i}`} className="commit-modal-item">
                  <span className={`commit-modal-kind is-${KIND_TONE[it.kind] || 'edit'}`}>
                    {KIND_LABEL[it.kind] || it.kind}
                  </span>
                  <span className="commit-modal-item-name" title={name}>{name}</span>
                  {size != null && it.kind !== 'rename' && (
                    <span className="commit-modal-item-size">{formatBytes(size)}</span>
                  )}
                </li>
              );
            })}
          </ul>

          {progress && (
            <div className="commit-modal-progress" role="status" aria-live="polite">
              {progress.kind === 'delete'
                ? 'Removing files…'
                : progress.kind === 'rename'
                  ? `Renaming ${progress.name || ''}…`
                  : 'Downloading from the cloud…'}
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
              ? 'Working…'
              : (snapshot.length === 0 && (pendingChanges || []).length === 0
                  ? 'OK, all good'
                  : 'Use cloud version')}
          </button>
        </footer>
      </div>
    </div>
  );
}
