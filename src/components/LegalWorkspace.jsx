import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import './LegalWorkspace.css';
import LegalTabs, { RailToggle, LEGAL_TABS } from './LegalTabs';
import { useTabSetting, InfoButton } from './LegalOmnibox';
import { useGo, useBrowserKeys, AddressRow, TabRail, TabStrip, TabMenu, NewTabPage, SerpPage, SerpScopes, HistoryPage, ClearHistoryButton, useSerp } from './LegalBrowser';
import { curPage, applyPage, consumeExpected, arrive, arrivalLabel, reportItems, registerReloader, endSwitch, selectTab, browserState, subscribeBrowser } from '../lib/legalBrowser';
import { listArchive } from '../lib/legislation';
import PageMasthead from './PageMasthead';
import { useChatFind } from '../lib/useChatFind';
import Tooltip from './Tooltip';
import { useItemSpots } from './DocRibbon';
import { toLayoutPx } from '../lib/appZoom';
import { openExternal } from '../lib/platform';
import { useLocation } from 'react-router-dom';
import { publishWorkspace, registerWorkspace } from '../lib/workspaceItems';
import { registerHoverSpot } from '../lib/pointer';
import { useRailSpotlight } from '../lib/pointerSpots';
import { useLegalViewMode } from '../lib/legalViewMode';

// The Legislation tabs' WORKSPACE — how the legislatie.just.ro tab is laid
// out, made the one frame every source tab stands in (the Newsletter keeps
// its own editorial layout):
//
//   masthead
//   the tab bar (LegalTabs) — its second line opening with SEARCH (the way
//     back to the search and its answers, lit while they are on show) and
//     History (the clock alone), then the page's own tools
//   ┌ rail ┐┌ main ─────────────────────────────┐
//   │ item ││ the search, or the item open       │
//   │ item ││                                    │
//   └──────┘└────────────────────────────────────┘
//
// What the tab has OPEN — one item per act, court file, company, CAEN class,
// the active one lit, each closable — is NOT drawn here any more: it is
// published (lib/workspaceItems) to the APP SIDEBAR, which lists every tab's
// items in a dropdown under its Legislation entry, one block per tab. The
// page still hands `items` / `activeId` / `onSelect` / `onClose` exactly as
// before; this component publishes them and answers the sidebar's requests.
// (`WorkspaceRail` below is kept for the Design system gallery.)
//
// The former in-page RAIL, for reference:
// It is sticky under the mini header and runs to the window's foot, frosts
// on the very render the bar pins (LegalTabs' `onPinnedChange`), carries the
// app sidebar's spotlight, and its divider is a drag handle (width kept per
// device, shared by every tab so the Search control above it — whose width
// is the rail's — lines up on all of them).
//
// A page hands it: `masthead`; `bar` (LegalTabs' props — search, status,
// trailing, noSearch; `bar.tools` stands after Search + History); `history`
// (HistoryButton's props, drawn as the clock beside Search); `items`
// ([{ id, kind, title, tip }]: the small-caps line and the main line),
// `activeId` (null = the search is on show), `onSelect(id)`, `onClose(id)`,
// `onSearch()` (Search pressed); `className` (the page's own root class,
// for its own rules); `rootRef` (the page's ref on the root);
// children = the main column.

export const RAIL_W_KEY = 'docvex:legislation:rail-w';
export const RAIL_W_DEFAULT = 236;
export const RAIL_W_MIN = 180;
export const RAIL_W_MAX = 420;

const SearchIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
  </svg>
);
const CloseIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const loadRailW = () => {
  try { const v = Number(localStorage.getItem(RAIL_W_KEY)); return v >= RAIL_W_MIN && v <= RAIL_W_MAX ? v : RAIL_W_DEFAULT; } catch { return RAIL_W_DEFAULT; }
};
const saveRailW = (w) => { try { localStorage.setItem(RAIL_W_KEY, String(w)); } catch { /* storage refused */ } };

/** SEARCH, in the mini header — the far left of its second line, the act
 *  find's size, lit while the search is on show. */
export function WorkspaceSearchTab({ active, onClick, label = 'Search' }) {
  // The sidebar's hover / selected wash brightens where the pointer is: its
  // position over the control, as --item-spot-x/y (lib/pointer).
  useEffect(() => registerHoverSpot('.lg-searchtab'), []);
  return (
    <button
      type="button"
      className={`lg-searchtab${active ? ' is-active' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="lg-searchtab-ico">{SearchIcon}</span>
      <span>{label}</span>
    </button>
  );
}

// The search view's mark: a book with a magnifier, thin-stroked like the
// other empty states' marks.
export const SearchMark = (
  <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5V5a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v8" /><path d="M4 19.5A1.5 1.5 0 0 1 5.5 18H12" /><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H12" />
    <path d="M8 7h6M8 10h4" /><circle cx="17" cy="17" r="3" /><path d="M19.2 19.2L21 21" />
  </svg>
);

const ExternalGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6" /><path d="M20 4l-8.5 8.5" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </svg>
);
const TickGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

/** WHERE WHAT IS ON SHOW CAME FROM — the Legislation tab's pill, for every
 *  source tab (LegalTabs' `status` slot, at the tabs row's right end): "Live
 *  from the portal" (success) or "From your copy on this machine" (warning),
 *  and the way out to the source — a button opening `href`. An item kept on
 *  this machine that the source confirms (`sync: 'same'`) is simply live,
 *  with a tick; one that DIFFERS gets a second, danger pill: "Differs from
 *  the portal · Sync" (`onSync` takes the source's version). `liveLabel` for
 *  a source that is not fetched at all (CAEN: bundled with the app). */
export function SourceStatus({ source, sync = '', href, tip, onSync, liveLabel = null, archiveLabel = 'From your copy on this machine', differsLabel = 'Differs from the portal' }) {
  // "Live from <the source's site>" — the platform on show (LEGAL_TABS).
  const { pathname } = useLocation();
  const site = LEGAL_TABS.find((t) => t.to === pathname)?.label || 'the portal';
  liveLabel = liveLabel || `Live from ${site}`;
  if (!source) return null;
  const src = sync === 'same' ? 'live' : source;
  return (
    <>
      <Tooltip content={tip || 'Open the source in the browser'}>
        <button type="button" className={`lgt-status-pill is-${src}`} onClick={() => href && openExternal(href)}>
          {sync === 'same' ? <span className="lgt-status-ico">{TickGlyph}</span> : null}
          <span>{src === 'live' ? liveLabel : archiveLabel}</span>
          {href ? <span className="lgt-status-ico">{ExternalGlyph}</span> : null}
        </button>
      </Tooltip>
      {sync === 'differs' && onSync ? (
        <Tooltip content="The source has changed since this copy was kept — take the source's">
          <button type="button" className="lgt-status-pill is-differs" onClick={onSync}>
            <span>{differsLabel} - click to sync</span>
          </button>
        </Tooltip>
      ) : null}
    </>
  );
}

/** The masthead's figures for a source with a copy on this machine — "Kept
 *  here" and "On this machine" (the Legislation masthead's, `lg-mast-*`). */
export function KeptFigures({ count, bytes, label = 'Kept here', lead = null }) {
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return (
    <div className="lg-mast-meta">
      {lead}
      <div>
        <div className="lg-mast-num">{count}</div>
        <div>{label}</div>
      </div>
      <span className="lg-mast-sep" />
      <div>
        <div className="lg-mast-num">{size}</div>
        <div>On this machine</div>
      </div>
    </div>
  );
}

// The search view's Clear: an eraser.
export const ClearGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 21h10" /><path d="M5.6 15.4l8.5-8.5a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L12 19H8.8l-3.2-3.2a1 1 0 0 1 0-1.4z" /><path d="M9.5 11.5l5 5" />
  </svg>
);

/** The search view's Clear — the tab bar's tool button with the eraser. */
export function WorkspaceClear({ onClick, disabled, tip = 'Clear the search — the fields and the answer' }) {
  return (
    <Tooltip content={tip}>
      <button type="button" className="lgt-tool-btn" disabled={disabled} onClick={onClick}>
        <span className="lgt-tool-ico">{ClearGlyph}</span><span>Clear</span>
      </button>
    </Tooltip>
  );
}

/** THE SEARCH VIEW, as every source tab draws it. Before anything is asked
 *  (`asked` false) it is the tabs' EMPTY STATE — a bare thin-stroke mark, a
 *  title, a muted line, centred — holding the ways to search STACKED at a
 *  larger size, "or" between them, each labelled over and hinted under
 *  (`modes: [{ id, label, hint?, node }]`), and `foot` (Clear, the bar's
 *  note) under them. Once there is an answer the same controls stand as one
 *  compact row over it. */
// Before anything is asked a platform page shows nothing of its own — the
// tabs' new-tab page is where a search starts. Once there is an answer, its
// foot (Clear, the bar's note) stands over the answer.
export function WorkspaceSearch({ asked, foot = null }) {
  if (!asked) return null;
  return foot ? <div className="lgb-foot">{foot}</div> : null;
}

/** The rail — presentational: the items, the resize handle, the spotlight.
 *  `still` draws it in place (the Design system gallery): not sticky, no
 *  measured height. */
export function WorkspaceRail({
  items, activeId, onSelect, onClose, pinned = false, width = RAIL_W_DEFAULT, onWidth = null,
  label = 'Open in this tab', still = false, head = null, empty = null, card = false,
}) {
  const [drag, setDrag] = useState(false);
  const spotRef = useItemSpots('.lg-rail-item', items.length > 0);

  // The SIDEBAR's spotlight: a soft accent glow and a border shine following
  // the pointer (the `.spot-glow` / `.spot-shine` lib/pointerSpots injects), CHASING it
  // — Sidebar.jsx's loop, run by the app's one pointer (lib/pointerSpots).
  useRailSpotlight(spotRef);

  // The DIVIDER is a drag handle: drag to resize (and the Search button above
  // with it); double-click for the default; ←/→ in 16px steps.
  const startResize = (e) => {
    if (e.button !== 0 || !onWidth) return;
    e.preventDefault();
    const x0 = toLayoutPx(e.clientX);
    const w0 = width;
    let w = w0;
    setDrag(true);
    const move = (ev) => {
      w = Math.round(Math.min(RAIL_W_MAX, Math.max(RAIL_W_MIN, w0 + toLayoutPx(ev.clientX) - x0)));
      onWidth(w, false);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('lg-resizing');
      setDrag(false);
      onWidth(w, true);
    };
    document.body.classList.add('lg-resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <aside ref={spotRef} className={`lg-rail${pinned ? ' is-pinned' : ''}${drag ? ' is-resizing' : ''}${still ? ' is-still' : ''}${card ? ' is-card' : ''}`} aria-label={label}>
      <div
        className={`lg-rail-resizer${drag ? ' is-active' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the list"
        aria-valuemin={RAIL_W_MIN}
        aria-valuemax={RAIL_W_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onMouseDown={startResize}
        onDoubleClick={() => onWidth?.(RAIL_W_DEFAULT, true)}
        onKeyDown={(e) => {
          const d = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
          if (!d || !onWidth) return;
          e.preventDefault();
          onWidth(Math.min(RAIL_W_MAX, Math.max(RAIL_W_MIN, width + d)), true);
        }}
      />
      {head}
      <div className="lg-rail-list">
        {!items.length && empty ? <p className="lg-rail-empty">{empty}</p> : null}
        {items.map((t) => {
          const name = [t.kind, t.title].filter(Boolean).join(' ');
          return (
            <div
              key={t.id}
              className={`lg-rail-item${t.id === activeId ? ' is-active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect?.(t.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect?.(t.id); }}
            >
              <Tooltip content={t.tip || name}>
                {/* Two lines: what the item IS, in small capitals ("ORDONANȚĂ
                    DE URGENȚĂ", "CLASS", "TRIBUNALUL CLUJ"), and its name
                    under it ("nr. 64/2012", "6210", "1234/3/2026"). */}
                <span className="lg-rail-title">
                  {t.kind ? <span className="lg-rail-kind">{t.kind}</span> : null}
                  {t.title ? <span className="lg-rail-num">{t.title}</span> : null}
                </span>
              </Tooltip>
              {onClose ? (
                <span className="lg-rail-actions">
                  <Tooltip content="Close">
                    <button type="button" aria-label={`Close ${name}`} onClick={(e) => { e.stopPropagation(); onClose(t.id); }}>{CloseIcon}</button>
                  </Tooltip>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ONE LEGISLATION TAB, AS A BROWSER (lib/legalBrowser, components/LegalBrowser):
//
//   the header ("Legislation", what is kept on this machine)
//   the mini header: [the tabs, when they run along the top]
//                    back · forward · the dice + THE search · where Enter goes · where it came from
//                    the page's own line: its controls at the left, the find at the right
//   ┌ tabs ┐┌ main ───────────────────────────────┐
//   │ tab  ││ the new-tab page, one search's      │
//   │ tab  ││ results on every platform, history, │
//   │ …    ││ or the platform page's own item     │
//   └──────┘└─────────────────────────────────────┘
//
// Every platform is still a page of its own (/legislation, /portal-just,
// /anaf, /caen), each rendering this frame with its own `items` / `activeId`
// / `onSelect` / `onClose` / `bar` / children. The frame publishes them
// (lib/workspaceItems) and REPORTS them to the tabs: a tab showing one of
// its items is bound to it, and an item the reader opens inside a page (a
// citation, a row of the page's own list) becomes that tab's next page. A
// link arriving from elsewhere (the Doc Viewer's "Read here", ANAF's Court
// files, the Newsletter) becomes a page of the active tab. A page's own
// `masthead` and `history` are no longer drawn: the header and the history
// are the tabs'.
const ARRIVAL_KEYS = ['_', 'open', 'nr', 'cui', 'code', 'parte', 'rid', 'q', 'tip', 'an'];

// The tabs' state as the FRAME reads it. The frame only looks at which tab
// is active, each tab's pages and place in them, the switch flag and the
// layout — not at the address field's draft, a tab's loading spinner or its
// pin, which the rows that draw them read for themselves. Every keystroke in
// the address field is a store change, and re-rendering the whole frame
// (masthead, mini header, rail) for it was the cost of typing there; so the
// snapshot handed back stays the same object until something the frame
// reads has changed.
const sameFrame = (a, b) => a.active === b.active && a.switching === b.switching && a.layout === b.layout
  && a.tabs.length === b.tabs.length
  && a.tabs.every((t, i) => t.id === b.tabs[i].id && t.idx === b.tabs[i].idx && t.stack === b.tabs[i].stack);
function useFrameBrowser() {
  const last = useRef(null);
  const get = useCallback(() => {
    const now = browserState();
    if (!last.current || (last.current !== now && !sameFrame(last.current, now))) last.current = now;
    return last.current;
  }, []);
  return useSyncExternalStore(subscribeBrowser, get);
}

export default function LegalWorkspace({
  className = '', bar = {},
  items = [], activeId = null, onSelect, onClose,
  rootRef = null, children, onReload = null,
  // The open item AS ITS SERVICE GAVE IT, for the Source view:
  // `{ site, service, data, text?, note? }` — null while nothing is open.
  source = null,
}) {
  const viewMode = useLegalViewMode();
  const showSource = viewMode === 'source' && !!source;
  const ownRef = useRef(null);
  const pageRef = rootRef || ownRef;
  const go = useGo();
  const { pathname } = go;
  // The tab's RELOAD asks this page to fetch what it shows again
  // (`onReload`, async); registered while the page is mounted.
  const reloadRef = useRef(onReload);
  reloadRef.current = onReload;
  useEffect(() => registerReloader(pathname, () => reloadRef.current?.()), [pathname]);
  const location = useLocation();
  const s = useFrameBrowser();
  const tab = s.tabs.find((t) => t.id === s.active) || s.tabs[0];
  const page = curPage(tab);
  // THE MINI HEADER IS DRAWN ONLY WITH SOMETHING BOTH ABOVE AND UNDER ITS
  // DIVIDER. Every page but the search screen has both (the address row
  // above; the results' scopes, History's Clear or an item's find under).
  // The search screen has neither — its field is in the page — so it has no
  // mini header; with the tabs across the top their strip stands in the page
  // as a plain row instead.
  const barShown = page.type !== 'new';
  useBrowserKeys(go);

  // A link from elsewhere becomes a page of the tabs; coming back to the
  // Legislation tab puts the active tab's page on screen. BEFORE the publish
  // below: an arrival's baseline is the item on show until now, and a page
  // that writes its selection into the URL (CAEN) changes both at once.
  const live = useRef({ onSelect, onClose });
  live.current = { onSelect, onClose };
  const mounted = useRef(false);
  useEffect(() => {
    const url = `${location.pathname}${location.search}`;
    const first = !mounted.current;
    mounted.current = true;
    if (location.search) {
      if (consumeExpected(url)) return;
      // A page writing its OWN address (CAEN's selected code) is not a link
      // arriving from elsewhere.
      if (location.state?.internal) return;
      // A tab window opening ON a tab (the sidebar's "Open in a new window"):
      // that tab selected, its page put on screen.
      const lt = new URLSearchParams(location.search).get('ltab');
      if (lt) { selectTab(lt, go); return; }
      const params = new URLSearchParams(location.search);
      if (ARRIVAL_KEYS.some((k) => params.get(k))) {
        // `newtab=1` asks for a NEW tab from outside the app's router (the Doc
        // Viewer's highlight card, over the main-window channel, which carries
        // no router state); it is not part of the page's address.
        const clean = url.replace(/[?&]_=\d+/, '').replace(/([?&])newtab=1(&|$)/, (m, a, b) => (b ? a : '')).replace(/\?$/, '');
        arrive(location.pathname, clean, arrivalLabel(location.pathname, params), go, { newTab: !!location.state?.newTab || params.get('newtab') === '1' });
      }
      return;
    }
    if (!first || page.type !== 'item') return;
    if (page.route !== pathname) { applyPage(page, go); return; }
    if (page.itemId != null && page.itemId !== activeId && items.some((x) => x.id === page.itemId)) live.current.onSelect?.(page.itemId);
    else if (page.itemId == null && !page.pending) applyPage(page, go);
  }, [location.pathname, location.search]); // eslint-disable-line react-hooks/exhaustive-deps

  // Publish what is open under this platform's route, and answer requests
  // (the tabs, the app sidebar) while mounted — through a ref, so the
  // registered handlers are always the page's latest.
  useEffect(() => {
    publishWorkspace(pathname, { items, activeId });
  });
  useEffect(() => registerWorkspace(pathname, {
    onSelect: (id) => live.current.onSelect?.(id),
    onClose: (id) => live.current.onClose?.(id),
  }), [pathname]);

  // The page's items, reported to the tabs (names, binding, pages opened inside).
  // The page a tab switch asked for is ON SCREEN (the platform's route, and
  // its item shown — or one still opening, which the tab's own spinner
  // covers): the switch is over.
  useEffect(() => {
    if (!s.switching) return;
    if (page.type !== 'item') { endSwitch(); return; }
    // Over when the page shows the tab's item, or is OPENING it (the tab's
    // own spinner covers that), or tried and found nothing to bind. An
    // unbound page not yet asked (the deferred apply has not run) is not over.
    if (pathname !== page.route) return;
    if (page.pending || (page.itemId != null && activeId === page.itemId) || (page.itemId == null && page.settled)) endSwitch();
  });

  const lastActive = useRef(activeId);
  useEffect(() => {
    reportItems(pathname, items, activeId, lastActive.current);
    lastActive.current = activeId;
  });

  // THE MINI HEADER is the Design system's (components/LegalTabs .lgt-bar):
  // it pins and frosts itself; here only its height is measured, for the
  // rail standing under it, and how far the page scrolls before it sticks.
  useLayoutEffect(() => {
    const root = pageRef.current;
    const barEl = root?.querySelector(':scope > .lgt-bar');
    const scroller = root?.closest('.sv-single-scroll, .main-content');
    if (!root || !scroller) return undefined;
    if (!barEl) {
      // No mini header (the search screen, tabs down the side): the rail
      // stands under the masthead and sticks at the page's inset.
      root.style.setProperty('--lgb-bar-h', '0px');
      root.style.setProperty('--lgb-scroll-h', `${scroller.clientHeight}px`);
      const shell = root.querySelector('.lgb-shell');
      const natural = shell ? shell.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop : 0;
      root.style.setProperty('--lgb-travel', `${Math.max(0, Math.round(natural))}px`);
      return undefined;
    }
    // --lgb-travel: how far the page scrolls before the bar (and the rail
    // under it) sticks — the range over which the rail grows to its stuck
    // height, so its foot stays one inset above the window's bottom.
    const place = () => {
      root.style.setProperty('--lgb-bar-h', `${barEl.offsetHeight}px`);
      root.style.setProperty('--lgb-scroll-h', `${scroller.clientHeight}px`);
      const inset = parseFloat(getComputedStyle(barEl).top) || 0;
      const was = barEl.style.position;
      barEl.style.position = 'relative';
      const natural = barEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      barEl.style.position = was;
      root.style.setProperty('--lgb-travel', `${Math.max(0, Math.round(natural - inset))}px`);
    };
    place();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    ro?.observe(barEl); ro?.observe(scroller);
    window.addEventListener('resize', place);
    return () => { ro?.disconnect(); window.removeEventListener('resize', place); };
  }, [barShown]); // eslint-disable-line react-hooks/exhaustive-deps

  // THE RAIL: not drawn while the only tab is the search tab (a new tab) —
  // a list of one blank tab says nothing.
  const soleSearch = s.tabs.length === 1 && page.type === 'new';
  // The app sidebar's Legislation dropdown already lists the tabs while it
  // is expanded (and the sidebar is not collapsed): the page's own rail of
  // the same tabs is not drawn then.
  const sidebarLists = useSidebarListsTabs();
  // The list can be put away from the bar's toggle (kept per device); while
  // the app sidebar lists the tabs the page's rail steps aside anyway.
  const [railHidden, setRailHidden] = useState(() => { try { return localStorage.getItem(LEGAL_RAIL_HIDDEN_KEY) === '1'; } catch { return false; } });
  const canRail = s.layout !== 'strip' && !soleSearch;
  const showRail = canRail && !sidebarLists && !railHidden;
  const toggleRail = () => {
    const next = !showRail;
    setRailHidden(!next);
    try { localStorage.setItem(LEGAL_RAIL_HIDDEN_KEY, next ? '0' : '1'); } catch { /* quota */ }
    // Showing it takes the list back from the app sidebar (one switch).
    if (next && sidebarLists) window.dispatchEvent(new CustomEvent('docvex:legal-list-set', { detail: { open: false } }));
  };
  const rail = useRailPresence(showRail);
  useRailFill(pageRef, rail.mounted);

  // Moving to another page of the tabs lands at the top.
  const pageKey = `${tab.id}|${tab.idx}|${page.type}`;
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) { firstKey.current = false; return; }
    const scroller = pageRef.current?.closest('.sv-single-scroll, .main-content');
    if (scroller) scroller.scrollTop = 0;
  }, [pageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [menu, setMenu] = useState(null);
  const openMenu = useCallback((id, x, y) => setMenu({ id, x, y }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // THE FIND, at the right of the page's line: the page's own (an open act's)
  // or one over whatever the tab shows.
  const mainRef = useRef(null);
  const isItem = page.type === 'item';
  const { tools, trailing, ...barRest } = bar || {};
  const pageSearch = isItem && barRest.search && !barRest.noSearch && barRest.search.find ? barRest.search : null;
  const [tabFind, setTabFind] = useTabSetting(`browser|${tab.id}|${tab.idx}`, 'find', '');
  const found = useChatFind({ containerRef: mainRef, query: isItem && !pageSearch ? tabFind : '', name: 'legalfind' });
  const search = !isItem ? null : pageSearch || {
    value: tabFind,
    placeholder: 'Find in this page',
    onChange: setTabFind,
    find: { current: found.current, total: found.total, prev: found.goPrev, next: found.goNext },
  };

  // THE SEARCH SCREEN FITS THE WINDOW: everything on it is in view, so the
  // page does not scroll — the shell is sized to run from where it starts to
  // one inset above the window's bottom (`--lgb-fit-h`), the page's scroller
  // is locked while it is on show (LegalBrowser.css), and a window too short
  // for it scrolls the column inside, never the page.
  const isSearch = page.type === 'new';
  useLayoutEffect(() => {
    if (!isSearch) return undefined;
    const root = pageRef.current;
    const scroller = root?.closest('.sv-single-scroll, .main-content');
    const shell = root?.querySelector('.lgb-shell');
    if (!root || !scroller || !shell) return undefined;
    const fit = () => {
      scroller.scrollTop = 0;
      const top = toLayoutPx(shell.getBoundingClientRect().top - scroller.getBoundingClientRect().top) - scroller.clientTop;
      const inset = parseFloat(getComputedStyle(root).getPropertyValue('--ds-page-inset')) || 6.4;
      root.style.setProperty('--lgb-fit-h', `${Math.max(160, Math.floor(scroller.clientHeight - top - inset))}px`);
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(scroller);
    window.addEventListener('resize', fit);
    return () => { ro?.disconnect(); window.removeEventListener('resize', fit); root.style.removeProperty('--lgb-fit-h'); };
  }, [isSearch, barShown]); // eslint-disable-line react-hooks/exhaustive-deps

  const figures = useArchiveFigures();
  const strip = s.layout === 'strip';
  const pageTools = page.type === 'serp' ? <SerpScopes page={page} />
    : page.type === 'history' ? <ClearHistoryButton />
      : isItem && (tools || trailing) ? <>{tools}{trailing}</> : null;
  // The rail toggle first on the line, wherever the page has a rail to show.
  const lineTools = canRail
    ? <><RailToggle shown={showRail} onToggle={toggleRail} what="tabs" />{pageTools}</>
    : pageTools;

  // THE "i" (what is kept on this machine) stands directly ABOVE THE
  // DIVIDER under the masthead's text: with an address row, that divider is
  // the mini header's hairline under the row, so the "i" ends the row; on the
  // search screen (no address row) the divider is the masthead's own, and it
  // stays in the masthead.
  const addrShown = page.type !== 'new';
  const info = (
    <InfoButton label="What is kept on this machine" title="Kept on this machine">
      <KeptFigures count={figures?.count ?? 0} bytes={figures?.bytes ?? 0} />
      <p className="lgb-info-note">
        Acts you open are saved here whole, so they still open when legislatie.just.ro does not answer.
      </p>
    </InfoButton>
  );

  return (
    <div className={`lws lgb-root${className ? ` ${className}` : ''}${strip ? ' is-strip' : ''}${isSearch ? ' is-search' : ''}`} ref={pageRef}>
      <PageMasthead
        eyebrow="Legal search"
        eyebrowMuted={`· ${LEGAL_TABS.filter((t) => !t.stub).length} platforms connected`}
        title="Legislation"
        compact={false}
        actions={addrShown ? null : info}
      >
        Romanian law, court files, companies and CAEN codes behind one search — type anything and every
        connected platform answers at once. What you open stays in the list on the left, like browser tabs.
      </PageMasthead>
      {barShown ? <LegalTabs
        standalone
        className="lgb-bar"
        rows={[
          strip ? <TabStrip go={go} openMenu={openMenu} /> : null,
          // The search screen has its field in the page (NewTabPage).
          page.type === 'new' ? null : <AddressRow go={go} status={isItem ? barRest.status : page.type === 'serp' ? <SerpStatus page={page} /> : null} extra={info} />,
        ]}
        tools={lineTools}
        search={search}
        noSearch={!search}
        // Nothing to put under the hairline (a new tab): no second line.
        line2={!!(lineTools || search)}
      /> : null}
      {!barShown && s.layout === 'strip' ? <div className="lgb-strip-plain"><TabStrip go={go} openMenu={openMenu} /></div> : null}
      <div className={`lgb-shell${rail.mounted ? ' has-rail' : ''}`}>
        {rail.mounted ? <TabRail go={go} openMenu={openMenu} className={rail.className} /> : null}
        <div className={`lgb-main${s.switching && isItem ? ' is-switching' : ''}`} ref={mainRef}>
          {/* A tab switch on its way: the content fades and a spinner shows
              (after a moment) until the page shows the tab. */}
          {s.switching && isItem ? <SwitchSpinner /> : null}
          {page.type === 'new' ? <NewTabPage />
            : page.type === 'history' ? <HistoryPage />
              : page.type === 'serp' ? <SerpPage key={`${page.q}|${tab.id}`} page={page} tabId={tab.id} />
                : (
                  <>
                    {/* DocVex · Source (the address row's switch): in Source
                        the open item is shown as the service gave it, and the
                        page's own view stays MOUNTED but hidden, so switching
                        back keeps its state (scroll, find, tables). */}
                    {showSource ? <SourceView source={source} /> : null}
                    <div style={{ display: showSource ? 'none' : 'contents' }}>{children}</div>
                  </>
                )}
        </div>
      </div>
      <TabMenu menu={menu} onClose={closeMenu} go={go} />
    </div>
  );
}

// THE RAIL FILLS THE SPACE ABOVE IT. Its column's top is the mini header's
// foot; but where the header's second line holds nothing over the rail (a
// new tab: no controls, no find; an open item whose only control is the find
// at the right) that band is empty, and the rail grows up into it — lifted by
// a transform, its height grown by the same, its foot still one inset above
// the window's bottom. Driven here rather than by CSS because what is empty
// is a matter of what the line happens to hold: the rows and every visible
// thing on the second line that stands over the rail's width set the floor.
// A change of layout (a page switch, the window resized) EASES to the new
// place; a scroll follows at once (a transition there would lag the foot).
function useRailFill(pageRef, on) {
  useLayoutEffect(() => {
    const root = pageRef.current;
    if (!root || !on) return undefined;
    const rail = root.querySelector('.lgb-rail');
    const shell = root.querySelector('.lgb-shell');
    const bar = root.querySelector(':scope > .lgt-bar');
    const scroller = root.closest('.sv-single-scroll, .main-content');
    if (!rail || !shell || !bar || !scroller) return undefined;
    const zoom = 1 / (toLayoutPx(1) || 1);                  // layout px → viewport px
    const css = (el, name, fb) => parseFloat(getComputedStyle(el).getPropertyValue(name)) || fb;
    // What occupies the band over the rail's width: a row, or a visible
    // control on the second line (looking through display: contents wrappers).
    const lowest = (el, left, right, acc) => {
      if (el.classList?.contains('is-hidden')) return acc;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) {
        for (const c of el.children) acc = lowest(c, left, right, acc);
        return acc;
      }
      if (r.right <= left || r.left >= right) return acc;
      return Math.max(acc, r.bottom);
    };
    let easeTimer = null;
    const update = (ease) => {
      if (window.innerWidth <= 760) {
        rail.classList.remove('is-filled', 'is-lifted', 'is-easing');
        shell.style.minHeight = '';
        return;
      }
      const sr = scroller.getBoundingClientRect();
      const inset = css(bar, 'top', 6.4) * zoom;
      const gap = css(root, '--ds-head-gap', 8) * zoom;
      // The rail keeps track of the MINI HEADER as it really stands — its
      // measured bottom edge, in flow or pinned — not of where its height
      // and the inset say it should be. Pinned, the rail sticks one head-gap
      // under that edge (its sticky top is written from it); in flow, the
      // shell under the bar is already there.
      // STICKY, FROM CONSTANTS — never from the bar's pinned class, which
      // flips a few pixels early and a frame late (LegalTabs decides it on
      // its own scroll listener): the rail's sticky top is ALWAYS the bar's
      // sticky top + the bar's height + the head gap, both measured against
      // the same scrollport origin, so the two stick at the same scroll.
      const br = bar.getBoundingClientRect();
      const sc = getComputedStyle(scroller);
      const origin = sr.top + (scroller.clientTop + (parseFloat(sc.paddingTop) || 0)) * zoom;
      const barTopL = css(bar, 'top', 6.4);
      const railTopL = barTopL + bar.offsetHeight + gap / zoom;
      rail.style.setProperty('--lgb-rail-top', `${railTopL}px`);
      const stuckTop = origin + railTopL * zoom;
      // Stuck or about to paint as pinned: its frosted ground covers its box.
      const pinned = bar.classList.contains('is-pinned') || br.top <= origin + barTopL * zoom + 0.5;
      // Where the rail stands without any lift: its place in the page, or
      // its sticky top once it has reached it.
      const natural = Math.max(shell.getBoundingClientRect().top, stuckTop);
      // The shell is kept exactly tall enough for the rail STUCK (its height
      // there + its bottom margin), so sticking never runs out of room.
      const foot0 = sr.top + scroller.clientHeight * zoom - inset;
      shell.style.minHeight = `${toLayoutPx(foot0 - stuckTop + inset)}px`;
      const rr = rail.getBoundingClientRect();
      // What stands above the rail and must not be overlapped: PINNED, the
      // bar paints its frosted ground over its whole box, so all of it is
      // taken; in flow the bar is transparent, and only what it holds counts
      // — its rows (with their hairline) and the visible controls on its
      // second line over the rail's width. The rail is lifted only into
      // what is left empty, and shrinks back as soon as anything is there.
      let floor = -Infinity;
      if (pinned) floor = br.bottom;
      for (const row of bar.querySelectorAll(':scope > .lgt-row')) floor = Math.max(floor, row.getBoundingClientRect().bottom + 2 * zoom);
      const line2 = bar.querySelector(':scope > .lgt-line2');
      // The line under the divider is the header's WHOLE band, whatever
      // stands on it and wherever (a find at its far right, a status…): the
      // rail never rises into it — lifting into its empty left used to put
      // the rail over the header's own line.
      if (line2) {
        const lr = line2.getBoundingClientRect();
        if (lr.height) floor = Math.max(floor, lr.bottom);
        else for (const c of line2.children) floor = lowest(c, rr.left, rr.right, floor);
      }
      const lift = floor === -Infinity ? 0 : Math.max(0, natural - (floor + gap));
      const height = foot0 - (natural - lift);
      if (ease) {
        rail.classList.add('is-easing');
        clearTimeout(easeTimer);
        easeTimer = setTimeout(() => rail.classList.remove('is-easing'), 320);
      }
      rail.style.setProperty('--lgb-lift', `${toLayoutPx(lift)}px`);
      rail.style.setProperty('--lgb-fill-h', `${toLayoutPx(height)}px`);
      rail.classList.add('is-filled');
      rail.classList.toggle('is-lifted', lift > 0.5);
    };
    let frame = null;
    const onScroll = () => { if (frame == null) frame = requestAnimationFrame(() => { frame = null; update(false); }); };
    const onLayout = () => requestAnimationFrame(() => update(true));
    update(false);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onLayout);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onLayout) : null;
    ro?.observe(bar); ro?.observe(scroller); ro?.observe(shell);
    // The bar pinning / unpinning (its own class) happens mid-scroll: follow
    // it at once. Anything else changing in the bar is a layout change: ease.
    const mo = new MutationObserver((list) => {
      const pinFlip = list.every((m) => m.type === 'attributes' && m.target === bar);
      if (pinFlip) onScroll(); else onLayout();
    });
    mo.observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onLayout);
      ro?.disconnect(); mo.disconnect();
      if (frame != null) cancelAnimationFrame(frame);
      clearTimeout(easeTimer);
      shell.style.minHeight = '';
    };
  }, [pageRef, on]);
}

// Where a results page's answers came from: every platform live, or the
// Legislation portal answered from the copy on this machine.
function SerpStatus({ page }) {
  const { answers } = useSerp(page.q, page.scope, 'all', page.refresh || 0);
  const leg = answers.legislation;
  const archive = !!leg && leg !== 'loading' && leg.source === 'archive';
  const scope = page.scope || 'all';
  const site = scope === 'all' ? 'legislatie.just.ro' : LEGAL_TABS.find((t) => t.id === scope)?.label || 'legislatie.just.ro';
  return (
    <Tooltip content={archive ? 'legislatie.just.ro did not answer — its results come from the copy kept here' : `Open ${site} in the browser`}>
      <button type="button" className={`lgt-status-pill is-${archive ? 'archive' : 'live'}`} onClick={() => openExternal(`https://${site.split(' ')[0]}/`)}>
        <span>{archive ? 'Legislation from your copy on this machine' : scope === 'all' ? 'Live from every platform' : `Live from ${site}`}</span>
        <span className="lgt-status-ico">{ExternalGlyph}</span>
      </button>
    </Tooltip>
  );
}

// "Kept here" / "On this machine": the acts the Legislation portal has left on
// this machine (read once, kept for the session).
let figuresCache = null;
// THE RAIL COMES AND GOES ANIMATED (the app sidebar taking the list over,
// the only tab being the search tab…): it narrows to nothing while it fades
// and the page beside it glides over — and back. Mounted without motion on
// the page's first frame. States: 'in' · 'from' (collapsed, about to grow) ·
// 'growing' · 'leaving' (collapsing, then unmounted) · 'out'.
const RAIL_MS = 300;
const LEGAL_RAIL_HIDDEN_KEY = 'docvex:legislation:rail-hidden';

function useRailPresence(show) {
  const [st, setSt] = useState(show ? 'in' : 'out');
  useEffect(() => {
    let raf = 0; let timer = 0;
    if (show) {
      // Each step schedules the NEXT from its own state: scheduling the grow
      // together with setSt('from') lost it — the state change re-ran this
      // effect, whose cleanup cancelled the frame, and the rail stayed
      // folded (mounted, zero wide) with the dropdown collapsed.
      if (st === 'out' || st === 'leaving') {
        setSt('from');
      } else if (st === 'from') {
        raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => setSt('growing')); });
      } else if (st === 'growing') {
        timer = setTimeout(() => setSt('in'), RAIL_MS);
      }
    } else if (st === 'in' || st === 'from' || st === 'growing') {
      setSt('leaving');
    } else if (st === 'leaving') {
      timer = setTimeout(() => setSt('out'), RAIL_MS);
    }
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
  }, [show, st]);
  const reduce = typeof document !== 'undefined' && document.documentElement.dataset.reduceMotion === 'true';
  if (reduce) return { mounted: show, className: '' };
  return {
    mounted: st !== 'out',
    className: st === 'from' ? 'is-folded' : st === 'growing' ? 'is-animating' : st === 'leaving' ? 'is-folded is-animating' : '',
  };
}

// THE SOURCE VIEW — the open item exactly as its platform's service gave it
// (the address row's DocVex · Source switch, Source by default): which
// service answered, the record as it came (JSON, in the service's own field
// names) and — for an act — its full text as sent, one line break for one.
// Nothing restyled, nothing left out. Copy puts all of it on the clipboard.
function SourceView({ source }) {
  const json = React.useMemo(() => {
    try { return JSON.stringify(source.data ?? null, null, 2); } catch { return String(source.data); }
  }, [source.data]);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const all = source.text ? `${json}\n\n${source.text}` : json;
    navigator.clipboard?.writeText(all).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {});
  };
  return (
    <section className="lgb-source" aria-label="The data as the service gave it">
      <header className="lgb-source-head">
        <div className="lgb-source-meta">
          <span className="lgb-source-site">{source.site}</span>
          <span className="lgb-source-service">{source.service}</span>
        </div>
        <button type="button" className="lgt-tool-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </header>
      {source.note ? <p className="lgb-source-note">{source.note}</p> : null}
      <pre className="lgb-source-json">{json}</pre>
      {source.text ? (
        <>
          <p className="lgb-source-label">Text · {source.text.length.toLocaleString()} characters</p>
          <pre className="lgb-source-text">{source.text}</pre>
        </>
      ) : null}
    </section>
  );
}

function SwitchSpinner() {
  const [on, setOn] = useState(false);
  useEffect(() => { const id = setTimeout(() => setOn(true), 140); return () => clearTimeout(id); }, []);
  return on ? (
    <div className="lgb-switching" role="status" aria-label="Loading">
      <span className="lgb-switching-spin" aria-hidden="true" />
    </div>
  ) : null;
}

function useSidebarListsTabs() {
  const read = () => window.__docvexLegalListed === true && window.__docvexSidebarCollapsed !== true;
  const [on, setOn] = useState(read);
  useEffect(() => {
    const sync = () => setOn(read());
    window.addEventListener('docvex:legal-listed', sync);
    window.addEventListener('docvex:sidebar-state', sync);
    sync();
    return () => {
      window.removeEventListener('docvex:legal-listed', sync);
      window.removeEventListener('docvex:sidebar-state', sync);
    };
  }, []);
  return on;
}

function useArchiveFigures() {
  const [f, setF] = useState(figuresCache);
  useEffect(() => {
    let alive = true;
    listArchive().then((r) => {
      if (!alive || !r?.ok) return;
      const acts = r.acts || r.records || [];
      figuresCache = { count: acts.filter((a) => a.hasText ?? a.withText ?? true).length, bytes: r.bytes || 0 };
      setF(figuresCache);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return f;
}
