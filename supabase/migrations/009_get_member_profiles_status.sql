-- ── get_member_profiles: add `status` column ─────────────────────────────
-- Adds a manually-set activity status (online / idle / dnd / offline) to the
-- profile rows returned by get_member_profiles. Status is stored in
-- auth.users.raw_user_meta_data->>'status' — set by the client via
-- supabase.auth.updateUser({ data: { status } }). Coalesced to 'online' for
-- users who have never set one, so the UI never sees NULL.
--
-- DROP + CREATE rather than CREATE OR REPLACE because the RETURNS TABLE
-- signature changes (new column). No other DB object depends on this
-- function (RLS policies don't reference it), so no CASCADE is needed.

drop function if exists public.get_member_profiles(uuid[]);

create or replace function public.get_member_profiles(p_user_ids uuid[])
returns table (
  id         uuid,
  email      text,
  full_name  text,
  name       text,
  avatar_url text,
  status     text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    u.id,
    u.email::text,
    u.raw_user_meta_data->>'full_name',
    u.raw_user_meta_data->>'name',
    u.raw_user_meta_data->>'avatar_url',
    coalesce(u.raw_user_meta_data->>'status', 'online') as status
  from auth.users u
  where u.id = any(p_user_ids)
    and exists (
      select 1
      from public.project_members me
      join public.project_members them on them.project_id = me.project_id
      where me.user_id   = (select auth.uid())
        and them.user_id = u.id
    );
$$;

revoke execute on function public.get_member_profiles(uuid[]) from public, anon, authenticated;
grant  execute on function public.get_member_profiles(uuid[]) to authenticated;
