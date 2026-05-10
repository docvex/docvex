import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';

if (started) {
  app.quit();
}

// Register custom URL scheme for OAuth callbacks
app.setAsDefaultProtocolClient('docvex');

// Enforce single instance so second launch delivers the OAuth URL here
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;

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

// Let the renderer open URLs in the system browser (needed for OAuth)
ipcMain.on('oauth:open-external', (_, url) => {
  shell.openExternal(url);
});

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
