import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import {
  windowMinimize,
  windowToggleMaximize,
  windowClose,
  windowIsMaximized,
  onWindowMaximizedChanged,
} from '../lib/platform';
import brandIcon from '../favicon.ico';
import './TitleBar.css';

// Custom frameless title bar (Electron only — App.jsx gates it on isElectron).
// One bar holds the Theme control AND the window controls (minimize / maximize
// / close), so they live in the same section, separated by a divider.
// Documentation / Updates / Account moved to the launch hub's own sidebar. The
// whole bar is a drag region; every interactive element opts out with
// `-webkit-app-region: no-drag` (set in TitleBar.css).

const THEME_OPTIONS = [
  { pref: 'cream', label: 'White' },
  { pref: 'ink', label: 'Dark' },
  { pref: 'system', label: 'System' },
];

const ThemeIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
  </svg>
);
const ChevronDownIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);
const CheckIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// ── Window-control glyphs (Windows-ish line icons) ──
const MinimizeGlyph = (
  <svg viewBox="0 0 12 12" width="11" height="11"><rect x="1.5" y="5.5" width="9" height="1" fill="currentColor" /></svg>
);
const MaximizeGlyph = (
  <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.7" y="1.7" width="8.6" height="8.6" /></svg>
);
const RestoreGlyph = (
  <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="1.6" y="3.4" width="6.6" height="6.6" /><path d="M3.8 3.4V1.7h6.6v6.6H8.6" />
  </svg>
);
const CloseGlyph = (
  <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <line x1="2" y1="2" x2="10" y2="10" /><line x1="10" y1="2" x2="2" y2="10" />
  </svg>
);

export default function TitleBar() {
  const { session } = useAuth();
  const { themePreference, setTheme } = useTheme();
  const { pathname } = useLocation();
  // The launch hub lives at /launch — only there does the brand read "… | HUB".
  const onHub = pathname === '/launch';

  const [themeOpen, setThemeOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const themeRef = useRef(null);
  const themeBtnRef = useRef(null);
  const dropdownRef = useRef(null);

  // Morph the dropdown out of the theme button's border. Measured FLIP, played
  // via the Web Animations API — it animates explicitly from the collapsed
  // (button-sized) keyframe to the natural one, so it's immune to the paint/
  // commit-timing and StrictMode pitfalls that make inline-style FLIPs no-op.
  useLayoutEffect(() => {
    if (!themeOpen) return;
    const btn = themeBtnRef.current;
    const menu = dropdownRef.current;
    if (!btn || !menu || typeof menu.animate !== 'function') return;
    const o = btn.getBoundingClientRect();
    const n = menu.getBoundingClientRect(); // natural (no transform applied)
    if (!n.width || !n.height) return;
    const sx = o.width / n.width;
    const sy = o.height / n.height;
    const tx = o.left - n.left;
    const ty = o.top - n.top;
    const anim = menu.animate(
      [
        { transformOrigin: 'top left', transform: `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`, opacity: 0 },
        { transformOrigin: 'top left', transform: 'translate(0, 0) scale(1, 1)', opacity: 1 },
      ],
      { duration: 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
    return () => anim.cancel();
  }, [themeOpen]);

  // Track OS maximized state so the maximize⇄restore glyph stays correct.
  useEffect(() => {
    let alive = true;
    windowIsMaximized().then((v) => { if (alive) setMaximized(!!v); });
    const off = onWindowMaximizedChanged((v) => setMaximized(!!v));
    return () => { alive = false; off?.(); };
  }, []);

  // Close the theme dropdown on outside-click / Escape.
  useEffect(() => {
    if (!themeOpen) return;
    const onDown = (e) => {
      if (themeRef.current && !themeRef.current.contains(e.target)) setThemeOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setThemeOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [themeOpen]);

  const signedIn = !!session;

  return (
    <div className="tb-bar">
      {/* Brand on the left — "DOCVEX", with a "| HUB" suffix on the launch hub. */}
      <div className="tb-brand">
        <img src={brandIcon} alt="" className="tb-brand-icon" />
        <span className="tb-brand-name">DOCVEX</span>
        {onHub && <span className="tb-brand-suffix">| HUB</span>}
      </div>

      {/* The bar's flex pushes the cluster to the right. */}
      <div className="tb-drag-spacer" />

      {signedIn && (
        <>
          <div className="tb-actions" ref={themeRef}>
            {/* Theme — icon-only trigger; dropdown of White / Dark / System. */}
            <div className="tb-menu-wrap">
              <button
                ref={themeBtnRef}
                type="button"
                className={`tb-btn tb-btn-icon-only${themeOpen ? ' is-open' : ''}`}
                onClick={() => setThemeOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={themeOpen}
                title="Theme"
              >
                <span className="tb-btn-icon">{ThemeIcon}</span>
                <span className="tb-btn-chevron">{ChevronDownIcon}</span>
              </button>
              {themeOpen && (
                <div className="tb-dropdown" role="menu" ref={dropdownRef}>
                  {THEME_OPTIONS.map((opt) => (
                    <button
                      key={opt.pref}
                      type="button"
                      role="menuitemradio"
                      aria-checked={themePreference === opt.pref}
                      className={`tb-dropdown-item${themePreference === opt.pref ? ' is-active' : ''}`}
                      onClick={() => { setTheme(opt.pref); setThemeOpen(false); }}
                    >
                      <span>{opt.label}</span>
                      {themePreference === opt.pref && <span className="tb-dropdown-check">{CheckIcon}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Divider between the Theme control and the window controls. */}
          <div className="tb-divider" aria-hidden="true" />
        </>
      )}

      {/* Window controls — always present so the frameless window stays
          controllable on every screen, including /auth. */}
      <div className="tb-window-controls">
        <button type="button" className="tb-win-btn" onClick={windowMinimize} aria-label="Minimize" title="Minimize">
          {MinimizeGlyph}
        </button>
        <button type="button" className="tb-win-btn" onClick={windowToggleMaximize} aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore' : 'Maximize'}>
          {maximized ? RestoreGlyph : MaximizeGlyph}
        </button>
        <button type="button" className="tb-win-btn tb-win-close" onClick={windowClose} aria-label="Close" title="Close">
          {CloseGlyph}
        </button>
      </div>
    </div>
  );
}
