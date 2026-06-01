import './index.css';
import './styles/tokens.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { UpdatesProvider } from './context/UpdatesContext';
import { NotificationsProvider } from './context/NotificationsContext';
import { SelectedProjectProvider } from './context/SelectedProjectContext';
import { UploadsProvider } from './context/UploadsContext';
import { BranchProvider } from './context/BranchContext';
import { ChatUnreadProvider } from './context/ChatUnreadContext';
import NotificationCenter from './components/NotificationCenter';
import { isElectron } from './lib/platform';
import { markLaunchConsumed } from './lib/launchGate';
import App from './App';

// Frameless Electron build draws a custom title bar — flag the document
// BEFORE first paint so the layout reserves --titlebar-h (no startup shift).
// Web keeps the browser chrome and skips this.
if (isElectron) document.documentElement.classList.add('with-titlebar');

// Project windows are opened from the launch hub with `?openProject=<id>`.
// When present, boot the router straight into that project's dashboard (so the
// window skips the launch hub entirely) and mark the launch gate consumed so a
// later navigation home doesn't bounce back to the hub.
const launchParams = new URLSearchParams(window.location.search);
const openProjectId = launchParams.get('openProject');
const openRoute = launchParams.get('route');
// Only honor an in-app route that targets the opened project (defence against
// a malformed query); otherwise default to that project's dashboard.
const safeRoute =
  openRoute && openRoute.startsWith(`/projects/${openProjectId}`) ? openRoute : null;
const initialEntries = openProjectId
  ? [safeRoute || `/projects/${openProjectId}/dashboard`]
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
//   NotificationsProvider       — needs Auth + Updates via its source hooks
//   UploadsProvider             — needs Auth + SelectedProject + Notifications
//                                 (uses notify() for rejection/error toasts).
//                                 Sits inside NotificationsProvider so the
//                                 toast helper is in scope; sits outside <App />
//                                 so the AppShell-mounted UploadModal reads
//                                 its state. NotificationCenter renders ABOVE
//                                 the modal's z-index (9999 vs 1000) so
//                                 toasts can pop in front of the dropzone.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>
        <ThemeProvider>
          <SelectedProjectProvider>
            <UpdatesProvider>
              <NotificationsProvider>
                <UploadsProvider>
                  <BranchProvider>
                    <ChatUnreadProvider>
                      <App />
                    </ChatUnreadProvider>
                  </BranchProvider>
                </UploadsProvider>
                <NotificationCenter />
              </NotificationsProvider>
            </UpdatesProvider>
          </SelectedProjectProvider>
        </ThemeProvider>
      </AuthProvider>
    </MemoryRouter>
  </React.StrictMode>
);
