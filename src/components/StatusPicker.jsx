import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { STATUS_OPTIONS, getStatusOption } from '../lib/userStatus';
import './StatusPicker.css';

const CheckIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// Floating popover that lets the current user pick a new activity status.
// Anchored to a trigger element via its DOMRect — caller passes the rect
// (e.g. `triggerEl.getBoundingClientRect()`). Rendered through a portal
// at <body> so the surrounding sidebar's `contain: layout paint` doesn't
// clip it.
//
// Outside-click and Escape both close. The caller owns the open/closed
// state and pairs onClose with onPick (typically: pick → call updateStatus
// → close).
export default function StatusPicker({ anchorRect, currentStatus, onPick, onClose }) {
  const panelRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e) => {
      // Ignore clicks inside the panel; everything else dismisses.
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    // mousedown rather than click so the picker dismisses before any
    // re-anchored re-open click would race with it (matters when the
    // sidebar badge itself is clicked again to close).
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  if (!anchorRect) return null;

  // Position the panel just below-right of the anchor, clamped to stay
  // on-screen. The 6px offset gives a tiny visual gap so the panel
  // doesn't look glued to the badge.
  const PANEL_WIDTH = 240;
  const PANEL_OFFSET = 6;
  const rawLeft = anchorRect.right + PANEL_OFFSET;
  const left = Math.min(
    Math.max(8, rawLeft),
    window.innerWidth - PANEL_WIDTH - 8,
  );
  // Anchor the panel's bottom to the badge's vertical centre so it floats
  // upward — the sidebar badge sits near the bottom of the screen, so
  // dropping the panel below would clip it.
  const bottom = window.innerHeight - anchorRect.bottom - 4;

  return createPortal(
    <div
      ref={panelRef}
      className="status-picker"
      role="menu"
      style={{
        left: `${left}px`,
        bottom: `${bottom}px`,
        width: `${PANEL_WIDTH}px`,
      }}
    >
      <div className="status-picker-header">Set your status</div>
      <ul className="status-picker-list">
        {STATUS_OPTIONS.map((option) => {
          const isSelected = option.key === (currentStatus || 'online');
          return (
            <li key={option.key}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                className={`status-picker-row${isSelected ? ' is-selected' : ''}`}
                onClick={() => onPick(option.key)}
              >
                <span
                  className={`status-picker-dot${option.key === 'offline' ? ' status-picker-dot-offline' : ''}`}
                  style={{ '--status-color': option.color }}
                />
                <span className="status-picker-text">
                  <span className="status-picker-label">{option.label}</span>
                  <span className="status-picker-desc">{option.description}</span>
                </span>
                {isSelected && <span className="status-picker-check">{CheckIcon}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}

// Re-export for callers that want the resolved option (label/color) without
// importing from lib/userStatus directly.
export { getStatusOption };
