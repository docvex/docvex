-- chat_messages: per-project team conversation surface.
--
-- One row per posted message. mentions[] and attached_file_ids[] are
-- denormalised arrays (vs join tables) because (a) v1 doesn't query
-- "who was mentioned where" at scale, (b) array GIN indexes on uuid[]
-- are fast enough for the @mention notification trigger, (c) Realtime
-- payloads carry the full row so the renderer doesn't need a follow-up
-- fetch to know which files were attached.
--
-- Edits update `body` + bump `edited_at`. Deletes are SOFT — `deleted_at`
-- is set and the body becomes hidden client-side. We don't hard-delete
-- because Realtime DELETE echoes carry only the row id (REPLICA IDENTITY
-- defaults to id-only), and other devices need at least body=null +
-- the timestamp to render a "message deleted" placeholder.

create table public.chat_messages (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects(id) on delete cascade,
  author_id          uuid not null references auth.users(id) on delete cascade,
  body               text not null,
  mentions           uuid[] not null default '{}',
  attached_file_ids  uuid[] not null default '{}',
  created_at         timestamptz not null default now(),
  edited_at          timestamptz,
  deleted_at         timestamptz
);

-- Primary query: "give me the recent messages for this project, newest
-- first." Hits this index. Filters on deleted_at happen client-side so
-- soft-deleted rows still echo via Realtime (the client renders them
-- as a tombstone placeholder).
create index chat_messages_project_created_idx
  on public.chat_messages (project_id, created_at desc);

-- GIN on mentions[] — used by the notification trigger to short-
-- circuit when the array is empty, and reserved for a future
-- "things that mention me" query.
create index chat_messages_mentions_gin_idx
  on public.chat_messages using gin (mentions);

alter table public.chat_messages enable row level security;

-- READ: every member of the project sees every message. Same gate
-- the rest of the project-scoped tables use (has_project_role).
create policy "chat: members read project messages"
  on public.chat_messages
  for select
  using (public.has_project_role(project_id, 'member'));

-- INSERT: any member can post, but author_id MUST match auth.uid()
-- (no impersonation). The trigger in 025 uses author_id; rejecting
-- a forged value here keeps the trigger's mention payload trustworthy.
create policy "chat: members post own messages"
  on public.chat_messages
  for insert
  with check (
    public.has_project_role(project_id, 'member')
    and author_id = (select auth.uid())
  );

-- UPDATE: author edits own message. Only body, mentions,
-- attached_file_ids, edited_at, deleted_at are realistically updated
-- — the rest are effectively immutable (id, project_id, author_id,
-- created_at). No column-level lock; client sends only the editable
-- fields. We still pin author_id = auth.uid() so a compromised
-- client can't repoint a message at another user.
create policy "chat: authors edit own messages"
  on public.chat_messages
  for update
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));

-- DELETE: not granted. Soft-delete is performed via UPDATE setting
-- deleted_at. Hard delete only happens via project cascade.

-- Add to Realtime publication so members get live INSERT/UPDATE
-- echoes across devices.
alter publication supabase_realtime add table public.chat_messages;
