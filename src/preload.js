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

  // Dev-only "DEBUG → Send all email previews to me" menu hook. Fires the
  // welcome, invite, and support-report Edge Functions with the debug
  // flag set so each template lands in the signed-in user's own inbox.
  // Returns an unsubscribe fn.
  onDebugSendEmailPreviews: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('debug:send-email-previews', listener);
    return () => ipcRenderer.removeListener('debug:send-email-previews', listener);
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

  // Local-folder sync — backs the Files page's "download to my PC"
  // workflow. The renderer pre-signs Supabase URLs and hands them off
  // to main, which does the actual fs writes (renderer is sandboxed
  // away from fs by contextIsolation). Web build doesn't have any of
  // these — ProjectFiles gates the whole local pane on
  // `window.electronAPI?.localFolder` being defined.
  localFolder: {
    pick: () => ipcRenderer.invoke('local-folder:pick'),
    list: (dir) => ipcRenderer.invoke('local-folder:list', dir),
    download: (payload) => ipcRenderer.invoke('local-folder:download', payload),
    // Write raw bytes already held in the renderer (e.g. files the
    // user picked via <input type=file>) directly into the user's
    // branch folder. Sibling of `download`, which fetches a URL —
    // here the renderer already has the bytes, so the IPC payload
    // carries them as an ArrayBuffer per file.
    writeFiles: (payload) => ipcRenderer.invoke('local-folder:write-files', payload),
    deleteFiles: (payload) => ipcRenderer.invoke('local-folder:delete-files', payload),
    renameFile: (payload) => ipcRenderer.invoke('local-folder:rename-file', payload),
    openPath: (target) => ipcRenderer.invoke('local-folder:open-path', target),
    showInFolder: (target) => ipcRenderer.invoke('local-folder:show-in-folder', target),
    // Filesystem watcher — main wraps a single fs.watch handle around
    // the requested dir. Renderer pairs `watch(dir)` with a handler
    // subscription via `onChange(...)`; the returned unsubscribe fn
    // detaches just the renderer listener (the watcher itself is
    // shared per-window and closed via `unwatch()`).
    watch: (dir) => ipcRenderer.invoke('local-folder:watch', dir),
    unwatch: () => ipcRenderer.invoke('local-folder:unwatch'),
    onChange: (handler) => {
      const listener = (_, dir) => handler(dir);
      ipcRenderer.on('local-folder:changed', listener);
      return () => ipcRenderer.removeListener('local-folder:changed', listener);
    },
    // Per-folder sidecar (.docvex.json) — persists the unique-ID
    // mapping for each file alongside the files themselves. Survives
    // browser-storage clears and syncs across teammates via
    // Dropbox/iCloud. See lib/localBranchMeta.js for the data shape
    // and reconciliation logic.
    readSidecar: (dir) => ipcRenderer.invoke('local-folder:read-sidecar', dir),
    writeSidecar: (payload) => ipcRenderer.invoke('local-folder:write-sidecar', payload),
  },
});
