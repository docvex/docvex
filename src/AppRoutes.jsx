import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './context/AuthContext';

// The app's route tree, extracted so it can be rendered by BOTH the main
// window shell (App.jsx → RootShell, with the sidebar) AND each split-view
// pane (SplitView.jsx → BareShell, sidebar-less, own MemoryRouter). The only
// difference between the two is the `Shell` element for the "/" layout route
// and the `ProjectShell` wrapper for the /projects/:id subtree — passed in as
// props so the single source of route definitions can't drift between
// surfaces.

const AuthPage = lazy(() => import('./components/AuthPage'));
const Activity = lazy(() => import('./pages/Activity'));
const Account = lazy(() => import('./pages/Account'));
const Settings = lazy(() => import('./pages/Settings'));
const Updates = lazy(() => import('./pages/Updates'));
const Newsletter = lazy(() => import('./pages/Newsletter'));
const Admin = lazy(() => import('./pages/Admin'));
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
const ProjectAIChat = lazy(() => import('./pages/Projects/ProjectAIChat'));
const Mail = lazy(() => import('./pages/Mail'));
const InviteAccept = lazy(() => import('./pages/Projects/InviteAccept'));
const DocViewer = lazy(() => import('./pages/DocViewer'));

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
        <Route path="/" element={<Shell />}>
          <Route index element={<Activity />} />
          <Route path="versions" element={<Updates />} />
          {/* Legacy alias — old links / stored notifications used /updates. */}
          <Route path="updates" element={<Navigate to="/versions" replace />} />
          <Route path="newsletter" element={<Newsletter />} />
          {import.meta.env.DEV && <Route path="debug" element={<Debug />} />}
          <Route path="notifications" element={<Navigate to="/" replace />} />
          <Route path="invite/:token" element={<InviteAccept />} />
          <Route element={<ProtectedRoute />}>
            <Route path="account" element={<Account />} />
            <Route path="settings" element={<Settings />} />
            <Route path="admin" element={<Admin />} />
            <Route path="projects" element={<ProjectList />} />
            <Route path="projects/new" element={<ProjectCreate />} />
            <Route path="projects/:projectId" element={<ProjectShell />}>
              <Route index element={<ProjectOverview />} />
              <Route path="dashboard" element={<ProjectDashboard />} />
            </Route>
            <Route path="files" element={<ProjectFiles />} />
            <Route path="clients" element={<ProjectClients />} />
            <Route path="todos" element={<ProjectTodos />} />
            <Route path="chat" element={<ProjectChat />} />
            <Route path="generate" element={<ProjectGenerate />} />
            <Route path="automate" element={<ProjectAutomate />} />
            <Route path="ai" element={<ProjectAI />} />
            <Route path="ai-chat" element={<ProjectAIChat />} />
            <Route path="mail" element={<Mail />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
