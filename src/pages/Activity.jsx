import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../context/NotificationsContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useUpdates } from '../context/UpdatesContext';
import { useAuth } from '../context/AuthContext';
import { buildActions } from '../notifications/actionRegistry';
import { resolveNotificationIcon } from '../notifications/icons';
import { formatRelativeTime } from '../lib/notifications';
import { isElectron } from '../lib/platform';
import { guessMimeFromName } from '../lib/localFolder';
import PageMasthead from '../components/PageMasthead';
import FileThumbnail from '../components/FileThumbnail';
import { glyphForFile } from '../components/fileGlyph';
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
// Filled folder — the same shape as the Files tab's crumb/tile glyph, used on
// folder-event group dividers instead of a file thumbnail.
const FolderGlyph = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

// Display-name resolution + deterministic avatar colour — mirrors
// getDisplayName() in Sidebar.jsx and the 12-colour djb2 fallback used across
// the app (Account.jsx, ProjectList.jsx). Keep them in sync.
function getDisplayName(user) {
  const meta = user?.user_metadata;
  if (meta?.full_name) return meta.full_name;
  if (meta?.name) return meta.name;
  if (user?.email) {
    const at = user.email.indexOf('@');
    return at > 0 ? user.email.slice(0, at) : user.email;
  }
  return 'Account';
}
const AVATAR_COLORS = ['#0891B2', '#BE185D', '#4F46E5', '#047857', '#B45309', '#6D28D9', '#DC2626', '#0369A1', '#DB2777', '#059669', '#7C3AED', '#EA580C'];
function colorForId(id) {
  if (!id) return AVATAR_COLORS[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) { h = ((h << 5) - h) + id.charCodeAt(i); h |= 0; }
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// ── Filter tab strip ──────────────────────────────────────────────────
// Rendered twice (inline tab bar + the on-scroll compact mini-header), so it's
// a component: each instance owns ONE shared underline element that slides to
// the active tab (transform + width transition in CSS) instead of a per-tab
// ::after that pops in and out.
function FilterTabs({ tabs, counts, active, onSelect }) {
  const stripRef = useRef(null);
  const underlineRef = useRef(null);

  // Place the underline under the active tab. Re-runs when the active tab or
  // the tab set changes; a ResizeObserver re-places on width shifts (count
  // digits changing, wrap, the compact bar appearing).
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const bar = underlineRef.current;
    if (!strip || !bar) return undefined;
    const place = () => {
      const btn = strip.querySelector(`[data-tab-id="${active}"]`);
      if (!btn) { bar.style.width = '0px'; return; }
      // Same insets as the old per-tab ::after (left 0.4rem / right 0.3rem),
      // straddling the strip's baseline exactly like the original underline.
      const x = btn.offsetLeft + 6.4;
      const y = btn.offsetTop + btn.offsetHeight - 0.32;
      bar.style.width = `${Math.max(btn.offsetWidth - 11.2, 0)}px`;
      bar.style.transform = `translate(${x}px, ${y}px)`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [active, tabs, counts]);

  return (
    <div className="activity-filters" role="tablist" aria-label="Filter activity" ref={stripRef}>
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-cat={tab.id}
            data-tab-id={tab.id}
            className={`activity-filter${isActive ? ' is-active' : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            {tab.id !== 'all' && <span className="activity-filter-dot" />}
            <span>{tab.label}</span>
            <span className="activity-filter-count">{counts[tab.id] || 0}</span>
          </button>
        );
      })}
      <span className="activity-filter-underline" data-cat={active} ref={underlineRef} aria-hidden="true" />
    </div>
  );
}

// ── Single activity row ───────────────────────────────────────────────
function ActivityRow({ notification, ctx, onMarkRead, onRemove }) {
  const { id, title, body, created_at, read_at, category, priority, variant } = notification;
  const actions = buildActions(notification, ctx);
  const glyph = resolveNotificationIcon(notification);
  const cat = category || 'system';
  const pri = priority || 'normal';
  const unread = !read_at;

  return (
    <li
      className={`activity-row${unread ? ' is-unread' : ''} is-pri-${pri} is-var-${variant || 'info'}`}
      data-cat={cat}
      onClick={() => { if (unread) onMarkRead(id); }}
    >
      {/* Category-tinted glyph square. File THUMBNAILS render only in the
          group dividers above — rows keep the compact category glyph. */}
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
        <span className="activity-time">{formatRelativeTime(created_at)}</span>
      </div>
      {/* Dismiss — pinned to the card's top-right corner, out of the flex
          flow so it never disturbs the row layout. */}
      <button
        type="button"
        className="activity-dismiss"
        aria-label="Dismiss"
        onClick={(e) => { e.stopPropagation(); onRemove(id); }}
      >
        {CloseIcon}
      </button>
    </li>
  );
}

export default function ActivityPage() {
  const { notifications, unreadCount, markRead, markAllRead, remove, clearAll } = useNotifications();
  const navigate = useNavigate();
  const { installUpdate } = useUpdates();
  const { session } = useAuth();
  const { selectedProject } = useSelectedProject();
  const userId = session?.user?.id || null;

  // Category filter (All = union). In-memory page state, not persisted —
  // matches the rest of the app. slideDir remembers which way the underline
  // travelled on the last filter change (+1 right / -1 left / 0 initial) so
  // the feed below can slide in from the same direction.
  const [filter, setFilter] = useState('all');
  const [slideDir, setSlideDir] = useState(0);

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

  // Feed grouped by what each event touched:
  //   • file events           → one group per file (thumbnail + name divider)
  //   • batch file events     → "Multiple files"
  //   • account events (auth) → one divider with the user's avatar + name
  //   • project architecture  → project lifecycle / members / roles group
  //                             under a divider named after the PROJECT
  //   • everything else       → "System", at the end
  // Groups are ordered by their newest event.
  const accountUser = session?.user || null;
  const PROJECT_CATEGORIES = new Set(['project', 'member', 'role']);
  const groups = useMemo(() => {
    const map = new Map();
    const push = (key, label, n, extra) => {
      if (!map.has(key)) map.set(key, { key, label, items: [], file: null, account: null, multi: null, ...extra });
      const g = map.get(key);
      g.items.push(n);
      // Merge file facts across the group's events (newest-first): keep the
      // first on-disk path / project name seen, and let ANY folder event mark
      // the whole group as a folder.
      if (extra?.file) {
        g.file = g.file || { name: extra.file.name };
        if (!g.file.path && extra.file.path) g.file.path = extra.file.path;
        if (!g.file.project && extra.file.project) g.file.project = extra.file.project;
        if (extra.file.folder) g.file.folder = true;
      }
      // Same first-seen rule for the batch ("Multiple files") group's project.
      if (extra?.multi) {
        g.multi = g.multi || {};
        if (!g.multi.project && extra.multi.project) g.multi.project = extra.multi.project;
      }
    };
    for (const n of filtered) {
      const a = n.payload?.activity;
      if (a?.fileName) {
        push(`file-${a.fileName.toLowerCase()}`, a.fileName, n, {
          file: {
            name: a.fileName,
            path: a.filePath || null,
            folder: !!a.folder,
            project: a.projectName || null,
          },
        });
      } else if (a) {
        push('__multi', 'Multiple files', n, { multi: { project: a.projectName || null } });
      } else if ((n.category || '') === 'auth') {
        push('__account', getDisplayName(accountUser), n, {
          account: {
            name: getDisplayName(accountUser),
            avatarUrl: accountUser?.user_metadata?.avatar_url || null,
            color: colorForId(accountUser?.id || ''),
          },
        });
      } else if (PROJECT_CATEGORIES.has(n.category || '')) {
        // Project-architecture events (renames, invites, role changes…).
        // Best-effort project name: the notification's own payload when it
        // carries one, otherwise the currently selected project.
        const projName = n.payload?.projectName || selectedProject?.name || 'Project';
        push(`proj-${projName.toLowerCase()}`, projName, n);
      } else {
        push('__system', 'System', n);
      }
    }
    const rank = (g) => (g.key === '__system' ? 1 : 0);
    return [...map.values()].sort((a, b) =>
      rank(a) - rank(b)
      || (Date.parse(b.items[0]?.created_at) || 0) - (Date.parse(a.items[0]?.created_at) || 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, accountUser, selectedProject?.name]);

  // Filter change with direction: compare old/new tab indices so both the
  // underline (CSS transition) and the feed slide-in move the same way.
  const selectFilter = (id) => {
    if (id === filter) return;
    const from = filterTabs.findIndex((t) => t.id === filter);
    const to = filterTabs.findIndex((t) => t.id === id);
    setSlideDir(to >= from ? 1 : -1);
    setFilter(id);
  };

  // Filter tab strip — rendered both inline (under the masthead) and inside the
  // on-scroll compact "mini header" (passed as PageMasthead's compactRight) so
  // filtering stays available once the big title scrolls away.
  const renderFilters = () => (
    <FilterTabs tabs={filterTabs} counts={catCounts} active={filter} onSelect={selectFilter} />
  );

  return (
    <div className="activity-page">
      <PageMasthead
        eyebrow="DocVex Journal"
        eyebrowMuted="All projects"
        title="Activity"
        compactRight={notifications.length > 0 ? renderFilters() : null}
      >
        A running record of everything happening across every project you're part of —
        files added or changed, invites, role updates, releases and sign-ins.
      </PageMasthead>

      {notifications.length > 0 && (
        <div className="activity-tabbar">
          {renderFilters()}
          {/* Bulk actions sit in line with the filter tabs (right-aligned). */}
          <div className="activity-tabbar-actions">
            <button type="button" className="act-btn" onClick={markAllRead} disabled={unreadCount === 0}>
              Mark all read
            </button>
            <button type="button" className="act-btn" onClick={clearAll} disabled={notifications.length === 0}>
              Clear all
            </button>
          </div>
        </div>
      )}

      {notifications.length === 0 ? (
        <div className="activity-empty">
          {BellOffIcon}
          <p className="activity-empty-title">Nothing here yet</p>
          <p className="activity-empty-help">
            File uploads, invites, role changes, releases and sign-ins show up here as they happen.
          </p>
        </div>
      ) : (
        /* Keyed on the filter so switching tabs remounts the feed and replays
           the slide-in — entering from the side the underline travelled
           toward. slideDir 0 (initial load) renders with no animation. */
        <div
          key={filter}
          className={`activity-feed${slideDir > 0 ? ' is-enter-right' : slideDir < 0 ? ' is-enter-left' : ''}`}
        >
          {filtered.length === 0 ? (
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
              {/* File groups get a Files-tab-style divider: thumbnail + name.
                  The thumb resolves from the on-disk bytes when the event
                  recorded a path (Electron localfile://), otherwise it falls
                  back to the extension glyph — same chain as the Files grid. */}
              <h2 className="activity-group-label">
                {g.file ? (
                  <span className="activity-group-file">
                    <span className={`activity-group-thumb${g.file.folder ? ' is-folder' : ''}`}>
                      {g.file.folder ? FolderGlyph : (
                        <FileThumbnail
                          mimeType={guessMimeFromName(g.file.name)}
                          sourceUrl={isElectron && g.file.path ? `localfile://local/${encodeURIComponent(g.file.path)}` : null}
                          glyph={glyphForFile(guessMimeFromName(g.file.name), g.file.name)}
                        />
                      )}
                    </span>
                    <span className="activity-group-filename">{g.file.name}</span>
                    {/* Short rule segment · the project the file lives in;
                        the label's trailing hairline continues after it. The
                        SELECTED project reads in the accent project-divider
                        style; files from other projects stay muted. */}
                    {g.file.project && (
                      <>
                        <span className="activity-group-rule" aria-hidden="true" />
                        <span className={g.file.project === selectedProject?.name ? 'activity-group-project' : 'activity-group-projname'}>
                          {g.file.project}
                        </span>
                      </>
                    )}
                  </span>
                ) : g.account ? (
                  /* Account divider — the signed-in user's avatar + name,
                     mirroring the file dividers' thumbnail + name shape. */
                  <span className="activity-group-file">
                    <span className="activity-group-avatar" style={{ background: g.account.avatarUrl ? 'var(--bg-elevated)' : g.account.color }}>
                      {g.account.avatarUrl
                        ? <img src={g.account.avatarUrl} alt="" referrerPolicy="no-referrer" draggable={false} />
                        : (g.account.name || '?').charAt(0).toUpperCase()}
                    </span>
                    <span className="activity-group-filename">{g.account.name}</span>
                  </span>
                ) : g.key === '__multi' ? (
                  /* Batch divider — "Multiple files" with the same project
                     tail as the single-file dividers. */
                  <span className="activity-group-file">
                    <span className="activity-group-filename">{g.label}</span>
                    {g.multi?.project && (
                      <>
                        <span className="activity-group-rule" aria-hidden="true" />
                        <span className={g.multi.project === selectedProject?.name ? 'activity-group-project' : 'activity-group-projname'}>
                          {g.multi.project}
                        </span>
                      </>
                    )}
                  </span>
                ) : g.key.startsWith('proj-') ? (
                  /* Project divider — the project's name, sized up and painted
                     in the masthead eyebrow's accent colour. */
                  <span className="activity-group-project">{g.label}</span>
                ) : g.label}
              </h2>
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
      )}
    </div>
  );
}
