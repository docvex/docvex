// Platform adapter — the single module that knows which environment the app
// is running in. Every Electron capability the renderer would otherwise pull
// from `window.electronAPI` (see src/preload.js) goes through here, with a
// web fallback for each entry point. The rest of the app imports from this
// module; nothing else touches `window.electronAPI` directly.
//
// Two flags expose the environment:
//   - `isElectron` — runtime feature detection (presence of window.electronAPI).
//     Use this for runtime branching where the answer might differ from
//     what the build was targeting (e.g. a future "test under web entry
//     during Electron dev" scenario).
//   - `isWebBuild`  — build-time constant from import.meta.env.VITE_TARGET.
//     Use this for code that should be tree-shaken in one build (e.g. a
//     dynamic import of an Electron-only module).
//
// Today these are equivalent in practice; the distinction exists so that
// callers can pick the right semantic.

const electronAPI =
  typeof window !== 'undefined' && window.electronAPI ? window.electronAPI : null;

export const isElectron = !!electronAPI;
export const isWebBuild = import.meta.env.VITE_TARGET === 'web';

// ── App metadata ──────────────────────────────────────────────────────────

// Returns the running app's semver string.
// Electron: IPC to main (reads app.getVersion()).
// Web: Vite inlines VITE_APP_VERSION from package.json at build time.
export async function getAppVersion() {
  if (electronAPI?.getAppVersion) return electronAPI.getAppVersion();
  return import.meta.env.VITE_APP_VERSION ?? '0.0.0-web';
}

// True for packaged Electron builds (i.e. installed via Squirrel, not run
// from `electron-forge start`). Drives the auto-update gating in
// UpdatesContext — a packaged build polls update.electronjs.org; dev and
// web both should not.
export async function isPackaged() {
  if (electronAPI?.isPackaged) return electronAPI.isPackaged();
  return false;
}

// ── External / OAuth URLs ─────────────────────────────────────────────────

// Open an arbitrary URL in the user's default browser.
// Electron: routes through main's shell.openExternal (filtered to http(s)).
// Web: opens in a new tab. noopener prevents the new tab from reading
// window.opener — standard safety for cross-origin links.
export function openExternal(url) {
  if (electronAPI?.openExternal) {
    electronAPI.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
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
// Electron: main opens a fresh BrowserWindow titled "DocVex - <fileName>"
//   with the app icon. The window has no preload + sandbox=true so it
//   can't reach electronAPI.
// Web: no Electron chrome to embed inside, so we fall back to a new
//   browser tab.
export function openFileWindow(url, fileName) {
  if (electronAPI?.openFileWindow) {
    electronAPI.openFileWindow(url, fileName);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

// Open a DOCX with the best-available renderer. Pass whichever
// sources you have — local disk path (My-branch files) and/or a
// signed cloud URL (Cloud-tab files, or My-branch files that have
// a cloud counterpart for the no-Word fallback).
//
// Routing (Electron):
//   1. Word installed → shell.openPath(localPath) when available,
//      else shell.openExternal('ms-word:ofv|u|<cloudUrl>').
//   2. No Word, cloudUrl present → Office Online in BrowserWindow.
//   3. No Word, localPath only → shell.openPath (OS default app).
//
// Routing (web):
//   - cloudUrl present → Office Online in new tab.
//   - localPath only   → no-op (no concept of a local file on web).
export function openDocx({ localPath = null, cloudUrl = null, fileName = 'file' }) {
  if (electronAPI?.openDocx) {
    electronAPI.openDocx({ localPath, cloudUrl, fileName });
    return;
  }
  if (cloudUrl && /^https?:\/\//i.test(cloudUrl)) {
    const officeOnline = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(cloudUrl)}`;
    window.open(officeOnline, '_blank', 'noopener,noreferrer');
  }
}

// Send the user through an OAuth provider's auth URL.
// Electron: pops the OS browser via main; the renderer waits for the
//   docvex:// callback (handled by onDeepLink below).
// Web: full-page redirect — supabase-js completes the flow when the user
//   lands back on /app/auth/callback?code=…
export function openOAuthUrl(url) {
  if (electronAPI?.openOAuthUrl) {
    electronAPI.openOAuthUrl(url);
    return;
  }
  window.location.assign(url);
}

// ── Deep links ────────────────────────────────────────────────────────────

// Subscribe to docvex:// URLs the OS routes back to the app. Returns an
// unsubscribe function. On web this is a no-op — deep links arrive as
// browser navigations and are handled by BrowserRouter directly.
export function onDeepLink(handler) {
  if (!electronAPI?.onOAuthCallback) return () => {};
  electronAPI.onOAuthCallback(handler);
  return () => {
    try { electronAPI.removeOAuthListener?.(); } catch { /* non-fatal */ }
  };
}

// One-shot fetch of any docvex:// URL passed on the command line at COLD
// start (e.g. clicking an invite link when the app isn't running yet).
// Resolves to null when nothing is pending OR on web (browsers don't get
// argv).
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
// fn. No web equivalent — the dev menu doesn't exist there.
export function onAccountSwitch(handler) {
  if (!electronAPI?.onAccountSwitch) return () => {};
  return electronAPI.onAccountSwitch(handler);
}

// ── Auto-updater ──────────────────────────────────────────────────────────

// Trigger a manual update check. Resolves to a status object whose `state`
// field drives the UI:
//   - Electron packaged: 'checking' → autoUpdater events take over
//   - Electron dev:      { state: 'dev' }
//   - Web:               { state: 'web' } — there is no installer to manage
export async function checkForUpdates() {
  if (electronAPI?.checkForUpdates) return electronAPI.checkForUpdates();
  return { state: 'web' };
}

// Trigger Squirrel's quit-and-install path. No-op on web.
export function installUpdate() {
  electronAPI?.installUpdate?.();
}

// Subscribe to autoUpdater lifecycle events. Returns an unsubscribe fn.
// No-op on web.
export function onUpdateStatus(handler) {
  if (!electronAPI?.onUpdateStatus) return () => {};
  return electronAPI.onUpdateStatus(handler);
}

// ── OS-level notifications ────────────────────────────────────────────────

// Show a system-level (outside-the-app) notification. Today's preload
// doesn't expose this — Electron path is a silent no-op until it does.
// Web path is also a no-op for now; revisit if we want to wire the
// browser Notifications API.
export function showOSNotification(/* opts */) {
  // Intentional no-op on both targets. See risk callout in the plan.
}
