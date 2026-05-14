import React, { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import UpdateProgressBar from './UpdateProgressBar';
import ProjectBanner from './ProjectBanner';
import ProjectPickerPanel from './ProjectPickerPanel';
import SwitchProjectLoader from './SwitchProjectLoader';
import ReportProblemModal from './ReportProblemModal';
import UploadOverlay from './UploadOverlay';
import { ReportProblemProvider } from '../context/ReportProblemContext';
import { useNotifications } from '../context/NotificationsContext';
import { clearSignedUrlCache } from '../lib/projectFiles';
import { clearPdfCache } from '../lib/pdfCache';
import { TEST_NOTIFICATIONS, TEST_NOTIFICATION_STAGGER_MS } from '../notifications/testNotifications';
import './AppShell.css';

// Track the cursor's viewport position and publish it as CSS variables on
// :root. The main-content::after pseudo-element reads --cursor-x / --cursor-y
// to center its spotlight mask, brightening the ambient dot grid in a fixed
// radius around the cursor.
//
// Throttled with requestAnimationFrame so we hit at most ~60Hz even on
// trackpads/mice that fire pointermove at 1kHz. The cost is a single
// inline-style write per frame — cheap, but skipping intermediate frames
// avoids stacking layout invalidations.
// Subscribes to the main process's "DEBUG → Clear all cached data" menu
// click. Main sends `debug:clear-cache` over IPC; we wipe the module-level
// caches (signed URLs + parsed pdf.js docs) and toast so the user gets
// feedback that something happened. The menu is dev-only (gated by
// !app.isPackaged in src/main.js), so this listener is also a no-op in
// packaged builds — onDebugClearCache simply never fires.
function useDebugClearCacheMenu(notify) {
  useEffect(() => {
    const off = window.electronAPI?.onDebugClearCache?.(() => {
      clearSignedUrlCache();
      clearPdfCache();
      notify?.({
        category: 'system',
        variant: 'info',
        priority: 'low',
        icon: 'sparkles',
        title: 'Cache cleared',
        body: 'Signed URLs + PDF documents dropped. Reopen any file to refetch.',
        dedupeKey: 'debug-cache-cleared',
      });
    });
    return () => { if (typeof off === 'function') off(); };
  }, [notify]);
}

// Subscribes to the main process's "DEBUG → Send all test notifications"
// menu click and fires one of every entry in TEST_NOTIFICATIONS. Used to
// preview the full set of toasts/history-rows at once so devs can eyeball
// every category × priority × icon combination without manually triggering
// the live actions. Staggered 200ms apart so the toast stack animates
// in cleanly rather than slamming all rows in the same frame (the
// renderer's MAX_ACTIVE_TOASTS cap would queue the rest either way; the
// stagger is for visual polish). The menu is dev-only (gated by
// !app.isPackaged in main.js), so this listener is a no-op in packaged
// builds — the event simply never fires.
function useDebugSendTestNotifications(notify) {
  useEffect(() => {
    const off = window.electronAPI?.onSendTestNotifications?.(() => {
      // Fire one notification per entry, staggered. clearTimeout-able so
      // a re-trigger before the previous batch finishes doesn't leak
      // timers, though in practice the user clicks once and waits.
      const timers = [];
      TEST_NOTIFICATIONS.forEach((payload, idx) => {
        const t = window.setTimeout(() => {
          notify?.(payload);
        }, idx * TEST_NOTIFICATION_STAGGER_MS);
        timers.push(t);
      });
      // Cleanup: if the component unmounts mid-stagger, cancel pending.
      return () => { for (const t of timers) clearTimeout(t); };
    });
    return () => { if (typeof off === 'function') off(); };
  }, [notify]);
}

function useCursorSpotlight() {
  useEffect(() => {
    const root = document.documentElement;
    let pendingFrame = null;
    let lastX = 0;
    let lastY = 0;

    const apply = () => {
      root.style.setProperty('--cursor-x', `${lastX}px`);
      root.style.setProperty('--cursor-y', `${lastY}px`);
      pendingFrame = null;
    };

    const onMove = (e) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (pendingFrame == null) {
        pendingFrame = requestAnimationFrame(apply);
      }
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (pendingFrame != null) cancelAnimationFrame(pendingFrame);
    };
  }, []);
}

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
  const { notify } = useNotifications();
  const showBanner = isProjectScopedRoute(pathname);
  useCursorSpotlight();
  useDebugClearCacheMenu(notify);
  useDebugSendTestNotifications(notify);
  return (
    <ReportProblemProvider>
      <div className="app-shell">
        <Sidebar />
        <main className={`main-content${showBanner ? ' main-content--has-banner' : ''}`}>
          {showBanner && <ProjectBanner />}
          {/* On project-scoped routes the page content is wrapped in a
              rounded "sheet" panel that sits just under the gold "working
              in" banner. The panel uses the existing --bg-card token so
              its top corners curve cleanly off the page-bg behind it. On
              non-project routes the Outlet renders bare so the existing
              pages (Dashboard, Account, Notifications, etc.) keep their
              current layout untouched. */}
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
        {/* Global drag-drop file-upload overlay (z-index 9998, above
            every modal, below NotificationCenter toasts at 9999). The
            component returns null when there's no drag in progress AND
            no uploads in flight, so the mount is free. Reads its state
            from UploadsContext (renderer.jsx mounts the provider). The
            backdrop is pointer-events: none so drops always reach the
            window-level listener inside UploadsProvider regardless of
            where on screen the user releases. */}
        <UploadOverlay />
      </div>
    </ReportProblemProvider>
  );
}
