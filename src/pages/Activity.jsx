import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../context/NotificationsContext';
import { useUpdates } from '../context/UpdatesContext';
import { useAuth } from '../context/AuthContext';
import { buildActions } from '../notifications/actionRegistry';
import { resolveNotificationIcon } from '../notifications/icons';
import { formatRelativeTime, groupByDay } from '../lib/notifications';
import ActivityMetrics from '../components/ActivityMetrics';
import './Activity.css';

// Activity = the merged home of what used to be the (empty) "/" Activity
// dashboard + the "/notifications" inbox. One feed of everything that has
// happened across the user's projects — file adds, invites, role changes,
// releases, sign-ins — relabelled as "activity". Data comes straight from
// NotificationsContext (category / variant / priority / icon already there);
// the redesign just reframes each row as an activity card.

// Friendly labels + display order for the category filter tabs. Mirrors the
// --cat-* token set; `data-cat` on the tab/row drives the colour in CSS.
const CATEGORY_LABELS = {
  file: 'Files',
  member: 'Members',
  project: 'Projects',
  role: 'Roles',
  update: 'Updates',
  auth: 'Sign-ins',
  support: 'Support',
  social: 'Social',
  system: 'System',
  info: 'Other',
};
const CATEGORY_ORDER = ['file', 'member', 'project', 'role', 'update', 'auth', 'support', 'social', 'system', 'info'];

// ── Inline icons (CLAUDE.md convention) ───────────────────────────────
const CloseIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const BellOffIcon = (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.73 21a2 2 0 0 1-3.46 0" /><path d="M18.63 13A17.89 17.89 0 0 1 18 8" /><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" /><path d="M18 8a6 6 0 0 0-9.33-5" /><line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

// ── Single activity row ───────────────────────────────────────────────
function ActivityRow({ notification, ctx, onMarkRead, onRemove }) {
  const { id, title, body, created_at, read_at, category, priority } = notification;
  const actions = buildActions(notification, ctx);
  const glyph = resolveNotificationIcon(notification);
  const cat = category || 'system';
  const pri = priority || 'normal';
  const unread = !read_at;

  return (
    <li
      className={`activity-row${unread ? ' is-unread' : ''} is-pri-${pri}`}
      data-cat={cat}
      onClick={() => { if (unread) onMarkRead(id); }}
    >
      {/* Category-tinted glyph square (no actor data on notifications yet) */}
      <div className="activity-avatar-wrap">
        <span className="activity-glyph">{glyph}</span>
      </div>

      <div className="activity-body">
        <span className="activity-sentence"><strong>{title}</strong></span>
        {body && <div className="activity-detail">{body}</div>}
        {actions.length > 0 && (
          <div className="activity-actions">
            {actions.map((a, i) => (
              <button
                key={i}
                type="button"
                className={`activity-action is-${a.variant || 'secondary'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  try { a.onClick?.(); } catch { /* swallow */ }
                  if (unread) onMarkRead(id);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="activity-meta">
        <span className="activity-time">
          <span className="activity-unread-dot" />
          {formatRelativeTime(created_at)}
        </span>
        <button
          type="button"
          className="activity-dismiss"
          aria-label="Dismiss"
          onClick={(e) => { e.stopPropagation(); onRemove(id); }}
        >
          {CloseIcon}
        </button>
      </div>
    </li>
  );
}

export default function ActivityPage() {
  const { notifications, unreadCount, markRead, markAllRead, remove, clearAll } = useNotifications();
  const navigate = useNavigate();
  const { installUpdate } = useUpdates();
  const { session } = useAuth();
  const userId = session?.user?.id || null;

  // Category filter (All = union). In-memory page state, not persisted —
  // matches the rest of the app.
  const [filter, setFilter] = useState('all');

  const ctx = useMemo(() => ({ navigate, installUpdate }), [navigate, installUpdate]);

  // Per-category counts in one pass; drives both the tab badges and which
  // category tabs render (empty categories are hidden, like the design).
  const catCounts = useMemo(() => {
    const out = { all: notifications.length };
    for (const n of notifications) {
      const c = n.category || 'system';
      out[c] = (out[c] || 0) + 1;
    }
    return out;
  }, [notifications]);

  const filterTabs = useMemo(() => {
    const present = CATEGORY_ORDER.filter((c) => (catCounts[c] || 0) > 0);
    return [{ id: 'all', label: 'All' }, ...present.map((c) => ({ id: c, label: CATEGORY_LABELS[c] || c }))];
  }, [catCounts]);

  const filtered = useMemo(
    () => (filter === 'all' ? notifications : notifications.filter((n) => (n.category || 'system') === filter)),
    [notifications, filter],
  );

  // Day-grouped feed.
  const groups = useMemo(
    () => groupByDay(filtered).map((g) => ({ key: g.key, label: g.label, items: g.items })),
    [filtered],
  );

  return (
    <div className="activity-page">
      <header className="activity-header">
        <div className="activity-title-block">
          <span className="activity-eyebrow">Live feed</span>
          <h1 className="activity-title">Activity</h1>
          <p className="activity-subtitle">
            A running record of everything happening across every project you're part of —
            files added or changed, invites, role updates, releases and sign-ins.
          </p>
        </div>
        <div className="activity-header-actions">
          <button type="button" className="act-btn" onClick={markAllRead} disabled={unreadCount === 0}>
            Mark all read
          </button>
          <button type="button" className="act-btn" onClick={clearAll} disabled={notifications.length === 0}>
            Clear all
          </button>
        </div>
      </header>

      {notifications.length > 0 && (
        <div className="activity-tabbar" role="tablist" aria-label="Filter activity">
          <div className="activity-filters">
            {filterTabs.map((tab) => {
              const active = filter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-cat={tab.id}
                  className={`activity-filter${active ? ' is-active' : ''}`}
                  onClick={() => setFilter(tab.id)}
                >
                  {tab.id !== 'all' && <span className="activity-filter-dot" />}
                  <span>{tab.label}</span>
                  <span className="activity-filter-count">{catCounts[tab.id] || 0}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="activity-feed-scroll">
      {/* Personal activity metrics — scroll together with the feed below. */}
      <ActivityMetrics userId={userId} />
      {notifications.length === 0 ? (
        <div className="activity-empty">
          {BellOffIcon}
          <p className="activity-empty-title">Nothing here yet</p>
          <p className="activity-empty-help">
            File uploads, invites, role changes, releases and sign-ins show up here as they happen.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="activity-empty">
          {BellOffIcon}
          <p className="activity-empty-title">
            No {(CATEGORY_LABELS[filter] || filter).toLowerCase()} activity
          </p>
          <p className="activity-empty-help">Nothing in this category right now. Try the All tab to see everything.</p>
        </div>
      ) : (
        <div className="activity-groups">
          {groups.map((g) => (
            <section key={g.key} className="activity-group">
              <h2 className="activity-group-label">{g.label}</h2>
              <ul className="activity-list">
                {g.items.map((n) => (
                  <ActivityRow
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
    </div>
  );
}
