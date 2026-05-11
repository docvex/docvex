import { app, BrowserWindow, ipcMain, shell, autoUpdater } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { updateElectronApp } from 'update-electron-app';

if (started) {
  app.quit();
}

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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
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

app.whenReady().then(() => {
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
