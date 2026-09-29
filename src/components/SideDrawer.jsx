import { hitAt } from '../lib/lawDetect';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Tooltip from './Tooltip';
import { toLayoutPx } from '../lib/appZoom';
import './SideDrawer.css';

// THE SIDE DRAWER — a panel that slides in from the right of the window and
// floats over the page (fixed, portalled to <body>, so nothing under it moves):
// the Playbook's preview drawer made a component anyone can fill. Standing in
// the Design system gallery as "Side drawer"; Research uses it for everything
// it opens (pages/ResearchDrawer).
//
//   <SideDrawer open onClose title="Act" subtitle="Legea nr. 31/1990"
//               onBack={canGoBack ? back : null} widthKey="docvex:my:drawer-w"
//               keepOpenWithin=".my-page" contentKey={viewId}>
//     …anything…
//   </SideDrawer>
//
// • Slides in (280ms), out the same way; kept mounted after the first opening
//   so reopening is instant (hidden once it has slid out).
// • `deferContent` (default on): the children are drawn only once the slide
//   has landed — laying out something heavy while the panel moves is what
//   makes a slide snap.
// • Resized by its LEFT EDGE (drag, ←/→ with Shift for bigger steps,
//   double-click = the default width), clamped `minWidth`…`maxWidth` and never
//   past the window; kept per device under `widthKey` when one is given.
// • Closed by ×, Escape, or a press outside it — except inside
//   `keepOpenWithin` (a selector: the page it belongs to, so the page can be
//   used while watching the drawer), tooltips and dropdown menus.
// • `onBack` shows a Back button at the head's left; `headerExtra` goes before
//   the close button; `contentKey` changing scrolls the body back to its top.

const SLIDE_MS = 280;

export default function SideDrawer({
  open,
  onClose,
  title = '',
  subtitle = '',
  onBack = null,
  headerExtra = null,
  children,
  widthKey = '',
  defaultWidth = 760,
  minWidth = 420,
  maxWidth = 1400,
  keepOpenWithin = '',
  deferContent = true,
  contentKey = null,
  ariaLabel = '',
  className = '',
  bodyClassName = '',
}) {
  const clamp = (w) => Math.round(Math.min(maxWidth, Math.max(minWidth, w)));
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const [ready, setReady] = useState(!deferContent && open);
  const panelRef = useRef(null);
  const bodyRef = useRef(null);
  const [width, setWidth] = useState(() => {
    if (!widthKey) return defaultWidth;
    try { const v = Number(localStorage.getItem(widthKey)); return v ? clamp(v) : defaultWidth; } catch { return defaultWidth; }
  });
  const [dragging, setDragging] = useState(false);
  const keepWidth = (w) => { if (widthKey) { try { localStorage.setItem(widthKey, String(w)); } catch { /* per-device nicety */ } } }; // secure-store-ok: a drawer width (widthKey is a UI key)

  const startDrag = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = toLayoutPx(e.clientX);
    const w0 = panelRef.current ? toLayoutPx(panelRef.current.getBoundingClientRect().width) : width;
    let w = w0;
    setDragging(true);
    // The drawer is pinned right: dragging its left edge left widens it.
    const move = (ev) => { w = clamp(w0 + x0 - toLayoutPx(ev.clientX)); setWidth(w); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
      keepWidth(w);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const gripKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.shiftKey ? 64 : 16;
    setWidth((cur) => { const w = clamp(cur + (e.key === 'ArrowLeft' ? step : -step)); keepWidth(w); return w; });
  };

  // Slide in / out; the content follows the slide when deferred.
  useEffect(() => {
    if (!open) { setShown(false); if (deferContent) setReady(false); return undefined; }
    setMounted(true);
    let t = 0;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => {
      setShown(true);
      if (deferContent) t = setTimeout(() => setReady(true), SLIDE_MS + 20);
      else setReady(true);
    }));
    return () => { cancelAnimationFrame(id); clearTimeout(t); };
  }, [open, deferContent]);

  // A new piece of content starts at its top.
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [contentKey]);

  // Escape, or a press outside (and outside `keepOpenWithin`), closes it.
  useEffect(() => {
    if (!open || !onClose) return undefined;
    const keep = ['.tooltip', '.lg-menu', keepOpenWithin].filter(Boolean).join(', ');
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => {
      const panel = panelRef.current;
      // A press on a legislation reference (lib/lawDetect) opens it in the
      // drawer — it must not close it first.
      if (hitAt(e.clientX, e.clientY)) return;
      if (panel && !panel.contains(e.target) && !e.target.closest?.(keep)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open, onClose, keepOpenWithin]);

  if (!mounted) return null;
  return createPortal(
    <aside
      ref={panelRef}
      className={`sd-drawer${shown ? ' is-open' : ''}${dragging ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
      style={{ '--sd-drawer-w': `${width}px` }}
      aria-label={ariaLabel || title || 'Side panel'}
      aria-hidden={!open || undefined}
    >
      <div
        className="sd-drawer-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the panel"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startDrag}
        onDoubleClick={() => { setWidth(defaultWidth); keepWidth(defaultWidth); }}
        onKeyDown={gripKey}
      />
      <header className="sd-drawer-head">
        {onBack ? (
          <Tooltip content="Back">
            <button type="button" className="sd-drawer-btn" aria-label="Back" onClick={onBack}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            </button>
          </Tooltip>
        ) : null}
        <span className="sd-drawer-title">{title}{subtitle ? <span className="sd-drawer-sub"> · {subtitle}</span> : null}</span>
        {headerExtra}
        {onClose ? (
          <Tooltip content="Close (Esc)">
            <button type="button" className="sd-drawer-btn" aria-label="Close" onClick={onClose}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </Tooltip>
        ) : null}
      </header>
      <div className={`sd-drawer-body${bodyClassName ? ` ${bodyClassName}` : ''}`} ref={bodyRef}>
        {ready ? children : null}
      </div>
    </aside>,
    document.body,
  );
}
