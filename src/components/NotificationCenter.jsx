import React from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useNotifications } from '../context/NotificationsContext';
import NotificationToast from './NotificationToast';
import './NotificationCenter.css';

// Routes that should never show toasts. /auth is full-screen sign-in — a
// toast bleeding over that would look like a bug.
const TOAST_HIDDEN_ROUTES = new Set(['/auth']);

export default function NotificationCenter() {
  const { activeToasts } = useNotifications();
  const { pathname } = useLocation();

  if (TOAST_HIDDEN_ROUTES.has(pathname)) return null;
  if (activeToasts.length === 0) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="notification-center"
      role="region"
      aria-label="Notifications"
    >
      {activeToasts.map((n) => (
        <NotificationToast key={n.id} notification={n} />
      ))}
    </div>,
    document.body
  );
}
