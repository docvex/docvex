-- 031_drop_branching_and_cloud_files.sql
--
-- Product pivot: the GitHub-style branching / change-request system is being
-- removed entirely, and the Files page becomes local-only (files live in a
-- folder on the user's computer, not in Supabase storage). This migration
-- tears down everything that backed those two features:
--
--   • branching tables   — branch_changes, change_requests,
--                           change_request_items, project_member_branches
--   • approve/reject RPCs + the shared _apply_change_request_items helper
--   • the notification + project_id triggers (and their functions)
--   • the cloud file store — project_files table + the `projects` and
--     `projects-pending` storage buckets (+ their RLS policies)
--   • projects.main_version (only the approve RPCs ever bumped it)
--
-- Drop order is children -> parents so nothing is left referencing a dropped
-- object. has_project_role() stays (shared by every other table's RLS).
-- Orphaned `notifications` rows from past approvals are harmless and kept.

begin;

-- 1. Triggers (drop before the functions they call) -----------------------
drop trigger if exists notify_admins_of_change_request on public.change_requests;
drop trigger if exists set_change_request_item_project_id on public.change_request_items;

-- 2. Trigger functions ----------------------------------------------------
drop function if exists public._notify_admins_of_change_request();
drop function if exists public._set_change_request_item_project_id();

-- 3. RPCs (public approve/reject first, then the internal helper) ----------
drop function if exists public.approve_change_request(uuid);
drop function if exists public.approve_change_requests(uuid[]);
drop function if exists public.reject_change_request(uuid, text);
drop function if exists public.reject_change_request_item(uuid, text);
drop function if exists public.reject_change_request_item(uuid);
drop function if exists public._apply_change_request_items(uuid);

-- 4. Remove tables from the realtime publication (guarded so re-runs and
--    already-absent tables don't error) -----------------------------------
do $$
begin
  alter publication supabase_realtime drop table public.change_request_items;
exception when undefined_object or undefined_table then null;
end $$;
do $$
begin
  alter publication supabase_realtime drop table public.change_requests;
exception when undefined_object or undefined_table then null;
end $$;
do $$
begin
  alter publication supabase_realtime drop table public.branch_changes;
exception when undefined_object or undefined_table then null;
end $$;
do $$
begin
  alter publication supabase_realtime drop table public.project_member_branches;
exception when undefined_object or undefined_table then null;
end $$;
do $$
begin
  alter publication supabase_realtime drop table public.project_files;
exception when undefined_object or undefined_table then null;
end $$;

-- 5. Tables (CASCADE clears FKs / policies / indexes / replica identity) ---
drop table if exists public.change_request_items cascade;
drop table if exists public.change_requests cascade;
drop table if exists public.branch_changes cascade;
drop table if exists public.project_member_branches cascade;
drop table if exists public.project_files cascade;

-- 6. Storage — drop every policy on storage.objects that gated the two file
--    buckets (policy names drifted across migrations, so match by definition).
--    The bucket ROWS themselves can't be removed via SQL (Supabase protects
--    storage.objects/buckets); delete the now-empty `projects` and
--    `projects-pending` buckets from the dashboard Storage UI.
do $$
declare pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        coalesce(qual, '') like '%projects-pending%'
        or coalesce(with_check, '') like '%projects-pending%'
        or coalesce(qual, '') like '%bucket_id = ''projects''%'
        or coalesce(with_check, '') like '%bucket_id = ''projects''%'
      )
  loop
    execute format('drop policy if exists %I on storage.objects', pol.policyname);
  end loop;
end $$;

-- 7. Drop the now-dead version cursor (content_hash / folder_path died with
--    the project_files table) ---------------------------------------------
alter table public.projects drop column if exists main_version;

commit;
