-- 000_notifications.sql — Notification history table.
--
-- This file is a backfill: the schema was originally applied to the live
-- Supabase project (pntxlvhkqfryyyxlqytr) via MCP `apply_migration` before
-- the migrations/ folder existed (two MCP migrations: create_notifications_table
-- and notifications_rls_initplan_fix, plus a follow-up that switched the
-- partial unique index to a non-partial one for ON CONFLICT inference).
-- This file captures the final post-fix state so a fresh replay produces
-- the same schema.

create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  category    text not null default 'info',
  variant     text not null default 'info',
  title       text not null default '',
  body        text,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  dedupe_key  text
);

create index notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

-- Non-partial unique index so PostgREST's upsert with
-- onConflict:'user_id,dedupe_key' can infer the conflict target. Postgres
-- treats `(user_id, null)` rows as distinct from each other by default, so
-- there's no behavioural change vs. the original partial-index design — the
-- partial version just couldn't be inferred from `ON CONFLICT (cols)`.
create unique index notifications_user_dedupe_idx
  on public.notifications (user_id, dedupe_key);

alter table public.notifications enable row level security;

-- All policies use (select auth.uid()) for initplan caching (Supabase lint 0003).
create policy "users select own"
  on public.notifications for select using ((select auth.uid()) = user_id);
create policy "users insert own"
  on public.notifications for insert with check ((select auth.uid()) = user_id);
create policy "users update own"
  on public.notifications for update using ((select auth.uid()) = user_id);
create policy "users delete own"
  on public.notifications for delete using ((select auth.uid()) = user_id);

-- Realtime publication for cross-device sync (notify, mark-read, delete echo
-- back to other open windows of the same user).
alter publication supabase_realtime add table public.notifications;
