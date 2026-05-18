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
import { useSelectedProject } from './SelectedProjectContext';
import { useNotifications } from './NotificationsContext';
import {
  getMainVersion,
  ensureBranchState,
  setBaseVersion,
  listBranchChanges,
  addBranchChange,
  discardBranchChange,
  discardAllBranchChanges,
  pushChangeRequest,
  withdrawChangeRequest,
  approveChangeRequest,
  rejectChangeRequest,
  listChangeRequests,
  getChangeRequest,
  subscribeChangeRequests,
  subscribeOwnBranchChanges,
} from '../lib/branches';

// Branch + change-request state for the currently-selected project.
//
// View model:
//   - `view` is 'main' or 'mine' — the branch the user is currently
//     looking at on the Files page. Default 'main' for everyone;
//     persists per-project in localStorage so a member toggled to
//     'mine' stays there across reloads.
//   - `mainVersion` is the project's current main-branch cursor.
//     `branchState.base_version` is the version the member last
//     pulled. When mainVersion > base_version, the UI shows a
//     "Sync to main" affordance.
//   - `pendingChanges` is the live list of the member's queued
//     edits (branch_changes rows). Realtime keeps it fresh across
//     devices. The Files page applies these as overlays on top of
//     project_files to render the member's branch view.
//   - `requests` is the change_requests visible to the caller:
//     authored by them (members) or in the project (admins).
//     Realtime keeps the inbox / status live.
//
// Action surface mirrors the lib's member-side + admin-side write
// ops, with optional toast on common failure paths.

const BranchContext = createContext(null);

const VIEW_KEY = (projectId) => `docvex:branch-view:${projectId}`;

function readCachedView(projectId) {
  if (!projectId) return 'main';
  try {
    const v = localStorage.getItem(VIEW_KEY(projectId));
    return v === 'mine' ? 'mine' : 'main';
  } catch {
    return 'main';
  }
}

export function BranchProvider({ children }) {
  const { session } = useAuth();
  const { selectedProject } = useSelectedProject();
  const { notify } = useNotifications();

  const userId    = session?.user?.id ?? null;
  const projectId = selectedProject?.id ?? null;
  // DEV OVERRIDE — paired with useHasCapability's
  // ALL_PERMISSIONS_OVERRIDE. Anyone with a role on the project is
  // treated as both member AND admin so every UI affordance is
  // unlocked. Server-side RLS still enforces. Flip the constant to
  // false to restore the real role hierarchy gates below.
  const ALL_PERMISSIONS_OVERRIDE = true;
  const role = selectedProject?.role;
  const hasAnyRole = Boolean(role);
  const isAdmin   = ALL_PERMISSIONS_OVERRIDE
    ? hasAnyRole
    : (role === 'admin' || role === 'owner');
  const isMember  = ALL_PERMISSIONS_OVERRIDE
    ? hasAnyRole
    : (role === 'member' || role === 'admin' || role === 'owner');

  const [view, setViewRaw] = useState(() => readCachedView(projectId));
  const [branchState, setBranchState] = useState(null);
  const [mainVersion, setMainVersion] = useState(0);
  const [pendingChanges, setPendingChanges] = useState([]);
  const [requests, setRequests] = useState([]);
  // Items currently sitting in the caller's OPEN change_request
  // (if any). Used by computeBranchDiff to filter out already-
  // submitted items so the Commit-changes button hides after a
  // successful push. Lazy-fetched on open-request changes + after a
  // successful merge-push via refreshOpenRequestItems().
  const [openOwnRequestItems, setOpenOwnRequestItems] = useState([]);
  const [loading, setLoading] = useState(false);

  // Admin's "preferred version" selections on the Pending Edits
  // tree — Map<fileKey, versionKey>. One preferred version per
  // file; toggling the same key clears it. Lifted into context so
  // the selection persists across tab switches and component
  // remounts inside the dashboard. Cleared automatically on
  // project switch via the reset effect below.
  const [preferredVersions, setPreferredVersions] = useState(new Map());

  const togglePreferredVersion = useCallback((fileKey, versionKey) => {
    if (!fileKey || !versionKey) return;
    setPreferredVersions((prev) => {
      const next = new Map(prev);
      if (next.get(fileKey) === versionKey) next.delete(fileKey);
      else next.set(fileKey, versionKey);
      return next;
    });
  }, []);

  const clearPreferredVersions = useCallback(() => {
    setPreferredVersions(new Map());
  }, []);

  // Re-read the cached view whenever the project changes — the key
  // is per-project so two projects can have different defaults.
  // Also clear any "preferred version" picks; those are per-project
  // and meaningless against the new project's open requests.
  useEffect(() => {
    setViewRaw(readCachedView(projectId));
    setPreferredVersions(new Map());
  }, [projectId]);

  const setView = useCallback((next) => {
    setViewRaw(next);
    if (!projectId) return;
    try { localStorage.setItem(VIEW_KEY(projectId), next); }
    catch { /* private-mode etc. */ }
  }, [projectId]);

  // Initial load + reload-on-project-change. Pulls main_version,
  // branch row (lazy-creating it if missing), pending changes, and
  // the requests visible to the caller in parallel.
  const refresh = useCallback(async () => {
    if (!projectId || !userId) {
      setBranchState(null);
      setMainVersion(0);
      setPendingChanges([]);
      setRequests([]);
      return;
    }
    setLoading(true);
    try {
      const [
        { data: mainV },
        { data: branch },
        { data: changes },
        { data: reqs },
      ] = await Promise.all([
        getMainVersion(projectId),
        // ensureBranchState only mutates when a row is missing, which
        // is the common first-time-load case. Cheap idempotent op.
        isMember ? ensureBranchState(projectId, userId) : Promise.resolve({ data: null }),
        isMember ? listBranchChanges(projectId)         : Promise.resolve({ data: [] }),
        listChangeRequests(projectId),
      ]);
      setMainVersion(mainV ?? 0);
      setBranchState(branch);
      setPendingChanges(changes || []);
      setRequests(reqs || []);

      // Auto-heal stale base_version. If the user has nothing pending
      // and no open request authored by them, but DOES have at least
      // one approved authored request, the simplest explanation for
      // mainVersion > base_version is "my own approval bumped main
      // and the cursor never caught up". Reconcile silently so the
      // "New update on main" pill doesn't light up against the
      // user's own already-merged work. Trades off accuracy in
      // multi-author projects (someone else's approval after yours
      // would also be skipped), but matches the user-perceived
      // "I'm synced" reality in the typical solo flow.
      const nextMain  = mainV ?? 0;
      const baseVer   = branch?.base_version ?? 0;
      const noPending = (changes || []).length === 0;
      const hasOpenOwn     = (reqs || []).some((r) => r.author_id === userId && r.status === 'open');
      const hasApprovedOwn = (reqs || []).some((r) => r.author_id === userId && r.status === 'approved');
      if (branch && nextMain > baseVer && noPending && !hasOpenOwn && hasApprovedOwn) {
        setBaseVersion(projectId, nextMain).then(({ error }) => {
          if (error) return;
          setBranchState((prev) => (prev ? { ...prev, base_version: nextMain } : prev));
        });
      }
    } finally {
      setLoading(false);
    }
  }, [projectId, userId, isMember]);

  useEffect(() => { refresh(); }, [refresh]);

  // The id of THIS user's open request (if any). Driven by the
  // requests array — recomputes on every realtime change/insert.
  const openOwnRequestId = useMemo(() => {
    if (!userId) return null;
    const own = requests.find((r) => r.author_id === userId && r.status === 'open');
    return own?.id || null;
  }, [requests, userId]);

  // Fetch items of the open own request whenever its id changes.
  // (When the request gets approved/rejected/withdrawn, openOwnRequestId
  // flips to null and we clear the items.) Realtime doesn't cover
  // change_request_items, so we also expose refreshOpenRequestItems()
  // for callers (the commit modal post-merge push) to trigger a
  // manual re-fetch.
  const refreshOpenRequestItems = useCallback(async () => {
    if (!openOwnRequestId) {
      setOpenOwnRequestItems([]);
      return;
    }
    const { data, error } = await getChangeRequest(openOwnRequestId);
    if (error) return;
    setOpenOwnRequestItems(data?.items || []);
  }, [openOwnRequestId]);

  useEffect(() => { refreshOpenRequestItems(); }, [refreshOpenRequestItems]);

  // ── Realtime ─────────────────────────────────────────────────────────
  // Two subscriptions:
  //   • branch_changes (own only) — keeps pendingChanges live across
  //     the member's devices.
  //   • change_requests (project-wide) — admins see new submissions
  //     instantly; authors see status flips (approved/rejected) live.
  // Both unsubscribe on project switch + unmount.
  useEffect(() => {
    if (!projectId || !userId || !isMember) return undefined;
    const unsub = subscribeOwnBranchChanges(projectId, userId, (payload) => {
      const { eventType, new: newRow, old: oldRow } = payload;
      if (eventType === 'INSERT' && newRow) {
        setPendingChanges((prev) => (
          prev.some((c) => c.id === newRow.id) ? prev : [...prev, newRow]
        ));
      } else if (eventType === 'DELETE' && oldRow) {
        setPendingChanges((prev) => prev.filter((c) => c.id !== oldRow.id));
      } else if (eventType === 'UPDATE' && newRow) {
        setPendingChanges((prev) => prev.map((c) => (c.id === newRow.id ? newRow : c)));
      }
    });
    return unsub;
  }, [projectId, userId, isMember]);

  useEffect(() => {
    if (!projectId) return undefined;
    const unsub = subscribeChangeRequests(projectId, (payload) => {
      const { eventType, new: newRow, old: oldRow } = payload;
      if (eventType === 'INSERT' && newRow) {
        setRequests((prev) => (
          prev.some((r) => r.id === newRow.id) ? prev : [newRow, ...prev]
        ));
      } else if (eventType === 'DELETE' && oldRow) {
        setRequests((prev) => prev.filter((r) => r.id !== oldRow.id));
      } else if (eventType === 'UPDATE' && newRow) {
        setRequests((prev) => prev.map((r) => (r.id === newRow.id ? newRow : r)));
        if (newRow.status === 'approved') {
          // Pull the new main_version. If this approval was OUR own
          // request, the freshly-merged main IS the state we already
          // have locally — bump base_version to the new value so
          // `isBehindMain` doesn't light up the "New update on main"
          // pill against changes the user just pushed themselves.
          getMainVersion(projectId).then(({ data }) => {
            const nextVersion = data ?? 0;
            setMainVersion(nextVersion);
            if (newRow.author_id === userId) {
              setBaseVersion(projectId, nextVersion).then(({ error }) => {
                if (error) return;
                setBranchState((prev) => (
                  prev ? { ...prev, base_version: nextVersion } : prev
                ));
              });
            }
          });
        }
      }
    });
    return unsub;
  }, [projectId, userId]);

  // ── Derived overlay ──────────────────────────────────────────────────
  // Map keyed by target file id to the change that affects it. Used
  // by the Files page to render Modified / Deleted badges and by
  // FileDetailModal to show proposed values in the 'mine' view.
  // Adds aren't in this map (they have no target_file_id); they're
  // exposed separately as addedChanges.
  const overlayByFileId = useMemo(() => {
    const map = new Map();
    for (const c of pendingChanges) {
      if (c.target_file_id) map.set(c.target_file_id, c);
    }
    return map;
  }, [pendingChanges]);

  const addedChanges = useMemo(
    () => pendingChanges.filter((c) => c.kind === 'add'),
    [pendingChanges],
  );

  const isBehindMain = Boolean(branchState && mainVersion > (branchState.base_version ?? 0));

  // ── Action wrappers ──────────────────────────────────────────────────
  // Thin wrappers around the lib calls. Centralised here so each
  // surface (Files page, FileDetailModal, ChangeRequestsView) calls
  // through the same path and we can layer cross-cutting concerns
  // (notify on failure, optimistic updates) in one place.
  //
  // All three writers apply OPTIMISTIC updates: the local
  // pendingChanges state is mutated synchronously so the UI reflects
  // the action before the server round-trip completes. The realtime
  // subscription above acts as reconciliation — when the echo arrives
  // it sees the row already present (matched by id after replace) and
  // skips. On server failure the optimistic mutation is rolled back.
  const queueChange = useCallback(async (patch) => {
    if (!projectId || !userId) return { error: new Error('No project/user') };

    const tempId = `temp-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const tentative = {
      id: tempId,
      project_id: projectId,
      user_id: userId,
      kind: patch.kind,
      target_file_id: patch.targetFileId || null,
      proposed: patch.proposed || null,
      created_at: new Date().toISOString(),
    };
    setPendingChanges((prev) => [...prev, tentative]);

    const res = await addBranchChange({ projectId, userId, ...patch });
    if (res.error) {
      setPendingChanges((prev) => prev.filter((c) => c.id !== tempId));
    } else if (res.data) {
      // Swap the temp row for the real one so a later realtime
      // INSERT echo for the same id is a no-op (the subscribe
      // handler skips rows it already has).
      setPendingChanges((prev) => prev.map((c) => (c.id === tempId ? res.data : c)));
    }
    return res;
  }, [projectId, userId]);

  const discardChange = useCallback(async (id) => {
    if (!id) return { error: new Error('Missing id') };
    let snapshot = null;
    setPendingChanges((prev) => {
      snapshot = prev.find((c) => c.id === id) || null;
      return prev.filter((c) => c.id !== id);
    });
    const res = await discardBranchChange(id);
    if (res.error && snapshot) {
      setPendingChanges((prev) => (
        prev.some((c) => c.id === id) ? prev : [...prev, snapshot]
      ));
    }
    return res;
  }, []);

  const discardAll = useCallback(async () => {
    if (!projectId) return { data: [], error: new Error('No project') };
    let snapshot = [];
    setPendingChanges((prev) => { snapshot = prev; return []; });
    const res = await discardAllBranchChanges(projectId);
    if (res.error) setPendingChanges(snapshot);
    return res;
  }, [projectId]);

  const pushRequest = useCallback(async ({ title, description }) => {
    if (!projectId || !userId) return { data: null, error: new Error('No project/user') };
    const res = await pushChangeRequest({
      projectId,
      authorId: userId,
      title,
      description,
    });
    if (res.error) {
      notify?.({
        category: 'file',
        variant: 'error',
        title: 'Could not push changes',
        body: res.error.message || 'Try again in a moment.',
        dedupeKey: `push-error:${projectId}`,
      });
    } else {
      notify?.({
        category: 'file',
        variant: 'success',
        title: 'Changes submitted',
        body: 'An admin will review and approve or reject your push.',
        dedupeKey: `push-success:${res.data?.id}`,
      });
    }
    return res;
  }, [projectId, userId, notify]);

  const withdrawRequest = useCallback(async (id) => withdrawChangeRequest(id), []);

  const approveRequest = useCallback(async (requestId) => {
    const { data: full, error: fetchErr } = await getChangeRequest(requestId);
    if (fetchErr) return { data: null, error: fetchErr };
    const res = await approveChangeRequest(full);
    if (res.error) {
      notify?.({
        category: 'file',
        variant: 'error',
        title: 'Approval failed',
        body: res.error.message || 'Try again in a moment.',
        dedupeKey: `approve-error:${requestId}`,
      });
    } else {
      notify?.({
        category: 'file',
        variant: 'success',
        title: 'Changes approved',
        body: `"${full.title}" was merged into main.`,
        dedupeKey: `approve-success:${requestId}`,
      });
    }
    return res;
  }, [notify]);

  const rejectRequest = useCallback(async (requestId, note) => {
    const { data: full, error: fetchErr } = await getChangeRequest(requestId);
    if (fetchErr) return { error: fetchErr };
    const res = await rejectChangeRequest(full, note);
    if (res.error) {
      notify?.({
        category: 'file',
        variant: 'error',
        title: 'Reject failed',
        body: res.error.message || 'Try again in a moment.',
        dedupeKey: `reject-error:${requestId}`,
      });
    }
    return res;
  }, [notify]);

  // After the user's local folder has been synced to main, bump their
  // base_version so the Sync prompt clears.
  const acknowledgeSync = useCallback(async () => {
    if (!projectId || !branchState) return { error: null };
    const targetVersion = mainVersion;
    const { error } = await setBaseVersion(projectId, targetVersion);
    if (!error) {
      setBranchState((prev) => prev ? { ...prev, base_version: targetVersion } : prev);
    }
    return { error };
  }, [projectId, branchState, mainVersion]);

  // ── Provider value ───────────────────────────────────────────────────
  const value = useMemo(() => ({
    // State
    view,
    setView,
    branchState,
    mainVersion,
    pendingChanges,
    overlayByFileId,
    addedChanges,
    requests,
    openOwnRequestItems,
    isBehindMain,
    isAdmin,
    isMember,
    loading,
    preferredVersions,
    // Actions
    queueChange,
    discardChange,
    discardAll,
    pushRequest,
    withdrawRequest,
    approveRequest,
    rejectRequest,
    acknowledgeSync,
    refreshOpenRequestItems,
    refresh,
    togglePreferredVersion,
    clearPreferredVersions,
  }), [
    view, setView, branchState, mainVersion, pendingChanges,
    overlayByFileId, addedChanges, requests, openOwnRequestItems,
    isBehindMain, isAdmin, isMember, loading, preferredVersions,
    queueChange, discardChange, discardAll, pushRequest, withdrawRequest,
    approveRequest, rejectRequest, acknowledgeSync,
    refreshOpenRequestItems, refresh,
    togglePreferredVersion, clearPreferredVersions,
  ]);

  return (
    <BranchContext.Provider value={value}>
      {children}
    </BranchContext.Provider>
  );
}

export function useBranch() {
  const ctx = useContext(BranchContext);
  if (!ctx) throw new Error('useBranch must be used inside <BranchProvider>');
  return ctx;
}
