// Platform adapter — the single module that talks to the Electron main
// process. Every capability the renderer would otherwise pull from
// `window.electronAPI` (see src/preload.js) goes through here. The rest of the
// app imports from this module; nothing else touches `window.electronAPI`
// directly.
//
// DocVex is desktop-only (the browser build of the app was removed), but every
// entry point still guards the bridge: a window whose preload predates a
// channel — the norm under `npm start`, where the renderer hot-reloads and main
// does not — must degrade to a no-op / empty answer, never throw.

const electronAPI =
  typeof window !== 'undefined' && window.electronAPI ? window.electronAPI : null;

// Presence of the preload bridge. Always true in the app's own windows.
export const isElectron = !!electronAPI;

// Synchronous OS guess from the userAgent — available before first paint (the
// async getPlatformInfo() IPC isn't). Electron's renderer userAgent always
// reports "Macintosh; Intel Mac OS X" on macOS (both Intel and Apple Silicon),
// so a substring test is reliable. Drives the macOS title-bar layout: the
// native traffic-light buttons replace the custom window controls, so the bar
// insets its brand and hides its own min/max/close on Mac.
export const isMac =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent || '');

// The tray's drop window (?trayDrop=1, main.js openTrayDropWindow).
export const isTrayDropWindow =
  typeof window !== 'undefined' && (() => {
    try { return new URLSearchParams(window.location.search).get('trayDrop') === '1'; } catch { return false; }
  })();

// The tray drop window: copy dropped paths into a folder / hear macOS
// menu-bar-icon drops.
export function trayDropCopyIn(dir, paths) {
  if (!electronAPI?.trayDropCopyIn) return Promise.resolve({ results: [], error: 'Restart DocVex to use this' });
  return electronAPI.trayDropCopyIn({ dir, paths });
}
export function onTrayDropFiles(cb) {
  return electronAPI?.onTrayDropFiles ? electronAPI.onTrayDropFiles(cb) : (() => {});
}

// True in auxiliary windows — the Doc Viewer (?docViewer=1) and the tray's
// drop window (?trayDrop=1). These share
// the renderer bundle with the main app window, but they must NOT each pay
// for the main window's background infrastructure (project-files prefetch,
// notifications history fetch + Realtime channel, chat-unread channel,
// GitHub releases fetch): with several viewer windows open at once those
// duplicated fetches, sockets, and folder scans multiply into real lag.
// Contexts consult this flag to skip their background work in aux windows;
// the main window (no marker param) keeps full behaviour.
export const isAuxWindow =
  typeof window !== 'undefined' &&
  (() => {
    try {
      const q = new URLSearchParams(window.location.search);
      return q.get('docViewer') === '1' || q.get('trayDrop') === '1';
    } catch {
      return false;
    }
  })();

// ── App metadata ──────────────────────────────────────────────────────────

// Returns the running app's semver string (IPC to main: app.getVersion()).
export async function getAppVersion() {
  if (electronAPI?.getAppVersion) return electronAPI.getAppVersion();
  return '0.0.0';
}

// True for packaged Electron builds (i.e. installed via Squirrel, not run
// from `electron-forge start`). Drives the auto-update gating in
// UpdatesContext — a packaged build polls update.electronjs.org; dev should
// not.
export async function isPackaged() {
  if (electronAPI?.isPackaged) return electronAPI.isPackaged();
  return false;
}

// Returns { platform, arch } for the running build — IPC to main
// (process.platform / process.arch — e.g. { platform: 'darwin', arch: 'arm64' }).
// Drives the manual-download update fallback's asset selection on platforms
// where the in-app auto-updater can't run (unsigned macOS / Linux).
export async function getPlatformInfo() {
  if (electronAPI?.getPlatformInfo) return electronAPI.getPlatformInfo();
  return { platform: 'unknown', arch: 'unknown' };
}

// ── External / OAuth URLs ─────────────────────────────────────────────────

// Open an arbitrary URL in the user's default browser — routes through main's
// shell.openExternal (filtered to http(s)).
export function openExternal(url) {
  electronAPI?.openExternal?.(url);
}

// ── Window controls (frameless title bar) ─────────────────────────────────
// Electron runs frameless; the renderer's title bar drives the window through
// these.
export function windowMinimize() { electronAPI?.windowMinimize?.(); }
export function windowToggleMaximize() { electronAPI?.windowToggleMaximize?.(); }
export function windowClose() { electronAPI?.windowClose?.(); }
export async function windowIsMaximized() {
  return electronAPI?.windowIsMaximized ? electronAPI.windowIsMaximized() : false;
}
// Subscribe to OS maximize/unmaximize. Returns an unsubscribe fn (a no-op stub
// when the bridge lacks the channel) so callers can clean up uniformly.
export function onWindowMaximizedChanged(handler) {
  return electronAPI?.onWindowMaximizedChanged
    ? electronAPI.onWindowMaximizedChanged(handler)
    : () => {};
}
export async function windowIsFullscreen() {
  return electronAPI?.windowIsFullscreen ? electronAPI.windowIsFullscreen() : false;
}
// True when the native window ACCEPTED the request — not when it has finished
// becoming fullscreen (on macOS that is an animation; listen on
// onWindowFullscreenChanged for the state). False means the caller should reach
// for the DOM's own Fullscreen API instead: on a window pinned
// non-fullscreenable, and in a window whose preload predates this channel.
// Hand the native window the colour it should paint where the renderer has not
// — through a resize, and above all through macOS's fullscreen animation, where
// the renderer composites nothing at all and Electron's default white is what
// the whole window flashes.
export function windowSetBackground(color) {
  try { electronAPI?.windowSetBackground?.(color); } catch { /* not fatal */ }
}

export async function windowSetFullscreen(on) {
  if (!electronAPI?.windowSetFullscreen) return false;
  try {
    return !!(await electronAPI.windowSetFullscreen(on));
  } catch {
    return false;
  }
}

// True in the dedicated sign-in window (main.js openAuthWindow boots the same
// renderer with ?authWindow=1). Everything else — the app window, the doc
// viewer, the tray menu — is false.
export const isAuthWindow = (() => {
  try {
    return isElectron && new URLSearchParams(window.location.search).get('authWindow') === '1';
  } catch {
    return false;
  }
})();

// Handover between the app window and the sign-in window.
//   authAppReady()  — app window, signed in: reveal me, dismiss the sign-in window.
//   authRequired()  — app window, signed out: hide me, put the sign-in window up.
//   authCompleted() — sign-in window: a session landed, hand back to the app.
export function authAppReady() {
  electronAPI?.authAppReady?.();
}
export function authRequired() {
  electronAPI?.authRequired?.();
}
export function authCompleted() {
  electronAPI?.authCompleted?.();
}

// Quit the entire app (closes all windows). Used by a deliberate logout.
export function quitApp() {
  electronAPI?.quitApp?.();
}
// Subscribe to native fullscreen enter/leave. Returns an unsubscribe fn.
// Drives the macOS title bar's traffic-light inset.
export function onWindowFullscreenChanged(handler) {
  return electronAPI?.onWindowFullscreenChanged
    ? electronAPI.onWindowFullscreenChanged(handler)
    : () => {};
}

// True for files Chromium's built-in viewers render inline (image
// tags, native <video>, pdf.js, text). DOCX gets `false` here because
// Chromium can't render it natively — but it has its own custom viewer
// (see viewerTypeFor below), so callers that hand off through
// openFileWindow should consult viewerTypeFor rather than gating on
// canViewInBrowser alone.
export function canViewInBrowser(mime, name) {
  const m = (mime || '').toLowerCase();
  const lcName = (name || '').toLowerCase();
  if (lcName.endsWith('.docx')) return false;
  return m === 'application/pdf'
    || m.startsWith('image/')
    || m.startsWith('video/')
    || m.startsWith('text/');
}

// True if the file is a Word document (matches the canonical DOCX
// MIME OR the .docx extension — the local-folder MIME mapper has
// historically returned `application/octet-stream` for some .docx
// files, so the extension check is the reliable signal). Callers
// route through openDocx for these; everything else goes through
// openFileWindow.
export function isDocxFile(mime, name) {
  const m = (mime || '').toLowerCase();
  const lcName = (name || '').toLowerCase();
  return m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || lcName.endsWith('.docx');
}

// True if the file is viewable inside DocVex — either by Chromium
// (image/video/PDF/text) OR by routing DOCX through openDocx (Word
// locally / Office Online / OS default). Used by callers to decide
// whether double-click should attempt an in-app open at all.
export function canOpenInApp(mime, name) {
  return canViewInBrowser(mime, name) || isDocxFile(mime, name);
}

// Open a file URL in a dedicated in-app window (image / video / PDF
// / text — types Chromium renders natively). DOCX uses openDocx
// below instead, because it has its own fallback chain that doesn't
// always end in a BrowserWindow at all.
//
// Main opens a fresh BrowserWindow titled "DocVex - <fileName>" with the app
// icon. The window has no preload + sandbox=true so it can't reach
// electronAPI.
export function openFileWindow(url, fileName) {
  electronAPI?.openFileWindow?.(url, fileName);
}

// Write `blob` to the OS temp folder and return its path — a document that is
// opened without being filed in a project.
export async function writeTempFile(name, blob) {
  if (!electronAPI?.writeTempFile) return { error: 'unsupported' };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return electronAPI.writeTempFile(name, bytes);
}

// Open a file in DocVex's document-viewer window — the file preview PLUS a
// Legal AI panel (src/pages/DocViewer.jsx). `file` is { path, name, mime }.
// Returns true when handled (false only when the bridge lacks the channel).
export function openDocViewerWindow(file) {
  if (electronAPI?.openDocViewerWindow) {
    electronAPI.openDocViewerWindow(file);
    return true;
  }
  return false;
}

// ── Pre-warmed doc-viewer window ────────────────────────────────────────────
// A viewer window boots hidden and empty so the NEXT file opens instantly:
// main hands it the file over IPC and shows it once the document has painted.
export function notifyDocViewerWarmReady() {
  try { electronAPI?.notifyDocViewerWarmReady?.(); } catch { /* non-fatal */ }
}
export function notifyDocViewerFilePainted() {
  try { electronAPI?.notifyDocViewerFilePainted?.(); } catch { /* non-fatal */ }
}
export function setDocViewerFile(file) {
  try { electronAPI?.setDocViewerFile?.({ path: file?.path, name: file?.name, mime: file?.mime || '', renamed: !!file?.renamed }); } catch { /* non-fatal */ }
}
export function onDocViewerOpenFile(handler) {
  if (!electronAPI?.onDocViewerOpenFile) return () => {};
  return electronAPI.onDocViewerOpenFile(handler);
}
// Preloading: ask the viewer to get a file ready before it is opened (the
// Files tab, on hover / selection). A no-op until main and the preload carry
// the channel (restart `npm start` after a main.js change).
let lastPrepared = '';
export function prepareDocViewerFile(file) {
  if (!file?.path || file.path === lastPrepared) return;
  lastPrepared = file.path;
  try { electronAPI?.prepareDocViewerFile?.({ path: file.path, name: file.name || '', mime: file.mime || '' }); } catch { /* non-fatal */ }
}
export function onDocViewerPrepareFile(handler) {
  if (!electronAPI?.onDocViewerPrepareFile) return () => {};
  return electronAPI.onDocViewerPrepareFile(handler);
}

// Surface a known on-disk file for localfile:// preview without opening a
// window (timeline source thumbnails). Awaitable — resolves once the path
// is inside containment.
export function allowLocalFile(p) {
  try {
    return Promise.resolve(electronAPI?.allowLocalFile?.(p));
  } catch {
    return Promise.resolve(false);
  }
}

// "Opened with DocVex" — standalone files opened via the OS file association
// (Explorer/Finder "Open with"), not linked to any project. list snapshots
// the recorded opens; onExternalOpensChanged subscribes to changes
// (unsubscribe fn returned); open re-launches one in its own Doc Viewer
// window; remove drops it from the list.
export function listExternalOpens() {
  return electronAPI?.listExternalOpens ? electronAPI.listExternalOpens() : Promise.resolve([]);
}
export function openExternalFile(p) {
  electronAPI?.openExternalFile?.(p);
}
export function removeExternalOpen(p) {
  return electronAPI?.removeExternalOpen ? electronAPI.removeExternalOpen(p) : Promise.resolve(false);
}
export function onExternalOpensChanged(cb) {
  return electronAPI?.onExternalOpensChanged ? electronAPI.onExternalOpensChanged(cb) : (() => {});
}

// On-disk path of a picked/dropped File object (webUtils.getPathForFile via
// the preload — File.path itself was removed in Electron 32). Returns '' for
// synthetic Files that have no disk path.
export function pathForFile(file) {
  try { return electronAPI?.getPathForFile?.(file) || ''; } catch { return ''; }
}

// Subscribe to "open this file as a new tab" pushes for the shared doc-viewer
// window. Returns an unsubscribe fn.
export function onDocViewerAddFile(cb) {
  return electronAPI?.onDocViewerAddFile ? electronAPI.onDocViewerAddFile(cb) : (() => {});
}

// This doc-viewer window's AI busy state (main: the Files tab's spinner, and
// a window closed while busy finishes in the background).
export function setDocViewerAiStatus(busy) {
  electronAPI?.setDocViewerAiStatus?.(busy);
}
// The first prompt about the document on show (a new document then appears in
// the Files tab; main ignores it for any other file).
export function docViewerPrompted() {
  try { electronAPI?.docViewerPrompted?.(); } catch { /* non-fatal */ }
}
// { busy, hidden } — the paths the AI is writing, and new documents not yet
// prompted. Snapshot + live updates.
export function getDocViewerState() {
  return electronAPI?.getDocViewerState ? electronAPI.getDocViewerState() : Promise.resolve({ busy: [], hidden: [] });
}
export function onDocViewerState(cb) {
  return electronAPI?.onDocViewerState ? electronAPI.onDocViewerState(cb) : (() => {});
}
// A tab in a SEPARATE WINDOW: the same app booted at a route. Opened only —
// nothing tracks or lists them.
export const isTabWindow = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tabWindow') === '1';
export function openTabWindow(route, title = '') { electronAPI?.openTabWindow?.(route, title); }
export const canOpenTabWindow = !!electronAPI?.openTabWindow;
// Send the MAIN window to an in-app route (or '@logout') and bring it forward —
// for secondary windows (the Doc Viewer), which have no app shell of their own.
export function navigateMainWindow(dest) {
  electronAPI?.navigateMainWindow?.(dest);
}

// "Back to app" from a doc-viewer window — raise the main app window.
export function focusMainWindow() {
  electronAPI?.focusMainWindow?.();
}

// File mutations (trash, rename) need to reach two audiences:
//   • SAME renderer — the doc-viewer's tab sidebar and its embedded Files tab
//     live in one window, so a `window` event refreshes the footer directly,
//     with no IPC round-trip (works even if the preload/main process hasn't
//     reloaded).
//   • OTHER windows — the main window's Files tab, reached via IPC; main fans
//     the broadcast back out to every window EXCEPT the sender (the sender
//     already handled it through the local `window` event).
const FILES_REMOVED_EVENT = 'docvex:files-removed';
const FILES_CHANGED_EVENT = 'docvex:files-changed';

// Tell every window that `paths` (file or folder paths) were just trashed /
// deleted, so the doc-viewer can close their tabs and other Files tabs re-list.
export function notifyFilesRemoved(paths) {
  try { window.dispatchEvent(new CustomEvent(FILES_REMOVED_EVENT, { detail: paths })); } catch { /* noop */ }
  electronAPI?.notifyFilesRemoved?.(paths);
}

// Subscribe to the "files removed" signal (same-window event + cross-window
// IPC). Returns an unsubscribe fn.
export function onFilesRemoved(cb) {
  const onLocal = (e) => cb(e.detail);
  window.addEventListener(FILES_REMOVED_EVENT, onLocal);
  const unsubIpc = electronAPI?.onFilesRemoved ? electronAPI.onFilesRemoved(cb) : null;
  return () => { window.removeEventListener(FILES_REMOVED_EVENT, onLocal); unsubIpc?.(); };
}

// Announce a generic on-disk file change (e.g. a rename) so every window's
// Files tab re-lists.
export function notifyFilesChanged() {
  try { window.dispatchEvent(new Event(FILES_CHANGED_EVENT)); } catch { /* noop */ }
  electronAPI?.notifyFilesChanged?.();
}

// Subscribe to the "files changed" signal (same-window event + cross-window
// IPC). Returns an unsubscribe fn.
export function onFilesChanged(cb) {
  const onLocal = () => cb();
  window.addEventListener(FILES_CHANGED_EVENT, onLocal);
  const unsubIpc = electronAPI?.onFilesChanged ? electronAPI.onFilesChanged(cb) : null;
  return () => { window.removeEventListener(FILES_CHANGED_EVENT, onLocal); unsubIpc?.(); };
}

// ── The national legislation portal ───────────────────────────────
// Every one of these goes through main: the portal's web service sends no CORS
// headers, and the archive is a folder on disk.
//
// Each one answers, never throws. A missing channel is not an error the page
// should show as a crash: in DEVELOPMENT the renderer is hot-reloaded on every save
// while main is only rebuilt when Electron restarts (Forge's Vite plugin has
// main-process hot restart stubbed out as a TODO) — so a window can be newer
// than the process it is talking to: the bridge lacks the method, or `invoke`
// on a handler that does not exist yet REJECTS ("No handler registered").
// That case is answered as `stale_app`, NOT as "unreachable": the pages used to
// blame the portal for it, and a developer went looking for a network fault
// that was a process needing `npm start` again. A real network failure still
// comes back as the fallback, and the Legislation tab then does what it does
// when the ministry's server is down: falls back to this machine's copy and
// says so. (`goFullscreen` guards the same way, for the same reason.)
const legisCall = async (method, arg, fallback) => {
  const fn = electronAPI?.[method];
  // A bridge that exists but lacks the method = a preload older than this code.
  if (!fn) return electronAPI && fallback === LEGIS_DOWN ? LEGIS_STALE : fallback;
  try {
    const res = await fn(arg);
    return res ?? fallback;
  } catch (e) {
    const stale = /No handler registered/i.test(String(e?.message || e));
    return stale && fallback === LEGIS_DOWN ? LEGIS_STALE : fallback;
  }
};
const LEGIS_DOWN = { ok: false, error: 'unreachable' };
const LEGIS_STALE = { ok: false, error: 'stale_app' };

export function legislationSearch(query) {
  return legisCall('legislationSearch', query, LEGIS_DOWN);
}
export function legislationArchivePut(payload) {
  return legisCall('legislationArchivePut', payload, LEGIS_DOWN);
}
export function legislationArchiveList() {
  // An archive that cannot be read is an EMPTY one, not a failure: the tab can
  // still search the portal, and saying "0 kept here" is the truth.
  return legisCall('legislationArchiveList', undefined, { ok: true, acts: [], bytes: 0 });
}
export function legislationArchiveGet(id) {
  return legisCall('legislationArchiveGet', id, { ok: false, error: 'not_kept' });
}
export function legislationArchiveRemove(id) {
  return legisCall('legislationArchiveRemove', id, LEGIS_DOWN);
}
export function legislationArchiveClear() {
  return legisCall('legislationArchiveClear', undefined, LEGIS_DOWN);
}
/** The act's page on the portal (`{ id, fresh }` → `{ ok, html, source }`), kept beside the act. */
export function legislationPage(payload) {
  return legisCall('legislationPage', payload, LEGIS_DOWN);
}

// The courts' portal and ANAF — the same guard, the same "unreachable" answer.
export function courtsSearch(query) {
  return legisCall('courtsSearch', query, LEGIS_DOWN);
}
export function courtsHearings(query) {
  return legisCall('courtsHearings', query, LEGIS_DOWN);
}
/** Where a web address lands (redirects followed) and its site's icon as a
 *  data: URL — `{ url }` → `{ ok, url, host, icon }`. Refuses this machine
 *  and private networks (main.js `link:preview`). */
export function linkPreview(url) {
  return legisCall('linkPreview', { url }, LEGIS_DOWN);
}
export function anafBilant(payload) {
  return legisCall('anafBilant', payload, LEGIS_DOWN);
}
export function anafLookup(payload) {
  return legisCall('anafLookup', payload, LEGIS_DOWN);
}

// Upload from a phone over the local network. A main process
// started before this existed answers `stale_app` (restart npm start).
export async function phoneUploadStart(payload) {
  if (!electronAPI?.phoneUploadStart) return { ok: false, error: 'stale_app' };
  try { return await electronAPI.phoneUploadStart(payload); } catch (err) {
    return { ok: false, error: /No handler registered/i.test(String(err?.message)) ? 'stale_app' : 'failed' };
  }
}
export function phoneUploadStop(token) {
  try { return electronAPI?.phoneUploadStop?.(token); } catch { return null; }
}
export function phoneUploadHold(payload) {
  try { return electronAPI?.phoneUploadHold?.(payload) || null; } catch { return null; }
}
export async function phoneUploadPending(payload) {
  try { return (await electronAPI?.phoneUploadPending?.(payload)) || []; } catch { return []; }
}
// Windows Firewall: does it let phones in? `{ allow: true }` asks Windows to.
export async function phoneUploadFirewall(payload) {
  try { return (await electronAPI?.phoneUploadFirewall?.(payload)) || { ok: false }; } catch { return { ok: false }; }
}
export async function phoneUploadHoldFile(payload) {
  try { return (await electronAPI?.phoneUploadHoldFile?.(payload)) || { ok: false }; } catch { return { ok: false }; }
}
export async function phoneUploadRelease(payload) {
  try { return (await electronAPI?.phoneUploadRelease?.(payload)) || { ok: false }; } catch { return { ok: false }; }
}
export async function phoneUploadAccept(id) {
  try { return (await electronAPI?.phoneUploadAccept?.(id)) || { ok: false }; } catch { return { ok: false }; }
}
export async function phoneUploadReject(id) {
  try { return (await electronAPI?.phoneUploadReject?.(id)) || { ok: false }; } catch { return { ok: false }; }
}
export function onPhoneUploadEvent(cb) {
  return electronAPI?.onPhoneUploadEvent ? electronAPI.onPhoneUploadEvent(cb) : () => {};
}

// Extract readable text from a legacy .doc file (parsed in the Electron main
// process). Resolves { text } or { error }.
export function extractDocText(filePath) {
  return electronAPI?.extractDocText ? electronAPI.extractDocText(filePath) : Promise.resolve({ error: 'unsupported' });
}

// Extract a WhatsApp export .zip (main process) and locate its chat transcript.
// Resolves { ok, chatPath, name } so the caller can open the reconstructed
// conversation in the doc-viewer; { ok: false } when it isn't a WhatsApp export
// (or when the bridge lacks the channel).
export function prepareWhatsAppZip(zipPath) {
  return electronAPI?.prepareWhatsAppZip ? electronAPI.prepareWhatsAppZip(zipPath) : Promise.resolve({ ok: false });
}

// Same, for an already-extracted WhatsApp export FOLDER: locate its chat
// transcript so the caller can open the reconstructed conversation in the
// doc-viewer. Resolves { ok, chatPath, name } or { ok: false }.
export function prepareWhatsAppFolder(dirPath) {
  return electronAPI?.prepareWhatsAppFolder ? electronAPI.prepareWhatsAppFolder(dirPath) : Promise.resolve({ ok: false });
}

// Content-based WhatsApp recognition for the Files tab. Resolves a
// { [path]: boolean } map for the given folder / .zip paths — true when the
// path CONTAINS a chat transcript (decided in the main process by reading
// inside, so renaming the zip/folder doesn't lose recognition). Empty map when
// the bridge lacks the channel (the UI falls back to its name heuristic).
export function detectWhatsApp(paths) {
  return electronAPI?.detectWhatsApp ? electronAPI.detectWhatsApp(paths) : Promise.resolve({});
}

// Open a self-contained HTML string in its own window. Used by the
// .docx viewer (the document is rendered to HTML via docx-preview in the
// renderer). Main stages it to a temp file + native window.
export function openHtmlWindow(html, fileName) {
  electronAPI?.openHtmlWindow?.(html, fileName);
}

// Open a DOCX with the best-available renderer. Pass whichever
// sources you have — local disk path and/or a signed cloud URL (for the
// no-Word fallback).
//
// Routing (in main):
//   1. Word installed → shell.openPath(localPath) when available,
//      else shell.openExternal('ms-word:ofv|u|<cloudUrl>').
//   2. No Word, cloudUrl present → Office Online in BrowserWindow.
//   3. No Word, localPath only → shell.openPath (OS default app).
export function openDocx({ localPath = null, cloudUrl = null, fileName = 'file' }) {
  electronAPI?.openDocx?.({ localPath, cloudUrl, fileName });
}

// Send the user through an OAuth provider's auth URL: main pops the OS
// browser; the renderer waits for the docvex:// callback (handled by
// onDeepLink below).
export function openOAuthUrl(url) {
  electronAPI?.openOAuthUrl?.(url);
}

// ── Deep links ────────────────────────────────────────────────────────────

// Subscribe to docvex:// URLs the OS routes back to the app. Returns an
// unsubscribe function.
export function onDeepLink(handler) {
  if (!electronAPI?.onOAuthCallback) return () => {};
  electronAPI.onOAuthCallback(handler);
  return () => {
    try { electronAPI.removeOAuthListener?.(); } catch { /* non-fatal */ }
  };
}

// One-shot fetch of any docvex:// URL passed on the command line at COLD
// start (e.g. clicking an invite link when the app isn't running yet).
// Resolves to null when nothing is pending.
export async function getStartupDeepLink() {
  if (!electronAPI?.getStartupDeepLink) return null;
  try {
    return await electronAPI.getStartupDeepLink();
  } catch {
    return null;
  }
}

// ── Dev-only account switcher ─────────────────────────────────────────────

// Subscribe to the dev "Account" menu's switch event. Returns an unsubscribe
// fn.
export function onAccountSwitch(handler) {
  if (!electronAPI?.onAccountSwitch) return () => {};
  return electronAPI.onAccountSwitch(handler);
}

// ── Auto-updater ──────────────────────────────────────────────────────────

// Trigger a manual update check. Resolves to a status object whose `state`
// field drives the UI:
//   - packaged:  'checking' → autoUpdater events take over
//   - dev:       { state: 'dev' }
//   - macOS / Linux, or no bridge: { state: 'unsupported' }
export async function checkForUpdates() {
  if (electronAPI?.checkForUpdates) return electronAPI.checkForUpdates();
  return { state: 'unsupported' };
}

// Pull the last-known updater status from main (recovers e.g. 'downloaded'
// after a renderer reload, since update:status events are push-only).
// { state: 'idle' } when the bridge is missing.
export async function getUpdateStatus() {
  if (electronAPI?.getUpdateStatus) return electronAPI.getUpdateStatus();
  return { state: 'idle' };
}

// Trigger Squirrel's quit-and-install path.
export function installUpdate() {
  electronAPI?.installUpdate?.();
}

// macOS self-update fallback (the build can't use Squirrel.Mac — see
// UpdatesContext). Downloads the new build, swaps the .app bundle, and
// relaunches. Resolves to { ok, error? }; on success the app quits itself.
// Progress is reported via onUpdateStatus ('downloading' with percent →
// 'installing').
export async function downloadAndInstallUpdate(url) {
  if (electronAPI?.downloadAndInstallUpdate) return electronAPI.downloadAndInstallUpdate(url);
  return { ok: false, error: 'Not supported on this platform.' };
}

// Subscribe to autoUpdater lifecycle events. Returns an unsubscribe fn.
export function onUpdateStatus(handler) {
  if (!electronAPI?.onUpdateStatus) return () => {};
  return electronAPI.onUpdateStatus(handler);
}

// ── App-wide UI scale (Settings → Display scale) ──────────────────────────

// Apply a global UI zoom factor (1 = 100%) through webFrame (browser) zoom —
// it rescales the VIEWPORT, so vh/vw, media queries and clientX-vs-layout math
// stay consistent, and it stacks multiplicatively on the CSS baseline
// (src/lib/appZoom.js) without touching it. Same mechanism VS Code uses;
// renders text crisply.
export function setAppZoom(factor) {
  const f = Number(factor) || 1;
  electronAPI?.setZoomFactor?.(f);
}

// ── OS-level notifications ────────────────────────────────────────────────

// Show a system-level (outside-the-app) notification. Today's preload
// doesn't expose this, so it is a silent no-op until it does.
export function showOSNotification(/* opts */) {
  // Intentional no-op. See risk callout in the plan.
}
