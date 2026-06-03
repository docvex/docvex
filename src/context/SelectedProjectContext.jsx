import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';
import { getProject } from '../lib/projects';
import { markProjectAccessed } from '../lib/recentProjects';

// Tracks which project the user is "working in" right now. Distinct from
// ProjectContext (which is URL-scoped, used inside /projects/:projectId):
// SelectedProjectContext is global state — drives the project-scoped sidebar
// items (Files, To-dos) and the top-of-screen "Working in X" banner.
//
// Persists in localStorage keyed per user_id so two accounts on the same
// machine don't see each other's selection. On sign-out the selection is
// dropped from memory (the localStorage row stays so a future re-login picks
// up where the user left off).
//
// Auto-clears (in memory and storage) when the selected project can no
// longer be fetched — the project was deleted or the user lost access.

const STORAGE_KEY_PREFIX = 'docvex.selectedProject.';

const SelectedProjectContext = createContext(null);

function storageKey(userId) {
  return STORAGE_KEY_PREFIX + (userId || '_anonymous');
}

// Minimum on-screen time for the switching-project loader. The actual
// state/route swap usually completes well under this — the floor makes the
// transition read as deliberate rather than flickery, regardless of how fast
// the new project's fetch resolves.
const SWITCH_LOADER_MIN_MS = 1000;

export function SelectedProjectProvider({ children }) {
  const { session, loading: authLoading } = useAuth();
  const userId = session?.user?.id || null;

  // _setSelectedProjectId is the raw setter; selectProject() is the public
  // API that also writes to localStorage.
  const [selectedProjectId, _setSelectedProjectId] = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [loading, setLoading] = useState(false);
  // Open/closed state of the project-picker drawer. Lives here (not in
  // Sidebar local state) so callers outside the sidebar — the ProjectBanner's
  // "Switch" button, e.g. — can also trigger it.
  const [pickerOpen, setPickerOpen] = useState(false);
  // True while a project-switch is in progress — drives the full-screen
  // SwitchProjectLoader overlay. Set by beginSwitch(), auto-cleared after
  // SWITCH_LOADER_MIN_MS. The sidebar's z-index is higher than the loader's,
  // so it stays visible/interactive (user can keep clicking around) while
  // the rest of the page is masked.
  const [switching, setSwitching] = useState(false);
  // Target name for the loader subtitle ("Switching to <name>"). Null when
  // the switch is a clear ("Select no project") — the loader falls back to
  // its no-name copy in that case.
  const [switchingToName, setSwitchingToName] = useState(null);
  const switchingTimerRef = useRef(null);

  // Tracks the user-id we last hydrated for. Prevents a re-mount from
  // clobbering an in-flight selection when only the user_id reference is
  // stable but auth-loading hasn't settled yet.
  const hydratedForUserRef = useRef(null);

  // Optionally seeded by selectProject(id, prefetched) — when the caller
  // already has the full project row (e.g. ProjectPickerPanel handing us the
  // exact row the user just clicked), we skip the redundant getProject()
  // round-trip and use the prefetched data directly. Consumed once, then
  // cleared so a later id change can't accidentally reuse stale data.
  const prefetchedProjectRef = useRef(null);

  // Hydrate selection from localStorage when the user changes.
  useEffect(() => {
    if (authLoading) return;
    if (hydratedForUserRef.current === userId) return;
    hydratedForUserRef.current = userId;

    if (!userId) {
      _setSelectedProjectId(null);
      setSelectedProject(null);
      return;
    }
    try {
      // A project window boots with ?openProject=<id> — prefer it as the
      // initial selection so global-selection pages (Files, Chat, To-dos)
      // resolve to THIS window's project instead of the last-used one.
      let openParam = null;
      try { openParam = new URLSearchParams(window.location.search).get('openProject'); }
      catch { /* no window.location (SSR/tests) */ }
      const stored = localStorage.getItem(storageKey(userId));
      _setSelectedProjectId(openParam || stored || null);
    } catch {
      _setSelectedProjectId(null);
    }
  }, [userId, authLoading]);

  // Fetch project details whenever the id changes. Drops the selection if
  // the project no longer exists or the user lost access (getProject returns
  // an error or null) — keeps the sidebar/banner honest with reality.
  //
  // Fast path: when selectProject was called with a prefetched row (the
  // picker already has it from listMyProjects), use it directly and skip the
  // network. The ref is consumed once so a later mismatched id falls back to
  // a real fetch.
  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedProject(null);
      return;
    }
    const cached = prefetchedProjectRef.current;
    prefetchedProjectRef.current = null;
    if (cached && cached.id === selectedProjectId) {
      setSelectedProject(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getProject(selectedProjectId).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data) {
        _setSelectedProjectId(null);
        setSelectedProject(null);
        if (userId) {
          try { localStorage.removeItem(storageKey(userId)); } catch { /* ignore */ }
        }
        setLoading(false);
        return;
      }
      setSelectedProject(data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedProjectId, userId]);

  // selectProject(id, prefetched?) — if the caller has the full project row,
  // passing it as the second arg lets the fetch effect short-circuit. The
  // ProjectAutoSelect in App.jsx passes only the id (it doesn't have the
  // row) and falls through to the normal fetch path.
  const selectProject = useCallback((id, prefetched = null) => {
    if (prefetched && prefetched.id === id) {
      prefetchedProjectRef.current = prefetched;
    }
    _setSelectedProjectId(id || null);
    if (!userId) return;
    try {
      if (id) localStorage.setItem(storageKey(userId), id);
      else    localStorage.removeItem(storageKey(userId));
    } catch { /* private mode / quota — non-fatal */ }
    // Stamp the recency map so the "Most recent" badge + the
    // sort-to-top behavior in project lists tracks every selection.
    // Skips on clear (id == null) — clearing isn't an access event.
    // Pass the prefetched name when available so the sidebar bookmark
    // row can render meaningful copy without an extra fetch.
    if (id) markProjectAccessed(userId, id, prefetched?.name ?? null);
  }, [userId]);

  const clearSelection = useCallback(() => selectProject(null), [selectProject]);

  // Merge a partial patch into the currently-selected project row when the
  // patch is for THIS selection. Used by mutation sites (e.g. project
  // rename in ProjectOverview) to push the new field values into the
  // sidebar trigger + ProjectBanner immediately, without waiting for the
  // next id-change to re-fetch the row from the server. No-ops if no
  // project is selected, or if `patch.id` is present and doesn't match
  // the current selection — keeps the caller from accidentally patching
  // a different project's row into this slot.
  const patchSelectedProject = useCallback((patch) => {
    if (!patch) return;
    setSelectedProject((prev) => {
      if (!prev) return prev;
      if (patch.id && patch.id !== prev.id) return prev;
      return { ...prev, ...patch };
    });
  }, []);

  const openPicker   = useCallback(() => setPickerOpen(true),     []);
  const closePicker  = useCallback(() => setPickerOpen(false),    []);
  // Toggle is what the sidebar trigger button and the banner's Switch
  // button bind to — clicking the SAME button that opened the picker now
  // closes it instead of being a no-op (which previously felt unresponsive).
  const togglePicker = useCallback(() => setPickerOpen((v) => !v), []);

  // Trigger the switching-project loader. Idempotent: a second call while
  // the loader is already up extends the floor by another SWITCH_LOADER_MIN_MS
  // (the old timer is cancelled), so rapid double-clicks don't yo-yo the
  // overlay. Caller invokes this RIGHT BEFORE the state mutation + navigate
  // so the overlay is up before any in-flight render flash.
  //
  // `name` is the target project name — surfaced as "Switching to <name>"
  // in the overlay subtitle. Pass null for a clear-selection switch; the
  // loader renders generic copy in that case.
  const beginSwitch = useCallback((name = null) => {
    setSwitching(true);
    setSwitchingToName(name);
    if (switchingTimerRef.current) clearTimeout(switchingTimerRef.current);
    switchingTimerRef.current = setTimeout(() => {
      setSwitching(false);
      // Keep switchingToName until next beginSwitch so the label doesn't
      // visibly blank-out as the overlay fades — the consumer hides itself
      // on `switching === false` so the stale name never renders again.
      switchingTimerRef.current = null;
    }, SWITCH_LOADER_MIN_MS);
  }, []);

  // Cleanup on unmount so a pending timer doesn't fire against a torn-down
  // tree (rare — the provider lives for the app's lifetime — but cheap).
  useEffect(() => () => {
    if (switchingTimerRef.current) clearTimeout(switchingTimerRef.current);
  }, []);

  const value = useMemo(() => ({
    selectedProjectId,
    selectedProject,
    loading,
    selectProject,
    clearSelection,
    patchSelectedProject,
    pickerOpen,
    openPicker,
    closePicker,
    togglePicker,
    switching,
    switchingToName,
    beginSwitch,
  }), [selectedProjectId, selectedProject, loading, selectProject, clearSelection, patchSelectedProject, pickerOpen, openPicker, closePicker, togglePicker, switching, switchingToName, beginSwitch]);

  return (
    <SelectedProjectContext.Provider value={value}>
      {children}
    </SelectedProjectContext.Provider>
  );
}

export function useSelectedProject() {
  const ctx = useContext(SelectedProjectContext);
  if (!ctx) throw new Error('useSelectedProject must be used inside <SelectedProjectProvider>');
  return ctx;
}
