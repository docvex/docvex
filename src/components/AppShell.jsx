import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import UpdateProgressBar from './UpdateProgressBar';
import ProjectBanner from './ProjectBanner';
import ProjectPickerPanel from './ProjectPickerPanel';
import './AppShell.css';

// Routes that operate on the currently-selected project. The banner shows on
// these so the user always sees which project they're working in. /projects
// (the browser list) and /projects/new are intentionally excluded — they're
// project-picker surfaces, not project-scoped views.
function isProjectScopedRoute(pathname) {
  if (pathname === '/files' || pathname.startsWith('/files/')) return true;
  if (pathname === '/todos' || pathname.startsWith('/todos/')) return true;
  // /projects/<id>/... but not /projects, /projects/, /projects/new
  if (pathname === '/projects' || pathname === '/projects/') return false;
  if (pathname === '/projects/new') return false;
  if (pathname.startsWith('/projects/')) return true;
  return false;
}

export default function AppShell() {
  const { pathname } = useLocation();
  const showBanner = isProjectScopedRoute(pathname);
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-content">
        {showBanner && <ProjectBanner />}
        <Outlet />
      </main>
      {/* Secondary project-picker panel — slides out from behind the
          sidebar when SelectedProjectContext.pickerOpen flips. Mounted
          unconditionally so the slide-in/out animates on every toggle.
          Sidebar.jsx's "Select a project" trigger, the dimmed Files/To-dos
          rows, and ProjectBanner's "Switch" button all call openPicker(). */}
      <ProjectPickerPanel />
      {/* Fixed-bottom indeterminate progress strip; renders only while an
          update is checking/downloading. Lives at the shell level so the
          user keeps the feedback even after navigating away from /updates. */}
      <UpdateProgressBar />
    </div>
  );
}
