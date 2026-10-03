import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import Tooltip from './Tooltip';
import { useItemSpots } from './DocRibbon';
import { useRailSpotlight } from '../lib/pointerSpots';
import { researchStore } from '../lib/researchChats';
import { subscribeRunner, runnerState, isThreadBusy } from '../lib/researchRunner';
import { isBlankChat } from '../lib/advisorChats';
import { isSourceEntry, isEntryActive, openEntry, closeEntry, subscribeWorkspaces, workspacesSnapshot } from '../lib/legislationEntries';
import { ICONS as I } from '../pages/Projects/aiHub';
import { RailToggle } from './LegalTabs';

// THE ONE SIDEBAR of the Legislation entry (2026-10-03): the Ask tab's chat
// list — New research, the chats as tabs (drag, right-click menu, a spinner
// on a chat at work, × close), then what each source has open — drawn the
// same on EVERY tab. Research renders it beside its thread; LegalWorkspace
// beside every source page, where opening a chat goes to Ask (`onOpenChat`).
// Width and resize are the caller's (shared key `docvex.research.railWidth`).

export const ASK_RAIL_WIDTH_KEY = 'docvex.research.railWidth';
export const ASK_RAIL_MIN = 168;
export const ASK_RAIL_MAX = 384;
export const ASK_RAIL_DEFAULT = 216;
export const readAskRailWidth = () => {
  try {
    const n = Number(localStorage.getItem(ASK_RAIL_WIDTH_KEY));
    return Number.isFinite(n) && n >= ASK_RAIL_MIN && n <= ASK_RAIL_MAX ? n : ASK_RAIL_DEFAULT;
  } catch { return ASK_RAIL_DEFAULT; }
};

// SHOWN OR HIDDEN — one setting for every tab of the entry (Ask and each
// source), with the toggle on every tab's second line, under the tab bar's
// underline. ONE SWITCH with the app sidebar's Research dropdown: hiding the
// list here hands it to the sidebar (its dropdown opens); showing it takes it
// back. The list is also off while the sidebar is listing it.
const RAIL_HIDDEN_KEY = 'docvex.research.railHidden';
const HIDDEN_EVENT = 'docvex:askrail-hidden';
const readHidden = () => { try { return localStorage.getItem(RAIL_HIDDEN_KEY) === '1'; } catch { return false; } };
const readSidebarLists = () => window.__docvexResearchListed === true && window.__docvexSidebarCollapsed !== true;
function setHidden(v) {
  try { localStorage.setItem(RAIL_HIDDEN_KEY, v ? '1' : '0'); } catch { /* quota */ }
  window.dispatchEvent(new Event(HIDDEN_EVENT));
}
/** `{ hidden, sidebarLists, off }` — off = not drawn on the page. */
export function useAskRailState() {
  const [hidden, setH] = useState(readHidden);
  const [sidebarLists, setS] = useState(readSidebarLists);
  useEffect(() => {
    const readH = () => setH(readHidden());
    const readS = () => setS(readSidebarLists());
    window.addEventListener(HIDDEN_EVENT, readH);
    window.addEventListener('docvex:research-listed', readS);
    window.addEventListener('docvex:sidebar-state', readS);
    readH(); readS();
    return () => {
      window.removeEventListener(HIDDEN_EVENT, readH);
      window.removeEventListener('docvex:research-listed', readS);
      window.removeEventListener('docvex:sidebar-state', readS);
    };
  }, []);
  return { hidden, sidebarLists, off: hidden || sidebarLists };
}
/** The show / hide button (components/LegalTabs RailToggle) for the list. */
export function AskRailToggle() {
  const { hidden, off } = useAskRailState();
  return (
    <RailToggle
      shown={!off}
      what="chats"
      onToggle={() => {
        if (!off) {
          setHidden(true);
          window.dispatchEvent(new CustomEvent('docvex:research-list-set', { detail: { open: true } }));
          return;
        }
        if (hidden) setHidden(false);
        window.dispatchEvent(new CustomEvent('docvex:research-list-set', { detail: { open: false } }));
      }}
    />
  );
}

function highlightMatch(text, q) {
  const t = String(text || '');
  if (!q) return t;
  const i = t.toLowerCase().indexOf(q);
  if (i === -1) return t;
  return <>{t.slice(0, i)}<mark>{t.slice(i, i + q.length)}</mark>{t.slice(i + q.length)}</>;
}

/**
 * @param {object} p
 * @param {React.MutableRefObject} [p.railRef] also given the <aside>
 * @param {boolean} [p.askOn] the Ask tab is on show (its chat is marked)
 * @param {string|null} p.activeId the chat on show
 * @param {() => void} p.onNew New research
 * @param {(id: string) => void} [p.onOpenChat] after a chat is selected
 * @param {string} [p.searchQ] narrows the chats (lower-cased)
 * @param {string} [p.searchText] the search as typed (the no-results line)
 */
export default function AskRail({ railRef, askOn = false, activeId = null, onNew, onOpenChat, searchQ = '', searchText = '', className = '', style, hidden = false }) {
  const chats = useSyncExternalStore(researchStore.subscribe, researchStore.getState);
  const runner = useSyncExternalStore(subscribeRunner, runnerState);
  const lists = useSyncExternalStore(subscribeWorkspaces, workspacesSnapshot);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [chatDrag, setChatDrag] = useState(null);
  const [chatMenu, setChatMenu] = useState(null); // { id, x, y }

  const spotRef = useItemSpots('.lg-rail-item', true);
  useRailSpotlight(spotRef);
  const setRef = (n) => { spotRef.current = n; if (railRef) railRef.current = n; };

  const threads = chats.threads || [];
  const listed = threads.filter((t) => !isBlankChat(t));
  const titleOf = (t) => String(t.source?.title || t.title || '');
  const visible = searchQ ? listed.filter((t) => titleOf(t).toLowerCase().includes(searchQ) || String(t.source?.kind || '').toLowerCase().includes(searchQ)) : listed;
  const activeThread = threads.find((t) => t.id === activeId) || null;
  const blankOn = askOn && (!activeThread || isBlankChat(activeThread));
  // A chat opens on Ask; an item a source tab opened opens on that tab.
  const open = (id) => {
    const t = threads.find((x) => x.id === id);
    if (isSourceEntry(t)) { openEntry(t, navigate, pathname); return; }
    researchStore.select(id);
    onOpenChat?.(id);
  };
  const closeOne = (t) => (isSourceEntry(t) ? closeEntry(t) : researchStore.close(t.id));

  const tabEl = (t) => {
    const tBusy = isThreadBusy(runner, t.id);
    const m = researchStore.meta(t, { busy: tBusy });
    const src = isSourceEntry(t);
    const on = src ? isEntryActive(t, pathname, lists) : askOn && t.id === activeId;
    return (
      <div
        key={t.id}
        role="tab"
        aria-selected={on}
        tabIndex={0}
        className={`lg-rail-item lgb-rtab${on ? ' is-active' : ''}${chatDrag?.id === t.id ? ' is-dragging' : ''}${chatDrag?.over === t.id && chatDrag?.id !== t.id ? ' is-drop' : ''}`}
        onClick={() => open(t.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(t.id); } }}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeOne(t); } }}
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
        onContextMenu={(e) => { e.preventDefault(); setChatMenu({ id: t.id, x: e.clientX, y: e.clientY }); }}
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.id); } catch { /* ignore */ } setChatDrag({ id: t.id, over: null }); }}
        onDragOver={(e) => { e.preventDefault(); if (chatDrag?.over !== t.id) setChatDrag((d) => (d ? { ...d, over: t.id } : d)); }}
        onDrop={(e) => { e.preventDefault(); researchStore.move(chatDrag?.id, t.id); setChatDrag(null); }}
        onDragEnd={() => setChatDrag(null)}
      >
        <Tooltip content={src ? (t.source.tip || titleOf(t)) : t.title}>
          <span className="lg-rail-title">
            <span className="lg-rail-kind lgb-rtab-kind">
              {tBusy ? <span className="lgb-spin" style={{ '--tone': m.tone }} /> : <span className="lgb-dot" style={{ '--tone': m.tone }} />}
              <span className="lgb-rtab-kindtext">{m.kind}</span>
            </span>
            <span className="lg-rail-num">{highlightMatch(src ? titleOf(t) : t.title, searchQ)}</span>
          </span>
        </Tooltip>
        <span className="lg-rail-actions">
          {!t.pinned ? (
            <Tooltip content={src ? 'Close' : 'Close chat'}>
              <button type="button" aria-label={src ? 'Close' : 'Close chat'} onClick={(e) => { e.stopPropagation(); closeOne(t); }}>{I.x({ width: 12, height: 12 })}</button>
            </Tooltip>
          ) : null}
        </span>
      </div>
    );
  };

  // A chat's right-click menu — the Legislation tabs' .lgb-menu.
  const menuEl = (() => {
    if (!chatMenu) return null;
    const t = threads.find((x) => x.id === chatMenu.id);
    if (!t) return null;
    const close = () => setChatMenu(null);
    const others = threads.some((x) => x.id !== t.id && !x.pinned && !isBlankChat(x));
    const item = (label, kbd, fn, { disabled = false } = {}) => (
      <button type="button" role="menuitem" className="lgb-menu-item" disabled={disabled} onClick={() => { fn(); close(); }}>
        <span>{label}</span>{kbd ? <span className="lgb-menu-kbd">{kbd}</span> : null}
      </button>
    );
    return createPortal(
      <>
        <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onMouseDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
        <div role="menu" className="lgb-menu" style={{ left: Math.min(chatMenu.x, window.innerWidth - 240), top: Math.min(chatMenu.y, window.innerHeight - 240), zIndex: 9999 }}>
          {item('New research', 'Ctrl+T', onNew)}
          {item(t.pinned ? 'Unpin' : 'Pin', '', () => researchStore.togglePin(t.id))}
          <div className="lgb-menu-sep" />
          {item('Close', 'Ctrl+W', () => closeOne(t))}
          {item('Close other chats', '', () => researchStore.closeOthers(t.id), { disabled: !others })}
          {item('Reopen closed chat', 'Ctrl+Shift+T', () => researchStore.reopenClosed(), { disabled: !researchStore.getState().closed.length })}
        </div>
      </>,
      document.body,
    );
  })();

  const pinned = visible.filter((t) => t.pinned);
  const rest = visible.filter((t) => !t.pinned);

  return (
    <aside
      ref={setRef}
      className={`aichat-rail is-tabrail${className ? ` ${className}` : ''}`}
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
      style={style}
      aria-label="Legislation"
    >
      {menuEl}
      <div className="lgb-rail-head">
        <span className="lgb-rail-label">Open · {listed.length}</span>
        <span className="lgb-rail-headbtns">
          <Tooltip content="Show these chats in the app sidebar">
            <button type="button" className="lgb-rail-add" aria-label="Show these chats in the app sidebar" onClick={() => window.dispatchEvent(new CustomEvent('docvex:research-list-set', { detail: { open: true } }))}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d="m15 10-2 2 2 2" /></svg>
            </button>
          </Tooltip>
        </span>
      </div>
      <div className="lgb-rail-list" role="tablist" aria-orientation="vertical">
        <div
          role="tab"
          aria-selected={blankOn}
          tabIndex={0}
          className={`lg-rail-item lgb-rtab lgb-searchtab${blankOn ? ' is-active' : ''}`}
          onClick={onNew}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNew(); } }}
        >
          <Tooltip content="New research">
            <span className="lg-rail-title">
              <span className="lg-rail-kind lgb-rtab-kind">
                <span className="lgb-searchtab-ico">{I.plus({ width: 11, height: 11 })}</span>
                <span className="lgb-rtab-kindtext">New research</span>
              </span>
              <span className="lg-rail-num">The law and your case</span>
            </span>
          </Tooltip>
        </div>
        {visible.length ? <div className="lgb-rail-div" aria-hidden="true" /> : null}
        {pinned.map(tabEl)}
        {pinned.length && rest.length ? <div className="lgb-rail-div" aria-hidden="true" /> : null}
        {rest.map(tabEl)}
        {searchQ && !visible.length ? <div className="aichat-rail-noresults">Nothing matches “{searchText}”.</div> : null}
        <div className="lgb-rail-end" onDragOver={(e) => { e.preventDefault(); setChatDrag((d) => (d ? { ...d, over: '__end' } : d)); }} onDrop={(e) => { e.preventDefault(); researchStore.move(chatDrag?.id, null); setChatDrag(null); }} />
      </div>
    </aside>
  );
}
