import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { UpdatesProvider } from './context/UpdatesContext';
import { NotificationsProvider } from './context/NotificationsContext';
import { SelectedProjectProvider } from './context/SelectedProjectContext';
import { UploadsProvider } from './context/UploadsContext';
import NotificationCenter from './components/NotificationCenter';
import App from './App';

// Provider order:
//   AuthProvider                — session
//   SelectedProjectProvider     — needs AuthContext (per-user storage key + auto-clear)
//   UpdatesProvider             — independent
//   NotificationsProvider       — needs Auth + Updates via its source hooks
//   UploadsProvider             — needs Auth + SelectedProject + Notifications
//                                 (uses notify() for rejection/error toasts).
//                                 Sits inside NotificationsProvider so the
//                                 toast helper is in scope; sits outside <App />
//                                 so the AppShell-mounted UploadOverlay reads
//                                 its state. NotificationCenter renders ABOVE
//                                 the overlay's z-index (9999 vs 9998) so
//                                 toasts can pop in front of the drop card.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
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
      </AuthProvider>
    </MemoryRouter>
  </React.StrictMode>
);
