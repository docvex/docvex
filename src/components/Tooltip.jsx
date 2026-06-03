import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

export default function Tooltip({ content, children, className = '' }) {
  // `{ x, y }` while visible, null while hidden. Single source of truth
  // for both mouse-driven and focus-driven shows.
  const [pos, setPos] = useState(null);
  const pillRef = useRef(null);
  // Tracks whether the cursor is currently inside the trigger area.
  // Clicking a button inside the trigger fires onFocus (because the
  // browser focuses the button on mousedown), which would otherwise
  // teleport the pill to the button's bottom-right corner. We use this
  // ref in onFocus to ignore focus events that came from a mouse
  // interaction — focus-driven positioning only fires for keyboard
  // users (Tab navigation, where no mousemove has set hoveringRef).
  const hoveringRef = useRef(false);

  // After every position change, measure the pill and clamp its transform
  // to stay inside the viewport. useLayoutEffect runs before the browser
  // paints, so the user only ever sees the adjusted position — no flicker.
  // The initial render still sets a `transform` inline (cursor + offset)
  // as a fallback for the brief window before this effect runs.
  //
  // Per-axis edge LOCK (not flip): each axis is independently clamped
  // into [EDGE_MARGIN, viewport - EDGE_MARGIN - pillSize]. As the cursor
  // approaches an edge, the pill slides along it — the locked axis
  // freezes at the edge while the other keeps tracking the cursor. The
  // pill never teleports to the opposite side of the cursor; the smooth
  // CSS transition just animates against a clamped target, so motion
  // stays continuous as the cursor enters / exits the clamp zone.
  useLayoutEffect(() => {
    if (!pos) return;
    const pill = pillRef.current;
    if (!pill) return;
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Default placement: below-right of the cursor with CURSOR_OFFSET gap.
    // Math.min then Math.max gives a single-expression clamp into the
    // valid range. When the cursor pushes far enough toward an edge that
    // the pill would overflow, the Math.min hits first and locks the axis
    // at `viewport - margin - pillSize`. The outer Math.max guards the
    // other side (defensive for cursors near the top/left edge or for
    // pills wider than the viewport).
    const x = Math.max(
      EDGE_MARGIN,
      Math.min(pos.x + CURSOR_OFFSET, vw - EDGE_MARGIN - w),
    );
    const y = Math.max(
      EDGE_MARGIN,
      Math.min(pos.y + CURSOR_OFFSET, vh - EDGE_MARGIN - h),
    );

    // First placement on this mount needs to SNAP to the cursor — the
    // pill's CSS-declared transition would otherwise interpolate from the
    // implicit `transform: none` baseline (origin 0,0) to the clamped
    // target, producing a visible "slide from top-left" on every hover.
    // Detect first-set by checking the pill's inline transform: empty
    // means freshly mounted (the JSX no longer renders one). For the
    // first set we momentarily disable the transition, write the
    // transform, force a reflow (`offsetWidth` read commits the style),
    // then restore the transition so subsequent moves glide normally.
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

  // Pass-through when content is empty so callers don't need to guard
  // (e.g. <Tooltip content={someCondition ? 'X' : undefined}>).
  if (!content) return children;

  return (
    <>
      <span
        className="tooltip-trigger-wrap"
        onMouseMove={(e) => {
          hoveringRef.current = true;
          setPos({ x: e.clientX, y: e.clientY });
        }}
        onMouseLeave={() => {
          hoveringRef.current = false;
          setPos(null);
        }}
        onFocus={(e) => {
          // Skip focus-driven positioning when the cursor is already
          // inside the trigger — clicking a button fires focus (the
          // browser focuses on mousedown), and without this guard the
          // pill would teleport from its cursor-tracking position to
          // the element's bottom-right corner on every click.
          if (hoveringRef.current) return;
          // Keyboard users get the same pill anchored to the focused
          // element's bottom-right corner — same +8px offset semantics as
          // the mouse path, just without a moving cursor to follow. The
          // viewport-clamp effect above adjusts the pill if the focused
          // element sits near a viewport edge.
          const target = e.target?.getBoundingClientRect?.bind(e.target)
            ? e.target
            : e.currentTarget?.firstElementChild;
          const rect = target?.getBoundingClientRect?.();
          if (rect) setPos({ x: rect.right, y: rect.bottom });
        }}
        onBlur={() => setPos(null)}
      >
        {children}
      </span>
      {pos && createPortal(
        <div
          ref={pillRef}
          className={`tooltip${className ? ` ${className}` : ''}`}
          role="tooltip"
          // No inline `transform` on render. The useLayoutEffect above
          // writes the clamped transform via the ref BEFORE the browser
          // paints, so the first frame is always the corrected position.
          //
          // Why this matters for jitter: if React's render-time inline
          // style wrote the UNCLAMPED `translate(pos.x + 8, pos.y + 8)`
          // and useLayoutEffect then overwrote it with the clamped
          // value, the CSS `transition: transform` would briefly snapshot
          // the raw target between the commit and the effect run. With
          // pos hugging an edge — e.g. moving the cursor horizontally
          // while pinned to the bottom — the y component of the raw
          // value would oscillate against the clamped value every frame,
          // and the transition would chase a phantom moving target,
          // producing a visible jitter. Sourcing every transform from
          // useLayoutEffect (a single value per frame) eliminates the
          // double-write race entirely.
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
