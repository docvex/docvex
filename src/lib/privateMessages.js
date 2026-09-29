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

//
// END-TO-END (migration 046): `body` is ciphertext under the CONVERSATION's
// key (lib/e2e/dmKeys — sealed to both people's identity keys; not even other
// project members, nor the server, can read it), bound to the message id. Rows
// come back from here DECRYPTED; one this device can't open reads as
// UNREADABLE_TEXT with `body_unreadable: true`. Rows from before are plain.

import { supabase, realtimeSuffix } from './supabaseClient';
import { encryptDmText, decryptDmText } from './e2e/dmKeys';
import { UNREADABLE_TEXT } from './e2e/projectKeys';
import { E2E_REQUIRED, orderedAsync } from './e2e/policy';

export async function decryptPrivateRow(row) {
  if (!row || typeof row.body !== 'string' || !row.body) return row;
  try {
    const r = await decryptDmText(row.project_id, row.sender_id, row.recipient_id, row.body, { rowId: row.id });
    if (r.ok) return r.encrypted ? { ...row, body: r.text, body_encrypted: true } : row;
  } catch { /* below */ }
  return { ...row, body: UNREADABLE_TEXT, body_unreadable: true, body_encrypted: true };
}
const decryptRows = (rows) => Promise.all((rows || []).map(decryptPrivateRow));

async function sealBody(projectId, senderId, recipientId, id, text) {
  try {
    return await encryptDmText(projectId, senderId, recipientId, text, { rowId: id });
  } catch (err) {
    if (E2E_REQUIRED) throw err;
    return text;
  }
}

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
  return { data: Array.isArray(data) ? await decryptRows(data.slice().reverse()) : [], error };
}

// Insert a new DM. Returns the inserted row so the caller can
// optimistically render it before Realtime echoes it back.
export async function sendPrivateMessage({ projectId, senderId, recipientId, body }) {
  if (!projectId || !senderId || !recipientId) {
    return { data: null, error: new Error('Missing projectId/senderId/recipientId') };
  }
  const trimmed = (body || '').trim();
  if (!trimmed) return { data: null, error: new Error('Empty message') };
  const id = globalThis.crypto.randomUUID();
  let stored;
  try { stored = await sealBody(projectId, senderId, recipientId, id, trimmed); } catch (err) { return { data: null, error: err }; }
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      id,
      project_id: projectId,
      sender_id: senderId,
      recipient_id: recipientId,
      body: stored,
    })
    .select(COLS)
    .single();
  return { data: data ? { ...data, body: trimmed, body_encrypted: stored !== trimmed } : data, error };
}

// Edit your own private message. RLS limits the update to
// sender_id = auth.uid(). edited_at bumped client-side so the
// recipient's UI can show "(edited)".
export async function editPrivateMessage(id, body) {
  if (!id) return { data: null, error: new Error('Missing id') };
  const trimmed = (body || '').trim();
  if (!trimmed) return { data: null, error: new Error('Empty message') };
  const { data: row, error: rErr } = await supabase.from(TABLE)
    .select('project_id, sender_id, recipient_id').eq('id', id).maybeSingle();
  if (rErr || !row) return { data: null, error: rErr || new Error('Message not found') };
  let sealed;
  try { sealed = await sealBody(row.project_id, row.sender_id, row.recipient_id, id, trimmed); } catch (err) { return { data: null, error: err }; }
  const { data, error } = await supabase
    .from(TABLE)
    .update({ body: sealed, edited_at: new Date().toISOString() })
    .eq('id', id)
    .select(COLS)
    .single();
  return { data: data ? await decryptPrivateRow(data) : data, error };
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
const decryptPayload = async (payload) => {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  if (payload.new && typeof payload.new === 'object') out.new = await decryptPrivateRow(payload.new);
  if (payload.old && typeof payload.old === 'object' && payload.old.body) out.old = await decryptPrivateRow(payload.old);
  return out;
};

export function subscribePrivateMessages(projectId, onChangeRaw) {
  if (!projectId) return () => {};
  const onChange = orderedAsync(onChangeRaw)(decryptPayload);
  const channel = supabase
    .channel(`private_messages:${projectId}:${realtimeSuffix()}`)
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
