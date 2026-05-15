// Thin Supabase wrappers for the project_files table + the matching
// objects in the `projects` storage bucket.
//
// Patterned after src/lib/projects.js and src/lib/notificationsRepo.js —
// every function returns `{ data, error }`, never throws. RLS does the
// authorization on every read; callers don't add their own user-id
// filters. The split between "metadata row" (this file) and "binary
// upload pipeline" (uploadProjectFile.js) is intentional: this file is
// pure data access, the other owns runtime concerns (XHR, AbortController,
// progress callbacks) the supabase-js SDK doesn't expose.
//
// Path convention for the bucket — enforced by the storage.objects RLS
// policies at supabase/migrations/001_projects.sql:263-278:
//   `{project_id}/{file_id}/{filename}`
// The `{file_id}` segment equals the project_files row's id, so the
// metadata row and the binary share one identity.

import { supabase } from './supabaseClient';
import { evictPdf } from './pdfCache';

// Bucket name — also referenced by uploadProjectFile.js. Centralised so
// rename / migration to a new bucket only touches one constant.
export const BUCKET = 'projects';
const TABLE = 'project_files';

// ── Metadata reads ────────────────────────────────────────────────────────

// Column list used by both the list query and the insert's RETURNING
// clause. Centralised so adding a column (e.g. thumbnail_path landed in
// migration 004, description in migration 005) only requires one edit.
// Strings are concatenated at definition time so this is constant-folded
// by the bundler.
const SELECT_COLUMNS =
  'id, project_id, name, description, mime_type, size_bytes, storage_path, ' +
  'thumbnail_path, thumbnail_frames, uploaded_by, uploaded_at';

// Newest-first list of files for a project. RLS gates by viewer+ via the
// "viewers read project files" policy, so callers don't add a project-
// membership filter themselves. The project_files_project_uploaded_idx
// composite index on (project_id, uploaded_at desc) serves this query
// path directly.
export async function listProjectFiles(projectId) {
  if (!projectId) return { data: [], error: new Error('Missing projectId') };
  const { data, error } = await supabase
    .from(TABLE)
    .select(SELECT_COLUMNS)
    .eq('project_id', projectId)
    .order('uploaded_at', { ascending: false });
  return { data: data || [], error };
}

// Insert a metadata row AFTER the binary has landed in storage. The
// uploader is required because the RLS WITH CHECK pins it to auth.uid()
// — passing the wrong id would be rejected by the policy anyway, but
// requiring it explicitly keeps the call-site honest. The same `id` is
// already in the storage path's middle segment.
//
// `thumbnailPath` is optional — null/undefined means "no preview thumb"
// (text files, generation failure, or pre-migration-004 uploads). The
// renderer falls back to a MIME-keyed glyph in that case.
export async function insertProjectFileRow({
  id,
  projectId,
  name,
  mimeType,
  sizeBytes,
  storagePath,
  thumbnailPath = null,
  thumbnailFrames = null,
  uploadedBy,
}) {
  const row = {
    id,
    project_id: projectId,
    name,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    storage_path: storagePath,
    thumbnail_path: thumbnailPath,
    // Null for non-video / legacy rows; populated string[] when the
    // uploader extracted >=2 frames for the hover slideshow.
    thumbnail_frames: thumbnailFrames,
    uploaded_by: uploadedBy,
  };
  const { data, error } = await supabase
    .from(TABLE)
    .insert(row)
    .select(SELECT_COLUMNS)
    .single();
  return { data, error };
}

// ── Storage URLs ──────────────────────────────────────────────────────────

// Module-level memoization for signed URLs keyed by storage_path. Re-opening
// the same file within the URL's TTL returns the cached URL synchronously —
// no second Supabase round-trip — which also means the resolved URL is
// identical across reopens, letting the browser's HTTP cache hit the
// thumbnail / image / video binary too. Effect: second-and-subsequent
// opens of the same file feel instant.
//
// Bounded by FIFO eviction at MAX_SIGNED_URL_CACHE so a user who scrolls
// through hundreds of files doesn't grow the Map unbounded. Each entry is
// ~600 bytes (URL string + tiny metadata), so the cap caps memory at ~120KB.
const _signedUrlCache = new Map();
const MAX_SIGNED_URL_CACHE = 200;
// Refresh slightly before actual expiry so callers never get a URL that
// dies mid-fetch. 30s is a comfortable margin given typical fetch durations.
const SIGNED_URL_SAFETY_MS = 30_000;

// Short-lived signed URL for downloading / inline-viewing a file. The
// 5-minute default is enough for the user to click through and the
// browser to fetch. Cached (see above) so repeat opens skip the round-trip.
// Pass `expiresIn` of 600+ if you need a long-lived URL for video streaming.
export async function createSignedDownloadUrl(storagePath, expiresIn = 300) {
  if (!storagePath) return { data: null, error: new Error('Missing storagePath') };

  const now = Date.now();
  const cached = _signedUrlCache.get(storagePath);
  if (cached && cached.expiresAt > now + SIGNED_URL_SAFETY_MS) {
    // Cache hit — return the same shape supabase-js would.
    return { data: { signedUrl: cached.url }, error: null };
  }

  const { data, error } = await supabase
    .storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresIn);

  if (!error && data?.signedUrl) {
    // Evict the oldest entry if at cap — Map iteration is insertion-order
    // so .keys().next().value gives the oldest.
    if (_signedUrlCache.size >= MAX_SIGNED_URL_CACHE) {
      const oldest = _signedUrlCache.keys().next().value;
      if (oldest !== undefined) _signedUrlCache.delete(oldest);
    }
    _signedUrlCache.set(storagePath, {
      url: data.signedUrl,
      expiresAt: now + expiresIn * 1000,
    });
  }
  return { data, error };
}

// Manual eviction — called from delete paths so a stale cached URL for a
// just-deleted file doesn't get handed out to a future caller (e.g. an
// optimistic UI element). Idempotent; missing key is a no-op.
export function evictSignedUrlCache(storagePath) {
  if (storagePath) _signedUrlCache.delete(storagePath);
}

// Nuke every cached signed URL. Used by the DEBUG button in FileDetailModal
// + intended for any future sign-out hookup. Cheap operation; the Map just
// clears in place.
export function clearSignedUrlCache() {
  _signedUrlCache.clear();
}

// Signed upload URL — supabase-js doesn't expose progress/abort on its
// `.upload()` method, so we obtain a one-shot signed URL and PUT to it
// via XMLHttpRequest in uploadProjectFile.js. The returned shape is
// `{ signedUrl, token, path }`; the caller uses `signedUrl` directly.
export async function createSignedUploadTarget(storagePath) {
  if (!storagePath) return { data: null, error: new Error('Missing storagePath') };
  const { data, error } = await supabase
    .storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath);
  return { data, error };
}

// Delete a binary object from storage. ONLY used for orphan cleanup when
// the metadata insert fails after the binary upload succeeded — there is
// no delete UI in v1. The storage.objects "admins delete project files"
// policy gates this, so a non-admin member's orphan-clean attempt fails
// silently; a server-side sweeper or admin can mop those up later.
export async function deleteStorageObject(storagePath) {
  if (!storagePath) return { data: null, error: new Error('Missing storagePath') };
  const { data, error } = await supabase
    .storage
    .from(BUCKET)
    .remove([storagePath]);
  return { data, error };
}

// ── Realtime ──────────────────────────────────────────────────────────────

// Subscribe to project_files changes for one project. `onChange` is
// invoked with the raw postgres_changes payload: { eventType, new, old }.
// Channel name is keyed on projectId so switching projects (subscribe →
// unsubscribe → subscribe) doesn't collide with the previous still-
// closing channel. Same shape as subscribeForUser in notificationsRepo.js.
//
// Returns an unsubscribe function. Idempotent: calling it twice or
// calling with a non-existent channel is harmless.
export function subscribeForProject(projectId, onChange) {
  if (!projectId) return () => {};
  const channel = supabase
    .channel(`project_files:${projectId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: TABLE,
        filter: `project_id=eq.${projectId}`,
      },
      onChange
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
  };
}

// ── Description edit ─────────────────────────────────────────────────────

// Patch ONLY the description column. We deliberately don't expose a
// generic update helper — name / mime_type / storage_path should never
// be reassigned post-upload, and the narrow surface here makes that a
// compile-time fact for callers. Empty / whitespace-only strings are
// normalised to NULL so "" and "  " don't read as "the user explicitly
// set a blank description" in the UI.
//
// RLS (migration 005) gates the write to uploader-or-admin; the caller
// doesn't need to add a where-clause for the auth check. The RPC will
// return zero rows if the gate rejects, which surfaces as a "row not
// found" error from .single() — the caller can display that to the
// user without leaking who is or isn't authorized.
export async function updateProjectFileDescription(id, description) {
  if (!id) return { data: null, error: new Error('Missing id') };
  const normalised = description?.trim() ? description.trim() : null;
  const { data, error } = await supabase
    .from(TABLE)
    .update({ description: normalised })
    .eq('id', id)
    .select(SELECT_COLUMNS)
    .single();
  return { data, error };
}

// ── Full delete (binary + thumbnail + row) ──────────────────────────────

// Deletes the binary(ies) FIRST, then the metadata row. Order matters:
// the storage RLS policy's uploader-path EXISTS subquery (migration
// 005) needs the project_files row to still exist to authorize the
// uploader. Swapping the order would lock out non-admin uploaders from
// deleting their own storage object (admin still works either way —
// the admin path doesn't depend on the row).
//
// supabase.storage.remove([…]) silently no-ops on "object not found",
// so calling with a thumbnail_path that's stale (orphaned object) is
// safe. The row delete is the source of truth for "the file is gone";
// any storage leftover is mopped up by the periodic admin sweeper /
// dashboard cleanup.
export async function deleteProjectFile({ id, storagePath, thumbnailPath, thumbnailFrames }) {
  if (!id || !storagePath) {
    return { data: null, error: new Error('Missing id or storagePath') };
  }
  const paths = [storagePath];
  // Video files: every frame path goes in the remove() batch. Includes
  // frame 0 (= thumbnailPath for new uploads); de-dup so we don't pass
  // the same path twice. Storage.remove silently no-ops on misses.
  if (Array.isArray(thumbnailFrames) && thumbnailFrames.length > 0) {
    for (const f of thumbnailFrames) {
      if (f && !paths.includes(f)) paths.push(f);
    }
  }
  if (thumbnailPath && !paths.includes(thumbnailPath)) paths.push(thumbnailPath);
  const { error: storageErr } = await supabase.storage.from(BUCKET).remove(paths);
  if (storageErr) {
    // Storage delete failed (RLS rejection for unauthorized callers,
    // network blip, etc.). Bubble — don't proceed to the row delete:
    // a row-only delete would orphan the binary and the file would
    // disappear from the UI but still exist in storage indefinitely.
    return { data: null, error: storageErr };
  }
  const { error: rowErr } = await supabase
    .from(TABLE)
    .delete()
    .eq('id', id);
  if (rowErr) return { data: null, error: rowErr };

  // Drop any cached signed URLs so a stale URL doesn't get handed out to
  // a UI element that re-renders after delete. The PDF doc cache is
  // evicted in lockstep so a re-uploaded file doesn't pick up a parsed
  // handle that no longer matches reality (the storage path encodes the
  // file id, so re-upload would get a fresh path anyway — this is
  // defence in depth + frees memory immediately).
  evictSignedUrlCache(storagePath);
  if (thumbnailPath) evictSignedUrlCache(thumbnailPath);
  if (Array.isArray(thumbnailFrames)) {
    for (const f of thumbnailFrames) evictSignedUrlCache(f);
  }
  evictPdf(storagePath);

  return { data: { id }, error: null };
}

// ── Uploader profile lookup ──────────────────────────────────────────────

// Single-uuid wrapper around the existing get_member_profiles RPC
// (defined at supabase/migrations/001_projects.sql:230-237; called
// today from src/lib/projects.js:163-187 for the Members tab). Returns
// one profile row or null — null means the user was deleted (FK was set
// null on auth.users delete per migration 003) or the RPC returned no
// match. The detail modal renders "Unknown" + an initial-letter avatar
// in that case.
export async function fetchUploaderProfile(userId) {
  if (!userId) return { data: null, error: null };
  const { data, error } = await supabase
    .rpc('get_member_profiles', { p_user_ids: [userId] });
  if (error) return { data: null, error };
  return { data: data?.[0] || null, error: null };
}
