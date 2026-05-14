const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // OAuth bridge (also carries `docvex://invite?token=…` URLs — the channel
  // name is historical; main.js routes both kinds through it).
  openOAuthUrl: (url) => ipcRenderer.send('oauth:open-external', url),
  onOAuthCallback: (handler) =>
    ipcRenderer.on('oauth:callback-url', (_, url) => handler(url)),
  removeOAuthListener: () =>
    ipcRenderer.removeAllListeners('oauth:callback-url'),

  // One-shot: pulls any docvex:// URL passed on the command line at COLD
  // start (e.g. clicking an invite link when the app isn't running yet).
  // Returns null if nothing pending. The renderer calls this once during
  // AuthContext setup; main clears the value after serving it, so a remount
  // or refetch can't replay the deep-link.
  getStartupDeepLink: () => ipcRenderer.invoke('app:get-startup-deep-link'),

  // Dev-only account switcher. The main process's "Account" menu sends the
  // target email on click; the renderer signs out of the current Supabase
  // session, stashes the email for prefill, and reloads the page so the
  // auth screen comes up clean. Returns an unsubscribe fn.
  onAccountSwitch: (handler) => {
    const listener = (_, email) => handler(email);
    ipcRenderer.on('account:switch-to', listener);
    return () => ipcRenderer.removeListener('account:switch-to', listener);
  },

  // Dev-only "DEBUG → Clear all cached data" menu hook. Main fires the
  // event when the menu item is clicked; the renderer wipes its module-
  // level caches (signed URLs, parsed pdf.js docs) so the next open
  // re-fetches everything from scratch. Returns an unsubscribe fn.
  onDebugClearCache: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('debug:clear-cache', listener);
    return () => ipcRenderer.removeListener('debug:clear-cache', listener);
  },

  // Dev-only "DEBUG → Send all test notifications" menu hook. Fires every
  // entry in TEST_NOTIFICATIONS so devs can preview the full toast +
  // history surface for each category × priority × icon combination
  // without manually triggering the live actions. Returns an unsubscribe fn.
  onSendTestNotifications: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('debug:send-test-notifications', listener);
    return () => ipcRenderer.removeListener('debug:send-test-notifications', listener);
  },

  // Open any URL in the user's default browser (used for release links etc.)
  openExternal: (url) => ipcRenderer.send('app:open-external', url),

  // Updates
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  isPackaged: () => ipcRenderer.invoke('app:is-packaged'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateStatus: (handler) => {
    const listener = (_, payload) => handler(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
