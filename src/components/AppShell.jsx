import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import UpdateProgressBar from './UpdateProgressBar';
import ProjectPickerPanel from './ProjectPickerPanel';
import SwitchProjectLoader from './SwitchProjectLoader';
import ReportProblemModal from './ReportProblemModal';
import UploadModal from './UploadModal';
import { ReportProblemProvider } from '../context/ReportProblemContext';
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
function isProjectScopedRoute(pathname) {
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
  const showBanner = isProjectScopedRoute(pathname);
  useCursorSpotlight();
  return (
    <ReportProblemProvider>
      <div className="app-shell">
        <Sidebar />
        <main className={`main-content${showBanner ? ' main-content--has-banner' : ''}`}>
          {/* On project-scoped routes the page content is wrapped in a
              rounded "sheet" panel — the "working in" banner that used
              to sit above it has been removed. The frame is still
              applied so project pages keep the rounded-top "sheet"
              look against the page background. On non-project routes
              the Outlet renders bare so the existing pages (Dashboard,
              Account, Notifications, etc.) keep their current layout
              untouched. */}
          {showBanner ? (
            <div className="project-page-frame">
              <Outlet />
            </div>
          ) : (
            <Outlet />
          )}
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
        {/* Full-screen support-report modal (z-index 60, above the sidebar)
            — opens when the sidebar's "Report a problem" button fires
            captureAndOpen() on the ReportProblemContext. Returns null when
            closed, so mounting unconditionally is free. */}
        <ReportProblemModal />
        {/* Global upload modal — open/close + drag-active state live
            in UploadsContext. Renders for BOTH states: drag-only
            (only the dashed dropzone is visible, chrome hidden,
            pointer-events off so drops fall through) AND fully open
            (after a drop or FAB click — header, dropzone, list, Send
            button). Keeping a single component for both states means
            the DOM tree stays put across the drop transition, so
            there's no one-frame disappearance the previous two-
            component setup had. */}
        <UploadModal />
      </div>
    </ReportProblemProvider>
  );
}
