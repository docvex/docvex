-- 018_change_request_items_project_id_and_realtime.sql
-- Two coupled changes that let the "Compose release" surface scale
-- past a handful of teammates:
--
--   1. Denormalise project_id onto change_request_items so realtime
--      subscriptions can filter server-side. Without this, the
--      compose view would have to subscribe to every item event in
--      every project the user belongs to (postgres_changes filters
--      only support same-table columns; we can't filter by the
--      parent request's project_id without a join).
--
--   2. Add change_request_items to the realtime publication. The
--      table is mutable in practice — migration 015 added UPDATE/
--      DELETE policies for the author of an open request, and
--      `createOrMergeChangeRequest` exercises both whenever a
--      member pushes additional work into their open request. The
--      original comment in migration 012 ("snapshots are immutable;
--      no realtime needed") no longer holds, and the gap forced a
--      manual Refresh button in the UI that doesn't scale.

-- ── Step 1: denormalize project_id ───────────────────────────────────
-- Nullable on add → backfill from parent → flip to NOT NULL. The
-- ON DELETE CASCADE matches the parent's FK and the request's FK,
-- so dropping a project still cleans up cleanly.
alter table public.change_request_items
  add column project_id uuid references public.projects(id) on delete cascade;

update public.change_request_items i
  set project_id = cr.project_id
  from public.change_requests cr
  where cr.id = i.request_id
    and i.project_id is null;

alter table public.change_request_items
  alter column project_id set not null;

-- Covers the realtime filter and the future "items by project"
-- queries (e.g., listOpenChangeRequestItemsForProject in
-- lib/branches.js). The existing (request_id, seq) index still
-- serves per-request lookups.
create index change_request_items_project_idx
  on public.change_request_items (project_id);

-- Maintain on INSERT — callers (the existing push pipeline,
-- createOrMergeChangeRequest, future imports) only set request_id;
-- this trigger fills project_id from the parent. Cheap (single
-- lookup), runs before insert so the realtime publication sees
-- the populated row in its INSERT event.
create or replace function public._set_change_request_item_project_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.project_id is null then
    select cr.project_id into new.project_id
      from public.change_requests cr
      where cr.id = new.request_id;
  end if;
  return new;
end;
$$;

drop trigger if exists set_change_request_item_project_id on public.change_request_items;
create trigger set_change_request_item_project_id
  before insert on public.change_request_items
  for each row execute function public._set_change_request_item_project_id();

-- ── Step 2: realtime publication ─────────────────────────────────────
-- Idempotent — `alter publication … add table` is rejected with a
-- duplicate-object error if the table is already in the publication,
-- but we know from migration 012 it wasn't.
alter publication supabase_realtime add table public.change_request_items;
