import React from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { ProjectProvider } from './context/ProjectContext';
import AuthPage from './components/AuthPage';
import AppShell from './components/AppShell';
import Dashboard from './pages/Dashboard';
import Account from './pages/Account';
import Updates from './pages/Updates';
import Notifications from './pages/Notifications';
import ProjectList from './pages/Projects/ProjectList';
import ProjectCreate from './pages/Projects/ProjectCreate';
import ProjectDashboard from './pages/Projects/ProjectDashboard';
import ProjectFiles from './pages/Projects/ProjectFiles';
import ProjectTodos from './pages/Projects/ProjectTodos';

function ProtectedRoute() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div className="spinner" />
      </div>
    );
  }

  return session ? <Outlet /> : <Navigate to="/auth" replace />;
}

// Mounts ProjectProvider once for the /projects/:projectId subtree so the
// nested routes (Dashboard / Members / Settings — the latter two ship in
// step 3+) all share one fetch and one Realtime channel.
function ProjectShell() {
  return (
    <ProjectProvider>
      <Outlet />
    </ProjectProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/" element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="updates" element={<Updates />} />
        <Route path="notifications" element={<Notifications />} />
        <Route element={<ProtectedRoute />}>
          <Route path="account" element={<Account />} />
          {/* Projects routes — all require a session. ProjectShell wraps the
              :projectId subtree in ProjectProvider so nested routes consume
              one shared context. */}
          <Route path="projects" element={<ProjectList />} />
          <Route path="projects/new" element={<ProjectCreate />} />
          <Route path="projects/:projectId" element={<ProjectShell />}>
            <Route index element={<ProjectDashboard />} />
            {/* Members / Settings routes are added in step 3. */}
          </Route>
          {/* Project-scoped tools — pull data from SelectedProjectContext.
              The ProjectBanner in AppShell tells the user which project is
              active. If no project is selected, these pages prompt the user
              to pick one from /projects. */}
          <Route path="files" element={<ProjectFiles />} />
          <Route path="todos" element={<ProjectTodos />} />
        </Route>
      </Route>
    </Routes>
  );
}
