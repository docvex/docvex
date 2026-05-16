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
import NotificationCenter from './components/NotificationCenter';
import App from './App';

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
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <ThemeProvider>
          <SelectedProjectProvider>
            <UpdatesProvider>
              <NotificationsProvider>
                <UploadsProvider>
                  <App />
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
