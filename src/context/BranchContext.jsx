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
  // legacy DB-side branch_changes helpers — used ONLY by the one-time
  // migration sweep on first load post-Phase 2. Reads existing rows,
  // dumps them into localStorage, deletes them. After that the DB
  // table is vestigial; future reads come from src/lib/pendingChanges.
  listBranchChanges,
  discardBranchChange,
  pushChangeRequest,
  withdrawChangeRequest,
  approveChangeRequest,
  approveChangeRequests,
  rejectChangeRequest,
  rejectChangeRequestItem,
  listChangeRequests,
  getChangeRequest,
  subscribeChangeRequests,
} from '../lib/branches';
import {
  loadPendingChanges,
  savePendingChanges,
  addPendingChange,
  discardPendingChange,
  discardAllPendingChanges,
  loadLastSeenMainVersion,
  saveLastSeenMainVersion,
  hasMigratedBranchChanges,
  markBranchChangesMigrated,
} from '../lib/pendingChanges';

// Branch + change-request state for the currently-selected project.
//
// REDESIGN (Phase 2):
// pendingChanges and the per-member version cursor moved out of the DB
// and into per-(user, project) localStorage (see src/lib/pendingChanges.js
// for the rationale). The realtime subscriptions now ONLY echo into
// React state — they never write to the DB on their own. The buggy
// auto-heal of base_version + the auto-bump on someone-else's-approval
// are both gone; the cursor only advances when the user explicitly
// pulls or when their OWN authored request is approved.
//
// View model:
//   - `view` is 'main' or 'mine' — the branch the user is currently
//     looking at on the Files page. Default 'main' for everyone;
//     persists per-project in localStorage so a member toggled to
//     'mine' stays there across reloads.
//   - `mainVersion` is the project's current main-branch cursor
//     (bumps server-side every time approve_change_request runs).
//   - `branchState.base_version` is now derived from a localStorage-
//     backed lastSeenMainVersion value. Same shape as before for
//     consumer compat. When mainVersion > lastSeen, the UI shows the
//     "New main branch available" chip.
//   - `pendingChanges` is the live list of the member's queued
//     metadata-only edits (rename / description / delete). Pure
//     React state, persisted per-(user, project) in localStorage.
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

  // Initial load + reload-on-project-change. Pulls main_version + the
  // change_requests visible to the caller from the server, then
  // hydrates the local pendingChanges queue and the per-user
  // lastSeenMainVersion cursor from localStorage. No more DB round-trip
  // for those — see src/lib/pendingChanges.js for the Phase 2 rationale.
  //
  // The auto-heal of base_version is GONE. The cursor now advances
  // ONLY on two explicit signals:
  //   1. The user runs SyncToMainModal and acknowledgeSync() fires.
  //   2. The realtime subscription echoes the user's OWN authored
  //      request flipping to 'approved' — that user's own work is by
  //      definition already in their local folder, so absorbing the
  //      version bump silently is correct.
  // Other users' approvals leave the cursor untouched; the chip
  // lights up and stays lit until the user explicitly pulls.
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
        { data: reqs },
      ] = await Promise.all([
        getMainVersion(projectId),
        listChangeRequests(projectId),
      ]);
      const nextMain = mainV ?? 0;
      setMainVersion(nextMain);
      setRequests(reqs || []);

      // Hydrate pendingChanges from localStorage — pure client state
      // now, no DB round-trip per project switch.
      setPendingChanges(isMember ? loadPendingChanges(userId, projectId) : []);

      // Seed lastSeenMainVersion on first ever load. A null return
      // from loadLastSeenMainVersion means "never set" — initialise
      // to the current main version so a brand-new user / new project
      // doesn't see the chip light up against the full history of
      // approvals that predate their first visit.
      let cursor = loadLastSeenMainVersion(userId, projectId);
      if (cursor === null) {
        saveLastSeenMainVersion(userId, projectId, nextMain);
        cursor = nextMain;
      }
      // Synthesize a branchState-shaped object so existing consumers
      // that read `branchState.base_version` (e.g. the version readout
      // under the folder picker) keep working without changes.
      setBranchState({ project_id: projectId, user_id: userId, base_version: cursor });
    } finally {
      setLoading(false);
    }
  }, [projectId, userId, isMember]);

  useEffect(() => { refresh(); }, [refresh]);

  // One-time migration: sweep any legacy branch_changes rows that
  // existed before Phase 2 into localStorage, then delete them from
  // the DB. Idempotent — gates on a per-(user, project) marker so
  // subsequent app loads skip the sweep entirely. Falls through if
  // the marker is already set, so this costs nothing on steady state.
  useEffect(() => {
    if (!userId || !projectId || !isMember) return;
    if (hasMigratedBranchChanges(userId, projectId)) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await listBranchChanges(projectId);
      if (cancelled || error || !Array.isArray(data) || data.length === 0) {
        markBranchChangesMigrated(userId, projectId);
        return;
      }
      // Merge into the existing localStorage queue, deduping by
      // (kind + target_file_id) so re-running on a partial sweep
      // doesn't double-queue any single edit.
      const existing = loadPendingChanges(userId, projectId);
      const seen = new Set(
        existing.map((c) => `${c.kind}:${c.target_file_id || ''}`),
      );
      const merged = [...existing];
      for (const row of data) {
        const key = `${row.kind}:${row.target_file_id || ''}`;
        if (seen.has(key)) continue;
        merged.push(row);
        seen.add(key);
      }
      savePendingChanges(userId, projectId, merged);
      setPendingChanges(merged);
      // Best-effort DB cleanup — failures here just leave vestigial
      // rows behind that won't be read on next boot.
      for (const row of data) {
        if (cancelled) break;
        discardBranchChange(row.id).catch(() => { /* swallow */ });
      }
      markBranchChangesMigrated(userId, projectId);
    })();
    return () => { cancelled = true; };
  }, [userId, projectId, isMember]);

  // Every open change_request authored by THIS user. Plural because
  // migration 022 dropped the one-open-per-author constraint and
  // commitFlow now creates a separate request per file, so a member
  // with three queued edits sits on three open requests at once.
  // Sorted (oldest first) just so consumers iterating get a stable
  // order; the order isn't load-bearing anywhere.
  const openOwnRequestIds = useMemo(() => {
    if (!userId) return [];
    return requests
      .filter((r) => r.author_id === userId && r.status === 'open')
      .map((r) => r.id);
  }, [requests, userId]);

  // Stable join key so the items-fetch effect below doesn't re-fire
  // every render with a new array reference — the IDs themselves
  // need to change before we re-fetch.
  const openOwnRequestIdsKey = openOwnRequestIds.join(',');

  // Fetch items across ALL of the user's open requests and union
  // them into `openOwnRequestItems`. Consumers (computeSyncState in
  // the commit modal, the soft-hold post-approval logic in
  // ProjectFiles) treat it as a flat list of "things already in
  // flight" — they don't care which request each item belongs to.
  //
  // Realtime doesn't cover change_request_items, so we also expose
  // refreshOpenRequestItems() for the commit modal to call after a
  // successful push.
  const refreshOpenRequestItems = useCallback(async () => {
    if (openOwnRequestIds.length === 0) {
      setOpenOwnRequestItems([]);
      return;
    }
    const results = await Promise.all(
      openOwnRequestIds.map((id) => getChangeRequest(id)),
    );
    const merged = [];
    for (const { data, error } of results) {
      if (error || !data) continue;
      if (Array.isArray(data.items)) merged.push(...data.items);
    }
    setOpenOwnRequestItems(merged);
    // openOwnRequestIdsKey is the canonical "has the set of open
    // own requests changed?" signal — using it in the dep array
    // means we don't refetch on every render that produces a new
    // array reference for the same set of ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openOwnRequestIdsKey]);

  useEffect(() => { refreshOpenRequestItems(); }, [refreshOpenRequestItems]);

  // ── Realtime ─────────────────────────────────────────────────────────
  // ONE subscription now — change_requests. pendingChanges no longer
  // lives in the DB so there's nothing to listen to for it; metadata
  // edits are pure client state synced across the user's own sessions
  // via localStorage only (intentional trade-off: cross-device sync
  // for un-pushed renames isn't worth a realtime channel).
  //
  // The change_requests handler is now a signal handler — it updates
  // the React `requests` list to reflect status flips and inserts /
  // deletions, refetches `mainVersion` so the chip's derived state
  // is current, and bumps `lastSeenMainVersion` (localStorage) only
  // when the user's OWN authored request just got approved. Other
  // users' approvals leave the cursor untouched so the chip lights
  // up and stays lit until the user explicitly pulls. No more DB
  // writes from this subscriber — that auto-write was the main
  // "system did things on its own" complaint.
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
          // Refetch mainVersion so consumers (the version readout
          // under the folder picker, the chip derivation) see the
          // new value. If the approval was OUR OWN, also catch the
          // localStorage cursor up — the local folder already has
          // these bytes by construction, so we're "in sync with this
          // particular bump" without any disk I/O.
          getMainVersion(projectId).then(({ data }) => {
            const nextVersion = data ?? 0;
            setMainVersion(nextVersion);
            if (newRow.author_id === userId && userId) {
              saveLastSeenMainVersion(userId, projectId, nextVersion);
              setBranchState((prev) => (
                prev ? { ...prev, base_version: nextVersion } : prev
              ));
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
  // pendingChanges now lives in localStorage (see src/lib/pendingChanges.js).
  // Each writer mutates React state and persists in one synchronous step —
  // no DB round-trip, no optimistic-vs-realtime reconciliation, no
  // temp-id swap dance. Functions still return the same `{ data, error }`
  // shape so existing call sites don't change.
  const queueChange = useCallback(async (patch) => {
    if (!projectId || !userId) return { error: new Error('No project/user') };
    const res = addPendingChange(userId, projectId, {
      kind: patch.kind,
      target_file_id: patch.targetFileId ?? patch.target_file_id ?? null,
      proposed: patch.proposed || null,
    });
    if (!res.error && res.data) {
      setPendingChanges((prev) => [...prev, res.data]);
    }
    return res;
  }, [projectId, userId]);

  const discardChange = useCallback(async (id) => {
    if (!id) return { error: new Error('Missing id') };
    if (!projectId || !userId) return { error: new Error('No project/user') };
    discardPendingChange(userId, projectId, id);
    setPendingChanges((prev) => prev.filter((c) => c.id !== id));
    return { error: null };
  }, [projectId, userId]);

  const discardAll = useCallback(async () => {
    if (!projectId || !userId) return { data: [], error: new Error('No project/user') };
    discardAllPendingChanges(userId, projectId);
    setPendingChanges([]);
    return { data: [], error: null };
  }, [projectId, userId]);

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

  // Approve a COMPOSED RELEASE — all the picked requests merged together
  // with a SINGLE main_version bump (so the version goes up by one per
  // release, not once per bundled request). Fetches each request's full
  // item snapshot, hands the batch to approveChangeRequests, and toasts
  // the combined result.
  const approveRelease = useCallback(async (requestIds) => {
    const ids = Array.from(new Set((requestIds || []).filter(Boolean)));
    if (ids.length === 0) return { data: null, error: new Error('No requests to approve') };
    const fetched = await Promise.all(ids.map((id) => getChangeRequest(id)));
    const requests = [];
    for (const { data, error } of fetched) {
      if (error) return { data: null, error };
      if (data) requests.push(data);
    }
    const res = await approveChangeRequests(requests);
    if (res.error) {
      notify?.({
        category: 'file',
        variant: 'error',
        title: 'Approval failed',
        body: res.error.message || 'Try again in a moment.',
        dedupeKey: `approve-release-error:${ids.join(',')}`,
      });
    } else {
      const n = requests.length;
      notify?.({
        category: 'file',
        variant: 'success',
        title: n === 1 ? 'Changes approved' : 'Release approved',
        body: n === 1
          ? `"${requests[0].title}" was merged into main.`
          : `${n} requests were merged into main.`,
        dedupeKey: `approve-release-success:${ids.join(',')}`,
      });
    }
    return res;
  }, [notify]);

  // Per-item decline. Mirrors rejectRequest's toast wiring but operates
  // on a single change_request_items row — the parent request only
  // flips to 'rejected' if that item was the last one in it (handled
  // server-side by reject_change_request_item). Used by the Decline
  // button on each version chip in the Pending Edits tree so admins
  // can throw away one author's file without nuking the author's
  // sibling files that happened to ride the same request.
  const rejectRequestItem = useCallback(async (item, note) => {
    if (!item?.id) return { data: null, error: new Error('Missing item') };
    const res = await rejectChangeRequestItem(item, { note });
    if (res.error) {
      notify?.({
        category: 'file',
        variant: 'error',
        title: 'Decline failed',
        body: res.error.message || 'Try again in a moment.',
        dedupeKey: `reject-item-error:${item.id}`,
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

  // After the user's local folder has been synced to main, advance
  // the localStorage-backed cursor so the "New main branch available"
  // chip clears. No more DB round-trip — the cursor is per-(user,
  // project) client state. acknowledgeSync still returns the same
  // `{ error }` shape so existing call sites (SyncToMainModal,
  // ResetBranchModal) don't need updates.
  const acknowledgeSync = useCallback(async () => {
    if (!projectId || !userId) return { error: null };
    const targetVersion = mainVersion;
    saveLastSeenMainVersion(userId, projectId, targetVersion);
    setBranchState((prev) => (
      prev ? { ...prev, base_version: targetVersion } : prev
    ));
    return { error: null };
  }, [projectId, userId, mainVersion]);

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
    approveRelease,
    rejectRequest,
    rejectRequestItem,
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
    approveRequest, approveRelease, rejectRequest, rejectRequestItem, acknowledgeSync,
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
