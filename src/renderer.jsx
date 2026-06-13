import './index.css';
import './styles/tokens.css';
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
import { SplitViewProvider } from './context/SplitViewContext';
import NotificationCenter from './components/NotificationCenter';
import { isElectron, isMac } from './lib/platform';
import { markLaunchConsumed } from './lib/launchGate';
import App from './App';

// Frameless Electron build draws a custom title bar — flag the document
// BEFORE first paint so the layout reserves --titlebar-h (no startup shift).
// Web keeps the browser chrome and skips this.
if (isElectron) {
  document.documentElement.classList.add('with-titlebar');
  // macOS keeps the native traffic-light buttons (titleBarStyle:'hidden' in
  // main.js) floating over our bar, so the title bar insets its brand to clear
  // them and hides its own window controls. Flag it before first paint too.
  if (isMac) document.documentElement.classList.add('is-mac');
}

// Project windows are opened from the launch hub with `?openProject=<id>`.
// When present, boot the router straight into that project's dashboard (so the
// window skips the launch hub entirely) and mark the launch gate consumed so a
// later navigation home doesn't bounce back to the hub.
const launchParams = new URLSearchParams(window.location.search);
const openProjectId = launchParams.get('openProject');
const openRoute = launchParams.get('route');
// Only honor an in-app route that targets the opened project (defence against
// a malformed query); otherwise default to that project's Files page (the
// working surface). The window hydrates its selected project from the
// ?openProject param (see SelectedProjectContext) so /files — which reads the
// global selection rather than a URL param — resolves to the right project.
const safeRoute =
  openRoute && openRoute.startsWith(`/projects/${openProjectId}`) ? openRoute : null;
// Document-viewer windows (opened from the Files page) boot straight into the
// full-screen /doc-viewer route, carrying the file's path/name/mime through.
const isDocViewer = launchParams.get('docViewer') === '1';
const initialEntries = isDocViewer
  ? [`/doc-viewer?${launchParams.toString()}`]
  : openProjectId
    ? [safeRoute || '/files']
    : ['/'];
if (openProjectId) markLaunchConsumed();

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
                  <SplitViewProvider>
                    <ChatUnreadProvider>
                      <App />
                    </ChatUnreadProvider>
                  </SplitViewProvider>
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
