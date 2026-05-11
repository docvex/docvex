import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { UpdatesProvider } from './context/UpdatesContext';
import { NotificationsProvider } from './context/NotificationsContext';
import { SelectedProjectProvider } from './context/SelectedProjectContext';
import NotificationCenter from './components/NotificationCenter';
import App from './App';

// Provider order:
//   AuthProvider                — session
//   SelectedProjectProvider     — needs AuthContext (per-user storage key + auto-clear)
//   UpdatesProvider             — independent
//   NotificationsProvider       — needs Auth + Updates via its source hooks
//
// NotificationCenter is a sibling of <App /> so toasts persist across route
// transitions; route-level visibility (hide on /auth) is handled inside the
// component via useLocation.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <SelectedProjectProvider>
          <UpdatesProvider>
            <NotificationsProvider>
              <App />
              <NotificationCenter />
            </NotificationsProvider>
          </UpdatesProvider>
        </SelectedProjectProvider>
      </AuthProvider>
    </MemoryRouter>
  </React.StrictMode>
);
