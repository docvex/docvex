import React, { useCallback, useEffect, useRef, useState } from 'react';
import './SnipPanel.css';

// Snipping-Tool-style launcher bar (tray → "Extract text"). Lives in a small
// TRANSPARENT always-on-top window (/snip-panel): the card at the top paints
// itself; the rest of the window is an invisible apron that gives the Mode /
// Delay dropdowns room to open (a window's content can't overflow its bounds).
//
//   New       — hides this panel, waits the chosen delay, then opens the
//               fullscreen /snip capture overlay. The capture mode
//               (rectangular / free-form / full-screen) is picked live in the
//               overlay's top pill, not here.
//   Delay     — 0–5 s before the screen is frozen (time to open menus etc.).
//   Cancel    — active only while a delayed capture is counting down.
//   Options   — placeholder (no options in this build), kept for the classic
//               toolbar shape.
//
// When a capture finishes or is cancelled, main.js re-shows this panel.

const DELAYS = [0, 1, 2, 3, 4, 5];

// Inline stroke icons (app convention — no icon library).
// Same "scan text" glyph as the Doc Viewer's Extract-text tool (ScanTextGlyph
// in DocViewer.jsx) — the tool's identity icon across the app.
const IconExtract = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M7 9h10" />
    <path d="M7 13h7" />
    <path d="M7 17h4" />
  </svg>
);
const IconDelay = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8" /><path d="M12 8v4.4l2.8 1.8" />
  </svg>
);
const IconOneScreen = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="5" width="16" height="11" rx="1.5" />
    <path d="M9 20h6M12 16v4" />
  </svg>
);
const IconMultiScreens = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="13" height="9" rx="1.5" />
    <path d="M19 8h1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-1" />
    <path d="M7 18h5" />
  </svg>
);
const IconCaret = (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);
const IconHelp = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.4c-.8.3-1 .9-1 1.7" /><circle cx="12" cy="16.6" r="0.4" fill="currentColor" />
  </svg>
);
const IconMinimize = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M5 12h14" />
  </svg>
);
const IconClose = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export default function SnipPanel() {
  const [delay, setDelay] = useState(0);
  // Freeze scope: false → only the screen this window is on; true → all.
  const [allScreens, setAllScreens] = useState(false);
  const [menu, setMenu] = useState(null); // null | 'delay'
  // True while a delayed capture is counting down (drives the info strip).
  const [pending, setPending] = useState(false);
  const pendingTimer = useRef(null);

  const closePanel = useCallback(() => {
    if (window.electronAPI?.windowClose) window.electronAPI.windowClose();
    else window.close();
  }, []);

  // Esc: close an open dropdown first; abort a running capture countdown
  // next (panel stays open); only then close the panel.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (menu) { setMenu(null); return; }
      if (pending) {
        window.electronAPI?.snipCancelPending?.();
        clearTimeout(pendingTimer.current);
        setPending(false);
        return;
      }
      closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, pending, closePanel]);

  useEffect(() => () => clearTimeout(pendingTimer.current), []);

  const startSnip = () => {
    setMenu(null);
    // Mode is chosen live in the capture overlay's top pill; rect is the
    // starting selection.
    window.electronAPI?.snipNew?.({ mode: 'rect', delay, allScreens });
    if (delay > 0) {
      // Show the countdown note until the capture actually fires (main hides
      // this window then).
      setPending(true);
      clearTimeout(pendingTimer.current);
      pendingTimer.current = setTimeout(() => setPending(false), delay * 1000 + 400);
    }
  };

  const toggleMenu = (which) => setMenu((m) => (m === which ? null : which));

  // Sidebar-style hover: feed the cursor position into --item-spot-x/y so the
  // radial accent gradient brightens at the pointer (same recipe as
  // .nav-item:hover in Sidebar.css). Percentages are ratios of two viewport
  // values, so no toLayoutPx conversion is needed.
  const trackSpot = (e) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--item-spot-x', `${((e.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty('--item-spot-y', `${((e.clientY - r.top) / r.height) * 100}%`);
  };

  return (
    <div className="sp-root" onMouseDown={() => setMenu(null)}>
      <div className="sp-card" onMouseDown={(e) => e.stopPropagation()}>
        {/* Mini title bar — drag region + window controls. */}
        <div className="sp-titlebar">
          <span className="sp-title-icon">{IconExtract}</span>
          <span className="sp-title">Extract Tool</span>
          <div className="sp-title-controls">
            <button
              type="button"
              className="sp-winbtn"
              aria-label="Minimize"
              onClick={() => window.electronAPI?.windowMinimize?.()}
            >
              {IconMinimize}
            </button>
            <button
              type="button"
              className="sp-winbtn is-close"
              aria-label="Close"
              onClick={closePanel}
            >
              {IconClose}
            </button>
          </div>
        </div>

        {/* Toolbar — New · Mode ▾ · Delay ▾ · Cancel · Options. */}
        <div className="sp-toolbar">
          <button type="button" className="sp-btn is-new" onMouseMove={trackSpot} onClick={() => startSnip()}>
            <span className="sp-btn-icon">{IconExtract}</span>
            New
          </button>

          <span className="sp-sep" />

          <div className="sp-dd">
            <button
              type="button"
              className={`sp-btn${menu === 'delay' ? ' is-open' : ''}`}
              aria-haspopup="menu"
              aria-expanded={menu === 'delay'}
              onMouseMove={trackSpot}
              onClick={() => toggleMenu('delay')}
            >
              <span className="sp-btn-icon">{IconDelay}</span>
              Delay
              {/* The chosen delay reads on the button itself (nothing when off). */}
              {delay > 0 && <span className="sp-btn-value is-set">{`${delay}s`}</span>}
              <span className="sp-caret">{IconCaret}</span>
            </button>
            {menu === 'delay' && (
              <div className="sp-menu" role="menu">
                {DELAYS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="menuitemradio"
                    aria-checked={delay === s}
                    className="sp-menu-item"
                    onMouseMove={trackSpot}
                    onClick={() => { setDelay(s); setMenu(null); }}
                  >
                    {s === 0 ? 'No delay' : `${s} second${s > 1 ? 's' : ''}`}
                    {/* Selected marker rides the right edge. */}
                    {delay === s && <span className="sp-radio-dot" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="sp-sep" />

          {/* Freeze scope — the screen this window is on, or every screen.
              The selection "thumb" is one sliding layer behind the buttons so
              switching glides left⇄right instead of jumping. */}
          <div className="sp-scope" role="group" aria-label="Screens to freeze">
            <span className={`sp-scope-thumb${allScreens ? ' is-right' : ''}`} aria-hidden="true" />
            <button
              type="button"
              className={`sp-scope-btn${!allScreens ? ' is-active' : ''}`}
              aria-pressed={!allScreens}
              onMouseMove={trackSpot}
              onClick={() => setAllScreens(false)}
            >
              <span className="sp-btn-icon">{IconOneScreen}</span>
              This screen
            </button>
            <button
              type="button"
              className={`sp-scope-btn${allScreens ? ' is-active' : ''}`}
              aria-pressed={allScreens}
              onMouseMove={trackSpot}
              onClick={() => setAllScreens(true)}
            >
              <span className="sp-btn-icon">{IconMultiScreens}</span>
              All screens
            </button>
          </div>
        </div>

        {/* Info strip. */}
        <div className="sp-info">
          <span className="sp-info-icon">{IconHelp}</span>
          {pending
            ? `Capturing in ${delay} second${delay > 1 ? 's' : ''}…`
            : `Click New to freeze ${allScreens ? 'all screens' : 'this screen'}${
              delay > 0 ? ` after ${delay} second${delay > 1 ? 's' : ''}` : ' instantly'
            }, then pick a capture mode from the pill at the top.`}
        </div>
      </div>
    </div>
  );
}
