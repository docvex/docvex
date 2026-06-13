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

// Grid dimensions per layout (how many resizable columns / rows it has). Drives
// the default pane-size vectors and which drag gutters SplitContainer renders.
export const LAYOUT_DIMS = {
  single:       { cols: 1, rows: 1 },
  vertical:     { cols: 2, rows: 1 },
  horizontal:   { cols: 1, rows: 2 },
  tri:          { cols: 2, rows: 2 },
  'tri-right':  { cols: 2, rows: 2 },
  'tri-bottom': { cols: 2, rows: 2 },
  'tri-left':   { cols: 2, rows: 2 },
  quad:         { cols: 2, rows: 2 },
};

// Default (even) pane sizes for a layout: an N-length vector of equal fractions
// per axis. SplitContainer renders these as `Nfr Nfr` grid templates.
export function defaultSizesFor(layout) {
  const d = LAYOUT_DIMS[layout] || { cols: 1, rows: 1 };
  return { cols: Array(d.cols).fill(1), rows: Array(d.rows).fill(1) };
}

// Coerce a saved/loaded size vector back to something valid for `layout`
// (right length, all positive); falls back to the even default on mismatch.
export function sanitizeSizes(layout, sizes) {
  const def = defaultSizesFor(layout);
  if (!sizes || !Array.isArray(sizes.cols) || !Array.isArray(sizes.rows)) return def;
  if (sizes.cols.length !== def.cols.length || sizes.rows.length !== def.rows.length) return def;
  const clean = (arr) => arr.map((n) => (Number.isFinite(n) && n > 0 ? n : 1));
  return { cols: clean(sizes.cols), rows: clean(sizes.rows) };
}

// ── Custom (user-named) layouts ────────────────────────────────────────────
// A custom layout is a base arrangement (one of the SPLIT_LAYOUTS ids,
// orientation included for the "T") PLUS the pane sizes the user dragged to,
// saved under a name they pick, so they can name + recall the split they like
// ("Review", "Docs + chat", …). Persisted in localStorage like other docvex.*
// prefs. (v2 added per-pane `sizes`; v1 entries with no sizes load as even.)
const CUSTOM_LAYOUTS_KEY = 'docvex.customLayouts.v1';

function readCustomLayouts() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_LAYOUTS_KEY) || '[]');
    // Drop entries whose base layout no longer exists (forward-compat), and
    // normalise the saved sizes against the layout's current grid dims.
    return Array.isArray(raw)
      ? raw
        .filter((c) => c && c.id && c.name && SPLIT_LAYOUTS[c.layout])
        .map((c) => ({ ...c, sizes: sanitizeSizes(c.layout, c.sizes) }))
      : [];
  } catch { return []; }
}

function makeLayoutId() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return `cl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// The whole split arrangement persists so it survives an app restart / project
// switch: the current layout + pane sizes + which custom layout is active, the
// last non-single arrangement (for the sidebar "Project" tab), and each pane's
// last-open route (so every window reopens to the tab it was on).
const SPLIT_STATE_KEY = 'docvex.splitView.v1';
function readSplitState() {
  try {
    const s = JSON.parse(localStorage.getItem(SPLIT_STATE_KEY) || '{}');
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; }
}

const SplitViewContext = createContext(null);

export function SplitViewProvider({ children }) {
  // Restore the persisted arrangement (read once at mount).
  const persisted = useRef(readSplitState()).current;
  const initialLayout = SPLIT_LAYOUTS[persisted.layout] ? persisted.layout : 'tri-right';

  // Default arrangement: the "T" with the big pane on the RIGHT and two panes
  // stacked on the LEFT (tri-right). Users can switch back to single / other
  // layouts from the title-bar split control. Restored from localStorage so the
  // last selected layout comes back on reopen.
  const [layout, setLayout] = useState(initialLayout);
  // The pane the shared chrome considers "active" (gets the accent ring), and
  // the pane the sidebar drives (see navigateFocusedPane below).
  const [focusedPane, setFocusedPane] = useState(0);

  const paneCount = SPLIT_LAYOUTS[layout]?.panes || 1;

  // Per-pane sizes for the CURRENT arrangement (column + row fraction vectors),
  // driven live by the drag gutters in SplitContainer. Reset to even whenever
  // the base layout changes; replaced wholesale when a custom layout is applied.
  const [paneSizes, setPaneSizes] = useState(() => sanitizeSizes(initialLayout, persisted.paneSizes));
  // Which saved custom layout (if any) is currently applied — so the title bar
  // can name it and "Update layout" knows what to overwrite.
  const [activeCustomLayoutId, setActiveCustomLayoutId] = useState(persisted.activeCustomLayoutId || null);
  // Each pane's last-open route, keyed by pane index (0 = primary), so a window
  // reopens to the tab it was on (not the layout's generic seed). Survives pane
  // unmount (unlike `panePaths` below, which is cleared on unregister).
  const [paneSeeds, setPaneSeeds] = useState(() => (persisted.paneSeeds && typeof persisted.paneSeeds === 'object' ? persisted.paneSeeds : {}));
  // Bumped each time a custom layout is applied, so SplitContainer can remount
  // the panes (to adopt the saved tabs) + re-point the primary window even when
  // the base layout id didn't change.
  const [applyToken, setApplyToken] = useState(0);

  // ── Per-pane refresh ────────────────────────────────────────────────────
  // Bumping a pane's nonce remounts that pane's routed content (the chrome's
  // refresh button + F5 on the focused pane). Keyed by pane index so refreshing
  // one window never disturbs the others.
  const [refreshNonces, setRefreshNonces] = useState({});
  const refreshPane = useCallback((index) => {
    setRefreshNonces((prev) => ({ ...prev, [index]: (prev[index] || 0) + 1 }));
  }, []);
  const refreshFocusedPane = useCallback(() => {
    setRefreshNonces((prev) => ({ ...prev, [focusedPane]: (prev[focusedPane] || 0) + 1 }));
  }, [focusedPane]);

  const changeLayout = useCallback((next) => {
    if (!SPLIT_LAYOUTS[next]) return;
    setLayout(next);
    // Clamp focus into the new pane range (e.g. quad→single drops to pane 0).
    setFocusedPane((p) => Math.min(p, (SPLIT_LAYOUTS[next].panes || 1) - 1));
    // A base-layout pick resets sizes to even and is no longer "a saved layout".
    setPaneSizes(defaultSizesFor(next));
    setActiveCustomLayoutId(null);
  }, []);

  // Live pane-resize from the drag gutters (does NOT clear the active custom
  // layout — the user can then "Update layout" to bake the new sizes in).
  const resizePanes = useCallback((next) => { setPaneSizes(next); }, []);

  // Remember the last SPLIT (non-single) ARRANGEMENT — layout + sizes + active
  // custom id — so the top app-nav bar's "Project" tab restores the full
  // workspace (not just the base layout) after a personal page collapsed it to
  // a single fullscreen window. Seeded from persistence so it survives reload.
  const lastSplitRef = useRef(
    persisted.lastSplit && SPLIT_LAYOUTS[persisted.lastSplit.layout] && persisted.lastSplit.layout !== 'single'
      ? { layout: persisted.lastSplit.layout, sizes: sanitizeSizes(persisted.lastSplit.layout, persisted.lastSplit.sizes), customId: persisted.lastSplit.customId || null }
      : { layout: 'tri-right', sizes: defaultSizesFor('tri-right'), customId: null },
  );
  useEffect(() => {
    if (layout !== 'single') lastSplitRef.current = { layout, sizes: paneSizes, customId: activeCustomLayoutId };
  }, [layout, paneSizes, activeCustomLayoutId]);
  const restoreSplit = useCallback(() => {
    const snap = lastSplitRef.current;
    const target = snap && snap.layout && snap.layout !== 'single'
      ? snap
      : { layout: 'tri-right', sizes: defaultSizesFor('tri-right'), customId: null };
    setLayout(target.layout);
    setFocusedPane((p) => Math.min(p, (SPLIT_LAYOUTS[target.layout].panes || 1) - 1));
    setPaneSizes(sanitizeSizes(target.layout, target.sizes));
    setActiveCustomLayoutId(target.customId || null);
  }, []);

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
    // Remember this pane's route as its seed for next time (persisted), so the
    // window reopens to the same tab. Kept separate from `panePaths` so it
    // isn't wiped when the pane unmounts on a layout change.
    if (path) setPaneSeeds((prev) => (prev[index] === path ? prev : { ...prev, [index]: path }));
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

  // Persist the whole arrangement (current layout + sizes + active custom id +
  // last split + per-pane seeds) so it's restored on the next app launch /
  // project open.
  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_STATE_KEY, JSON.stringify({
        layout,
        paneSizes,
        activeCustomLayoutId,
        lastSplit: lastSplitRef.current,
        paneSeeds,
      }));
    } catch { /* quota / private mode */ }
  }, [layout, paneSizes, activeCustomLayoutId, paneSeeds]);

  // ── Custom layouts ────────────────────────────────────────────────────────
  const [customLayouts, setCustomLayouts] = useState(readCustomLayouts);
  useEffect(() => {
    try { localStorage.setItem(CUSTOM_LAYOUTS_KEY, JSON.stringify(customLayouts)); } catch { /* quota / private mode */ }
  }, [customLayouts]);

  // Save the CURRENT arrangement (base layout + dragged pane sizes) under a
  // name. Returns the new entry (or null for an empty name), and marks it the
  // active custom layout so the title bar names it immediately.
  const addCustomLayout = useCallback((name) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return null;
    // Snapshot the WHOLE selection: arrangement + sizes + which tab each window
    // is on (paneSeeds), so applying it later restores all three.
    const entry = { id: makeLayoutId(), name: trimmed.slice(0, 40), layout, sizes: paneSizes, seeds: { ...paneSeeds } };
    setCustomLayouts((prev) => [...prev, entry]);
    setActiveCustomLayoutId(entry.id);
    return entry;
  }, [layout, paneSizes, paneSeeds]);

  // Apply a saved custom layout — restore its base arrangement, pane sizes AND
  // the per-window tabs, and remember it as the active one. Bumping applyToken
  // forces the panes to remount (so they adopt the saved tabs even when the
  // base layout id is unchanged).
  const applyCustomLayout = useCallback((entry) => {
    if (!entry || !SPLIT_LAYOUTS[entry.layout]) return;
    setLayout(entry.layout);
    setFocusedPane((p) => Math.min(p, (SPLIT_LAYOUTS[entry.layout].panes || 1) - 1));
    setPaneSizes(sanitizeSizes(entry.layout, entry.sizes));
    if (entry.seeds && typeof entry.seeds === 'object') setPaneSeeds({ ...entry.seeds });
    setActiveCustomLayoutId(entry.id);
    setApplyToken((t) => t + 1);
  }, []);

  // Overwrite a saved custom layout with the CURRENT selection (arrangement +
  // sizes + tabs) — the "Update layout" affordance.
  const updateCustomLayout = useCallback((id) => {
    setCustomLayouts((prev) => prev.map((c) => (c.id === id ? { ...c, layout, sizes: paneSizes, seeds: { ...paneSeeds } } : c)));
    setActiveCustomLayoutId(id);
  }, [layout, paneSizes, paneSeeds]);

  // Rename a saved custom layout (the "Edit" affordance).
  const renameCustomLayout = useCallback((id, name) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    setCustomLayouts((prev) => prev.map((c) => (c.id === id ? { ...c, name: trimmed.slice(0, 40) } : c)));
  }, []);

  const removeCustomLayout = useCallback((id) => {
    setCustomLayouts((prev) => prev.filter((c) => c.id !== id));
    setActiveCustomLayoutId((cur) => (cur === id ? null : cur));
  }, []);

  const activeCustomLayout = useMemo(
    () => customLayouts.find((c) => c.id === activeCustomLayoutId) || null,
    [customLayouts, activeCustomLayoutId],
  );

  const value = useMemo(() => ({
    layout,
    setLayout: changeLayout,
    restoreSplit,
    paneCount,
    paneSizes,
    resizePanes,
    paneSeeds,
    applyToken,
    focusedPane,
    setFocusedPane,
    registerPaneNavigator,
    reportPanePath,
    navigateFocusedPane,
    focusedPanePath,
    refreshNonces,
    refreshPane,
    refreshFocusedPane,
    customLayouts,
    addCustomLayout,
    applyCustomLayout,
    updateCustomLayout,
    renameCustomLayout,
    removeCustomLayout,
    activeCustomLayout,
  }), [layout, changeLayout, restoreSplit, paneCount, paneSizes, resizePanes, paneSeeds, applyToken, focusedPane, registerPaneNavigator, reportPanePath, navigateFocusedPane, focusedPanePath, refreshNonces, refreshPane, refreshFocusedPane, customLayouts, addCustomLayout, applyCustomLayout, updateCustomLayout, renameCustomLayout, removeCustomLayout, activeCustomLayout]);

  return <SplitViewContext.Provider value={value}>{children}</SplitViewContext.Provider>;
}

export function useSplitView() {
  const ctx = useContext(SplitViewContext);
  if (!ctx) throw new Error('useSplitView must be used within <SplitViewProvider>');
  return ctx;
}
