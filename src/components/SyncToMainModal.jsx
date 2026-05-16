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
  add:     'Download',
  replace: 'Overwrite',
  delete:  'Delete',
};
const KIND_TONE = {
  add:     'add',
  replace: 'replace',
  delete:  'delete',
};

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Compute the "cloud → local" diff: what would need to happen to
// the local folder to make it match main. Note this is the inverse
// of computeBranchDiff which is "local → cloud" (what the user
// wants to commit). The two flows mirror each other but the
// kind labels mean different things, so we keep them separate.
function computeSyncDiff(cloudFiles, localFiles, localHashByName, cloudHashByFileId) {
  const localByName = new Map();
  for (const l of localFiles || []) {
    if (l?.name) localByName.set(l.name.toLowerCase(), l);
  }
  const cloudByFilename = new Map();
  for (const c of cloudFiles || []) {
    const filename = (c.storage_path || '').split('/').pop();
    if (filename) cloudByFilename.set(filename.toLowerCase(), c);
  }
  const items = [];
  for (const cloud of cloudFiles || []) {
    const filename = (cloud.storage_path || '').split('/').pop();
    if (!filename) continue;
    const key = filename.toLowerCase();
    const local = localByName.get(key);
    if (!local) {
      items.push({ kind: 'add', cloud });
      continue;
    }
    const lh = localHashByName?.get(key);
    const ch = cloud.content_hash || cloudHashByFileId?.get(cloud.id);
    let differs;
    if (lh && ch) differs = lh !== ch;
    else differs = Number(cloud.size_bytes) !== Number(local.sizeBytes);
    if (differs) items.push({ kind: 'replace', cloud, local });
  }
  for (const local of localFiles || []) {
    if (!cloudByFilename.has(local.name.toLowerCase())) {
      items.push({ kind: 'delete', local });
    }
  }
  return items;
}

export default function SyncToMainModal({
  open,
  onClose,
  localFiles,
  cloudFiles,
  localFolder,
  localHashByName,
  cloudHashByFileId,
  onLocalListChanged,
  onSyncComplete,
}) {
  const { acknowledgeSync, mainVersion, discardAll, pendingChanges } = useBranch();
  const { notify } = useNotifications();
  useSelectedProject();

  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(null);  // { current, total, name, kind }
  const [error, setError] = useState(null);
  const [snapshot, setSnapshot] = useState([]);

  useEffect(() => {
    if (open) {
      setSnapshot(computeSyncDiff(cloudFiles, localFiles, localHashByName, cloudHashByFileId));
      setError(null);
      setProgress(null);
      setSubmitting(false);
    }
  }, [open, cloudFiles, localFiles, localHashByName, cloudHashByFileId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !submitting) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  const counts = useMemo(() => {
    const c = { add: 0, replace: 0, delete: 0 };
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
            return { url: data.signedUrl, filename };
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
      const syncedHashes = new Map();
      for (const it of snapshot) {
        if (it.kind !== 'add' && it.kind !== 'replace') continue;
        const filename = (it.cloud?.storage_path || '').split('/').pop();
        const hash = it.cloud?.content_hash;
        if (filename && hash) syncedHashes.set(filename.toLowerCase(), hash);
      }
      const deletedNames = new Set(
        snapshot
          .filter((it) => it.kind === 'delete' && it.local?.name)
          .map((it) => it.local.name.toLowerCase()),
      );
      onSyncComplete?.({ syncedHashes, deletedNames });

      onLocalListChanged?.();
      notify?.({
        category: 'file',
        variant: 'success',
        icon: 'check',
        title: 'Reverted to main',
        body: `Branch matches main (v${mainVersion}).`,
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
            Revert to main branch
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
              ? 'Your branch already matches main — nothing to revert.'
              : (
                <>
                  {counts.add     > 0 && <>{counts.add} to download · </>}
                  {counts.replace > 0 && <>{counts.replace} to overwrite · </>}
                  {counts.delete  > 0 && <>{counts.delete} to delete · </>}
                  {(pendingChanges || []).length > 0 && (
                    <>{(pendingChanges || []).length} queued change{(pendingChanges || []).length === 1 ? '' : 's'} discarded · </>
                  )}
                  applied to your folder.
                </>
              )}
          </p>

          {counts.delete > 0 && (
            <div className="commit-modal-error" role="alert" style={{ color: 'var(--text-secondary)', background: 'color-mix(in srgb, var(--accent) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)' }}>
              Files only present locally will be deleted. If any are work
              you haven't pushed yet, cancel and push first.
            </div>
          )}

          <ul className="commit-modal-items">
            {snapshot.map((it, i) => {
              const file = it.cloud || it.local;
              const name = file?.name || `Item ${i + 1}`;
              const size = it.kind === 'delete' ? it.local?.sizeBytes : it.cloud?.size_bytes;
              return (
                <li key={`${it.kind}:${name}:${i}`} className="commit-modal-item">
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

          {progress && (
            <div className="commit-modal-progress" role="status" aria-live="polite">
              {progress.kind === 'delete' ? 'Deleting…' : 'Downloading…'}
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
              ? 'Reverting…'
              : (snapshot.length === 0 && (pendingChanges || []).length === 0
                  ? 'Mark as synced'
                  : 'Revert to main')}
          </button>
        </footer>
      </div>
    </div>
  );
}
