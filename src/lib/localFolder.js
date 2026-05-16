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

// Web-backend module-level state. The dirHandle is the chosen
// directory; handlesByName maps each top-level filename to its
// FileSystemFileHandle so subsequent reads/writes don't have to
// re-walk the directory. lastSnapshot + pollTimer + changeHandlers
// drive the polling-based watcher (no real fs.watch on the web).
const webState = {
  dirHandle: null,
  handlesByName: new Map(),
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
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'application/octet-stream';
  return '';
}

// Same sanitisation as main.js's pending-upload helper — keeps web
// downloads compatible with the canonical-storage-path layout the
// approve RPC eventually writes.
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 240);
}

async function listWeb() {
  const dir = webState.dirHandle;
  if (!dir) return { files: [], error: 'No folder picked' };
  webState.handlesByName.clear();
  const files = [];
  try {
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file') continue;
      // Skip dotfiles + OS bookkeeping to match the Electron listing.
      if (entry.name.startsWith('.') || entry.name === 'Thumbs.db') continue;
      let f;
      try { f = await entry.getFile(); }
      catch { continue; }  // permission revoked mid-iteration, skip
      webState.handlesByName.set(entry.name, entry);
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

// Snapshot the current handle set — sorted "name:size:mtime"
// tuples joined into a single string. Cheap to compare; any
// add/edit/delete shifts the string and triggers a change event.
function snapshotHandles() {
  const items = [];
  for (const [name, _h] of webState.handlesByName) items.push(name);
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
    return listWeb();
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
