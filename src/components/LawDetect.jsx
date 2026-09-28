import React, { Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useMorphPill } from './useMorphPill';
import { startLawDetection, hitAt, setHotRange } from '../lib/lawDetect';
import { subscribePointer } from '../lib/pointer';
import { openLawRef, subscribeLawDrawer, getLawDrawer, backLawDrawer, closeLawDrawer, openLawView } from '../lib/lawDrawer';
import './LawDetect.css';

// THE APP-WIDE LEGISLATION LAYER (2026-09-28 — the app's main feature), one
// behaviour everywhere: every reference to Romanian law in any text is
// HIGHLIGHTED in its platform's colour (lib/lawDetect), HOVERING it shows the
// highlight tooltip with what it is (components/RefHitPill — the Legislation
// tab's and the Doc Viewer's pill), and a CLICK opens the SIDE DRAWER from
// the right with the record itself (lib/lawDrawer → pages/ResearchDrawer's
// views: the act, the CAEN code, the court file, the company). Mounted once
// per window (AppShell, the Doc Viewer). A click that ends a text selection
// is left alone.
const LawRefDrawer = lazy(() => import('../pages/ResearchDrawer'));
let pillMod = null; // components/RefHitPill, loaded with the first hover

export default function LawDetect({ startAfterMs = 1500 }) {
  const [hover, setHover] = useState(null);
  const [, setTick] = useState(0);
  const stack = useSyncExternalStore(subscribeLawDrawer, getLawDrawer);
  const [drawerWanted, setDrawerWanted] = useState(false);
  if (stack.length && !drawerWanted) setDrawerWanted(true);

  const morph = useMorphPill({
    hoverContent: hover && pillMod ? pillMod.refHitPill(hover, { onLoaded: () => setTick((k) => k + 1) }) : '',
    menuItems: [],
  });
  const morphRef = useRef(morph);
  morphRef.current = morph;
  const hotRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => { startLawDetection(); }, startAfterMs);
    return () => clearTimeout(t);
  }, [startAfterMs]);

  // Hover: on the shared pointer (lib/pointer), once a frame.
  useEffect(() => {
    const clear = () => {
      if (!hotRef.current) return;
      hotRef.current = null;
      setHotRange(null);
      document.documentElement.classList.remove('is-lawref-hot');
      morphRef.current.handleMouseLeave();
    };
    const off = subscribePointer({
      read: (p) => (p.moved || !p.inWindow ? (p.inWindow ? hitAt(p.x, p.y, p.target) : null) : undefined),
      write: (p, it) => {
        if (it === undefined) return;
        if (!it) { clear(); return; }
        if (hotRef.current !== it) {
          hotRef.current = it;
          setHotRange(it.range);
          document.documentElement.classList.add('is-lawref-hot');
          const show = () => setHover(it.hit);
          if (pillMod) show();
          else import('./RefHitPill').then((m) => { pillMod = m; if (hotRef.current === it) show(); });
        }
        morphRef.current.handleMouseMove({ clientX: p.x, clientY: p.y });
      },
    });
    // Click: capture, ahead of whatever the text sits in.
    const onClick = (e) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      const sel = window.getSelection?.();
      if (sel && !sel.isCollapsed) return; // ending a text selection
      const it = hitAt(e.clientX, e.clientY, e.target);
      if (!it) return;
      e.preventDefault();
      e.stopPropagation();
      clear();
      openLawRef(it.hit);
    };
    document.addEventListener('click', onClick, true);
    return () => { off(); document.removeEventListener('click', onClick, true); clear(); };
  }, []);

  return (
    <>
      {morph.node}
      {drawerWanted ? (
        <Suspense fallback={null}>
          <LawRefDrawer
            stack={stack}
            onClose={closeLawDrawer}
            onBack={backLawDrawer}
            onOpen={openLawView}
            widthKey="docvex:law-drawer-w"
            keepOpenWithin=""
            ariaLabel="Legislation"
          />
        </Suspense>
      ) : null}
    </>
  );
}
