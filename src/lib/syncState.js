// Unified sync-state computer for the local branch flow.
//
// Replaces three independent matching pipelines that had drifted
// apart over time:
//   • computeBranchDiff      (lib/branches.js)         — "local → cloud" diff
//   • computeSyncDiff        (components/SyncToMainModal.jsx) — "cloud → local" diff
//   • reconcileWithFilesystem (lib/localBranchMeta.js) — sidecar reconcile
//
// All three rebuilt the same fundamental view of the world (which
// local file IS which cloud file, what differs, what's missing) using
// slightly different rules. The result was matched bugs in every
// direction: a rename caught by one pipeline but not another, a
// missing-card overlay showing for a file the diff said was present,
// a "Synced" pill where Sync-to-main found nothing to revert despite
// names visibly differing.
//
// This module is the single source of truth. One pass over the
// inputs produces a unified per-fileId map AND the two derived
// item lists every UI surface consumes:
//
//   • toCommit  — what auto-commit needs to push to a change request
//   • toSync    — what Revert-to-main needs to apply to the folder
//
// Trust hierarchy for matching, in order of authority:
//   1. Sidecar fileId mapping  (authoritative when present)
//   2. Content SHA-256          (for bootstrap + sidecar reconcile)
//   3. Filename                 (last-resort fallback for the bootstrap
//                                window before the sidecar reconciles)
//
// Pure function. No React, no Supabase IO, no module state. The same
// inputs always produce the same output. Caller decides what to do
// with the reconciled sidecar (persist via saveSidecar when changed).

import { reconcileWithFilesystem } from './localBranchMeta';

// Build the unified sync state.
//
// Inputs (all optional except localFiles/cloudFiles/sidecar):
//   localFiles         — array of disk entries
//                        [{ name, path, sizeBytes, mtimeIso, mimeType }]
//   cloudFiles         — array of project_files rows
//                        [{ id, name, storage_path, size_bytes,
//                           content_hash, mime_type, ... }]
//   sidecar            — current in-memory sidecar (see localBranchMeta)
//   pendingChanges     — caller's queued branch_changes rows
//   openRequestItems   — caller's open change_request_items
//                        (typically merged with the post-approval
//                        soft-hold by the caller)
//   localHashByName    — Map<lc-filename, sha256-hex>
//   cloudHashByFileId  — Map<cloud.id, sha256-hex> (legacy backfill)
//
// Output shape:
//   {
//     sidecar,             // next sidecar (caller persists if changed)
//     sidecarChanged,
//     rows,                // Map<fileId, Row> — unified per-file view
//     toCommit,            // Item[] — what auto-commit should push
//     toSync,              // Item[] — what Revert-to-main should apply
//     summary,             // { hasLocalChanges, inSync, missingCount, ... }
//     openRequestDeleteIds // Set<fileId> — cloud rows queued for delete
//   }
//
// Row shape per fileId:
//   {
//     fileId,
//     sidecarEntry,    // { filename, contentHash, mtime } | null
//     local,           // disk file | null
//     cloud,           // project_files row | null
//     localHash,
//     cloudHash,
//     status,          // 'synced' | 'local-only' | 'replace' | 'rename'
//                      // | 'missing-local' | 'orphan'
//     bytesDiffer,
//     nameDiffers,
//   }
//
// toCommit / toSync Item shapes match what the existing commitFlow +
// SyncToMainModal already expect, so callers can pass them straight
// through without translation.
export function computeSyncState({
  localFiles = [],
  cloudFiles = [],
  sidecar,
  pendingChanges = [],
  openRequestItems = [],
  localHashByName,
  cloudHashByFileId,
} = {}) {
  // 1. Sidecar reconciliation. Anything observed on disk gets mapped
  //    to a fileId (carrying over from rename or bootstrap from
  //    cloud hash, otherwise minted). Stale entries (sidecar has
  //    them, disk doesn't) are pruned. In-place byte edits refresh
  //    the stored hash so downstream byte-compare is accurate.
  //
  //    Empty-folder gate: a freshly-picked but empty folder
  //    legitimately has no localFiles yet. The reconcile pass would
  //    interpret that as "every previously-tracked file was deleted"
  //    and wipe the sidecar — destroying the mapping the user will
  //    need the moment the file watcher catches up. Skip reconcile
  //    while the folder listing hasn't materialised yet; the next
  //    tick (with a populated localFiles) does the right thing.
  let nextSidecar = sidecar;
  let sidecarChanged = false;
  if (sidecar && (localFiles.length > 0 || sidecar.byFileId.size === 0)) {
    const result = reconcileWithFilesystem(
      sidecar,
      localFiles,
      cloudFiles,
      localHashByName,
      cloudHashByFileId,
    );
    nextSidecar = result.sidecar;
    sidecarChanged = result.changed;
  }

  // 2. Index inputs for O(1) lookups in the row walk below.
  const localByName = new Map();
  for (const f of localFiles) {
    if (f?.name) localByName.set(f.name.toLowerCase(), f);
  }
  const cloudById = new Map();
  for (const c of cloudFiles) {
    if (c?.id) cloudById.set(c.id, c);
  }

  // 3. Build "covered" sets from in-flight changes — anything already
  //    queued (pendingChanges) or already pushed but awaiting review
  //    (openRequestItems) is filtered out of toCommit so the same
  //    work doesn't appear twice in the request.
  //
  //    "Covered" isn't binary: a fileId can be covered for a rename
  //    to "foo.txt" but the user just renamed it AGAIN to "bar.txt".
  //    The rename should re-push. Same with replace: covered by a
  //    push of hash X, but the user edited again to hash Y. So we
  //    record the *target state* the covered item describes, and
  //    the toCommit walk re-emits when the current state diverges.
  const coveredFileIds = new Set();
  const coveredRenameTargetByFileId = new Map();
  const coveredContentHashByFileId = new Map();
  const openRequestDeleteIds = new Set();

  const recordCovered = (kind, targetId, proposed) => {
    if (kind === 'edit' && targetId) {
      coveredFileIds.add(targetId);
      if (proposed?.name) {
        coveredRenameTargetByFileId.set(targetId, proposed.name.toLowerCase());
      }
    } else if (kind === 'delete' && targetId) {
      coveredFileIds.add(targetId);
    } else if (kind === 'replace' && targetId) {
      coveredFileIds.add(targetId);
      if (proposed?.content_hash) {
        coveredContentHashByFileId.set(targetId, proposed.content_hash);
      }
    } else if (kind === 'add' && proposed?.id) {
      coveredFileIds.add(proposed.id);
      if (proposed?.content_hash) {
        coveredContentHashByFileId.set(proposed.id, proposed.content_hash);
      }
    }
  };

  for (const c of pendingChanges) recordCovered(c.kind, c.target_file_id, c.proposed);
  for (const it of openRequestItems) {
    recordCovered(it.kind, it.target_file_id, it.proposed);
    if (it.kind === 'delete' && it.target_file_id) {
      openRequestDeleteIds.add(it.target_file_id);
    }
  }

  // 4. Walk every fileId we know about (sidecar ∪ cloud) and build
  //    a unified row. The row carries enough context that every
  //    surface — status pill, per-card modified badge, missing-card
  //    overlay, sync-modal diff — can decide its rendering off ONE
  //    classification.
  const rows = new Map();
  const matchedLocalNames = new Set();    // names claimed by a sidecar mapping
  const fileIdUniverse = new Set();
  for (const id of nextSidecar?.byFileId.keys() || []) fileIdUniverse.add(id);
  for (const id of cloudById.keys()) fileIdUniverse.add(id);

  for (const fileId of fileIdUniverse) {
    const sidecarEntry = nextSidecar?.byFileId.get(fileId) || null;
    const cloud = cloudById.get(fileId) || null;
    const local = sidecarEntry
      ? (localByName.get(sidecarEntry.filename.toLowerCase()) || null)
      : null;
    if (local) matchedLocalNames.add(local.name.toLowerCase());

    const localHash = local
      ? (localHashByName?.get(local.name.toLowerCase()) || null)
      : null;
    const cloudHash = cloud
      ? (cloud.content_hash || cloudHashByFileId?.get(cloud.id) || null)
      : null;

    let status;
    let bytesDiffer = false;
    let nameDiffers = false;
    if (cloud && local) {
      if (localHash && cloudHash) {
        bytesDiffer = localHash !== cloudHash;
      } else {
        bytesDiffer = Number(cloud.size_bytes) !== Number(local.sizeBytes);
      }
      nameDiffers = (cloud.name || '').toLowerCase()
        !== (local.name || '').toLowerCase();
      if (bytesDiffer) status = 'replace';
      else if (nameDiffers) status = 'rename';
      else status = 'synced';
    } else if (cloud && !local) {
      status = 'missing-local';   // cloud row exists, no disk file maps to it
    } else if (!cloud && local) {
      status = 'local-only';      // disk file with locally-minted fileId
    } else {
      status = 'orphan';          // sidecar entry pointing at nothing real
    }

    rows.set(fileId, {
      fileId,
      sidecarEntry,
      local,
      cloud,
      localHash,
      cloudHash,
      status,
      bytesDiffer,
      nameDiffers,
    });
  }

  // 5. Derive toCommit (local → cloud). Auto-commit ships these as
  //    items in a change_request. Mirrors the historic
  //    computeBranchDiff output shape so commitFlow.buildCommitSnapshot
  //    can consume directly.
  const toCommit = [];
  for (const row of rows.values()) {
    if (coveredFileIds.has(row.fileId)) {
      // Already in-flight — but a rename is only "covered" if the
      // proposed name matches what's on disk now. If the user
      // renamed again after pushing, the on-disk name diverges from
      // the in-flight rename and we DO need a fresh edit item.
      if (row.status === 'rename') {
        const covered = coveredRenameTargetByFileId.get(row.fileId);
        if (covered && covered === row.local.name.toLowerCase()) continue;
        if (!covered) continue;     // covered by a non-rename change, skip
      } else {
        continue;
      }
    }
    if (row.status === 'local-only') {
      toCommit.push({ kind: 'add', fileId: row.fileId, local: row.local });
    } else if (row.status === 'replace') {
      toCommit.push({
        kind: 'replace',
        fileId: row.fileId,
        local: row.local,
        cloud: row.cloud,
      });
    } else if (row.status === 'rename') {
      // External rename detected (in-app rename queues a
      // branch_change directly and gets caught by the covered check
      // above). Emit as an edit to the cloud row's name.
      toCommit.push({
        kind: 'edit',
        fileId: row.fileId,
        target_file_id: row.cloud.id,
        local: row.local,
        cloud: row.cloud,
        proposed: { name: row.local.name },
      });
    }
    // 'missing-local' is intentionally NOT auto-committed as a
    // delete. The user didn't express intent to delete — the file
    // might be temporarily gone (mid-Dropbox-sync, network drive
    // glitch, etc.). Explicit deletes flow through the modal /
    // right-click → delete path, which writes a branch_change row
    // directly.
  }

  // 6. Derive toSync (cloud → local). Revert-to-main applies these
  //    to the folder. Inverse of toCommit: pulls main's bytes /
  //    names / deletions into the user's working copy.
  const toSync = [];
  for (const row of rows.values()) {
    if (row.status === 'missing-local') {
      if (openRequestDeleteIds.has(row.fileId)) continue;
      const targetName = row.cloud.name
        || (row.cloud.storage_path || '').split('/').pop()
        || '';
      if (!targetName) continue;
      toSync.push({
        kind: 'add',
        fileId: row.fileId,
        cloud: row.cloud,
        targetName,
      });
    } else if (row.status === 'replace') {
      const targetName = row.cloud.name
        || (row.cloud.storage_path || '').split('/').pop()
        || row.local.name;
      toSync.push({
        kind: 'replace',
        fileId: row.fileId,
        local: row.local,
        cloud: row.cloud,
        targetName,
      });
    } else if (row.status === 'rename') {
      toSync.push({
        kind: 'rename',
        fileId: row.fileId,
        local: row.local,
        cloud: row.cloud,
        targetName: row.cloud.name,
      });
    } else if (row.status === 'local-only') {
      toSync.push({
        kind: 'delete',
        fileId: row.fileId,
        local: row.local,
      });
    }
  }

  // 7. Local files not claimed by any sidecar entry. After reconcile
  //    this should be rare (pass 1c mints a UUID for every unknown
  //    local file with a hash). The window where it can happen is
  //    the brief async hashing gap: a brand-new file lands on disk
  //    but the SHA-256 worker hasn't returned its hex yet, so
  //    reconcile pass 1c skips it (the guard requires a hash to mint
  //    a UUID). Until the hash arrives, the file has no sidecar
  //    entry and no fileId. We surface it as a "local-only" toSync
  //    delete candidate so Revert-to-main still wipes it.
  for (const local of localFiles) {
    if (matchedLocalNames.has(local.name.toLowerCase())) continue;
    // Skip if this filename is the target of an in-flight rename —
    // the file IS the post-rename state of an already-tracked cloud
    // row, just not yet picked up by the sidecar reconcile.
    let skipped = false;
    for (const target of coveredRenameTargetByFileId.values()) {
      if (target === local.name.toLowerCase()) { skipped = true; break; }
    }
    if (skipped) continue;
    toSync.push({
      kind: 'delete',
      fileId: null,
      local,
    });
  }

  // 8. Summary signals for the status pills. `hasLocalChanges` and
  //    `inSync` are the two the chips actually look at; the others
  //    are exposed for completeness so callers can build richer
  //    affordances without recomputing.
  const summary = {
    hasLocalChanges: toCommit.length > 0,
    inSync: toCommit.length === 0,
    missingCount: toSync.filter((it) => it.kind === 'add').length,
    deleteCount: toSync.filter((it) => it.kind === 'delete').length,
    replaceCount: toSync.filter((it) => it.kind === 'replace').length,
    renameCount: toSync.filter((it) => it.kind === 'rename').length,
    rowCount: rows.size,
  };

  return {
    sidecar: nextSidecar,
    sidecarChanged,
    rows,
    toCommit,
    toSync,
    summary,
    openRequestDeleteIds,
  };
}

// Helper for the per-card render: derive the "modified" flag for a
// local file without recomputing the diff. Returns true when the
// file's row classifies as replace or rename (i.e., diverges from
// main and would be picked up by auto-commit).
export function isLocalFileModified(syncState, fileId) {
  const row = syncState?.rows.get(fileId);
  if (!row) return false;
  return row.status === 'replace' || row.status === 'rename';
}

// Helper for the missing-card render: returns true when a cloud row
// has no corresponding local file (regardless of why — never
// downloaded, deleted on disk, or sidecar still bootstrapping).
// openRequestDeleteIds suppresses the overlay for cloud rows queued
// to be deleted.
export function isCloudFileMissing(syncState, cloudId) {
  const row = syncState?.rows.get(cloudId);
  if (!row) return false;
  if (row.status !== 'missing-local') return false;
  if (syncState.openRequestDeleteIds.has(cloudId)) return false;
  return true;
}
