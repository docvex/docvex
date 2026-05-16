import { app, BrowserWindow, Menu, ipcMain, shell, autoUpdater, dialog } from 'electron';
import path from 'node:path';
import fsp from 'node:fs/promises';
import started from 'electron-squirrel-startup';
import { updateElectronApp } from 'update-electron-app';

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

// Enforce single instance so second launch delivers the OAuth URL here
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
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
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'application/octet-stream';
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
      // Skip dotfiles + the OS metadata files (Thumbs.db / .DS_Store)
      // so the local pane reads as "your project's documents" instead
      // of leaking OS bookkeeping.
      if (entry.name.startsWith('.') || entry.name === 'Thumbs.db') continue;
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

// Open a local file (or its parent folder) in the OS file manager /
// default app. Used for the card click handler on local files and the
// "Open folder" button next to the local pane header.
ipcMain.handle('local-folder:open-path', async (_, targetPath) => {
  if (!targetPath) return '';
  // shell.openPath returns an empty string on success, an error message
  // on failure. Pass it through so the renderer can surface failures.
  return shell.openPath(targetPath);
});
// --------------------------------------------------------------------------

app.whenReady().then(() => {
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
