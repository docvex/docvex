import React, { useEffect, useRef } from 'react';
import { Navigate, Outlet, useMatch, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { ProjectProvider, useProject } from './context/ProjectContext';
import { useSelectedProject } from './context/SelectedProjectContext';
import { isLaunchConsumed } from './lib/launchGate';
import { isElectron } from './lib/platform';
import AppShell from './components/AppShell';
import TitleBar from './components/TitleBar';
import ReportProblemModal from './components/ReportProblemModal';
import { ReportProblemProvider } from './context/ReportProblemContext';
import AppRoutes from './AppRoutes';

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

// Sets the OS window title so each DocVex window is distinguishable in the
// macOS dock / Window menu (and the taskbar on Windows). Electron mirrors
// document.title onto the BrowserWindow title (page-title-updated), so the
// per-window React tree is the right place to drive it. The window's role is
// fixed for its lifetime by the query it was opened with (renderer.jsx):
//   • Hub window      — no ?openProject          → "DocVex — Hub"
//   • Project window  — ?openProject=<id>        → "DocVex — <project name>"
//   • Doc-viewer      — ?docViewer=1 (+ name)    → "DocVex — <file name>"
function WindowTitle() {
  const { selectedProject } = useSelectedProject();
  useEffect(() => {
    if (!isElectron) return;
    const params = new URLSearchParams(window.location.search);
    let label;
    if (params.get('docViewer') === '1') {
      label = params.get('name') || 'Document Viewer';
    } else if (params.get('openProject')) {
      // selectedProject hydrates from ?openProject async; until its name lands
      // show a neutral label rather than flashing the wrong one.
      label = selectedProject?.name || 'Project';
    } else {
      label = 'Hub';
    }
    document.title = `DocVex — ${label}`;
  }, [selectedProject?.name]);
  return null;
}

export default function App() {
  // Guard against the window navigating to a file when an OS file drag is
  // dropped anywhere OUTSIDE an explicit drop target (the Files canvas calls
  // preventDefault itself). Without this, a stray drop loads file:// in the
  // window and breaks the app. Targets that DO accept drops still work — they
  // preventDefault on their own elements before this bubbles up.
  useEffect(() => {
    const prevent = (e) => {
      // Only files; let in-app element drags (text, etc.) behave normally.
      if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  // Electron runs frameless — the custom title bar (with window controls + the
  // Theme / split-view actions) renders above the routes. The document's
  // `.with-titlebar` class (set in renderer.jsx) makes the layout reserve
  // --titlebar-h for it. Web keeps the browser chrome.
  // ReportProblemProvider wraps both the TitleBar (which hosts the "Report a
  // problem" trigger) and the routed content + the modal, so the trigger and
  // the modal share one context instance.
  return (
    <ReportProblemProvider>
      <WindowTitle />
      {isElectron && <TitleBar />}
      <AppRoutes Shell={RootShell} ProjectShell={ProjectShell} />
      <ReportProblemModal />
    </ReportProblemProvider>
  );
}
