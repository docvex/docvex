// The project folder, as the renderer sees it. Desktop only: every call goes
// through `window.electronAPI.localFolder` (preload → main, which does the
// filesystem work — the renderer is sandboxed away from fs by
// contextIsolation). The browser build and its File System Access backend
// (an IndexedDB-persisted directory handle, a 3 s poll standing in for a
// watcher) were removed with the web build; the handful of calls that only
// meant something there are kept as no-ops so their callers need no branch.
//
// Beside it sits the PROJECT INDEX (src/projectIndex/README.md — the
// contract): a project is linked to its folder by a `<name>.docvex` project
// file, its listing comes from a machine-local index at once, and main
// watches the folder and sends only the differences. `projectIndexApi` below
// wraps those calls; `hasProjectIndex()` says whether the main process in
// this build has them yet, and while it does not, everything falls back to
// listing the folder the old way.

import { ipc, rememberProjectDir } from './projectIndexClient';

const electronApi = typeof window !== 'undefined' ? window.electronAPI?.localFolder : null;
const hasElectron = Boolean(electronApi);

// Extension-based MIME inference for files that arrive without metadata.
// A copy of main.js's guessMimeFromName, kept in step by convention. Exported
// so surfaces that only know a filename can build a thumbnail descriptor.
export function guessMimeFromName(name) {
  const i = name.lastIndexOf('.');
  if (i < 0) return '';
  const ext = name.slice(i + 1).toLowerCase();
  if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg';
  if (['png', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) return `image/${ext}`;
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return `video/${ext}`;
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'md') return 'text/markdown';
  if (['txt', 'log', 'json', 'csv', 'xml', 'html', 'css', 'js', 'ts'].includes(ext)) return 'text/plain';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (['doc', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'application/octet-stream';
  return '';
}

export const isElectronBranch = hasElectron;
// Kept for callers that still ask; there is no browser backend any more.
export const isWebBranch = false;
export const hasLocalFolderApi = hasElectron;

// ── Project index (see src/projectIndex/README.md) ─────────────────────
// The index calls, as the contract names them, through the shared client
// (lib/projectIndexClient — `ipc`, which never throws and answers null for a
// call main doesn't have). Main is being moved onto the index while this
// renderer code already calls it, so everything here is feature-detected:
// `hasProjectIndex()` is false on a main process that predates it, and the
// Files tab then lists folders as before. The fallbacks below give each call
// the shape its callers expect when there is no answer.
const bridge = () => (typeof window !== 'undefined' ? window.electronAPI : null);

export function hasProjectIndex() {
  const api = bridge();
  return typeof api?.projectFiles === 'function' && typeof api?.projectOpen === 'function';
}

const noop = () => {};
const answer = async (p, fallback) => {
  try { return (await p) ?? fallback; } catch (err) { return { ...fallback, error: err?.message || String(err) }; }
};

export const projectIndexApi = {
  // { projectId, name?, dir? } → { ok, dir, projectFile, rev } | { ok: false, error }
  open: async (args) => {
    const res = await answer(ipc.projectOpen(args), { ok: false, error: 'unavailable' });
    if (res?.ok && res.dir && args?.projectId) rememberProjectDir(args.projectId, res.dir);
    return res;
  },
  // projectId → { dir, projectFile } | { dir: null }
  locate: (projectId) => answer(ipc.projectLocate(projectId), { dir: null }),
  // { projectId } → { ok, dir, rev, files: Row[], dirs: rel[], reconciling }
  files: (args) => answer(ipc.projectFiles(args), { ok: false, files: [], dirs: [] }),
  reconcile: (args) => answer(ipc.projectReconcile(args), { ok: false }),
  fileId: (args) => answer(ipc.projectFileId(args), { id: null }),
  pathForId: (args) => answer(ipc.projectPathForId(args), { path: null }),
  // project:delta — { projectId, rev, upserted, removed, dirsAdded, dirsRemoved, reconciled? }
  onDelta: (cb) => bridge()?.onProjectDelta?.(cb) || noop,
  // project:opened — { projectId, dir, name } (a .docvex opened from the OS)
  onOpened: (cb) => bridge()?.onProjectOpened?.(cb) || noop,
};

// Where each project's folder is, once found this session — so the many
// callers of projectDir (Doc Viewer, Advisor, timeline…) cost one registry
// lookup, not one per call. A project file opened from the OS moves it.
const linkedDirs = new Map();
if (typeof window !== 'undefined') {
  projectIndexApi.onOpened((p) => { if (p?.projectId && p?.dir) linkedDirs.set(p.projectId, p.dir); });
}
export function forgetLinkedDir(projectId) {
  if (projectId) linkedDirs.delete(projectId); else linkedDirs.clear();
}

// Link a project to a folder: writes (or finds) `<name>.docvex` there and
// registers it on this machine. { ok, dir } | { ok: false, error }.
export async function linkProjectFolder({ projectId, name, dir }) {
  if (!hasProjectIndex() || !projectId || !dir) return { ok: false, error: 'unavailable' };
  const res = await projectIndexApi.open({ projectId, name: name || undefined, dir });
  if (res?.ok) linkedDirs.set(projectId, res.dir || dir);
  return res || { ok: false, error: 'unavailable' };
}

// The folder a project lives in, by its project file. The machine registry
// answers first; a project this machine has never linked is looked up where
// the app used to keep it (main's old per-project registry, which also makes
// a folder for a project that has none yet) and linked there — which is how
// existing projects get their project file on first open. A project the
// registry knows is answered with the folder it knows, gone or not: whether
// it is still there is the Files tab's question (it opens the project and
// asks where the folder went), and a folder that has moved must never be
// quietly replaced by a new, empty one here.
// Where the app kept a project's folder before project files: main's own
// per-project registry, which also makes a folder for a project that has none
// yet. Only the migration path (a project never linked on this machine) asks.
export async function legacyProjectDir({ projectId, name, baseDir }) {
  if (!hasElectron) return { path: null, error: 'Desktop app only' };
  try { return (await electronApi.projectDir(projectId, name, baseDir)) || { path: null }; }
  catch (err) { return { path: null, error: err?.message || String(err) }; }
}

export async function resolveProjectFolder({ projectId, name, baseDir }) {
  if (!projectId) return { path: null, error: 'No project id' };
  if (linkedDirs.has(projectId)) return { path: linkedDirs.get(projectId), error: null };
  const loc = await projectIndexApi.locate(projectId);
  if (loc?.dir) {
    linkedDirs.set(projectId, loc.dir);
    rememberProjectDir(projectId, loc.dir);
    return { path: loc.dir, error: null };
  }
  const legacy = await legacyProjectDir({ projectId, name, baseDir });
  if (!legacy?.path) return legacy || { path: null, error: 'Could not open the project folder.' };
  const linked = await linkProjectFolder({ projectId, name, dir: legacy.path });
  // A folder that already holds ANOTHER project's file is not this one's —
  // but the legacy registry said it was, and refusing would lock the user
  // out of their files. Use it, unlinked, and say why.
  if (!linked?.ok) return { path: legacy.path, error: null, linkError: linked?.error || null };
  return { path: linked.dir || legacy.path, error: null };
}

export const localFolderApi = {
  // The folder a project's files live in. With the project index this is the
  // project file's folder (see resolveProjectFolder); before it, main's fixed
  // per-project directory under the projects folder.
  projectDir: async (projectId, name, baseDir) => {
    if (!hasElectron) return { path: null, error: 'Desktop app only' };
    if (hasProjectIndex()) {
      const res = await resolveProjectFolder({ projectId, name, baseDir });
      return { path: res?.path || null, error: res?.path ? null : (res?.error || 'Could not open the project folder.') };
    }
    return electronApi.projectDir(projectId, name, baseDir);
  },

  pick: async () => (hasElectron ? electronApi.pick() : null),

  list: async (dir) => (hasElectron ? electronApi.list(dir) : { files: [], dirs: [], error: 'Desktop app only' }),

  // Filesystem facts for ONE file (size + created / modified / accessed +
  // permission bits) — the Doc Viewer's Metadata tab.
  stat: async (pathOrName) => (hasElectron ? electronApi.stat(pathOrName) : { error: 'Desktop app only' }),

  // Recursive listing — every file under `dir` tagged with its `folderPath`
  // (relative dir, '' = root). The Files tab reads the project index instead
  // when main has it; account sync and a few others still walk.
  listAll: async (dir) => (hasElectron ? electronApi.listRecursive(dir) : { files: [], dirs: [], error: 'Desktop app only' }),

  // ── Folder management ─────────────────────────────────────────────
  createFolder: async (payload) => (hasElectron ? electronApi.createFolder(payload) : { error: 'Desktop app only' }),
  deleteFolder: async (payload) => (hasElectron ? electronApi.deleteFolder(payload) : { error: 'Desktop app only' }),
  // Move a whole folder (and its contents) into the recycle bin.
  trashFolder: async (payload) => (hasElectron ? electronApi.trashFolder(payload) : { ok: false, error: 'Desktop app only' }),
  move: async (payload) => (hasElectron ? electronApi.move(payload) : { error: 'Desktop app only' }),

  download: async (payload) => (hasElectron ? electronApi.download(payload) : { results: [], error: 'Desktop app only' }),

  // Write bytes the renderer already has (File / Blob from a picker or a
  // drop) into a folder. `{ dir, files: [{ filename, blob }] }`; IPC can't
  // carry a Blob, so each is turned into an ArrayBuffer first.
  writeFiles: async (payload) => {
    const dir = payload?.dir;
    const files = Array.isArray(payload?.files) ? payload.files : [];
    if (!dir) return { results: [], error: 'No directory specified' };
    if (!hasElectron) return { results: [], error: 'Desktop app only' };
    const ipcFiles = [];
    for (const f of files) {
      if (!f?.filename || !f?.blob) {
        ipcFiles.push({ filename: f?.filename || '?', bytes: null });
        continue;
      }
      try {
        const bytes = await f.blob.arrayBuffer();
        ipcFiles.push({ filename: f.filename, bytes });
      } catch (err) {
        ipcFiles.push({ filename: f.filename, bytes: null, error: err?.message || String(err) });
      }
    }
    return electronApi.writeFiles({ dir, files: ipcFiles });
  },

  // Write files that carry a path RELATIVE to the folder, subfolders and all
  // (lib/projectSync's pull).
  writeTree: async (payload) => {
    const dir = payload?.dir;
    const files = Array.isArray(payload?.files) ? payload.files : [];
    if (!dir) return { results: [], error: 'No directory specified' };
    if (!hasElectron) return { results: [], error: 'Desktop app only' };
    const ipcFiles = [];
    for (const f of files) {
      if (!f?.relPath || !f?.blob) { ipcFiles.push({ relPath: f?.relPath || '?', bytes: null }); continue; }
      ipcFiles.push({ relPath: f.relPath, bytes: await f.blob.arrayBuffer(), mtime: f.mtime || null });
    }
    return electronApi.writeTree({ dir, files: ipcFiles, dirs: Array.isArray(payload?.dirs) ? payload.dirs : [] });
  },

  // Account sync: remove folders deleted on another device, only if empty here.
  removeEmptyDirs: async (payload) => {
    if (hasElectron && electronApi.removeEmptyDirs) return electronApi.removeEmptyDirs(payload);
    return { removed: [], error: null };
  },

  deleteFiles: async (payload) => (hasElectron ? electronApi.deleteFiles(payload) : { results: [], error: 'Desktop app only' }),
  renameFile: async (payload) => (hasElectron ? electronApi.renameFile(payload) : { error: 'Desktop app only' }),
  openPath: async (target) => (hasElectron ? electronApi.openPath(target) : ''),
  // "Save as…" — copy a file to a location picked in the native save dialog.
  saveAs: async (target) => (hasElectron ? electronApi.saveAs(target) : { ok: false }),
  // "Open contents" of a compressed file — a .zip unpacks into a sibling folder.
  extractArchive: async (target) => (hasElectron ? electronApi.extractArchive(target) : { ok: false, error: 'Desktop app only' }),
  showInFolder: async (target) => (hasElectron ? electronApi.showInFolder(target) : { ok: false, error: 'Desktop app only' }),

  // The folder watcher of the pre-index main process. With the project index
  // main watches the open project itself and sends `project:delta` instead.
  watch: async (dir) => (hasElectron ? electronApi.watch(dir) : { ok: false }),
  unwatch: async () => (hasElectron ? electronApi.unwatch() : { ok: false }),
  onChange: (handler) => (hasElectron ? electronApi.onChange(handler) : noop),

  // Browser-only folder persistence (a picked directory handle had to be
  // re-granted each session). There is nothing to persist on the desktop —
  // kept as no-ops so the callers that still make them don't have to branch.
  persistPickedHandle: async () => {},
  restorePersistedHandle: async () => null,
  reconnectHandle: async () => true,
  forgetPersistedHandle: async () => {},

  // The legacy per-folder `.docvex.json` sidecar. READ only, and only as a
  // fallback — to recognise a folder linked to a project before project
  // files existed. Main imports and deletes these; nothing writes new ones.
  readSidecar: async (dir) => (hasElectron && electronApi.readSidecar ? electronApi.readSidecar(dir) : { json: null, error: null }),

  // ── Recently deleted (local recycle bin, `.docvex-trash/`) ─────────
  trashFile: async (payload) => (hasElectron ? electronApi.trashFile(payload) : { ok: false, error: 'Desktop app only' }),
  listTrash: async (dir) => (hasElectron ? electronApi.listTrash(dir) : { items: [], error: null }),
  restoreFromTrash: async (payload) => (hasElectron ? electronApi.restoreFromTrash(payload) : { ok: false, error: 'Desktop app only' }),
  deleteFromTrash: async (payload) => (hasElectron ? electronApi.deleteFromTrash(payload) : { ok: false, error: 'Desktop app only' }),
  purgeTrash: async (payload) => (hasElectron ? electronApi.purgeTrash(payload) : { purged: 0, error: null }),
  // DEV-only trash seeder.
  debugSeedTrash: async (payload) => (hasElectron ? electronApi.debugSeedTrash(payload) : { error: 'Desktop app only' }),
};

// Read a local file as a Blob through the `localfile://` protocol.
export async function readLocalBlob(pathOrName) {
  const url = `localfile://local/${encodeURIComponent(pathOrName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Read failed: ${res.status}`);
  return await res.blob();
}
