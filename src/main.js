import { app, BrowserWindow, Menu, ipcMain, shell, autoUpdater, dialog, protocol } from 'electron';
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

// Auto-update via update.electronjs.org (free, public-repo hosted feed).
// Polls every 10 min, downloads in the background, installs on next launch.
// No-op in dev (`electron-forge start`) — only runs in packaged builds.
if (app.isPackaged) {
  updateElectronApp({
    repo: 'petreluca1105-dotcom/docvex',
    updateInterval: '10 minutes',
  });
}

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

// Build a custom application menu so we can insert our "Account" item next
// to the standard File/Edit/View/Window submenus. Uses Electron's role
// shortcuts so we don't have to hand-author the standard items. Dev-only —
// packaged builds keep Electron's default menu untouched.
function buildAppMenu() {
  const template = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Account',
      submenu: ACCOUNTS.map((acc) => ({
        label: `Switch to ${acc.email}`,
        click: () => switchAccount(acc),
      })),
    },
    {
      // Dev-only developer aids:
      //   - Clear all cached data: wipes the renderer's module-level caches
      //     (signed URLs in projectFiles.js, parsed pdf.js docs in pdfCache.js).
      //   - Send all test notifications: fires one of every entry in
      //     TEST_NOTIFICATIONS (src/notifications/testNotifications.js) so
      //     devs can preview the toast stack + history rows for every
      //     category × priority × icon combo without manually triggering
      //     the live actions.
      // Grows as more dev surfaces appear.
      label: 'DEBUG',
      submenu: [
        {
          label: 'Clear all cached data',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('debug:clear-cache');
            }
          },
        },
        {
          label: 'Send all test notifications',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('debug:send-test-notifications');
            }
          },
        },
        {
          // Fires every transactional email template (welcome, invite,
          // support-report) addressed to the signed-in user's own email
          // so devs can verify each layout end-to-end without
          // orchestrating a real signup / invite / bug-report.
          label: 'Send all email previews to me',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('debug:send-email-previews');
            }
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Wire autoUpdater events → renderer. update-electron-app drives the actual
// checkForUpdates / setFeedURL calls; we just observe.
if (app.isPackaged) {
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

const createWindow = () => {
  // Launch-mode suffix shown in the window title bar. `app.isPackaged` is
  // false under `electron-forge start` (npm start) and true once the app
  // has been built and installed via Squirrel.
  const launchMode = app.isPackaged ? 'standalone' : 'npm start';

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    // Initial title for the brief flash before the renderer mounts. The
    // page-title-updated handler below keeps it pinned after load.
    title: `DocVex - ${launchMode}`,
    // Resolved relative to the bundled main.js location (vite.main.config.mjs
    // copies src/favicon.ico into .vite/build/ so this works in dev *and*
    // packaged). On Windows, the .exe's embedded icon (set via
    // packagerConfig.icon in forge.config.js) takes priority in packaged
    // builds — this line is what gives the dev window the right icon and
    // what macOS/Linux WMs read.
    icon: path.join(__dirname, 'favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // By default, Electron syncs window.title ← document.title every time
  // the renderer's <title> changes — that would overwrite our launch-mode
  // suffix as soon as index.html loads. preventDefault() blocks the sync;
  // we then own the title and re-apply it so it survives a Vite HMR reload.
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle(`DocVex - ${launchMode}`);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.webContents.openDevTools();
};

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
  const opts = {
    width: 1100,
    height: 800,
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
  if (!dir) return { files: [], error: 'No directory specified' };
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
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
    return { files, error: null };
  } catch (err) {
    return { files: [], error: err?.message || 'Could not read directory' };
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
      const target = path.join(dir, sanitizeFilename(f.filename));
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
    watcher = fs.watch(dir, { persistent: false }, () => {
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

// Tear the watcher down on quit so we don't leave a handle dangling.
app.on('before-quit', stopWatcher);
// --------------------------------------------------------------------------

app.whenReady().then(() => {
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
      // Wrap the Node Readable in a web ReadableStream so the Fetch
      // Response constructor accepts it. Available in Node 18+ via
      // ReadableStream.from; Electron 42 bundles Node 22.
      const nodeStream = fs.createReadStream(filePath);
      const webStream = ReadableStream.from(nodeStream);
      return new Response(webStream, {
        headers: {
          'content-type': mime,
          'content-length': String(stat.size),
        },
      });
    } catch (err) {
      return new Response(
        `localfile error reading ${filePath}: ${err?.message || err}`,
        { status: err?.code === 'ENOENT' ? 404 : 500 },
      );
    }
  });

  // Account-switcher menu is dev-only — the hardcoded ACCOUNTS list above is
  // the developer's personal test emails, not something distributed users
  // should see in their menu bar.
  if (!app.isPackaged) {
    buildAppMenu();
  }

  createWindow();

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
