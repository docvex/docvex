-- 019_notify_all_members_on_change_request.sql
-- Replace the AFTER-INSERT trigger fan-out so EVERY project member
-- (owner / admin / member) gets a "new change request" notification,
-- not just admins.
--
-- Why: migration 017 widened change_requests SELECT to all members
-- so the "Version control" tab on the Project Dashboard shows
-- everyone's commits to everyone in the project. Notifications
-- should follow the same scope — a teammate's push is now relevant
-- context for everyone on the project, not just the approval gate.
--
-- Without this, members only learned about teammate activity by
-- visiting the dashboard. With it, the bell in the sidebar drives
-- async awareness ("alice pushed, you should take a look") which
-- is the cadence team workflows actually run on.
--
-- Viewers (the read-only role) are still excluded — they're not
-- participants in the review flow, so a notification would be noise
-- without any actionable surface for them.

create or replace function public._notify_admins_of_change_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member record;
  v_project public.projects%rowtype;
  v_author_name text;
begin
  -- Only fire on initial open submissions, not on later status flips.
  if new.status <> 'open' then
    return new;
  end if;
  select * into v_project from public.projects where id = new.project_id;
  -- Cheap human-readable author label for the toast body. Avoiding
  -- auth.users keeps the function's grants minimal.
  v_author_name := 'A teammate';
  for v_member in
    select pm.user_id, pm.role
      from public.project_members pm
      where pm.project_id = new.project_id
        and pm.role in ('owner', 'admin', 'member')
        and pm.user_id <> new.author_id
  loop
    insert into public.notifications (
      user_id, category, variant, priority, icon, title, body, payload, dedupe_key
    )
    values (
      v_member.user_id,
      'file',
      'info',
      -- Admins still get the louder "needs review" framing
      -- (they're the only ones who can act); other members
      -- get a calmer awareness ping.
      case when v_member.role in ('owner', 'admin') then 'normal' else 'low' end,
      'upload',
      case when v_member.role in ('owner', 'admin')
        then 'New change request to review'
        else 'New change request'
      end,
      format('%s submitted "%s" in %s.', v_author_name, new.title, coalesce(v_project.name, 'a project')),
      jsonb_build_object(
        'change_request_id', new.id,
        'project_id', new.project_id,
        'author_id', new.author_id
      ),
      format('cr-submitted:%s', new.id)
    )
    on conflict (user_id, dedupe_key) do nothing;
  end loop;
  return new;
end;
$$;
