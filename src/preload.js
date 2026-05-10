const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openOAuthUrl: (url) => ipcRenderer.send('oauth:open-external', url),
  onOAuthCallback: (handler) =>
    ipcRenderer.on('oauth:callback-url', (_, url) => handler(url)),
  removeOAuthListener: () =>
    ipcRenderer.removeAllListeners('oauth:callback-url'),
});
