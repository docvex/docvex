import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { UpdatesProvider } from './context/UpdatesContext';
import { NotificationsProvider } from './context/NotificationsContext';
import NotificationCenter from './components/NotificationCenter';
import App from './App';

// NotificationsProvider sits innermost so it can consume AuthContext +
// UpdatesContext via its source hooks. NotificationCenter is rendered as a
// sibling to <App /> so toasts persist across route transitions; route-level
// visibility (hide on /auth) is handled inside the component via useLocation.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <UpdatesProvider>
          <NotificationsProvider>
            <App />
            <NotificationCenter />
          </NotificationsProvider>
        </UpdatesProvider>
      </AuthProvider>
    </MemoryRouter>
  </React.StrictMode>
);
