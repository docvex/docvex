// Unified local-folder abstraction. Two backends share one interface:
//
//   • Electron — `window.electronAPI.localFolder` IPC layer (preload
//     bridges to fs.watch / fsp / shell). Full filesystem access,
//     persistent paths, native folder picker.
//
//   • Web — the File System Access API (`window.showDirectoryPicker`).
//     User-gesture-driven, returns a FileSystemDirectoryHandle. Files
//     are read via `getFile()` (returns a Blob), written via
//     `createWritable()`. No native fs.watch — we poll every 3s and
//     diff snapshots to fire change events. Chromium-family browsers
//     only; absent in Firefox/Safari (those see the same "no local
//     branch" experience as the Electron-less web build did before).
//
// The exported `localFolderApi` is shape-identical to the previous
// Electron-only window.electronAPI.localFolder, so callers don't
// have to branch. Consumers that DO need to know which backend is
// active (for path persistence, input editability, etc.) read
// `isElectronBranch` / `isWebBranch`.

const electronApi = typeof window !== 'undefined' ? window.electronAPI?.localFolder : null;
const hasElectron = Boolean(electronApi);
const hasWebFs    = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

// ── IndexedDB persistence for the web's FileSystemDirectoryHandle ───────
// The File System Access API hands back an opaque handle each pick,
// which we used to drop on page reload. IDB can structured-clone the
// handle, so persisting it across sessions costs almost nothing —
// the only catch is permission: the user must regrant via a user
// gesture each session (queryPermission returns 'prompt' on cold
// load). That's surfaced in the UI as a "Reconnect" button.
//
// Keyed by projectId so different projects can each remember their
// own folder. localStorage stores Electron paths (path-as-string is
// useful there); IDB stores the actual handle here on web.
const IDB_NAME = 'docvex-fs-handles';
const IDB_STORE = 'handles';
const IDB_VERSION = 1;

function openIdb() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('No IndexedDB'));
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(projectId) {
  try {
    const db = await openIdb();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(projectId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbPut(projectId, value) {
  try {
    const db = await openIdb();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, projectId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

async function idbDelete(projectId) {
  try {
    const db = await openIdb();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(projectId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

// Web-backend module-level state. The dirHandle is the chosen
// directory; handlesByName maps each top-level filename to its
// FileSystemFileHandle so subsequent reads/writes don't have to
// re-walk the directory. lastSnapshot + pollTimer + changeHandlers
// drive the polling-based watcher (no real fs.watch on the web).
const webState = {
  dirHandle: null,
  handlesByName: new Map(),
  // Size + mtime of each handled file, used by snapshotHandles to
  // detect in-place byte edits in addition to add/remove/rename.
  // Filled alongside handlesByName by listWeb; cleared in the same
  // pick/restore/forget paths.
  metaByName: new Map(),
  // Separate one-slot handle for `.docvex.json` — kept out of
  // handlesByName because that map is filtered to non-dotfiles
  // (see listWeb). Cached so back-to-back writeSidecar calls skip
  // the per-write directory walk. Cleared on pick / restore /
  // forget so a folder switch can't reuse the previous sidecar.
  sidecarHandle: null,
  lastSnapshot: null,
  pollTimer: null,
  changeHandlers: [],
};

// Duplicate of main.js's guessMimeFromName — extension-based MIME
// inference for files the browser handed us without metadata. Kept
// in sync by convention; if a third copy shows up, extract to a
// shared util.
function guessMimeFromName(name) {
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

// Same sanitisation as main.js's pending-upload helper — keeps web
// downloads compatible with the canonical-storage-path layout the
// approve RPC eventually writes.
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 240);
}

// Filename-based ignore set for the web listing — kept in sync with
// the Electron-side isIgnoredLocalFilename() in src/main.js. Both
// surfaces have to filter the same way or the diff layer sees
// different file sets depending on the build.
function isIgnoredLocalFilenameWeb(name) {
  if (!name) return true;
  if (name.startsWith('.')) return true;
  if (name.startsWith('~$')) return true;
  if (name.endsWith('~')) return true;
  if (/\.(swp|swo|swn|swm)$/i.test(name)) return true;
  if (/\.(lock|lck)$/i.test(name)) return true;
  if (/\.(tmp|temp|bak|partial|crdownload|part)$/i.test(name)) return true;
  if (name === 'Thumbs.db' || name === 'thumbs.db') return true;
  if (name === 'desktop.ini' || name === 'Desktop.ini') return true;
  if (name === 'ehthumbs.db') return true;
  if (name === 'Icon\r') return true;
  return false;
}

async function listWeb() {
  const dir = webState.dirHandle;
  if (!dir) return { files: [], error: 'No folder picked' };
  webState.handlesByName.clear();
  // Refresh the size/mtime fingerprint map alongside the handle map.
  // snapshotHandles() reads from it so the poller detects in-place
  // byte edits (e.g. Word "Save" overwriting the same file), not
  // just adds/removes/renames.
  webState.metaByName.clear();
  const files = [];
  try {
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file') continue;
      // Drop OS / editor / lockfile noise — same matrix as Electron.
      if (isIgnoredLocalFilenameWeb(entry.name)) continue;
      let f;
      try { f = await entry.getFile(); }
      catch { continue; }  // permission revoked mid-iteration, skip
      webState.handlesByName.set(entry.name, entry);
      webState.metaByName.set(entry.name, { size: f.size, mtime: f.lastModified });
      files.push({
        name: entry.name,
        // Synthetic path scheme so the renderer can detect web vs
        // electron via `path.startsWith('web://')`. The folder
        // segment is just the picker-supplied dir.name (FSA doesn't
        // surface real absolute paths for privacy reasons).
        path: `web://${dir.name}/${entry.name}`,
        sizeBytes: f.size,
        mtimeIso: new Date(f.lastModified).toISOString(),
        mimeType: guessMimeFromName(entry.name),
      });
    }
    files.sort((a, b) => (a.mtimeIso < b.mtimeIso ? 1 : -1));
    return { files, error: null };
  } catch (err) {
    return { files: [], error: err?.message || String(err) };
  }
}

// Snapshot tuples "name:size:mtime" joined into a single string.
// Including size + mtime (not just name) means an in-place edit
// (Word's "Save" writing new bytes to the same path) shifts the
// snapshot and fires the change handler. Without these fields,
// the web watcher missed byte edits entirely — only adds, removes,
// and renames triggered listeners.
function snapshotHandles() {
  const items = [];
  for (const [name] of webState.handlesByName) {
    const m = webState.metaByName.get(name) || { size: 0, mtime: 0 };
    items.push(`${name}:${m.size}:${m.mtime}`);
  }
  return items.sort().join('|');
}

function startWebPolling() {
  if (webState.pollTimer) return;
  webState.pollTimer = setInterval(async () => {
    if (!webState.dirHandle) return;
    // listWeb refreshes the handle map; we then diff the snapshot.
    await listWeb();
    const snap = snapshotHandles();
    if (webState.lastSnapshot !== null && snap !== webState.lastSnapshot) {
      const dirName = webState.dirHandle?.name || '';
      for (const h of webState.changeHandlers) {
        try { h(dirName); } catch { /* swallow */ }
      }
    }
    webState.lastSnapshot = snap;
  }, 3000);
}

function stopWebPolling() {
  if (webState.pollTimer) clearInterval(webState.pollTimer);
  webState.pollTimer = null;
  webState.lastSnapshot = null;
}

export const isElectronBranch = hasElectron;
export const isWebBranch      = !hasElectron && hasWebFs;
export const hasLocalFolderApi = hasElectron || hasWebFs;

export const localFolderApi = {
  pick: async () => {
    if (hasElectron) return electronApi.pick();
    if (!hasWebFs) return null;
    try {
      // mode: 'readwrite' so download() can write via createWritable.
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      webState.dirHandle = handle;
      webState.sidecarHandle = null;
      webState.lastSnapshot = null;
      return handle.name;
    } catch (err) {
      // User-cancelled (clicked away from the OS dialog) — return null
      // so the caller knows nothing changed.
      if (err?.name === 'AbortError') return null;
      throw err;
    }
  },

  list: async (dir) => {
    if (hasElectron) return electronApi.list(dir);
    // Web has no in-app folder navigation (the FSA backend tracks a
    // single flat directory handle), so it never surfaces subfolders.
    const res = await listWeb();
    return { ...res, dirs: [] };
  },

  // Recursive listing — the SYNC source. Every file under `dir` tagged
  // with its `folderPath` (relative dir, '' = root). Electron walks the
  // tree; web has no subfolders so it returns the flat listing with
  // folderPath '' on each entry.
  listAll: async (dir) => {
    if (hasElectron) return electronApi.listRecursive(dir);
    const res = await listWeb();
    return { files: (res.files || []).map((f) => ({ ...f, folderPath: '' })), error: res.error };
  },

  // ── Folder management (Electron only) ─────────────────────────────
  // Create / delete a subfolder and move an entry between folders.
  // Local organisation layer; the cloud project stays flat. The web
  // backend can't navigate subfolders, so these report unsupported
  // rather than silently no-op'ing (callers surface the message).
  createFolder: async (payload) => {
    if (hasElectron) return electronApi.createFolder(payload);
    return { error: 'Folders are available in the desktop app' };
  },
  deleteFolder: async (payload) => {
    if (hasElectron) return electronApi.deleteFolder(payload);
    return { error: 'Folders are available in the desktop app' };
  },
  move: async (payload) => {
    if (hasElectron) return electronApi.move(payload);
    return { error: 'Folders are available in the desktop app' };
  },

  download: async (payload) => {
    if (hasElectron) return electronApi.download(payload);
    const dir = webState.dirHandle;
    if (!dir) return { results: [], error: 'No folder picked' };
    const results = [];
    for (const f of payload?.files || []) {
      if (!f?.url || !f?.filename) {
        results.push({ filename: f?.filename || '?', ok: false, error: 'Missing url/filename' });
        continue;
      }
      try {
        const res = await fetch(f.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const safe = sanitizeFilename(f.filename);
        // create:true so re-downloads / first-downloads both work.
        // The writable replaces existing content — same semantics as
        // the Electron path's `fsp.writeFile`.
        const fh = await dir.getFileHandle(safe, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        webState.handlesByName.set(safe, fh);
        results.push({ filename: f.filename, ok: true, path: `web://${dir.name}/${safe}` });
      } catch (err) {
        results.push({ filename: f.filename, ok: false, error: err?.message || String(err) });
      }
    }
    return { results, error: null };
  },

  // Write bytes the renderer already has (File / Blob from a picker
  // or drag-drop) into the branch folder. Used by the FAB on 'mine'
  // branch — uploads now stay local until the user explicitly pushes.
  //
  // Accepts `{ dir, files: [{ filename, blob }] }`. Internally
  // serialises each blob to an ArrayBuffer for IPC (Electron) or
  // writes via createWritable (web).
  writeFiles: async (payload) => {
    const dir = payload?.dir;
    const files = Array.isArray(payload?.files) ? payload.files : [];
    if (!dir) return { results: [], error: 'No directory specified' };
    if (hasElectron) {
      // Electron IPC can't transfer Blob directly — convert to
      // ArrayBuffer first and let the main process write the bytes.
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
    }
    const dirHandle = webState.dirHandle;
    if (!dirHandle) return { results: [], error: 'No folder picked' };
    const results = [];
    for (const f of files) {
      if (!f?.filename || !f?.blob) {
        results.push({ filename: f?.filename || '?', ok: false, error: 'Missing filename or blob' });
        continue;
      }
      try {
        const safe = sanitizeFilename(f.filename);
        const fh = await dirHandle.getFileHandle(safe, { create: true });
        const w = await fh.createWritable();
        await w.write(f.blob);
        await w.close();
        webState.handlesByName.set(safe, fh);
        results.push({ filename: f.filename, ok: true, path: `web://${dirHandle.name}/${safe}` });
      } catch (err) {
        results.push({ filename: f.filename, ok: false, error: err?.message || String(err) });
      }
    }
    return { results, error: null };
  },

  // Delete a batch of files from the picked folder. Used by the
  // "Sync to main" flow when main no longer has files that are
  // still present locally. Both backends accept `{ dir, paths }`
  // and return per-path { ok, error? } so the caller can report
  // partial failures.
  deleteFiles: async (payload) => {
    if (hasElectron) return electronApi.deleteFiles(payload);
    const dir = webState.dirHandle;
    if (!dir) return { results: [], error: 'No folder picked' };
    const results = [];
    for (const p of payload?.paths || []) {
      // Web paths are synthetic — extract the filename and remove via
      // the directory handle. removeEntry throws if missing, which we
      // swallow as success (matches Electron's ENOENT handling).
      const name = (p || '').startsWith('web://') ? p.split('/').pop() : p;
      if (!name) {
        results.push({ path: p, ok: false, error: 'Invalid path' });
        continue;
      }
      try {
        await dir.removeEntry(name);
        webState.handlesByName.delete(name);
        webState.metaByName.delete(name);
        results.push({ path: p, ok: true });
      } catch (err) {
        if (err?.name === 'NotFoundError') {
          results.push({ path: p, ok: true });
        } else {
          results.push({ path: p, ok: false, error: err?.message || String(err) });
        }
      }
    }
    return { results, error: null };
  },

  // Rename a file inside the picked folder. Used by the
  // FileDetailModal's name commit on My branch so File Explorer
  // shows the new name alongside the queued metadata rename.
  //
  // Electron: single fsp.rename.
  // Web: prefer FileSystemFileHandle.move() (Chromium 110+; atomic).
  //      Fallback to read+write+delete for older browsers that
  //      shipped the FSA API before move() landed.
  renameFile: async (payload) => {
    if (hasElectron) return electronApi.renameFile(payload);
    const dir = webState.dirHandle;
    if (!dir) return { error: 'No folder picked' };
    const fromName = payload?.fromName;
    const toName = payload?.toName;
    if (!fromName || !toName) return { error: 'Missing names' };
    if (fromName === toName) return { ok: true, error: null };
    try {
      const handle = webState.handlesByName.get(fromName);
      if (!handle) return { error: 'Source file not found' };
      // Atomic path — move() exists on FileSystemFileHandle in
      // Chromium 110+. Avoids a roundtrip through memory.
      if (typeof handle.move === 'function') {
        await handle.move(toName);
        const newHandle = await dir.getFileHandle(toName);
        webState.handlesByName.delete(fromName);
        webState.handlesByName.set(toName, newHandle);
        // metaByName lives next to handlesByName; carry the entry over
        // (or drop both) so snapshotHandles stays consistent.
        const carried = webState.metaByName.get(fromName);
        webState.metaByName.delete(fromName);
        if (carried) webState.metaByName.set(toName, carried);
        return { ok: true, error: null };
      }
      // Fallback: copy bytes to a fresh handle, then delete the
      // original. Two round-trips through the renderer's memory but
      // works on every FSA-supporting browser.
      const file = await handle.getFile();
      const newHandle = await dir.getFileHandle(toName, { create: true });
      const writable = await newHandle.createWritable();
      await writable.write(file);
      await writable.close();
      await dir.removeEntry(fromName);
      webState.handlesByName.delete(fromName);
      webState.handlesByName.set(toName, newHandle);
      const carried = webState.metaByName.get(fromName);
      webState.metaByName.delete(fromName);
      if (carried) webState.metaByName.set(toName, carried);
      return { ok: true, error: null };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  },

  // No web equivalent for "open in OS file manager" / "open in default
  // app" — browsers don't expose those for sandboxed file handles.
  // Returns an empty string so callers can treat it as a no-op (matches
  // the Electron API's success contract).
  openPath: async (target) => {
    if (hasElectron) return electronApi.openPath(target);
    return '';
  },

  // Reveal a file in the OS file manager (Explorer / Finder) with the
  // file pre-selected. Electron-only; web returns a no-op success
  // shape since browsers can't drive the host's file manager.
  showInFolder: async (target) => {
    if (hasElectron) return electronApi.showInFolder(target);
    return { ok: false, error: 'Not supported on web' };
  },

  watch: async (dir) => {
    if (hasElectron) return electronApi.watch(dir);
    startWebPolling();
    return { ok: true };
  },

  unwatch: async () => {
    if (hasElectron) return electronApi.unwatch();
    stopWebPolling();
    return { ok: true };
  },

  onChange: (handler) => {
    if (hasElectron) return electronApi.onChange(handler);
    webState.changeHandlers.push(handler);
    return () => {
      webState.changeHandlers = webState.changeHandlers.filter((h) => h !== handler);
    };
  },

  // ── Web folder persistence ────────────────────────────────────────
  // Electron persists the chosen folder as a path string in
  // localStorage (handled by the caller, see ProjectFiles.jsx).
  // Web can't — `showDirectoryPicker` returns an opaque handle, no
  // path. IDB structured-clones the handle so we can carry it
  // across page reloads; permission grants don't persist by
  // default, hence the reconnect step below.
  //
  // All four are no-ops on Electron so callers can fire them
  // unconditionally without branching.

  // Save the currently-picked handle to IDB keyed by projectId.
  // Call this right after a successful `pick()` so the next visit
  // can find it. Failure is silent — folder still works this session;
  // the user just has to pick again next time.
  persistPickedHandle: async (projectId) => {
    if (hasElectron) return;
    if (!hasWebFs || !projectId || !webState.dirHandle) return;
    await idbPut(projectId, {
      handle: webState.dirHandle,
      name: webState.dirHandle.name,
      savedAt: Date.now(),
    });
  },

  // Look up the persisted handle for a project. Returns
  // `{ name, needsPermission }` when one exists, `null` otherwise.
  // Side-effect: when found, the handle is hot-loaded into
  // webState so subsequent operations (after permission is granted
  // via `reconnectHandle`) work without further setup.
  //
  // `needsPermission` distinguishes the two restore outcomes:
  //   • false → permission still 'granted' (rare; only when the
  //             browser remembered the grant from a prior session,
  //             which Chromium 122+ allows for some flows). The
  //             caller can list/read immediately.
  //   • true  → permission is 'prompt' or 'denied'. The caller
  //             should show a Reconnect affordance; the user's
  //             click on it must be the gesture that drives
  //             `reconnectHandle()` below.
  restorePersistedHandle: async (projectId) => {
    if (hasElectron) return null;
    if (!hasWebFs || !projectId) return null;
    const stored = await idbGet(projectId);
    if (!stored?.handle) return null;
    webState.dirHandle = stored.handle;
    webState.sidecarHandle = null;
    webState.lastSnapshot = null;
    let perm = 'prompt';
    try {
      perm = await stored.handle.queryPermission({ mode: 'readwrite' });
    } catch { /* older browsers without queryPermission — fall through */ }
    return {
      name: stored.name || stored.handle.name,
      needsPermission: perm !== 'granted',
    };
  },

  // User-gesture-driven permission request. Returns true if the
  // handle is now usable. MUST be called from inside a user gesture
  // (e.g., onClick handler) — the FSA spec rejects bare programmatic
  // calls. The caller should disable the surrounding UI while this
  // promise is in flight.
  reconnectHandle: async () => {
    if (hasElectron) return true;
    if (!hasWebFs || !webState.dirHandle) return false;
    try {
      const perm = await webState.dirHandle.requestPermission({ mode: 'readwrite' });
      return perm === 'granted';
    } catch {
      return false;
    }
  },

  // Drop the persisted handle for a project and clear in-memory
  // state. Used by an explicit "forget folder" affordance or when
  // a project gets deleted. Idempotent.
  forgetPersistedHandle: async (projectId) => {
    if (hasElectron) return;
    if (!projectId) return;
    await idbDelete(projectId);
    if (webState.dirHandle) {
      webState.dirHandle = null;
      webState.handlesByName.clear();
      webState.metaByName.clear();
      webState.sidecarHandle = null;
      webState.lastSnapshot = null;
    }
  },

  // ── Sidecar (.docvex.json) I/O ────────────────────────────────────
  // Reads / writes a single hidden JSON file inside the picked folder.
  // The sidecar carries the fileId ↔ filename mapping for the local
  // branch; storing it in-folder means the IDs survive a localStorage
  // clear, ride along with the files when shared via Dropbox/iCloud,
  // and re-attach automatically when the user re-picks the folder
  // (no bootstrap window where unrecognised files briefly render as
  // missing).
  //
  // Both methods are async and return { json | ok, error }. Missing
  // files (read on a never-written folder) resolve to { json: null,
  // error: null } — the caller treats null as "empty mapping".
  //
  // Web path: bypasses `webState.handlesByName` (which excludes
  // dotfiles to keep the file grid clean). Goes straight through
  // `dir.getFileHandle('.docvex.json', { create: true })`. A single
  // sidecar handle is cached in `webState.sidecarHandle` to skip the
  // per-write directory walk; cleared when the folder is forgotten /
  // re-picked.
  readSidecar: async (dir) => {
    if (hasElectron) return electronApi.readSidecar(dir);
    const dirHandle = webState.dirHandle;
    if (!dirHandle) return { json: null, error: 'No folder picked' };
    try {
      // create:true so the handle always resolves — if the file
      // doesn't exist yet we just read an empty handle and return
      // null below (via the empty-text branch).
      const fh = await dirHandle.getFileHandle('.docvex.json', { create: true });
      webState.sidecarHandle = fh;
      const file = await fh.getFile();
      if (file.size === 0) return { json: null, error: null };
      const text = await file.text();
      let parsed = null;
      try { parsed = JSON.parse(text); }
      catch (parseErr) { return { json: null, error: `Bad JSON: ${parseErr?.message || parseErr}` }; }
      return { json: parsed, error: null };
    } catch (err) {
      return { json: null, error: err?.message || String(err) };
    }
  },

  writeSidecar: async (payload) => {
    const dir = payload?.dir;
    const json = payload?.json;
    if (!dir) return { ok: false, error: 'No directory specified' };
    if (!json || typeof json !== 'object') return { ok: false, error: 'Invalid payload' };
    if (hasElectron) return electronApi.writeSidecar({ dir, json });
    const dirHandle = webState.dirHandle;
    if (!dirHandle) return { ok: false, error: 'No folder picked' };
    try {
      const fh = webState.sidecarHandle
        || await dirHandle.getFileHandle('.docvex.json', { create: true });
      webState.sidecarHandle = fh;
      const w = await fh.createWritable();
      await w.write(JSON.stringify(json, null, 2));
      await w.close();
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
};

// Read a local file as a Blob, regardless of backend. Used by the
// commit modal (to PUT bytes into the pending bucket) and by
// LocalFileCard (to build thumbnails on web). On Electron this
// fetches via the custom `localfile://` protocol; on web it reads
// the cached FileSystemFileHandle.
export async function readLocalBlob(pathOrName) {
  if (hasElectron) {
    const url = `localfile://local/${encodeURIComponent(pathOrName)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Read failed: ${res.status}`);
    return await res.blob();
  }
  // Web: the value may be either the synthetic `web://dir/name` path
  // or just the bare filename. Strip the prefix in either case.
  const name = (pathOrName || '').startsWith('web://')
    ? pathOrName.split('/').pop()
    : pathOrName;
  const handle = webState.handlesByName.get(name);
  if (!handle) throw new Error(`No handle for "${name}" — pick the folder again`);
  return await handle.getFile();
}
