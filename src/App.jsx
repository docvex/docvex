import React, { lazy, Suspense, useEffect, useRef } from 'react';
import { Routes, Route, Navigate, Outlet, useMatch } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { ProjectProvider, useProject } from './context/ProjectContext';
import { useSelectedProject } from './context/SelectedProjectContext';
import AppShell from './components/AppShell';

// All page modules are code-split — each becomes its own JS chunk that loads
// only when the user navigates to that route. Keeps the cold-start bundle
// small. The Suspense fallback below covers the brief network/parse pause
// while a chunk loads. AppShell stays eager because it owns the layout that
// surrounds every route and would itself appear "flashy" if lazy-loaded.
const AuthPage = lazy(() => import('./components/AuthPage'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Account = lazy(() => import('./pages/Account'));
const Updates = lazy(() => import('./pages/Updates'));
const Notifications = lazy(() => import('./pages/Notifications'));
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
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/" element={<AppShell />}>
          <Route index element={<Dashboard />} />
          <Route path="updates" element={<Updates />} />
          <Route path="notifications" element={<Notifications />} />
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
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
