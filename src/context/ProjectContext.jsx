import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { getProject, listMembers } from '../lib/projects';

// Scoped to a single /projects/:projectId subtree. Mounted by App.jsx only
// inside the project routes so unrelated pages (Dashboard, Account, Updates)
// don't pay the cost of a project fetch + Realtime channel.
//
// State: { project, role, members, loading, error, refresh }.
//   - project    — full row from public.projects, null while loading/error
//   - role       — caller's role on this project: 'owner'|'admin'|'member'|'viewer'|null
//   - members    — array of { user_id, role, added_at, profile } from listMembers()
//   - loading    — true during the initial fetch (refresh() doesn't flip this)
//   - error      — Error from the initial fetch, null on success
//   - refresh()  — manual re-fetch trigger; useful after mutations that don't
//                  themselves come through Realtime (e.g. updateMemberRole
//                  triggers a Realtime UPDATE event, but a Dashboard rename
//                  needs a manual refresh for the name to update locally).

const ProjectContext = createContext(null);

export function ProjectProvider({ children }) {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [role, setRole] = useState(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Use a ref instead of state for the cancel flag so we don't re-render on
  // it. The effect captures the ref and can check `cancelledRef.current` to
  // bail out cleanly when projectId changes mid-flight.
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    cancelledRef.current = false;

    const [{ data: projData, error: projErr }, { data: memData, error: memErr }] = await Promise.all([
      getProject(projectId),
      listMembers(projectId),
    ]);
    if (cancelledRef.current) return;

    if (projErr) {
      setError(projErr);
      setProject(null);
      setRole(null);
      setMembers([]);
      setLoading(false);
      return;
    }

    setProject(projData);
    setRole(projData?.role ?? null);
    setMembers(memErr ? [] : (memData || []));
    setError(null);
    setLoading(false);
  }, [projectId]);

  // Initial load when projectId changes. Reset loading so the consumer can
  // distinguish "no project yet" from "switched projects".
  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    setError(null);
    load();
    return () => { cancelledRef.current = true; };
  }, [projectId, load]);

  // Realtime subscriptions — project row + membership list. Same pattern as
  // notificationsRepo.subscribeForUser, scoped to one channel per project.
  // Updates the local state in-place rather than re-fetching; cheaper for the
  // happy path of "another admin promoted someone".
  useEffect(() => {
    if (!projectId) return;
    const channel = supabase
      .channel(`project:${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'projects', filter: `id=eq.${projectId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            setProject(null);
            setError(new Error('Project was deleted'));
          } else if (payload.new) {
            setProject((prev) => (prev ? { ...prev, ...payload.new } : payload.new));
          }
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'project_members', filter: `project_id=eq.${projectId}` },
        // Member changes can affect counts, roles, and the caller's own role.
        // Easier and more correct to re-fetch the full member list than to
        // patch by user_id (the payload doesn't include the profile join).
        () => { load(); },
      )
      .subscribe();

    return () => { try { supabase.removeChannel(channel); } catch { /* non-fatal */ } };
  }, [projectId, load]);

  // Public refresh — same as the effect's load(), but exposed so pages can
  // re-pull after a mutation (e.g. updateProject from the Settings page).
  // Doesn't flip `loading` so the UI doesn't flicker.
  const refresh = useCallback(async () => { await load(); }, [load]);

  const value = useMemo(
    () => ({ project, role, members, loading, error, refresh }),
    [project, role, members, loading, error, refresh],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used inside <ProjectProvider>');
  return ctx;
}
