import React, { lazy, Suspense, useState } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import ProjectVersionGate from './components/ProjectVersionGate';
import { useAuth } from './context/AuthContext';
import { LEGAL_TABS } from './components/LegalTabs';

// The app's route tree. The "/" layout `Shell` and the /projects/:id
// `ProjectShell` wrapper are passed in as props by App.jsx (the main window
// shell, with the sidebar) so the route definitions live in one place.

// EVERY PAGE CAN BE WARMED AHEAD. `page(factory)` is React.lazy with a
// memory: once its chunk has loaded (on a visit, or warmed by
// `preloadRoutes`), the page renders straight away — no Suspense, no
// spinner — so moving between tabs never waits on a chunk twice. A mount
// keeps whichever of the two it started with (`useState`), so a page that
// did suspend is not remounted when its chunk arrives.
const warmers = [];
function page(factory, { warm = 2 } = {}) {
  let Loaded = null;
  let pending = null;
  const load = () => {
    if (!pending) {
      pending = factory().then(
        (m) => { Loaded = m.default; return m; },
        (e) => { pending = null; throw e; },
      );
    }
    return pending;
  };
  const Lazy = lazy(load);
  function Page(props) {
    const [C] = useState(() => Loaded || Lazy);
    return <C {...props} />;
  }
  Page.preload = () => load().catch(() => { /* the route retries on render */ });
  if (warm) warmers.push({ warm, run: Page.preload });
  return Page;
}

// Warm every page of the main window, one chunk at a time while the window
// is idle — the Legislation platforms first (warm 1), then the rest. Called
// once by AppShell after sign-in.
let warmed = false;
export function preloadRoutes() {
  if (warmed) return;
  warmed = true;
  const queue = [...warmers].sort((a, b) => a.warm - b.warm);
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 60));
  const next = () => {
    const w = queue.shift();
    if (!w) return;
    w.run().finally(() => idle(next)); // true idle only — never forced mid-work
  };
  idle(next);
}

const AuthPage = lazy(() => import('./components/AuthPage'));
const Activity = page(() => import('./pages/Activity'));
const Account = page(() => import('./pages/Account'));
const Settings = page(() => import('./pages/Settings'));
const DesignSystem = page(() => import('./pages/DesignSystem'));
const Updates = page(() => import('./pages/Updates'));
const Newsletter = page(() => import('./pages/Newsletter'), { warm: 1 });
// Research — the Legislation search and the Advisor as one search engine.
const Research = page(() => import('./pages/Research'), { warm: 1 });
const Playbook = page(() => import('./pages/Playbook'));
const Debug = page(() => import('./pages/Debug'));
// The Hub is the one lazy route we deliberately pre-warm: it's reached by a
// single sidebar click that also plays a rail-slide animation, and a Suspense
// fallback mid-slide blanks the whole shell and restarts the transition. The
// import factory is hoisted so `preloadProjectList()` can start (and the
// bundler can de-dupe) the exact same chunk request React would make.
const importProjectList = () => import('./pages/Projects/ProjectList');
const ProjectList = page(importProjectList);
export function preloadProjectList() {
  return ProjectList.preload();
}
const ProjectCreate = page(() => import('./pages/Projects/ProjectCreate'));
const ProjectOverview = page(() => import('./pages/Projects/ProjectOverview'));
const ProjectFiles = page(() => import('./pages/Projects/ProjectFiles'));
// The main window boots on /files: its chunk is fetched at once, alongside
// sign-in, rather than after the auth → project → version-gate waterfall.
export function preloadBootRoute() { ProjectFiles.preload(); }
const InviteAccept = lazy(() => import('./pages/Projects/InviteAccept'));
const DocViewer = lazy(() => import('./pages/DocViewer'));
const TrayDrop = lazy(() => import('./pages/TrayDrop'));

// Shared full-screen spinner — reuses the `.spinner` class from Sidebar.css.
export function RouteFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <div className="spinner" />
    </div>
  );
}

function ProtectedRoute() {
  const { session, loading } = useAuth();
  if (loading) return <RouteFallback />;
  return session ? <Outlet /> : <Navigate to="/auth" replace />;
}

// Renders the full route tree. `Shell` is the "/" layout element (sidebar
// shell in the main window, sidebar-less shell in a pane); `ProjectShell`
// wraps the /projects/:id subtree (the full version mirrors the project into
// SelectedProjectContext, the pane version does not — see App.jsx / SplitView.jsx).
export default function AppRoutes({ Shell, ProjectShell }) {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        {/* Full-screen document viewer window (file preview + Legal AI panel),
            opened from the Files page. Sits outside the sidebar shell. */}
        <Route path="/doc-viewer" element={<DocViewer />} />
        {/* The system tray's drop window: files dropped here go into the
            selected project's folder. */}
        <Route path="/tray-drop" element={<TrayDrop />} />
        <Route path="/" element={<Shell />}>
          <Route index element={<Activity />} />
          <Route path="versions" element={<Updates />} />
          {/* Legacy alias — old links / stored notifications used /updates. */}
          <Route path="updates" element={<Navigate to="/versions" replace />} />
          <Route path="newsletter" element={<Newsletter />} />
          {/* Legislation is ASK alone (pages/Research): the AI reads the portals
              itself. The platforms' own search pages were removed (2026-10-03);
              their old addresses land on Ask. */}
          <Route path="research" element={<Research />} />
          {LEGAL_TABS.map((t) => (
            <Route key={t.to} path={t.to.slice(1)} element={<Navigate to="/research" replace />} />
          ))}
          {import.meta.env.DEV && <Route path="debug" element={<Debug />} />}
          <Route path="notifications" element={<Navigate to="/" replace />} />
          <Route path="invite/:token" element={<InviteAccept />} />
          <Route element={<ProtectedRoute />}>
            {/* Protected: the Playbook holds the user's own documents and the
                writing profile learned from them, all keyed to their account. */}
            <Route path="playbook" element={<Playbook />} />
            <Route path="account" element={<Account />} />
            <Route path="settings" element={<Settings />} />
            <Route path="design" element={<DesignSystem />} />
            <Route path="projects" element={<ProjectList />} />
            <Route path="projects/new" element={<ProjectCreate />} />
            {/* Everything that opens ONE project: shut to an app older than the
                version that last synced it (components/ProjectVersionGate). */}
            <Route element={<ProjectVersionGate />}>
              <Route path="projects/:projectId" element={<ProjectShell />}>
                <Route index element={<ProjectOverview />} />
              </Route>
              <Route path="files" element={<ProjectFiles />} />
              {/* The Timeline, Advisor, Chat and Neural network tabs were removed. */}
              <Route path="events" element={<Navigate to="/files" replace />} />
              <Route path="ai" element={<Navigate to="/research" replace />} />
            </Route>
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
