// File identity — what used to be the per-folder `.docvex.json` sidecar.
//
// Every file in a project has a PORTABLE id (a uuid) that other records point
// at (chat attachments, timelines) and that survives rename, move, edit and
// another machine opening the same folder. It used to live in a hidden
// `.docvex.json` in every folder, kept by the renderer with filename + hash
// matching. It now lives in the project's `.docvex/ids.json`, kept by the
// MAIN process (src/projectIndex/README.md): renames are recognised by the
// filesystem's own file id, legacy sidecars are imported (their ids kept —
// Supabase rows reference them) and then deleted. Every listing Row carries
// its `id`, so the renderer rarely has to ask.
//
// What is left here is the lookup both ways, plus the old sidecar API as thin
// stand-ins: nothing reads or writes `.docvex.json` from the renderer any
// more, and a sidecar handed around is always empty.

import { projectIndexApi, hasProjectIndex } from './localFolder';

// The portable id of the file at `path`, or null (no index, not a project file).
export async function fileIdForPath(path) {
  if (!path || !hasProjectIndex()) return null;
  const { id } = await projectIndexApi.fileId({ path });
  return id || null;
}

// Where the file with portable id `id` is now, or null.
export async function pathForFileId(projectId, id) {
  if (!projectId || !id || !hasProjectIndex()) return null;
  const { path } = await projectIndexApi.pathForId({ projectId, id });
  return path || null;
}

// ── The retired sidecar API ───────────────────────────────────────────
// Kept so an old caller still compiles and behaves sensibly: the sidecar is
// always empty and saving it does nothing (main owns identity now).
export const LEGACY_SIDECAR_KEY = (projectId, localFolder) =>
  `docvex:branch-meta:${projectId}:${localFolder}`;

export function emptySidecar(projectId, localFolder) {
  return {
    projectId: projectId || null,
    localFolder: localFolder || null,
    byFileId: new Map(),
    byFilename: new Map(),
  };
}
export function toPayload(sidecar) {
  return { version: 1, projectId: sidecar?.projectId || null, entries: {} };
}
export async function loadSidecar(projectId, localFolder) { return emptySidecar(projectId, localFolder); }
export async function saveSidecar() {}
export function addEntry(sidecar) { return sidecar; }
export function removeEntry(sidecar) { return sidecar; }
export function removeByFilename(sidecar) { return sidecar; }
export function renameEntry(sidecar) { return sidecar; }
export function reconcileWithFilesystem(sidecar) { return { sidecar, changed: false }; }
export function fileIdForFilename(sidecar, filename) {
  if (!filename) return null;
  return sidecar?.byFilename?.get(filename.toLowerCase()) || null;
}
export function entryForFileId(sidecar, fileId) {
  return sidecar?.byFileId?.get(fileId) || null;
}
