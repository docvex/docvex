-- 042_invite_tier_guard.sql
-- GDPR/security audit (2026-09-28): the members.invite capability alone could
-- mint project ADMINS, and a custom role from ANOTHER project could be attached
-- to an invitation (accept_invitation copies its base role).
--
-- 1. project_invitations INSERT: an invitation at admin tier — directly, or via
--    a custom role based on admin — needs the inviter to be admin/owner; a
--    custom role must belong to the invitation's own project.
-- 2. project_invitations UPDATE is not granted by any policy (the send-invite
--    Edge Function updates with the service role and checks the same rules).
-- 3. accept_invitation ignores a custom role that is not the project's own.

create or replace function public.invite_role_allowed(
  p_project_id uuid, p_role public.project_role, p_custom_role_id uuid
) returns boolean
language sql stable security definer set search_path = public as $$
  select
    (p_custom_role_id is null or exists (
      select 1 from public.custom_roles cr
      where cr.id = p_custom_role_id and cr.project_id = p_project_id))
    and (
      coalesce(
        (select cr.base_role from public.custom_roles cr where cr.id = p_custom_role_id),
        p_role
      ) <> 'admin'
      or public.has_project_role(p_project_id, 'admin')
    );
$$;
revoke all on function public.invite_role_allowed(uuid, public.project_role, uuid) from public, anon;
grant execute on function public.invite_role_allowed(uuid, public.project_role, uuid) to authenticated;

alter policy "admins create invitations" on public.project_invitations
  with check (
    has_capability(project_id, 'members.invite')
    and role <> 'owner'
    and public.invite_role_allowed(project_id, role, custom_role_id)
  );

create or replace function public.accept_invitation(p_token text, p_user_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_inv  public.project_invitations%rowtype;
  v_cr   public.custom_roles%rowtype;
  v_role public.project_role;
  v_custom uuid;
begin
  select * into v_inv from public.project_invitations
    where token = p_token for update;
  if not found
    then raise exception 'invitation_not_found' using errcode = 'P0001';
  end if;
  if v_inv.accepted_at is not null
    then raise exception 'already_accepted'    using errcode = 'P0002';
  end if;
  if v_inv.expires_at < now()
    then raise exception 'expired'             using errcode = 'P0003';
  end if;

  v_role := v_inv.role;
  v_custom := null;
  if v_inv.custom_role_id is not null then
    -- Only a custom role of THIS project counts.
    select * into v_cr from public.custom_roles
      where id = v_inv.custom_role_id and project_id = v_inv.project_id;
    if found then
      v_role := v_cr.base_role;
      v_custom := v_cr.id;
    end if;
  end if;
  if v_role = 'owner' then v_role := 'member'; end if;

  insert into public.project_members (project_id, user_id, role, custom_role_id)
    values (v_inv.project_id, p_user_id, v_role, v_custom)
    on conflict (project_id, user_id) do nothing;

  update public.project_invitations set accepted_at = now() where id = v_inv.id;
  return v_inv.project_id;
end;
$function$;
