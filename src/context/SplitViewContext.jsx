import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

// Split-view layout state. Drives the title-bar split control and the
// SplitContainer that tiles the main content area into independent,
// separately-navigable panes (each its own MemoryRouter). Electron-only in
// practice (the title-bar control is the only way to change layout, and the
// title bar is Electron-only); on web the layout stays 'single', so the
// SplitContainer is a transparent pass-through.

// Each layout id → how many panes it renders. The grid placement per id lives
// in SplitView.css (keyed off `.sv-<id>`). The "T" (3-pane) layout has four
// rotational variants — the single full-span pane points top / right / bottom
// / left — but they all share the same "Split T" label since the title-bar
// control treats them as one entry with a rotate affordance.
export const SPLIT_LAYOUTS = {
  single:       { panes: 1, label: 'Single window' },
  vertical:     { panes: 2, label: 'Split vertical' },
  horizontal:   { panes: 2, label: 'Split horizontal' },
  tri:          { panes: 3, label: 'Split T' },
  'tri-right':  { panes: 3, label: 'Split T' },
  'tri-bottom': { panes: 3, label: 'Split T' },
  'tri-left':   { panes: 3, label: 'Split T' },
  quad:         { panes: 4, label: 'Four panes' },
};

// The 3-pane "T" in its four 90° rotations, in CLOCKWISE order. `tri` (the
// single pane spanning the TOP) is the entry orientation; each step turns the
// spanning pane one quarter-turn clockwise: top → right → bottom → left.
export const TRI_ORIENTATIONS = ['tri', 'tri-right', 'tri-bottom', 'tri-left'];
export const isTriLayout = (id) => TRI_ORIENTATIONS.includes(id);

// Rotate a "T" layout by `dir` quarter-turns (+1 clockwise, -1 counter-
// clockwise). Non-tri ids pass through unchanged so callers can apply it
// blindly to the current layout.
export function rotateTri(id, dir = 1) {
  const i = TRI_ORIENTATIONS.indexOf(id);
  if (i === -1) return id;
  const n = TRI_ORIENTATIONS.length;
  return TRI_ORIENTATIONS[(i + dir + n) % n];
}

// ── Custom (user-named) layouts ────────────────────────────────────────────
// A custom layout is just a base arrangement (one of the SPLIT_LAYOUTS ids,
// orientation included for the "T") saved under a name the user picks, so they
// can name + recall the split they like ("Review", "Docs + chat", …). Persisted
// in localStorage like the other docvex.* prefs.
const CUSTOM_LAYOUTS_KEY = 'docvex.customLayouts.v1';

function readCustomLayouts() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_LAYOUTS_KEY) || '[]');
    // Drop entries whose base layout no longer exists (forward-compat).
    return Array.isArray(raw) ? raw.filter((c) => c && c.id && c.name && SPLIT_LAYOUTS[c.layout]) : [];
  } catch { return []; }
}

function makeLayoutId() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return `cl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const SplitViewContext = createContext(null);

export function SplitViewProvider({ children }) {
  // Default arrangement: the "T" with the big pane on the RIGHT and two panes
  // stacked on the LEFT (tri-right). Users can switch back to single / other
  // layouts from the title-bar split control.
  const [layout, setLayout] = useState('tri-right');
  // The pane the shared chrome considers "active" (gets the accent ring), and
  // the pane the sidebar drives (see navigateFocusedPane below).
  const [focusedPane, setFocusedPane] = useState(0);

  const paneCount = SPLIT_LAYOUTS[layout]?.panes || 1;

  const changeLayout = useCallback((next) => {
    if (!SPLIT_LAYOUTS[next]) return;
    setLayout(next);
    // Clamp focus into the new pane range (e.g. quad→single drops to pane 0).
    setFocusedPane((p) => Math.min(p, (SPLIT_LAYOUTS[next].panes || 1) - 1));
  }, []);

  // Remember the last SPLIT (non-single) layout so the top app-nav bar's
  // "Project" tab can restore the workspace after a personal page collapsed it
  // to a single fullscreen window. Defaults to the entry "T" arrangement.
  const lastSplitRef = useRef('tri-right');
  useEffect(() => {
    if (layout !== 'single') lastSplitRef.current = layout;
  }, [layout]);
  const restoreSplit = useCallback(() => {
    const target = lastSplitRef.current && lastSplitRef.current !== 'single' ? lastSplitRef.current : 'tri-right';
    changeLayout(target);
  }, [changeLayout]);

  // ── Per-pane navigation bridge ──────────────────────────────────────────
  // Each SECONDARY pane (index ≥ 1) runs its own MemoryRouter, so its
  // navigate() isn't reachable from the sidebar (which lives on the root
  // router). Panes register their navigate fn here keyed by index; the sidebar
  // then drives whichever pane is focused. The primary pane (index 0) IS the
  // root router, so it's never registered — navigateFocusedPane returns false
  // for it and the caller falls back to its normal root navigation.
  const navigatorsRef = useRef(new Map());
  // Current pathname per registered pane, so the sidebar can highlight the tab
  // the focused window is actually on.
  const [panePaths, setPanePaths] = useState({});

  const registerPaneNavigator = useCallback((index, navigate) => {
    navigatorsRef.current.set(index, navigate);
    return () => {
      navigatorsRef.current.delete(index);
      setPanePaths((prev) => {
        if (!(index in prev)) return prev;
        const next = { ...prev };
        delete next[index];
        return next;
      });
    };
  }, []);

  const reportPanePath = useCallback((index, path) => {
    setPanePaths((prev) => (prev[index] === path ? prev : { ...prev, [index]: path }));
  }, []);

  // Navigate the focused window. Returns true when a secondary pane handled it
  // (so the caller suppresses its own root navigation); false when the primary
  // pane is focused (caller should navigate the root router as usual).
  const navigateFocusedPane = useCallback((to, options) => {
    const nav = navigatorsRef.current.get(focusedPane);
    if (!nav) return false;
    nav(to, options);
    return true;
  }, [focusedPane]);

  // Pathname of the focused pane — null when the primary (root) pane is
  // focused, so the sidebar falls back to its own useLocation() for highlight.
  const focusedPanePath = focusedPane === 0 ? null : (panePaths[focusedPane] ?? null);

  // ── Custom layouts ────────────────────────────────────────────────────────
  const [customLayouts, setCustomLayouts] = useState(readCustomLayouts);
  useEffect(() => {
    try { localStorage.setItem(CUSTOM_LAYOUTS_KEY, JSON.stringify(customLayouts)); } catch { /* quota / private mode */ }
  }, [customLayouts]);

  // Save the CURRENT arrangement under a name. Returns the new entry (or null
  // for an empty name). Names aren't forced unique — the id keys the list.
  const addCustomLayout = useCallback((name) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return null;
    const entry = { id: makeLayoutId(), name: trimmed.slice(0, 40), layout };
    setCustomLayouts((prev) => [...prev, entry]);
    return entry;
  }, [layout]);

  const removeCustomLayout = useCallback((id) => {
    setCustomLayouts((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const value = useMemo(() => ({
    layout,
    setLayout: changeLayout,
    restoreSplit,
    paneCount,
    focusedPane,
    setFocusedPane,
    registerPaneNavigator,
    reportPanePath,
    navigateFocusedPane,
    focusedPanePath,
    customLayouts,
    addCustomLayout,
    removeCustomLayout,
  }), [layout, changeLayout, restoreSplit, paneCount, focusedPane, registerPaneNavigator, reportPanePath, navigateFocusedPane, focusedPanePath, customLayouts, addCustomLayout, removeCustomLayout]);

  return <SplitViewContext.Provider value={value}>{children}</SplitViewContext.Provider>;
}

export function useSplitView() {
  const ctx = useContext(SplitViewContext);
  if (!ctx) throw new Error('useSplitView must be used within <SplitViewProvider>');
  return ctx;
}
