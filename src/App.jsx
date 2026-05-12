import React, { useEffect } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { ProjectProvider, useProject } from './context/ProjectContext';
import { useSelectedProject } from './context/SelectedProjectContext';
import AuthPage from './components/AuthPage';
import AppShell from './components/AppShell';
import Dashboard from './pages/Dashboard';
import Account from './pages/Account';
import Updates from './pages/Updates';
import Notifications from './pages/Notifications';
import ProjectList from './pages/Projects/ProjectList';
import ProjectCreate from './pages/Projects/ProjectCreate';
import ProjectOverview from './pages/Projects/ProjectOverview';
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

// Mirrors `useProject().project.id` into SelectedProjectContext so that
// landing on any /projects/:projectId route (Overview, Dashboard, …) makes
// that project the user's working project — keeps the sidebar's Projects
// picker in sync with whatever the user is viewing, including deep-links and
// OAuth-resume navigations. Pulled out of the page components so both share
// one effect at the shell level.
function ProjectAutoSelect() {
  const { project } = useProject();
  const { selectedProjectId, selectProject } = useSelectedProject();
  useEffect(() => {
    if (project?.id && project.id !== selectedProjectId) {
      selectProject(project.id);
    }
  }, [project?.id, selectedProjectId, selectProject]);
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
            {/* Two distinct project views with different mental models:
                - index (Overview): reached by clicking a card in the Projects
                  list. Shows the project's people + management actions.
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
          <Route path="todos" element={<ProjectTodos />} />
        </Route>
      </Route>
    </Routes>
  );
}
