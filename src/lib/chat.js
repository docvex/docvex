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
// parent_id / pinned_at / pinned_by added in migration 026 (Variant B:
// threaded replies + pinned messages). Reactions live in a sibling table.
const COLS = 'id, project_id, author_id, body, mentions, attached_file_ids, created_at, edited_at, deleted_at, parent_id, pinned_at, pinned_by';
const REACTIONS_TABLE = 'chat_message_reactions';

// `limit` defaults to 100 — same magnitude as the notifications cap.
// Newest-first per the index in migration 024; the renderer reverses
// for chronological top-to-bottom display, which keeps the most-recent
// messages near the composer where the user's eye lands first.
//
// Only TOP-LEVEL messages (parent_id is null) belong in the main thread —
// threaded replies are loaded per-thread via listThreadReplies.
export async function listChatMessages(projectId, { limit = 100 } = {}) {
  if (!projectId) return { data: [], error: new Error('Missing projectId') };
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLS)
    .eq('project_id', projectId)
    .is('parent_id', null)
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

// ───── Threaded replies (migration 026) ─────────────────────────────
// A reply is a normal chat_messages row with parent_id set. Replies are
// excluded from the main list (listChatMessages filters parent_id null)
// and loaded per-thread here, oldest-first for natural reading order.
export async function listThreadReplies(parentId) {
  if (!parentId) return { data: [], error: new Error('Missing parentId') };
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLS)
    .eq('parent_id', parentId)
    .order('created_at', { ascending: true });
  return { data: data || [], error };
}

// All replies across the project in one shot — lets the renderer build
// the Threads rail (count + last reply per parent) AND open any thread
// without a per-thread round trip. Oldest-first.
export async function listProjectReplies(projectId) {
  if (!projectId) return { data: [], error: new Error('Missing projectId') };
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLS)
    .eq('project_id', projectId)
    .not('parent_id', 'is', null)
    .order('created_at', { ascending: true });
  return { data: data || [], error };
}

export async function sendThreadReply({ projectId, authorId, parentId, body, mentions = [] }) {
  if (!projectId || !authorId || !parentId) {
    return { data: null, error: new Error('Missing projectId/authorId/parentId') };
  }
  const trimmed = (body || '').trim();
  if (!trimmed) return { data: null, error: new Error('Empty reply') };
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      project_id: projectId,
      author_id: authorId,
      parent_id: parentId,
      body: trimmed,
      mentions: Array.from(new Set(mentions || [])).filter(Boolean),
    })
    .select(COLS)
    .single();
  return { data, error };
}

// ───── Pin / unpin (migration 026 RPC) ──────────────────────────────
// Goes through set_chat_message_pin (SECURITY DEFINER) so a member can
// pin ANY message without the loosened UPDATE RLS that would let them
// rewrite someone else's body. The pin flip echoes via the existing
// chat_messages realtime subscription (UPDATE on pinned_at).
export async function setChatMessagePin(messageId, pinned) {
  if (!messageId) return { error: new Error('Missing messageId') };
  const { error } = await supabase.rpc('set_chat_message_pin', {
    p_message_id: messageId,
    p_pinned: !!pinned,
  });
  return { error };
}

// ───── Reactions (migration 026) ────────────────────────────────────
// One row per (message, user, emoji). Loaded per-project in one shot so
// the renderer can fold them onto messages by message_id.
export async function listReactionsForProject(projectId) {
  if (!projectId) return { data: [], error: new Error('Missing projectId') };
  const { data, error } = await supabase
    .from(REACTIONS_TABLE)
    .select('id, message_id, user_id, emoji, created_at')
    .eq('project_id', projectId);
  return { data: data || [], error };
}

// Toggle the viewer's reaction. `mine` = does the viewer already have
// this emoji on this message (caller knows from the folded state) — when
// true we delete, otherwise insert. Returns { error }.
export async function toggleReaction({ messageId, projectId, userId, emoji, mine }) {
  if (!messageId || !projectId || !userId || !emoji) {
    return { error: new Error('Missing reaction fields') };
  }
  if (mine) {
    const { error } = await supabase
      .from(REACTIONS_TABLE)
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', userId)
      .eq('emoji', emoji);
    return { error };
  }
  const { error } = await supabase
    .from(REACTIONS_TABLE)
    .insert({ message_id: messageId, project_id: projectId, user_id: userId, emoji });
  // Unique-violation (double-tap race) is benign — the reaction exists.
  if (error && error.code === '23505') return { error: null };
  return { error };
}

// Realtime for reactions — INSERT/DELETE echoes across devices. Caller
// refetches (or folds the payload) on any event.
export function subscribeReactions(projectId, onChange) {
  if (!projectId) return () => {};
  const channel = supabase
    .channel(`chat_reactions:${projectId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: REACTIONS_TABLE, filter: `project_id=eq.${projectId}` },
      onChange,
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
  };
}
