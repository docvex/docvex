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

// Bucket name — also referenced by uploadProjectFile.js. Centralised so
// rename / migration to a new bucket only touches one constant.
export const BUCKET = 'projects';
const TABLE = 'project_files';

// ── Metadata reads ────────────────────────────────────────────────────────

// Newest-first list of files for a project. RLS gates by viewer+ via the
// "viewers read project files" policy, so callers don't add a project-
// membership filter themselves. The project_files_project_uploaded_idx
// composite index on (project_id, uploaded_at desc) serves this query
// path directly.
export async function listProjectFiles(projectId) {
  if (!projectId) return { data: [], error: new Error('Missing projectId') };
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, project_id, name, mime_type, size_bytes, storage_path, uploaded_by, uploaded_at')
    .eq('project_id', projectId)
    .order('uploaded_at', { ascending: false });
  return { data: data || [], error };
}

// Insert a metadata row AFTER the binary has landed in storage. The
// uploader is required because the RLS WITH CHECK pins it to auth.uid()
// — passing the wrong id would be rejected by the policy anyway, but
// requiring it explicitly keeps the call-site honest. The same `id` is
// already in the storage path's middle segment.
export async function insertProjectFileRow({
  id,
  projectId,
  name,
  mimeType,
  sizeBytes,
  storagePath,
  uploadedBy,
}) {
  const row = {
    id,
    project_id: projectId,
    name,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    storage_path: storagePath,
    uploaded_by: uploadedBy,
  };
  const { data, error } = await supabase
    .from(TABLE)
    .insert(row)
    .select('id, project_id, name, mime_type, size_bytes, storage_path, uploaded_by, uploaded_at')
    .single();
  return { data, error };
}

// ── Storage URLs ──────────────────────────────────────────────────────────

// Short-lived signed URL for downloading / inline-viewing a file. The
// 5-minute default is enough for the user to click through and the
// browser to fetch; the URL is single-purpose and not stored anywhere.
// Increase expiresIn for video streaming if seek-back-after-pause stops
// working.
export async function createSignedDownloadUrl(storagePath, expiresIn = 300) {
  if (!storagePath) return { data: null, error: new Error('Missing storagePath') };
  const { data, error } = await supabase
    .storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresIn);
  return { data, error };
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
