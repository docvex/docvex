// Per-(project, local folder) sidecar that maps every file on disk to
// a stable unique ID. This is the source of truth for "which local
// file IS which cloud file" — once a file gets an ID, all matching
// across rename / replace / sync flows is by ID, not by filename.
//
// Why: the previous matching system stacked filename / display-name /
// content-hash fallbacks. Each fallback was independently fragile
// (a rename broke filename match; the display-name index missed the
// post-approval split between cloud.name and storage_path filename;
// hash-only match couldn't disambiguate two identical-bytes files).
// Stable IDs collapse all those cases into one.
//
// ID assignment:
//   • Downloaded from main (sync)      → fileId = project_files.id
//   • Added locally via the FAB        → fileId = fresh crypto.randomUUID()
//   • Already on disk, unknown to app  → bootstrap: hash-match to
//                                        a cloud file OR mint fresh
//
// At commit time the locally-minted UUID is threaded through
// uploadBlobToPending so proposed.id matches the sidecar — after the
// admin approves, project_files.id == the sidecar's id, no re-link
// needed.
//
// Storage: `.docvex.json` sitting in the picked folder itself. Lives
// with the files, so the mapping survives a localStorage clear, ships
// to teammates via Dropbox/iCloud, and re-attaches without any
// bootstrap window when the user re-picks the folder. The old
// localStorage key (docvex:branch-meta:*) is migrated forward in
// ProjectFiles.jsx the first time a folder loads without a sidecar.

import { localFolderApi } from './localFolder';

const SIDECAR_VERSION = 1;

// Legacy localStorage key. Kept so the one-time migration in
// ProjectFiles.jsx can read the old mapping and port it into the
// in-folder JSON, then delete the localStorage entry.
export const LEGACY_SIDECAR_KEY = (projectId, localFolder) =>
  `docvex:branch-meta:${projectId}:${localFolder}`;

// In-memory shape — Maps for O(1) lookup in both directions. The
// `byFilename` index is lower-cased so Windows-style case-insensitive
// matching works (`Photo.JPG` and `photo.jpg` resolve to the same row).
export function emptySidecar(projectId, localFolder) {
  return {
    projectId: projectId || null,
    localFolder: localFolder || null,
    byFileId: new Map(),    // fileId → { filename, contentHash, mtime }
    byFilename: new Map(),  // lowercase filename → fileId
  };
}

// Hydrate an in-memory sidecar from a parsed `.docvex.json` payload.
// Defensive: an empty / wrong-version / cross-project payload yields
// an empty sidecar so a corrupt file can't poison matching.
function fromPayload(projectId, localFolder, parsed) {
  const empty = emptySidecar(projectId, localFolder);
  if (!parsed || parsed.version !== SIDECAR_VERSION) return empty;
  if (parsed.projectId && parsed.projectId !== projectId) return empty;
  const entries = parsed.entries || {};
  for (const [fileId, entry] of Object.entries(entries)) {
    if (!entry?.filename) continue;
    empty.byFileId.set(fileId, {
      filename: entry.filename,
      contentHash: entry.contentHash || null,
      mtime: entry.mtime || null,
    });
    empty.byFilename.set(entry.filename.toLowerCase(), fileId);
  }
  return empty;
}

// Serialize an in-memory sidecar to the JSON payload written to
// `.docvex.json`. Kept separate from saveSidecar so the migration
// path in ProjectFiles.jsx can build a payload from a legacy
// localStorage entry and reuse the same shape.
export function toPayload(sidecar) {
  const payload = {
    version: SIDECAR_VERSION,
    projectId: sidecar.projectId,
    entries: {},
  };
  for (const [fileId, entry] of sidecar.byFileId) {
    payload.entries[fileId] = entry;
  }
  return payload;
}

// Async: read `.docvex.json` from the picked folder and hydrate.
// Returns an empty sidecar when the folder has no sidecar yet (first
// pick, or a fresh folder). Wrong-project entries are treated as
// empty too — defensive against a user pointing two projects at the
// same folder.
export async function loadSidecar(projectId, localFolder) {
  const empty = emptySidecar(projectId, localFolder);
  if (!projectId || !localFolder) return empty;
  const { json, error } = await localFolderApi.readSidecar(localFolder);
  if (error || !json) return empty;
  return fromPayload(projectId, localFolder, json);
}

// Async: write the sidecar to `.docvex.json` in the picked folder.
// Fire-and-forget at call sites (we don't gate the next render on
// the FS write completing). Failures are swallowed — the in-memory
// sidecar is still correct for the session; next save retries.
export async function saveSidecar(sidecar) {
  if (!sidecar?.projectId || !sidecar?.localFolder) return;
  const payload = toPayload(sidecar);
  await localFolderApi.writeSidecar({ dir: sidecar.localFolder, json: payload });
}

function clone(sc) {
  return {
    projectId: sc.projectId,
    localFolder: sc.localFolder,
    byFileId: new Map(sc.byFileId),
    byFilename: new Map(sc.byFilename),
  };
}

// Insert or update an entry. Self-heals collisions:
//   • If a DIFFERENT fileId already claims this filename, that row
//     is dropped (the more recent operation wins — typically a
//     download arriving for a file the user had previously had with
//     a locally-minted UUID).
//   • If this fileId previously had a different filename, the old
//     filename's reverse-index entry is cleared so a stale lookup
//     can't resurrect it.
// Returns a NEW sidecar (immutable update pattern keeps React state
// updates safe).
export function addEntry(sidecar, fileId, entry) {
  if (!fileId || !entry?.filename) return sidecar;
  const next = clone(sidecar);
  const lcFilename = entry.filename.toLowerCase();
  const existingFileId = next.byFilename.get(lcFilename);
  if (existingFileId && existingFileId !== fileId) {
    next.byFileId.delete(existingFileId);
  }
  const existingEntry = next.byFileId.get(fileId);
  if (existingEntry && existingEntry.filename.toLowerCase() !== lcFilename) {
    next.byFilename.delete(existingEntry.filename.toLowerCase());
  }
  next.byFileId.set(fileId, {
    filename: entry.filename,
    contentHash: entry.contentHash || null,
    mtime: entry.mtime || null,
  });
  next.byFilename.set(lcFilename, fileId);
  return next;
}

export function removeEntry(sidecar, fileId) {
  const entry = sidecar.byFileId.get(fileId);
  if (!entry) return sidecar;
  const next = clone(sidecar);
  next.byFileId.delete(fileId);
  next.byFilename.delete(entry.filename.toLowerCase());
  return next;
}

// Remove an entry by its current filename. Used by the FAB delete /
// disk-watch delete paths where the caller has the filename but not
// the fileId handy.
export function removeByFilename(sidecar, filename) {
  if (!filename) return sidecar;
  const fileId = sidecar.byFilename.get(filename.toLowerCase());
  if (!fileId) return sidecar;
  return removeEntry(sidecar, fileId);
}

// Update an entry's filename in place — used by the FileDetailModal
// rename path so the same fileId carries through the rename. The
// caller has the OLD filename and the NEW filename; both indices
// get rewritten atomically.
export function renameEntry(sidecar, oldFilename, newFilename) {
  if (!oldFilename || !newFilename) return sidecar;
  const fileId = sidecar.byFilename.get(oldFilename.toLowerCase());
  if (!fileId) return sidecar;
  const entry = sidecar.byFileId.get(fileId);
  if (!entry) return sidecar;
  return addEntry(sidecar, fileId, {
    filename: newFilename,
    contentHash: entry.contentHash,
    mtime: entry.mtime,
  });
}

// Reconcile sidecar against current disk state. Three passes:
//   1. Walk local files. For each one without a sidecar entry,
//      attempt rename detection (an existing entry's hash matches
//      this file's hash AND the entry's filename is no longer on
//      disk → it was renamed; carry the fileId over). If not a
//      rename, try cloud bootstrap (entry's hash matches a cloud
//      row's content_hash → use the cloud's id). If neither, mint
//      a fresh UUID for a brand-new local-only file.
//   2. Walk sidecar entries. Anything whose filename is missing
//      from disk AND wasn't claimed as a rename source → prune
//      (stale; the file was deleted or moved out of the folder).
//   3. Walk sidecar entries again. If the entry's stored hash
//      differs from the current local hash for the same filename,
//      refresh — catches in-place byte edits done via the OS.
// Returns { sidecar, changed }. `changed` lets the caller skip a
// file write when nothing moved.
export function reconcileWithFilesystem(
  sidecar,
  localFiles,
  cloudFiles,
  localHashByName,
  cloudHashByFileId,
) {
  let next = sidecar;
  let changed = false;

  const localByName = new Map();
  for (const f of localFiles || []) {
    if (f?.name) localByName.set(f.name.toLowerCase(), f);
  }

  // Cloud-hash index for the bootstrap path. Includes both the
  // stored content_hash column and the renderer's lazily-populated
  // backfill cache (legacy rows uploaded before migration 014 store
  // null on the column).
  const cloudByHash = new Map();
  for (const c of cloudFiles || []) {
    const h = c.content_hash || cloudHashByFileId?.get(c.id);
    if (h && !cloudByHash.has(h)) cloudByHash.set(h, c);
  }

  // PASS 1 — locals without a sidecar entry.
  for (const local of localFiles || []) {
    const lcName = local.name.toLowerCase();
    if (next.byFilename.has(lcName)) continue;
    const localHash = localHashByName?.get(lcName);

    if (localHash) {
      // 1a. Rename detection — an existing sidecar entry's hash
      //     matches AND its old filename is no longer on disk.
      let renamedFromFileId = null;
      for (const [fid, entry] of next.byFileId) {
        if (!entry.contentHash || entry.contentHash !== localHash) continue;
        if (!localByName.has(entry.filename.toLowerCase())) {
          renamedFromFileId = fid;
          break;
        }
      }
      if (renamedFromFileId) {
        next = addEntry(next, renamedFromFileId, {
          filename: local.name,
          contentHash: localHash,
          mtime: local.mtimeIso || null,
        });
        changed = true;
        continue;
      }

      // 1b. Cloud bootstrap by HASH — local file's hash matches a
      //     cloud row. Adopt that row's id so a future push routes
      //     as REPLACE against the same cloud file (not a duplicate
      //     ADD). Guard: don't re-link a cloud id that another
      //     local file already claims (duplicate-hash collision).
      //     Covers the "first-time pick an existing folder that
      //     already has cloud-matching files" path — once the
      //     sidecar is persisted in-folder, future picks short-
      //     circuit through the file-backed loadSidecar and never
      //     reach this bootstrap branch.
      const cloudHashMatch = cloudByHash.get(localHash);
      if (cloudHashMatch && !next.byFileId.has(cloudHashMatch.id)) {
        next = addEntry(next, cloudHashMatch.id, {
          filename: local.name,
          contentHash: localHash,
          mtime: local.mtimeIso || null,
        });
        changed = true;
        continue;
      }
    }

    // 1c. Brand-new local-only file. Mint a fresh UUID; this same
    //     id rides through uploadBlobToPending on commit so the
    //     approved row's project_files.id matches what the sidecar
    //     already has. Requires a hash so the next pass can detect
    //     renames via content match — without one we defer and
    //     re-bootstrap on the next reconciliation tick.
    if (!localHash) continue;
    const newFileId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    next = addEntry(next, newFileId, {
      filename: local.name,
      contentHash: localHash,
      mtime: local.mtimeIso || null,
    });
    changed = true;
  }

  // PASS 2 — prune stale entries (sidecar has them, disk doesn't,
  // pass 1 didn't reclaim them as a rename).
  for (const [fileId, entry] of Array.from(next.byFileId)) {
    if (!localByName.has(entry.filename.toLowerCase())) {
      next = removeEntry(next, fileId);
      changed = true;
    }
  }

  // PASS 3 — hash refresh for files whose bytes changed in place.
  // Without this an OS-side edit (size unchanged or not) would leave
  // the stale hash in the sidecar; downstream matching against
  // cloud.content_hash would falsely report no diff.
  for (const [fileId, entry] of Array.from(next.byFileId)) {
    const lcName = entry.filename.toLowerCase();
    if (!localByName.has(lcName)) continue;
    const localHash = localHashByName?.get(lcName);
    if (localHash && entry.contentHash !== localHash) {
      const local = localByName.get(lcName);
      next = addEntry(next, fileId, {
        filename: entry.filename,
        contentHash: localHash,
        mtime: local?.mtimeIso || entry.mtime,
      });
      changed = true;
    }
  }

  return { sidecar: next, changed };
}

// Convenience reverse lookups for callers.
export function fileIdForFilename(sidecar, filename) {
  if (!filename) return null;
  return sidecar.byFilename.get(filename.toLowerCase()) || null;
}

export function entryForFileId(sidecar, fileId) {
  return sidecar.byFileId.get(fileId) || null;
}
