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

function PaneChrome() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { selectedProject } = useSelectedProject();
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

  // The window dropdown mirrors ONLY the sidebar's Projects-section navigation
  // (the currently-selected project's pages). With no project selected there's
  // nothing to scope to, so it falls back to the top-level destinations.
  const dests = selectedProject?.id
    ? [
        { label: 'Dashboard', to: `/projects/${selectedProject.id}/dashboard` },
        { label: 'Files', to: '/files' },
        { label: 'Chat', to: '/chat' },
        { label: 'AI', to: '/ai-chat' },
        { label: 'AI Dashboard', to: '/ai' },
        { label: 'To-dos', to: '/todos' },
      ]
    : [
        { label: 'Activity', to: '/' },
        { label: 'Projects', to: '/projects' },
        { label: 'Versions', to: '/versions' },
        { label: 'Newsletter', to: '/newsletter' },
        { label: 'Account', to: '/account' },
      ];

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
        <div className="sv-chrome-head">
          <span className="sv-chrome-title">{destLabel}</span>
          {description && <span className="sv-chrome-dot" aria-hidden="true">·</span>}
          {description && <span className="sv-chrome-desc">{description}</span>}
        </div>
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
          {scoped ? <div className="project-page-frame">{<Outlet />}</div> : <Outlet />}
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
              <AppRoutes Shell={BareShell} ProjectShell={BareProjectShell} />
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
const GENERIC_SPLIT_SEEDS = ['/files', '/chat', '/ai-chat', '/todos'];

// Routes that render WITHOUT the in-pane chrome bar when shown fullscreen
// (single-pane mode) — every personal destination opened from the top app-nav
// bar. They each carry their own page masthead, so the chrome's title +
// destination dropdown would just duplicate it.
const CHROMELESS_FULLSCREEN_ROUTES = new Set(['/', '/newsletter', '/versions', '/settings', '/debug']);

export default function SplitContainer({ primary }) {
  const { layout, paneCount, focusedPane, setFocusedPane } = useSplitView();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();

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
    return (
      <div className={`sv-single${chromeless ? ' is-chromeless' : ''}`}>
        <PaneChromeProvider>
          {!chromeless && <PaneChrome />}
          <div className="sv-single-scroll">{primary}</div>
          <PaneFooter />
        </PaneChromeProvider>
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
  const seedForSecondary = (i) => secondarySeeds[i % secondarySeeds.length] || seed;
  return (
    <div className={`sv-grid sv-${layout}`}>
      <div
        className={`sv-pane sv-pane-primary${focusedPane === 0 ? ' is-focused' : ''}`}
        onMouseDownCapture={() => setFocusedPane(0)}
      >
        <div className="sv-pane-inner">
          {/* The primary pane gets the same browser-like nav chrome as the
              others; it drives the ROOT router (this component lives inside it),
              so it navigates the main window and stays in sync with the
              sidebar. */}
          <PaneChromeProvider>
            <PaneChrome />
            <div className="sv-pane-main sv-pane-main-primary">{primary}</div>
            <PaneFooter />
          </PaneChromeProvider>
        </div>
      </div>
      {Array.from({ length: paneCount - 1 }, (_, i) => (
        <SecondaryPane key={i + 1} index={i + 1} seedPath={seedForSecondary(i)} />
      ))}
    </div>
  );
}
