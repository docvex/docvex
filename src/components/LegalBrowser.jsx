import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import './LegalBrowser.css';
import Tooltip from './Tooltip';
import RuleOptions from './RuleOptions';
import { useItemSpots } from './DocRibbon';
import { useRailSpotlight } from '../lib/pointerSpots';
import { LEGAL_TABS } from './LegalTabs';
import { detectQuery, randomQuery } from '../lib/legalOmni';
import { isMac } from '../lib/platform';
import { useLegalViewMode, setLegalViewMode } from '../lib/legalViewMode';
import {
  subscribeBrowser, browserState, curPage, pageMeta, PLATFORMS, PLATFORM_ORDER,
  navigateActive, openInNewTab, newTab, selectTab, closeTab, closeOthers, reopenClosed, openSearch, isSearchTab,
  duplicateTab, togglePin, moveTab, stepTab, reloadTab, canReload, setDraft, replaceActive, clearHistory, setLayout, setTabLoading,
} from '../lib/legalBrowser';
import { pageForQuery, platformsFor, searchPlatform, peekPlatform, peekAnswer, forgetAnswers, facetsFor, inBranch } from '../lib/legalSearch';

// THE LEGISLATION TAB'S BROWSER CHROME — the pieces LegalWorkspace lays out:
// the tabs (a RAIL down the left, or a STRIP along the top), the ADDRESS row
// (back / forward, the dice joined to the one search, where Enter will go,
// where what is on show came from), and the tab's own pages: the NEW TAB page,
// the RESULTS of one search across every platform, and HISTORY. The state is
// lib/legalBrowser's; the answers lib/legalSearch's.
//
// Links follow a browser's rules: a click opens here, Ctrl/⌘+click in a new
// tab behind, Shift+click in a new tab in front, the middle button behind.

// ── Hooks ──
export const useBrowser = () => useSyncExternalStore(subscribeBrowser, browserState);
const histOf = () => browserState().hist;
export function useGo() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return useMemo(() => ({ navigate, pathname }), [navigate, pathname]);
}

/** Click / Ctrl+click / Shift+click / middle-click on something that opens `page`. */
export function linkProps(page, go) {
  return {
    onClick: (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) openInNewTab(page, go, { background: true });
      else if (e.shiftKey) openInNewTab(page, go);
      else navigateActive(page, go);
    },
    onAuxClick: (e) => { if (e.button === 1) { e.preventDefault(); openInNewTab(page, go, { background: true }); } },
    onMouseDown: (e) => { if (e.button === 1) e.preventDefault(); },
  };
}

// ── Glyphs ──
const G = {
  reload: <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>,
  close: <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  plus: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  // A panel moving into the sidebar on the left.
  toSide: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9 4.5v15" /><path d="M16 9.5l-2.5 2.5 2.5 2.5" /></svg>,
  clock: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>,
  back: <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>,
  fwd: <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>,
  search: <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" /></svg>,
  dice: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" /><circle cx="8.2" cy="8.2" r="1.1" fill="currentColor" /><circle cx="15.8" cy="8.2" r="1.1" fill="currentColor" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" /><circle cx="8.2" cy="15.8" r="1.1" fill="currentColor" /><circle cx="15.8" cy="15.8" r="1.1" fill="currentColor" />
    </svg>
  ),
  bin: <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" /></svg>,
  mark: (
    <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5V5a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v8" /><path d="M4 19.5A1.5 1.5 0 0 1 5.5 18H12" /><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H12" />
      <path d="M8 7h6M8 10h4" /><circle cx="17" cy="17" r="3" /><path d="M19.2 19.2L21 21" />
    </svg>
  ),
};

// ── One tab, as the rail and the strip draw it ──
function useTabHandlers(t, go, drag, setDrag, openMenu) {
  return {
    onClick: () => selectTab(t.id, go),
    onAuxClick: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id, go); } },
    onMouseDown: (e) => { if (e.button === 1) e.preventDefault(); },
    onContextMenu: (e) => { e.preventDefault(); openMenu(t.id, e.clientX, e.clientY); },
    draggable: true,
    onDragStart: (e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.id); } catch { /* ignore */ } setDrag({ id: t.id, over: null }); },
    onDragOver: (e) => { e.preventDefault(); if (drag?.over !== t.id) setDrag((d) => (d ? { ...d, over: t.id } : d)); },
    onDrop: (e) => { e.preventDefault(); moveTab(drag?.id, t.id); setDrag(null); },
    onDragEnd: () => setDrag(null),
  };
}

// A tab in the rail — the Playbook presets list's item (.lg-rail-item, the
// Legislation rail's = the app sidebar's .nav-item): two lines, the platform
// and what it shows on top in small capitals, the name under it; × on hover.
// Memoised: a keystroke in the address field changes only the ACTIVE tab (its
// draft), so every other row can skip the render.
const RailTab = React.memo(function RailTab({ t, active, go, drag, setDrag, openMenu }) {
  const m = pageMeta(curPage(t));
  const h = useTabHandlers(t, go, drag, setDrag, openMenu);
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className={`lg-rail-item lgb-rtab${active ? ' is-active' : ''}${drag?.id === t.id ? ' is-dragging' : ''}${drag?.over === t.id && drag?.id !== t.id ? ' is-drop' : ''}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTab(t.id, go); } }}
      {...h}
    >
      <Tooltip content={m.loadedTip || m.tip || `${m.kind} — ${m.title}`}>
        <span className="lg-rail-title">
          <span className="lg-rail-kind lgb-rtab-kind">
            {t.loading ? <span className="lgb-spin" style={{ '--tone': m.tone }} /> : <span className="lgb-dot" style={{ '--tone': m.tone }} />}
            <span className="lgb-rtab-kindtext">{m.kind}</span>
          </span>
          <span className="lg-rail-num">{m.title}</span>
        </span>
      </Tooltip>
      <span className="lg-rail-actions">
        {canReload(t) ? (
          <Tooltip content="Reload — ask the source again (F5)">
            <button type="button" aria-label="Reload tab" disabled={t.loading} onClick={(e) => { e.stopPropagation(); reloadTab(t.id, go, forgetAnswers); }}>{G.reload}</button>
          </Tooltip>
        ) : null}
        {!t.pinned ? (
          <Tooltip content="Close tab (Ctrl+W)">
            <button type="button" aria-label="Close tab" onClick={(e) => { e.stopPropagation(); closeTab(t.id, go); }}>{G.close}</button>
          </Tooltip>
        ) : null}
      </span>
    </div>
  );
});

// The rail's spotlight — the Playbook list's and the app sidebar's: a soft
// accent glow and a border shine following the pointer (the light elements
// lib/pointerSpots injects, moved by a transform). The chase itself is lib/pointerSpots' useRailSpotlight.

function SearchTabButton({ active, go }) {
  const open = () => {
    openSearch(go);
    requestAnimationFrame(() => window.dispatchEvent(new Event('docvex:legal-omni-focus')));
  };
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className={`lg-rail-item lgb-rtab lgb-searchtab${active ? ' is-active' : ''}`}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
    >
      <Tooltip content="Search every platform (Ctrl+T)">
        <span className="lg-rail-title">
          <span className="lg-rail-kind lgb-rtab-kind">
            <span className="lgb-searchtab-ico">{G.search}</span>
            <span className="lgb-rtab-kindtext">Search</span>
          </span>
          <span className="lg-rail-num">Search everything</span>
        </span>
      </Tooltip>
    </div>
  );
}

/** The tabs down the left — the Playbook presets list: its surface, its
 *  head (a label, a hairline under it), pinned first under a divider. */
export function TabRail({ go, openMenu, className = '' }) {
  const s = useBrowser();
  const [drag, setDrag] = useState(null);
  const railRef = useItemSpots('.lg-rail-item', true);
  useRailSpotlight(railRef);
  // The blank search tab is not listed: the Search button stands for it.
  const listed = s.tabs.filter((t) => !isSearchTab(t));
  const pinned = listed.filter((t) => t.pinned);
  const rest = listed.filter((t) => !t.pinned);
  const onSearch = isSearchTab(s.tabs.find((t) => t.id === s.active));
  const item = (t) => <RailTab key={t.id} t={t} active={t.id === s.active} go={go} drag={drag} setDrag={setDrag} openMenu={openMenu} />;
  return (
    <aside className={`lgb-rail${className ? ` ${className}` : ''}`} ref={railRef} aria-label="Open tabs">
      <div className="lgb-rail-head">
        <span className="lgb-rail-label">Open · {listed.length}</span>
        <span className="lgb-rail-headbtns">
          <Tooltip content="History">
            <button type="button" className="lgb-rail-add" aria-label="History" onClick={() => openHistory(go)}>{G.clock}</button>
          </Tooltip>
          {/* THE LIST AND THE SIDEBAR'S DROPDOWN ARE ONE SWITCH: this sends
              the list to the app sidebar (its Legislation dropdown opens,
              and this rail goes); folding the dropdown brings it back. */}
          <Tooltip content="Show these tabs in the app sidebar">
            <button type="button" className="lgb-rail-add" aria-label="Show these tabs in the app sidebar" onClick={() => window.dispatchEvent(new CustomEvent('docvex:legal-list-set', { detail: { open: true } }))}>{G.toSide}</button>
          </Tooltip>
        </span>
      </div>
      <div className="lgb-rail-list" role="tablist" aria-orientation="vertical">
        {/* THE SEARCH TAB — a tab like the others, first in the list: it
            opens the one search (lib/legalBrowser openSearch), never a pile
            of new tabs. */}
        <SearchTabButton active={onSearch} go={go} />
        {listed.length ? <div className="lgb-rail-div" aria-hidden="true" /> : null}
        {pinned.map(item)}
        {pinned.length && rest.length ? <div className="lgb-rail-div" aria-hidden="true" /> : null}
        {rest.map(item)}
        <div className="lgb-rail-end" onDragOver={(e) => { e.preventDefault(); setDrag((d) => (d ? { ...d, over: '__end' } : d)); }} onDrop={(e) => { e.preventDefault(); moveTab(drag?.id, null); setDrag(null); }} />
      </div>
    </aside>
  );
}

/** The tabs along the top, a browser's. */
export function TabStrip({ go, openMenu }) {
  const s = useBrowser();
  const [drag, setDrag] = useState(null);
  return (
    <div className="lgb-strip" role="tablist">
      {/* The Search tab first, as in the rail; the blank tab it stands for
          is not drawn. */}
      <Tooltip content="Search every platform (Ctrl+T)">
        <div role="tab" aria-selected={isSearchTab(s.tabs.find((t) => t.id === s.active))} className={`lgb-stab lgb-searchtab${isSearchTab(s.tabs.find((t) => t.id === s.active)) ? ' is-active' : ''}`} onClick={() => { openSearch(go); requestAnimationFrame(() => window.dispatchEvent(new Event('docvex:legal-omni-focus'))); }}>
          <span className="lgb-searchtab-ico">{G.search}</span>
          <span className="lgb-stab-label">Search</span>
        </div>
      </Tooltip>
      {s.tabs.filter((t) => !isSearchTab(t)).map((t) => <StripTab key={t.id} t={t} active={t.id === s.active} go={go} drag={drag} setDrag={setDrag} openMenu={openMenu} />)}
      <Tooltip content="History">
        <button type="button" className="lgb-icobtn lgb-strip-hist" aria-label="History" onClick={() => openHistory(go)}>{G.clock}</button>
      </Tooltip>
    </div>
  );
}
const StripTab = React.memo(function StripTab({ t, active, go, drag, setDrag, openMenu }) {
  const m = pageMeta(curPage(t));
  const h = useTabHandlers(t, go, drag, setDrag, openMenu);
  return (
    <Tooltip content={m.tip || `${m.kind} — ${m.title}`}>
      <div role="tab" aria-selected={active} className={`lgb-stab${active ? ' is-active' : ''}${t.pinned ? ' is-pinned' : ''}${drag?.over === t.id && drag?.id !== t.id ? ' is-drop' : ''}`} {...h}>
        {t.loading ? <span className="lgb-spin" style={{ '--tone': m.tone }} /> : <span className="lgb-dot" style={{ '--tone': m.tone }} />}
        {!t.pinned ? <span className="lgb-stab-label">{m.strip || m.title}</span> : null}
        {!t.pinned ? <button type="button" className="lgb-stab-close" aria-label="Close tab" onClick={(e) => { e.stopPropagation(); closeTab(t.id, go); }}>{G.close}</button> : null}
      </div>
    </Tooltip>
  );
});

export function openHistory(go) {
  const h = browserState().tabs.find((t) => curPage(t).type === 'history');
  if (h) selectTab(h.id, go); else openInNewTab({ type: 'history' }, go);
}

// ── The tab's menu (right-click) ──
export function TabMenu({ menu, onClose, go }) {
  const s = useBrowser();
  const ref = useRef(null);
  useEffect(() => {
    if (!menu) return undefined;
    const down = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', onClose, true);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key); window.removeEventListener('scroll', onClose, true); };
  }, [menu, onClose]);
  if (!menu) return null;
  const t = s.tabs.find((x) => x.id === menu.id);
  if (!t) return null;
  const others = s.tabs.some((x) => x.id !== t.id && !x.pinned);
  const item = (label, kbd, fn, { disabled = false, danger = false } = {}) => (
    <button type="button" role="menuitem" className={`lgb-menu-item${danger ? ' is-danger' : ''}`} disabled={disabled} onClick={() => { fn(); onClose(); }}>
      <span>{label}</span>{kbd ? <span className="lgb-menu-kbd">{kbd}</span> : null}
    </button>
  );
  return createPortal(
    <div ref={ref} role="menu" className="lgb-menu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 280) }}>
      {item('Search', 'Ctrl+T', () => openSearch(go))}
      {item('Reload', 'F5', () => reloadTab(t.id, go, forgetAnswers), { disabled: !canReload(t) || t.loading })}
      {item('Duplicate', '', () => duplicateTab(t.id))}
      {item(t.pinned ? 'Unpin' : 'Pin', '', () => togglePin(t.id))}
      <div className="lgb-menu-sep" />
      {item('Close', 'Ctrl+W', () => closeTab(t.id, go))}
      {item('Close other tabs', '', () => closeOthers(t.id, go), { disabled: !others })}
      {item('Reopen closed tab', 'Ctrl+Shift+T', () => reopenClosed(0, go), { disabled: !s.closed.length })}
      <div className="lgb-menu-sep" />
      {item(s.layout === 'strip' ? 'Show tabs on the side' : 'Show tabs across the top', '', () => setLayout(s.layout === 'strip' ? 'rail' : 'strip'))}
    </div>,
    document.body,
  );
}

// ── The address row ──
const FIELD_MIN = 240;
const FIELD_PLACEHOLDER = 'An act, a CUI, a court file, a CAEN code — or any words';

// The results' SUMMARY, in line with the field that holds the query (so it
// never repeats the query): under All, the total across the platforms; "read
// as …" only when the words were read as something else. On one platform its
// group's head already gives the count, so nothing but a reading is left.
function SerpSummary({ page }) {
  const scope = page.scope || 'all';
  const { asked, answers } = useSerp(page.q, page.scope, branchOf(page), page.refresh || 0);
  const shown = scope === 'all' ? asked : [scope];
  const n = shown.filter((p) => answers[p] && answers[p] !== 'loading').reduce((k, p) => k + (answers[p].total ?? answers[p].rows.length), 0);
  const d = detectQuery(page.q);
  const readAs = d && d.label.replace(/[“”"]/g, '').trim().toLowerCase() !== page.q.trim().toLowerCase() ? d.label : '';
  const text = [
    scope === 'all' && n ? `${n.toLocaleString('en-US')} ${n === 1 ? 'result' : 'results'} in all` : '',
    readAs ? `read as ${readAs}` : '',
  ].filter(Boolean).join(' · ');
  return text ? <span className="lgb-addr-found">{text}</span> : null;
}

// `bare`: the field alone (the new-tab page's) — no back / forward / reload.
// DocVex · Source — how an open item is shown: restyled by DocVex, or the data
// as the platform's service gave it (the default). lib/legalViewMode.
function ViewModeToggle() {
  const mode = useLegalViewMode();
  return (
    <div className="lgt-toggle lgb-viewmode" role="tablist" aria-label="How an item is shown">
      <Tooltip content="Restyled by DocVex — laid out as a document">
        <button type="button" role="tab" aria-selected={mode === 'docvex'} className={`lgt-toggle-btn${mode === 'docvex' ? ' is-on' : ''}`} onClick={() => setLegalViewMode('docvex')}>DocVex</button>
      </Tooltip>
      <Tooltip content="As the platform's service gave it — the raw data">
        <button type="button" role="tab" aria-selected={mode === 'source'} className={`lgt-toggle-btn${mode === 'source' ? ' is-on' : ''}`} onClick={() => setLegalViewMode('source')}>Source</button>
      </Tooltip>
    </div>
  );
}

export function AddressRow({ go, status, bare = false, extra = null }) {
  const s = useBrowser();
  const tab = s.tabs.find((t) => t.id === s.active) || s.tabs[0];
  const page = curPage(tab);
  const m = pageMeta(page);
  const [focus, setFocus] = useState(false);
  const inputRef = useRef(null);
  const fieldRef = useRef(null);
  const measureRef = useRef(null);
  const value = tab.draft ?? m.addr;
  const typed = tab.draft != null && tab.draft !== m.addr;
  const d = typed ? detectQuery(value) : null;
  const route = d ? (() => {
    const generic = d.source === 'legislation' && d.what === 'words' && !d.params.tip;
    const pl = generic ? null : PLATFORMS[d.source];
    return { site: pl ? pl.site : 'All platforms', label: d.label, tone: pl ? pl.tone : 'var(--accent)', tip: pl ? `Enter searches ${pl.site}` : 'Enter searches every connected platform' };
  })() : null;
  const run = (text, mode) => {
    const r = pageForQuery(text);
    if (!r) return;
    if (mode === 'new') openInNewTab(r.page, go);
    else if (mode === 'bg') openInNewTab(r.page, go, { background: true });
    else navigateActive(r.page, go);
    setDraft(null);
    inputRef.current?.blur();
  };
  // Ctrl/⌘+L (and a focus asked for from elsewhere) puts the caret here.
  useEffect(() => {
    const f = () => { inputRef.current?.focus(); inputRef.current?.select(); };
    window.addEventListener('docvex:legal-omni-focus', f);
    return () => window.removeEventListener('docvex:legal-omni-focus', f);
  }, []);
  const dice = async () => {
    try { const q = await randomQuery(); if (q) { setDraft(q); inputRef.current?.focus(); } } catch { /* nothing drawn */ }
  };
  // THE FIELD IS AS WIDE AS WHAT IT HOLDS — the text typed, or the
  // placeholder while it is empty — measured off a hidden copy, plus the
  // field's own chrome (its glyph, padding and the clear button / key hint),
  // never under FIELD_MIN and never past the room the row has (it shrinks
  // like any flex item). It glides to a new width.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    const input = inputRef.current;
    const measure = measureRef.current;
    if (!field || !input || !measure) return;
    const chrome = field.offsetWidth - input.offsetWidth;
    field.style.width = `${Math.max(FIELD_MIN, Math.ceil(measure.offsetWidth + chrome + 6))}px`;
  }, [value, focus]);
  return (
    <div className={`lgb-addr${bare ? ' is-bare' : ''}`}>
      {bare ? null : (<>
      <ViewModeToggle />
      <Tooltip content="Back (Alt+←)">
        <button type="button" className="lgb-icobtn" aria-label="Back" disabled={tab.idx === 0} onClick={() => stepTab(tab.id, -1, go)}>{G.back}</button>
      </Tooltip>
      <Tooltip content="Forward (Alt+→)">
        <button type="button" className="lgb-icobtn" aria-label="Forward" disabled={tab.idx >= tab.stack.length - 1} onClick={() => stepTab(tab.id, 1, go)}>{G.fwd}</button>
      </Tooltip>
      <Tooltip content="Reload — ask the source again (F5 / Ctrl+R)">
        <button type="button" className={`lgb-icobtn lgb-reload${tab.loading ? ' is-spinning' : ''}`} aria-label="Reload" disabled={!canReload(tab) || tab.loading} onClick={() => reloadTab(tab.id, go, forgetAnswers)}>{G.reload}</button>
      </Tooltip>
      </>)}
      <div className="lgb-omni">
        <Tooltip content="Something random that exists — an act, a company, a court file or a CAEN code">
          <button type="button" className="lgb-dice" aria-label="Draw something random" onClick={dice}>{G.dice}</button>
        </Tooltip>
        <div ref={fieldRef} className={`lgb-field${focus ? ' is-focus' : ''}${value && (focus || typed) ? ' is-lit' : ''}`}>
          <span className="lgb-field-measure" ref={measureRef} aria-hidden="true">{value || FIELD_PLACEHOLDER}</span>
          <span className="lgb-field-ico">{G.search}</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData?.getData('text') || '';
              if (!/\n/.test(text)) return;
              e.preventDefault();
              setDraft(text.replace(/\s*\n\s*/g, ' ').trim());
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); run(e.currentTarget.value, e.ctrlKey || e.metaKey ? 'new' : e.altKey ? 'bg' : 'here'); }
              if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); e.currentTarget.blur(); }
            }}
            onFocus={(e) => { setFocus(true); const el = e.currentTarget; setTimeout(() => el.select(), 0); }}
            onBlur={() => setFocus(false)}
            placeholder={FIELD_PLACEHOLDER}
            aria-label="Search legislation, companies, court files and CAEN codes"
            spellCheck={false}
          />
          {value ? (
            <button type="button" className="lgb-field-clear" aria-label="Clear the search" onClick={() => { setDraft(''); inputRef.current?.focus(); }}>{G.close}</button>
          ) : (
            <span className={`lgt-search-kbd lgb-kbd${focus ? ' is-hidden' : ''}`}><kbd>{isMac ? '⌘' : 'Ctrl'}</kbd><kbd>L</kbd></span>
          )}
        </div>
      </div>
      {page.type === 'serp' && !typed ? <SerpSummary page={page} /> : null}
      {route ? (
        <Tooltip content={route.tip}>
          <button type="button" className="lgb-route" style={{ '--pill-tone': route.tone }} onMouseDown={(e) => e.preventDefault()} onClick={(e) => run(value, e.ctrlKey || e.metaKey ? 'bg' : 'here')}>
            <span className="lgb-route-site">{route.site}</span>
            <span className="lgb-route-label">{route.label}</span>
          </button>
        </Tooltip>
      ) : null}
      <span className="lgb-addr-gap" />
      {status ? <span className="lgb-status">{status}</span> : null}
      {extra ? <span className="lgb-addr-extra">{extra}</span> : null}
    </div>
  );
}

// ── The new-tab page ──
export function NewTabPage() {
  const go = useGo();
  const live = LEGAL_TABS.filter((t) => !t.stub);
  const tryIt = (q) => (e) => {
    const r = pageForQuery(q);
    if (!r) return;
    if (e.ctrlKey || e.metaKey) openInNewTab(r.page, go, { background: true }); else navigateActive(r.page, go);
  };
  return (
    <section className="lgb-newtab">
      <span className="lgb-newtab-mark" aria-hidden="true">{G.mark}</span>
      <h2 className="lgb-newtab-title">One search for all of it</h2>
      <p className="lgb-newtab-sub">
        Type an act (“Legea 31/1990”), a CUI, a court file number, a CAEN code — or just words — in the field
        below. Every connected platform answers at once; Ctrl+click any result to open it in a tab of its own.
      </p>
      {/* THE SEARCH on this screen is the field itself, under the line —
          not the mini header's (which has no address row here), and with no
          back / forward / reload: there is nothing to go back to. */}
      <div className="lgb-newtab-field"><AddressRow go={go} bare /></div>
      <div className="lgb-plats">
        {live.map((t) => {
          const pl = PLATFORMS[t.id];
          return (
            <div key={t.id} className="lgb-plat">
              <span className="lgb-plat-site"><span className="lgb-dot" style={{ '--tone': pl?.tone }} />{t.label}</span>
              <span className="lgb-plat-about">{t.about}</span>
              {t.tries?.length ? (
                <span className="lgb-plat-tries">
                  <span className="lgb-plat-try-label">Try</span>
                  {t.tries.map((q) => <button key={q} type="button" className="lgb-chip" onClick={tryIt(q)}>{q}</button>)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── The results page ──
/** The answers to one search: which platforms were asked, and each one's
 *  answer (or 'loading'). `extra` platforms are asked too (a scope picked). */
export function useSerp(q, scope, branch = 'all', refresh = 0) {
  const asked = useMemo(() => {
    const base = platformsFor(q);
    return scope && scope !== 'all' && !base.includes(scope) ? [...base, scope] : base;
  }, [q, scope]);
  // The answers are READ from lib/legalSearch (what has arrived is there
  // synchronously), so a results page shown again paints on its first frame
  // with no "searching" pass; `tick` re-reads when one arrives. `refresh`
  // on the page (a Reload) asks again.
  const [tick, bump] = useReducer((x) => x + 1, 0);
  const run = useMemo(() => (scope && scope !== 'all' ? [scope] : asked), [scope, asked]);
  useEffect(() => {
    let live = true;
    const done = () => { if (live) bump(); };
    run.forEach((p) => {
      const a = peekAnswer(p, q);
      if (!a || !a.ok) searchPlatform(p, q).then(done);
    });
    // Platforms already on their way are shown too, whatever the scope.
    asked.forEach((p) => {
      if (run.includes(p) || peekAnswer(p, q)) return;
      peekPlatform(p, q)?.then(done);
    });
    return () => { live = false; };
  }, [q, run, asked, refresh]);
  const answers = useMemo(() => {
    const out = {};
    asked.forEach((p) => {
      const a = peekAnswer(p, q);
      if (a) out[p] = a;
      else if (run.includes(p) || peekPlatform(p, q)) out[p] = 'loading';
    });
    return out;
  }, [q, asked, run, tick, refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  // Narrowed to the branch of law picked (the second switch), so the rows,
  // the counts and the platforms' tooltips all agree.
  const narrowed = useMemo(() => {
    if (!branch || branch === 'all') return answers;
    const out = {};
    for (const [p, a] of Object.entries(answers)) out[p] = inBranch(a, branch, scope || 'all');
    return out;
  }, [answers, branch, scope]);
  return { asked, answers: narrowed };
}

/** The branch of law picked for the platform choice on show — each choice
 *  (All, and every platform) keeps its own; one not set yet is All. */
// Under All there is no second switch (Penal · Civil · Other were removed
// there), so All never narrows.
export const branchOf = (page) => ((page.scope || 'all') === 'all' ? 'all' : page.branches?.[page.scope] || 'all');

export function SerpScopes({ page }) {
  const { asked, answers } = useSerp(page.q, page.scope, 'all', page.refresh || 0);
  const scope = page.scope || 'all';
  const count = (p) => (answers[p] && answers[p] !== 'loading' ? answers[p].total ?? answers[p].rows.length : null);
  const total = asked.reduce((n, p) => n + (count(p) || 0), 0);
  // Each platform is named by its SOURCE ADDRESS (legislatie.just.ro,
  // portal.just.ro…) — the tabs and the masthead name it the same way; what
  // it holds is in its tooltip.
  const scopes = [{ id: 'all', label: 'All', n: total }, ...PLATFORM_ORDER.map((p) => ({ id: p, label: PLATFORMS[p].site, name: PLATFORMS[p].name, n: count(p) }))];
  // The Design system's Segmented choice (components/RuleOptions — the
  // Playbook's and the Import window's switch, its pill sliding to the
  // choice); the counts are in each segment's tooltip only.
  const field = {
    label: 'Platforms',
    options: scopes.map((x) => ({
      id: x.id,
      label: x.label,
      example: x.n == null ? `${x.name || x.label} — searching…` : `${x.name || x.label} — ${x.n} ${x.n === 1 ? 'result' : 'results'}`,
      // A platform (or All) that answered NOTHING is faded — once it has
      // answered; one still searching is not.
      empty: x.n === 0,
    })),
  };
  // The pill takes the chosen platform's own colour (its dot's, in the tabs
  // and the results); All keeps the accent.
  const tone = scope === 'all' ? 'var(--accent)' : PLATFORMS[scope]?.tone || 'var(--accent)';
  // THE SECOND SWITCH, to its right: its choices are what the PLATFORM PICKED
  // is about (lib/legalSearch's FACETS) — under All the branch of law, on a
  // platform its own kinds (acts by kind, court files by subject matter,
  // companies by fiscal standing, CAEN codes by level); each platform choice
  // keeps its own pick. Colour-coded the same way.
  const facets = facetsFor(scope);
  const inScope = scope === 'all' ? asked : [scope];
  const settled = inScope.every((p) => answers[p] && answers[p] !== 'loading');
  const facetCount = (f) => (settled
    ? inScope.reduce((n, p) => n + (answers[p]?.ok ? answers[p].rows.filter((r) => f.test(r)).length : 0), 0)
    : null);
  const branch = facets.some((f) => f.id === branchOf(page)) ? branchOf(page) : 'all';
  const branchField = {
    label: scope === 'all' ? 'Branch of law' : `Narrow ${PLATFORMS[scope]?.site || ''}`,
    // A facet with NO results among what the platform choice answered is
    // faded (counted once every platform in the choice has answered).
    options: facets.map((f) => {
      const n = facetCount(f);
      return { id: f.id, label: f.label, example: n == null ? f.tip : `${f.tip} — ${n} ${n === 1 ? 'result' : 'results'}`, empty: n === 0 };
    }),
  };
  const branchTone = facets.find((f) => f.id === branch)?.tone || 'var(--accent)';
  return (
    <>
      <div className="lgb-scopes-tone" style={{ '--scope-tone': tone }}>
        <RuleOptions field={field} value={scope} onPick={(id) => replaceActive({ ...page, scope: id })} className="lgb-scopes" />
      </div>
      {/* Not under All: the second switch belongs to a platform. */}
      {scope !== 'all' ? (
        <div className="lgb-scopes-tone" style={{ '--scope-tone': branchTone }}>
          <RuleOptions field={branchField} value={branch} onPick={(id) => replaceActive({ ...page, branches: { ...(page.branches || {}), [scope]: id } })} className="lgb-scopes" />
        </div>
      ) : null}
    </>
  );
}

export function SerpPage({ page, tabId }) {
  const go = useGo();
  const { asked, answers } = useSerp(page.q, page.scope, branchOf(page), page.refresh || 0);
  const scope = page.scope || 'all';
  const busy = (scope === 'all' ? asked : [scope]).some((p) => !answers[p] || answers[p] === 'loading');
  useEffect(() => { setTabLoading(tabId, busy); }, [tabId, busy]);
  useEffect(() => () => setTabLoading(tabId, false), [tabId]);
  const shown = scope === 'all' ? asked : [scope];
  const done = shown.filter((p) => answers[p] && answers[p] !== 'loading');
  const n = done.reduce((k, p) => k + (answers[p].total ?? answers[p].rows.length), 0);
  const d = detectQuery(page.q);
  const visible = shown.filter((p) => {
    const a = answers[p];
    return !(scope === 'all' && a && a !== 'loading' && a.ok && !a.rows.length);
  });
  return (
    <div className="lgb-serp">
      {/* Every platform answered nothing under All: the groups are hidden,
          so this is the one line that says so. */}
      {!visible.length && !busy ? <p className="lgb-serp-found">Nothing matches “{page.q}” on any connected platform.</p> : null}
      {visible.map((p) => {
        const a = answers[p];
        const pl = PLATFORMS[p];
        const lim = scope === 'all' ? 3 : 999;
        return (
          <section key={p} className="lgb-group">
            <div className="lgb-group-head">
              <span className="lgb-group-dot" style={{ '--tone': pl.tone }} />
              <span className="lgb-group-name">{pl.name}</span>
              <span className="lgb-group-meta">
                {pl.site} · {!a || a === 'loading' ? 'searching…' : a.ok ? `${a.total ?? a.rows.length} ${(a.total ?? a.rows.length) === 1 ? 'result' : 'results'}` : 'did not answer'}
              </span>
              {a && a !== 'loading' && a.source === 'archive' ? (
                <span className="lgb-pill" style={{ '--pill-tone': 'var(--warning)' }}><span className="lgb-pill-dot" />From your copy on this machine — the portal did not answer</span>
              ) : null}
              {a && a !== 'loading' && a.note ? <span className="lgb-group-note">{a.note}</span> : null}
              {a && a !== 'loading' && a.rows.length > lim ? (
                <button type="button" className="lgb-tool" onClick={() => replaceActive({ ...page, scope: p })}>Show all {a.rows.length} →</button>
              ) : null}
            </div>
            {a && a !== 'loading' && !a.ok ? <p className="lgb-empty">{pl.site} could not be reached{a.error ? ` (${a.error})` : ''}.</p> : null}
            {a && a !== 'loading' && a.ok && !a.rows.length ? <p className="lgb-empty">Nothing on {pl.site} matches “{page.q}”.</p> : null}
            {a && a !== 'loading' && a.rows.length ? (
              <ul className="lgb-rows">
                {a.rows.slice(0, lim).map((r, i) => <ResultRow key={`${p}${i}`} r={r} go={go} />)}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function ResultRow({ r, go }) {
  const pl = PLATFORMS[r.platform];
  const lp = linkProps(r.page, go);
  return (
    <li className="lgb-row">
      <Tooltip content="Open · Ctrl+click opens in a new tab">
        <button type="button" className="lgb-row-main" {...lp}>
          <span className="lgb-row-kind" style={{ color: pl?.tone }}>{r.kind}</span>
          <span className="lgb-row-title">{r.title}</span>
          {r.meta.length || r.tags.length ? (
            <span className="lgb-row-meta">
              {r.meta.map((m) => <span key={m}>{m}</span>)}
              {r.tags.map((t) => <span key={t.label} className="lgb-pill" style={{ '--pill-tone': t.tone }}>{t.label}</span>)}
            </span>
          ) : null}
        </button>
      </Tooltip>
      <Tooltip content="Open in a new tab">
        <button type="button" className="lgb-row-new" aria-label="Open in a new tab" onClick={(e) => { e.stopPropagation(); openInNewTab(r.page, go, { background: !e.shiftKey }); }}>{G.plus}</button>
      </Tooltip>
    </li>
  );
}

// ── History ──
const dayLabel = (iso) => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const fmt = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (d.toDateString() === today.toDateString()) return `Today — ${fmt}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday — ${fmt}`;
  return fmt;
};
export function HistoryPage() {
  const go = useGo();
  // The history alone: the address row above it changes the store on every
  // keystroke, and the whole list used to be rebuilt for each one.
  const hist = useSyncExternalStore(subscribeBrowser, histOf);
  const days = [];
  for (const h of hist) {
    const label = dayLabel(h.at);
    const last = days[days.length - 1];
    if (last?.label === label) last.items.push(h); else days.push({ label, items: [h] });
  }
  return (
    <section className="lgb-hist">
      <h2 className="lgb-hist-title">History</h2>
      <p className="lgb-hist-sub">Every search run and everything opened, in every tab. Press one to open it here; Ctrl+click for a new tab.</p>
      {!hist.length ? <p className="lgb-empty">Nothing yet. Every search you run and everything you open is listed here.</p> : null}
      {days.map((dg) => (
        <React.Fragment key={dg.label}>
          <p className="lgb-hist-day">{dg.label}</p>
          <ul className="lgb-hist-list">
            {dg.items.map((h) => {
              const m = pageMeta(h.page);
              const lp = linkProps({ ...h.page }, go);
              const t = new Date(h.at);
              return (
                <li key={h.id}>
                  <button type="button" className="lgb-hist-row" {...lp}>
                    <span className="lgb-hist-time">{`${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`}</span>
                    <span className="lgb-dot" style={{ '--tone': m.tone }} />
                    <span className="lgb-hist-kind">{m.kind}</span>
                    <span className="lgb-hist-name">{m.title}</span>
                    <span className="lgb-hist-site">{m.site}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </React.Fragment>
      ))}
    </section>
  );
}

export function ClearHistoryButton() {
  return (
    <Tooltip content="Forget every visit">
      <button type="button" className="lgb-tool is-danger" onClick={clearHistory}>{G.bin}<span>Clear history</span></button>
    </Tooltip>
  );
}

// ── Keyboard ──
/** A browser's shortcuts, while the Legislation tab is on screen. */
export function useBrowserKeys(go) {
  const goRef = useRef(go);
  goRef.current = go;
  const onKey = useCallback((e) => {
    const g = goRef.current;
    const s = browserState();
    const mod = e.ctrlKey || e.metaKey;
    const k = (e.key || '').toLowerCase();
    if (mod && e.shiftKey && k === 't') { e.preventDefault(); reopenClosed(0, g); return; }
    if (mod && !e.shiftKey && k === 't') { e.preventDefault(); openSearch(g); requestAnimationFrame(() => window.dispatchEvent(new Event('docvex:legal-omni-focus'))); return; }
    if (mod && k === 'w') { e.preventDefault(); closeTab(s.active, g); return; }
    if (e.key === 'F5' || (mod && !e.shiftKey && k === 'r')) { e.preventDefault(); reloadTab(s.active, g, forgetAnswers); return; }
    if (mod && k === 'l') { e.preventDefault(); window.dispatchEvent(new Event('docvex:legal-omni-focus')); return; }
    if (mod && e.key === 'Tab') {
      e.preventDefault();
      const i = s.tabs.findIndex((t) => t.id === s.active);
      const n = s.tabs[(i + (e.shiftKey ? -1 : 1) + s.tabs.length) % s.tabs.length];
      selectTab(n.id, g);
      return;
    }
    if (mod && /^[1-9]$/.test(e.key)) {
      const n = e.key === '9' ? s.tabs[s.tabs.length - 1] : s.tabs[Number(e.key) - 1];
      if (n) { e.preventDefault(); selectTab(n.id, g); }
      return;
    }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); stepTab(s.active, -1, g); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); stepTab(s.active, 1, g); }
  }, []);
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);
}
