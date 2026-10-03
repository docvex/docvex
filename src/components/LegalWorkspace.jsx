import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import './LegalWorkspace.css';
import LegalTabs, { LEGAL_TABS } from './LegalTabs';
import { ViewModeToggle } from './LegalBrowser';
import PageMasthead from './PageMasthead';
import Tooltip from './Tooltip';
import { useItemSpots } from './DocRibbon';
import { toLayoutPx } from '../lib/appZoom';
import { openExternal } from '../lib/platform';
import { useLocation, useNavigate } from 'react-router-dom';
import { publishWorkspace, registerWorkspace, requestWorkspace, subscribeWorkspaces, workspacesSnapshot } from '../lib/workspaceItems';
import { syncSourceItems } from '../lib/legislationEntries';
import { researchStore } from '../lib/researchChats';
import AskRail, { ASK_RAIL_WIDTH_KEY, ASK_RAIL_MIN, ASK_RAIL_MAX, ASK_RAIL_DEFAULT, readAskRailWidth, useAskRailState, AskRailToggle } from './AskRail';
import { PLATFORMS } from '../lib/legalBrowser';
import { registerHoverSpot } from '../lib/pointer';
import { useRailSpotlight } from '../lib/pointerSpots';
import { useLegalViewMode } from '../lib/legalViewMode';

// The frame every Legislation tab stands in — see LegalWorkspace (below) for
// its layout. The other exports are the pieces the platform pages draw with:
// the search view, the rail of what is open, the source pill, the figures.

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
  // `backup:<provider>` — an answer from a backup service (court files: the
  // portal could not answer, so EasyAPI or DosarJust did). Drawn as a copy is.
  const backup = String(source).startsWith('backup:') ? String(source).slice(7) : '';
  const src = sync === 'same' ? 'live' : backup ? 'archive' : source;
  return (
    <>
      <Tooltip content={backup ? `${site} could not answer, so this came from ${backup}, a backup service — it may be a little behind` : (tip || 'Open the source in the browser')}>
        <button type="button" className={`lgt-status-pill is-${src}`} onClick={() => href && openExternal(href)}>
          {sync === 'same' ? <span className="lgt-status-ico">{TickGlyph}</span> : null}
          <span>{src === 'live' ? liveLabel : backup ? `From ${backup} (backup)` : archiveLabel}</span>
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

// A bin — the pages' "Kept …" buttons (forget the copies kept on this machine).
export const BinIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" />
  </svg>
);

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
 *  (`asked` false) it is the tab's EMPTY STATE — a thin-stroke mark, a title,
 *  a muted line, centred — holding the ways to search STACKED at a larger
 *  size, "or" between them, each labelled over and hinted under
 *  (`modes: [{ id, label, hint?, node }]`), and `foot` (Clear, the bar's
 *  note) under them. Once there is an answer the same controls stand as one
 *  compact row over it. (Restored 2026-10-02: with the Legislation browser
 *  retired, each source tab is searched from its own page again.) */
export function WorkspaceSearch({ asked, title = '', sub = '', modes = [], foot = null }) {
  if (!asked) {
    return (
      <div className="lg-start">
        <div className="lg-start-mark" aria-hidden="true">{SearchMark}</div>
        {title ? <h2 className="lg-start-title">{title}</h2> : null}
        {sub ? <p className="lg-start-sub">{sub}</p> : null}
        {modes.length ? (
          <div className="lg-start-modes">
            {modes.map((m, i) => (
              <React.Fragment key={m.id || i}>
                {i > 0 ? <p className="lg-start-or">or</p> : null}
                <div className="lg-start-mode">
                  {m.label ? <p className="lg-start-label">{m.label}</p> : null}
                  {m.node}
                  {m.hint ? <p className="lg-start-hint">{m.hint}</p> : null}
                </div>
              </React.Fragment>
            ))}
          </div>
        ) : null}
        {foot ? <div className="lg-start-foot">{foot}</div> : null}
      </div>
    );
  }
  return (
    <div className="lg-searchrow">
      {modes.map((m, i) => <React.Fragment key={m.id || i}>{m.node}</React.Fragment>)}
      {foot}
    </div>
  );
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


// ── THE ONE SIDEBAR of the Legislation entry (2026-10-02) ─────────────────
// Every tab of the entry shows the same list on its left: Ask's chats, then
// what each source has open (its acts, court files, companies, CAEN codes —
// published by the source pages through lib/workspaceItems, so the list
// knows a tab's items while another tab is on show). A press goes to that
// tab and opens the item there; × closes it. On Ask the list is Research's
// own chat rail (with its drag, menu and resize) and these SOURCE GROUPS are
// appended to it; on a source tab the whole of it is `LegislationRail`.
const RailCloseGlyph = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

function RailRow({ active, tone, kind, title, tip, onOpen, onClose, closeLabel = 'Close' }) {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className={`lg-rail-item lgb-rtab${active ? ' is-active' : ''}`}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      onAuxClick={(e) => { if (e.button === 1 && onClose) { e.preventDefault(); onClose(); } }}
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
    >
      <Tooltip content={tip || title}>
        <span className="lg-rail-title">
          <span className="lg-rail-kind lgb-rtab-kind">
            <span className="lgb-dot" style={{ '--tone': tone }} />
            <span className="lgb-rtab-kindtext">{kind}</span>
          </span>
          <span className="lg-rail-num">{title}</span>
        </span>
      </Tooltip>
      {onClose ? (
        <span className="lg-rail-actions">
          <Tooltip content={closeLabel}>
            <button type="button" aria-label={closeLabel} onClick={(e) => { e.stopPropagation(); onClose(); }}>{RailCloseGlyph}</button>
          </Tooltip>
        </span>
      ) : null}
    </div>
  );
}

/** What each SOURCE has open, one group per source with something in it. */
export function LegislationSourceGroups() {
  const lists = useSyncExternalStore(subscribeWorkspaces, workspacesSnapshot);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const groups = LEGAL_TABS
    .map((t) => ({ t, list: lists?.[t.to] }))
    .filter(({ list }) => list?.items?.length);
  if (!groups.length) return null;
  return groups.map(({ t, list }) => {
    const tone = PLATFORMS[t.id]?.tone || 'var(--accent)';
    return (
      <React.Fragment key={t.id}>
        <div className="lgb-rail-div" aria-hidden="true" />
        <p className="lgw-rail-group">{t.label}</p>
        {list.items.map((it) => (
          <RailRow
            key={it.id}
            active={pathname === t.to && list.activeId === it.id}
            tone={tone}
            kind={it.kind || t.short || t.label}
            title={it.title || it.kind || ''}
            tip={it.tip}
            onOpen={() => {
              if (pathname !== t.to) navigate(t.to);
              requestWorkspace(t.to, 'select', it.id);
            }}
            onClose={() => requestWorkspace(t.to, 'close', it.id)}
          />
        ))}
      </React.Fragment>
    );
  });
}

/** THE one sidebar on a source tab: the Ask tab's own list (components/AskRail
 *  — New research, the chats, what each source has open), its width shared
 *  with Ask's and resizable here too. Opening a chat goes to Ask. Like Ask's,
 *  it sticks under the mini header, runs to one gap above the window's foot
 *  and draws its card only while stuck. */
export function LegislationRail() {
  const navigate = useNavigate();
  const railRef = useRef(null);
  const [width, setWidth] = useState(readAskRailWidth);
  const [resizing, setResizing] = useState(false);
  const toAsk = () => navigate('/research');
  const startResize = (e) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startW = width;
    let latest = startW;
    const onMove = (ev) => { latest = Math.max(ASK_RAIL_MIN, Math.min(ASK_RAIL_MAX, startW + toLayoutPx(ev.clientX - startX))); setWidth(latest); };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
      try { localStorage.setItem(ASK_RAIL_WIDTH_KEY, String(Math.round(latest))); } catch { /* quota */ }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  // Sticky under the mini header; its height down to one gap above the
  // window's foot; the card only while stuck (Research.jsx does the same).
  useEffect(() => {
    const rail = railRef.current;
    const scroller = rail?.closest('.sv-single-scroll, .main-content');
    if (!rail || !scroller) return undefined;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const root = rail.closest('.lws') || scroller;
      const bar = root.querySelector('.lgt-bar');
      const cs = getComputedStyle(rail);
      const inset = parseFloat(cs.getPropertyValue('--chrome-inset')) || 6.4;
      const gap = parseFloat(cs.getPropertyValue('--rail-gap')) || 6.4;
      const top = inset + (bar ? bar.offsetHeight : 48) + gap;
      rail.style.top = `${top}px`;
      const sr = scroller.getBoundingClientRect();
      const at = toLayoutPx(rail.getBoundingClientRect().top - sr.top);
      rail.classList.toggle('is-stuck', scroller.scrollTop > 0 && at <= top + 0.5);
      rail.style.height = `${Math.max(160, scroller.clientHeight - Math.max(at, top) - gap)}px`;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null;
    ro?.observe(scroller);
    if (rail.parentElement) ro?.observe(rail.parentElement);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); scroller.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); };
  }, []);
  return (
    <>
      <AskRail
        railRef={railRef}
        className={`lgw-askrail${resizing ? ' is-resizing' : ''}`}
        onNew={() => { researchStore.openNew(); toAsk(); }}
        onOpenChat={toAsk}
        style={{ flexBasis: `calc(${width}px + var(--ds-divider-pull, 11.2px))` }}
      />
      <div
        className={`lgw-askrail-resizer${resizing ? ' is-active' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the list"
        onMouseDown={startResize}
        onDoubleClick={() => { setWidth(ASK_RAIL_DEFAULT); try { localStorage.setItem(ASK_RAIL_WIDTH_KEY, String(ASK_RAIL_DEFAULT)); } catch { /* quota */ } }}
      />
    </>
  );
}

/** THE LEGISLATION ENTRY'S MASTHEAD — one, the same on Ask (pages/Research)
 *  and on every source tab: switching tabs changes what is under the tab
 *  row, never the header above it. */
export function LegislationMasthead() {
  return (
    <PageMasthead eyebrow="Legislation" eyebrowMuted="· Romanian law and your case" title="Legislation" compact={false}>
      Ask about Romanian law and your case, or search each source on its own tab — acts, court files,
      companies, CAEN codes and the sources still to come.
    </PageMasthead>
  );
}

// THE LEGISLATION TAB (2026-10-02): one sidebar entry, tabs across the top —
// ASK (the conversation, pages/Research) and then every source DocVex reads
// or will read, in the order Research's "i" lists them (LEGAL_TABS). A source
// tab is that platform's OWN PAGE, searched from its own search view
// (WorkspaceSearch); the cross-platform browser that stood here (one search
// for every platform, browser-style tabs, an address row) was retired — Ask
// is the one search across everything now.
//
//   masthead ("Legislation" — or the page's own)
//   the tab bar (LegalTabs): Ask · legislatie.just.ro · portal.just.ro · …
//     its second line: the page's own tools, its find / search
//   ┌ open ┐┌ main ─────────────────────────────┐
//   │ item ││ the search view, or the item open  │
//   └──────┘└────────────────────────────────────┘
//
// A page hands it: `bar` (LegalTabs' props — tools, search, status,
// trailing, noSearch); `items`
// ([{ id, kind, title, tip }]) with `activeId`, `onSelect(id)`, `onClose(id)`
// — what the page has open, listed on the left; `source` (the open item AS
// ITS SERVICE GAVE IT, for the DocVex · Source switch); `className`,
// `rootRef`; children = the main column. The masthead is the entry's one
// (LegislationMasthead), never the page's. The Newsletter uses the same frame without the source tabs.
export default function LegalWorkspace({
  className = '', bar = {},
  items = [], activeId = null, onSelect, onClose,
  rootRef = null, children,
  source = null,
}) {
  const viewMode = useLegalViewMode();
  const showSource = viewMode === 'source' && !!source;
  const ownRef = useRef(null);
  const pageRef = rootRef || ownRef;
  const { pathname } = useLocation();
  const newsletter = pathname === '/newsletter';

  // What this source has open, published for THE sidebar (every tab lists
  // every tab's items), and how it answers a press there.
  const live = useRef({ onSelect, onClose });
  live.current = { onSelect, onClose };
  useEffect(() => {
    if (newsletter) return;
    publishWorkspace(pathname, { items, activeId });
    // Every item opened here is kept in the ONE list (lib/legislationEntries).
    syncSourceItems(pathname, items);
  });
  useEffect(() => (newsletter ? undefined : registerWorkspace(pathname, {
    onSelect: (id) => live.current.onSelect?.(id),
    onClose: (id) => live.current.onClose?.(id),
  })), [pathname, newsletter]);

  // Moving to another item lands at its top.
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) { firstKey.current = false; return; }
    const scroller = pageRef.current?.closest('.sv-single-scroll, .main-content');
    if (scroller) scroller.scrollTop = 0;
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const { tools, trailing, status, search, noSearch } = bar || {};
  // DocVex · Source, wherever an item open has its service's own record.
  // The list's show / hide button stands first on every tab's second line,
  // under the tab bar's underline (one setting for every tab, components/AskRail).
  const lineTools = !newsletter || source || tools
    ? <>{newsletter ? null : <AskRailToggle />}{source ? <ViewModeToggle /> : null}{tools}</>
    : null;
  const { off: railOff } = useAskRailState();
  const lineTrailing = trailing || null;

  // ONE masthead for the whole Legislation entry — the same on Ask and on
  // every source tab (LegislationMasthead); the Newsletter draws its own.
  const head = newsletter ? null : <LegislationMasthead />;

  return (
    <div className={`lws lgw-root${className ? ` ${className}` : ''}`} ref={pageRef}>
      {head}
      <LegalTabs
        standalone={newsletter}
        status={status}
        tools={lineTools}
        trailing={lineTrailing}
        search={search}
        noSearch={!search || !!noSearch}
        dropSearch={!search || !!noSearch}
        line2={!!(lineTools || lineTrailing || search)}
      />
      <div className={`lgw-shell${newsletter || railOff ? '' : ' has-rail'}`}>
        {/* THE one sidebar of the entry — the same list on every tab. */}
        {newsletter || railOff ? null : <LegislationRail />}
        <div className="lgw-main">
          {/* DocVex · Source: in Source the open item is shown as the service
              gave it, and the page's own view stays MOUNTED but hidden, so
              switching back keeps its state. */}
          {showSource ? <SourceView source={source} /> : null}
          <div style={{ display: showSource ? 'none' : 'contents' }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

// THE SOURCE VIEW — the open item exactly as its platform's service gave it
// (the DocVex · Source switch on the tab bar's second line): which
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

