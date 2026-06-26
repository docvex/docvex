import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import UpdateProgressBar from './UpdateProgressBar';
import SwitchProjectLoader from './SwitchProjectLoader';
import ContentShell from './SplitView';
import CursorSpotlight from './CursorSpotlight';
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
const FLUSH_CONTENT_ROUTES = new Set(['/', '/newsletter', '/versions']);

export default function AppShell() {
  const { pathname } = useLocation();
  const showBanner = isProjectScopedRoute(pathname);
  const flushContent = FLUSH_CONTENT_ROUTES.has(pathname);
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
      <div className="app-shell">
        {/* App chrome — a single bordered, rounded frame that wraps the vertical
            sidebar AND the content area so they read as one window-in-window
            surface, inset from the frameless window edges (the ambient dot grid
            shows around it). */}
        <div className="app-chrome">
          <Sidebar />
          <main className={`main-content main-content--single${flushContent ? ' main-content--flush' : ''}`}>
            {/* Cursor-following spotlight that brightens the ambient dot grid.
                A real element moved by a direct transform write (not a CSS-var
                `::after`) to avoid a document-wide style recalc on every move. */}
            <CursorSpotlight />
            {/* On project-scoped routes the page content is wrapped in a rounded
                "sheet" panel. ContentShell renders it as a single pane with the
                in-pane nav chrome (left rail + header). */}
            <ContentShell primary={primary} />
          </main>
        </div>
        {/* Project picking now lives in the Hub tab (/projects) — the old
            slide-out picker panel was removed. */}
        {/* Full-screen project-switch overlay (z-index 45, below sidebar at 50)
            — appears when SelectedProjectContext.beginSwitch() is called, stays
            up for at least 500ms so the transition reads as deliberate even
            when the new project loads almost instantly. */}
        <SwitchProjectLoader />
        {/* Fixed-bottom indeterminate progress strip; renders only while an
            update is checking/downloading. Lives at the shell level so the
            user keeps the feedback even after navigating away from /updates. */}
        <UpdateProgressBar />
      </div>
  );
}
