import React, { useEffect, useRef } from 'react';
import { Outlet, useMatch } from 'react-router-dom';
import { ProjectProvider, useProject } from './context/ProjectContext';
import { useSelectedProject } from './context/SelectedProjectContext';
import { useAuth } from './context/AuthContext';
import { isElectron } from './lib/platform';
import { prefetchProjectFiles } from './lib/projectFilesPrefetch';
import AppShell from './components/AppShell';
import TitleBar from './components/TitleBar';
import ReportProblemModal from './components/ReportProblemModal';
import { ReportProblemProvider } from './context/ReportProblemContext';
import AppRoutes from './AppRoutes';

// Mirrors `useProject().project.id` into SelectedProjectContext when the
// user is on the /dashboard sub-route — the "working in this project"
// surface. Browsing a project's Overview (/projects/:id) is intentionally
// non-mutating: it's read-only management, so it shouldn't hijack the
// sidebar's selection. The Hub (/projects) sets the selection explicitly
// before navigating to /dashboard, so the Hub → dashboard flow still works
// without relying on the auto-select here. Deep-links
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

// Sets the OS window title so each DocVex window is distinguishable in the
// macOS dock / Window menu (and the taskbar on Windows). Electron mirrors
// document.title onto the BrowserWindow title (page-title-updated), so the
// per-window React tree is the right place to drive it. Two window roles
// remain (the launch hub + per-project windows were removed):
//   • Main window — titled after the working project, else plain "DocVex"
//   • Doc-viewer  — ?docViewer=1 (+ name) → "DocVex — <file name>"
function WindowTitle() {
  const { selectedProject } = useSelectedProject();
  useEffect(() => {
    if (!isElectron) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('docViewer') === '1') {
      document.title = `DocVex — ${params.get('name') || 'Document Viewer'}`;
    } else {
      document.title = selectedProject?.name ? `DocVex — ${selectedProject.name}` : 'DocVex';
    }
  }, [selectedProject?.name]);
  return null;
}

// Background warm-up for the Files page. The app boots on the Hub (/projects);
// while the user is there, this prefetches the on-disk folder + listings +
// sidecar for the selected (most-recently-worked-on) project into a module
// cache, so the first "Project" tab open (→ /files) paints the grid on the
// first frame instead of resolving the folder + listing live. Electron-only;
// prefetchProjectFiles no-ops on web (no ambient per-project folder). Headless.
function ProjectPrefetch() {
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const { session } = useAuth();
  const userId = session?.user?.id || null;
  useEffect(() => {
    if (!isElectron || !selectedProjectId) return;
    prefetchProjectFiles({
      projectId: selectedProjectId,
      projectName: selectedProject?.name || null,
      userId,
    });
  }, [selectedProjectId, selectedProject?.name, userId]);
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
      <ProjectPrefetch />
      {isElectron && <TitleBar />}
      <AppRoutes Shell={AppShell} ProjectShell={ProjectShell} />
      <ReportProblemModal />
    </ReportProblemProvider>
  );
}
