import React, { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import UpdateProgressBar from './UpdateProgressBar';
import SwitchProjectLoader from './SwitchProjectLoader';
import ContentShell from './SplitView';
import CursorSpotlight from './CursorSpotlight';
import Tooltip from './Tooltip';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import './AppShell.css';

// 2×2 grid glyph — the Hub launcher (the projects list at /projects).
const HubIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

// Routes that operate on the currently-selected project. The banner shows on
// these so the user always sees which project they're working in. /projects
// (the browser list) and /projects/new are intentionally excluded — they're
// project-picker surfaces, not project-scoped views. The Project Overview
// (/projects/:id exact) is also excluded: that page already shows the
// project name as its <h1>, so a redundant "working in <name>" pill above it
// reads as noise. Sub-routes like /projects/:id/dashboard still get the pill
// because their <h1> is generic ("Dashboard") — the pill anchors which
// project the generic page is about.
export function isProjectScopedRoute(pathname) {
  if (pathname === '/files' || pathname.startsWith('/files/')) return true;
  if (pathname === '/clients' || pathname.startsWith('/clients/')) return true;
  if (pathname === '/todos' || pathname.startsWith('/todos/')) return true;
  if (pathname === '/chat' || pathname.startsWith('/chat/')) return true;
  if (pathname === '/generate' || pathname.startsWith('/generate/')) return true;
  if (pathname === '/automate' || pathname.startsWith('/automate/')) return true;
  if (pathname === '/ai' || pathname.startsWith('/ai/')) return true;
  if (pathname === '/projects' || pathname === '/projects/') return false;
  if (pathname === '/projects/new') return false;
  if (pathname.startsWith('/projects/')) {
    // Strip trailing slash, then check whether there's anything past the id.
    const rest = pathname.slice('/projects/'.length).replace(/\/$/, '');
    // Exact /projects/:id (no further segment) → Overview → no pill.
    if (rest && !rest.includes('/')) return false;
    return true;
  }
  return false;
}

// The sidebar's "Personal" section tabs (Activity / Newsletter / Versions).
// These all render their content full-bleed — no chrome frame (border / rounded
// corners / shadow) and no gaps around the content section — so they read as one
// consistent editorial surface. Keep in sync with Sidebar's personalItems.
const FLUSH_CONTENT_ROUTES = new Set(['/', '/newsletter', '/versions', '/mail', '/admin', '/settings', '/debug', '/files', '/chat', '/ai']);

// The project Overview / settings page (/projects/:id, no further segment)
// also renders full-bleed — it carries its own Versions-style masthead, so it
// gets the same borderless, flush content frame. /projects, /projects/new, and
// deeper subroutes are excluded.
function isProjectOverviewRoute(pathname) {
  const m = pathname.match(/^\/projects\/([^/]+)\/?$/);
  return !!m && m[1] !== 'new';
}

// Collapsed-rail width — just wide enough for the centered nav icons. Matches
// the value the collapse CSS is tuned against (icon column + sidebar padding +
// border). Keep in sync with the .app-shell.sidebar-collapsed rule.
const COLLAPSED_SIDEBAR_WIDTH = '60px';
const SIDEBAR_COLLAPSED_KEY = 'docvex.sidebarCollapsed';

export default function AppShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { session } = useAuth();
  // Sidebar minimize state — persisted per device (not per user; it's a layout
  // preference). Drives both the rail's own width and the --sidebar-width var
  // the rest of the chrome offsets against, so the whole layout animates in
  // lock-step (see the @property-registered --sidebar-width transition).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const toggleSidebar = () => {
    setSidebarCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };
  // While switching/loading a project we drop the tab content (and its chrome)
  // and show ONLY the spinner over the ambient dot-grid + cursor spotlight.
  const { switching } = useSelectedProject();
  // When a switch ends (switching: true → false) we re-mount the content and
  // fade it in once the loader has finished dissolving. This flag drives that
  // entrance animation and clears itself when it completes (or on the next
  // switch). It's gated on a real switch so first-load / plain navigation
  // don't animate.
  const [fadeInAfterSwitch, setFadeInAfterSwitch] = useState(false);
  const wasSwitching = useRef(false);
  useEffect(() => {
    if (switching) {
      wasSwitching.current = true;
    } else if (wasSwitching.current) {
      wasSwitching.current = false;
      setFadeInAfterSwitch(true);
    }
  }, [switching]);
  const showBanner = isProjectScopedRoute(pathname);
  const flushContent = FLUSH_CONTENT_ROUTES.has(pathname) || isProjectOverviewRoute(pathname);
  // The Hub (/projects) is a full-screen launcher: pressing the floating Hub
  // button navigates here and the sidebar is hidden so the launcher fills the
  // window. Leaving /projects (e.g. picking a project) brings the rail back.
  const onHub = pathname === '/projects' || pathname === '/projects/';
  // The live, sidebar-driven view. ContentShell wraps it as one pane with the
  // in-pane nav chrome (left rail + header) pinned above a scroll area.
  const primary = showBanner ? (
    <div className="project-page-frame">
      <Outlet />
    </div>
  ) : (
    <Outlet />
  );
  return (
      <div
        className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
        style={sidebarCollapsed ? { '--sidebar-width': COLLAPSED_SIDEBAR_WIDTH } : undefined}
      >
        {/* App chrome — a single bordered, rounded frame that wraps the vertical
            sidebar AND the content area so they read as one window-in-window
            surface, inset from the frameless window edges (the ambient dot grid
            shows around it). */}
        {/* Hub launcher — lives OUTSIDE the sidebar as a floating button.
            Pressing it opens the Hub (/projects); the sidebar hides there. */}
        {session && !onHub && (
          <Tooltip content="Hub — your projects">
            <button
              type="button"
              className={`app-hub-btn${sidebarCollapsed ? ' app-hub-btn--collapsed' : ''}`}
              onClick={() => navigate('/projects')}
              aria-label="Open the Hub"
            >
              <span className="app-hub-icon">{HubIcon}</span>
              <span className="app-hub-label">
                DOCVEX<span className="app-hub-sep" aria-hidden="true">|</span><span className="app-hub-suffix">HUB</span>
              </span>
            </button>
          </Tooltip>
        )}
        <div className="app-chrome">
          {!onHub && <Sidebar collapsed={sidebarCollapsed} onToggleCollapse={toggleSidebar} />}
          <main className={`main-content main-content--single${flushContent ? ' main-content--flush' : ''}`}>
            {/* Cursor-following spotlight that brightens the ambient dot grid.
                A real element moved by a direct transform write (not a CSS-var
                `::after`) to avoid a document-wide style recalc on every move. */}
            <CursorSpotlight />
            {/* On project-scoped routes the page content is wrapped in a rounded
                "sheet" panel. ContentShell renders it as a single pane with the
                in-pane nav chrome (left rail + header). Dropped while switching
                so only the spinner + ambient background show. */}
            {!switching && (
              <ContentShell
                primary={primary}
                fadeIn={fadeInAfterSwitch}
                onFadeInEnd={() => setFadeInAfterSwitch(false)}
              />
            )}
            {/* Project-switch spinner — scoped to the content section (this
                positioned <main>). Transparent panel, so the cursor spotlight +
                dot grid stay visible behind the spinner; the sidebar is untouched. */}
            <SwitchProjectLoader />
          </main>
        </div>
        {/* Project picking now lives in the Hub tab (/projects) — the old
            slide-out picker panel was removed. */}
        {/* Fixed-bottom indeterminate progress strip; renders only while an
            update is checking/downloading. Lives at the shell level so the
            user keeps the feedback even after navigating away from /updates. */}
        <UpdateProgressBar />
      </div>
  );
}
