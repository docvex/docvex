import React, { Suspense, lazy, useState, useSyncExternalStore } from 'react';
import { subscribeLawDrawer, getLawDrawer, backLawDrawer, closeLawDrawer, openLawView } from '../lib/lawDrawer';

// THE APP DRAWER for a portal record (lib/lawDrawer → pages/ResearchDrawer's
// views: an act, a CAEN code, a court file, a company), opened with
// `openLawView` — e.g. the Newsletter's "Read the act". Mounted once per window
// (AppShell). Loaded only once something is opened. (It used to live in
// components/LawDetect with the app-wide legislation highlighting, removed on
// 2026-10-03.)
const LawRefDrawer = lazy(() => import('../pages/ResearchDrawer'));

export default function LawDrawerHost() {
  const stack = useSyncExternalStore(subscribeLawDrawer, getLawDrawer);
  const [wanted, setWanted] = useState(false);
  if (stack.length && !wanted) setWanted(true);
  if (!wanted) return null;
  return (
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
  );
}
