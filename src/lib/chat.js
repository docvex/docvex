// Chat data layer — thin wrappers around the `chat_messages` table.
// Mirrors the pattern in notificationsRepo.js and branches.js: every
// function returns `{ data, error }`, no exceptions thrown for
// expected failures.
//
// Schema reference (see migration 024_chat_messages.sql):
//   id                 uuid PK
//   project_id         uuid (FK projects)
//   author_id          uuid (FK auth.users)
//   body               text  — Markdown-light, rendered client-side
//   mentions           uuid[]  — user_ids to ping
//   attached_file_ids  uuid[]  — project_files ids surfaced as cards
//   created_at         timestamptz
//   edited_at          timestamptz?
//   deleted_at         timestamptz?  — soft delete tombstone

import { supabase } from './supabaseClient';

const TABLE = 'chat_messages';
const COLS = 'id, project_id, author_id, body, mentions, attached_file_ids, created_at, edited_at, deleted_at';

// `limit` defaults to 100 — same magnitude as the notifications cap.
// Newest-first per the index in migration 024; the renderer reverses
// for chronological top-to-bottom display, which keeps the most-recent
// messages near the composer where the user's eye lands first.
export async function listChatMessages(projectId, { limit = 100 } = {}) {
  if (!projectId) return { data: [], error: new Error('Missing projectId') };
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return { data: Array.isArray(data) ? data.slice().reverse() : [], error };
}

// Insert a new message. mentions / attached_file_ids default to empty
// arrays so callers can omit them when the message has neither.
export async function sendChatMessage({
  projectId,
  authorId,
  body,
  mentions = [],
  attachedFileIds = [],
}) {
  if (!projectId || !authorId) {
    return { data: null, error: new Error('Missing projectId/authorId') };
  }
  const trimmed = (body || '').trim();
  if (!trimmed) {
    return { data: null, error: new Error('Empty message') };
  }
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      project_id: projectId,
      author_id: authorId,
      body: trimmed,
      mentions: Array.from(new Set(mentions || [])).filter(Boolean),
      attached_file_ids: Array.from(new Set(attachedFileIds || [])).filter(Boolean),
    })
    .select(COLS)
    .single();
  return { data, error };
}

// Edit your own message. RLS limits the update to author_id =
// auth.uid(). Bumps edited_at server-side via the same statement.
// Mentions can change on edit (typing a new @ in an edit) — the
// notification trigger re-fires on UPDATE for that case; existing
// mentions deduplicate via the per-(message, user) dedupe_key.
export async function editChatMessage(id, { body, mentions, attachedFileIds }) {
  if (!id) return { data: null, error: new Error('Missing id') };
  const patch = { edited_at: new Date().toISOString() };
  if (typeof body === 'string') patch.body = body.trim();
  if (Array.isArray(mentions)) {
    patch.mentions = Array.from(new Set(mentions)).filter(Boolean);
  }
  if (Array.isArray(attachedFileIds)) {
    patch.attached_file_ids = Array.from(new Set(attachedFileIds)).filter(Boolean);
  }
  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq('id', id)
    .select(COLS)
    .single();
  return { data, error };
}

// Soft-delete: flip deleted_at + null the body so a curious admin
// querying the table directly can't read the original contents.
// Mentions array is also cleared so the trigger's filter (the
// "deleted_at is not null" guard in _notify_chat_mentions) is the
// belt and suspenders is the empty mentions array.
export async function deleteChatMessage(id) {
  if (!id) return { error: new Error('Missing id') };
  const { error } = await supabase
    .from(TABLE)
    .update({
      body: '',
      mentions: [],
      attached_file_ids: [],
      deleted_at: new Date().toISOString(),
    })
    .eq('id', id);
  return { error };
}

// Realtime subscription scoped to a single project. Returns an
// unsubscribe function. INSERT / UPDATE / DELETE all flow through
// `onChange(payload)` — soft deletes arrive as UPDATEs with
// deleted_at set, true row deletes (project cascade) as DELETE.
export function subscribeChatMessages(projectId, onChange) {
  if (!projectId) return () => {};
  const channel = supabase
    .channel(`chat_messages:${projectId}`)
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
