// Branch + change-request data access — patterned after projectFiles.js
// and notificationsRepo.js: every function returns `{ data, error }`,
// never throws. RLS does the authorization on every read/write; callers
// don't add their own user-id filters.
//
// Conceptual model (mirrors Github at a far smaller scale):
//
//   MAIN BRANCH = public.project_files. Everyone reads it; only an
//   approved change request can mutate it. The project carries a
//   `main_version` counter that bumps on every approval.
//
//   MEMBER BRANCH = the union of project_files + this member's pending
//   `branch_changes` overlaid on top. Branch state is implicit per
//   (project, user) — a row in project_member_branches gets lazy-
//   created on first edit / first sync. The row's `base_version`
//   tracks which `main_version` the member last pulled.
//
//   COMMIT (push) = snapshot every queued branch_changes row into a
//   new change_request + change_request_items, then clear the queue.
//   The member can keep editing — their next edits queue up for their
//   NEXT request.
//
//   APPROVE / REJECT / WITHDRAW live in a separate lib pass (admin
//   approval is more involved — it has to move storage objects and
//   mutate project_files atomically). The functions exposed here are
//   the READ + MEMBER-SIDE WRITE surface: enough to power the branch
//   UI, the per-action queueing, and the "Push" button.

import { supabase } from './supabaseClient';

const BRANCHES_TABLE   = 'project_member_branches';
const CHANGES_TABLE    = 'branch_changes';
const REQUESTS_TABLE   = 'change_requests';
const ITEMS_TABLE      = 'change_request_items';

// Storage bucket for pending uploads. Separate from the canonical
// `projects` bucket so the existing storage RLS — which casts the
// first path segment to uuid — doesn't choke on these paths.
export const PENDING_BUCKET = 'projects-pending';

// Column lists used for both reads and the SELECT after writes.
// Centralised so adding a column only requires one edit per table.
const BRANCH_COLS  = 'project_id, user_id, base_version, created_at';
const CHANGE_COLS  = 'id, project_id, user_id, kind, target_file_id, proposed, created_at';
const REQUEST_COLS = 'id, project_id, author_id, title, description, status, ' +
                     'submitted_at, decided_at, decided_by, decision_note';
const ITEM_COLS    = 'id, request_id, kind, target_file_id, proposed, seq';

// ── Main-branch version cursor ────────────────────────────────────────

// Read the project's current main_version. Used by the UI to compare
// against the caller's branch.base_version — when current > base, the
// "Sync to main" affordance lights up. Cheap one-column lookup.
export async function getMainVersion(projectId) {
  if (!projectId) return { data: 0, error: new Error('Missing projectId') };
  const { data, error } = await supabase
    .from('projects')
    .select('main_version')
    .eq('id', projectId)
    .single();
  if (error) return { data: 0, error };
  return { data: data?.main_version ?? 0, error: null };
}

// ── Member branch state ───────────────────────────────────────────────

// Read the caller's branch state for a project. Returns null (no
// error) when no row exists yet — the caller is a "fresh" member who
// hasn't edited or synced. The UI treats null as base_version = the
// project's current main_version (i.e. in sync, nothing pending).
export async function getBranchState(projectId, userId = null) {
  if (!projectId) return { data: null, error: new Error('Missing projectId') };
  // Filter by user_id when known: the RLS policy on
  // project_member_branches lets admins / owners READ every member's
  // row, so a project-only filter returns N rows for them and
  // `.maybeSingle()` then errors out with "JSON object requested,
  // multiple (or no) rows returned" → branchState stays null and the
  // UI shows Local v0 forever. Members hit the same query and only
  // see their own row regardless, so adding the filter is safe
  // either way.
  let q = supabase.from(BRANCHES_TABLE).select(BRANCH_COLS).eq('project_id', projectId);
  if (userId) q = q.eq('user_id', userId);
  const { data, error } = await q.maybeSingle();
  // Pass through both the row and the error. supabase-js' .maybeSingle()
  // returns data: null + error: null for "no row" — that's the fresh-
  // member case and not an error condition.
  return { data: data || null, error };
}

// Lazy-create the caller's branch row if it doesn't exist. Sets
// `base_version` to the current main_version so a fresh member is
// "in sync" from the start. Returns the row whether it existed
// before or was just inserted.
//
// Idempotent: a re-run on an existing row is a no-op (the existence
// check short-circuits before the insert).
export async function ensureBranchState(projectId, userId) {
  if (!projectId || !userId) {
    return { data: null, error: new Error('Missing projectId/userId') };
  }
  // Pass userId so admins/owners get their OWN row, not a multi-row
  // result that maybeSingle() can't disambiguate.
  const existing = await getBranchState(projectId, userId);
  if (existing.error) return existing;
  if (existing.data) return existing;
  // No row yet — read the current main_version and insert.
  const { data: currentVersion } = await getMainVersion(projectId);
  const { data, error } = await supabase
    .from(BRANCHES_TABLE)
    .insert({
      project_id: projectId,
      user_id: userId,
      base_version: currentVersion,
    })
    .select(BRANCH_COLS)
    .single();
  return { data, error };
}

// Bump the caller's base_version to a specific value. Called after
// a successful "Sync to main" — the member has just applied main's
// diff to their local folder, so their cursor advances to the new
// main_version. Idempotent. RLS gates this to the caller's own row.
export async function setBaseVersion(projectId, version) {
  if (!projectId) return { error: new Error('Missing projectId') };
  // The UPDATE policy already pins this to the caller's row
  // (`user_id = auth.uid()`), but for an admin/owner the project-only
  // WHERE would attempt to update every member's row before RLS
  // filters — Supabase returns 0 rows affected silently in that
  // case. Add the user_id filter so the update targets exactly one
  // row regardless of who's calling.
  const userId = (await supabase.auth.getUser()).data?.user?.id;
  if (!userId) return { error: new Error('Not authenticated') };
  const { error } = await supabase
    .from(BRANCHES_TABLE)
    .update({ base_version: version })
    .eq('project_id', projectId)
    .eq('user_id', userId);
  return { error };
}

// ── Branch changes (uncommitted edits) ────────────────────────────────

// List the caller's pending changes for a project, ordered by when
// they were queued. The UI applies these as overlays on top of the
// project_files list to render the member's branch view.
export async function listBranchChanges(projectId) {
  if (!projectId) return { data: [], error: new Error('Missing projectId') };
  const { data, error } = await supabase
    .from(CHANGES_TABLE)
    .select(CHANGE_COLS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  return { data: data || [], error };
}

// Queue a single change. `kind` is one of:
//   'add'     — a new file (target_file_id = null, proposed carries
//               name/description/mime/size/pending_storage_path)
//   'edit'    — metadata-only change on an existing file (proposed
//               carries the changed name/description fields only)
//   'delete'  — remove an existing file (proposed = null)
//   'replace' — replace an existing file's bytes (proposed same shape
//               as 'add', target_file_id = the file being replaced)
//
// RLS pins user_id to auth.uid() via WITH CHECK; passing the wrong
// value would be rejected but the caller is expected to pass their
// own id anyway for symmetry with insertProjectFileRow's contract.
export async function addBranchChange({
  projectId,
  userId,
  kind,
  targetFileId = null,
  proposed = null,
}) {
  if (!projectId || !userId) {
    return { data: null, error: new Error('Missing projectId/userId') };
  }
  if (!['add', 'edit', 'delete', 'replace'].includes(kind)) {
    return { data: null, error: new Error(`Invalid kind: ${kind}`) };
  }
  const { data, error } = await supabase
    .from(CHANGES_TABLE)
    .insert({
      project_id: projectId,
      user_id: userId,
      kind,
      target_file_id: targetFileId,
      proposed,
    })
    .select(CHANGE_COLS)
    .single();
  return { data, error };
}

// Discard a single queued change without pushing. The caller might
// also need to clean up the pending storage object for add/replace
// kinds — that's done at the call site (the lib doesn't reach into
// storage on its own, same convention as deleteProjectFile vs
// deleteStorageObject in projectFiles.js).
export async function discardBranchChange(id) {
  if (!id) return { error: new Error('Missing id') };
  const { error } = await supabase
    .from(CHANGES_TABLE)
    .delete()
    .eq('id', id);
  return { error };
}

// Discard ALL queued changes for a project. Used by the "Discard
// all" affordance in the branch UI. Returns the rows that were
// deleted so the caller can clean up any pending storage objects
// attached to them (add/replace kinds carry a pending_storage_path
// in `proposed`).
export async function discardAllBranchChanges(projectId) {
  if (!projectId) return { data: [], error: new Error('Missing projectId') };
  const { data, error } = await supabase
    .from(CHANGES_TABLE)
    .delete()
    .eq('project_id', projectId)
    .select(CHANGE_COLS);
  return { data: data || [], error };
}

// ── Change requests (commits awaiting review) ─────────────────────────

// Push the caller's queued branch_changes as a new change request.
// Steps:
//   1. Snapshot every branch_changes row for this project + user.
//   2. Insert a change_requests row.
//   3. Bulk-insert change_request_items mirroring the snapshots.
//   4. Delete the source branch_changes rows.
// Each step is its own statement (Supabase JS doesn't expose
// transactions), so on partial failure we best-effort roll back to
// keep the table consistent — see the catch branches below.
//
// The unique partial index on change_requests (status='open')
// rejects a second push while a previous request is still open,
// returning a 23505 error the caller can surface as "You already
// have an open request — wait for review or withdraw it first".
export async function pushChangeRequest({ projectId, authorId, title, description }) {
  if (!projectId || !authorId) {
    return { data: null, error: new Error('Missing projectId/authorId') };
  }
  const trimmedTitle = (title || '').trim();
  if (!trimmedTitle) {
    return { data: null, error: new Error('Title cannot be empty') };
  }
  // 1. Snapshot the queue.
  const { data: changes, error: listErr } = await supabase
    .from(CHANGES_TABLE)
    .select('kind, target_file_id, proposed, created_at')
    .eq('project_id', projectId)
    .eq('user_id', authorId)
    .order('created_at', { ascending: true });
  if (listErr) return { data: null, error: listErr };
  if (!changes || changes.length === 0) {
    return { data: null, error: new Error('No changes to push') };
  }
  // 2. Insert the request row. Will 23505 if the author has an open
  // request already — let it bubble up to the caller's error toast.
  const { data: request, error: reqErr } = await supabase
    .from(REQUESTS_TABLE)
    .insert({
      project_id: projectId,
      author_id: authorId,
      title: trimmedTitle,
      description: (description && description.trim()) || null,
    })
    .select(REQUEST_COLS)
    .single();
  if (reqErr) return { data: null, error: reqErr };
  // 3. Insert items. `seq` carries the same order as the source
  // changes for stable display in the admin's preview.
  const items = changes.map((c, i) => ({
    request_id: request.id,
    kind: c.kind,
    target_file_id: c.target_file_id,
    proposed: c.proposed,
    seq: i,
  }));
  const { error: itemErr } = await supabase
    .from(ITEMS_TABLE)
    .insert(items);
  if (itemErr) {
    // Roll back the request — without items it's just noise in the
    // admin's inbox. Best-effort; an orphan request row is not a
    // correctness issue, just a stale audit log entry.
    await supabase.from(REQUESTS_TABLE).delete().eq('id', request.id);
    return { data: null, error: itemErr };
  }
  // 4. Clear the source queue. If THIS fails the request is still
  // valid (admin can review the snapshots) but the member sees their
  // queue persist locally — they'll need to manually discard. Acceptable
  // and recoverable.
  await supabase
    .from(CHANGES_TABLE)
    .delete()
    .eq('project_id', projectId)
    .eq('user_id', authorId);
  return { data: request, error: null };
}

// Create a change request from a pre-built item list. Sibling of
// pushChangeRequest above, but for callers that DON'T use the
// branch_changes table — the filesystem-diff flow on the My branch
// tab computes its items directly off (localFiles vs project_files)
// and ships them straight through here, skipping the branch_changes
// snapshot step entirely.
//
// `items` shape: [{ kind, target_file_id, proposed }, …] in the
// order they should appear to the admin. seq is assigned per the
// array order.
export async function createChangeRequest({
  projectId,
  authorId,
  title,
  description,
  items,
}) {
  if (!projectId || !authorId) {
    return { data: null, error: new Error('Missing projectId/authorId') };
  }
  const trimmedTitle = (title || '').trim();
  if (!trimmedTitle) {
    return { data: null, error: new Error('Title cannot be empty') };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { data: null, error: new Error('No items to commit') };
  }
  const { data: request, error: reqErr } = await supabase
    .from(REQUESTS_TABLE)
    .insert({
      project_id: projectId,
      author_id: authorId,
      title: trimmedTitle,
      description: (description && description.trim()) || null,
    })
    .select(REQUEST_COLS)
    .single();
  if (reqErr) return { data: null, error: reqErr };
  const rows = items.map((it, i) => ({
    request_id: request.id,
    kind: it.kind,
    target_file_id: it.target_file_id ?? null,
    proposed: it.proposed ?? null,
    seq: i,
  }));
  const { error: itemErr } = await supabase.from(ITEMS_TABLE).insert(rows);
  if (itemErr) {
    // Roll back the orphan request — without items there's nothing
    // to review and it'd just clutter the admin's inbox.
    await supabase.from(REQUESTS_TABLE).delete().eq('id', request.id);
    return { data: null, error: itemErr };
  }
  return { data: request, error: null };
}

// Create a change request OR merge a fresh batch of items into the
// author's existing open request. Resolves the "duplicate key
// value violates unique constraint change_requests_one_open_per_author"
// case: a member pushed once, the request is still under review,
// and they push again. The clean solution would be to wait for the
// admin to decide; the practical one is to fold the new items in
// so the admin sees the current state of the branch, not two
// fragmented requests.
//
// Merge rules:
//   • Existing items that share a `target_file_id` with any new
//     item get DELETED — new wins (you renamed file A, then
//     renamed it again; the latest rename is what should land).
//   • Existing 'add' items that share a `proposed.id` with any new
//     'add' get DELETED too — same logic for files the author
//     re-uploaded under the same minted id.
//   • Surviving existing items are kept in place; new items append
//     at the end with seq numbers continuing from the current max.
//   • The request's title + description are overwritten to the new
//     batch's values (latest push wins — matches git's `--amend`).
//
// Returns `{ data: { request, merged }, error }` where `merged: true`
// indicates we folded into an existing request, `merged: false` means
// a fresh one was created.
export async function createOrMergeChangeRequest({
  projectId,
  authorId,
  title,
  description,
  items,
}) {
  if (!projectId || !authorId) {
    return { data: null, error: new Error('Missing projectId/authorId') };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { data: null, error: new Error('No items to commit') };
  }

  // Look for an existing open request to merge into.
  const { data: existing, error: lookupErr } = await supabase
    .from(REQUESTS_TABLE)
    .select(REQUEST_COLS)
    .eq('project_id', projectId)
    .eq('author_id', authorId)
    .eq('status', 'open')
    .maybeSingle();
  if (lookupErr) return { data: null, error: lookupErr };

  if (!existing) {
    const res = await createChangeRequest({ projectId, authorId, title, description, items });
    if (res.error) return { data: null, error: res.error };
    return { data: { request: res.data, merged: false }, error: null };
  }

  // ── Merge path ──
  const trimmedTitle = (title || '').trim();
  if (trimmedTitle) {
    // Best-effort title/description refresh. Failure here doesn't
    // block the merge — the items are the meaningful payload.
    await supabase
      .from(REQUESTS_TABLE)
      .update({
        title: trimmedTitle,
        description: (description && description.trim()) || null,
      })
      .eq('id', existing.id);
  }

  // Fetch existing items to compute conflicts + the seq baseline.
  const { data: existingItems, error: itemsErr } = await supabase
    .from(ITEMS_TABLE)
    .select('id, target_file_id, kind, proposed, seq')
    .eq('request_id', existing.id);
  if (itemsErr) return { data: null, error: itemsErr };

  const maxSeq = (existingItems || []).reduce((m, it) => Math.max(m, it.seq ?? -1), -1);

  // Build conflict sets from the new batch.
  const newTargetIds = new Set();
  const newAddIds    = new Set();
  for (const it of items) {
    if (it.target_file_id) newTargetIds.add(it.target_file_id);
    if (it.kind === 'add' && it.proposed?.id) newAddIds.add(it.proposed.id);
  }

  const idsToDelete = (existingItems || [])
    .filter((it) => (
      (it.target_file_id && newTargetIds.has(it.target_file_id))
      || (it.kind === 'add' && it.proposed?.id && newAddIds.has(it.proposed.id))
    ))
    .map((it) => it.id);

  if (idsToDelete.length > 0) {
    const { error: delErr } = await supabase
      .from(ITEMS_TABLE)
      .delete()
      .in('id', idsToDelete);
    if (delErr) return { data: null, error: delErr };
  }

  // Append the new items at the end of the seq stream.
  const rows = items.map((it, i) => ({
    request_id: existing.id,
    kind: it.kind,
    target_file_id: it.target_file_id ?? null,
    proposed: it.proposed ?? null,
    seq: maxSeq + 1 + i,
  }));
  const { error: insertErr } = await supabase.from(ITEMS_TABLE).insert(rows);
  if (insertErr) return { data: null, error: insertErr };

  return { data: { request: existing, merged: true }, error: null };
}

// Filesystem diff lives in `lib/syncState.js` now — the unified
// state computer replaced the three previous per-surface pipelines
// (this one, the SyncToMainModal one, and the sidecar reconcile)
// with one pass over the same inputs. Callers that previously
// imported `computeBranchDiff` from here now call
// `computeSyncState(...).toCommit` from `lib/syncState.js`.

// Hex-encoded SHA-256 of a Blob. Uses the SubtleCrypto API which is
// hardware-accelerated in Chromium / WebKit / Firefox. Buffers the
// whole blob in memory (no streaming Digest API yet); fine for files
// in the MB-to-low-GB range. Caller can skip hashing huge files via
// `skipHash` in uploadBlobToPending below.
export async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hashBuf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

// Upload a Blob's bytes to the projects-pending bucket and return
// the path metadata needed for a change_request_item's `proposed`
// field. Backend-agnostic: caller is responsible for resolving the
// Blob (via `readLocalBlob` from lib/localFolder.js — which fetches
// `localfile://` on Electron or pulls from a FileSystemFileHandle
// on web).
//
// Computes a SHA-256 of the bytes in parallel with the PUT so the
// returned metadata carries `contentHash` for the change_request_item
// — that lets the approve RPC populate project_files.content_hash
// without an extra round-trip, and downstream diffs catch same-size
// content edits later.
//
// `fileId` (optional): pre-minted UUID for the proposed file. The
// caller wants to thread the same id used in their local sidecar
// (see lib/localBranchMeta.js) so that after the admin approves,
// project_files.id matches what the sidecar already mapped the
// local file to — no re-link needed. Omit to have a fresh UUID
// minted here (legacy flow).
//
// Returns:
//   { fileId, name, mimeType, sizeBytes, contentHash, pendingPath, canonicalPath }
// where canonicalPath is the destination the approve RPC will write
// project_files.storage_path to after the admin merges.
export async function uploadBlobToPending({
  projectId,
  userId,
  blob,
  fileName,
  mimeType,
  fileId: providedFileId,
}) {
  if (!projectId || !userId || !blob || !fileName) {
    return { data: null, error: new Error('Missing required arg') };
  }
  // Use the caller-provided id when present so the sidecar's
  // mapping survives intact across the approve boundary. Fall back
  // to a fresh UUID for callers that haven't adopted the sidecar yet.
  const fileId = providedFileId || crypto.randomUUID();
  const pendingPath = buildPendingStoragePath(projectId, userId, fileId, fileName);
  const canonicalPath = `${projectId}/${fileId}/${fileName}`;
  // Get a signed upload URL into the pending bucket.
  const { data: target, error: signErr } = await createPendingUploadTarget(pendingPath);
  if (signErr || !target?.signedUrl) {
    return { data: null, error: signErr || new Error('Could not sign upload URL') };
  }
  // Hash + PUT in parallel — same arraybuffer is read twice by the
  // browser, but the hash compute and the network write don't block
  // each other.
  let contentHash = null;
  try {
    const [, hash] = await Promise.all([
      (async () => {
        const putRes = await fetch(target.signedUrl, {
          method: 'PUT',
          body: blob,
          headers: {
            'content-type': mimeType || blob.type || 'application/octet-stream',
            'x-upsert': 'false',
          },
        });
        if (!putRes.ok) {
          throw new Error(`Upload failed (${putRes.status}): ${await putRes.text().catch(() => '')}`);
        }
      })(),
      sha256Hex(blob).catch(() => null),
    ]);
    contentHash = hash;
  } catch (err) {
    return { data: null, error: new Error(err?.message || String(err)) };
  }
  return {
    data: {
      fileId,
      name: fileName,
      mimeType: mimeType || blob.type || 'application/octet-stream',
      sizeBytes: blob.size,
      contentHash,
      pendingPath,
      canonicalPath,
    },
    error: null,
  };
}

// Upload a thumbnail (or single video frame) into the pending bucket
// alongside its parent file. Returns the pending storage path AND
// the canonical destination path that approve_change_request will
// copy it to — both are threaded into `proposed.thumbnail_pending_path`
// + `proposed.thumbnail_path` so the merge step can `storage.copy()`
// pending → canonical and the project_files row picks up
// thumbnail_path on insert.
//
// Path convention mirrors uploadBlobToPending: pending lives under
// `{projectId}/{userId}/{fileId}/_thumb{suffix}`, canonical lives
// under `{projectId}/{fileId}/_thumb{suffix}` (matching
// buildThumbnailPath / buildVideoFramePath from lib/thumbnails.js).
// `suffix` is empty for the single-frame thumb and `_N` for video
// frame N.
export async function uploadPendingThumbnail({
  projectId,
  userId,
  fileId,
  blob,
  suffix = '',
}) {
  if (!projectId || !userId || !fileId || !blob) {
    return { data: null, error: new Error('Missing required arg') };
  }
  const filename = `_thumb${suffix}.jpg`;
  const pendingPath = buildPendingStoragePath(projectId, userId, fileId, filename);
  const canonicalPath = `${projectId}/${fileId}/${filename}`;
  const { data: target, error: signErr } = await createPendingUploadTarget(pendingPath);
  if (signErr || !target?.signedUrl) {
    return { data: null, error: signErr || new Error('Could not sign thumbnail upload URL') };
  }
  try {
    const putRes = await fetch(target.signedUrl, {
      method: 'PUT',
      body: blob,
      headers: {
        'content-type': blob.type || 'image/jpeg',
        'x-upsert': 'false',
      },
    });
    if (!putRes.ok) {
      return { data: null, error: new Error(`Thumbnail upload failed (${putRes.status})`) };
    }
  } catch (err) {
    return { data: null, error: new Error(err?.message || String(err)) };
  }
  return { data: { pendingPath, canonicalPath }, error: null };
}

// Author cancels an open request before the admin decides. The
// RLS update policy allows author → withdrawn or admin → any
// terminal state; the eq('status','open') guard prevents a
// withdraw from clobbering an already-decided request in a race.
export async function withdrawChangeRequest(id) {
  if (!id) return { error: new Error('Missing id') };
  const { error } = await supabase
    .from(REQUESTS_TABLE)
    .update({
      status: 'withdrawn',
      decided_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'open');
  return { error };
}

// List change requests visible to the caller. Members see their own;
// admins see every request in the project. The `status` option
// filters server-side — useful for the admin's "Open" tab vs the
// "Decided" history.
export async function listChangeRequests(projectId, { status, limit } = {}) {
  if (!projectId) return { data: [], error: new Error('Missing projectId') };
  let query = supabase
    .from(REQUESTS_TABLE)
    .select(REQUEST_COLS)
    .eq('project_id', projectId)
    .order('submitted_at', { ascending: false });
  if (status) query = query.eq('status', status);
  if (limit)  query = query.limit(limit);
  const { data, error } = await query;
  return { data: data || [], error };
}

// Every item in every OPEN change request for a project, in one
// round trip. Replaces the N+1 of `Promise.all(getChangeRequest)`
// the compose view originally did per open request — once a team
// has more than a handful of open requests, that pattern stops
// scaling (every reviewer's render fires N parallel fetches AND
// the realtime echoes re-fire them all again).
//
// Returned shape matches what the compose view wants directly,
// flattened from the supabase-js relationship join — each row is
// one item with its parent's metadata in scope. Author profiles
// are still resolved separately because they're a different
// table and benefit from independent caching.
//
// Server-side filter (`project_id` + `request.status='open'`)
// keeps the payload tight even on a busy project; index added
// in migration 018 covers it.
export async function listOpenChangeRequestItemsForProject(projectId) {
  if (!projectId) return { data: [], error: new Error('Missing projectId') };
  const { data, error } = await supabase
    .from(ITEMS_TABLE)
    .select(`
      id, request_id, kind, target_file_id, proposed, seq,
      request:change_requests!inner (id, project_id, author_id, title, status)
    `)
    .eq('project_id', projectId)
    .eq('request.status', 'open')
    .order('seq', { ascending: true });
  if (error) return { data: [], error };
  const flat = (data || []).map((row) => ({
    requestId: row.request_id,
    requestTitle: row.request?.title || '',
    authorId: row.request?.author_id || null,
    item: {
      id: row.id,
      kind: row.kind,
      target_file_id: row.target_file_id,
      proposed: row.proposed,
      seq: row.seq,
      request_id: row.request_id,
    },
  }));
  return { data: flat, error: null };
}

// Realtime subscription for change_request_items in one project.
// Pairs with `listOpenChangeRequestItemsForProject` to keep the
// compose view live across the team:
//   • A teammate's createOrMergeChangeRequest push (which inserts
//     new items / deletes superseded ones) shows up instantly for
//     every reviewer.
//   • An admin's approve / reject (which delete the parent request
//     and cascade to items) clears stale items without a refetch.
//
// Server-side filter on `project_id` (added in migration 018) keeps
// the channel quiet on busy multi-project servers — without it
// every renderer would see item events from every project in the
// publication.
export function subscribeChangeRequestItemsForProject(projectId, onChange) {
  if (!projectId) return () => {};
  const channel = supabase
    .channel(`change_request_items:${projectId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: ITEMS_TABLE,
        filter: `project_id=eq.${projectId}`,
      },
      onChange,
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
  };
}

// Full detail of a single request — header + ordered items. Two
// parallel queries instead of a server-side join because the
// supabase-js relationship syntax adds noise and we want the items
// as a top-level array.
export async function getChangeRequest(id) {
  if (!id) return { data: null, error: new Error('Missing id') };
  const [reqRes, itemsRes] = await Promise.all([
    supabase.from(REQUESTS_TABLE).select(REQUEST_COLS).eq('id', id).single(),
    supabase.from(ITEMS_TABLE).select(ITEM_COLS).eq('request_id', id).order('seq', { ascending: true }),
  ]);
  if (reqRes.error)   return { data: null, error: reqRes.error };
  if (itemsRes.error) return { data: null, error: itemsRes.error };
  return {
    data: { ...reqRes.data, items: itemsRes.data || [] },
    error: null,
  };
}

// ── Pending-upload storage helpers ────────────────────────────────────

// Canonical path layout for a pending upload. Matches the storage
// RLS in migration 012 — segment 1 = project_id (admin gate),
// segment 2 = user_id (uploader gate). The change_id segment keeps
// each pending upload isolated even if the user picks the same
// filename twice in one branch.
export function buildPendingStoragePath(projectId, userId, changeId, filename) {
  return `${projectId}/${userId}/${changeId}/${filename}`;
}

// Short-lived signed URL for a pending object. Same shape as
// projectFiles.createSignedDownloadUrl but against the pending
// bucket. Used by the admin review UI to preview proposed uploads
// before approval.
export async function createPendingSignedUrl(storagePath, expiresIn = 300) {
  if (!storagePath) return { data: null, error: new Error('Missing storagePath') };
  const { data, error } = await supabase
    .storage
    .from(PENDING_BUCKET)
    .createSignedUrl(storagePath, expiresIn);
  return { data, error };
}

// One-shot signed upload URL into the pending bucket. Same recipe
// as createSignedUploadTarget in projectFiles.js — the upload
// pipeline PUTs via XHR for progress/abort, so we obtain a signed
// PUT target here rather than using supabase-js' .upload().
export async function createPendingUploadTarget(storagePath) {
  if (!storagePath) return { data: null, error: new Error('Missing storagePath') };
  const { data, error } = await supabase
    .storage
    .from(PENDING_BUCKET)
    .createSignedUploadUrl(storagePath);
  return { data, error };
}

// Delete one pending object. Used during discard flows so a discarded
// add/replace doesn't leak storage. RLS allows uploader OR admin so
// both the member's discard AND the admin's post-decision cleanup
// path work through this single helper.
export async function deletePendingObject(storagePath) {
  if (!storagePath) return { error: new Error('Missing storagePath') };
  const { error } = await supabase
    .storage
    .from(PENDING_BUCKET)
    .remove([storagePath]);
  return { error };
}

// ── Admin merge (approve / reject) ────────────────────────────────────

// Orchestrate approval. The DB side lives in the SECURITY DEFINER
// RPC (migration 013); this wrapper does storage prep BEFORE the
// RPC + cleanup AFTER. Order matters for crash safety:
//
//   1. Copy every add/replace item's bytes from the pending bucket
//      to the canonical `projects` bucket at the path already
//      stored in proposed.storage_path. The member's submit pipeline
//      writes that canonical path at queue time (minting a fresh
//      file_id), so the RPC can read proposed.storage_path as-is
//      and just insert/update rows pointing at it.
//   2. Look up existing storage paths for replace/delete items so
//      we can clean them up after — we need to read project_files
//      BEFORE the RPC mutates/deletes those rows.
//   3. Call the RPC. Single transaction; either the whole request
//      applies or none of it does.
//   4. Delete pending objects (now superseded) + old canonical
//      objects (for replace + delete items).
//
// If (1) fails partway: partially-copied canonical files exist but
// nothing references them — harmless orphans, cleanable by a future
// sweep. If (4) fails: orphan pending or old canonical objects —
// also harmless. Only (3) is transactional; that's the line we don't
// cross without correctness.
//
// Caller passes a snapshot of the request with its items
// (getChangeRequest returns exactly that shape).
export async function approveChangeRequest(request) {
  if (!request?.id || !request?.items) {
    return { data: null, error: new Error('Missing request or items') };
  }
  if (request.status !== 'open') {
    return { data: null, error: new Error(`Request is not open (status: ${request.status})`) };
  }

  const pendingPathsToDelete = [];        // pending bucket
  const oldCanonicalPathsToDelete = [];   // projects bucket
  // Canonical paths we WROTE bytes to in this approve. Used below to
  // guard the "delete old canonical bytes" sweep — if a replace item's
  // existing project_files.storage_path is identical to the new
  // proposed.storage_path (commitFlow reuses target_file_id for the
  // {file_id} path segment on replaces), the post-RPC cleanup would
  // delete the bytes we just published, leaving the file 400'ing on
  // every signed-URL fetch from then on.
  const writtenCanonicalPaths = new Set();

  // 1. + 2. Storage prep + existing-path lookups.
  for (const item of request.items) {
    if (item.kind === 'add' || item.kind === 'replace') {
      const pendingPath = item.proposed?.pending_storage_path;
      const canonicalPath = item.proposed?.storage_path;
      if (!pendingPath || !canonicalPath) {
        return { data: null, error: new Error(`Item ${item.id} missing storage paths`) };
      }
      writtenCanonicalPaths.add(canonicalPath);
      const thumbDest = item.proposed?.thumbnail_path;
      if (thumbDest) writtenCanonicalPaths.add(thumbDest);
      const framesDest = item.proposed?.thumbnail_frames;
      if (Array.isArray(framesDest)) {
        for (const f of framesDest) if (f) writtenCanonicalPaths.add(f);
      }
      // Best-effort destination clear so the copy below is idempotent.
      // Supabase storage's `copy()` 400s with "Duplicate" if the
      // destination already exists, which strands an approve forever
      // when a previous attempt got past the copy step but failed at
      // the RPC (e.g. the thumbnail_frames null bug fixed in
      // migration 020). The canonical destination is owned by this
      // approve flow — our pending bytes are authoritative — so
      // removing any prior occupant is correct. ENOENT-style failures
      // are swallowed (the file we tried to remove was never there).
      await supabase.storage.from('projects').remove([canonicalPath]).catch(() => {});
      const { error: copyErr } = await supabase
        .storage
        .from(PENDING_BUCKET)
        .copy(pendingPath, canonicalPath, { destinationBucket: 'projects' });
      if (copyErr) {
        return { data: null, error: new Error(`Copy failed: ${copyErr.message || copyErr}`) };
      }
      pendingPathsToDelete.push(pendingPath);

      // Thumbnail copy (best-effort; the UI falls back to the MIME
      // glyph if the thumb is missing). Same idempotency clear so a
      // retry doesn't 400 on a left-behind thumb from an earlier
      // partially-applied approve.
      const pendingThumb = item.proposed?.thumbnail_pending_path;
      const canonicalThumb = item.proposed?.thumbnail_path;
      if (pendingThumb && canonicalThumb) {
        await supabase.storage.from('projects').remove([canonicalThumb]).catch(() => {});
        const { error: thumbErr } = await supabase
          .storage
          .from(PENDING_BUCKET)
          .copy(pendingThumb, canonicalThumb, { destinationBucket: 'projects' });
        if (!thumbErr) pendingPathsToDelete.push(pendingThumb);
      }

      // Video frame copies (best-effort). The upload pipeline writes
      // every frame _thumb_N.jpg to the pending bucket but only the
      // poster (_thumb_0) rides along in `thumbnail_pending_path` —
      // the remaining frames live in `thumbnail_frames` as canonical
      // paths only. Without this loop, project_files.thumbnail_frames
      // ends up pointing at canonical paths that don't exist and the
      // slideshow's per-frame sign requests all 400.
      //
      // Path derivation: canonical is `{projectId}/{fileId}/_thumb_N.jpg`,
      // pending is `{projectId}/{userId}/{fileId}/_thumb_N.jpg` —
      // the only structural difference is the inserted user_id
      // segment. We rebuild the pending path from the canonical one
      // using request.author_id (the uploader). Skip the poster
      // (already copied above to avoid a duplicate-key 400).
      const frames = item.proposed?.thumbnail_frames;
      if (Array.isArray(frames) && frames.length > 0) {
        for (const canonicalFrame of frames) {
          if (!canonicalFrame || canonicalFrame === canonicalThumb) continue;
          const segs = canonicalFrame.split('/');
          if (segs.length < 3) continue;
          const pendingFrame = [segs[0], request.author_id, ...segs.slice(1)].join('/');
          await supabase.storage.from('projects').remove([canonicalFrame]).catch(() => {});
          const { error: frameErr } = await supabase
            .storage
            .from(PENDING_BUCKET)
            .copy(pendingFrame, canonicalFrame, { destinationBucket: 'projects' });
          if (!frameErr) pendingPathsToDelete.push(pendingFrame);
        }
      }
    }

    // For replace + delete: record the EXISTING canonical paths so
    // we can clean them up after the RPC. Must read project_files
    // before the RPC runs since the RPC will mutate/delete the row.
    if ((item.kind === 'replace' || item.kind === 'delete') && item.target_file_id) {
      const { data: existing } = await supabase
        .from('project_files')
        .select('storage_path, thumbnail_path, thumbnail_frames')
        .eq('id', item.target_file_id)
        .maybeSingle();
      // Skip any path we just wrote to in this approve — when
      // commitFlow reuses the existing file_id for a replace, the new
      // storage_path equals the old one and the sweep would otherwise
      // delete the bytes we just published.
      if (existing?.storage_path && !writtenCanonicalPaths.has(existing.storage_path)) {
        oldCanonicalPathsToDelete.push(existing.storage_path);
      }
      if (existing?.thumbnail_path && !writtenCanonicalPaths.has(existing.thumbnail_path)) {
        oldCanonicalPathsToDelete.push(existing.thumbnail_path);
      }
      if (Array.isArray(existing?.thumbnail_frames)) {
        for (const f of existing.thumbnail_frames) {
          if (f && !writtenCanonicalPaths.has(f)) oldCanonicalPathsToDelete.push(f);
        }
      }
    }
  }

  // 3. The atomic DB-side merge.
  const { data: rpcResult, error: rpcErr } = await supabase
    .rpc('approve_change_request', { p_request_id: request.id });
  if (rpcErr) {
    return { data: null, error: rpcErr };
  }

  // 4. Best-effort cleanup. Failures here only leak storage.
  if (pendingPathsToDelete.length > 0) {
    try { await supabase.storage.from(PENDING_BUCKET).remove(pendingPathsToDelete); }
    catch { /* swallow */ }
  }
  if (oldCanonicalPathsToDelete.length > 0) {
    try { await supabase.storage.from('projects').remove(oldCanonicalPathsToDelete); }
    catch { /* swallow */ }
  }

  return { data: rpcResult, error: null };
}

// Reject ONE item out of a (possibly multi-item) open request. The
// server-side RPC deletes the change_request_items row and only flips
// the parent request to 'rejected' when that was the last surviving
// item. Per-file decline lives here so admins can decline one file's
// edit without nuking sibling items the request happened to bundle.
//
// `item` must include `id`, `kind`, and `proposed` (for storage
// cleanup). Returns `{ data: { requestId, requestEmptied }, error }`
// so the caller can refetch the parent request when it's fully
// closed out.
export async function rejectChangeRequestItem(item, { note = null } = {}) {
  if (!item?.id) return { data: null, error: new Error('Missing item') };

  const { data: rpcRows, error: rpcErr } = await supabase
    .rpc('reject_change_request_item', {
      p_item_id: item.id,
      p_note: note,
    });
  if (rpcErr) return { data: null, error: rpcErr };

  // Best-effort cleanup of THIS item's pending bytes only. The frames
  // array stores canonical paths, not pending ones — the matching
  // pending objects share a prefix with thumbnail_pending_path but
  // aren't enumerated individually, so they leak a few hundred KB per
  // declined video item. The approve path has the same minor leak
  // (see approveChangeRequest); chasing it isn't worth a new column.
  const pendingPaths = [];
  if (item.kind === 'add' || item.kind === 'replace') {
    const p = item.proposed?.pending_storage_path;
    if (p) pendingPaths.push(p);
    const t = item.proposed?.thumbnail_pending_path;
    if (t) pendingPaths.push(t);
  }
  if (pendingPaths.length > 0) {
    try {
      await supabase.storage.from(PENDING_BUCKET).remove(pendingPaths);
    } catch { /* swallow */ }
  }

  const row = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  return {
    data: {
      requestId: row?.request_id || null,
      requestEmptied: Boolean(row?.request_emptied),
    },
    error: null,
  };
}

// Reject an open request. Cleans up pending storage objects after
// the RPC succeeds — keeping them would leak storage indefinitely.
// `note` is optional admin feedback that surfaces in the author's
// notification.
export async function rejectChangeRequest(request, note = null) {
  if (!request?.id || !request?.items) {
    return { error: new Error('Missing request or items') };
  }
  if (request.status !== 'open') {
    return { error: new Error(`Request is not open (status: ${request.status})`) };
  }

  const { error: rpcErr } = await supabase
    .rpc('reject_change_request', {
      p_request_id: request.id,
      p_note: note,
    });
  if (rpcErr) return { error: rpcErr };

  // Cleanup pending objects (for add/replace items). The member's
  // working copy is gone; they'll need to re-upload to resubmit.
  const pendingPaths = [];
  for (const item of request.items) {
    if (item.kind === 'add' || item.kind === 'replace') {
      const p = item.proposed?.pending_storage_path;
      if (p) pendingPaths.push(p);
      const t = item.proposed?.thumbnail_pending_path;
      if (t) pendingPaths.push(t);
    }
  }
  if (pendingPaths.length > 0) {
    try {
      await supabase.storage.from(PENDING_BUCKET).remove(pendingPaths);
    } catch { /* swallow */ }
  }
  return { error: null };
}

// ── Realtime subscriptions ────────────────────────────────────────────

// Subscribe to change_requests for one project. Admins get pinged
// when a new request lands; authors see status flips (approved /
// rejected) without polling. Returns an unsubscribe function;
// idempotent on repeat calls or on a channel that's already closing.
export function subscribeChangeRequests(projectId, onChange) {
  if (!projectId) return () => {};
  const channel = supabase
    .channel(`change_requests:${projectId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: REQUESTS_TABLE,
        filter: `project_id=eq.${projectId}`,
      },
      onChange,
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
  };
}

// Subscribe to branch_changes for the caller. Drives the live-overlay
// badges on cards across the member's multiple sessions / devices.
// Filtered by user_id so the realtime channel doesn't waste bandwidth
// on other members' queues (which RLS would deny anyway, but pre-
// filtering on the wire is cheaper).
export function subscribeOwnBranchChanges(projectId, userId, onChange) {
  if (!projectId || !userId) return () => {};
  const channel = supabase
    .channel(`branch_changes:${projectId}:${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: CHANGES_TABLE,
        filter: `project_id=eq.${projectId}`,
      },
      (payload) => {
        // Server-side filter only supports a single column; do the
        // user_id check on the client. RLS would have stripped other
        // users' rows anyway, but this guard skips the React update
        // for any noise that slips through (e.g. a future schema
        // tweak that loosens RLS).
        const row = payload.new || payload.old;
        if (row && row.user_id !== userId) return;
        onChange(payload);
      },
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
  };
}
