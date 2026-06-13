import React from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationsContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useSplitView } from '../context/SplitViewContext';
import Tooltip from './Tooltip';
import './Sidebar.css';

// App nav — a horizontal bar pinned directly under the frameless title bar.
// (Formerly a vertical left rail; moved to the top per product direction.)
// Project navigation (Files / Chat / AI) lives in the window topbar's
// destination dropdown; Account lives in the title bar. This bar carries the
// personal destinations (Activity / Newsletter / Settings, + Debug in dev) and
// the signed-out "Sign in" CTA.

// Pulse/heartbeat line — reads as "activity feed".
const ActivityIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
  </svg>
);

// Newspaper glyph — folded-page outline with masthead + column lines.
const NewspaperIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 22h14a2 2 0 0 0 2-2V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v16a2 2 0 0 1-2-2V8"/>
    <path d="M8 7h6M8 11h6M8 15h4"/>
  </svg>
);

// Split-layout glyph — the "Project" tab that restores the workspace split
// after a personal page took over fullscreen.
const LayoutIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <line x1="14" y1="3" x2="14" y2="21"/>
    <line x1="14" y1="12" x2="21" y2="12"/>
  </svg>
);

// Layers/stack glyph — the Versions (release history) destination.
const VersionsIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 2 7 12 12 22 7 12 2"/>
    <polyline points="2 17 12 22 22 17"/>
    <polyline points="2 12 12 17 22 12"/>
  </svg>
);

// Gear glyph — the app Settings destination.
const GearIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);

// Bug glyph — dev-only Debug row.
const BugIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="8" y="6" width="8" height="14" rx="4"/>
    <path d="M12 2v4M9 4l1.5 2M15 4l-1.5 2M3 9h3M18 9h3M2 14h4M18 14h4M4 19l3-2M20 19l-3-2"/>
  </svg>
);

// Envelope glyph — the personal Mail tab (AI-drafted replies).
const MailIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="14" rx="2"/>
    <path d="m3 7 9 6 9-6"/>
  </svg>
);

const SignInIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
    <polyline points="10 17 15 12 10 7"/>
    <line x1="15" y1="12" x2="3" y2="12"/>
  </svg>
);

export default function Sidebar() {
  const { session } = useAuth();
  const { unreadCount } = useNotifications();
  const { pickerOpen, closePicker } = useSelectedProject();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // Split view: these personal destinations open FULLSCREEN — clicking one
  // collapses any split layout back to a single window. focusedPanePath drives
  // the active highlight (null in single mode → NavLink's own root match).
  // `restoreSplit` powers the "Project" tab (back to the workspace layout).
  const { layout, setLayout, restoreSplit, setFocusedPane, focusedPanePath } = useSplitView();

  // Active state for a tab. With a secondary pane focused, match against that
  // window's path; otherwise defer to NavLink's own root match.
  const paneTabActive = (to, end, isActive) => {
    if (focusedPanePath == null) return isActive;
    if (end) return focusedPanePath === to;
    return focusedPanePath === to || focusedPanePath.startsWith(`${to}/`);
  };

  // Open the destination fullscreen: collapse any split layout to a single
  // window and focus the primary pane, then let the NavLink navigate the root
  // router normally (single mode renders the root Outlet full-area). Also
  // closes the project picker if it was open.
  const handleTabClick = () => {
    closePicker();
    setFocusedPane(0);
    setLayout('single');
  };

  // "Project" tab — restore the workspace split. If we're leaving a personal
  // page, point the primary pane at a project surface so it doesn't render the
  // personal page inside a split pane (the tri layout re-seeds to /chat itself).
  const PERSONAL_ROUTES = new Set(['/', '/newsletter', '/versions', '/settings', '/debug', '/account', '/mail']);
  const handleProjectClick = () => {
    closePicker();
    setFocusedPane(0);
    restoreSplit();
    if (PERSONAL_ROUTES.has(pathname)) navigate('/files');
  };

  // Personal destinations. Settings is signed-in only (matches where the gear
  // used to live); Debug is dev-only (import.meta.env.DEV is false in
  // packaged + web builds).
  const items = [
    {
      to: '/', label: 'Activity', icon: ActivityIcon, end: true,
      badge: unreadCount > 0 ? (unreadCount > 9 ? '9+' : String(unreadCount)) : null,
    },
    { to: '/newsletter', label: 'Newsletter', icon: NewspaperIcon, end: true },
    { to: '/versions', label: 'Versions', icon: VersionsIcon, end: true },
    ...(session ? [{ to: '/settings', label: 'Settings', icon: GearIcon, end: true }] : []),
    ...(session ? [{ to: '/mail', label: 'Mail', icon: MailIcon, end: true }] : []),
    ...(import.meta.env.DEV ? [{ to: '/debug', label: 'Debug', icon: BugIcon, end: true }] : []),
  ];

  return (
    <nav className={`sidebar${pickerOpen ? ' picker-open' : ''}`}>
      <ul className="sidebar-nav">
        {/* "Project" — restores the workspace split layout that a personal page
            collapsed when it opened fullscreen. Active while a split is live. */}
        <li>
          <Tooltip content="Back to the project workspace">
            <button
              type="button"
              className={`nav-item${layout !== 'single' ? ' active' : ''}`}
              onClick={handleProjectClick}
            >
              <span className="icon">{LayoutIcon}</span>
              <span className="label">Project</span>
            </button>
          </Tooltip>
        </li>
        {items.map(({ to, label, icon, end, badge }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                `nav-item${paneTabActive(to, end, isActive) ? ' active' : ''}`
              }
              onClick={handleTabClick}
            >
              <span className="icon">
                {icon}
                {badge && <span className="nav-badge" aria-hidden="true" />}
              </span>
              <span className="label nav-label-row">
                {label}
                {badge && <span className="nav-badge-text">{badge}</span>}
              </span>
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="sidebar-footer">
        {/* Account (signed in) lives in the title bar. The signed-out "Sign in"
            CTA stays here for shell routes. */}
        {!session && (
          <NavLink to="/auth" className="nav-item signin-btn">
            <span className="icon">{SignInIcon}</span>
            <span className="label">Sign in</span>
          </NavLink>
        )}
      </div>
    </nav>
  );
}
