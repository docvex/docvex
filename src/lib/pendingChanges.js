// localStorage-backed per-(user, project) state that used to live in the
// Supabase `branch_changes` table and `project_member_branches.base_version`
// column. Phase 2 of the cloud-collab redesign moved these out of the DB so:
//
//   1. No realtime auto-bumps of cursor state — the audit found the auto-heal
//      in BranchContext was buggy (couldn't cope with multiple open requests
//      per author) and silently mutated user state on app load.
//   2. No two-sources-of-truth merge problem at push time — pendingChanges
//      and the filesystem diff used to feed into commitFlow's buildCommitSnapshot
//      via fragile name-dedup logic. Now pendingChanges is plain client state;
//      the watcher / diff layer is the only filesystem-side source.
//   3. Faster reads — every render-time question ("am I behind main? what
//      pending edits do I have?") answered from local memory, not a network
//      round-trip plus realtime echo.
//
// Two concepts share this module by accident of co-location:
//
//   • pendingChanges       — queue of {kind, target_file_id, proposed} a user
//                            has staged (rename, description edit, delete)
//                            but not yet pushed. Used by CommitFlow at push
//                            time to combine with the fs diff.
//   • lastSeenMainVersion  — highest project main_version the user has
//                            EXPLICITLY absorbed (pulled OR authored an
//                            approved push to). Drives the "New main branch
//                            available" chip without a DB cursor.
//
// All operations are best-effort: localStorage may be unavailable (private
// browsing, full quota) and we degrade to in-memory only.

const PC_KEY = (userId, projectId) =>
  `docvex:pending-changes:${userId || '_anon'}:${projectId}`;
const LSV_KEY = (userId, projectId) =>
  `docvex:last-seen-main-version:${userId || '_anon'}:${projectId}`;
const MIGRATED_KEY = (userId, projectId) =>
  `docvex:branch-changes-migrated:${userId || '_anon'}:${projectId}`;

function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeWrite(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

// ─── pendingChanges queue ───────────────────────────────────────────

export function loadPendingChanges(userId, projectId) {
  if (!projectId) return [];
  const raw = safeRead(PC_KEY(userId, projectId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePendingChanges(userId, projectId, changes) {
  if (!projectId) return false;
  return safeWrite(PC_KEY(userId, projectId), JSON.stringify(changes || []));
}

// Append a new change, mint a temp id (the same shape branch_changes used
// for its uuid PK — consumers index by `id`). The created_at stamp lets the
// commit modal display "queued 2 min ago" without a DB round-trip.
export function addPendingChange(userId, projectId, change) {
  if (!projectId) return { data: null, error: new Error('No project') };
  const current = loadPendingChanges(userId, projectId);
  const row = {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    project_id: projectId,
    user_id: userId,
    kind: change?.kind,
    target_file_id: change?.target_file_id ?? change?.targetFileId ?? null,
    proposed: change?.proposed ?? null,
    created_at: new Date().toISOString(),
  };
  const next = [...current, row];
  savePendingChanges(userId, projectId, next);
  return { data: row, error: null };
}

export function discardPendingChange(userId, projectId, id) {
  if (!projectId || !id) return { error: null };
  const current = loadPendingChanges(userId, projectId);
  const next = current.filter((c) => c.id !== id);
  savePendingChanges(userId, projectId, next);
  return { error: null };
}

export function discardAllPendingChanges(userId, projectId) {
  if (!projectId) return { data: [], error: null };
  savePendingChanges(userId, projectId, []);
  return { data: [], error: null };
}

// ─── lastSeenMainVersion cursor ─────────────────────────────────────

// Returns null when the cursor has never been initialised (caller should
// seed it to the current main_version on first load — that puts the user
// "in sync" on their first visit, so the chip doesn't false-light against
// the entire history of approved changes).
export function loadLastSeenMainVersion(userId, projectId) {
  if (!projectId) return null;
  const raw = safeRead(LSV_KEY(userId, projectId));
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function saveLastSeenMainVersion(userId, projectId, version) {
  if (!projectId) return false;
  const v = Number.isFinite(version) ? version | 0 : 0;
  return safeWrite(LSV_KEY(userId, projectId), String(v));
}

// ─── one-time migration marker ──────────────────────────────────────
// BranchContext uses these to gate the DB-to-localStorage sweep that runs
// once per (user, project) the first time the redesigned client boots.
// After the sweep completes the marker is written and the sweep won't
// re-run, even on app restarts. Clearing the marker lets a dev re-run
// the migration if needed.

export function hasMigratedBranchChanges(userId, projectId) {
  if (!projectId) return true;
  return safeRead(MIGRATED_KEY(userId, projectId)) === '1';
}

export function markBranchChangesMigrated(userId, projectId) {
  if (!projectId) return false;
  return safeWrite(MIGRATED_KEY(userId, projectId), '1');
}
