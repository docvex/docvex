import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useUpdates } from '../context/UpdatesContext';
import { useNotifications } from '../context/NotificationsContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useReportProblem } from '../context/ReportProblemContext';
import { PLAN } from '../lib/plan';
import StatusBadge from './StatusBadge';
import StatusPicker from './StatusPicker';
import { updateStatus, DEFAULT_STATUS_KEY } from '../lib/userStatus';
// Vite imports the asset, hashes it, and emits an asset reference.
// Chromium (Electron's renderer) renders .ico in <img> tags, so the same
// favicon.ico the forge packager uses on Windows doubles as the in-app
// brand mark — one canonical source for both surfaces.
import brandIcon from '../favicon.ico';
import './Sidebar.css';

function getDisplayName(user) {
  const meta = user?.user_metadata;
  if (meta?.full_name) return meta.full_name;
  if (meta?.name)      return meta.name;
  // Fall back to the email's local part — "petreluca1105@gmail.com" reads
  // better as "petreluca1105" in the cramped sidebar than the full address.
  // The Account page still displays the full email beneath this name.
  if (user?.email) {
    const at = user.email.indexOf('@');
    return at > 0 ? user.email.slice(0, at) : user.email;
  }
  return 'Account';
}

// Pulse/heartbeat line — reads naturally as "activity feed", much more so
// than the old 4-rectangle grid which suggested a dashboard layout instead.
const ActivityIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
  </svg>
);

const BellIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>
);

const BriefcaseIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>
    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
  </svg>
);

// Layout-dashboard glyph (Lucide-style) — four rectangles of unequal sizes
// that read as "dashboard widgets". Picked specifically because the
// equal-grid version of this icon now lives on the Activity row as the old
// DashboardIcon was renamed/swapped to a pulse.
const ProjectDashboardIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="9"/>
    <rect x="14" y="3" width="7" height="5"/>
    <rect x="14" y="12" width="7" height="9"/>
    <rect x="3" y="16" width="7" height="5"/>
  </svg>
);

const FilesIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
  </svg>
);

const TodosIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 11 12 14 22 4"/>
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
  </svg>
);

// Two-person silhouette (Lucide "users" glyph) — reads as "people / contacts"
// at a glance. Same stroke recipe as the other sidebar icons so it inherits
// the nav-item color states (#888 idle, #e0e0e0 hover, #fff active, #555
// disabled) via `currentColor`.
const ClientsIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);

const SwitchIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="17 1 21 5 17 9"/>
    <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
    <polyline points="7 23 3 19 7 15"/>
    <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
  </svg>
);

const SignInIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
    <polyline points="10 17 15 12 10 7"/>
    <line x1="15" y1="12" x2="3" y2="12"/>
  </svg>
);

// Speech bubble with an exclamation mark — universal "report a
// problem" affordance. Stroke uses currentColor so the icon picks up
// the nav-item's hover / focus / active color state for free.
const ReportProblemIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);

const LockOpenIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
  </svg>
);

const LockClosedIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
);

const LOCK_STORAGE_KEY = 'docvex.sidebarLocked';

function AccountAvatar({ user, onBadgeClick }) {
  // Mirrors the Account page's avatar logic: real picture for OAuth users,
  // initial-letter fallback for email-only sign-ups. Wrapped in a
  // position-relative span so the StatusBadge can anchor to the corner.
  // The badge is rendered as a <button> with its own onClick that stops
  // propagation — clicking the dot opens the StatusPicker, NOT the parent
  // NavLink's /account navigation.
  const avatarUrl = user?.user_metadata?.avatar_url;
  const initial = (user?.email || '?').charAt(0).toUpperCase();
  const status = user?.user_metadata?.status || DEFAULT_STATUS_KEY;

  const avatarEl = avatarUrl ? (
    <img
      className="sidebar-avatar"
      src={avatarUrl}
      alt=""
      referrerPolicy="no-referrer"
    />
  ) : (
    <span className="sidebar-avatar sidebar-avatar-fallback">{initial}</span>
  );

  return (
    <span className="sidebar-avatar-wrap">
      {avatarEl}
      <StatusBadge
        status={status}
        size="sm"
        ringColor="var(--bg-sidebar)"
        onClick={(e) => {
          // Block the NavLink's /account navigation — clicking the dot
          // is its own affordance (open the picker), not a shortcut to
          // the Account page.
          e.preventDefault();
          e.stopPropagation();
          onBadgeClick(e.currentTarget.getBoundingClientRect());
        }}
      />
    </span>
  );
}

export default function Sidebar() {
  const { session } = useAuth();
  const { hasUpdate, currentVersion } = useUpdates();
  const { unreadCount } = useNotifications();
  const {
    selectedProject,
    pickerOpen,
    togglePicker,
    closePicker,
    switching,
    switchingToName,
  } = useSelectedProject();
  const { captureAndOpen: openReportProblem, capturing: reportCapturing } = useReportProblem();
  const { pathname } = useLocation();
  // Status picker anchor — DOMRect of the clicked StatusBadge. null = closed.
  // The picker re-anchors on every open (via the AccountAvatar's onBadgeClick
  // callback) so a sidebar resize between opens doesn't leave it floating.
  const [statusAnchor, setStatusAnchor] = useState(null);
  // Personal-section "Projects" item lights up on the project browser pages:
  //   /projects               — the list
  //   /projects/new           — the create form
  //   /projects/:id           — the Overview (reached by clicking a card)
  // but NOT on /projects/:id/dashboard (or any other sub-route), because
  // those are reached via the Projects sidebar section's own sub-items.
  // Built manually because NavLink's `end` is binary and can't express
  // "exact, plus this one specific deeper pattern".
  const personalProjectsActive = (() => {
    if (pathname === '/projects' || pathname === '/projects/') return true;
    if (pathname === '/projects/new') return true;
    // /projects/:id exactly — no further segment after the id.
    return /^\/projects\/[^/]+\/?$/.test(pathname);
  })();
  // Persist the lock preference so the layout doesn't snap closed on every reload.
  // First-time users (no key stored) default to LOCKED — explicit only flips it
  // to unlocked when the user clicks the lock button. Once stored, the user's
  // explicit choice (either way) wins.
  const [locked, setLocked] = useState(() => {
    try {
      const stored = localStorage.getItem(LOCK_STORAGE_KEY);
      return stored === null ? true : stored === 'true';
    } catch { return true; }
  });

  useEffect(() => {
    try { localStorage.setItem(LOCK_STORAGE_KEY, String(locked)); } catch { /* ignore */ }
  }, [locked]);

  // Cursor-following pill shown while hovering the Projects-section nav
  // items with NO project selected. The three rows (Dashboard / Files /
  // To-dos) render as disabled buttons in that state — the pill makes
  // the "why these are dimmed" affordance explicit without forcing the
  // user to wait for a native title tooltip.
  //
  // Position is the cursor's viewport coordinates with an 8px offset so
  // the pill sits just below-right of the pointer — close enough to read
  // as attached to the cursor without the cursor visual overlapping the
  // pill box. null means hidden. Rendered via createPortal at <body>
  // level because `.sidebar` has `contain: layout`, which makes it a
  // containing block for `position: fixed` descendants — without the
  // portal the pill would be clipped to the 60-220px sidebar column.
  const [lockedHintPos, setLockedHintPos] = useState(null);
  const showLockedHint = (e) => setLockedHintPos({ x: e.clientX, y: e.clientY });
  const hideLockedHint = () => setLockedHintPos(null);

  // Once a project gets picked, the disabled buttons unmount and are
  // replaced by real NavLinks — no `mouseleave` ever fires, so the pill
  // state would be left stale on screen. Clearing on the same dependency
  // that drives the swap keeps state and DOM in sync.
  useEffect(() => {
    if (selectedProject) setLockedHintPos(null);
  }, [selectedProject]);

  // Project-picker state (open/close, fetching the project list, Esc to
  // close) lives in ProjectPickerPanel.jsx now — the panel owns its own
  // data + key handling so the sidebar doesn't have to know.
  //
  // Personal section is config-driven (link rows only).
  const personalSection = {
    label: 'Personal',
    items: [
      { kind: 'link', to: '/', label: 'Activity', icon: ActivityIcon, end: true },
      // Active state is driven by `personalProjectsActive` (computed above)
      // instead of NavLink's `end` flag — `end` can only express "exact" or
      // "any descendant", but we want a custom set: the list, the create
      // form, and the project Overview (but NOT the project Dashboard, which
      // is owned by the Projects sidebar section's own sub-item).
      {
        kind: 'link',
        to: '/projects',
        label: 'Projects',
        icon: BriefcaseIcon,
        forcedActive: personalProjectsActive,
        visible: !!session,
      },
      {
        kind: 'link',
        to: '/notifications',
        label: 'Notifications',
        icon: BellIcon,
        end: true,
        visible: !!session,
        badge: unreadCount > 0 ? (unreadCount > 9 ? '9+' : String(unreadCount)) : null,
      },
    ].filter((i) => i.visible !== false),
  };


  return (
    <>
    <nav className={`sidebar${locked ? ' locked' : ''}${pickerOpen ? ' picker-open' : ''}`}>
      <div className="sidebar-brand">
        <div className="brand-left">
          <span className="icon brand-icon">
            <img src={brandIcon} alt="Docvex" className="brand-icon-img" />
          </span>
          <span className="label brand-text">
            <span className="brand-name">DOCVEX</span>
            {currentVersion && (
              <NavLink
                to="/updates"
                end
                className="brand-version"
                title={hasUpdate ? 'Update available — open Updates' : 'Open Updates'}
                onClick={closePicker}
              >
                {/* Once an update is pending the version number stops being
                    the actionable info — the pill takes its slot rather than
                    sitting next to it, so the brand block stays uncluttered
                    and the eye lands on the call-to-action. */}
                {hasUpdate ? (
                  <span className="brand-version-badge">Update available</span>
                ) : (
                  <span className="brand-version-num">v{currentVersion}</span>
                )}
              </NavLink>
            )}
          </span>
        </div>
        <button
          type="button"
          className={`label lock-btn${locked ? ' is-locked' : ''}`}
          onClick={() => setLocked((v) => !v)}
          title={locked ? 'Unlock sidebar' : 'Lock sidebar open'}
          aria-label={locked ? 'Unlock sidebar' : 'Lock sidebar open'}
          aria-pressed={locked}
        >
          {locked ? LockClosedIcon : LockOpenIcon}
        </button>
      </div>

      <ul className="sidebar-nav">
        {/* Personal section — config-driven (NavLink rows only). */}
        <li className="sidebar-section-header" aria-hidden="true">
          <span className="label sidebar-section-label">{personalSection.label}</span>
        </li>
        {personalSection.items.map(({ to, label, icon, end, badge, forcedActive }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              /* `forcedActive` overrides NavLink's own match when the item
                 has a non-standard active rule (see Projects above). */
              className={({ isActive }) =>
                `nav-item${(forcedActive ?? isActive) ? ' active' : ''}`
              }
              /* Clicking any sidebar nav item closes the picker — if the
                 user is navigating to another page, they don't want the
                 picker panel still floating over the new view. No-op when
                 the picker is already closed. */
              onClick={closePicker}
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

        {/* Projects section — static layout: trigger row + Files + To-dos.
            Files / To-dos always render. With no project selected they're
            buttons (`.is-disabled` dim) that open the picker on click; with
            a project selected they're regular NavLinks at full contrast. */}
        {session && (
          <>
            <li className="sidebar-section-header" aria-hidden="true">
              <span className="label sidebar-section-label">Projects</span>
            </li>
            <li>
              <button
                type="button"
                className={`project-picker-trigger${selectedProject ? ' has-selection' : ''}${switching ? ' is-switching' : ''}`}
                onClick={togglePicker}
                title={
                  switching
                    ? (switchingToName ? `Switching to ${switchingToName}…` : 'Switching project…')
                    : (selectedProject ? 'Switch project' : 'Select a project')
                }
              >
                {/* While a switch is in progress, replace the project name
                    with a small spinner so the trigger visibly tracks the
                    SwitchProjectLoader overlay's lifecycle. The spinner
                    sits where the name used to so the row height stays
                    stable across the transition. */}
                <span className="label">
                  {switching ? (
                    <span className="project-picker-trigger-spinner" aria-label="Switching project" />
                  ) : (
                    selectedProject ? selectedProject.name : 'Select a project'
                  )}
                </span>
              </button>
            </li>
            {selectedProject ? (
              <>
                <li>
                  <NavLink
                    /* /dashboard is the project's "working surface" (recent
                       files). The plain /projects/:id route is the project
                       Overview (members + admin) reached from the Projects
                       list — different mental model, different destination. */
                    to={`/projects/${selectedProject.id}/dashboard`}
                    end
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                    onClick={closePicker}
                  >
                    <span className="icon">{ProjectDashboardIcon}</span>
                    <span className="label">Dashboard</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/files"
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                    onClick={closePicker}
                  >
                    <span className="icon">{FilesIcon}</span>
                    <span className="label">Files</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/clients"
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                    onClick={closePicker}
                  >
                    <span className="icon">{ClientsIcon}</span>
                    <span className="label">Clients</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/todos"
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                    onClick={closePicker}
                  >
                    <span className="icon">{TodosIcon}</span>
                    <span className="label">To-dos</span>
                  </NavLink>
                </li>
              </>
            ) : (
              // Single <li> wrapping all three locked buttons so the
              // hover zone is one continuous rectangle — the cursor
              // moving from Dashboard → Files → To-dos never leaves
              // this element, no mouseleave fires, the pill stays
              // pinned and tracking. Three separate <li>s flickered
              // the pill off-and-on in the 4px gap between rows.
              // Internal spacing replicated via `gap: 4px` in CSS so
              // the visual layout is byte-identical to the old version.
              <li
                className="locked-projects-section"
                onMouseMove={showLockedHint}
                onMouseLeave={hideLockedHint}
              >
                <button
                  type="button"
                  className="nav-item is-disabled"
                  onClick={togglePicker}
                >
                  <span className="icon">{ProjectDashboardIcon}</span>
                  <span className="label">Dashboard</span>
                </button>
                <button
                  type="button"
                  className="nav-item is-disabled"
                  onClick={togglePicker}
                >
                  <span className="icon">{FilesIcon}</span>
                  <span className="label">Files</span>
                </button>
                <button
                  type="button"
                  className="nav-item is-disabled"
                  onClick={togglePicker}
                >
                  <span className="icon">{ClientsIcon}</span>
                  <span className="label">Clients</span>
                </button>
                <button
                  type="button"
                  className="nav-item is-disabled"
                  onClick={togglePicker}
                >
                  <span className="icon">{TodosIcon}</span>
                  <span className="label">To-dos</span>
                </button>
              </li>
            )}
          </>
        )}
      </ul>

      <div className="sidebar-footer">
        {session ? (() => {
          const displayName = getDisplayName(session.user);
          return (
            <NavLink
              to="/account"
              end
              className={({ isActive }) => `nav-item account-btn${isActive ? ' active' : ''}`}
              title={`${displayName} · ${PLAN.tier}`}
              onClick={closePicker}
            >
              <span className="icon">
                <AccountAvatar
                  user={session.user}
                  onBadgeClick={(rect) => setStatusAnchor(rect)}
                />
              </span>
              <span className="label account-btn-label">
                <span className="account-btn-name">{displayName}</span>
                <span className="account-btn-tier">{PLAN.tier}</span>
              </span>
            </NavLink>
          );
        })() : (
          <NavLink to="/auth" className="nav-item signin-btn">
            <span className="icon">{SignInIcon}</span>
            <span className="label">Sign in</span>
          </NavLink>
        )}
        {/* "Report a problem" — sits BELOW the Account row when the user
            is signed in. Gated on `session` because bug reports need a
            known sender (the Edge Function reads the user's auth email
            for the Reply-To header). While the screen capture is in
            flight (~200-700ms via html2canvas) we disable the button
            and dim it so the user gets feedback without a separate
            spinner element. */}
        {session && (
          <button
            type="button"
            className="nav-item report-problem-btn"
            onClick={openReportProblem}
            disabled={reportCapturing}
            title={reportCapturing ? 'Capturing screenshot…' : 'Report a problem'}
          >
            <span className="icon">{ReportProblemIcon}</span>
            <span className="label">
              {reportCapturing ? 'Capturing…' : 'Report a problem'}
            </span>
          </button>
        )}
      </div>
    </nav>
    {/* Cursor-following pill, portal'd to <body> so `.sidebar`'s
        `contain: layout` containing-block can't clip it. `pointer-events:
        none` lives in CSS so the pill never eats hover/click events from
        the row it's hovering over. The +8px offset places it just below-
        right of the cursor — tight enough to read as attached to the
        pointer but still clear of the cursor visual itself. */}
    {lockedHintPos && createPortal(
      <div
        className="locked-features-hint"
        aria-hidden="true"
        style={{ transform: `translate(${lockedHintPos.x + 8}px, ${lockedHintPos.y + 8}px)` }}
      >
        Select a project to use these features
      </div>,
      document.body,
    )}
    {statusAnchor && session && (
      <StatusPicker
        anchorRect={statusAnchor}
        currentStatus={session.user?.user_metadata?.status || DEFAULT_STATUS_KEY}
        onPick={async (key) => {
          setStatusAnchor(null);
          await updateStatus(key);
        }}
        onClose={() => setStatusAnchor(null)}
      />
    )}
    </>
  );
}
