// Private (direct) messages between two project members. Mirrors the
// chat.js helper shape (`{ data, error }` returns, no thrown
// exceptions for expected failures) so the Chat page's data layer
// reads uniformly between Team and Private surfaces.
//
// Schema reference (migration 026_private_messages.sql):
//   id            uuid PK
//   project_id    uuid    — scopes the DM to a single project
//   sender_id     uuid    — auth.users
//   recipient_id  uuid    — auth.users
//   body          text
//   created_at    timestamptz
//   edited_at     timestamptz?
//   deleted_at    timestamptz?  — soft-delete tombstone

import { supabase } from './supabaseClient';

const TABLE = 'private_messages';
const COLS = 'id, project_id, sender_id, recipient_id, body, created_at, edited_at, deleted_at';

// Fetch the chronological thread between the viewer and one other
// member of the project. The RLS policy already filters out anything
// the viewer shouldn't see, but we also constrain the query by
// (viewer, partner) tuple so we don't pull every DM the viewer has
// in this project. Newest-first per the thread index, reversed
// client-side so the renderer can render top-down.
export async function listPrivateMessages(projectId, viewerId, partnerId, { limit = 100 } = {}) {
  if (!projectId || !viewerId || !partnerId) {
    return { data: [], error: new Error('Missing projectId/viewerId/partnerId') };
  }
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLS)
    .eq('project_id', projectId)
    .or(
      `and(sender_id.eq.${viewerId},recipient_id.eq.${partnerId}),`
      + `and(sender_id.eq.${partnerId},recipient_id.eq.${viewerId})`,
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  return { data: Array.isArray(data) ? data.slice().reverse() : [], error };
}

// Insert a new DM. Returns the inserted row so the caller can
// optimistically render it before Realtime echoes it back.
export async function sendPrivateMessage({ projectId, senderId, recipientId, body }) {
  if (!projectId || !senderId || !recipientId) {
    return { data: null, error: new Error('Missing projectId/senderId/recipientId') };
  }
  const trimmed = (body || '').trim();
  if (!trimmed) return { data: null, error: new Error('Empty message') };
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      project_id: projectId,
      sender_id: senderId,
      recipient_id: recipientId,
      body: trimmed,
    })
    .select(COLS)
    .single();
  return { data, error };
}

// Edit your own private message. RLS limits the update to
// sender_id = auth.uid(). edited_at bumped client-side so the
// recipient's UI can show "(edited)".
export async function editPrivateMessage(id, body) {
  if (!id) return { data: null, error: new Error('Missing id') };
  const trimmed = (body || '').trim();
  if (!trimmed) return { data: null, error: new Error('Empty message') };
  const { data, error } = await supabase
    .from(TABLE)
    .update({ body: trimmed, edited_at: new Date().toISOString() })
    .eq('id', id)
    .select(COLS)
    .single();
  return { data, error };
}

// Soft-delete: flip deleted_at + null the body so an admin reading
// the table directly can't recover the message text.
export async function deletePrivateMessage(id) {
  if (!id) return { error: new Error('Missing id') };
  const { error } = await supabase
    .from(TABLE)
    .update({
      body: '',
      deleted_at: new Date().toISOString(),
    })
    .eq('id', id);
  return { error };
}

// Realtime subscription scoped to a project. Filtering by project_id
// alone is fine — RLS still hides messages the viewer isn't part of,
// so the renderer only sees rows for conversations it should see.
// Returns an unsubscribe function. INSERT / UPDATE / DELETE all flow
// through `onChange(payload)`.
export function subscribePrivateMessages(projectId, onChange) {
  if (!projectId) return () => {};
  const channel = supabase
    .channel(`private_messages:${projectId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: TABLE,
        filter: `project_id=eq.${projectId}`,
      },
      onChange,
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
  };
}
