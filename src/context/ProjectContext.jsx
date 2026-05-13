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
import { useAuth } from './AuthContext';

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
  const { session } = useAuth();
  const selfUserId = session?.user?.id ?? null;
  const [project, setProject] = useState(null);
  const [role, setRole] = useState(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Use a ref instead of state for the cancel flag so we don't re-render on
  // it. The effect captures the ref and can check `cancelledRef.current` to
  // bail out cleanly when projectId changes mid-flight.
  const cancelledRef = useRef(false);
  // Debounce handle for the Realtime member-changes refetch. A batch of N
  // member events (e.g. an admin bulk-importing invitations that all accept
  // around the same time) coalesces into one listMembers() call instead of N.
  const memberRefetchTimerRef = useRef(null);

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
  //
  // The `project_members` handler patches the local members array in place
  // for UPDATE (role change) and DELETE (removal). INSERT can't be patched
  // optimistically because the payload doesn't include the profile join —
  // it falls through to the debounced refetch, which also serves as a
  // catch-all reconcile to cover any patch-missed edge case (e.g. an UPDATE
  // for a user we never had in the array yet). The debounce coalesces a
  // batch of events into a single network call.
  useEffect(() => {
    if (!projectId) return;
    const refreshMembersDebounced = () => {
      if (memberRefetchTimerRef.current) clearTimeout(memberRefetchTimerRef.current);
      memberRefetchTimerRef.current = setTimeout(async () => {
        memberRefetchTimerRef.current = null;
        const { data, error: memErr } = await listMembers(projectId);
        if (cancelledRef.current) return;
        if (!memErr) setMembers(data || []);
      }, 200);
    };

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
        (payload) => {
          // Optimistic local patches so the UI reflects role/removal changes
          // immediately, without waiting for the debounced refetch. The
          // refetch then reconciles to authoritative data — covers INSERTs
          // and any UPDATE where the affected user isn't in our array yet.
          if (payload.eventType === 'UPDATE' && payload.new?.user_id) {
            const { user_id: changedId, role: newRole } = payload.new;
            setMembers((prev) =>
              prev.map((m) => (m.user_id === changedId ? { ...m, role: newRole } : m)),
            );
            // If the caller is the affected user, patch the provider's role
            // state too — keeps "I just got promoted" UI in sync without
            // waiting on the network.
            if (selfUserId && changedId === selfUserId) {
              setRole(newRole);
              setProject((prev) => (prev ? { ...prev, role: newRole } : prev));
            }
          } else if (payload.eventType === 'DELETE' && payload.old?.user_id) {
            const removedId = payload.old.user_id;
            setMembers((prev) => prev.filter((m) => m.user_id !== removedId));
          }
          refreshMembersDebounced();
        },
      )
      .subscribe();

    return () => {
      if (memberRefetchTimerRef.current) {
        clearTimeout(memberRefetchTimerRef.current);
        memberRefetchTimerRef.current = null;
      }
      try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
    };
  }, [projectId, selfUserId]);

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
