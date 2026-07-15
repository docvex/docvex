import React, { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, Navigate, useNavigate } from 'react-router-dom';
import { RouteFallback } from '../AppRoutes';
import Sidebar from './Sidebar';
import UpdateProgressBar from './UpdateProgressBar';
import SwitchProjectLoader from './SwitchProjectLoader';
import ContentShell from './SplitView';
import CursorSpotlight from './CursorSpotlight';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import './AppShell.css';

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
  if (pathname === '/events' || pathname.startsWith('/events/')) return true;
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
const FLUSH_CONTENT_ROUTES = new Set(['/', '/newsletter', '/versions', '/mail', '/admin', '/settings', '/debug', '/files', '/chat', '/events', '/ai']);

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
  const { session, loading: authLoading } = useAuth();
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
  // The Hub (/projects) is a full-screen launcher: the sidebar's "All
  // projects" item navigates here and the sidebar slides OUT of the window so
  // the launcher fills it. Leaving /projects (picking a project) slides it
  // back in. The sidebar stays mounted throughout — the `on-hub` shell class
  // drives the slide via a margin-left transition (see AppShell.css), so both
  // directions animate.
  const onHub = pathname === '/projects' || pathname === '/projects/';
  const navigate = useNavigate();
  // "All projects" click intercept: instead of navigating instantly (which
  // would swap the content mid-frame), fade the current page out and start
  // the rail slide (`hub-leaving`), THEN navigate once the fade has read.
  // The Hub content then fades in via the onHub-flip effect below.
  const [hubLeaving, setHubLeaving] = useState(false);
  // Entrance fade for content crossing the hub boundary. Distinct from
  // fadeInAfterSwitch: the switch fade carries a 220ms delay (it waits for
  // the loader to dissolve), which here would read as a blank flicker.
  const [hubFadeIn, setHubFadeIn] = useState(false);
  const hubNavTimer = useRef(null);
  const goToHub = () => {
    if (onHub || hubLeaving) return;
    setHubLeaving(true);
    hubNavTimer.current = setTimeout(() => {
      // One commit for all three: the hub must MOUNT with its entrance class
      // already applied — setting the flag from an effect after navigation
      // paints one full-opacity frame first (a visible flicker).
      setHubFadeIn(true);
      navigate('/projects');
      setHubLeaving(false);
    }, 200);
  };
  useEffect(() => () => clearTimeout(hubNavTimer.current), []);
  // Fallback for hub crossings that don't go through goToHub (e.g. leaving
  // the hub without a project switch). Skipped while switching — the content
  // shell is unmounted then and re-enters via fadeInAfterSwitch; stacking
  // both animations would double-flash.
  const prevOnHub = useRef(onHub);
  useEffect(() => {
    if (prevOnHub.current !== onHub) {
      prevOnHub.current = onHub;
      if (!switching) setHubFadeIn(true);
    }
  }, [onHub, switching]);
  // The live, sidebar-driven view. ContentShell wraps it as one pane with the
  // in-pane nav chrome (left rail + header) pinned above a scroll area.
  const primary = showBanner ? (
    <div className="project-page-frame">
      <Outlet />
    </div>
  ) : (
    <Outlet />
  );

  // Force signed-out users to the auth screen — the app shell (sidebar + the
  // public Activity/Newsletter/Versions pages) is only for authenticated
  // sessions. AuthPage pins the window to its default size + disables resizing
  // ('locked'), so this is also what gives the sign-in screen its fixed scale.
  // The invite-accept route stays reachable while signed out: it stashes its
  // token and routes through /auth itself (see InviteAccept.jsx). While auth is
  // still hydrating we hold on a spinner instead of flashing the shell.
  const isInviteRoute = pathname.startsWith('/invite/');
  if (authLoading) return <RouteFallback />;
  if (!session && !isInviteRoute) return <Navigate to="/auth" replace />;

  return (
      <div
        className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}${onHub ? ' on-hub' : ''}${hubLeaving ? ' hub-leaving' : ''}`}
        style={sidebarCollapsed ? { '--sidebar-width': COLLAPSED_SIDEBAR_WIDTH } : undefined}
      >
        {/* App chrome — a single bordered, rounded frame that wraps the vertical
            sidebar AND the content area so they read as one window-in-window
            surface, inset from the frameless window edges (the ambient dot grid
            shows around it). */}
        {/* The Hub launcher moved INTO the sidebar — it's the "All projects"
            nav item at the top of the rail (see Sidebar.jsx). On /projects the
            rail stays MOUNTED but slides off-window (offstage) so the move
            animates both ways instead of popping in/out of the DOM. */}
        <div className="app-chrome">
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggleCollapse={toggleSidebar}
            offstage={onHub || hubLeaving}
            onHubNav={goToHub}
          />
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
                hubFadeIn={hubFadeIn}
                onHubFadeInEnd={() => setHubFadeIn(false)}
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
