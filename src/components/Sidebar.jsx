import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationsContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useChatUnread } from '../context/ChatUnreadContext';
import { useSplitView } from '../context/SplitViewContext';
import { PLAN } from '../lib/plan';
import StatusBadge from './StatusBadge';
import StatusPicker from './StatusPicker';
import Tooltip from './Tooltip';
import { updateStatus, DEFAULT_STATUS_KEY } from '../lib/userStatus';
// Vite imports the asset, hashes it, and emits an asset reference.
// Chromium (Electron's renderer) renders .ico in <img> tags, so the same
// favicon.ico the forge packager uses on Windows doubles as the in-app
// brand mark — one canonical source for both surfaces.
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

// Newspaper glyph — folded-page outline with masthead + column lines,
// reads as "newsletter / briefing feed".
const NewspaperIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 22h14a2 2 0 0 0 2-2V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v16a2 2 0 0 1-2-2V8"/>
    <path d="M8 7h6M8 11h6M8 15h4"/>
  </svg>
);

// Terminal/console glyph — the Developer console (Admin) row.
const ConsoleIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="18" rx="2"/>
    <path d="m6 8 3 3-3 3M13 14h4"/>
  </svg>
);

// Bug glyph — reads as "debug / developer tools". Dev-only sidebar row.
const BugIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="8" y="6" width="8" height="14" rx="4"/>
    <path d="M12 2v4M9 4l1.5 2M15 4l-1.5 2M3 9h3M18 9h3M2 14h4M18 14h4M4 19l3-2M20 19l-3-2"/>
  </svg>
);

const FilesIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
  </svg>
);


// Speech bubble for the Chat tab.
const ChatIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);

// Sparkles for the AI tab — reads as "AI / create". A single AI entry
// hosts both the Generate and Automate sub-surfaces (ProjectAI.jsx
// renders tabs internally) so the sidebar stays compact.
const AIIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>
    <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/>
    <path d="M5 4l.7 1.9L7.6 6.6 5.7 7.3 5 9.2 4.3 7.3 2.4 6.6l1.9-.7z"/>
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
  const { unreadCount } = useNotifications();
  const { unreadCount: chatUnreadCount } = useChatUnread();
  const chatBadge = chatUnreadCount > 0
    ? (chatUnreadCount > 9 ? '9+' : String(chatUnreadCount))
    : null;
  const {
    selectedProject,
    pickerOpen,
    togglePicker,
    closePicker,
  } = useSelectedProject();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Split view: when a SECONDARY pane is focused, the sidebar drives THAT
  // window (not the root/primary one), and its active-tab highlight follows
  // the focused pane's path instead of the root router's.
  const { navigateFocusedPane, focusedPanePath } = useSplitView();

  // Active state for a sidebar tab. With a secondary pane focused, match
  // against that window's path; otherwise defer to NavLink's own root match.
  const paneTabActive = (to, end, isActive) => {
    if (focusedPanePath == null) return isActive;
    if (end) return focusedPanePath === to;
    return focusedPanePath === to || focusedPanePath.startsWith(`${to}/`);
  };

  // Shared click handler: route the click to the focused window. When a
  // secondary pane handles it, suppress the NavLink's own root navigation.
  const handleTabClick = (e, to, options) => {
    closePicker();
    if (navigateFocusedPane(to, options)) e.preventDefault();
  };
  // Status picker anchor — DOMRect of the clicked StatusBadge. null = closed.
  // The picker re-anchors on every open (via the AccountAvatar's onBadgeClick
  // callback) so a sidebar resize between opens doesn't leave it floating.
  // (Account + status picker moved to the title bar.)
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

  // Project memory / AI usage card — a compact "health strip" of two
  // stacked progress bars. It no longer expands in place: clicking it
  // navigates to the selected project's Overview (Personal → Projects →
  // [project], i.e. /projects/:id) where storage / AI-quota management
  // lives. Hovering surfaces a tooltip whose percentages are colour-
  // coded to match each bar.

  // Project-picker state (open/close, fetching the project list, Esc to
  // close) lives in ProjectPickerPanel.jsx now — the panel owns its own
  // data + key handling so the sidebar doesn't have to know.
  //
  // Personal section is config-driven (link rows only).
  const personalSection = {
    label: 'Personal',
    items: [
      // Activity absorbs the old Notifications inbox — it carries the unread
      // badge now (the separate Notifications row was removed).
      {
        kind: 'link',
        to: '/',
        label: 'Activity',
        icon: ActivityIcon,
        end: true,
        badge: unreadCount > 0 ? (unreadCount > 9 ? '9+' : String(unreadCount)) : null,
      },
      // Newsletter — the Legal Newsfeed briefing (Romanian legislation
      // updates with AI summaries). Public personal page, like Activity.
      {
        kind: 'link',
        to: '/newsletter',
        label: 'Newsletter',
        icon: NewspaperIcon,
        end: true,
      },
      // Admin (the Developer console) moved to the Launch hub's sidebar — it's
      // no longer a row here.
      // Debug — dev-only in-app developer tools (formerly the native DEBUG
      // menu). import.meta.env.DEV is false in packaged + web builds, so this
      // row only appears under `npm start` / web:dev, matching the old menu's
      // !app.isPackaged gate.
      {
        kind: 'link',
        to: '/debug',
        label: 'Debug',
        icon: BugIcon,
        end: true,
        visible: import.meta.env.DEV,
      },
    ].filter((i) => i.visible !== false),
  };


  return (
    <>
    <nav className={`sidebar${locked ? ' locked' : ''}${pickerOpen ? ' picker-open' : ''}`}>
      {/* DOCVEX brand moved to the topbar; lock toggle moved to the footer —
          no header row here anymore. */}
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
                 has a non-standard active rule (see Projects above). With a
                 split pane focused, the highlight follows that window's path. */
              className={({ isActive }) =>
                `nav-item${(forcedActive ?? paneTabActive(to, end, isActive)) ? ' active' : ''}`
              }
              /* Clicking any sidebar nav item closes the picker — if the
                 user is navigating to another page, they don't want the
                 picker panel still floating over the new view. No-op when
                 the picker is already closed. When a secondary split pane is
                 focused, the click drives THAT window instead of the root. */
              onClick={(e) => handleTabClick(e, to)}
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

        {/* Projects-section nav (Files / Chat / AI) was removed from the
            sidebar — project navigation now lives in the window topbar's
            destination dropdown. */}

      </ul>

      <div className="sidebar-footer">
        {/* Account (signed in) moved to the title bar (TitleBar.jsx). The
            signed-out "Sign in" CTA stays here for shell routes. */}
        {!session && (
          <NavLink to="/auth" className="nav-item signin-btn">
            <span className="icon">{SignInIcon}</span>
            <span className="label">Sign in</span>
          </NavLink>
        )}
        {/* Lock toggle — moved here from the top brand row. */}
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
    </nav>
    </>
  );
}
