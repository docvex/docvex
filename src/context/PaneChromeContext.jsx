import React, { createContext, useContext, useEffect, useState } from 'react';

// Per-pane channel between the routed page and its window chrome (the top bar):
//   • a live DESCRIPTION (text) the chrome shows next to the title,
//   • a portal SLOT (a second chrome row) the page renders its own toolbar into
//     — e.g. the Files folder nav + breadcrumb + search — so the chrome + that
//     toolbar read as ONE bar.
// Each pane surface (single / primary / secondary) wraps its PaneChrome +
// content in its OWN provider, so panes don't clobber each other.
//
// Split into separate contexts on purpose: the slot value + portal element each
// change independently, and the SETTERS are stable, so pages that only set them
// don't needlessly re-render.

const SlotValueContext = createContext(null);
const SlotSetContext = createContext(() => {});
const PortalElContext = createContext(null);
const SetPortalElContext = createContext(() => {});
// Footer channel — symmetric to the row-2 toolbar portal but for the window's
// BOTTOM bar (e.g. the chat message composer): a page portals content into its
// pane's footer, so the footer always shows what's relevant to that window.
const FooterElContext = createContext(null);
const SetFooterElContext = createContext(() => {});

export function PaneChromeProvider({ children }) {
  const [slot, setSlot] = useState(null);
  const [portalEl, setPortalEl] = useState(null);
  const [footerEl, setFooterEl] = useState(null);
  return (
    <SlotSetContext.Provider value={setSlot}>
      <SetPortalElContext.Provider value={setPortalEl}>
        <SetFooterElContext.Provider value={setFooterEl}>
          <SlotValueContext.Provider value={slot}>
            <PortalElContext.Provider value={portalEl}>
              <FooterElContext.Provider value={footerEl}>
                {children}
              </FooterElContext.Provider>
            </PortalElContext.Provider>
          </SlotValueContext.Provider>
        </SetFooterElContext.Provider>
      </SetPortalElContext.Provider>
    </SlotSetContext.Provider>
  );
}

// Chrome-side: the current published slot (description), and a ref callback to
// register the row-2 portal target element.
export function usePaneChromeSlotValue() {
  return useContext(SlotValueContext);
}
export function usePaneChromePortalRef() {
  return useContext(SetPortalElContext);
}

// Page-side: the row-2 portal element to render a toolbar into (or null).
export function usePaneChromePortalEl() {
  return useContext(PortalElContext);
}

// Chrome-side: ref callback to register the pane's footer element.
export function usePaneChromeFooterRef() {
  return useContext(SetFooterElContext);
}
// Page-side: the footer portal element to render a bottom bar into (or null).
export function usePaneChromeFooterEl() {
  return useContext(FooterElContext);
}

// Page-side: publish chrome extras while mounted (cleared on unmount).
export function usePaneChromeSlot({ description = null } = {}) {
  const setSlot = useContext(SlotSetContext);
  useEffect(() => {
    setSlot({ description: description ?? null });
    return () => setSlot(null);
  }, [description, setSlot]);
}
