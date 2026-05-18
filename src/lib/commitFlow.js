// Shared commit pipeline — extracted from CommitChangesModal so the
// auto-commit effect in ProjectFiles can reuse the exact upload +
// thumbnail + push semantics without driving the modal UI.
//
// Two exported helpers:
//   buildCommitSnapshot — combines the filesystem diff (from
//     computeBranchDiff) with modal-driven branch_changes, filters
//     fs items that are superseded by a queued rename so the same
//     file doesn't appear twice in the request.
//   runCommitFlow      — uploads every fs add/replace's bytes +
//     thumbnails to the pending bucket, builds the items list, and
//     calls createOrMergeChangeRequest. Returns { data, error,
//     uploadedPendingPaths } so callers can surface progress or
//     mop up partial uploads on failure.
//
// Both functions are pure orchestration over existing helpers — no
// React, no UI state, no module-level mutability. The modal owns
// progress UI / title input; the auto-commit owns the timer.

import {
  uploadBlobToPending,
  uploadPendingThumbnail,
  createOrMergeChangeRequest,
  deletePendingObject,
  discardBranchChange,
} from './branches';
import { readLocalBlob } from './localFolder';
import {
  generateThumbnail,
  generateVideoFrames,
  extractVideoDuration,
} from './thumbnails';

// Strip an extension off a name for the rename-supersession check.
// Mirrors the helper used inline in CommitChangesModal.
function stripExt(name) {
  if (!name) return '';
  const lc = name.toLowerCase();
  const dot = lc.lastIndexOf('.');
  return dot > 0 ? lc.slice(0, dot) : lc;
}

// Combine fs diff + modal branch_changes into one ordered snapshot.
// Filters fs items that are already represented by a queued rename
// — without this, a rename + the post-rename filesystem state would
// produce both "edit (rename)" AND "add (new name)" / "delete (old
// name)" items in the same request.
export function buildCommitSnapshot({ fsDiff, pendingChanges }) {
  const renamedNameVariants = new Set();
  const renamedCloudIds = new Set();
  for (const c of pendingChanges || []) {
    if (c.kind === 'edit' && c.target_file_id && c.proposed?.name) {
      const proposedName = (c.proposed.name || '').toLowerCase();
      renamedNameVariants.add(proposedName);
      renamedNameVariants.add(stripExt(proposedName));
      renamedCloudIds.add(c.target_file_id);
    }
  }
  const nameMatchesRename = (name) => {
    const lc = (name || '').toLowerCase();
    return renamedNameVariants.has(lc) || renamedNameVariants.has(stripExt(lc));
  };
  const filteredFsDiff = (fsDiff || []).filter((it) => {
    if (it.kind === 'add' && it.local && nameMatchesRename(it.local.name)) return false;
    if (it.kind === 'delete' && it.cloud
        && renamedCloudIds.has(it.cloud.id)) return false;
    return true;
  });
  const fsItems = filteredFsDiff.map((it) => ({ ...it, source: 'fs' }));
  const modalItems = (pendingChanges || []).map((c) => ({
    source: 'modal',
    kind: c.kind,
    target_file_id: c.target_file_id || null,
    proposed: c.proposed,
    _branchChangeId: c.id,
  }));
  return [...fsItems, ...modalItems];
}

// Push a pre-built snapshot. Uploads bytes + thumbnails for every
// fs add/replace, then creates or merges a change_request whose
// items mirror the snapshot. The modal-driven items pass through
// as metadata-only patches.
//
// Best-effort cleanup: on any failure mid-flight, every pending
// object we already uploaded is removed so the pending bucket
// doesn't accumulate orphans. Pre-existing modal branch_changes
// rows that were successfully folded into the request are
// discarded after the push so they don't double-count on the
// next commit.
export async function runCommitFlow({
  projectId,
  userId,
  snapshot,
  title,
  description = '',
  onProgress,
}) {
  const uploadedPendingPaths = [];
  try {
    const uploadable = (snapshot || []).filter((it) =>
      it.source === 'fs' && (it.kind === 'add' || it.kind === 'replace'),
    );
    const uploadedById = new Map();
    for (let i = 0; i < uploadable.length; i++) {
      const it = uploadable[i];
      onProgress?.({ current: i + 1, total: uploadable.length, name: it.local.name });
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
        fileId: it.fileId,
      });
      if (upErr || !meta) throw upErr || new Error('Upload failed');
      uploadedPendingPaths.push(meta.pendingPath);

      // Thumbnail generation + upload — same shape as the upload
      // pipeline. Best-effort, non-fatal: a failure leaves
      // thumbnail_path null and the card falls back to a glyph.
      const mime = (it.local.mimeType || blob.type || '').toLowerCase();
      const isVideo = mime.startsWith('video/');
      const blobAsFile = (blob instanceof File && blob.type)
        ? blob
        : new File([blob], it.local.name, { type: mime || 'application/octet-stream' });
      let thumbnailPath = null;
      let thumbnailPendingPath = null;
      let thumbnailFrames = null;
      let durationSeconds = null;
      try {
        if (isVideo) {
          const [frames, dur] = await Promise.all([
            generateVideoFrames(blobAsFile),
            extractVideoDuration(blobAsFile),
          ]);
          durationSeconds = Number.isFinite(dur) ? Math.round(dur) : null;
          if (Array.isArray(frames) && frames.length > 0) {
            const framePaths = [];
            const framePendingPaths = [];
            for (let f = 0; f < frames.length; f++) {
              const { data: tMeta, error: tErr } = await uploadPendingThumbnail({
                projectId,
                userId,
                fileId: meta.fileId,
                blob: frames[f],
                suffix: `_${f}`,
              });
              if (tErr || !tMeta) continue;
              uploadedPendingPaths.push(tMeta.pendingPath);
              framePaths.push(tMeta.canonicalPath);
              framePendingPaths.push(tMeta.pendingPath);
            }
            if (framePaths.length > 0) {
              thumbnailFrames = framePaths;
              thumbnailPath = framePaths[0];
              thumbnailPendingPath = framePendingPaths[0];
            }
          }
        } else {
          const tBlob = await generateThumbnail(blobAsFile);
          if (tBlob) {
            const { data: tMeta, error: tErr } = await uploadPendingThumbnail({
              projectId,
              userId,
              fileId: meta.fileId,
              blob: tBlob,
            });
            if (!tErr && tMeta) {
              uploadedPendingPaths.push(tMeta.pendingPath);
              thumbnailPath = tMeta.canonicalPath;
              thumbnailPendingPath = tMeta.pendingPath;
            }
          }
        }
      } catch {
        // Thumbnail upload failed — leave the row without one.
      }
      uploadedById.set(it, {
        ...meta,
        thumbnailPath,
        thumbnailPendingPath,
        thumbnailFrames,
        durationSeconds,
      });
    }

    // Build the thumbnail-related half of `proposed` per item.
    // Keys are OMITTED (not set to null) — the approve RPC's
    // `proposed ? 'thumbnail_frames'` guard treats a present-but-null
    // key as "frames present" and then calls
    // jsonb_array_elements_text(null), which raises a SQL error.
    const buildThumbProposed = (meta) => {
      const t = {};
      if (meta.thumbnailPath) t.thumbnail_path = meta.thumbnailPath;
      if (meta.thumbnailPendingPath) t.thumbnail_pending_path = meta.thumbnailPendingPath;
      if (Array.isArray(meta.thumbnailFrames) && meta.thumbnailFrames.length > 0) {
        t.thumbnail_frames = meta.thumbnailFrames;
      }
      if (typeof meta.durationSeconds === 'number' && Number.isFinite(meta.durationSeconds)) {
        t.duration_seconds = meta.durationSeconds;
      }
      return t;
    };

    const items = (snapshot || []).map((it) => {
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
            ...buildThumbProposed(meta),
          },
        };
      }
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
            ...buildThumbProposed(meta),
          },
        };
      }
      if (it.source === 'fs' && it.kind === 'delete') {
        return {
          kind: 'delete',
          target_file_id: it.cloud.id,
          proposed: null,
        };
      }
      return {
        kind: it.kind,
        target_file_id: it.target_file_id ?? null,
        proposed: it.proposed ?? null,
      };
    });

    const { data: result, error: reqErr } = await createOrMergeChangeRequest({
      projectId,
      authorId: userId,
      title,
      description,
      items,
    });
    if (reqErr) throw reqErr;

    // Discard the modal-sourced branch_changes rows we just
    // snapshotted — they're now living inside the request's
    // immutable items, so leaving them in the queue would
    // duplicate the pill on the card and inflate next commit's
    // count.
    const consumedModalIds = (snapshot || [])
      .filter((it) => it.source === 'modal' && it._branchChangeId)
      .map((it) => it._branchChangeId);
    for (const id of consumedModalIds) {
      discardBranchChange(id).catch(() => { /* swallow */ });
    }

    return { data: result, error: null, uploadedPendingPaths };
  } catch (err) {
    // Mop up any pending bytes we already uploaded so the bucket
    // doesn't accumulate orphans across failed commits.
    for (const p of uploadedPendingPaths) {
      deletePendingObject(p).catch(() => { /* swallow */ });
    }
    return { data: null, error: err, uploadedPendingPaths };
  }
}
