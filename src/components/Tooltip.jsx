import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
// How long the pill takes to fade away when the page scrolls under it.
// Keep in step with the .tooltip.is-out transition in Tooltip.css.
const FADE_OUT_MS = 120;

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
  const triggerRef = useRef(null); // the wrapper/host node the cursor is over

  // Safety net for a missed mouseleave: if the trigger is removed, disabled, or
  // re-rendered out from under the cursor, React's onMouseLeave never fires and
  // the pill freezes at its last cursor position ("stuck in a random location").
  // While shown, watch the pointer globally and hide once it's no longer over
  // the trigger node (DOM containment, so display:contents wrappers still work).
  const shown = pos != null;

  // ── Scrolling ──────────────────────────────────────────────────────────
  // Scrolling moves the trigger out from under a cursor that has not itself
  // moved, so no mouseleave fires and the pill is left describing whatever
  // has slid beneath it. It goes — but it FADES rather than vanishing, the
  // way it does across the Doc Viewer's focus crossing, because the pointer
  // is still where it was and a pill blinking out under a stationary cursor
  // reads as a glitch.
  // Capture phase, on the window: the scroller is usually a pane deep in the
  // tree and a scroll event does not bubble.
  const [fading, setFading] = useState(false);
  const fadeRef = useRef(0);
  useEffect(() => () => { if (fadeRef.current) window.clearTimeout(fadeRef.current); }, []);
  useLayoutEffect(() => {
    if (!shown) return undefined;
    const onScroll = () => {
      if (fadeRef.current) return;
      setFading(true);
      fadeRef.current = window.setTimeout(() => {
        fadeRef.current = 0;
        setFading(false);
        hoveringRef.current = false;
        setPos(null);
      }, FADE_OUT_MS);
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  }, [shown]);

  useLayoutEffect(() => {
    if (!shown) return undefined;
    const onWinMove = (e) => {
      const node = triggerRef.current;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      if (!node || !under || !node.contains(under)) {
        hoveringRef.current = false;
        setPos(null);
      }
    };
    window.addEventListener('pointermove', onWinMove, { passive: true });
    return () => window.removeEventListener('pointermove', onWinMove);
  }, [shown]);

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
      // Two lines or more: HALF the radius. A stadium pill (999px) is right
      // only one line tall — on two lines its ends read as a deformed
      // capsule. The rule is measured, not opted into: the one-line height
      // is the line box plus the padding and border, and a pill at least a
      // line taller than that gets half of what its one-line radius would
      // have been (that height's half, halved). Inline, so a re-render that
      // rewrites the class list cannot drop it.
      const cs = getComputedStyle(pill);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      const oneLine = lh + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
        + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const tall = h >= oneLine + lh - 1;
      pill.style.borderRadius = tall ? `${oneLine / 4}px` : '';
      pill.style.transition = 'none';
      pill.style.transform = `translate(${x}px, ${y}px)`;
      void pill.offsetWidth;
      pill.style.transition = '';
    } else {
      pill.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, [pos]);

  const triggerProps = {
    onMouseMove: (e) => {
      if (fadeRef.current) return;   // mid-fade: let it finish leaving
      hoveringRef.current = true; triggerRef.current = e.currentTarget;
      setPos({ x: toLayoutPx(e.clientX), y: toLayoutPx(e.clientY) });
    },
    onMouseLeave: () => { hoveringRef.current = false; setPos(null); },
    onFocus: (e) => {
      if (hoveringRef.current) return;
      // Only anchor to the element on KEYBOARD focus. Focus moved by a mouse
      // click or restored programmatically (e.g. when a modal closes) would
      // otherwise pop the pill up at the element's corner with no cursor near
      // it — the "tooltip in a random location while not hovering" bug.
      const target = e.target?.getBoundingClientRect?.bind(e.target) ? e.target : e.currentTarget?.firstElementChild;
      if (!target?.matches || !target.matches(':focus-visible')) return;
      triggerRef.current = e.currentTarget;
      const rect = target?.getBoundingClientRect?.();
      if (rect) setPos({ x: toLayoutPx(rect.right), y: toLayoutPx(rect.bottom) });
    },
    onBlur: () => setPos(null),
  };

  const tooltip = content && pos
    ? createPortal(
        <div ref={pillRef} className={`tooltip${fading ? ' is-out' : ''}${className ? ` ${className}` : ''}`} role="tooltip">{content}</div>,
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
