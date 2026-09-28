import React, { lazy, Suspense, useState } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import ProjectVersionGate from './components/ProjectVersionGate';
import { useAuth } from './context/AuthContext';
import { LEGAL_STUB_TABS } from './components/LegalTabs';

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
const Legislation = page(() => import('./pages/Legislation'), { warm: 1 });
const Caen = page(() => import('./pages/Caen'), { warm: 1 });
// Research — the Legislation search and the Advisor as one search engine.
const Research = page(() => import('./pages/Research'), { warm: 1 });
const PortalJust = page(() => import('./pages/PortalJust'), { warm: 1 });
const Anaf = page(() => import('./pages/Anaf'), { warm: 1 });
const LegalSourceStub = page(() => import('./pages/LegalSourceStub'), { warm: 1 });
const Roadmap = page(() => import('./pages/Roadmap'));
const Playbook = page(() => import('./pages/Playbook'));
const Admin = page(() => import('./pages/Admin'));
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
const ProjectDashboard = page(() => import('./pages/Projects/ProjectDashboard'));
const ProjectFiles = page(() => import('./pages/Projects/ProjectFiles'));
// The main window boots on /files: its chunk is fetched at once, alongside
// sign-in, rather than after the auth → project → version-gate waterfall.
export function preloadBootRoute() { ProjectFiles.preload(); }
const ProjectClients = page(() => import('./pages/Projects/ProjectClients'));
const ProjectTodos = page(() => import('./pages/Projects/ProjectTodos'));
const ProjectChat = page(() => import('./pages/Projects/ProjectChat'));
const ProjectEvents = page(() => import('./pages/Projects/ProjectEvents'));
const ProjectGenerate = page(() => import('./pages/Projects/ProjectGenerate'));
const ProjectAutomate = page(() => import('./pages/Projects/ProjectAutomate'));
const ProjectAI = page(() => import('./pages/Projects/ProjectAI'));
const Mail = page(() => import('./pages/Mail'));
const InviteAccept = lazy(() => import('./pages/Projects/InviteAccept'));
const DocViewer = lazy(() => import('./pages/DocViewer'));
const SnipOverlay = lazy(() => import('./pages/SnipOverlay'));
const SnipPanel = lazy(() => import('./pages/SnipPanel'));
const SnipCountdown = lazy(() => import('./pages/SnipCountdown'));
const TrayMenu = lazy(() => import('./pages/TrayMenu'));

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
        {/* Full-screen "extract text from screen" overlay — opened from the
            system tray over a frozen screenshot of the desktop. */}
        <Route path="/snip" element={<SnipOverlay />} />
        {/* Snipping-Tool-style launcher bar (tray → "Extract text") — small
            transparent always-on-top window; "New" starts the /snip capture. */}
        <Route path="/snip-panel" element={<SnipPanel />} />
        {/* Delayed-capture countdown badge — click-through transparent window
            centred on each target display while the snip delay ticks down. */}
        <Route path="/snip-countdown" element={<SnipCountdown />} />
        {/* The app-drawn system-tray menu — a transparent always-on-top
            window main.js anchors to the tray icon (see main.js's tray
            section) and hides on blur. */}
        <Route path="/tray-menu" element={<TrayMenu />} />
        <Route path="/" element={<Shell />}>
          <Route index element={<Activity />} />
          <Route path="versions" element={<Updates />} />
          {/* Legacy alias — old links / stored notifications used /updates. */}
          <Route path="updates" element={<Navigate to="/versions" replace />} />
          {/* The Legislation tab's three pages — one sidebar entry, each on
              its own route, each drawing the shared tab bar
              (components/LegalTabs) under its own masthead: the Newsletter,
              the national legislative portal read through its own web service
              and kept on this machine (pages/Legislation), and the CAEN
              nomenclature bundled with the app (pages/Caen). Public: the law
              is not project data. */}
          <Route path="newsletter" element={<Newsletter />} />
          <Route path="legislation" element={<Legislation />} />
          <Route path="caen" element={<Caen />} />
          {/* Research: one search over the legal platforms AND the Advisor
              (pages/Research). Neither tab is replaced. */}
          <Route path="research" element={<Research />} />
          {/* The courts' portal (case files, live over SOAP from main) and
              ANAF (a company's fiscal record, live over REST from main). */}
          <Route path="portal-just" element={<PortalJust />} />
          <Route path="anaf" element={<Anaf />} />
          {/* The tab's sources not yet connected (aggregators, BPI, …):
              placeholders, one page for all (pages/LegalSourceStub). */}
          {/* One component serves every placeholder, so the ELEMENT is keyed
              by tab: without it, going from one placeholder to another kept
              the mounted page and the Legislation bar's enter motion (which
              plays on mount) never ran. */}
          {LEGAL_STUB_TABS.map((t) => (
            <Route key={t.to} path={t.to.slice(1)} element={<LegalSourceStub key={t.id} />} />
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
            <Route path="admin" element={<Admin />} />
            <Route path="projects" element={<ProjectList />} />
            <Route path="projects/new" element={<ProjectCreate />} />
            {/* Everything that opens ONE project: shut to an app older than the
                version that last synced it (components/ProjectVersionGate). */}
            <Route element={<ProjectVersionGate />}>
              <Route path="projects/:projectId" element={<ProjectShell />}>
                <Route index element={<ProjectOverview />} />
                <Route path="dashboard" element={<ProjectDashboard />} />
              </Route>
              <Route path="files" element={<ProjectFiles />} />
              <Route path="clients" element={<ProjectClients />} />
              <Route path="todos" element={<ProjectTodos />} />
              <Route path="chat" element={<ProjectChat />} />
              <Route path="events" element={<ProjectEvents />} />
              <Route path="generate" element={<ProjectGenerate />} />
              <Route path="automate" element={<ProjectAutomate />} />
              <Route path="ai" element={<ProjectAI />} />
            </Route>
            <Route path="roadmap" element={<Roadmap />} />
            <Route path="mail" element={<Mail />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
