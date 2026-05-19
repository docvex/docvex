import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Shared morph-pill hook + portal renderer. Powers the same hover-
// tooltip → right-click-menu interaction the file grid uses on every
// surface (Cloud-tab FileCard, My-branch LocalFileCard). Lives here
// instead of inline so the FLIP animation + sticky-mode dismissal
// logic stays in one place — adding a third caller is a one-line
// change instead of another 100-line copy-paste.
//
// Usage:
//   const morphPill = useMorphPill({
//     hoverContent: 'Tooltip text',     // shown when cursor is over card
//     menuItems: [                       // shown after right-click
//       { label: 'Properties', onClick: () => …, key: 'props' },
//       { label: 'Open',       onClick: () => …, key: 'open'  },
//     ],
//   });
//   return (
//     <div
//       onMouseMove={morphPill.handleMouseMove}
//       onMouseLeave={morphPill.handleMouseLeave}
//       onContextMenu={morphPill.handleContextMenu}
//     >
//       …card content…
//       {morphPill.node}
//     </div>
//   );
//
// State model:
//   pillPos       — cursor coords when the pill is visible. null = hidden.
//   menuMode      — when true, pill is sticky (ignores mouseleave),
//                   interactive (pointer-events:auto), and renders the
//                   menu items instead of the text.
//   oldPillRectRef — bounding rect of the small tooltip pill at the
//                   moment of right-click, so the FLIP animation has
//                   a "from" size to scale up from.
//
// `menuItems` entries are `{ label, onClick, key? }`. Falsy entries
// are filtered, so callers can write `[itemA, condition && itemB, itemC]`
// and have the conditional collapse cleanly without per-render branching.
export function useMorphPill({ hoverContent, menuItems }) {
  const [pillPos, setPillPos] = useState(null);
  const [menuMode, setMenuMode] = useState(false);
  const pillRef = useRef(null);
  const oldPillRectRef = useRef(null);

  const handleMouseMove = (e) => {
    if (menuMode) return;
    setPillPos({ x: e.clientX, y: e.clientY });
  };
  const handleMouseLeave = () => {
    if (menuMode) return;
    setPillPos(null);
  };
  const handleContextMenu = (e) => {
    e.preventDefault();
    // Snapshot the pill's current (tooltip-size) rect BEFORE the
    // menu-mode flip so the FLIP effect below has a "from" size to
    // scale up from. Captured here in the event handler rather than
    // in the effect because by the time the effect runs the DOM is
    // already at menu-size.
    if (pillRef.current) {
      oldPillRectRef.current = pillRef.current.getBoundingClientRect();
    }
    setPillPos({ x: e.clientX, y: e.clientY });
    setMenuMode(true);
  };
  const closeMenu = () => {
    setMenuMode(false);
    setPillPos(null);
    oldPillRectRef.current = null;
  };

  // Sticky-mode dismissal: outside click, Escape, or scroll.
  useEffect(() => {
    if (!menuMode) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
    const onDown = (e) => {
      if (pillRef.current && pillRef.current.contains(e.target)) return;
      closeMenu();
    };
    const onScroll = () => closeMenu();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menuMode]);

  // Position-clamp — same recipe as the shared Tooltip: keep the pill
  // inside the viewport on both axes, snap on first mount so the CSS
  // transition doesn't visibly slide in from (0,0). Re-runs on menu-
  // mode flip too so the bigger menu shape gets re-clamped.
  useLayoutEffect(() => {
    if (!pillPos) return;
    const pill = pillRef.current;
    if (!pill) return;
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = Math.max(8, Math.min(pillPos.x + 8, vw - 8 - w));
    const y = Math.max(8, Math.min(pillPos.y + 8, vh - 8 - h));
    const isFirstSet = !pill.style.transform;
    if (isFirstSet) {
      pill.style.transition = 'none';
      pill.style.transform = `translate(${x}px, ${y}px)`;
      void pill.offsetWidth;
      pill.style.transition = '';
    } else {
      pill.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, [pillPos, menuMode]);

  // FLIP morph — runs once on menu-mode entry. Concept:
  //   F (First) — captured in handleContextMenu as oldPillRectRef.
  //   L (Last)  — measured right here, after React has committed the
  //               .is-menu shape change.
  //   I (Invert) — apply an inline transform that scales the pill
  //               DOWN so it visually matches the old tooltip size.
  //   P (Play)  — transition back to scale(1) using a transform-only
  //               animation, which composites on the GPU and runs
  //               without layout-thrashing repaints.
  useLayoutEffect(() => {
    if (!menuMode) return;
    const oldRect = oldPillRectRef.current;
    if (!oldRect) return;
    const pill = pillRef.current;
    if (!pill) return;
    const newRect = pill.getBoundingClientRect();
    if (newRect.width === 0 || newRect.height === 0) {
      oldPillRectRef.current = null;
      return;
    }
    const sx = oldRect.width / newRect.width;
    const sy = oldRect.height / newRect.height;
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(pill.style.transform || '');
    const tx = m ? parseFloat(m[1]) : 0;
    const ty = m ? parseFloat(m[2]) : 0;
    pill.style.transformOrigin = 'top left';
    pill.style.transition = 'none';
    pill.style.transform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
    void pill.offsetWidth;
    pill.style.transition = 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)';
    pill.style.transform = `translate(${tx}px, ${ty}px) scale(1, 1)`;
    oldPillRectRef.current = null;
  }, [menuMode]);

  const filteredItems = (menuItems || []).filter(Boolean);

  const node = pillPos ? createPortal(
    <div
      ref={pillRef}
      className={`tooltip project-files-morph-pill${menuMode ? ' is-menu' : ''}`}
      role={menuMode ? 'menu' : 'tooltip'}
      // In menu mode, cursor leaving the pill dismisses it. The base
      // tooltip is pointer-events:none so this never fires for the
      // non-menu state — only the `.is-menu` rule turns pointer-events
      // on, which is what makes the menu hoverable AND what makes
      // mouseleave fire when the cursor exits.
      onMouseLeave={menuMode ? closeMenu : undefined}
    >
      {menuMode ? (
        <ul className="project-files-morph-list">
          {filteredItems.map((item, i) => (
            <li key={item.key || item.label || i} role="none">
              <button
                type="button"
                role="menuitem"
                className={`project-files-morph-item${item.danger ? ' project-files-morph-item-danger' : ''}`}
                onClick={() => {
                  closeMenu();
                  item.onClick?.();
                }}
                disabled={item.disabled || false}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="project-files-morph-text">{hoverContent}</span>
      )}
    </div>,
    document.body,
  ) : null;

  return {
    handleMouseMove,
    handleMouseLeave,
    handleContextMenu,
    closeMenu,
    isMenuOpen: menuMode,
    node,
  };
}
