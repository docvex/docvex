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
export async function getBranchState(projectId) {
  if (!projectId) return { data: null, error: new Error('Missing projectId') };
  const { data, error } = await supabase
    .from(BRANCHES_TABLE)
    .select(BRANCH_COLS)
    .eq('project_id', projectId)
    .maybeSingle();
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
  const existing = await getBranchState(projectId);
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
  const { error } = await supabase
    .from(BRANCHES_TABLE)
    .update({ base_version: version })
    .eq('project_id', projectId);
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

// Compute the diff between the user's local folder and the
// canonical project_files list. Output drives the commit modal's
// item preview AND the post-confirm upload + change_request
// creation. Match key is the on-disk filename (lower-cased to
// match Windows' case-insensitive filesystem).
//
// Returned shape:
//   [{ kind: 'add', local }]                   — file on disk, no cloud counterpart
//   [{ kind: 'replace', local, cloud }]        — same filename, different bytes
//   [{ kind: 'delete', cloud }]                — file in cloud, no local counterpart
//
// Detection ladder (most precise first):
//   0. localFiles is empty → return []. An empty local folder is
//      treated as the "clean / not-yet-materialized" state, not as
//      "I deleted all the cloud files". The user materialises their
//      branch by downloading or adding files; until they do there's
//      nothing meaningful to commit. Also: matches the post-Reset
//      state — Reset wipes local and we want the commit affordance
//      to disappear, not flip to "commit N deletes".
//   1. content_hash on BOTH sides → compare hashes. Catches same-size
//      content edits (image re-encode, video re-render).
//   2. size on both sides → fall back to size comparison. Used when
//      either side hasn't been hashed yet (legacy rows, files the
//      renderer hasn't background-hashed yet).
//   3. Filename only → presence/absence drives add / delete.
//   4. Filter out items that are already covered by an OPEN
//      change_request from this author — see the `openRequestItems`
//      argument. Push doesn't mutate the filesystem; without this
//      filter the same items would keep showing as pending forever
//      until admin approval physically rewrites the cloud.
//
// `localHashByName`     — Map<lowercase-filename, hex-sha256> filled
//                         by the renderer's background hasher.
// `cloudHashByFileId`   — Map<project_files.id, hex-sha256> used as
//                         a fallback when project_files.content_hash
//                         is null (legacy rows uploaded before
//                         migration 014). Filled by the renderer
//                         lazily — see ProjectFiles.jsx.
// `openRequestItems`    — items currently sitting in the author's
//                         open change_request. Diff items targeting
//                         the same file (by target_file_id) or the
//                         same canonical add name are filtered out
//                         so the Commit-changes button hides as
//                         soon as a push lands.
//
// Pure function — no Supabase IO.
export function computeBranchDiff(localFiles, cloudFiles, localHashByName, cloudHashByFileId, openRequestItems) {
  // Empty local short-circuits to no-diff — see ladder step 0 above.
  if (!Array.isArray(localFiles) || localFiles.length === 0) return [];
  const cloudByFilename = new Map();
  for (const c of cloudFiles || []) {
    const filename = (c.storage_path || '').split('/').pop();
    if (filename) cloudByFilename.set(filename.toLowerCase(), c);
  }
  const localByFilename = new Map();
  for (const l of localFiles || []) {
    if (l?.name) localByFilename.set(l.name.toLowerCase(), l);
  }
  // `let` (not const) so the rename-detection pass below can rebuild
  // the array via filter().
  let items = [];
  for (const local of localFiles || []) {
    const key = local.name.toLowerCase();
    const cloud = cloudByFilename.get(key);
    if (!cloud) {
      items.push({ kind: 'add', local });
      continue;
    }
    const localHash = localHashByName?.get(key);
    // Prefer the stored hash from project_files (populated post-014).
    // Fall back to the renderer's on-demand backfill cache for legacy
    // rows whose content_hash column is still null.
    const cloudHash = cloud.content_hash || cloudHashByFileId?.get(cloud.id);
    let changed;
    if (localHash && cloudHash) {
      // Precise path: both sides hashed.
      changed = localHash !== cloudHash;
    } else {
      // Fallback: size compare. Misses same-size content edits, but
      // never false-positives a real change.
      changed = Number(cloud.size_bytes) !== Number(local.sizeBytes);
    }
    if (changed) items.push({ kind: 'replace', local, cloud });
  }
  for (const cloud of cloudFiles || []) {
    const filename = (cloud.storage_path || '').split('/').pop();
    if (filename && !localByFilename.has(filename.toLowerCase())) {
      items.push({ kind: 'delete', cloud });
    }
  }

  // Rename detection. After a metadata-rename via the FileDetailModal
  // on My branch, the local file is renamed on disk too — so the
  // filesystem now has e.g. local "bar.png" with content hash X
  // and cloud still has "foo.png" with content hash X. Without
  // intervention this looks like delete(foo) + add(bar), which
  // would duplicate the rename intent that's already queued as an
  // 'edit' branch_change. Pair add↔delete entries with matching
  // content_hash and drop both — the rename is represented solely
  // by the branch_change.
  if (localHashByName && (cloudHashByFileId || (cloudFiles || []).some((c) => c.content_hash))) {
    const renamedCloudIds  = new Set();
    const renamedLocalKeys = new Set();
    for (const item of items) {
      if (item.kind !== 'add' || !item.local) continue;
      const key = (item.local.name || '').toLowerCase();
      const lh = localHashByName.get(key);
      if (!lh) continue;
      for (const other of items) {
        if (other.kind !== 'delete' || !other.cloud) continue;
        if (renamedCloudIds.has(other.cloud.id)) continue;
        const ch = other.cloud.content_hash || cloudHashByFileId?.get(other.cloud.id);
        if (ch && ch === lh) {
          renamedCloudIds.add(other.cloud.id);
          renamedLocalKeys.add(key);
          break;
        }
      }
    }
    if (renamedCloudIds.size > 0) {
      items = items.filter((item) => {
        if (item.kind === 'add' && item.local
            && renamedLocalKeys.has(item.local.name.toLowerCase())) return false;
        if (item.kind === 'delete' && item.cloud
            && renamedCloudIds.has(item.cloud.id)) return false;
        return true;
      });
    }
  }

  // Filter out items already covered by an open change_request the
  // caller passed in. Match by target_file_id for replace/delete/edit;
  // by proposed.name (lower-cased) for adds, since adds don't have a
  // cloud row to point at — only a future filename.
  if (Array.isArray(openRequestItems) && openRequestItems.length > 0) {
    const coveredTargetIds = new Set();
    const coveredAddNames  = new Set();
    for (const it of openRequestItems) {
      if (it.target_file_id) coveredTargetIds.add(it.target_file_id);
      if (it.kind === 'add' && it.proposed?.name) {
        coveredAddNames.add(it.proposed.name.toLowerCase());
      }
    }
    return items.filter((item) => {
      if (item.kind === 'add' && item.local?.name) {
        return !coveredAddNames.has(item.local.name.toLowerCase());
      }
      const targetId = item.cloud?.id;
      if (targetId && coveredTargetIds.has(targetId)) return false;
      return true;
    });
  }
  return items;
}

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
}) {
  if (!projectId || !userId || !blob || !fileName) {
    return { data: null, error: new Error('Missing required arg') };
  }
  // Mint a file_id so the canonical storage_path the approve RPC
  // will write to project_files.storage_path is already final at
  // submit time. Avoids any post-approval renaming dance.
  const fileId = crypto.randomUUID();
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

  // 1. + 2. Storage prep + existing-path lookups.
  for (const item of request.items) {
    if (item.kind === 'add' || item.kind === 'replace') {
      const pendingPath = item.proposed?.pending_storage_path;
      const canonicalPath = item.proposed?.storage_path;
      if (!pendingPath || !canonicalPath) {
        return { data: null, error: new Error(`Item ${item.id} missing storage paths`) };
      }
      const { error: copyErr } = await supabase
        .storage
        .from(PENDING_BUCKET)
        .copy(pendingPath, canonicalPath, { destinationBucket: 'projects' });
      if (copyErr) {
        return { data: null, error: new Error(`Copy failed: ${copyErr.message || copyErr}`) };
      }
      pendingPathsToDelete.push(pendingPath);

      // Thumbnail copy (best-effort; the UI falls back to the MIME
      // glyph if the thumb is missing).
      const pendingThumb = item.proposed?.thumbnail_pending_path;
      const canonicalThumb = item.proposed?.thumbnail_path;
      if (pendingThumb && canonicalThumb) {
        const { error: thumbErr } = await supabase
          .storage
          .from(PENDING_BUCKET)
          .copy(pendingThumb, canonicalThumb, { destinationBucket: 'projects' });
        if (!thumbErr) pendingPathsToDelete.push(pendingThumb);
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
      if (existing?.storage_path)   oldCanonicalPathsToDelete.push(existing.storage_path);
      if (existing?.thumbnail_path) oldCanonicalPathsToDelete.push(existing.thumbnail_path);
      if (Array.isArray(existing?.thumbnail_frames)) {
        for (const f of existing.thumbnail_frames) {
          if (f) oldCanonicalPathsToDelete.push(f);
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
