import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../context/NotificationsContext';
import { useUpdates } from '../context/UpdatesContext';
import { buildActions } from '../notifications/actionRegistry';
import {
  formatRelativeTime,
  groupByDay,
  NOTIFICATION_PRIORITIES,
} from '../lib/notifications';
import { resolveNotificationIcon } from '../notifications/icons';
import './Notifications.css';

// Tab strip definition. Order is hierarchical: All first as the default
// "show me everything", then critical → high → normal → low matching the
// priority enum's intrinsic weight (lower index = more urgent).
const PRIORITY_TABS = Object.freeze([
  { id: 'all',                                  label: 'All' },
  { id: NOTIFICATION_PRIORITIES.CRITICAL,       label: 'Critical' },
  { id: NOTIFICATION_PRIORITIES.HIGH,           label: 'High' },
  { id: NOTIFICATION_PRIORITIES.NORMAL,         label: 'Normal' },
  { id: NOTIFICATION_PRIORITIES.LOW,            label: 'Low' },
]);

// Inline SVGs per CLAUDE.md convention.
const AuthIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const UpdateIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

const SocialIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const SystemIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const InfoIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
);

const CloseIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const BellOffIcon = (
  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
    <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
    <path d="M18 8a6 6 0 0 0-9.33-5" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

// CategoryIcon is retained as a fallback for very old persisted rows that
// predate the resolveNotificationIcon helper, but new code paths always
// flow through the resolver — it knows about explicit per-notification
// icons AND falls back through variant → category → info in one call.
const CategoryIcon = {
  auth: AuthIcon,
  update: UpdateIcon,
  social: SocialIcon,
  system: SystemIcon,
  info: InfoIcon,
};

function NotificationRow({ notification, ctx, onMarkRead, onRemove }) {
  const { id, variant, title, body, created_at, read_at, category, priority } = notification;
  const actions = buildActions(notification, ctx);
  const handleRowClick = () => {
    if (!read_at) onMarkRead(id);
  };
  // Resolved per-notification icon — explicit > variant default (error/
  // warning) > category default (folder/user/etc.).
  const icon = resolveNotificationIcon(notification) || CategoryIcon[category] || InfoIcon;
  // Priority falls back to 'normal' for older persisted rows without the
  // field. The dot itself only renders for non-normal (the class hides
  // the normal dot via display:none) so the default look stays clean.
  const effectivePriority = priority || 'normal';
  return (
    <li
      className={`n-row n-row-${variant || 'info'} n-row-cat-${category || 'system'} n-row-pri-${effectivePriority}${read_at ? '' : ' n-row-unread'}`}
      onClick={handleRowClick}
    >
      <span className="n-row-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="n-row-body">
        <div className="n-row-head">
          <span className="n-row-title-wrap">
            {/* Priority dot — only visually present for critical/high/low;
                the .n-row-pri-normal rule hides it. Tooltip exposes the
                priority name for screen readers + hover. */}
            <span
              className="n-row-priority"
              title={`Priority: ${effectivePriority}`}
              aria-label={`Priority: ${effectivePriority}`}
            />
            <span className="n-row-title">{title}</span>
          </span>
          <time
            className="n-row-time"
            dateTime={created_at}
            title={new Date(created_at).toLocaleString()}
          >
            {formatRelativeTime(created_at)}
          </time>
        </div>
        {body && <div className="n-row-message">{body}</div>}
        {actions.length > 0 && (
          <div className="n-row-actions">
            {actions.map((a, i) => (
              <button
                key={i}
                type="button"
                className={`n-row-action n-row-action-${a.variant || 'secondary'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  try { a.onClick?.(); } catch { /* swallow */ }
                  if (!read_at) onMarkRead(id);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className="n-row-remove"
        aria-label="Delete notification"
        onClick={(e) => { e.stopPropagation(); onRemove(id); }}
      >
        {CloseIcon}
      </button>
    </li>
  );
}

export default function NotificationsPage() {
  const { notifications, unreadCount, markRead, markAllRead, remove, clearAll } = useNotifications();
  const navigate = useNavigate();
  const { installUpdate } = useUpdates();
  // Active priority tab — 'all' is the default union, the others filter
  // to ONLY that priority (exclusive). Page-state lives in memory; not
  // persisted across reloads (matches the rest of the app's convention).
  const [priorityFilter, setPriorityFilter] = useState('all');

  // Per-priority counts derived in one pass over the full list. Drives
  // the tab badges so the unread-by-priority signal reads at a glance.
  // `all` is just the total length; reading both off the same memoized
  // object means no double-iteration.
  const counts = useMemo(() => {
    const out = { all: notifications.length, critical: 0, high: 0, normal: 0, low: 0 };
    for (const n of notifications) {
      const p = n.priority || 'normal';
      if (out[p] != null) out[p] += 1;
    }
    return out;
  }, [notifications]);

  // Filter the list before day-grouping. 'all' is a pass-through.
  const filtered = useMemo(() => {
    if (priorityFilter === 'all') return notifications;
    return notifications.filter((n) => (n.priority || 'normal') === priorityFilter);
  }, [notifications, priorityFilter]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);
  const ctx = useMemo(() => ({ navigate, installUpdate }), [navigate, installUpdate]);

  return (
    <div className="notifications-page">
      <header className="notifications-header">
        <div>
          <h1 className="notifications-title">Notifications</h1>
          <p className="notifications-subtitle">
            {notifications.length === 0
              ? 'You are all caught up.'
              : `${notifications.length} total · ${unreadCount} unread`}
          </p>
        </div>
        <div className="notifications-header-actions">
          <button
            type="button"
            className="notifications-btn"
            onClick={markAllRead}
            disabled={unreadCount === 0}
          >
            Mark all read
          </button>
          <button
            type="button"
            className="notifications-btn"
            onClick={clearAll}
            disabled={notifications.length === 0}
          >
            Clear all
          </button>
        </div>
      </header>

      {/* Priority filter tabs — exclusive. Each non-All tab shows only
          that priority; All is the union. Counts come from a single-pass
          memo above. The tab strip renders even on an empty inbox so the
          UI shape is stable (users see the surface area available). */}
      {notifications.length > 0 && (
        <nav className="n-tabs" role="tablist" aria-label="Filter by priority">
          {PRIORITY_TABS.map((t) => {
            const active = priorityFilter === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`n-tab${active ? ' is-active' : ''} n-tab-${t.id}`}
                onClick={() => setPriorityFilter(t.id)}
              >
                <span>{t.label}</span>
                <span className="n-tab-count">{counts[t.id] || 0}</span>
              </button>
            );
          })}
        </nav>
      )}

      {notifications.length === 0 ? (
        <div className="notifications-empty">
          <span className="notifications-empty-icon" aria-hidden="true">{BellOffIcon}</span>
          <p className="notifications-empty-title">No notifications yet</p>
          <p className="notifications-empty-help">
            Sign-ins, update lifecycle, and (soon) social events will land here as they happen.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        // Tab-specific empty state — happens when the user picks a tab
        // (e.g. "Critical") that has zero items in their history. Tells
        // them WHY the list is empty (filter, not data) so they don't
        // wonder if a notification got eaten.
        <div className="notifications-empty">
          <span className="notifications-empty-icon" aria-hidden="true">{BellOffIcon}</span>
          <p className="notifications-empty-title">
            No {PRIORITY_TABS.find((t) => t.id === priorityFilter)?.label?.toLowerCase()} notifications
          </p>
          <p className="notifications-empty-help">
            Nothing in this priority bucket right now. Try the All tab to see everything.
          </p>
        </div>
      ) : (
        <div className="notifications-groups">
          {groups.map((group) => (
            <section key={group.dayStart} className="n-group">
              <h2 className="n-group-label">{group.label}</h2>
              <ul className="n-group-list">
                {group.items.map((n) => (
                  <NotificationRow
                    key={n.id}
                    notification={n}
                    ctx={ctx}
                    onMarkRead={markRead}
                    onRemove={remove}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
