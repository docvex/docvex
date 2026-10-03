import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { PaneChromeProvider, usePaneChromeSlotValue, usePaneChromePortalRef, usePaneChromeFooterRef } from '../context/PaneChromeContext';
import Tooltip from './Tooltip';
import './SplitView.css';

// Single-pane content shell for the main window. Navigation lives in the app's vertical sidebar; this shell keeps
// the in-content chrome the pages rely on: a header bar that pages portal their
// description/toolbar into (PaneChrome + PaneChromeContext), and a footer
// (PaneFooter) for things like the chat composer.

function RefreshIcon() {
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>;
}


// Destinations the in-pane navigation offers. Mirrors ONLY the sidebar's
// Projects-section navigation (the selected project's pages) when a project is
// selected; with none selected it falls back to the top-level destinations.
// Shared by the chrome's label resolution and the single-window side nav.
function paneDestinations(selectedProject) {
  return selectedProject?.id
    ? [
        { label: 'Files', to: '/files' },
        { label: 'Updates', to: '/versions' },
      ]
    : [
        { label: 'Activity', to: '/' },
        { label: 'Projects', to: '/projects' },
        { label: 'Updates', to: '/versions' },
        { label: 'Legislation', to: '/legislation' },
        { label: 'Account', to: '/account' },
      ];
}

function PaneChrome({ onRefresh }) {
  const { pathname } = useLocation();
  const { selectedProject } = useSelectedProject();
  const slot = usePaneChromeSlotValue();
  const setPortalEl = usePaneChromePortalRef();

  const dests = paneDestinations(selectedProject);

  // Friendly label for the header. Prefer an exact match against the
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

  // Short description for the current destination, shown after the title.
  const DEST_DESC = {
    '/': 'Activity & notifications',
    '/projects': 'All your projects',
    '/versions': 'Release history',
    '/legislation': 'legislatie.just.ro',
    '/caen': 'CAEN codes',
    '/newsletter': 'Legal newsfeed',
    '/account': 'Profile & settings',
    '/files': 'Project files & folders',
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
      {/* Row 1 — refresh + header. */}
      <div className="sv-chrome-row">
        {/* Refresh this window (top-left); also bound to F5. */}
        <Tooltip content="Refresh this window (F5)">
          <button
            type="button"
            className="sv-chrome-refresh"
            onClick={onRefresh}
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
      </div>
      {/* Row 2 — portal target where the routed page renders its toolbar (folder
          nav + breadcrumb + search on Files); stays collapsed when empty. */}
      <div className="sv-chrome-row2" ref={setPortalEl} />
    </div>
  );
}

// Window footer — symmetric to PaneChrome but at the BOTTOM of the pane. The
// routed page portals content into it via usePaneChromeFooterEl . The element collapses (CSS `:empty`) when the page publishes
// nothing.
function PaneFooter() {
  const setFooterEl = usePaneChromeFooterRef();
  return <div className="sv-footer" ref={setFooterEl} />;
}

// Routes that render WITHOUT the in-content chrome bar — the personal
// destinations plus the Hub (/projects) and Account (/account). They each carry
// their own page masthead, so the chrome's title would just duplicate it.
const CHROMELESS_FULLSCREEN_ROUTES = new Set(['/', '/research', '/newsletter', '/legislation', '/caen', '/portal-just', '/anaf', '/firme', '/bpi', '/ancpi', '/rejust', '/unbr', '/eurlex', '/playbook', '/versions', '/settings', '/design', '/debug', '/projects', '/account', '/files']);

// The project Overview / settings page (/projects/:id, no further segment) is
// also chromeless — it carries its own Versions-style masthead + compact
// on-scroll header, so the in-pane chrome bar (title + refresh) would just
// duplicate it. /projects, /projects/new, and deeper subroutes
// (/projects/:id/dashboard) are excluded.
function isProjectOverviewRoute(pathname) {
  const m = pathname.match(/^\/projects\/([^/]+)\/?$/);
  return !!m && m[1] !== 'new';
}

export default function ContentShell({ primary, fadeIn = false, onFadeInEnd, hubFadeIn = false, onHubFadeInEnd }) {
  const { pathname } = useLocation();
  // Bumping the nonce remounts the routed content (chrome refresh button + F5),
  // re-running the page's mount effects — i.e. a refresh.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const refresh = () => setRefreshNonce((n) => n + 1);

  // F5 refreshes the window content (and never the whole Electron app — we
  // swallow the key so the webContents doesn't hard-reload).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'F5' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        refresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Some fullscreen destinations carry their own page header, so the chrome bar
  // (title + refresh) is redundant noise there — suppress it. The app sidebar
  // still drives navigation.
  const chromeless = CHROMELESS_FULLSCREEN_ROUTES.has(pathname) || isProjectOverviewRoute(pathname);
  return (
    <div
      className={`sv-single${chromeless ? ' is-chromeless' : ''}${fadeIn ? ' is-switch-fade-in' : ''}${hubFadeIn ? ' is-hub-fade-in' : ''}`}
      onAnimationEnd={(fadeIn || hubFadeIn) ? (e) => {
        // Only react to OUR fade-in keyframes — child animations bubble here too.
        if (e.target !== e.currentTarget) return;
        if (e.animationName === 'svSwitchFadeIn') onFadeInEnd?.();
        if (e.animationName === 'svHubFadeIn') onHubFadeInEnd?.();
      } : undefined}
    >
      <div className="sv-single-body">
        <PaneChromeProvider>
          {!chromeless && <PaneChrome onRefresh={refresh} />}
          <div className="sv-single-scroll">
            <React.Fragment key={refreshNonce}>{primary}</React.Fragment>
          </div>
          <PaneFooter />
        </PaneChromeProvider>
      </div>
    </div>
  );
}
