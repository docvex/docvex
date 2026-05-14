import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../context/NotificationsContext';
import { useUpdates } from '../context/UpdatesContext';
import { buildActions } from '../notifications/actionRegistry';
import { DEFAULT_TOAST_DURATION } from '../lib/notifications';
import { resolveNotificationIcon } from '../notifications/icons';

const CloseIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export default function NotificationToast({ notification }) {
  const { dismissToast } = useNotifications();
  const navigate = useNavigate();
  const { installUpdate } = useUpdates();

  const [leaving, setLeaving] = useState(false);
  const timerRef = useRef(null);
  const rootRef = useRef(null);

  // Rebuild action closures at render time so rows hydrated from localStorage
  // still get working buttons. ctx carries fresh React-bound callbacks.
  const actions = buildActions(notification, { navigate, installUpdate });

  // Begin the exit animation, then actually dismiss after the transition ends.
  // We don't unmount synchronously because that would skip the slide-out.
  const beginDismiss = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => dismissToast(notification.id), 180);
  }, [dismissToast, notification.id, leaving]);

  // Auto-dismiss timer. Reset on hover/focus pause and on every (re)mount.
  const startTimer = useCallback(() => {
    if (notification.persistent) return;
    const duration = Number(notification.duration) || DEFAULT_TOAST_DURATION;
    clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(beginDismiss, duration);
  }, [notification.persistent, notification.duration, beginDismiss]);

  const stopTimer = useCallback(() => {
    clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    startTimer();
    return stopTimer;
  }, [startTimer, stopTimer]);

  // Escape on a focused/hovered toast dismisses it (macOS-style).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const handler = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        beginDismiss();
      }
    };
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [beginDismiss]);

  // Category drives the border-left color + icon tint (see
  // NotificationCenter.css .toast-cat-* rules). Variant adds an override
  // for error/warning so failures always read as "stop and look".
  const cat = notification.category || 'system';
  const variant = notification.variant || 'info';
  const icon = resolveNotificationIcon(notification);

  return (
    <div
      ref={rootRef}
      className={`toast toast-${variant} toast-cat-${cat}${leaving ? ' toast-leaving' : ''}`}
      role="status"
      aria-live="polite"
      onMouseEnter={stopTimer}
      onMouseLeave={startTimer}
      onFocus={stopTimer}
      onBlur={startTimer}
      tabIndex={-1}
    >
      <span className="toast-icon" aria-hidden="true">
        {icon}
      </span>

      <div className="toast-body">
        <div className="toast-title">{notification.title}</div>
        {notification.body && <div className="toast-message">{notification.body}</div>}
        {actions.length > 0 && (
          <div className="toast-actions">
            {actions.map((action, i) => (
              <button
                key={i}
                type="button"
                className={`toast-action toast-action-${action.variant || 'secondary'}`}
                onClick={() => {
                  try { action.onClick?.(); } catch { /* swallow — UI shouldn't crash on a broken action */ }
                  beginDismiss();
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        className="toast-close"
        onClick={beginDismiss}
        aria-label="Dismiss notification"
      >
        {CloseIcon}
      </button>
    </div>
  );
}
