import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import Tooltip from './Tooltip';
import { DiceGlyph, LEGAL_TABS } from './LegalTabs';
import { detectQuery, randomQuery } from '../lib/legalOmni';
import './LegalOmnibox.css';

// THE ONE SEARCH of the Legislation tab — its address bar. Whatever is typed
// is read (lib/legalOmni: an act, a court file, a CUI, a CAEN code, or words)
// and, on Enter, the platform that answers it is opened with the query in its
// route; the pill at the field's end says where it will go before it goes. The
// dice sits at its left and writes something that exists into it. What is
// typed is kept module-level, so it survives moving between the platforms'
// pages (each mounts its own copy of the bar). Ctrl/⌘+L focuses it, as a
// browser's address bar; Ctrl/⌘+F stays the open act's find.

let text = '';
const listeners = new Set();
const setText = (v) => { text = v; listeners.forEach((fn) => fn()); };
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const read = () => text;

// Whether a start screen is showing the search (WorkspaceSearch): while one
// is, the bar's line leaves its copy out, so there is one search on screen.
let starts = 0;
const startListeners = new Set();
const emitStarts = () => startListeners.forEach((fn) => fn());
export function useStartScreenSearch() {
  // A layout effect: the bar's row is dropped before the start screen paints.
  useLayoutEffect(() => { starts += 1; emitStarts(); return () => { starts -= 1; emitStarts(); }; }, []);
}
export const useSearchOnStart = () => useSyncExternalStore(
  (fn) => { startListeners.add(fn); return () => startListeners.delete(fn); },
  () => starts > 0,
);

// Which of the tab's two views is on show — Search or History — kept here
// (module-level) so it survives moving between the platforms' pages, and set
// back to Search by anything that searches or opens.
let view = 'search';
const viewListeners = new Set();
export const setLegalView = (v) => { if (view === v) return; view = v; viewListeners.forEach((fn) => fn()); };
export const useLegalView = () => useSyncExternalStore(
  (fn) => { viewListeners.add(fn); return () => viewListeners.delete(fn); },
  () => view,
);

// SEARCH TABS — what the rail's + makes: an item in the open list that shows
// the search, like a browser's new tab. Kept here (module-level) so they
// survive moving between the platforms' pages. The active one is titled by
// what is run from it, and it gives way to what it opens (as a browser tab
// navigates): LegalWorkspace drops it when an item opens from it.
let searchTabs = { list: [], active: null };
let tabSeq = 0;
const tabListeners = new Set();
const setTabs = (next) => { searchTabs = next; tabListeners.forEach((fn) => fn()); };
export const useSearchTabs = () => useSyncExternalStore(
  (fn) => { tabListeners.add(fn); return () => tabListeners.delete(fn); },
  () => searchTabs,
);
export function addSearchTab() {
  // Only ONE new search at a time: a blank one already there is selected.
  const blank = searchTabs.list.find((t) => !t.route);
  if (blank) { setTabs({ ...searchTabs, active: blank.id }); setText(''); return blank.id; }
  const id = `s${++tabSeq}`;
  setTabs({ list: [...searchTabs.list, { id, title: '' }], active: id });
  setText('');
  return id;
}
export const selectSearchTab = (id) => setTabs({ ...searchTabs, active: id });
export const leaveSearchTabs = () => { if (searchTabs.active) setTabs({ ...searchTabs, active: null }); };
export function closeSearchTab(id) {
  setTabs({ list: searchTabs.list.filter((t) => t.id !== id), active: searchTabs.active === id ? null : searchTabs.active });
}
// A query run from the active search tab: the tab takes its name and the
// platform that answered it (`route`), so picking it again goes back there.
const titleActiveTab = (q, route) => {
  if (!searchTabs.active) return;
  setTabs({ ...searchTabs, list: searchTabs.list.map((t) => (t.id === searchTabs.active ? { ...t, title: q, route } : t)) });
};

// PER-TAB SETTINGS — a platform's filters (CAEN's View and Revision, the
// in-tab find…) belong to the TAB they were set in, not to the whole page:
// kept here by tab key (`tabKeyFor`) and name, module-level so they survive
// moving between the platforms' pages. A tab that never set one reads the
// default.
const tabSettings = new Map();
const settingListeners = new Set();
let settingsTick = 0;
export function useTabSetting(tabKey, name, fallback) {
  useSyncExternalStore(
    (fn) => { settingListeners.add(fn); return () => settingListeners.delete(fn); },
    () => settingsTick,
  );
  const k = `${tabKey}::${name}`;
  const value = tabSettings.has(k) ? tabSettings.get(k) : fallback;
  const set = (v) => { tabSettings.set(k, v); settingsTick += 1; settingListeners.forEach((fn) => fn()); };
  return [value, set];
}
/** Which tab a platform's page is showing: its open item, else the search
 *  tab selected in the list, else the platform's own search view. */
export const tabKeyFor = (route, activeId) => (activeId != null
  ? `${route}|${activeId}`
  : searchTabs.active ? `search|${searchTabs.active}` : `${route}|home`);

const FOCUS_EVENT = 'docvex:legal-omni-focus';
/** Put the cursor in the search (the rail's +). */
export const focusOmnibox = () => window.dispatchEvent(new Event(FOCUS_EVENT));

/** Run a query: the platform that answers it opens with it. */
export function useOmniRun() {
  const navigate = useNavigate();
  return (q) => {
    const d = detectQuery(q);
    if (!d) return false;
    setText(q);
    setLegalView('search');
    titleActiveTab(q, d.to.split('?')[0]);
    navigate(d.to);
    return true;
  };
}

const SearchGlyph = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
  </svg>
);
const CloseGlyph = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

export default function LegalOmnibox({ large = false }) {
  const value = useSyncExternalStore(subscribe, read);
  const run = useOmniRun();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const detected = detectQuery(value);

  useEffect(() => {
    const focus = () => { inputRef.current?.focus(); inputRef.current?.select(); };
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'l') { e.preventDefault(); focus(); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(FOCUS_EVENT, focus);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(FOCUS_EVENT, focus); };
  }, []);

  const dice = async () => {
    setBusy(true); setNote('');
    const q = await randomQuery();
    setBusy(false);
    if (!q) { setNote('Nothing could be drawn — the platforms did not answer.'); return; }
    setText(q);
    inputRef.current?.focus();
  };

  return (
    <div className={`lgo${large ? ' is-large' : ''}`}>
      <Tooltip content="Something random that exists — an act, a company, a court file or a CAEN code">
        <button type="button" className="lgt-dice lgo-dice" aria-label="Draw something random" disabled={busy} onClick={dice}>
          {DiceGlyph}
        </button>
      </Tooltip>
      <div className={`lgt-search lgo-field${value ? ' is-active' : ''}`}>
        <span className="lgt-search-glyph">{SearchGlyph}</span>
        <input
          ref={inputRef}
          value={value}
          placeholder="An act, a CUI, a court file, a CAEN code — or any words"
          aria-label="Search legislation, companies, court files and CAEN codes"
          onChange={(e) => { setText(e.target.value); setNote(''); }}
          onPaste={(e) => {
            // A pasted list of CUIs arrives one per line: kept on one.
            const t = e.clipboardData?.getData('text') || '';
            if (!/\n/.test(t)) return;
            e.preventDefault();
            setText(`${value}${t.replace(/\s*\n\s*/g, ' ').trim()}`);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (run(value)) e.currentTarget.blur(); }
            if (e.key === 'Escape' && value) { e.stopPropagation(); setText(''); }
          }}
        />
        {value ? (
          <button type="button" className="lgt-search-clear" aria-label="Clear the search" onClick={() => { setText(''); inputRef.current?.focus(); }}>{CloseGlyph}</button>
        ) : (
          <span className="lgt-search-kbd"><kbd>{isMac ? '⌘' : 'Ctrl'}</kbd><kbd>L</kbd></span>
        )}
      </div>
      {/* Where Enter will go — OUTSIDE the field, beside it. */}
      {note ? <span className="lgo-note">{note}</span> : detected ? (
          // Where Enter will take it, said before it goes.
          <Tooltip content={`Enter searches ${detected.site}`}>
            <button type="button" className={`lgo-route is-${detected.source}`} onClick={() => run(value)}>
              <span className="lgo-route-site">{detected.site}</span>
              <span className="lgo-route-what">{detected.label}</span>
            </button>
          </Tooltip>
        ) : null}
    </div>
  );
}

// ── The header's "i": every platform the search reaches ────────────────────
const InfoGlyph = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><path d="M12 7.6h.01" strokeWidth="2.6" />
  </svg>
);

/** An "i" that opens a small card of facts under itself — the platforms
 *  button's own recipe (`.lgo-info` + `.lgo-pop`), for any content. Closed
 *  by a press elsewhere, Escape, a scroll or a resize. */
export function InfoButton({ label, title = null, width = 300, children }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(width, window.innerWidth - 24);
    setPos({ top: r.bottom + 6, left: Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12)), width: w });
  }, [open, width]);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (!popRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    const scroll = (e) => { if (!popRef.current?.contains(e.target)) setOpen(false); };
    const resize = () => setOpen(false);
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  return (
    <>
      <Tooltip content={label}>
        <button ref={btnRef} type="button" className={`lgo-info${open ? ' is-open' : ''}`} aria-label={label} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {InfoGlyph}
        </button>
      </Tooltip>
      {open && pos ? createPortal(
        <div ref={popRef} className="lgo-pop" role="dialog" aria-label={label} style={{ top: pos.top, left: pos.left, width: pos.width }}>
          {title ? <p className="lgo-pop-head">{title}</p> : null}
          {children}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export function PlatformsButton() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(460, window.innerWidth - 24);
    setPos({ top: r.bottom + 6, left: Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12)), width: w });
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    const scroll = (e) => { if (!popRef.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    const resize = () => setOpen(false);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);

  const live = LEGAL_TABS.filter((t) => !t.stub);
  const later = LEGAL_TABS.filter((t) => t.stub);

  return (
    <>
      <Tooltip content="The platforms this search reaches">
        <button
          ref={btnRef}
          type="button"
          className={`lgo-info${open ? ' is-open' : ''}`}
          aria-label="The platforms this search reaches"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {InfoGlyph}
        </button>
      </Tooltip>
      {open && pos ? createPortal(
        <div ref={popRef} className="lgo-pop" role="dialog" aria-label="Platforms" style={{ top: pos.top, left: pos.left, width: pos.width }}>
          <p className="lgo-pop-head">Searched from here</p>
          <ul className="lgo-pop-list">
            {live.map((t) => (
              <li key={t.id} className="lgo-plat">
                <div className="lgo-plat-main">
                  <span className="lgo-plat-site">{t.label}<span className="lgo-plat-pill is-live">Connected</span></span>
                  <span className="lgo-plat-about">{t.about}</span>
                </div>
                {t.tries?.length ? (
                  <span className="lgo-plat-tries">
                    <span className="lgo-plat-trylabel">Try</span>
                    {t.tries.map((q) => (
                      <span key={q} className="lgo-try">{q}</span>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="lgo-pop-head">Not connected yet</p>
          <ul className="lgo-pop-list">
            {later.map((t) => (
              <li key={t.id} className="lgo-plat is-later">
                <div className="lgo-plat-main">
                  <span className="lgo-plat-site">{t.label}<span className="lgo-plat-pill">Coming</span></span>
                  <span className="lgo-plat-about">{t.about}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
