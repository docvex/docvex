import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import UpdateProgressBar from './UpdateProgressBar';
import ProjectPickerPanel from './ProjectPickerPanel';
import SwitchProjectLoader from './SwitchProjectLoader';
import SplitContainer from './SplitView';
import { useSplitView } from '../context/SplitViewContext';
import useCursorSpotlight from '../hooks/useCursorSpotlight';
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

export default function AppShell() {
  const { pathname } = useLocation();
  const { paneCount } = useSplitView();
  const showBanner = isProjectScopedRoute(pathname);
  const isSplit = paneCount > 1;
  useCursorSpotlight();
  // Primary pane content (the live, sidebar-driven view). SplitContainer wraps
  // it: in single mode as one pane with the in-pane nav chrome pinned above a
  // scroll area; in split mode tiled alongside the extra panes.
  const primary = showBanner ? (
    <div className="project-page-frame">
      <Outlet />
    </div>
  ) : (
    <Outlet />
  );
  return (
      <div className="app-shell">
        <Sidebar />
        <main className={`main-content ${isSplit ? 'main-content--split' : 'main-content--single'}`}>
          {/* On project-scoped routes the page content is wrapped in a rounded
              "sheet" panel. In split mode the content area is tiled into
              independent panes by SplitContainer; the primary pane keeps the
              live (sidebar-driven) view, the rest are separately-navigable. */}
          <SplitContainer primary={primary} />
        </main>
        {/* Secondary project-picker panel — slides out from behind the
            sidebar when SelectedProjectContext.pickerOpen flips. Mounted
            unconditionally so the slide-in/out animates on every toggle.
            Sidebar.jsx's "Select a project" trigger, the dimmed Files/To-dos
            rows, and ProjectBanner's "Switch" button all call openPicker(). */}
        <ProjectPickerPanel />
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
