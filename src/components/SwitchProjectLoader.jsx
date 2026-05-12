import React, { useEffect, useState } from 'react';
import { useSelectedProject } from '../context/SelectedProjectContext';
import './SwitchProjectLoader.css';

// Duration of the fade-out animation. Must match the CSS keyframe duration
// in .switch-project-loader.is-closing so the unmount timer + the animation
// finish on the same frame.
const FADE_OUT_MS = 220;

// Full-screen overlay shown while the user switches between projects.
// Visibility is driven by SelectedProjectContext.switching, which is set by
// beginSwitch() and auto-cleared after a min-floor (SWITCH_LOADER_MIN_MS in
// the context) so the transition reads as deliberate rather than flickery.
//
// The overlay starts at the sidebar's right edge (not at left: 0) so the
// spinner+label sit centered in the main content area rather than under
// the sidebar. The CSS uses var(--sidebar-width) which the .app-shell sets
// to 60px by default and 220px when the sidebar is expanded (hover/locked/
// picker-open) — see AppShell.css.
//
// Z-index sits BELOW the sidebar (sidebar = 50, this = 45) on purpose: the
// sidebar stays visible and interactive during the switch, so the user can
// click around / cancel by picking again / open the picker once more, while
// the main content area is masked.
export default function SwitchProjectLoader() {
  const { switching, switchingToName } = useSelectedProject();

  // Two-stage lifecycle so we can play a fade-out animation BEFORE unmount:
  //   - `visible`: should the DOM node exist at all
  //   - `closing`: should the .is-closing class be applied (drives the
  //                fade-out animation; the unmount happens after the
  //                animation finishes)
  // When `switching` flips false we don't immediately unmount — we keep the
  // node, switch to the closing class, and remove it FADE_OUT_MS later.
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (switching) {
      // New switch began — drop any in-flight closing state and show.
      setVisible(true);
      setClosing(false);
      return undefined;
    }
    if (!visible) return undefined;
    // Min delay just elapsed in the context — start the fade-out.
    setClosing(true);
    const t = setTimeout(() => {
      setVisible(false);
      setClosing(false);
    }, FADE_OUT_MS);
    return () => clearTimeout(t);
  }, [switching, visible]);

  if (!visible) return null;

  // Label varies by switch kind. "Switching to <name>" reads naturally;
  // the no-name clear-selection case falls back to a generic line.
  const label = switchingToName
    ? `Switching to ${switchingToName}`
    : 'Switching project…';
  return (
    <div
      className={`switch-project-loader${closing ? ' is-closing' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="switch-project-loader-stack">
        <div className="switch-project-loader-spinner" />
        <div className="switch-project-loader-label">{label}</div>
      </div>
    </div>
  );
}
