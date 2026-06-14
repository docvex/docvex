import { app, BrowserWindow, Menu, ipcMain, shell, autoUpdater, dialog, protocol, nativeImage, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import started from 'electron-squirrel-startup';
import { updateElectronApp } from 'update-electron-app';

// Resolve the path to Word's executable when Microsoft Word is
// installed locally. Electron's `app.getApplicationNameForProtocol`
// only finds Word when the `ms-word:` URL scheme is registered, which
// some Office installs (Microsoft Store / Click-to-Run variants) skip
// or strip — so we ALSO probe the well-known WINWORD.EXE locations
// across Office versions. The first hit wins. Returns null when Word
// can't be found by any method (Linux, macOS without Office, or a
// Windows install we don't recognise).
//
// Splitting "is Word installed?" from "open with Word" means the
// DOCX handler can branch reliably even when the protocol layer is
// flaky: with a real .exe path we can `child_process.spawn(winword,
// [arg])` directly, bypassing the registry entirely.
function getWinwordPath() {
  if (process.platform !== 'win32') return null;
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  // Walk the Click-to-Run layout first (current Microsoft default),
  // then the legacy MSI layout. Office 16 covers 2016 / 2019 / 2021 /
  // 365; 15 = 2013, 14 = 2010. Older isn't worth probing — those
  // versions don't accept HTTPS URLs as command-line args anyway.
  const candidates = [
    `${pf}\\Microsoft Office\\root\\Office16\\WINWORD.EXE`,
    `${pfx86}\\Microsoft Office\\root\\Office16\\WINWORD.EXE`,
    `${pf}\\Microsoft Office\\Office16\\WINWORD.EXE`,
    `${pfx86}\\Microsoft Office\\Office16\\WINWORD.EXE`,
    `${pf}\\Microsoft Office\\Office15\\WINWORD.EXE`,
    `${pfx86}\\Microsoft Office\\Office15\\WINWORD.EXE`,
    `${pf}\\Microsoft Office\\Office14\\WINWORD.EXE`,
    `${pfx86}\\Microsoft Office\\Office14\\WINWORD.EXE`,
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; }
    catch { /* permission denied — try next */ }
  }
  return null;
}

// True when ANY of our Word-detection routes report it's available.
// Falsy when neither the executable nor the protocol handler turns
// up — at that point the DOCX flow falls back to Office Online.
function isWordInstalled() {
  if (getWinwordPath()) return true;
  // Last-ditch: trust Electron's protocol-handler query. Returns
  // empty string when nothing is registered for ms-word:.
  return Boolean(app.getApplicationNameForProtocol('ms-word:'));
}

// Spawn Word as a detached child process. Word accepts EITHER a local
// file path OR an http(s) URL as its first positional argument; for
// URLs it fetches and opens the document itself (no DocVex byte
// handling). `detached` + `unref` so the user can close DocVex without
// killing Word, and stdio:'ignore' so DocVex doesn't accumulate a
// pile of pipes from each Word launch.
function spawnWord(winwordPath, arg) {
  if (!winwordPath || !arg) return false;
  try {
    const child = spawn(winwordPath, [arg], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Custom `localfile://` scheme — lets the renderer load arbitrary
// files from the user's chosen branch folder via `<img src=…>`,
// without flipping webSecurity off. Registration MUST happen before
// app.whenReady because the scheme privileges are global. The actual
// request handler is wired in app.whenReady below.
//
// Privileges:
//   standard        — REQUIRED for fetch + <img> to work. Without it
//                     Chromium treats the scheme as opaque (like
//                     mailto:) and `<img>` loads fail with
//                     ERR_UNKNOWN_URL_SCHEME before the handler runs.
//   secure          — treat as same-origin (so it can be loaded from
//                     http(s) and Vite-served pages)
//   supportFetchAPI — fetch() works against this scheme (future-proof)
//   stream          — large videos / PDFs stream rather than buffer
//   bypassCSP       — allow the renderer's CSP to load it
//   corsEnabled     — without this, `fetch('localfile://…')` from the
//                     Vite dev origin (http://localhost:5173) is blocked
//                     by Chromium CORS before the protocol handler runs.
//                     `<img src>` works without it, but the SHA-256
//                     hashing path uses fetch() to read bytes as a Blob.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'localfile',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);

// Known accounts for the dev-only "Account" menu. Clicking an item sends an
// IPC to the renderer, which signs out of the current Supabase session,
// stashes the target credentials for prefill, and reloads the page so the
// auth screen comes up clean with the email (and optionally password)
// already typed.
//
// Hardcoded because these are the developer's personal test accounts — the
// menu is gated on !app.isPackaged below so distributed builds don't show
// these emails (let alone the password) to other users. An account without
// a `password` field just prefills the email and lets the user type the
// rest manually.
const ACCOUNTS = [
  { email: 'petreluca25@stud.ase.ro', password: 'Hailamasa12345' },
  { email: 'petreluca1105@gmail.com' },
];

if (started) {
  app.quit();
}

// Capture any docvex:// URL passed on the command line at COLD start. The
// `second-instance` event below handles the subsequent-launch case (single-
// instance lock has already routed the URL to us), but on the very first
// launch — when the app wasn't running and the user clicked, say, an invite
// link in their email — nobody else is listening, so we have to scan our
// own argv. The renderer pulls this value via the `app:get-startup-deep-link`
// IPC handle once it's mounted and ready to act on it.
let pendingStartupDeepLink = (process.argv || [])
  .find((arg) => typeof arg === 'string' && arg.startsWith('docvex://')) || null;

// Squirrel-based in-place auto-update only works on Windows for this app.
// The macOS build is NOT Developer-ID signed (forge.config.js ad-hoc signs
// it), so Squirrel.Mac's autoUpdater refuses to apply updates — it emits an
// `error` ("Could not get code signature for running application") and never
// downloads anything. On macOS (and Linux) the renderer falls back to a
// manual browser download of the new build instead — see the `update:check`
// handler and the Updates page's StatusBanner.
const AUTO_UPDATE_SUPPORTED = process.platform === 'win32';

// Auto-update via update.electronjs.org (free, public-repo hosted feed).
// Polls every 10 min, downloads in the background, installs on next launch.
// No-op in dev (`electron-forge start`) — only runs in packaged builds, and
// only on platforms where Squirrel can actually apply the update.
if (app.isPackaged && AUTO_UPDATE_SUPPORTED) {
  updateElectronApp({
    repo: 'petreluca1105-dotcom/docvex',
    updateInterval: '10 minutes',
  });
}

// Branding: report a proper product name instead of the bundle default.
// In a packaged build the macOS dock / menu read the bundle's CFBundleName
// (set from package.json#productName at package time); under
// `electron-forge start` the bundle is plain "Electron", so the dock label
// stays "Electron" in dev — only the packaged app shows "DocVex" there.
// setName still fixes app.getName(), the app menu, and notification source
// names everywhere. Pin userData to its pre-rename location first so the
// rename doesn't move the dev session/cache to a new Application Support
// folder (which would silently log the user out).
const __userDataBeforeRename = app.getPath('userData');
app.setName('DocVex');
app.setPath('userData', __userDataBeforeRename);

// Register custom URL scheme for OAuth callbacks.
// In dev mode (`electron-forge start`), process.defaultApp is true and we must
// pass the path to this app so Windows launches `electron.exe <app-path> docvex://...`
// rather than `electron.exe docvex://...` (which tries to treat the URL as an app path).
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('docvex', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('docvex');
}

// Enforce single instance so second launch delivers the OAuth URL here.
// DEV ESCAPE HATCH: when DOCVEX_ALLOW_MULTI is set (used by
// `npm run start:multi` to spin up multiple parallel dev instances
// for testing realtime / multi-user flows from one machine), skip the
// lock entirely so each child electron-forge process can boot its
// own window. OAuth callbacks won't be delivered between instances
// in this mode — that's the trade-off for parallel testing.
const allowMulti = Boolean(process.env.DOCVEX_ALLOW_MULTI);
if (!allowMulti) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  }
}

let mainWindow = null;

// ── Multi-monitor / window-state persistence ───────────────────────────────
// Remember where the main window last lived (which monitor + size) so the next
// launch reopens it on the same display, and pin every SECONDARY window (doc
// viewer, file viewers) to whichever monitor the main window is currently on.
// State is a tiny JSON file in userData. All of `screen` is only valid after
// the app is ready, but these run at window-creation time, so that holds.
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch { /* no/invalid state — fall back to defaults */ }
  return null;
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    // getNormalBounds() is the restored (non-maximized) rect, so we can reopen
    // at the user's chosen size even when they quit while maximized.
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    const state = {
      x: b.x, y: b.y, width: b.width, height: b.height,
      maximized: win.isMaximized(), fullscreen: win.isFullScreen(),
    };
    fs.writeFileSync(windowStateFile(), JSON.stringify(state));
  } catch { /* best-effort */ }
}

// A saved rect is only usable if it still overlaps a CONNECTED display — a
// monitor may have been unplugged or rearranged since last launch. Require a
// decent overlap so the (grabbable) title bar can't land off-screen.
function boundsAreOnScreen(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return false;
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    const ix = Math.max(b.x, wa.x);
    const iy = Math.max(b.y, wa.y);
    const ax = Math.min(b.x + b.width, wa.x + wa.width);
    const ay = Math.min(b.y + b.height, wa.y + wa.height);
    return ax - ix > 96 && ay - iy > 64;
  });
}

// Center a width×height rect within the work area of the display that currently
// holds `refWin` (the main window) — used to open every secondary window on the
// same monitor as the base app. Falls back to the primary display.
function centeredOnDisplayOf(refWin, width, height) {
  let display;
  try {
    display = refWin && !refWin.isDestroyed()
      ? screen.getDisplayMatching(refWin.getBounds())
      : screen.getPrimaryDisplay();
  } catch {
    display = screen.getPrimaryDisplay();
  }
  const wa = display.workArea;
  const w = Math.min(width, wa.width);
  const h = Math.min(height, wa.height);
  return {
    width: w,
    height: h,
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + (wa.height - h) / 2),
  };
}

// Latest known update status. Kept here so renderers that mount after an
// event has already fired can still recover the current state on request.
let updateStatus = { state: 'idle' };

const sendUpdateStatus = (payload) => {
  updateStatus = payload;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', payload);
  }
};

// Hand off the account switch to the renderer via IPC. The renderer owns
// the Supabase client (the session lives in its localStorage) and the
// React-Router state, so the actual signOut + page-refresh has to happen
// there. Main's only job is to ferry the target credentials across the
// bridge. Password is optional — accounts without one just prefill the
// email and let the user type the password manually.
function switchAccount(account) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('account:switch-to', {
      email: account.email,
      password: account.password || null,
    });
  }
}

// The previous custom application menu (File / Edit / View / Window / Account
// / DEBUG submenus) has been removed — we now run with no native menu bar at
// all. The dev-only DEBUG actions it used to host moved into an in-app
// "Debug" page in the renderer's Personal sidebar section (see
// src/pages/Debug.jsx), so they no longer need IPC round-trips through main.

// Wire autoUpdater events → renderer. update-electron-app drives the actual
// checkForUpdates / setFeedURL calls; we just observe. Skipped on platforms
// where the autoUpdater can't run (see AUTO_UPDATE_SUPPORTED) so the macOS
// build doesn't emit spurious 'error' status events from a no-op updater.
if (app.isPackaged && AUTO_UPDATE_SUPPORTED) {
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }));
  autoUpdater.on('update-available', () => sendUpdateStatus({ state: 'downloading' }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ state: 'up-to-date' }));
  autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
    sendUpdateStatus({ state: 'downloaded', releaseName, releaseNotes });
  });
  autoUpdater.on('error', (err) => {
    sendUpdateStatus({ state: 'error', message: String(err?.message || err) });
  });
}

// Restore DevTools access on a window. The app removes the native menu
// (setApplicationMenu(null) + per-window removeMenu()), which ALSO strips the
// default DevTools keyboard accelerators (F12 / Ctrl+Shift+I / Cmd+Opt+I) that
// the menu's `toggleDevTools` role provided. We re-add them per-window via the
// raw input event, plus a right-click "Inspect element" context menu, so the
// inspector is reachable again even without a menu bar.
function wireDevtoolsShortcuts(win) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const isF12 = key === 'f12';
    // Ctrl+Shift+I (Win/Linux) or Cmd+Opt+I (macOS).
    const isInspectCombo =
      key === 'i' &&
      input.shift &&
      (input.control || input.meta) &&
      (process.platform === 'darwin' ? input.alt : true);
    if (isF12 || isInspectCombo) {
      event.preventDefault();
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools();
    }
  });
  // Right-click → "Inspect element" at the cursor.
  wc.on('context-menu', (_event, params) => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Inspect element',
        click: () => {
          wc.inspectElement(params.x, params.y);
          if (!wc.isDevToolsOpened()) wc.openDevTools();
        },
      },
    ]);
    menu.popup({ window: win });
  });
}

// Shared factory for an app window (the main window OR the doc-viewer window).
// All windows are frameless with the renderer-drawn title bar; `query` is
// appended to the loaded URL (e.g. `?docViewer=1`) so the renderer can boot
// straight into a specific surface. `openDevtools` only for the primary window
// so the doc-viewer window doesn't pop its own devtools.
// Default app-window size — used as the launch fallback AND as the fixed size
// the signed-out (auth) screen pins the window to. Kept in one place so the two
// can't drift.
const DEFAULT_WINDOW_SIZE = { width: 1200, height: 750 };

function createAppWindow({ query, openDevtools = false, bounds = null } = {}) {
  const win = new BrowserWindow({
    // `bounds` pins size + monitor: restored main-window state on launch, or a
    // rect centered on the main window's display for secondary windows. Without
    // it Electron centers a default-sized window on the primary display.
    width: bounds?.width ?? DEFAULT_WINDOW_SIZE.width,
    height: bounds?.height ?? DEFAULT_WINDOW_SIZE.height,
    ...(bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
      ? { x: bounds.x, y: bounds.y }
      : {}),
    // Floor on how small the user can drag the window. Below this the sidebar
    // + layout start to crowd; 900×600 keeps the chrome usable.
    minWidth: 900,
    minHeight: 600,
    title: 'DocVex',
    // Title-bar chrome: the renderer draws its own bar (src/components/TitleBar.jsx).
    //  • Windows / Linux — fully frameless (frame:false strips the OS title bar
    //    AND its min/max/close buttons); the renderer supplies custom controls.
    //  • macOS — `titleBarStyle:'hidden'` keeps the native traffic-light buttons
    //    (close / minimize / zoom) at top-left, which users expect, while hiding
    //    the rest of the OS bar so our custom bar shows through. The bar is 44px
    //    tall (--titlebar-h in index.css, same as Win/Linux). trafficLightPosition
    //    is the TOP-LEFT inset of the ~12px-tall button cluster, so to centre it
    //    vertically in the 44px bar — VS Code's tight look — y = (44-12)/2 ≈ 16.
    //    x:19 puts the first light a hair in from the left, matching VS Code. The
    //    renderer insets its brand to clear them and hides its own window controls
    //    (is-mac CSS). Nudge `y` a px or two if the lights look high or low.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 13, y: 10 } }
      : { frame: false }),
    icon: path.join(__dirname, 'appicon_desktop.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Tell this window's title bar when its OS maximized state flips (double-
  // click drag region, Win+Up, snap, etc.) so it can swap the maximize⇄restore
  // glyph. The renderer also queries the initial state via window:is-maximized.
  const sendMaxState = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:maximized-changed', win.isMaximized());
    }
  };
  win.on('maximize', sendMaxState);
  win.on('unmaximize', sendMaxState);

  // Tell the title bar when this window enters/leaves native fullscreen. On
  // macOS fullscreen hides the traffic-light buttons, so the renderer drops the
  // brand's left inset that normally clears them (is-fullscreen CSS).
  const sendFullscreenState = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:fullscreen-changed', win.isFullScreen());
    }
  };
  win.on('enter-full-screen', sendFullscreenState);
  win.on('leave-full-screen', sendFullscreenState);

  // No native menu bar (per-window on Windows, so removeMenu each window).
  win.removeMenu();
  // Removing the menu also drops the default DevTools accelerators — re-add them.
  wireDevtoolsShortcuts(win);

  // Let the renderer drive the taskbar / dock / Alt-Tab title (there's no
  // in-window OS title bar). The app sets document.title per window via
  // <WindowTitle> — "DocVex — Hub", "DocVex — <project>", "DocVex — <file>" —
  // so each instance is distinguishable in the macOS Window menu / dock. We do
  // NOT preventDefault here, so Chromium mirrors document.title onto the window
  // title. index.html ships "DocVex" as the pre-mount fallback.

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}${qs}`);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      query ? { query } : undefined,
    );
  }

  if (openDevtools) win.webContents.openDevTools();
  return win;
}

const createWindow = () => {
  // Reopen on the same monitor + size as last time, when that display is still
  // connected (otherwise let Electron center on the primary display).
  const saved = readWindowState();
  const bounds = saved && boundsAreOnScreen(saved) ? saved : null;
  mainWindow = createAppWindow({ openDevtools: true, bounds });
  // Restore the maximized / fullscreen state the user left it in.
  if (saved?.maximized) mainWindow.maximize();
  if (saved?.fullscreen) mainWindow.setFullScreen(true);
  // Persist size + position (i.e. which monitor) for next launch. Debounced on
  // move/resize so a force-quit still leaves a recent state; flushed on close.
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(mainWindow), 400);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('close', () => { clearTimeout(saveTimer); saveWindowState(mainWindow); });
};

// Document-viewer window — opened from the Files page when a file is double-
// clicked. There is a SINGLE shared window with Chrome-style tabs: the first
// file boots the window at /doc-viewer with the file in the query; every
// subsequent file is pushed into the existing window as a new tab via
// `doc-viewer:add-file` (the renderer appends/activates the tab).
let docViewerWindow = null;
function createDocViewerWindow(file) {
  if (docViewerWindow && !docViewerWindow.isDestroyed()) {
    if (docViewerWindow.isMinimized()) docViewerWindow.restore();
    docViewerWindow.focus();
    docViewerWindow.webContents.send('doc-viewer:add-file', file || {});
    return;
  }
  const query = { docViewer: '1' };
  if (file?.path) query.path = file.path;
  if (file?.name) query.name = file.name;
  if (file?.mime) query.mime = file.mime;
  // Open on the same monitor as the base app.
  docViewerWindow = createAppWindow({ query, bounds: centeredOnDisplayOf(mainWindow, 1200, 800) });
  docViewerWindow.on('closed', () => { docViewerWindow = null; });
}
ipcMain.on('window:open-doc-viewer', (_, file) => createDocViewerWindow(file));

// Extract readable text from a legacy .doc (OLE binary) via word-extractor in
// the main process — the sandboxed renderer can't parse that format. Returns
// { text } or { error }; the doc viewer renders the text. word-extractor is
// lazy-imported so its weight isn't paid until a .doc is actually opened.
ipcMain.handle('doc:extract-text', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { error: 'no_path' };
  try {
    const { default: WordExtractor } = await import('word-extractor');
    const doc = await new WordExtractor().extract(filePath);
    return { text: (doc.getBody() || '').trim() };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
});

// ── WhatsApp export (.zip) → extract + locate the chat transcript ──────
// WhatsApp's "Export chat" produces a .zip holding the transcript (`_chat.txt`
// on iOS, "WhatsApp Chat with NAME.txt" on Android) plus every media file. To
// reconstruct the conversation we extract the zip to a temp folder ONCE
// (cached by the zip's path+size+mtime so re-opening is instant) and hand the
// doc-viewer the on-disk path of the transcript — its media siblings then load
// straight from that temp folder via localfile://, reusing the normal renderer.
//
// A WhatsApp line starts with a bracketed/locale-loose timestamp; this signature
// keeps us from hijacking arbitrary zips that merely happen to contain a .txt.
const WHATSAPP_SIGNATURE = /(^|\n)[\s‎‏]*\[?\s*\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}:\d{2}/;

// Recursively find the best transcript candidate inside an extracted export.
// Preference: an exact `_chat.txt` → a "WhatsApp Chat …".txt → the largest .txt.
async function findChatTranscript(dir, depth = 0) {
  let exact = null;
  let named = null;
  let largest = null;
  let largestSize = -1;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (depth >= 4) continue; // exports are flat / one level — cap the walk
      const nested = await findChatTranscript(full, depth + 1);
      if (nested) { if (/(^|[\\/])_chat\.txt$/i.test(nested)) return nested; named = named || nested; }
      continue;
    }
    if (!/\.txt$/i.test(ent.name)) continue;
    if (/^_chat\.txt$/i.test(ent.name)) exact = full;
    else if (/whatsapp chat/i.test(ent.name)) named = named || full;
    try { const st = await fsp.stat(full); if (st.size > largestSize) { largestSize = st.size; largest = full; } } catch { /* skip */ }
  }
  return exact || named || largest;
}

async function looksLikeWhatsApp(filePath) {
  try {
    const fd = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(16 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      return WHATSAPP_SIGNATURE.test(buf.slice(0, bytesRead).toString('utf8'));
    } finally { await fd.close(); }
  } catch { return false; }
}

ipcMain.handle('whatsapp:prepare-zip', async (_e, zipPath) => {
  if (typeof zipPath !== 'string' || !/\.zip$/i.test(zipPath)) return { ok: false };
  try {
    const stat = await fsp.stat(zipPath);
    const { createHash } = await import('node:crypto');
    const key = createHash('sha1').update(`${zipPath}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 16);
    const destDir = path.join(app.getPath('temp'), 'docvex-wa', key);

    // Reuse a previous extraction when the chat transcript is already present.
    let chatPath = await findChatTranscript(destDir);
    if (!chatPath) {
      await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(destDir, { recursive: true });
      const { default: extract } = await import('extract-zip');
      await extract(zipPath, { dir: destDir });
      chatPath = await findChatTranscript(destDir);
    }
    if (!chatPath || !(await looksLikeWhatsApp(chatPath))) return { ok: false };

    // Friendly tab name: the Android transcript names itself; iOS `_chat.txt`
    // is anonymous, so fall back to the zip's own filename.
    const base = path.basename(chatPath);
    const name = /^_chat\.txt$/i.test(base)
      ? path.basename(zipPath).replace(/\.zip$/i, '')
      : base.replace(/\.txt$/i, '');
    return { ok: true, chatPath, name };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// ── WhatsApp recognition for the Files tab (content-based) ──────────────
// Given folder / .zip paths, decide whether each one IS a WhatsApp export by
// looking INSIDE it (transcript file + timestamp signature) — never at the
// path's own name, so a renamed export keeps its WhatsApp mark in the file
// grid. Verdicts are memoised per path+size+mtime for the app's lifetime.
const waDetectCache = new Map();

// Does the zip contain a WhatsApp transcript? Scans the central directory
// lazily (yauzl — already in the tree as extract-zip's engine) and signature-
// tests the first bytes of the first few .txt entries, so a multi-hundred-MB
// export is decided from a couple of KB without extracting anything.
async function zipContainsWhatsAppChat(zipPath) {
  const { default: yauzl } = await import('yauzl');
  return new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) { resolve(false); return; }
      let txtTested = 0;
      let settled = false;
      const finish = (verdict) => {
        if (settled) return;
        settled = true;
        try { zf.close(); } catch { /* already closed */ }
        resolve(verdict);
      };
      zf.on('entry', (entry) => {
        const isTxt = !/\/$/.test(entry.fileName) && /\.txt$/i.test(entry.fileName);
        if (!isTxt || txtTested >= 6) { zf.readEntry(); return; }
        txtTested += 1;
        zf.openReadStream(entry, (e2, rs) => {
          if (e2 || !rs) { zf.readEntry(); return; }
          let head = '';
          let judged = false;
          const judge = () => {
            if (judged || settled) return;
            judged = true;
            if (WHATSAPP_SIGNATURE.test(head)) finish(true);
            else zf.readEntry();
          };
          rs.on('data', (d) => {
            head += d.toString('utf8');
            if (head.length >= 16 * 1024) { judge(); rs.destroy(); }
          });
          rs.on('end', judge);
          rs.on('error', judge);
        });
      });
      zf.on('end', () => finish(false));
      zf.on('error', () => finish(false));
      zf.readEntry();
    });
  });
}

ipcMain.handle('whatsapp:detect', async (_e, paths) => {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [];
  const out = {};
  await Promise.all(list.map(async (p) => {
    try {
      const st = await fsp.stat(p);
      const key = `${p}:${st.size}:${st.mtimeMs}`;
      if (waDetectCache.has(key)) { out[p] = waDetectCache.get(key); return; }
      let hit = false;
      if (st.isDirectory()) {
        // An extracted export: a folder whose transcript passes the signature
        // test. Reuses the same walk the zip-open path uses.
        const chatPath = await findChatTranscript(p);
        hit = Boolean(chatPath && (await looksLikeWhatsApp(chatPath)));
      } else if (/\.zip$/i.test(p)) {
        hit = await zipContainsWhatsAppChat(p);
      }
      waDetectCache.set(key, hit);
      out[p] = hit;
    } catch {
      out[p] = false;
    }
  }));
  return out;
});

// On Windows: when the OS opens docvex:// in a second instance, argv contains the URL
app.on('second-instance', (_, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const callbackUrl = argv.find((arg) => arg.startsWith('docvex://'));
  if (callbackUrl && mainWindow) {
    mainWindow.webContents.send('oauth:callback-url', callbackUrl);
  }
});

// On macOS: the OS fires open-url instead of launching a second instance
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('docvex://') && mainWindow) {
    mainWindow.webContents.send('oauth:callback-url', url);
  }
});

// Let the renderer open URLs in the system browser (needed for OAuth + release links)
ipcMain.on('oauth:open-external', (_, url) => {
  shell.openExternal(url);
});

// Generic external-URL opener (release links, GitHub, etc.). Only allow
// http(s) so a compromised renderer can't trigger arbitrary protocol handlers.
ipcMain.on('app:open-external', (_, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

// Custom window controls — the window is frameless (frame:false), so the
// renderer's title bar owns minimize / maximize / close. Multi-window now, so
// each control acts on the window that SENT the event (not just mainWindow).
// The renderer queries the current maximized state on mount and subscribes to
// changes so it shows the right maximize⇄restore glyph.
ipcMain.on('window:minimize', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize();
});
ipcMain.on('window:toggle-maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  // Respect the auth-screen lock: when the window is pinned non-maximizable
  // (signed-out screen), the custom title bar's maximize button is inert so
  // the lock can't be bypassed.
  if (!w.isMaximizable()) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on('window:close', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});
ipcMain.handle('window:is-maximized', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return !!(w && w.isMaximized());
});
ipcMain.handle('window:is-fullscreen', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return !!(w && w.isFullScreen());
});

// Window sizing driven by the signed-out (auth) screen — AuthPage sends these
// as it mounts/unmounts. Acts on the window that sent the event.
//   'locked' → entering the login screen: drop maximize/fullscreen, pin to the
//              default size, and disable resizing/maximizing (a focused window).
//   'app'    → just signed in: restore resizing and fill the screen (maximize).
//   'unlock' → left the login screen without signing in (e.g. back to a public
//              page): just restore resizing, leave size/position alone.
ipcMain.on('window:auth-state', (e, state) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return;
  if (state === 'locked') {
    if (w.isFullScreen()) w.setFullScreen(false);
    if (w.isMaximized()) w.unmaximize();
    w.setResizable(false);
    w.setMaximizable(false);
    w.setFullScreenable(false);
    w.setSize(DEFAULT_WINDOW_SIZE.width, DEFAULT_WINDOW_SIZE.height);
    w.center();
    return;
  }
  // 'app' or 'unlock' — both restore interactive sizing.
  w.setResizable(true);
  w.setMaximizable(true);
  w.setFullScreenable(true);
  if (state === 'app' && !w.isMaximized()) w.maximize();
});

// Quit the entire app — fired by a deliberate logout. Closes every window
// (each runs its own close handler, so the main window still persists its
// bounds) and exits the process.
ipcMain.on('app:quit', () => {
  app.quit();
});

// Resolve the bundled favicon path ONCE at module load. The previous
// inline `path.join(__dirname, 'favicon.ico')` only worked in dev mode
// (where __dirname is the source `src/` directory). In packaged
// builds __dirname is `app.asar/.vite/build/` and the icon doesn't
// live there, so the BrowserWindow silently fell back to Electron's
// generic icon. `app.getAppPath()` returns the project root in dev
// and the app.asar root in packaged — same relative path resolves in
// both. If the file is missing for some reason we leave it null and
// the BrowserWindow inherits the .exe's embedded icon (which was set
// from the same favicon by electron-packager's packagerConfig).
const APP_ICON_PATH = (() => {
  try {
    const p = path.join(app.getAppPath(), 'src', 'favicon.ico');
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();

// Floating "READ ONLY" pill injected into every cloud-URL viewer
// window — same visual recipe as ProjectBanner.css's "Working in"
// pill (top-centre, fixed, gold-cognac fill, rounded ends, soft
// shadow). Colours are inlined because the loaded page is a remote
// origin (Supabase storage, view.officeapps.live.com) where our
// :root token variables aren't available.
//
// The script runs in the loaded page's main frame after every
// successful navigation — Chromium's PDF viewer, the image/video
// auto-wrapper, and Office Online all expose a `document.body` we
// can append to. The dataset marker keeps the inject idempotent so
// SPA navigations / cross-origin redirects don't stack multiple
// pills. Office Online and the PDF viewer ARE cross-origin from
// our window, but executeJavaScript runs in the page's own context
// so same-origin rules don't apply.
const READ_ONLY_PILL_INJECT = `
(() => {
  if (document.getElementById('docvex-read-only-pill')) return;
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => {
      window.__docvexInjectPill && window.__docvexInjectPill();
    }, { once: true });
    return;
  }
  const pill = document.createElement('div');
  pill.id = 'docvex-read-only-pill';
  pill.textContent = 'READ ONLY';
  pill.setAttribute('aria-label', 'Read-only view');
  pill.style.cssText = [
    'position: fixed',
    'top: 0.75rem',
    'left: 50%',
    'transform: translateX(-50%)',
    'z-index: 2147483647',
    'display: inline-flex',
    'align-items: center',
    'justify-content: center',
    'background: #8B4513',
    'color: #FFF8E7',
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif',
    'font-size: 0.78rem',
    'font-weight: 700',
    'letter-spacing: 0.08em',
    'border-radius: 999px',
    'border: 1px solid rgba(255, 248, 231, 0.18)',
    'line-height: 1.4',
    'padding: 0.4rem 1rem',
    'white-space: nowrap',
    'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32)',
    'pointer-events: none',
    'user-select: none',
  ].join(';') + ';';
  document.body.appendChild(pill);
})();
`;

// Helper — wraps the "open this URL inside a DocVex BrowserWindow"
// boilerplate used by every in-app viewer path (raw-load + Office
// Online). Title is pinned against page-title-updated so Chromium's
// PDF viewer / Office Online iframe can't overwrite our chrome.
//
// Cloud-URL opens (https://…) get a "(READ ONLY)" suffix on the
// title AND a floating pill injected into the page (see
// READ_ONLY_PILL_INJECT above) because the signed Supabase URL is
// GET-only — any edit attempt inside Office Online / PDF.js / a
// video element has nowhere to save back to. localfile:// URLs
// render the user's own local working copy, which IS editable via
// the OS, so neither the title marker nor the pill applies there.
function openInAppWindow(url, fileName) {
  const isCloud = /^https?:\/\//i.test(url);
  const title = isCloud
    ? `DocVex - ${fileName} (READ ONLY)`
    : `DocVex - ${fileName}`;
  // Open on the same monitor as the base app.
  const pos = centeredOnDisplayOf(mainWindow, 1100, 800);
  const opts = {
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    title,
    // No preload + sandbox defaults: this window only renders the
    // signed file URL / external viewer page, it never needs access
    // to electronAPI / fs.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (APP_ICON_PATH) opts.icon = APP_ICON_PATH;
  const win = new BrowserWindow(opts);
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle(title);
  });
  win.setMenu(null);
  wireDevtoolsShortcuts(win);

  if (isCloud) {
    // Re-inject on every navigation — Office Online does internal
    // redirects to its rendering host (officeapps.live.com →
    // word-edit.officeapps.live.com), and Chromium's PDF viewer
    // counts as its own navigation. Each navigation rebuilds
    // document.body, dropping the previously-injected node.
    const inject = () => {
      win.webContents.executeJavaScript(READ_ONLY_PILL_INJECT, true)
        .catch(() => { /* page may have torn down mid-inject; harmless */ });
    };
    win.webContents.on('did-finish-load', inject);
    win.webContents.on('did-frame-finish-load', (_e, isMainFrame) => {
      if (isMainFrame) inject();
    });
  }

  win.loadURL(url);
  return win;
}

// Open a file URL inside its own in-app BrowserWindow — replaces the
// shell.openExternal path for "View" so images / videos / PDFs render
// inside DocVex's chrome (titled "DocVex - <filename>" with the app
// icon) instead of being handed off to the user's default browser.
//
// Allowed URL schemes for the file URL:
//   • http(s)    — signed Supabase URLs for cloud-backed files.
//   • localfile  — our own protocol handler (registered above) for
//                  My-branch files on disk.
// Other schemes are rejected — keeps a compromised renderer from
// smuggling a navigation that bypasses our security model.
//
// DOCX has its own IPC (`app:open-docx`) because the routing fans
// out: try Word locally → fall back to Office Online → fall back
// to OS default. That logic doesn't belong wedged inside this
// browser-native-types path.
ipcMain.on('app:open-file-window', (_, payload) => {
  const url = payload?.url;
  const fileName = typeof payload?.fileName === 'string' ? payload.fileName : 'file';
  if (typeof url !== 'string') return;
  if (!/^https?:\/\//i.test(url) && !/^localfile:\/\//i.test(url)) return;
  openInAppWindow(url, fileName);
});

// Open an arbitrary HTML string in its own in-app window. Used by the
// .docx viewer: Chromium can't render .docx bytes natively, so the
// renderer rasterizes the document to self-contained HTML via
// docx-preview (styles inlined, images base64) and hands the markup
// here. We stage it to a temp file and loadFile() it — top-level data:
// URL navigation is blocked by Chromium, and the sandboxed renderer
// can't write files itself. The temp file is deleted once the window has
// parsed it (the inlined assets mean nothing references it afterwards).
async function openHtmlContentWindow(html, fileName) {
  const title = `DocVex - ${fileName} (READ ONLY)`;
  // Open on the same monitor as the base app.
  const pos = centeredOnDisplayOf(mainWindow, 1100, 800);
  const opts = {
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    title,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (APP_ICON_PATH) opts.icon = APP_ICON_PATH;
  const win = new BrowserWindow(opts);
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle(title);
  });
  win.setMenu(null);
  wireDevtoolsShortcuts(win);

  const tmpFile = path.join(
    app.getPath('temp'),
    `docvex-docx-${Date.now()}-${Math.random().toString(36).slice(2)}.html`,
  );
  try {
    await fsp.writeFile(tmpFile, html, 'utf8');
  } catch {
    win.destroy();
    return;
  }
  const cleanup = () => { fsp.unlink(tmpFile).catch(() => { /* temp dir self-cleans */ }); };
  win.webContents.once('did-finish-load', cleanup);
  win.on('closed', cleanup);
  win.loadFile(tmpFile);
}

ipcMain.on('app:open-html-window', (_, payload) => {
  const html = typeof payload?.html === 'string' ? payload.html : null;
  const fileName = typeof payload?.fileName === 'string' ? payload.fileName : 'file';
  if (!html) return;
  openHtmlContentWindow(html, fileName);
});

// Open a DOCX, walking a fallback chain so the user always gets the
// best available render:
//
//   1. WINWORD.EXE found on disk (most reliable detection — see
//      getWinwordPath above) → spawn Word directly with the file
//      path or URL as a positional arg. Bypasses the registry, so it
//      works for Click-to-Run, Microsoft Store, and MSI installs
//      even when the ms-word: protocol isn't registered.
//
//   2. ms-word: URL scheme registered (fallback for unusual installs
//      where WINWORD.EXE lives somewhere we didn't probe)
//      a. localPath → shell.openPath. Whatever app the OS has
//         registered for .docx — Word when it's the default.
//      b. cloudUrl → shell.openExternal('ms-word:ofe|u|<url>').
//         Word fetches the URL itself; `ofe` = open for edit.
//
//   3. No Word, cloudUrl available → Office Online viewer
//      (https://view.officeapps.live.com/op/view.aspx?src=…) rendered
//      inside an in-app BrowserWindow. Microsoft's servers fetch the
//      signed URL and produce a full-fidelity Word render.
//
//   4. No Word, only localPath → shell.openPath. OS picks whatever
//      DOCX handler the user has, or surfaces an "Open with…" dialog.
//
// `ms-word:` URL grammar:
//   ms-word:ofv|u|<url>   — open for view (read-only).
//   ms-word:ofe|u|<url>   — open for edit (DocVex uses this so the
//                           user can edit immediately on open).
// Reference: https://learn.microsoft.com/office/client-developer/office-uri-schemes
//
// Routing:
//   • cloudUrl present  → Office Online (web Word) in a new DocVex
//                          BrowserWindow. Unconditional — no more
//                          "try local Word first" detour. Office
//                          Online's view UI is consistent on every
//                          machine and matches the read-only semantics
//                          of a signed Supabase URL (which is GET-
//                          only — Word's local Save would fail with
//                          a 403 anyway, then drop into a confusing
//                          Save-As dialog). The user explicitly asked
//                          for "the web version of Word" for cloud
//                          DOCX, so the local-Word branch is gone.
//   • localPath only    → local file on disk. Local Word handles
//                          this best (in-place save + watcher picks
//                          up the edit). Fall back to `ms-word:` URL
//                          scheme, then to `shell.openPath` so the
//                          OS default DOCX handler takes over.
ipcMain.on('app:open-docx', (_, payload) => {
  const localPath = typeof payload?.localPath === 'string' && payload.localPath
    ? payload.localPath
    : null;
  const rawCloudUrl = typeof payload?.cloudUrl === 'string' ? payload.cloudUrl : null;
  const cloudUrl = rawCloudUrl && /^https?:\/\//i.test(rawCloudUrl) ? rawCloudUrl : null;
  const fileName = typeof payload?.fileName === 'string' ? payload.fileName : 'file';
  if (!localPath && !cloudUrl) return;

  // Cloud DOCX → Office Online viewer in a fresh window. The
  // openInAppWindow helper handles the title (DocVex - <name>
  // (READ ONLY)), the icon, and the floating READ ONLY pill inject.
  if (cloudUrl) {
    const officeOnlineUrl = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(cloudUrl)}`;
    openInAppWindow(officeOnlineUrl, fileName);
    return;
  }

  // Local DOCX → keep the Word-on-disk chain so the user can edit
  // in place. Local Word saves directly to the file; our watcher
  // picks the change up into the diff layer like any other edit.
  const winwordPath = getWinwordPath();
  if (winwordPath && spawnWord(winwordPath, localPath)) return;
  if (app.getApplicationNameForProtocol('ms-word:')) {
    shell.openPath(localPath);
    return;
  }
  // No Word installed — let the OS pick whatever DOCX handler the
  // user has registered.
  shell.openPath(localPath);
});

// Update IPC ---------------------------------------------------------------
ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:is-packaged', () => app.isPackaged);
// OS + CPU arch for the running build. The renderer uses this to pick the
// right release asset for the manual-download update fallback (e.g. the
// arm64 vs x64 macOS zip) — see UpdatesContext.installerAssetFor.
ipcMain.handle('app:get-platform-info', () => ({
  platform: process.platform,
  arch: process.arch,
}));

// One-shot pull of a docvex:// URL captured at cold start (see argv scan
// above). Renderer calls this once during AuthContext mount; we hand back
// the URL and clear it so a remount (StrictMode double-effect in dev) or a
// later refetch can't replay the deep-link. Returns null when nothing is
// pending. The `second-instance` event continues to push subsequent URLs
// via the `oauth:callback-url` channel — this handle is only for the
// FIRST-launch race that the event misses.
ipcMain.handle('app:get-startup-deep-link', () => {
  const url = pendingStartupDeepLink;
  pendingStartupDeepLink = null;
  return url;
});

ipcMain.handle('update:check', async () => {
  // Return last-known status synchronously; autoUpdater.checkForUpdates is
  // a no-op in dev (Squirrel can't update an unpackaged app).
  if (!app.isPackaged) return { state: 'dev' };
  // macOS/Linux: unsigned build — Squirrel can't apply updates in place. Tell
  // the renderer to use its manual browser-download fallback instead of
  // spinning forever on a 'checking' state that never resolves.
  if (!AUTO_UPDATE_SUPPORTED) return { state: 'unsupported' };
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    sendUpdateStatus({ state: 'error', message: String(err?.message || err) });
  }
  return updateStatus;
});

ipcMain.on('update:install', () => {
  if (app.isPackaged && updateStatus.state === 'downloaded') {
    autoUpdater.quitAndInstall();
  }
});

// ── macOS self-update ──────────────────────────────────────────────────────
// The macOS build isn't Developer-ID signed, so Squirrel.Mac's autoUpdater
// can't apply updates (see AUTO_UPDATE_SUPPORTED). To still give Mac users a
// one-click "update my app" button, we reimplement the essential steps that
// Squirrel.Mac would otherwise do: download the new build's .zip, extract it,
// swap the running .app bundle for the new one, and relaunch. No signature
// verification — acceptable for a self-distributed app. Because we replace the
// ENTIRE bundle (matching binary + asar together), the embedded-asar-integrity
// fuse stays satisfied.

// Resolve the running app's .app bundle from the executable path, e.g.
// /Applications/docvex.app/Contents/MacOS/docvex → /Applications/docvex.app.
// Returns null when not running from a bundle (dev / bare binary).
function currentMacAppBundle() {
  const marker = '.app/Contents/MacOS/';
  const idx = process.execPath.indexOf(marker);
  return idx === -1 ? null : process.execPath.slice(0, idx + 4); // keep ".app"
}

// Find the first *.app directory within `dir` (one level deep, then nested).
async function findDotApp(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && e.name.endsWith('.app')) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const nested = await findDotApp(path.join(dir, e.name));
      if (nested) return nested;
    }
  }
  return null;
}

// Stream a URL to disk, reporting integer percent via onProgress (best-effort:
// only fires when the server sends Content-Length).
async function downloadToFile(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let lastPct = -1;
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
      if (total && onProgress) {
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.end(resolve);
    });
  }
}

// Run a command, resolving on exit 0 and rejecting otherwise.
function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)),
    );
  });
}

ipcMain.handle('update:download-and-install', async (_evt, payload) => {
  const url = payload?.url;
  if (process.platform !== 'darwin') return { ok: false, error: 'Auto-install is only supported on macOS here.' };
  if (!app.isPackaged) return { ok: false, error: 'Auto-install only works in the installed app.' };
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'No valid download URL for this build.' };
  }
  const currentApp = currentMacAppBundle();
  if (!currentApp) return { ok: false, error: "Couldn't locate the installed app bundle." };

  let work;
  try {
    work = await fsp.mkdtemp(path.join(app.getPath('temp'), 'docvex-update-'));
    const zipPath = path.join(work, 'update.zip');
    const extractDir = path.join(work, 'extracted');
    await fsp.mkdir(extractDir, { recursive: true });

    // 1. Download the new build.
    sendUpdateStatus({ state: 'downloading', percent: 0 });
    await downloadToFile(url, zipPath, (percent) => {
      sendUpdateStatus({ state: 'downloading', percent });
    });

    // 2. Extract. ditto restores the framework symlinks + exec bits the zip
    //    stored (make-mac-zips.mjs preserves them as real symlinks).
    sendUpdateStatus({ state: 'installing' });
    await runCommand('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);

    // 3. Locate the new bundle.
    const newApp = await findDotApp(extractDir);
    if (!newApp) throw new Error('No .app found inside the downloaded archive.');

    // 4. Stage the new bundle right next to the target (same volume → atomic
    //    rename later) BEFORE we touch the installed app. Doing the copy now
    //    means a permission failure (e.g. no write access to /Applications)
    //    surfaces here, harmlessly, instead of mid-swap.
    const stagedApp = `${currentApp}.docvex-new`;
    const backupApp = `${currentApp}.docvex-old`;
    await fsp.rm(stagedApp, { recursive: true, force: true });
    await runCommand('/usr/bin/ditto', [newApp, stagedApp]);

    // 4b. Ad-hoc re-sign the staged bundle. The published macOS builds have
    //     their Electron fuses flipped AFTER the (linker) ad-hoc signature is
    //     applied — which happens whenever packaging runs on a non-macOS host,
    //     where forge.config.js's resetAdHocDarwinSignature can't run. That
    //     leaves the Electron Framework's signature invalid, so on Apple
    //     Silicon the kernel SIGKILLs the app at launch ("Code Signature
    //     Invalid", crashing inside fuses::IsRunAsNodeEnabled). A fresh ad-hoc
    //     re-sign on the user's own Mac makes the on-disk bytes match the
    //     signature again. Done BEFORE the swap so any failure aborts without
    //     touching the installed app. codesign ships with macOS itself, so
    //     this needs no Xcode install. Strip extended attributes first —
    //     codesign rejects FinderInfo / resource-fork "detritus" with
    //     "resource fork ... not allowed".
    await runCommand('/usr/bin/xattr', ['-cr', stagedApp]);
    await runCommand('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', stagedApp]);

    // 5. Hand off to a detached script that waits for THIS process to quit,
    //    swaps the bundle, and relaunches. A running process can't reliably
    //    replace its own bundle, so the script does it once we're gone. Paths
    //    are passed as argv (not interpolated into the script body) so they're
    //    injection-safe even with spaces / special chars.
    const scriptPath = path.join(work, 'apply-update.sh');
    const sh = [
      '#!/bin/bash',
      'set -e',
      'PID="$1"; CURRENT="$2"; STAGED="$3"; BACKUP="$4"; WORK="$5"',
      // Wait up to ~30s for the old app to exit so the swap is safe.
      'for i in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done',
      'rm -rf "$BACKUP"',
      'mv "$CURRENT" "$BACKUP"',
      // Roll back if the swap fails, so the user is never left without an app.
      'if ! mv "$STAGED" "$CURRENT"; then mv "$BACKUP" "$CURRENT"; exit 1; fi',
      '/usr/bin/xattr -dr com.apple.quarantine "$CURRENT" 2>/dev/null || true',
      'rm -rf "$BACKUP"',
      'open "$CURRENT"',
      'rm -rf "$WORK"',
      '',
    ].join('\n');
    await fsp.writeFile(scriptPath, sh, { mode: 0o755 });

    sendUpdateStatus({ state: 'ready-relaunch' });
    const child = spawn(
      '/bin/bash',
      [scriptPath, String(process.pid), currentApp, stagedApp, backupApp, work],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();

    // Give the renderer a beat to paint the relaunch state, then quit so the
    // handoff script can replace the bundle.
    setTimeout(() => app.quit(), 600);
    return { ok: true };
  } catch (err) {
    const message = String(err?.message || err);
    sendUpdateStatus({ state: 'error', message });
    if (work) fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: message };
  }
});
// --------------------------------------------------------------------------

// Local-folder sync IPC ----------------------------------------------------
// Backs the Files page's "download from cloud" workflow: the renderer
// chooses a folder, lists its contents, and asks main to fetch a batch
// of signed Supabase URLs into it. We do the file I/O here (not the
// renderer) because the renderer is sandboxed away from `fs` by
// contextIsolation, and because Node's streaming fetch + writeFile is
// the easiest path that avoids loading multi-MB videos into renderer
// memory just to pipe them back out.

// Map a filename's extension to a best-effort MIME type so the renderer
// can pick the right card icon (PDF / video / image / text / generic).
// Mirrors the categoriser in ProjectFiles.jsx so local + cloud cards
// bucket into the same Photos / Videos / Documents sections.
function guessMimeFromName(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!ext) return '';
  if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg';
  if (['png', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) return `image/${ext}`;
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return `video/${ext}`;
  // Audio — WhatsApp voice notes are Ogg-Opus (`.opus`); the rest cover the
  // common shared-audio formats. Without these the localfile handler falls
  // back to octet-stream and Chromium refuses to decode the <audio> element.
  if (['opus', 'ogg', 'oga'].includes(ext)) return 'audio/ogg';
  if (ext === 'mp3') return 'audio/mpeg';
  if (['m4a', 'aac'].includes(ext)) return 'audio/mp4';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'md') return 'text/markdown';
  if (['txt', 'log', 'json', 'csv', 'xml', 'html', 'css', 'js', 'ts'].includes(ext)) return 'text/plain';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (['doc', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'application/octet-stream';
  return '';
}

// Strip path separators + Windows-reserved chars. The cloud filename
// almost always comes from `File.name` (already sanitised by the OS file
// picker), but a renamed display name could carry "/" or ":" — those
// would either escape the target dir or fail to create on Windows.
// Replace with underscore so a stray character doesn't blow up the
// whole batch.
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 240);
}

// Open the native folder picker. Returns the chosen absolute path, or
// null when the user canceled. `createDirectory` lets the picker offer
// a "New folder" button on macOS; on Windows the OS dialog has its own
// affordance and the flag is a no-op.
ipcMain.handle('local-folder:pick', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose download folder',
  });
  if (result.canceled) return null;
  return result.filePaths?.[0] || null;
});

// Per-project working directory. Each project auto-binds to a fixed folder
// under the user's Documents (`Documents/Docvex/<projectId>`) — there's no
// manual folder picking; the Files page calls this on mount to resolve (and
// create) the directory. Returns the absolute path.
// Resolve (and create on first use) the per-project local folder. THE SAME
// folder is used at project-creation time (ProjectCreate mirrors the new
// project to disk) and by the Files page — so files added in Files land in the
// project's own directory.
//
// Resolution order:
//   1. Registry hit  — .docvex-projects.json (in Documents/Docvex) maps
//      projectId → FULL folder path; reused even after a rename.
//   2. Legacy "Docvex/<uuid>" folder — adopted so old files aren't orphaned.
//   3. An existing "<baseDir>/<name>" folder whose .docvex.json claims this
//      project — adopted (covers projects created by the old hub flow).
//   4. New → create "<baseDir>/<name>" (baseDir = the user's chosen projects
//      directory from the hub; falls back to Documents/Docvex), de-duping
//      name collisions with a numeric suffix.
//
// Accepts a projectId string (back-compat) or { projectId, name, baseDir }.
function sanitizeFolderName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/[\\/:*?"<>|]/g, ' ')   // strip path-illegal characters
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')            // Windows: no trailing dot/space
    .slice(0, 80)
    .trim();
}

// Read the projectId a folder's .docvex.json sidecar claims (or null).
async function sidecarProjectId(dirPath) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(dirPath, '.docvex.json'), 'utf8'));
    return j?.projectId || null;
  } catch { return null; }
}

ipcMain.handle('local-folder:project-dir', async (_, arg) => {
  const projectId = typeof arg === 'string' ? arg : arg?.projectId;
  const projectName = (arg && typeof arg === 'object') ? arg.name : undefined;
  const baseDir = (arg && typeof arg === 'object' && arg.baseDir) ? String(arg.baseDir) : null;
  if (!projectId) return { path: null, error: 'No project id' };
  try {
    const docvexRoot = path.join(app.getPath('documents'), 'Docvex');
    await fsp.mkdir(docvexRoot, { recursive: true });
    const registryPath = path.join(docvexRoot, '.docvex-projects.json');

    let registry = {};
    try { registry = JSON.parse(await fsp.readFile(registryPath, 'utf8')) || {}; }
    catch { registry = {}; }
    const writeRegistry = () => fsp.writeFile(registryPath, JSON.stringify(registry, null, 2)).catch(() => {});
    // Resolve a registry value (full path now; bare folder name for legacy
    // entries) to an absolute path.
    const toAbs = (v) => (path.isAbsolute(v) ? v : path.join(docvexRoot, v));

    // 1. Already mapped → reuse that folder.
    if (registry[projectId]) {
      const dir = toAbs(registry[projectId]);
      await fsp.mkdir(dir, { recursive: true });
      return { path: dir, error: null };
    }

    // 2. Legacy "<uuid>" folder under Docvex → adopt it.
    const legacy = path.join(docvexRoot, String(projectId));
    try {
      if ((await fsp.stat(legacy)).isDirectory()) {
        registry[projectId] = legacy;
        await writeRegistry();
        return { path: legacy, error: null };
      }
    } catch { /* none */ }

    // 3 + 4. Resolve under the project base dir (the hub's chosen folder), or
    // Documents/Docvex when none was given.
    const root = baseDir || docvexRoot;
    await fsp.mkdir(root, { recursive: true });
    const base = sanitizeFolderName(projectName) || String(projectId);
    const takenPaths = new Set(Object.values(registry).map(toAbs));

    let folderName = base;
    let n = 2;
    for (;;) {
      const dir = path.join(root, folderName);
      let exists = false;
      try { exists = (await fsp.stat(dir)).isDirectory(); } catch { exists = false; }
      if (!exists && !takenPaths.has(dir)) {
        await fsp.mkdir(dir, { recursive: true });
        registry[projectId] = dir;
        await writeRegistry();
        return { path: dir, error: null };
      }
      // Folder already there — adopt it only if it's already THIS project's
      // (sidecar match); otherwise try the next suffixed name so we never
      // dump files into an unrelated folder.
      if (exists && !takenPaths.has(dir) && (await sidecarProjectId(dir)) === projectId) {
        registry[projectId] = dir;
        await writeRegistry();
        return { path: dir, error: null };
      }
      folderName = `${base} (${n})`;
      n += 1;
    }
  } catch (err) {
    return { path: null, error: err?.message || String(err) };
  }
});

// Filenames that should never surface as "your project's files" — they
// are OS / editor bookkeeping artifacts that materialise transiently
// next to the documents the user actually cares about. Leaving them
// visible causes three classes of bugs:
//   1. Word's `~$report.docx` lockfile appears as a phantom new file
//      every time the user opens a .docx for editing, gets minted a
//      sidecar UUID, and rides into the next commit (the bug the
//      user explicitly hit and reported).
//   2. Vim / IDE swap files (`.swp`, `.swo`, `*~`) flicker in and out
//      of the list, racing the watcher debounce.
//   3. macOS / Windows file managers drop hidden metadata (`.DS_Store`,
//      `desktop.ini`, `Thumbs.db`) the user never agreed to share.
//
// The check is filename-only — we don't try to peek at file headers
// or sizes. Anything matching one of these patterns is dropped from
// the list before it has a chance to be hashed, reconciled with the
// sidecar, or compared against cloud state.
function isIgnoredLocalFilename(name) {
  if (!name) return true;
  // Dotfiles cover the broadest swath: .DS_Store, .git, .vscode/,
  // .env, the sidecar's own .docvex.json, .Trashes, .Spotlight-V100,
  // etc. The Files tab is for documents, not config.
  if (name.startsWith('.')) return true;
  // Office lockfiles use ~$ prefix — Word, Excel, PowerPoint all do
  // this. The lockfile exists for the duration of the open session
  // and is deleted on clean close. Without this filter, a user
  // editing a .docx gets a phantom "~$Report.docx" card.
  if (name.startsWith('~$')) return true;
  // Vim / classic editor backup files end with ~ — e.g. `report.docx~`.
  if (name.endsWith('~')) return true;
  // Editor swap files — Vim / NeoVim are the dominant offenders.
  if (/\.(swp|swo|swn|swm)$/i.test(name)) return true;
  // Lockfile patterns from various OSes / editors (LibreOffice's
  // `.~lock.report.docx#`, OS-level `.lock`, `.lck`). The dotfile
  // rule catches LibreOffice's because it starts with `.`; the
  // generic `.lock` / `.lck` extension catch covers third parties.
  if (/\.(lock|lck)$/i.test(name)) return true;
  // Generic temp scratch — most apps write `*.tmp` and `*.temp` next
  // to the open file for atomic rename-on-save. They disappear after
  // save but the watcher tick can catch them mid-flight.
  if (/\.(tmp|temp|bak|partial|crdownload|part)$/i.test(name)) return true;
  // Windows folder metadata (capital-T variant for older releases).
  if (name === 'Thumbs.db' || name === 'thumbs.db') return true;
  if (name === 'desktop.ini' || name === 'Desktop.ini') return true;
  if (name === 'ehthumbs.db') return true;
  // macOS quirks not always caught by the dotfile rule.
  if (name === 'Icon\r') return true; // Finder custom-icon marker
  return false;
}

// List regular files in `dir`. Subdirectories are filtered out — the
// Files tab is flat by design, and recursing could surface a project's
// node_modules. Each entry carries size + mtime so the card meta line
// can show the same "size · date" pair the cloud cards use.
ipcMain.handle('local-folder:list', async (_, dir) => {
  if (!dir) return { files: [], dirs: [], error: 'No directory specified' };
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = [];
    const dirs = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Hide dotfolders (.git, .vscode, …) — same "show only the
        // project's stuff" spirit as the file-noise filter. Visible
        // folders are what the user organises with.
        if (entry.name.startsWith('.')) continue;
        try {
          const full = path.join(dir, entry.name);
          const stat = await fsp.stat(full);
          // `empty` = no VISIBLE entries inside (ignoring dotfolders +
          // noise files) — drives the outline-vs-filled folder icon.
          let empty = true;
          try {
            const children = await fsp.readdir(full, { withFileTypes: true });
            empty = !children.some((c) => (
              c.isDirectory()
                ? !c.name.startsWith('.')
                : (c.isFile() && !isIgnoredLocalFilename(c.name))
            ));
          } catch { /* unreadable → treat as empty */ }
          dirs.push({ name: entry.name, path: full, mtimeIso: stat.mtime.toISOString(), empty });
        } catch { /* skip dirs we can't stat */ }
        continue;
      }
      if (!entry.isFile()) continue;
      // Drop OS / editor / lockfile noise so the local pane reads
      // as "your project's documents" only. See isIgnoredLocalFilename
      // for the exact pattern set and the rationale per pattern.
      if (isIgnoredLocalFilename(entry.name)) continue;
      try {
        const full = path.join(dir, entry.name);
        const stat = await fsp.stat(full);
        files.push({
          name: entry.name,
          path: full,
          sizeBytes: stat.size,
          mtimeIso: stat.mtime.toISOString(),
          mimeType: guessMimeFromName(entry.name),
        });
      } catch { /* skip files we can't stat (permission, symlink to gone target) */ }
    }
    // Newest first — matches the cloud list's `uploaded_at DESC` order.
    files.sort((a, b) => (a.mtimeIso < b.mtimeIso ? 1 : -1));
    // Folders alphabetical — a stable, scannable order for navigation.
    dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { files, dirs, error: null };
  } catch (err) {
    return { files: [], dirs: [], error: err?.message || 'Could not read directory' };
  }
});

// Recursive listing — every file anywhere under `dir`, each tagged with
// its `folderPath` (relative dir from the root, forward-slash separated,
// '' for root). This is the SYNC source: the branch flow needs to see
// files in subfolders so the folder structure can sync to the team.
// Dotfolders + noise files are skipped, same as the flat list.
async function walkLocalDir(root, rel, out) {
  const dir = rel ? path.join(root, rel) : root;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      await walkLocalDir(root, childRel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isIgnoredLocalFilename(entry.name)) continue;
    try {
      const full = path.join(dir, entry.name);
      const stat = await fsp.stat(full);
      out.push({
        name: entry.name,
        path: full,
        folderPath: rel || '',
        sizeBytes: stat.size,
        mtimeIso: stat.mtime.toISOString(),
        mimeType: guessMimeFromName(entry.name),
      });
    } catch { /* skip unstattable */ }
  }
}

ipcMain.handle('local-folder:list-recursive', async (_, dir) => {
  if (!dir) return { files: [], error: 'No directory specified' };
  try {
    const files = [];
    await walkLocalDir(dir, '', files);
    files.sort((a, b) => (a.mtimeIso < b.mtimeIso ? 1 : -1));
    return { files, error: null };
  } catch (err) {
    return { files: [], error: err?.message || 'Could not read directory' };
  }
});

// ── Folder management (My-branch local organisation) ──────────────────
// Create / delete a subfolder and move a file between folders, all
// confined to the picked branch folder via the same resolve + prefix
// guard the file ops use. Folders are a LOCAL organisation layer — the
// cloud project stays flat — so these never touch Supabase.
function sanitizeSegment(name) {
  // Single path segment only: strip separators + illegal chars so a
  // typed folder name can't escape the parent or break Windows.
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\.+$/, '').trim().slice(0, 120);
}

ipcMain.handle('local-folder:create-folder', async (_, payload) => {
  const dir = payload?.dir;
  const name = sanitizeSegment(payload?.name || '');
  if (!dir || !name) return { error: 'Missing or invalid name' };
  try {
    const normalizedDir = path.resolve(dir);
    const target = path.resolve(dir, name);
    if (!target.startsWith(normalizedDir)) return { error: 'Path outside branch folder' };
    await fsp.mkdir(target); // non-recursive: throws EEXIST if it exists
    return { ok: true, name, path: target, error: null };
  } catch (err) {
    if (err?.code === 'EEXIST') return { error: 'A folder with that name already exists' };
    return { error: err?.message || String(err) };
  }
});

ipcMain.handle('local-folder:delete-folder', async (_, payload) => {
  const dir = payload?.dir;
  const name = payload?.name;
  if (!dir || !name) return { error: 'Missing args' };
  try {
    const normalizedDir = path.resolve(dir);
    const target = path.resolve(dir, name);
    // Must be strictly inside the parent (never the parent itself).
    if (!target.startsWith(normalizedDir) || target === normalizedDir) {
      return { error: 'Path outside branch folder' };
    }
    await fsp.rm(target, { recursive: true, force: true });
    return { ok: true, error: null };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
});

// Move a file (or folder) into another folder. `root` is the branch
// folder boundary; both source and destination must resolve inside it.
ipcMain.handle('local-folder:move', async (_, payload) => {
  const root = payload?.root;
  const fromPath = payload?.fromPath;
  const toDir = payload?.toDir;
  if (!root || !fromPath || !toDir) return { error: 'Missing args' };
  try {
    const normalizedRoot = path.resolve(root);
    const from = path.resolve(fromPath);
    const to = path.resolve(toDir, path.basename(from));
    if (!from.startsWith(normalizedRoot) || !to.startsWith(normalizedRoot)) {
      return { error: 'Path outside branch folder' };
    }
    if (from === to) return { ok: true, error: null };
    // Refuse to clobber an existing destination entry.
    try {
      await fsp.access(to);
      return { error: 'An item with that name already exists in the destination' };
    } catch { /* doesn't exist — safe to move */ }
    await fsp.rename(from, to);
    return { ok: true, path: to, error: null };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
});

// Download a batch of cloud files into `dir`. Caller passes pre-signed
// URLs so we don't need Supabase credentials in the main process; we
// just fetch each URL and write the bytes. Results are returned per-
// file so the renderer can show a "3 of 5 downloaded" summary.
// Existing files at the target path are overwritten — the user
// explicitly asked to sync from cloud, so cloud is the source of
// truth.
ipcMain.handle('local-folder:download', async (_, payload) => {
  const dir = payload?.dir;
  const files = Array.isArray(payload?.files) ? payload.files : [];
  if (!dir) return { results: [], error: 'No directory specified' };
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    return { results: [], error: `Could not create directory: ${err?.message || err}` };
  }
  const results = [];
  for (const f of files) {
    if (!f?.url || !f?.filename) {
      results.push({ filename: f?.filename || '?', ok: false, error: 'Missing url or filename' });
      continue;
    }
    try {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // f.subdir is the file's folder_path (relative, '' = root). Recreate
      // the structure so a teammate's download lands files in the same
      // folders. Each segment is sanitised + the resolved path is verified
      // to stay inside the branch folder.
      const relDir = (f.subdir || '').split('/').map(sanitizeSegment).filter(Boolean).join(path.sep);
      const targetDir = relDir ? path.join(dir, relDir) : dir;
      if (!path.resolve(targetDir).startsWith(path.resolve(dir))) {
        throw new Error('Path outside branch folder');
      }
      if (relDir) await fsp.mkdir(targetDir, { recursive: true });
      const target = path.join(targetDir, sanitizeFilename(f.filename));
      await fsp.writeFile(target, buf);
      results.push({ filename: f.filename, path: target, ok: true });
    } catch (err) {
      results.push({ filename: f.filename, ok: false, error: err?.message || String(err) });
    }
  }
  return { results, error: null };
});

// Write user-provided bytes (typically files picked via the FAB on
// 'mine' branch) directly into the branch folder. Sibling of the
// download handler above, which fetches URLs — here the renderer
// already holds the bytes, so the IPC payload carries an
// ArrayBuffer per file. Filenames are sanitised the same way as
// download; collisions overwrite (last writer wins) so a re-upload
// of the same name behaves predictably.
ipcMain.handle('local-folder:write-files', async (_, payload) => {
  const dir = payload?.dir;
  const files = Array.isArray(payload?.files) ? payload.files : [];
  if (!dir) return { results: [], error: 'No directory specified' };
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    return { results: [], error: `Could not create directory: ${err?.message || err}` };
  }
  const results = [];
  for (const f of files) {
    if (!f?.filename || !f?.bytes) {
      results.push({ filename: f?.filename || '?', ok: false, error: 'Missing filename or bytes' });
      continue;
    }
    try {
      const buf = Buffer.from(f.bytes);
      const target = path.join(dir, sanitizeFilename(f.filename));
      await fsp.writeFile(target, buf);
      results.push({ filename: f.filename, path: target, ok: true });
    } catch (err) {
      results.push({ filename: f.filename, ok: false, error: err?.message || String(err) });
    }
  }
  return { results, error: null };
});

// Rename a file inside the user's branch folder. Used when the
// FileDetailModal name input is committed on the My branch view —
// the metadata-rename branch_change is queued in parallel; this
// IPC handles the actual on-disk move so File Explorer reflects
// the new name. Same defensive `path.resolve` + `startsWith(dir)`
// check as delete-files so a stray path can't escape the branch.
ipcMain.handle('local-folder:rename-file', async (_, payload) => {
  const dir = payload?.dir;
  const fromName = payload?.fromName;
  const toName = payload?.toName;
  if (!dir || !fromName || !toName) return { error: 'Missing args' };
  if (fromName === toName) return { ok: true, error: null };
  try {
    const normalizedDir = path.resolve(dir);
    const fromPath = path.resolve(dir, fromName);
    const toPath = path.resolve(dir, toName);
    if (!fromPath.startsWith(normalizedDir) || !toPath.startsWith(normalizedDir)) {
      return { error: 'Path outside branch folder' };
    }
    await fsp.rename(fromPath, toPath);
    return { ok: true, error: null };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      // Source file already gone (raced with watcher, manual move).
      // Surface as a soft failure so the caller can refresh without
      // panic.
      return { error: 'Source file not found' };
    }
    return { error: err?.message || String(err) };
  }
});

// Open a local file (or its parent folder) in the OS file manager /
// default app. Used for the card click handler on local files and the
// "Open folder" button next to the local pane header.
ipcMain.handle('local-folder:open-path', async (_, targetPath) => {
  if (!targetPath) return '';
  // shell.openPath returns an empty string on success, an error message
  // on failure. Pass it through so the renderer can surface failures.
  return shell.openPath(targetPath);
});

// Reveal a local file in the OS file manager (Explorer on Windows,
// Finder on macOS, the default file manager on Linux) with the file
// pre-selected. Wired to the "Show in explorer" context-menu item
// on My-branch cards. Returns nothing useful (shell call is sync-ish
// and best-effort).
ipcMain.handle('local-folder:show-in-folder', async (_, targetPath) => {
  if (!targetPath) return { ok: false, error: 'No path' };
  try {
    shell.showItemInFolder(targetPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Delete a batch of files inside the user's branch folder. Used by
// the "Sync to main" flow when the local copy has files that no
// longer exist on main. We only accept paths INSIDE the chosen
// directory (`dir`) — defensive against a malformed path slipping
// through and deleting something outside the branch.
ipcMain.handle('local-folder:delete-files', async (_, payload) => {
  const dir = payload?.dir;
  const paths = Array.isArray(payload?.paths) ? payload.paths : [];
  if (!dir) return { results: [], error: 'No directory specified' };
  const results = [];
  // Normalize the dir prefix once so the inside-the-folder check is
  // a cheap startsWith on the canonical resolved path.
  let normalizedDir;
  try {
    normalizedDir = path.resolve(dir);
  } catch (err) {
    return { results: [], error: `Bad directory: ${err?.message || err}` };
  }
  for (const p of paths) {
    if (!p || typeof p !== 'string') {
      results.push({ path: p, ok: false, error: 'Invalid path' });
      continue;
    }
    let resolved;
    try {
      resolved = path.resolve(p);
    } catch (err) {
      results.push({ path: p, ok: false, error: err?.message || String(err) });
      continue;
    }
    if (!resolved.startsWith(normalizedDir)) {
      results.push({ path: p, ok: false, error: 'Path is outside branch folder' });
      continue;
    }
    try {
      await fsp.unlink(resolved);
      results.push({ path: p, ok: true });
    } catch (err) {
      // ENOENT is benign — the file's already gone, treat as success
      // so the sync's "delete these N files" tally still works.
      if (err?.code === 'ENOENT') {
        results.push({ path: p, ok: true });
      } else {
        results.push({ path: p, ok: false, error: err?.message || String(err) });
      }
    }
  }
  return { results, error: null };
});

// ── Filesystem watcher ────────────────────────────────────────────────
// Watches the user's branch folder for add / change / delete events
// and pings the renderer so it can re-list. One watcher at a time
// (we only ever have one selected folder); switching folders closes
// the old watcher and opens a new one. fs.watch emits multiple
// events per single user action (a save can fire rename + change),
// so we debounce 200ms before notifying.
//
// fs.watch on Windows is reliable for top-level adds/removes/renames
// in a single directory. It does NOT recurse into subdirectories,
// which matches the Files-tab semantics (the list itself is flat).
let watcher = null;
let watcherDebounce = null;
let watchedDir = null;

const stopWatcher = () => {
  if (watcher) {
    try { watcher.close(); } catch { /* swallow */ }
    watcher = null;
  }
  if (watcherDebounce) {
    clearTimeout(watcherDebounce);
    watcherDebounce = null;
  }
  watchedDir = null;
};

ipcMain.handle('local-folder:watch', (_, dir) => {
  stopWatcher();
  if (!dir) return { ok: true };
  try {
    // recursive so changes inside synced subfolders are noticed too
    // (Windows + macOS support recursive fs.watch; on platforms that
    // don't, it degrades to top-level only).
    watcher = fs.watch(dir, { persistent: false, recursive: true }, () => {
      // Debounce: collapse a burst of events (rename + change pairs
      // during a save) into a single notification.
      if (watcherDebounce) clearTimeout(watcherDebounce);
      watcherDebounce = setTimeout(() => {
        watcherDebounce = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('local-folder:changed', dir);
        }
      }, 200);
    });
    watcher.on('error', () => stopWatcher());
    watchedDir = dir;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('local-folder:unwatch', () => {
  stopWatcher();
  return { ok: true };
});

// Per-folder sidecar (.docvex.json) — the on-disk source of truth for
// "which filename IS which stable fileId". Lives next to the user's
// files so IDs survive a localStorage clear, ship to teammates via
// Dropbox/iCloud, and don't need a separate bootstrap pass when the
// user re-picks the folder. Both handlers operate INSIDE the chosen
// folder; we don't accept absolute paths to .docvex.json so a stray
// path can't escape and read/write arbitrary user files.
ipcMain.handle('local-folder:read-sidecar', async (_, dir) => {
  if (!dir) return { json: null, error: 'No directory specified' };
  try {
    const target = path.join(dir, '.docvex.json');
    const raw = await fsp.readFile(target, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); }
    catch (parseErr) { return { json: null, error: `Bad JSON: ${parseErr?.message || parseErr}` }; }
    return { json: parsed, error: null };
  } catch (err) {
    // ENOENT is the normal "no sidecar yet" case — return null without
    // surfacing an error so callers treat it as an empty mapping.
    if (err?.code === 'ENOENT') return { json: null, error: null };
    return { json: null, error: err?.message || String(err) };
  }
});

ipcMain.handle('local-folder:write-sidecar', async (_, payload) => {
  const dir = payload?.dir;
  const json = payload?.json;
  if (!dir) return { ok: false, error: 'No directory specified' };
  if (!json || typeof json !== 'object') return { ok: false, error: 'Invalid payload' };
  try {
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, '.docvex.json');
    await fsp.writeFile(target, JSON.stringify(json, null, 2), 'utf8');
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ── Recently deleted (local recycle bin) ─────────────────────────────
// Deleting a file in the Files page MOVES it into a hidden `.docvex-trash/`
// folder inside the picked project folder rather than unlinking it. Each
// trashed file gets a `deletedAt` timestamp recorded in
// `.docvex-trash/.trashmeta.json`, so the renderer can show a "Deletes in
// N days" countdown and the main process can auto-purge entries older than
// 30 days. `.docvex-trash` is a dotfolder, so it's already skipped by the
// list/walk handlers and never leaks into "My drafts".
const TRASH_DIRNAME = '.docvex-trash';
const TRASH_META_FILE = '.trashmeta.json';
const TRASH_RETENTION_DAYS = 30;

function trashDir(dir) {
  return path.join(dir, TRASH_DIRNAME);
}

async function readTrashMeta(dir) {
  try {
    const raw = await fsp.readFile(path.join(trashDir(dir), TRASH_META_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeTrashMeta(dir, meta) {
  await fsp.mkdir(trashDir(dir), { recursive: true });
  await fsp.writeFile(
    path.join(trashDir(dir), TRASH_META_FILE),
    JSON.stringify(meta, null, 2),
    'utf8',
  );
}

// Mint a collision-proof stored name: `<epoch>__<sanitized original>`.
// The timestamp prefix keeps repeated deletes of the same name distinct.
function mintStoredName(originalName, nowMs) {
  return `${nowMs}__${sanitizeFilename(originalName)}`;
}

// Core sweep used by BOTH the IPC handler and the periodic timer. Unlinks
// every trashed entry whose deletedAt is older than the cutoff, plus orphan
// files (in the trash dir without a meta record) older than the cutoff by
// mtime. Returns the number of files purged.
async function purgeTrashDir(dir, olderThanDays = TRASH_RETENTION_DAYS, nowMs = Date.now()) {
  const tdir = trashDir(dir);
  let entries;
  try {
    entries = await fsp.readdir(tdir, { withFileTypes: true });
  } catch {
    return 0; // no trash folder yet
  }
  const meta = await readTrashMeta(dir);
  const cutoff = nowMs - olderThanDays * 86400000;
  let purged = 0;
  let metaDirty = false;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === TRASH_META_FILE) continue;
    const stored = entry.name;
    const rec = meta[stored];
    let expired = false;
    if (rec?.deletedAt) {
      expired = Date.parse(rec.deletedAt) <= cutoff;
    } else {
      // Orphan with no record — fall back to file mtime.
      try {
        const stat = await fsp.stat(path.join(tdir, stored));
        expired = stat.mtimeMs <= cutoff;
      } catch { expired = false; }
    }
    if (!expired) continue;
    try {
      await fsp.unlink(path.join(tdir, stored));
      purged += 1;
    } catch (err) {
      if (err?.code !== 'ENOENT') continue;
    }
    if (rec) { delete meta[stored]; metaDirty = true; }
  }
  if (metaDirty) {
    try { await writeTrashMeta(dir, meta); } catch { /* best-effort */ }
  }
  return purged;
}

// Move a single file into the bin. `path` must resolve inside `dir`.
ipcMain.handle('local-folder:trash-file', async (_, payload) => {
  const dir = payload?.dir;
  const filePath = payload?.path;
  if (!dir || !filePath) return { ok: false, error: 'Missing args' };
  try {
    const normalizedDir = path.resolve(dir);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(normalizedDir)) {
      return { ok: false, error: 'Path is outside project folder' };
    }
    const originalName = path.basename(resolved);
    // Record the file's location relative to the project root so a restore
    // can put it back where it came from (subfolder included).
    const originalRelDir = path
      .relative(normalizedDir, path.dirname(resolved))
      .split(path.sep).join('/');
    const nowMs = Date.now();
    const stored = mintStoredName(originalName, nowMs);
    await fsp.mkdir(trashDir(dir), { recursive: true });
    await fsp.rename(resolved, path.join(trashDir(dir), stored));
    const meta = await readTrashMeta(dir);
    meta[stored] = { originalName, deletedAt: new Date(nowMs).toISOString(), originalRelDir };
    await writeTrashMeta(dir, meta);
    return { ok: true, stored, error: null };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, error: 'File not found' };
    return { ok: false, error: err?.message || String(err) };
  }
});

// Move an entire folder into the bin. There's no "trashed directory" concept —
// instead every file inside is trashed individually with its original relative
// path recorded, so a restore drops each file back where it lived (recreating
// the folder structure). After the files are moved out, the now-empty folder
// tree (plus any ignored/lock leftovers) is removed. Reuses all the existing
// trash machinery (list / restore / countdown / purge) — folders ride the same
// rails as single-file deletes. Returns the list of stored names so the caller
// can offer an undo that restores them all.
ipcMain.handle('local-folder:trash-folder', async (_, payload) => {
  const dir = payload?.dir;
  const folderPath = payload?.path;
  if (!dir || !folderPath) return { ok: false, error: 'Missing args' };
  try {
    const normalizedDir = path.resolve(dir);
    const resolved = path.resolve(folderPath);
    // Must be strictly inside the root (never the root itself or outside it).
    if (!resolved.startsWith(normalizedDir) || resolved === normalizedDir) {
      return { ok: false, error: 'Path is outside project folder' };
    }
    const tdir = trashDir(dir);
    await fsp.mkdir(tdir, { recursive: true });
    const meta = await readTrashMeta(dir);
    const nowMs = Date.now();
    const deletedAt = new Date(nowMs).toISOString();
    const stored = [];
    let counter = 0;
    // Recursively trash every file under the folder, preserving each file's
    // location relative to the project root so restore puts it back exactly.
    const walk = async (current) => {
      let entries;
      try { entries = await fsp.readdir(current, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.isFile()) continue;
        const originalRelDir = path
          .relative(normalizedDir, path.dirname(full))
          .split(path.sep).join('/');
        // nowMs + counter keeps the stored-name prefix unique across the batch
        // while every file shares one deletedAt (same 30-day countdown).
        const storedName = mintStoredName(entry.name, nowMs + counter);
        counter += 1;
        try {
          await fsp.rename(full, path.join(tdir, storedName));
          meta[storedName] = { originalName: entry.name, deletedAt, originalRelDir };
          stored.push(storedName);
        } catch { /* skip unreadable */ }
      }
    };
    await walk(resolved);
    await writeTrashMeta(dir, meta);
    // Remove the now-empty folder tree (and any leftover ignored/lock files).
    await fsp.rm(resolved, { recursive: true, force: true });
    return { ok: true, stored, error: null };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, error: 'Folder not found' };
    return { ok: false, error: err?.message || String(err) };
  }
});

// DEV-only: seed the bin with dummy files whose `deletedAt` is backdated so
// each one is N days from its 30-day purge. Drives the countdown-ring UI.
ipcMain.handle('local-folder:debug-seed-trash', async (_, payload) => {
  const dir = payload?.dir;
  const days = Array.isArray(payload?.days) ? payload.days : [];
  if (!dir) return { ok: false, error: 'No directory specified' };
  try {
    const tdir = trashDir(dir);
    await fsp.mkdir(tdir, { recursive: true });
    const meta = await readTrashMeta(dir);
    const nowMs = Date.now();
    let count = 0;
    for (const d of days) {
      const daysLeft = Number(d);
      if (!Number.isFinite(daysLeft)) continue;
      const deletedAtMs = nowMs - Math.max(0, TRASH_RETENTION_DAYS - daysLeft) * 86400000;
      const originalName = `debug-expires-in-${daysLeft}d.txt`;
      const stored = mintStoredName(originalName, nowMs + count);
      await fsp.writeFile(path.join(tdir, stored), `Debug trash item — expires in ${daysLeft} day(s).\n`, 'utf8');
      meta[stored] = { originalName, deletedAt: new Date(deletedAtMs).toISOString(), originalRelDir: '' };
      count += 1;
    }
    await writeTrashMeta(dir, meta);
    return { ok: true, count, error: null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// List bin contents, joining each stored file with its meta record.
ipcMain.handle('local-folder:list-trash', async (_, dir) => {
  if (!dir) return { items: [], error: 'No directory specified' };
  const tdir = trashDir(dir);
  let entries;
  try {
    entries = await fsp.readdir(tdir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return { items: [], error: null };
    return { items: [], error: err?.message || String(err) };
  }
  const meta = await readTrashMeta(dir);
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === TRASH_META_FILE) continue;
    const stored = entry.name;
    const rec = meta[stored] || {};
    const full = path.join(tdir, stored);
    try {
      const stat = await fsp.stat(full);
      const originalName = rec.originalName || stored.replace(/^\d+__/, '');
      items.push({
        stored,
        originalName,
        deletedAt: rec.deletedAt || stat.mtime.toISOString(),
        originalRelDir: rec.originalRelDir || '',
        sizeBytes: stat.size,
        mimeType: guessMimeFromName(originalName),
        path: full,
      });
    } catch { /* skip unreadable */ }
  }
  // Most-recently-deleted first.
  items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
  return { items, error: null };
});

// Restore a binned file back to its original location (subfolder included).
ipcMain.handle('local-folder:restore-from-trash', async (_, payload) => {
  const dir = payload?.dir;
  const stored = payload?.stored;
  if (!dir || !stored) return { ok: false, error: 'Missing args' };
  try {
    const from = path.join(trashDir(dir), stored);
    const meta = await readTrashMeta(dir);
    const rec = meta[stored] || {};
    const originalName = rec.originalName || stored.replace(/^\d+__/, '');
    const destDir = rec.originalRelDir ? path.join(dir, rec.originalRelDir) : dir;
    await fsp.mkdir(destDir, { recursive: true });
    let target = path.join(destDir, originalName);
    // Collision → suffix "(restored)" before the extension.
    try {
      await fsp.access(target);
      const ext = path.extname(originalName);
      const base = originalName.slice(0, originalName.length - ext.length);
      target = path.join(destDir, `${base} (restored)${ext}`);
    } catch { /* no collision */ }
    await fsp.rename(from, target);
    if (rec) { delete meta[stored]; await writeTrashMeta(dir, meta); }
    return { ok: true, restoredPath: target, error: null };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, error: 'File not found in bin' };
    return { ok: false, error: err?.message || String(err) };
  }
});

// Permanently delete a single binned file ("Delete forever").
ipcMain.handle('local-folder:delete-from-trash', async (_, payload) => {
  const dir = payload?.dir;
  const stored = payload?.stored;
  if (!dir || !stored) return { ok: false, error: 'Missing args' };
  try {
    try { await fsp.unlink(path.join(trashDir(dir), stored)); }
    catch (err) { if (err?.code !== 'ENOENT') throw err; }
    const meta = await readTrashMeta(dir);
    if (meta[stored]) { delete meta[stored]; await writeTrashMeta(dir, meta); }
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Sweep entries older than `olderThanDays` (default 30). Called by the
// renderer on folder open and by the periodic timer below.
ipcMain.handle('local-folder:purge-trash', async (_, payload) => {
  const dir = payload?.dir;
  const olderThanDays = payload?.olderThanDays ?? TRASH_RETENTION_DAYS;
  if (!dir) return { purged: 0, error: 'No directory specified' };
  try {
    const purged = await purgeTrashDir(dir, olderThanDays);
    return { purged, error: null };
  } catch (err) {
    return { purged: 0, error: err?.message || String(err) };
  }
});

// Periodic auto-sweep: every 6h, purge the currently-watched folder's bin.
// Main only knows the active folder (`watchedDir`); other folders are swept
// on open by the renderer. Cleared on before-quit alongside the watcher.
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let purgeTimer = null;
const stopPurgeTimer = () => {
  if (purgeTimer) { clearInterval(purgeTimer); purgeTimer = null; }
};

// Tear the watcher + purge timer down on quit so we don't leave handles dangling.
app.on('before-quit', () => { stopWatcher(); stopPurgeTimer(); });
// --------------------------------------------------------------------------

app.whenReady().then(() => {
  // macOS dock icon. BrowserWindow({ icon }) is ignored on macOS (the dock
  // uses the bundle icon), and under `electron-forge start` the bundle is
  // Electron's, so the dock shows the generic Electron icon. Set it at
  // runtime from the same asset the window uses (copied next to main.js by
  // vite.main.config's copyMainIcon plugin). No-op on Windows/Linux.
  if (process.platform === 'darwin' && app.dock) {
    try {
      const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'appicon_desktop.png'));
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    } catch { /* non-fatal — fall back to the bundle icon */ }
  }

  // Resolve `localfile://local/<encoded-absolute-path>` requests by
  // streaming the file off disk via fs.createReadStream wrapped in a
  // Response. The renderer URL-encodes the full path as a single
  // segment, including drive letters / backslashes / spaces, so we
  // just decode the pathname and read directly — no further URL
  // wrangling.
  //
  // Why streaming + a Node ReadStream instead of net.fetch(file://…):
  //   • net.fetch on file:// hits ERR_UNEXPECTED on Windows when the
  //     path contains a drive letter that's been URL-parsed weirdly.
  //   • A Node stream wrapped in a Response gives the renderer
  //     proper byte-range support for `<video>` / `<img>` requests
  //     without buffering large files into memory.
  //
  // Security note: this exposes arbitrary local files to the
  // renderer. Same trust boundary as the rest of the renderer
  // (preload's localFolder IPCs already read/write the filesystem),
  // so no additional gate is needed beyond not shipping this scheme
  // to any non-Electron context.
  // Downscaled-image cache for the `?thumb=` branch below. Keyed by
  // path+mtime+width; capped so a huge folder can't grow it unbounded
  // (entries are ~20-60KB JPEGs — the cap is a few MB of RAM).
  const thumbCache = new Map();
  const THUMB_CACHE_MAX = 400;
  async function thumbnailFor(filePath, mtimeMs, width, mime) {
    const key = `${filePath}:${mtimeMs}:${width}`;
    const hit = thumbCache.get(key);
    if (hit !== undefined) return hit;
    let out = null;
    try {
      // OS thumbnailer (Windows Shell / macOS QuickLook) — fast, and decodes
      // HEIC where Chromium can't. Not available on Linux → caller streams
      // the original.
      const img = await nativeImage.createThumbnailFromPath(filePath, { width, height: width });
      if (img && !img.isEmpty()) {
        // PNG keeps alpha for png sources; everything else compresses better
        // as JPEG.
        out = mime === 'image/png'
          ? { buffer: img.toPNG(), mime: 'image/png' }
          : { buffer: img.toJPEG(82), mime: 'image/jpeg' };
        if (!out.buffer?.length) out = null;
      }
    } catch { out = null; }
    if (thumbCache.size >= THUMB_CACHE_MAX) {
      thumbCache.delete(thumbCache.keys().next().value);
    }
    thumbCache.set(key, out);
    return out;
  }

  protocol.handle('localfile', async (request) => {
    let filePath = '';
    try {
      const url = new URL(request.url);
      // pathname is the encoded path segment; strip leading slash and
      // decode in one go.
      const raw = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
      filePath = decodeURIComponent(raw);
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) {
        return new Response('Not a file', { status: 404 });
      }
      const mime = guessMimeFromName(filePath) || 'application/octet-stream';
      const total = stat.size;
      // CORS on every body response: the DocViewer's text-extraction tool
      // loads media with crossOrigin="anonymous" so it can draw the element
      // to a canvas and export the crop — without this header the CORS-mode
      // load fails outright, and without crossOrigin the canvas is tainted.
      const cors = { 'access-control-allow-origin': '*' };
      // `?thumb=N` — serve a downscaled thumbnail instead of the original
      // bytes. The WhatsApp reconstruction asks for these: painting 167
      // full-resolution camera photos into ~300px bubbles re-rasters tens of
      // megapixels every scroll frame, which is what tanks the frame rate on
      // media-heavy conversations. Videos are included — the OS thumbnailer
      // returns a poster frame (the same one Explorer shows), which the
      // file grids and the rail paint as the video's thumbnail. Only
      // opted-in formats are downscaled — webp/gif keep animation + alpha
      // and are small anyway, so they (and any failure here) fall through
      // to the normal full-file stream; callers must therefore check the
      // response's content-type before treating the bytes as an image.
      const thumbW = parseInt(url.searchParams.get('thumb') || '', 10);
      if (Number.isFinite(thumbW) && thumbW > 0 && /^(image\/(jpeg|png|bmp|tiff|heic|heif)|video\/)/.test(mime)) {
        const body = await thumbnailFor(filePath, stat.mtimeMs, Math.min(1024, thumbW), mime);
        if (body) {
          return new Response(body.buffer, {
            headers: {
              ...cors,
              'content-type': body.mime,
              'content-length': String(body.buffer.length),
              // Immutable per URL: the renderer never reuses a thumb URL for
              // different bytes (the path encodes the file, mtime busts the
              // main-process cache on change).
              'cache-control': 'max-age=3600',
            },
          });
        }
      }
      // Honour HTTP Range requests so <audio>/<video> can seek and read
      // duration. Chromium needs a 206 partial response for this; an .ogg
      // voice note in particular reports duration = Infinity (and won't
      // scrub) when the server replies 200 with the whole body. Wrap the
      // Node Readable in a web ReadableStream so the Fetch Response accepts
      // it (ReadableStream.from — Electron 42 bundles Node 22).
      const range = request.headers.get('range');
      const rm = range && /bytes=(\d*)-(\d*)/.exec(range);
      if (rm) {
        let start = rm[1] ? parseInt(rm[1], 10) : 0;
        let end = rm[2] ? parseInt(rm[2], 10) : total - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= total) end = total - 1;
        if (start > end || start >= total) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { ...cors, 'content-range': `bytes */${total}`, 'accept-ranges': 'bytes' },
          });
        }
        const partStream = ReadableStream.from(fs.createReadStream(filePath, { start, end }));
        return new Response(partStream, {
          status: 206,
          headers: {
            ...cors,
            'content-type': mime,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${total}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      const webStream = ReadableStream.from(fs.createReadStream(filePath));
      return new Response(webStream, {
        headers: {
          ...cors,
          'content-type': mime,
          'content-length': String(total),
          'accept-ranges': 'bytes',
        },
      });
    } catch (err) {
      return new Response(
        `localfile error reading ${filePath}: ${err?.message || err}`,
        { status: err?.code === 'ENOENT' ? 404 : 500 },
      );
    }
  });

  // Application menu:
  //  • Windows / Linux — none. setApplicationMenu(null) removes the bar entirely
  //    (the renderer's custom title bar carries everything).
  //  • macOS — a minimal native menu. macOS ALWAYS shows a menu bar at the top
  //    of the screen, and the standard editing/clipboard/window shortcuts
  //    (Cmd+C/V/X/A/Z, Cmd+Q/W/M/H) only work when their menu roles exist. With
  //    a null menu they silently break, so we install the standard roles. There
  //    is no File menu — the app is windowless-document by design.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        role: 'appMenu', // DocVex › About / Hide / Quit
      },
      {
        role: 'editMenu', // Undo / Redo / Cut / Copy / Paste / Select All
      },
      {
        label: 'View',
        submenu: [
          { role: 'togglefullscreen' },
          { type: 'separator' },
          { role: 'toggleDevTools' },
        ],
      },
      {
        role: 'windowMenu', // Minimize / Zoom / Close
      },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  createWindow();

  // Best-effort sweep of stale WhatsApp-zip extractions (temp/docvex-wa) on
  // startup — drop folders not touched in 7 days so extracted media doesn't
  // pile up. Cached extractions are keyed by zip path+mtime, so a dropped
  // folder just means the next open re-extracts.
  (async () => {
    try {
      const root = path.join(app.getPath('temp'), 'docvex-wa');
      const entries = await fsp.readdir(root, { withFileTypes: true });
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const full = path.join(root, ent.name);
        try {
          const st = await fsp.stat(full);
          if (st.mtimeMs < cutoff) await fsp.rm(full, { recursive: true, force: true });
        } catch { /* skip */ }
      }
    } catch { /* no extractions yet — nothing to sweep */ }
  })();

  // Periodic bin auto-sweep — purge the active folder's `.docvex-trash`
  // of entries older than 30 days every 6h while the app runs. Other
  // folders are swept on open by the renderer.
  stopPurgeTimer();
  purgeTimer = setInterval(() => {
    if (watchedDir) {
      purgeTrashDir(watchedDir).catch(() => { /* best-effort */ });
    }
  }, PURGE_INTERVAL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
