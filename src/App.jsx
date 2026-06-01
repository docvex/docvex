import React, { lazy, Suspense, useEffect, useRef } from 'react';
import { Routes, Route, Navigate, Outlet, useMatch, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { ProjectProvider, useProject } from './context/ProjectContext';
import { useSelectedProject } from './context/SelectedProjectContext';
import { isLaunchConsumed } from './lib/launchGate';
import { isElectron } from './lib/platform';
import AppShell from './components/AppShell';
import TitleBar from './components/TitleBar';

// All page modules are code-split — each becomes its own JS chunk that loads
// only when the user navigates to that route. Keeps the cold-start bundle
// small. The Suspense fallback below covers the brief network/parse pause
// while a chunk loads. AppShell stays eager because it owns the layout that
// surrounds every route and would itself appear "flashy" if lazy-loaded.
const AuthPage = lazy(() => import('./components/AuthPage'));
// Launch hub — Unity-Hub-style project launcher shown once per cold start
// (see RootShell below). Full-screen, rendered outside AppShell.
const Launch = lazy(() => import('./pages/Launch'));
// Activity = merged home of the old (empty) "/" dashboard + the
// "/notifications" inbox — one feed of everything across the user's projects.
const Activity = lazy(() => import('./pages/Activity'));
const Account = lazy(() => import('./pages/Account'));
const Updates = lazy(() => import('./pages/Updates'));
const Newsletter = lazy(() => import('./pages/Newsletter'));
// Dev-only in-app developer tools (formerly the native DEBUG menu). Only
// routed in dev builds — import.meta.env.DEV is false in packaged/web builds.
const Debug = lazy(() => import('./pages/Debug'));
const ProjectList = lazy(() => import('./pages/Projects/ProjectList'));
const ProjectCreate = lazy(() => import('./pages/Projects/ProjectCreate'));
const ProjectOverview = lazy(() => import('./pages/Projects/ProjectOverview'));
const ProjectDashboard = lazy(() => import('./pages/Projects/ProjectDashboard'));
const ProjectFiles = lazy(() => import('./pages/Projects/ProjectFiles'));
const ProjectClients = lazy(() => import('./pages/Projects/ProjectClients'));
const ProjectTodos = lazy(() => import('./pages/Projects/ProjectTodos'));
const ProjectChat = lazy(() => import('./pages/Projects/ProjectChat'));
const ProjectGenerate = lazy(() => import('./pages/Projects/ProjectGenerate'));
const ProjectAutomate = lazy(() => import('./pages/Projects/ProjectAutomate'));
const ProjectAI = lazy(() => import('./pages/Projects/ProjectAI'));
const InviteAccept = lazy(() => import('./pages/Projects/InviteAccept'));

// Shared full-screen spinner. Re-uses the `.spinner` class from Sidebar.css
// so we don't bloat the bundle with a second loader style. Used by both
// ProtectedRoute (auth gate) and the route-level Suspense boundary.
function RouteFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      <div className="spinner" />
    </div>
  );
}

function ProtectedRoute() {
  const { session, loading } = useAuth();

  if (loading) {
    return <RouteFallback />;
  }

  return session ? <Outlet /> : <Navigate to="/auth" replace />;
}

// Mirrors `useProject().project.id` into SelectedProjectContext when the
// user is on the /dashboard sub-route — the "working in this project"
// surface. Browsing a project's Overview (/projects/:id) is intentionally
// non-mutating: it's read-only management, so it shouldn't hijack the
// sidebar's selection. The picker (ProjectPickerPanel) sets the selection
// explicitly before navigating to /dashboard, so the picker → dashboard
// flow still works without relying on the auto-select here. Deep-links
// and refreshes directly to /dashboard still resolve correctly because
// this effect fires on that route.
//
// Two timing races we defend against:
//   1. "Select no project" → picker calls clearSelection() then navigate('/').
//      The state change and URL change batch together, but the effect can
//      re-run with the new selectedProjectId=null while useMatch / the
//      ProjectShell unmount haven't caught up, which would re-select the
//      project right after the user explicitly cleared it. prevSelectedRef
//      below detects the "had-a-selection → null" transition and bails.
//   2. Switching projects (abc → def) via the picker: ProjectProvider's
//      `project` state doesn't reset on projectId change — it stays at the
//      old abc-row until getProject(def) resolves. Acting on that stale
//      project.id would briefly flip selectedProjectId back to 'abc'. We
//      gate on projectLoading so the auto-select waits for the fetch to
//      settle before reading project.id.
function ProjectAutoSelect() {
  const { project, loading: projectLoading } = useProject();
  const { selectedProjectId, selectProject } = useSelectedProject();
  const onDashboard = useMatch('/projects/:projectId/dashboard');
  const prevSelectedRef = useRef(selectedProjectId);
  useEffect(() => {
    const prev = prevSelectedRef.current;
    prevSelectedRef.current = selectedProjectId;
    if (!onDashboard) return;
    if (projectLoading) return;       // wait for the in-flight fetch (race 2)
    if (prev && !selectedProjectId) return; // user just deselected (race 1)
    if (project?.id && project.id !== selectedProjectId) {
      selectProject(project.id);
    }
  }, [onDashboard, projectLoading, project?.id, selectedProjectId, selectProject]);
  return null;
}

// Gate in front of AppShell. On a cold app start (Electron) the MemoryRouter
// begins at '/', and an authenticated user who hasn't yet passed through the
// launch hub this session is redirected there ONCE — the Unity-Hub-style
// "open a project first" screen. The redirect is scoped to the exact home
// route (pathname === '/'):
//   - so deep-linked / nested entries (e.g. /invite/:token from a deep link,
//     or any later in-app navigation) are never hijacked, and
//   - so redirecting happens BEFORE AppShell mounts — no sidebar flash.
// Once consumed (the hub sets the flag when the user opens / creates / skips a
// project), AppShell renders normally for every route including '/'.
function RootShell() {
  const { session, loading } = useAuth();
  const { pathname } = useLocation();
  if (!loading && isElectron && session && pathname === '/' && !isLaunchConsumed()) {
    return <Navigate to="/launch" replace />;
  }
  return <AppShell />;
}

// Mounts ProjectProvider once for the /projects/:projectId subtree so the
// nested routes (Overview, Dashboard) all share one fetch + Realtime channel.
function ProjectShell() {
  return (
    <ProjectProvider>
      <ProjectAutoSelect />
      <Outlet />
    </ProjectProvider>
  );
}

export default function App() {
  // Electron runs frameless — the custom title bar (with window controls + the
  // Documentation / Theme / Updates / Account actions) renders above the
  // routes. The document's `.with-titlebar` class (set in renderer.jsx) makes
  // the layout reserve --titlebar-h for it. Web keeps the browser chrome.
  return (
    <>
      {isElectron && <TitleBar />}
      <Suspense fallback={<RouteFallback />}>
        <Routes>
        <Route path="/auth" element={<AuthPage />} />
        {/* Launch hub — full-screen, outside AppShell (like /auth). Reached via
            the cold-start redirect in RootShell, or manually. */}
        <Route path="/launch" element={<Launch />} />
        <Route path="/" element={<RootShell />}>
          <Route index element={<Activity />} />
          <Route path="updates" element={<Updates />} />
          <Route path="newsletter" element={<Newsletter />} />
          {/* Debug — dev-only developer tools page (Personal sidebar section).
              Only mounted under import.meta.env.DEV so packaged + web builds
              never expose it. Public personal route, like Newsletter. */}
          {import.meta.env.DEV && <Route path="debug" element={<Debug />} />}
          {/* Notifications merged into Activity ("/"); keep the path as a
              redirect so old links / OS notification deep-links still land. */}
          <Route path="notifications" element={<Navigate to="/" replace />} />
          {/* Invite-accept is intentionally PUBLIC (not behind ProtectedRoute) —
              an invitee clicking the email link before signing in needs the
              page to render so it can stash the token and walk them through
              /auth. The page itself branches on session presence. */}
          <Route path="invite/:token" element={<InviteAccept />} />
          <Route element={<ProtectedRoute />}>
            <Route path="account" element={<Account />} />
            {/* Projects routes — all require a session. ProjectShell wraps the
                :projectId subtree in ProjectProvider so nested routes consume
                one shared context. */}
            <Route path="projects" element={<ProjectList />} />
            <Route path="projects/new" element={<ProjectCreate />} />
            <Route path="projects/:projectId" element={<ProjectShell />}>
              {/* Two distinct project views with different mental models:
                  - index (Overview): reached by clicking a card in the Projects
                    list. Shows the project's members + management actions.
                  - /dashboard: reached from the Projects sidebar's Dashboard
                    sub-item. The "working in this project" surface — files. */}
              <Route index element={<ProjectOverview />} />
              <Route path="dashboard" element={<ProjectDashboard />} />
            </Route>
            {/* Project-scoped tools — pull data from SelectedProjectContext.
                The ProjectBanner in AppShell tells the user which project is
                active. If no project is selected, these pages prompt the user
                to pick one from /projects. */}
            <Route path="files" element={<ProjectFiles />} />
            <Route path="clients" element={<ProjectClients />} />
            <Route path="todos" element={<ProjectTodos />} />
            <Route path="chat" element={<ProjectChat />} />
            <Route path="generate" element={<ProjectGenerate />} />
            <Route path="automate" element={<ProjectAutomate />} />
            {/* Unified AI surface: a single sidebar entry hosts both
                Generate and Automate as internal tabs. The standalone
                /generate and /automate routes are kept above so any
                existing bookmark / deep-link still resolves. */}
            <Route path="ai" element={<ProjectAI />} />
          </Route>
        </Route>
        </Routes>
      </Suspense>
    </>
  );
}
