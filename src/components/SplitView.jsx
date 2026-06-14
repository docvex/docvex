import React, { useEffect, useRef, useState } from 'react';
import {
  MemoryRouter,
  Outlet,
  useLocation,
  useNavigate,
  UNSAFE_LocationContext as LocationContext,
  UNSAFE_RouteContext as RouteContext,
} from 'react-router-dom';
import { ProjectProvider } from '../context/ProjectContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useSplitView } from '../context/SplitViewContext';
import { PaneChromeProvider, usePaneChromeSlotValue, usePaneChromePortalRef, usePaneChromeFooterRef } from '../context/PaneChromeContext';
import { isProjectScopedRoute } from './AppShell';
import AppRoutes from '../AppRoutes';
import Tooltip from './Tooltip';
import './SplitView.css';

// Tiles the main content area into independently-navigable panes. The PRIMARY
// pane (index 0) renders the live, sidebar-driven view (the root router's
// Outlet, passed in as `primary`). Each SECONDARY pane runs its OWN
// MemoryRouter so it navigates on its own (back/forward + an in-pane "Go to"
// menu), seeded from the primary's current path at creation. All panes share
// the surrounding providers (auth/theme/selected-project/notifications), so
// there's one session and one theme across the whole window.

// ── In-pane navigation chrome ─────────────────────────────────────────
function ChevronDown() {
  return <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>;
}
function RefreshIcon() {
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>;
}

// Which pane (index) a subtree belongs to — set around every pane's content so
// the chrome's refresh button + the refreshable content wrapper know which pane
// to act on without prop-drilling through AppRoutes.
const PaneIndexContext = React.createContext(0);
const usePaneIndex = () => React.useContext(PaneIndexContext);

// Remounts its children whenever this pane's refresh nonce changes (chrome
// refresh button / F5), re-running the page's mount effects — i.e. a refresh.
function PaneRefreshable({ children }) {
  const index = usePaneIndex();
  const { refreshNonces } = useSplitView();
  return <React.Fragment key={refreshNonces[index] || 0}>{children}</React.Fragment>;
}

// Side-rail icons — stroke style matches the DocVex hub's sidebar nav icons
// (currentColor stroke, 18px, so they inherit hover/active colour).
const Svg = (p) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p} />;
const NAV_ICONS = {
  dashboard: <Svg><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></Svg>,
  files: <Svg><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>,
  chat: <Svg><path d="M21 11.5a8.38 8.38 0 0 1-9 8.5 9 9 0 0 1-4-1L3 21l1.5-4a8.5 8.5 0 0 1 4-11.5 8.38 8.38 0 0 1 12.5 6z" /></Svg>,
  ai: <Svg><path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z" /><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" /></Svg>,
  activity: <Svg><path d="M3 12h4l3 8 4-16 3 8h4" /></Svg>,
  projects: <Svg><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 11h18" /></Svg>,
  versions: <Svg><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></Svg>,
  newsletter: <Svg><path d="M4 4h13a1 1 0 0 1 1 1v13a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z" /><line x1="8" y1="8" x2="14" y2="8" /><line x1="8" y1="12" x2="14" y2="12" /><line x1="8" y1="16" x2="11" y2="16" /></Svg>,
  account: <Svg><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>,
};

// Destinations the in-pane navigation offers. Mirrors ONLY the sidebar's
// Projects-section navigation (the selected project's pages) when a project is
// selected; with none selected it falls back to the top-level destinations.
// Shared by the chrome's label resolution and the single-window side nav.
function paneDestinations(selectedProject) {
  return selectedProject?.id
    ? [
        { label: 'Files', to: '/files', icon: NAV_ICONS.files },
        { label: 'Chat', to: '/chat', icon: NAV_ICONS.chat },
        { label: 'AI', to: '/ai-chat', icon: NAV_ICONS.ai },
        { label: 'Updates', to: '/versions', icon: NAV_ICONS.versions },
      ]
    : [
        { label: 'Activity', to: '/', icon: NAV_ICONS.activity },
        { label: 'Projects', to: '/projects', icon: NAV_ICONS.projects },
        { label: 'Versions', to: '/versions', icon: NAV_ICONS.versions },
        { label: 'Newsletter', to: '/newsletter', icon: NAV_ICONS.newsletter },
        { label: 'Account', to: '/account', icon: NAV_ICONS.account },
      ];
}

// Whether a destination is the one currently shown — exact match, or a nested
// route under it (e.g. /files/sub, or any /projects/:id/* for the Dashboard).
function isDestActive(to, currentPath) {
  if (to === currentPath) return true;
  if (to === '/') return false;
  if (to.startsWith('/projects/')) return currentPath.startsWith('/projects/');
  return currentPath.startsWith(`${to}/`);
}

// Vertical destination list for single-window mode — replaces the chrome's
// destination dropdown with a persistent left rail of switchable tabs. Drives
// the root router (single mode lives inside it), so it navigates the window.
function PaneSideNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { selectedProject } = useSelectedProject();
  const dests = paneDestinations(selectedProject);
  const currentPath = pathname || '/';
  return (
    <nav className="sv-single-nav" aria-label="Switch view">
      {dests.map((d) => (
        <button
          key={d.to}
          type="button"
          className={`sv-single-nav-item${isDestActive(d.to, currentPath) ? ' is-active' : ''}`}
          onClick={() => navigate(d.to)}
        >
          <span className="sv-single-nav-icon">{d.icon}</span>
          <span className="sv-single-nav-label">{d.label}</span>
        </button>
      ))}
    </nav>
  );
}

function PaneChrome({ hideDest = false }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { selectedProject } = useSelectedProject();
  const paneIndex = usePaneIndex();
  const { refreshPane } = useSplitView();
  const slot = usePaneChromeSlotValue();
  const setPortalEl = usePaneChromePortalRef();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  const dests = paneDestinations(selectedProject);

  const go = (to) => { setMenuOpen(false); navigate(to); };

  // Friendly label for the destination bar. Prefer an exact match against the
  // destinations list, then resolve a bare /projects/:id (and its subroutes)
  // to the project NAME rather than showing the raw UUID. Falls back to the
  // path for anything unrecognised.
  const currentPath = pathname || '/';
  const projectMatch = currentPath.match(/^\/projects\/([^/]+)(\/.*)?$/);
  let destLabel = dests.find((d) => d.to === currentPath)?.label;
  if (!destLabel && projectMatch) {
    const [, idSeg, sub] = projectMatch;
    if (idSeg === 'new') {
      destLabel = 'New project';
    } else {
      const name = selectedProject?.id === idSeg ? selectedProject.name : 'Project';
      destLabel = !sub || sub === '/'
        ? name
        : `${name} · ${sub.replace(/^\//, '').replace(/\//g, ' · ')}`;
    }
  }
  if (!destLabel) destLabel = currentPath;

  // Short description for the current destination, shown under/after the title.
  const DEST_DESC = {
    '/': 'Activity & notifications',
    '/projects': 'All your projects',
    '/versions': 'Release history',
    '/newsletter': 'Legal newsfeed',
    '/account': 'Profile & settings',
    '/admin': 'Developer console',
    '/files': 'Project files & folders',
    '/chat': 'Team & private chat',
    '/ai-chat': 'DocVex AI assistant',
    '/ai': 'AI dashboard & tools',
    '/todos': 'Project to-dos',
    '/mail': 'AI-drafted replies',
    '/debug': 'Developer tools',
  };
  let destDesc = DEST_DESC[currentPath];
  if (!destDesc && projectMatch) {
    const sub = projectMatch[2];
    destDesc = !sub || sub === '/' ? 'Project overview' : sub === '/dashboard' ? 'Project dashboard' : 'Project';
  }
  // The routed page can publish a LIVE description + a search box into its
  // chrome via usePaneChromeSlot; prefer those over the static fallbacks.
  const description = slot?.description ?? destDesc;

  return (
    <div className="sv-chrome">
      {/* Row 1 — header + destination dropdown. */}
      <div className="sv-chrome-row">
        {/* Refresh this window (top-left); also bound to F5 for the focused pane. */}
        <Tooltip content="Refresh this window (F5)">
          <button
            type="button"
            className="sv-chrome-refresh"
            onClick={() => refreshPane(paneIndex)}
            aria-label="Refresh this window"
          >
            <RefreshIcon />
          </button>
        </Tooltip>
        <div className="sv-chrome-head">
          <span className="sv-chrome-title">{destLabel}</span>
          {description && <span className="sv-chrome-dot" aria-hidden="true">·</span>}
          {description && <span className="sv-chrome-desc">{description}</span>}
        </div>
        {/* Destination dropdown — hidden in single-window mode, where the
            persistent left rail (PaneSideNav) handles switching instead. */}
        {!hideDest && (
          <div className="sv-chrome-menu-wrap" ref={wrapRef}>
            <button type="button" className={`sv-chrome-dest${menuOpen ? ' is-open' : ''}`} onClick={() => setMenuOpen((v) => !v)}>
              <span className="sv-chrome-dest-label">{destLabel}</span>
              <ChevronDown />
            </button>
            {menuOpen && (
              <div className="sv-chrome-menu" role="menu">
                {dests.map((d) => (
                  <button key={d.to} type="button" className="sv-chrome-menu-item" onClick={() => go(d.to)}>
                    {d.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {/* Row 2 — portal target where the routed page renders its toolbar (folder
          nav + breadcrumb + search on Files); stays collapsed when empty. */}
      <div className="sv-chrome-row2" ref={setPortalEl} />
    </div>
  );
}

// Window footer — symmetric to PaneChrome but at the BOTTOM of the pane. The
// routed page portals content into it via usePaneChromeFooterEl (e.g. the chat
// composer), so each window's footer shows what's relevant to that window. The
// element collapses (CSS `:empty`) when the page publishes nothing.
function PaneFooter() {
  const setFooterEl = usePaneChromeFooterRef();
  return <div className="sv-footer" ref={setFooterEl} />;
}

// Sidebar-less shell used INSIDE a secondary pane — the in-pane nav chrome
// plus the routed content (wrapped in the project "sheet" frame on
// project-scoped routes, matching the main shell).
function BareShell() {
  const { pathname } = useLocation();
  const scoped = isProjectScopedRoute(pathname);
  return (
    <div className="sv-pane-inner">
      <PaneChromeProvider>
        <PaneChrome />
        <div className="sv-pane-main">
          <PaneRefreshable>
            {scoped ? <div className="project-page-frame">{<Outlet />}</div> : <Outlet />}
          </PaneRefreshable>
        </div>
        <PaneFooter />
      </PaneChromeProvider>
    </div>
  );
}

// Pane variant of ProjectShell. Same ProjectProvider (URL-scoped fetch +
// realtime) so a pane can sit on a DIFFERENT project than the main window —
// but WITHOUT ProjectAutoSelect, so a pane viewing a project never hijacks
// the global "working in" selection that the sidebar/primary pane track.
function BareProjectShell() {
  return (
    <ProjectProvider>
      <Outlet />
    </ProjectProvider>
  );
}

// React Router forbids rendering a <Router> inside another <Router> (it
// checks the surrounding LocationContext). A split pane is its OWN independent
// router living inside the app's root router, so we reset the location + route
// contexts to their defaults right around the inner MemoryRouter — the guard
// then sees "no parent router" and the pane navigates on its own, with a clean
// match tree (no inherited parent-route matches). This is the standard pattern
// for embedding an isolated router (micro-frontends / split views).
const RESET_ROUTE_CONTEXT = { outlet: null, matches: [], isDataRoute: false };

// Contains a crash to the pane it happens in (rather than blanking the whole
// window, which has no boundary of its own). `resetKey` remounts the subtree
// when the user clicks "Reload pane".
class PaneErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch() { /* swallow — the fallback UI is enough */ }
  render() {
    if (this.state.error) {
      return (
        <div className="sv-pane-error">
          <p>This pane ran into a problem.</p>
          <button type="button" onClick={() => this.setState({ error: null })}>Reload pane</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Bridges a secondary pane's OWN MemoryRouter to the SplitViewContext: it
// registers the pane's navigate() (so the sidebar can drive this window when
// it's focused) and reports the pane's current path (so the sidebar can
// highlight the tab this window is on). Rendered inside the pane's router so
// useNavigate/useLocation resolve to that pane, not the root.
function PaneRouterBridge({ index }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { registerPaneNavigator, reportPanePath } = useSplitView();
  useEffect(() => registerPaneNavigator(index, navigate), [index, navigate, registerPaneNavigator]);
  useEffect(() => { reportPanePath(index, pathname); }, [index, pathname, reportPanePath]);
  return null;
}

function SecondaryPane({ index, seedPath }) {
  const { focusedPane, setFocusedPane } = useSplitView();
  // seedPath is read once at mount (MemoryRouter only consumes initialEntries
  // on first render); later changes to the primary's path don't disturb a
  // pane that's been navigated independently.
  const initialRef = useRef(seedPath || '/');
  return (
    <div
      className={`sv-pane${focusedPane === index ? ' is-focused' : ''}`}
      onMouseDownCapture={() => setFocusedPane(index)}
    >
      <PaneErrorBoundary>
        <LocationContext.Provider value={null}>
          <RouteContext.Provider value={RESET_ROUTE_CONTEXT}>
            <MemoryRouter initialEntries={[initialRef.current]}>
              <PaneRouterBridge index={index} />
              <PaneIndexContext.Provider value={index}>
                <AppRoutes Shell={BareShell} ProjectShell={BareProjectShell} />
              </PaneIndexContext.Provider>
            </MemoryRouter>
          </RouteContext.Provider>
        </LocationContext.Provider>
      </PaneErrorBoundary>
    </div>
  );
}

// Per-layout pane seeding. Every "T" (tri) orientation shows the same three
// surfaces regardless of which way the big pane points: Project chat on the
// spanning (primary) pane, AI chat + Files on the two smaller panes. The
// secondary array is in DOM order (the two non-spanning panes). Non-tri layouts
// fall back to a generic spread.
const TRI_SECONDARY = ['/ai-chat', '/files'];
const LAYOUT_SECONDARY_SEEDS = {
  tri: TRI_SECONDARY,
  'tri-right': TRI_SECONDARY,
  'tri-bottom': TRI_SECONDARY,
  'tri-left': TRI_SECONDARY,
};
const LAYOUT_PRIMARY_SEED = {
  tri: '/chat',
  'tri-right': '/chat',
  'tri-bottom': '/chat',
  'tri-left': '/chat',
};
const GENERIC_SPLIT_SEEDS = ['/files', '/chat', '/ai-chat'];

// Routes that render WITHOUT the in-pane chrome bar when shown fullscreen
// (single-pane mode) — the personal destinations opened from the top app-nav
// bar plus the Hub (/projects) and Account (/account). They each carry their own
// page masthead, so the chrome's title + destination dropdown would just
// duplicate it. The persistent left destination rail is also suppressed on
// these (see `railless` below).
const CHROMELESS_FULLSCREEN_ROUTES = new Set(['/', '/newsletter', '/versions', '/settings', '/debug', '/mail', '/projects', '/account']);

// Resize gutters for the current arrangement. A gutter exists on an axis only
// when that axis has 2 tracks; for the "T" layouts the cross-axis gutter is
// clipped to the half that actually holds the two stacked secondary panes (the
// other half is the single spanning primary, which has no divider there).
function guttersFor(layout, sizes) {
  const { cols, rows } = sizes;
  const out = [];
  const colPct = cols.length === 2 ? (cols[0] / (cols[0] + cols[1])) * 100 : null;
  const rowPct = rows.length === 2 ? (rows[0] / (rows[0] + rows[1])) * 100 : null;
  if (colPct != null) {
    let top = 0; let bottom = 0;
    if (layout === 'tri') top = rowPct;                 // primary spans top row
    if (layout === 'tri-bottom') bottom = 100 - rowPct; // primary spans bottom row
    out.push({ axis: 'col', pct: colPct, top, bottom, left: 0, right: 0 });
  }
  if (rowPct != null) {
    let left = 0; let right = 0;
    if (layout === 'tri-right') right = 100 - colPct;   // primary spans right column
    if (layout === 'tri-left') left = colPct;           // primary spans left column
    out.push({ axis: 'row', pct: rowPct, left, right, top: 0, bottom: 0 });
  }
  return out;
}

export default function SplitContainer({ primary }) {
  const { layout, paneCount, focusedPane, setFocusedPane, refreshFocusedPane, paneSizes, resizePanes, paneSeeds, applyToken, reportPanePath, activeCustomLayout } = useSplitView();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const gridRef = useRef(null);
  const paneSizesRef = useRef(paneSizes);
  paneSizesRef.current = paneSizes;
  const paneSeedsRef = useRef(paneSeeds);
  paneSeedsRef.current = paneSeeds;

  // When a custom layout is active, its saved per-window tabs (immutable) are
  // the source of truth for restoring each window — so a window reopens to the
  // tab the layout was saved with, regardless of how the live `paneSeeds` has
  // drifted. The primary window (pane 0) is restored by navigating the root.
  const activeSeeds = activeCustomLayout?.seeds && typeof activeCustomLayout.seeds === 'object' ? activeCustomLayout.seeds : null;
  const activeSeedsRef = useRef(activeSeeds);
  activeSeedsRef.current = activeSeeds;
  const hasActiveCustomRef = useRef(Boolean(activeCustomLayout));
  hasActiveCustomRef.current = Boolean(activeCustomLayout);
  const primaryTarget = () => activeSeedsRef.current?.[0] ?? paneSeedsRef.current?.[0];

  // Report the PRIMARY window's tab (pane 0 is the root router) so it's captured
  // into a custom layout's per-window snapshot alongside the secondary panes.
  useEffect(() => { reportPanePath(0, pathname); }, [pathname, reportPanePath]);

  // On a fresh mount (cold reopen / returning to the workspace) WITH a custom
  // layout active, restore the primary window to its saved tab — window 0 must
  // remember its tab like the others. Scoped to custom-layout users so it never
  // hijacks the normal landing route. Runs once; later navigation is respected.
  const restoredPrimaryRef = useRef(false);
  useEffect(() => {
    if (restoredPrimaryRef.current) return;
    restoredPrimaryRef.current = true;
    if (!hasActiveCustomRef.current) return;
    const target = primaryTarget();
    if (target && target !== pathname) navigate(target, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When a custom layout is applied, re-point the primary window to the tab it
  // had when saved (secondary panes remount via the applyToken-keyed key below).
  const appliedRef = useRef(applyToken);
  useEffect(() => {
    if (applyToken === appliedRef.current) return; // skip initial mount
    appliedRef.current = applyToken;
    const target = primaryTarget();
    if (target && target !== pathname) navigate(target);
  }, [applyToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag a gutter to re-proportion the two tracks on its axis. Writes the new
  // fractions live to context (which re-renders the grid template); the body
  // class blanks pane pointer-events so pane content can't swallow the drag.
  const onGutterDown = (axis) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const grid = gridRef.current;
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    document.body.classList.add('sv-resizing');
    const onMove = (ev) => {
      const pct = axis === 'col'
        ? ((ev.clientX - rect.left) / rect.width) * 100
        : ((ev.clientY - rect.top) / rect.height) * 100;
      const clamped = Math.min(85, Math.max(15, pct));
      const cur = paneSizesRef.current;
      resizePanes(axis === 'col'
        ? { ...cur, cols: [clamped, 100 - clamped] }
        : { ...cur, rows: [clamped, 100 - clamped] });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('sv-resizing');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // F5 refreshes the FOCUSED window (and never the whole Electron app — we
  // swallow the key so the webContents doesn't hard-reload).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'F5' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        refreshFocusedPane();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refreshFocusedPane]);

  // When the user switches INTO a layout that names a primary surface, point
  // the main (spanning) pane at it. Skipped on first mount so it never hijacks
  // the landing page.
  const prevLayoutRef = useRef(layout);
  useEffect(() => {
    const prev = prevLayoutRef.current;
    prevLayoutRef.current = layout;
    if (layout !== prev && LAYOUT_PRIMARY_SEED[layout]) navigate(LAYOUT_PRIMARY_SEED[layout]);
  }, [layout, navigate]);

  // Single mode renders as ONE pane with the same in-pane navigation chrome the
  // split panes use (back / forward / home + a destination menu), pinned above
  // an independently-scrolling content area. The chrome drives the main app
  // router (this component lives inside the root router), so it navigates the
  // whole window. `.sv-single-scroll` reproduces `.main-content`'s old
  // scroll + padding so pages look unchanged below the bar.
  if (paneCount <= 1) {
    // Some fullscreen destinations carry their own page header, so the in-pane
    // chrome bar (title + destination dropdown) is redundant noise there —
    // suppress it for those routes. The sidebar still drives navigation.
    const chromeless = CHROMELESS_FULLSCREEN_ROUTES.has(pathname);
    // The persistent left destination rail (PaneSideNav) is suppressed on the
    // chromeless fullscreen pages (the personal tabs + the Hub). Each carries
    // its own page header, and the top app-nav bar still drives window
    // navigation, so a second left rail there is just noise.
    const railless = chromeless;
    return (
      <div className={`sv-single${railless ? '' : ' sv-single--nav'}${chromeless ? ' is-chromeless' : ''}`}>
        {/* Persistent left rail of switchable destinations (replaces the old
            chrome destination dropdown in single-window mode). */}
        {!railless && <PaneSideNav />}
        <div className="sv-single-body">
          <PaneIndexContext.Provider value={0}>
            <PaneChromeProvider>
              {!chromeless && <PaneChrome hideDest />}
              <div className="sv-single-scroll"><PaneRefreshable>{primary}</PaneRefreshable></div>
              <PaneFooter />
            </PaneChromeProvider>
          </PaneIndexContext.Provider>
        </div>
      </div>
    );
  }

  const seed = `${pathname}${search || ''}`;
  // Secondary-pane seeds: a layout-specific arrangement when defined (e.g.
  // tri-right), else a generic spread that still guarantees Files is shown
  // (it's first in the pool; routes the primary already shows are dropped so
  // panes don't duplicate).
  const genericPool = GENERIC_SPLIT_SEEDS.filter((r) => r !== pathname);
  const secondarySeeds = LAYOUT_SECONDARY_SEEDS[layout] || genericPool;
  // Seed priority: the active custom layout's SAVED tab for this window (so it
  // restores exactly what was saved) → the live remembered route → the layout's
  // generic seed.
  const seedForSecondary = (i) => activeSeeds?.[i + 1] || paneSeeds?.[i + 1] || secondarySeeds[i % secondarySeeds.length] || seed;
  const gridStyle = {
    gridTemplateColumns: paneSizes.cols.map((c) => `${c}fr`).join(' '),
    gridTemplateRows: paneSizes.rows.map((r) => `${r}fr`).join(' '),
  };
  const gutters = guttersFor(layout, paneSizes);
  return (
    <div className={`sv-grid sv-${layout}`} style={gridStyle} ref={gridRef}>
      <div
        className={`sv-pane sv-pane-primary${focusedPane === 0 ? ' is-focused' : ''}`}
        onMouseDownCapture={() => setFocusedPane(0)}
      >
        <div className="sv-pane-inner">
          {/* The primary pane gets the same browser-like nav chrome as the
              others; it drives the ROOT router (this component lives inside it),
              so it navigates the main window and stays in sync with the
              sidebar. */}
          <PaneIndexContext.Provider value={0}>
            <PaneChromeProvider>
              <PaneChrome />
              <div className="sv-pane-main sv-pane-main-primary"><PaneRefreshable>{primary}</PaneRefreshable></div>
              <PaneFooter />
            </PaneChromeProvider>
          </PaneIndexContext.Provider>
        </div>
      </div>
      {Array.from({ length: paneCount - 1 }, (_, i) => (
        // The applyToken in the key remounts panes when a custom layout is
        // applied, so each window re-seeds to that layout's saved tab.
        <SecondaryPane key={`${i + 1}:${applyToken}`} index={i + 1} seedPath={seedForSecondary(i)} />
      ))}
      {/* Drag gutters sit over the grid gaps (absolute, out of grid flow). */}
      {gutters.map((g) => (
        <div
          key={g.axis}
          className={`sv-gutter sv-gutter-${g.axis}`}
          role="separator"
          aria-orientation={g.axis === 'col' ? 'vertical' : 'horizontal'}
          aria-label={g.axis === 'col' ? 'Resize columns' : 'Resize rows'}
          style={g.axis === 'col'
            ? { left: `${g.pct}%`, top: `${g.top}%`, bottom: `${g.bottom}%` }
            : { top: `${g.pct}%`, left: `${g.left}%`, right: `${g.right}%` }}
          onMouseDown={onGutterDown(g.axis)}
        />
      ))}
    </div>
  );
}
