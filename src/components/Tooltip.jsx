import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
// Cursor coords + innerWidth are viewport px; the transform we set is layout
// px — under the app's CSS-zoom downscale the two differ (see lib/appZoom).
import { toLayoutPx } from '../lib/appZoom';
import './Tooltip.css';

// Cursor-following pill tooltip — same behaviour and visual treatment as
// the sidebar's `.locked-features-hint` cursor pill ("Select a project to
// use these features"). One shared interaction language for every floating
// hint in the app.
//
// Usage:
//   <Tooltip content="Close">
//     <button>{CloseIcon}</button>
//   </Tooltip>
//
// Behaviour:
//   - Appears on the first onMouseMove inside the trigger (no show delay
//     — matches the cursor pill which is instantaneous).
//   - Position updates every onMouseMove so the pill stays attached to
//     the pointer with an 8px below-right offset.
//   - Viewport edge lock: each axis is independently clamped to stay
//     inside the viewport. When the cursor approaches an edge, the pill
//     slides along that edge — the locked axis freezes while the other
//     keeps tracking the cursor. The pill never teleports to the opposite
//     side; the CSS transform transition just animates against a clamped
//     target so motion stays continuous as the cursor enters/exits the
//     clamp zone.
//   - Disappears on mouseleave.
//   - Focus fallback for keyboard users: pill anchors to the bottom-right
//     of the focused element with the same 8px offset, so accessibility
//     isn't regressed by dropping the old onFocus/onBlur path.
//
// The wrapper uses `display: contents` so it adds no layout box of its
// own — the child sits in the same flex/grid slot it would have without
// the tooltip. Pill is portalled to <body> so it can escape any
// overflow:hidden or `contain: layout` ancestor.

const CURSOR_OFFSET = 8;
const EDGE_MARGIN = 8;

// Hook form of the tooltip — same cursor-following pill, but it attaches to an
// element you already render instead of wrapping it. Use this when wrapping in
// the `display: contents` span would change DOM nesting in a way that breaks CSS
// (e.g. overlapping avatar stacks that rely on `:first-child`). Spread
// `triggerProps` onto your element and render `tooltip` anywhere (it's portalled
// to <body>, so its JSX position doesn't affect layout):
//
//   const { triggerProps, tooltip } = useTooltip(name);
//   return (<>
//     <span className="avatar" {...triggerProps}>{initials}</span>
//     {tooltip}
//   </>);
export function useTooltip(content, className = '') {
  const [pos, setPos] = useState(null);
  const pillRef = useRef(null);
  const hoveringRef = useRef(false);

  useLayoutEffect(() => {
    if (!pos) return;
    const pill = pillRef.current;
    if (!pill) return;
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    const vw = toLayoutPx(window.innerWidth);
    const vh = toLayoutPx(window.innerHeight);
    const x = Math.max(EDGE_MARGIN, Math.min(pos.x + CURSOR_OFFSET, vw - EDGE_MARGIN - w));
    const y = Math.max(EDGE_MARGIN, Math.min(pos.y + CURSOR_OFFSET, vh - EDGE_MARGIN - h));
    const isFirstSet = !pill.style.transform;
    if (isFirstSet) {
      pill.style.transition = 'none';
      pill.style.transform = `translate(${x}px, ${y}px)`;
      void pill.offsetWidth;
      pill.style.transition = '';
    } else {
      pill.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, [pos]);

  const triggerProps = {
    onMouseMove: (e) => { hoveringRef.current = true; setPos({ x: toLayoutPx(e.clientX), y: toLayoutPx(e.clientY) }); },
    onMouseLeave: () => { hoveringRef.current = false; setPos(null); },
    onFocus: (e) => {
      if (hoveringRef.current) return;
      const target = e.target?.getBoundingClientRect?.bind(e.target) ? e.target : e.currentTarget?.firstElementChild;
      const rect = target?.getBoundingClientRect?.();
      if (rect) setPos({ x: toLayoutPx(rect.right), y: toLayoutPx(rect.bottom) });
    },
    onBlur: () => setPos(null),
  };

  const tooltip = content && pos
    ? createPortal(
        <div ref={pillRef} className={`tooltip${className ? ` ${className}` : ''}`} role="tooltip">{content}</div>,
        document.body,
      )
    : null;

  return { triggerProps, tooltip };
}

export default function Tooltip({ content, children, className = '' }) {
  const { triggerProps, tooltip } = useTooltip(content, className);
  // Pass-through when content is empty so callers don't need to guard
  // (e.g. <Tooltip content={someCondition ? 'X' : undefined}>).
  if (!content) return children;
  // The wrapper uses `display: contents` so it adds no layout box of its own —
  // the child sits in the same flex/grid slot it would have without the tooltip.
  return (
    <>
      <span className="tooltip-trigger-wrap" {...triggerProps}>{children}</span>
      {tooltip}
    </>
  );
}
