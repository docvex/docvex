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

  // Tracks the user-id we last hydrated for. Prevents a re-mount from
  // clobbering an in-flight selection when only the user_id reference is
  // stable but auth-loading hasn't settled yet.
  const hydratedForUserRef = useRef(null);

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
      const stored = localStorage.getItem(storageKey(userId));
      _setSelectedProjectId(stored || null);
    } catch {
      _setSelectedProjectId(null);
    }
  }, [userId, authLoading]);

  // Fetch project details whenever the id changes. Drops the selection if
  // the project no longer exists or the user lost access (getProject returns
  // an error or null) — keeps the sidebar/banner honest with reality.
  useEffect(() => {
    if (!selectedProjectId) {
      setSelectedProject(null);
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

  const selectProject = useCallback((id) => {
    _setSelectedProjectId(id || null);
    if (!userId) return;
    try {
      if (id) localStorage.setItem(storageKey(userId), id);
      else    localStorage.removeItem(storageKey(userId));
    } catch { /* private mode / quota — non-fatal */ }
  }, [userId]);

  const clearSelection = useCallback(() => selectProject(null), [selectProject]);

  const openPicker   = useCallback(() => setPickerOpen(true),     []);
  const closePicker  = useCallback(() => setPickerOpen(false),    []);
  // Toggle is what the sidebar trigger button and the banner's Switch
  // button bind to — clicking the SAME button that opened the picker now
  // closes it instead of being a no-op (which previously felt unresponsive).
  const togglePicker = useCallback(() => setPickerOpen((v) => !v), []);

  const value = useMemo(() => ({
    selectedProjectId,
    selectedProject,
    loading,
    selectProject,
    clearSelection,
    pickerOpen,
    openPicker,
    closePicker,
    togglePicker,
  }), [selectedProjectId, selectedProject, loading, selectProject, clearSelection, pickerOpen, openPicker, closePicker, togglePicker]);

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
