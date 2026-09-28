import React, { useEffect, useRef } from 'react';
import { Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { ProjectProvider, useProject } from './context/ProjectContext';
import { useSelectedProject } from './context/SelectedProjectContext';
import { useAuth } from './context/AuthContext';
import { isElectron, isAuxWindow, isTabWindow, reportTabWindowRoute } from './lib/platform';
import { projectIndexApi } from './lib/localFolder';
import { getProject } from './lib/projects';
import { useNotify } from './context/NotificationsContext';
import { prefetchProjectFiles, clearPrefetchedProjectFiles } from './lib/projectFilesPrefetch';
import AppShell from './components/AppShell';
import TitleBar from './components/TitleBar';
import ReportProblemModal from './components/ReportProblemModal';
import { ReportProblemProvider, useReportProblem } from './context/ReportProblemContext';
import AppRoutes from './AppRoutes';
import { maybeRunLegalFeedSync, resetLegalFeedSync } from './lib/legalFeedSync';

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
// while the user is there, this opens the selected (most-recently-worked-on)
// project from its project file and reads its listing out of the project
// index into a module cache, so the first "Project" tab open (→ /files)
// paints the grid on the first frame. Electron-only. Headless.
function ProjectPrefetch() {
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const { session } = useAuth();
  const userId = session?.user?.id || null;
  useEffect(() => {
    // Main window only — a Doc Viewer / snip window will never open the Files
    // page, so warming it per window (times every open viewer) is pure waste.
    if (!isElectron || isAuxWindow || !selectedProjectId) return;
    prefetchProjectFiles({
      projectId: selectedProjectId,
      projectName: selectedProject?.name || null,
      userId,
    });
  }, [selectedProjectId, selectedProject?.name, userId]);
  return null;
}

// A `<Project name>.docvex` project file opened from the OS (double-clicked
// in Explorer / Finder, or handed to the app on its command line): main
// registers where that folder is and sends `project:opened`; the main window
// selects the project and shows its Files. Only a project the signed-in
// account can see is opened — anything else is said plainly rather than
// silently ignored. One that arrives before sign-in waits for it.
function ProjectFileOpened() {
  const navigate = useNavigate();
  const { selectProject, beginSwitch } = useSelectedProject();
  const { notify } = useNotify();
  const { session } = useAuth();
  const userId = session?.user?.id || null;
  const pendingRef = useRef(null);
  const openRef = useRef(null);
  openRef.current = async (p) => {
    if (!p?.projectId) return;
    if (!userId) { pendingRef.current = p; return; }
    pendingRef.current = null;
    const { data, error } = await getProject(p.projectId);
    if (error || !data) {
      notify({
        category: 'project',
        variant: 'error',
        icon: 'folder',
        title: 'Can’t open that project',
        body: `${p.name ? `“${p.name}”` : 'That project'} isn’t in your account, or you don’t have access to it. Ask its owner to invite you.`,
        dedupeKey: `project-file-open:${p.projectId}`,
      });
      return;
    }
    // The folder may be a different one from where this machine last had the
    // project: the warm listing is dropped, and a Files page already showing
    // this project opens it again.
    clearPrefetchedProjectFiles(data.id);
    window.dispatchEvent(new CustomEvent('docvex:project-folder-changed', { detail: { projectId: data.id } }));
    beginSwitch(data.name);
    selectProject(data.id, data);
    navigate('/files');
  };
  useEffect(() => {
    if (!isElectron || isAuxWindow || isTabWindow) return undefined;
    return projectIndexApi.onOpened((p) => { openRef.current?.(p); });
  }, []);
  useEffect(() => {
    if (userId && pendingRef.current) openRef.current?.(pendingRef.current);
  }, [userId]);
  return null;
}

// Tray-menu → main-window bridge (Electron, main window only). The system-tray
// menu (src/pages/TrayMenu.jsx) has no router of its own: it sends an action to
// main, main raises this window and forwards the destination here.
//   '/settings', '/projects/:id', … — plain routes
//   '@report'                       — open the Report-a-problem modal
// Also owns the Ctrl+, accelerator the menu advertises for Settings (the app
// runs with no native menu on Windows, so the shortcut lives here).
function TrayNavigation() {
  const navigate = useNavigate();
  const { captureAndOpen } = useReportProblem();
  const { signOut } = useAuth();
  useEffect(() => {
    if (!isElectron || isAuxWindow) return undefined;
    const go = (dest) => {
      if (typeof dest !== 'string' || !dest) return;
      if (dest === '@report') { captureAndOpen(); return; }
      // Log out asked for from a Doc Viewer window (its account menu).
      if (dest === '@logout') {
        signOut().catch(() => {}).finally(() => navigate('/auth', { replace: true }));
        return;
      }
      navigate(dest);
    };
    const off = window.electronAPI?.onAppNavigate?.(go);
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === ',') {
        e.preventDefault();
        navigate('/settings');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      off?.();
      window.removeEventListener('keydown', onKey);
    };
  }, [navigate, captureAndOpen, signOut]);
  return null;
}

// The Legal Newsfeed's reader (lib/legalFeedSync). legislatie.just.ro refuses
// Supabase's servers, so the newest Monitorul Oficial issues are read from here,
// over the user's own connection, and handed to the legal-feed-sync function to
// judge. Only app admins' apps do it (the function accepts nobody else), only
// the main window, at most every three hours; the first check waits a minute
// and a half so it never competes with the app's own start.
function LegalFeedSyncRunner() {
  const { session } = useAuth();
  const userId = session?.user?.id;
  useEffect(() => {
    resetLegalFeedSync();
    if (!isElectron || isAuxWindow || !userId) return undefined;
    const tick = () => { maybeRunLegalFeedSync().catch(() => {}); };
    const first = setTimeout(tick, 90 * 1000);
    const every = setInterval(tick, 30 * 60 * 1000);
    return () => { clearTimeout(first); clearInterval(every); };
  }, [userId]);
  return null;
}

// A TAB WINDOW reports its route (and title) to main whenever it moves, so
// the main window's sidebar names it and docking it returns right there.
function TabWindowRoute() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    const clean = search.replace(/[?&]_=\d+/, '').replace(/^&/, '?');
    const t = setTimeout(() => reportTabWindowRoute(`${pathname}${clean}`, document.title), 120);
    return () => clearTimeout(t);
  }, [pathname, search]);
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
      {/* The tray "Extract text" windows are chromeless — the overlay's
          (?snip=1) frozen screenshot must fill the display edge-to-edge, the
          launcher panel (?snipPanel=1) draws its own mini title bar, and the
          delayed-capture countdown badge (?snipCountdown=1) is a transparent
          click-through circle. */}
      {isElectron
        && !['snip', 'snipPanel', 'snipCountdown', 'trayMenu'].some(
          (k) => new URLSearchParams(window.location.search).get(k) === '1',
        )
        && <TitleBar />}
      {/* A tab in a separate window runs neither (they belong to the main
          window); it reports where it is instead, so its × in the main
          window's sidebar can bring that back. */}
      {isTabWindow ? <TabWindowRoute /> : (
        <>
          <TrayNavigation />
          <ProjectFileOpened />
          <LegalFeedSyncRunner />
        </>
      )}
      <AppRoutes Shell={AppShell} ProjectShell={ProjectShell} />
      <ReportProblemModal />
    </ReportProblemProvider>
  );
}
