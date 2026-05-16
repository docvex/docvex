import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useUpdates } from '../context/UpdatesContext';
import { useNotifications } from '../context/NotificationsContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useReportProblem } from '../context/ReportProblemContext';
import { PLAN } from '../lib/plan';
import StatusBadge from './StatusBadge';
import StatusPicker from './StatusPicker';
import Tooltip from './Tooltip';
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

// Speech bubble for the Chat tab.
const ChatIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);

// Sparkles for the Generate tab — reads as "AI / create".
const GenerateIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>
    <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/>
    <path d="M5 4l.7 1.9L7.6 6.6 5.7 7.3 5 9.2 4.3 7.3 2.4 6.6l1.9-.7z"/>
  </svg>
);

// Lightning bolt for the Automate tab — universal "automation / workflow" glyph.
const AutomateIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
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

// "Select a project to use these features" pill rendered inline inside
// the locked-projects section. CSS gives it a fully-rounded
// `border-radius: 999px` (stadium shape) by default, which only looks
// right when the text fits on a single line — once the copy wraps, the
// big half-circle ends pinch awkwardly into the lines. This component
// watches the pill's rendered height via ResizeObserver and toggles
// `is-multiline` when the content rises above ~1 line, at which point
// CSS swaps the radius for a softer corner that reads correctly on
// multi-line content.
function LockedProjectsHint() {
  const ref = useRef(null);
  const [multiLine, setMultiLine] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // `display: none` (sidebar collapsed) yields offsetHeight 0 and
      // a non-numeric line-height; bail before computing nonsense.
      if (el.offsetHeight === 0) return;
      const cs = getComputedStyle(el);
      const lineHeight = parseFloat(cs.lineHeight);
      const padTop = parseFloat(cs.paddingTop);
      const padBottom = parseFloat(cs.paddingBottom);
      const contentHeight = el.offsetHeight - padTop - padBottom;
      // 1.4 × line-height threshold gives a comfortable margin: a single
      // line measures ~1.0 ×, two lines measure ~2.0 ×, so the cutoff
      // never flickers on sub-pixel rounding.
      setMultiLine(contentHeight > lineHeight * 1.4);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <span
      ref={ref}
      className={`locked-projects-hint${multiLine ? ' is-multiline' : ''}`}
      aria-hidden="true"
    >
      Select a project to use these features
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

  // Project memory / AI usage card — two states:
  //   - minimized (default): both progress bars stacked vertically with
  //     no labels or percentages. Reads as a compact "health strip".
  //   - maximized: each bar gets its own labeled row (title + percent)
  //     and a "Configure" button appears below, linking to the Projects
  //     list (/projects) for storage/AI-quota management.
  // Toggle by clicking the card. Local state — no persistence yet; if the
  // user wants this to survive reloads later, swap to a localStorage-
  // backed initializer like LOCK_STORAGE_KEY above.
  const [usageExpanded, setUsageExpanded] = useState(false);

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
        {/* The whole brand block (icon + DOCVEX + version) is one big NavLink
            to the About DocVex hub (/updates route — kept for backwards
            compat). The page now hosts three tabs: Updates / About / Contact
            us, so a single entry point covers all three. The previous
            version-only NavLink was nested inside this div; pulling the
            whole brand-left into the link gives the click a much larger
            target without changing the visual. */}
        <Tooltip content={hasUpdate ? 'About DocVex — update available' : 'Open About DocVex'}>
          <NavLink
            to="/updates"
            end
            className={({ isActive }) => `brand-left brand-link${isActive ? ' is-active' : ''}`}
            onClick={closePicker}
          >
            <span className="icon brand-icon">
              <img src={brandIcon} alt="Docvex" className="brand-icon-img" />
            </span>
            <span className="label brand-text">
              <span className="brand-name">DOCVEX</span>
              {currentVersion && (
                // Once an update is pending the version number stops being
                // the actionable info — the pill takes its slot rather than
                // sitting next to it, so the brand block stays uncluttered
                // and the eye lands on the call-to-action.
                hasUpdate ? (
                  <span className="brand-version brand-version-badge">Update available</span>
                ) : (
                  <span className="brand-version brand-version-num">v{currentVersion}</span>
                )
              )}
            </span>
          </NavLink>
        </Tooltip>
        <Tooltip content={locked ? 'Unlock sidebar' : 'Lock sidebar open'}>
          <button
            type="button"
            className={`label lock-btn${locked ? ' is-locked' : ''}`}
            onClick={() => setLocked((v) => !v)}
            aria-label={locked ? 'Unlock sidebar' : 'Lock sidebar open'}
            aria-pressed={locked}
          >
            {locked ? LockClosedIcon : LockOpenIcon}
          </button>
        </Tooltip>
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
              <Tooltip
                content={
                  switching
                    ? (switchingToName ? `Switching to ${switchingToName}…` : 'Switching project…')
                    : (selectedProject ? 'Switch project' : 'Select a project')
                }
              >
              <button
                type="button"
                className={`project-picker-trigger${selectedProject ? ' has-selection' : ''}${switching ? ' is-switching' : ''}`}
                onClick={togglePicker}
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
              </Tooltip>
            </li>
            {/* Project memory + AI usage card — only renders when a project
                is selected. Two states:
                  - minimized: both bars stacked tightly together with no
                    labels (compact "health strip").
                  - maximized: each bar gets a labeled row + percentage,
                    plus a "Configure" button that navigates to /projects
                    (the project list, where storage/quota management
                    will live).
                The whole card is clickable to toggle the state; the
                Configure button has stopPropagation so its click does NOT
                also collapse the card. Tooltip only surfaces in the
                minimized state — labels are visible in the maximized one.
                Placeholder static percentages; wire to real per-project
                storage + AI quota data when the schema lands. */}
            {selectedProject && (() => {
              const memoryPercent = 35; // TODO: wire to real per-project storage
              const memoryLimit = '5 GB';
              const aiPercent = 62;     // TODO: wire to real per-project AI quota
              const aiLimit = '10k tokens';
              const minimizedHint =
                `Project memory ${memoryPercent}% · AI usage ${aiPercent}% — click to expand`;
              // Tooltip content must stay non-empty for BOTH states. When
              // it goes empty, Tooltip short-circuits to `return children`
              // and the trigger-wrap `<span>` disappears from the DOM —
              // which remounts the button as a fresh element on every
              // toggle. New elements skip CSS transitions on their first
              // computed style, killing the morph animation.
              const expandedHint = 'Click to collapse usage';
              return (
                <li className={`project-usage-li${usageExpanded ? ' is-expanded' : ''}`}>
                  <Tooltip content={usageExpanded ? expandedHint : minimizedHint}>
                    <button
                      type="button"
                      className={`project-usage${usageExpanded ? ' is-expanded' : ''}`}
                      onClick={() => setUsageExpanded((v) => !v)}
                      aria-expanded={usageExpanded}
                      aria-label={
                        usageExpanded
                          ? 'Collapse usage details'
                          : `Project memory ${memoryPercent}% of ${memoryLimit}, AI usage ${aiPercent}% of ${aiLimit}. Click to expand.`
                      }
                    >
                      {/* Memory row — label row ALWAYS renders so the
                          minimized → expanded morph can animate the label
                          in/out via CSS (max-height + opacity transitions
                          on .project-usage-label-row). Conditionally
                          rendering the label would make it pop in
                          instantly and break the smooth morph. */}
                      <span className="project-usage-section">
                        {/* No `.label` class — the global `.sidebar .label`
                            rules pin a 120ms opacity transition with a
                            100ms transition-delay on hover/lock/picker-open
                            that overrode our own max-height + opacity
                            transition, making the morph look like nothing
                            happened for the first 100ms after a click.
                            Sidebar-collapsed visibility is handled by a
                            dedicated `.project-usage-label-row` rule in
                            Sidebar.css instead. */}
                        <span className="project-usage-label-row">
                          <span className="project-usage-label">Project Memory</span>
                          <span className="project-usage-value">{memoryPercent}%</span>
                        </span>
                        <span
                          className="project-usage-bar"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={memoryPercent}
                        >
                          <span
                            className="project-usage-bar-fill"
                            style={{ width: `${memoryPercent}%` }}
                          />
                        </span>
                      </span>
                      {/* AI usage row — same shape as memory; fill tinted
                          differently (pink vs baby blue) so the two are
                          distinguishable even when stacked in the
                          minimized state with no labels visible. */}
                      <span className="project-usage-section">
                        <span className="project-usage-label-row">
                          <span className="project-usage-label">AI Usage</span>
                          <span className="project-usage-value">{aiPercent}%</span>
                        </span>
                        <span
                          className="project-usage-bar"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={aiPercent}
                        >
                          <span
                            className="project-usage-bar-fill project-usage-bar-fill-ai"
                            style={{ width: `${aiPercent}%` }}
                          />
                        </span>
                      </span>
                    </button>
                  </Tooltip>
                </li>
              );
            })()}
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
                <li>
                  <NavLink
                    to="/chat"
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                    onClick={closePicker}
                  >
                    <span className="icon">{ChatIcon}</span>
                    <span className="label">Chat</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/generate"
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                    onClick={closePicker}
                  >
                    <span className="icon">{GenerateIcon}</span>
                    <span className="label">Generate</span>
                  </NavLink>
                </li>
                <li>
                  <NavLink
                    to="/automate"
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                    onClick={closePicker}
                  >
                    <span className="icon">{AutomateIcon}</span>
                    <span className="label">Automate</span>
                  </NavLink>
                </li>
              </>
            ) : (
              // Single <li> wrapping all the locked buttons so the hover
              // zone is one continuous rectangle — the cursor moving
              // between rows never leaves this element, no mouseleave
              // fires on the Tooltip wrapper, and the pill stays pinned
              // and tracking. Separate <li>s would flicker the pill
              // off-and-on in the 4px gap between rows.
              // Internal spacing replicated via `gap: 4px` in CSS so the
              // visual layout is byte-identical to the old version.
              // Tooltip wraps the buttons INSIDE the <li> rather than the
              // <li> itself. Wrapping the <li> from outside produced a
              // `<span><li>…</li></span>` DOM tree which broke the
              // `.sidebar-nav > li` rule's child-combinator match — the
              // <li> stopped inheriting `direction: ltr` from that rule
              // and instead picked up `direction: rtl` from .sidebar-nav
              // (used to put the scrollbar on the left), flipping every
              // button's inner flex row and shoving the icons to the
              // right of the labels. With the Tooltip's display:contents
              // span sitting inside the <li>, the <li> is again a direct
              // child of <ul.sidebar-nav> and the rule matches normally.
              // Hint pill replaces the cursor-following Tooltip wrapper —
              // sits inline between the disabled buttons (after Clients,
              // before To-dos so it lands roughly in the middle of the
              // seven-row list) and is always visible. The section only
              // renders when the buttons are gated by "no project
              // selected", so the explanatory copy is always relevant —
              // no need for a hover-driven affordance here.
              <li className="locked-projects-section">
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
                {/* Pill lives in its own component so it can own a
                    ResizeObserver that toggles `.is-multiline` when the
                    copy wraps — CSS then drops the fully-rounded
                    `border-radius: 999px` (stadium) to a softer corner
                    that reads correctly on multi-line content. */}
                <LockedProjectsHint />
                <button
                  type="button"
                  className="nav-item is-disabled"
                  onClick={togglePicker}
                >
                  <span className="icon">{TodosIcon}</span>
                  <span className="label">To-dos</span>
                </button>
                <button
                  type="button"
                  className="nav-item is-disabled"
                  onClick={togglePicker}
                >
                  <span className="icon">{ChatIcon}</span>
                  <span className="label">Chat</span>
                </button>
                <button
                  type="button"
                  className="nav-item is-disabled"
                  onClick={togglePicker}
                >
                  <span className="icon">{GenerateIcon}</span>
                  <span className="label">Generate</span>
                </button>
                <button
                  type="button"
                  className="nav-item is-disabled"
                  onClick={togglePicker}
                >
                  <span className="icon">{AutomateIcon}</span>
                  <span className="label">Automate</span>
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
            <Tooltip content={`${displayName} · ${PLAN.tier}`}>
              <NavLink
                to="/account"
                end
                className={({ isActive }) => `nav-item account-btn${isActive ? ' active' : ''}`}
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
            </Tooltip>
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
          <Tooltip content={reportCapturing ? 'Capturing screenshot…' : 'Report a problem'}>
            <button
              type="button"
              className="nav-item report-problem-btn"
              onClick={openReportProblem}
              disabled={reportCapturing}
            >
              <span className="label">
                {reportCapturing ? 'Capturing…' : 'Report a problem'}
              </span>
            </button>
          </Tooltip>
        )}
      </div>
    </nav>
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
