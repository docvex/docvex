import './index.css';
import './styles/tokens.css';
import './styles/miniHeader.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { AppPrefsProvider } from './context/AppPrefsContext';
import { UpdatesProvider } from './context/UpdatesContext';
import { NotificationsProvider } from './context/NotificationsContext';
import { SelectedProjectProvider } from './context/SelectedProjectContext';
import { ChatUnreadProvider } from './context/ChatUnreadContext';
import NotificationCenter from './components/NotificationCenter';
import { isElectron, isMac } from './lib/platform';
import App from './App';

// Document-viewer windows (opened from the Files page) boot straight into the
// full-screen /doc-viewer route, carrying the file's path/name/mime through.
// Tray "Extract text" overlay windows boot into /snip with the frozen
// screenshot's path. Every other window is the main app.
const launchParams = new URLSearchParams(window.location.search);
const isDocViewer = launchParams.get('docViewer') === '1';
const isSnip = launchParams.get('snip') === '1';

// Frameless Electron build draws a custom title bar — flag the document
// BEFORE first paint so the layout reserves --titlebar-h (no startup shift).
// Web keeps the browser chrome and skips this. The tray "Extract text"
// overlay is chromeless edge-to-edge (the frozen screenshot must fill the
// display exactly), so it skips the reservation too.
if (isElectron && !isSnip) {
  document.documentElement.classList.add('with-titlebar');
  // macOS keeps the native traffic-light buttons (titleBarStyle:'hidden' in
  // main.js) floating over our bar, so the title bar insets its brand to clear
  // them and hides its own window controls. Flag it before first paint too.
  if (isMac) document.documentElement.classList.add('is-mac');
}
const initialEntries = isDocViewer
  ? [`/doc-viewer?${launchParams.toString()}`]
  : isSnip
    ? [`/snip?${launchParams.toString()}`]
    : ['/'];

// Provider order:
//   AuthProvider                — session
//   ThemeProvider               — needs Auth (per-user theme localStorage key);
//                                 sits OUTSIDE the rest so the data-theme
//                                 attribute on <html> is set before any other
//                                 provider's children render (avoids a paint
//                                 with the wrong tokens).
//   SelectedProjectProvider     — needs AuthContext (per-user storage key + auto-clear)
//   UpdatesProvider             — independent
//   NotificationsProvider       — needs Auth + Updates via its source hooks.
//                                 NotificationCenter renders inside it (toast
//                                 stack at z 9999).
//   ChatUnreadProvider          — chat unread badges.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>
        <ThemeProvider>
          <AppPrefsProvider>
            <SelectedProjectProvider>
              <UpdatesProvider>
                <NotificationsProvider>
                  <ChatUnreadProvider>
                    <App />
                  </ChatUnreadProvider>
                  <NotificationCenter />
                </NotificationsProvider>
              </UpdatesProvider>
            </SelectedProjectProvider>
          </AppPrefsProvider>
        </ThemeProvider>
      </AuthProvider>
    </MemoryRouter>
  </React.StrictMode>
);
