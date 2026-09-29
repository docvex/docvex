-- 048_rls_hardening.sql — fixes from the 2026-09-29 Supabase review.
--
-- 1. Members could be ADDED directly (skipping the invitation and its tier
--    guard): anyone with members.invite could insert any user as admin.
--    Membership now comes only from accept_invitation / add_creator_as_owner
--    (both SECURITY DEFINER), so the direct INSERT policy is gone.
-- 2. members.change_role could grant (or take away) admin: the update rule now
--    uses the invitation's tier guard (invite_role_allowed) on the new row and
--    lets only an admin touch an admin's row. The same goes for removal.
-- 3. A custom role of ANOTHER project could be assigned and counted:
--    invite_role_allowed checks the role's project on update, and
--    has_capability only honours a custom role of the same project.
-- 4. A removed member could delete their old uploads from project-sync:
--    deleting one's own object now needs files.delete_own in the project.
-- 5. Message authors could move messages, rewrite pins or re-address DMs:
--    UPDATE is limited to the columns the app edits (column privileges).
-- 6. AI usage rows: created_at forced to now(), token counts bounded.
-- Plus: reactions must point at a message of their project; project admins
-- can no longer change created_by; website forms bounded and rate-limited;
-- app admins recognised only by a CONFIRMED email of the signed-in user;
-- helper functions get a fixed search_path; anon loses table and admin-RPC
-- privileges it never needs.

-- ── 1. no direct membership inserts ─────────────────────────────────────────
drop policy if exists "admins insert non-owner members" on public.project_members;

-- ── 2 + 3. role changes and removals respect the tier ──────────────────────
drop policy if exists "admins update non-owner members" on public.project_members;
create policy "admins update non-owner members" on public.project_members for update
  using (
    public.has_capability(project_id, 'members.change_role')
    and role <> 'owner'
    and user_id <> (select auth.uid())
    and (role <> 'admin' or public.has_project_role(project_id, 'admin'))
  )
  with check (
    role <> 'owner'
    and public.invite_role_allowed(project_id, role, custom_role_id)
  );

drop policy if exists "delete members" on public.project_members;
create policy "delete members" on public.project_members for delete
  using (
    (
      public.has_capability(project_id, 'members.remove')
      and role <> 'owner'
      and (role <> 'admin' or public.has_project_role(project_id, 'admin'))
    )
    or (user_id = (select auth.uid()) and role <> 'owner')
  );

create or replace function public.has_capability(p_project_id uuid, p_capability project_capability)
returns boolean
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_uid             uuid := (select auth.uid());
  v_role            public.project_role;
  v_custom_role_id  uuid;
  v_base_role       public.project_role;
  v_override        boolean;
begin
  if v_uid is null then
    return false;
  end if;

  select pm.role, pm.custom_role_id
    into v_role, v_custom_role_id
  from public.project_members pm
  where pm.project_id = p_project_id
    and pm.user_id    = v_uid;

  if not found then
    return false;
  end if;

  if v_custom_role_id is not null then
    -- Only a custom role OF THIS PROJECT counts (048).
    select cr.base_role into v_base_role
    from public.custom_roles cr
    where cr.id = v_custom_role_id
      and cr.project_id = p_project_id;

    if not found then
      v_base_role := v_role;
    else
      select crc.granted into v_override
      from public.custom_role_capabilities crc
      where crc.custom_role_id = v_custom_role_id
        and crc.capability     = p_capability;

      if found then
        return v_override;
      end if;
    end if;
  else
    v_base_role := v_role;
  end if;

  return case v_base_role
    when 'owner'  then true
    when 'admin'  then true
    when 'member' then p_capability in (
                         'files.view'::public.project_capability,
                         'files.upload'::public.project_capability,
                         'files.delete_own'::public.project_capability
                       )
    when 'viewer' then p_capability = 'files.view'::public.project_capability
    else false
  end;
end;
$function$;

-- ── 4. project-sync deletes need the project's permission ──────────────────
drop policy if exists "project sync: deleters remove" on storage.objects;
create policy "project sync: deleters remove" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'project-sync'
    and public.storage_project_id(name) is not null
    and (
      public.has_capability(public.storage_project_id(name), 'files.delete_any')
      or (owner = auth.uid() and public.has_capability(public.storage_project_id(name), 'files.delete_own'))
    )
  );

-- ── 5. what message authors may change ──────────────────────────────────────
revoke update on public.chat_messages from anon, authenticated;
grant update (body, mentions, attached_file_ids, edited_at, deleted_at) on public.chat_messages to authenticated;
revoke update on public.private_messages from anon, authenticated;
grant update (body, edited_at, deleted_at) on public.private_messages to authenticated;

-- Project admins edit the project's own fields, never who created it.
revoke update on public.projects from anon, authenticated;
grant update (name, description, ai_context, ai_context_updated_at, jurisdiction, updated_at) on public.projects to authenticated;

-- A reaction must point at a message of the project it names.
drop policy if exists "reactions: members add own" on public.chat_message_reactions;
create policy "reactions: members add own" on public.chat_message_reactions for insert
  with check (
    public.has_project_role(project_id, 'member')
    and user_id = (select auth.uid())
    and exists (
      select 1 from public.chat_messages m
       where m.id = chat_message_reactions.message_id
         and m.project_id = chat_message_reactions.project_id
    )
  );

-- ── 6. AI usage rows ─────────────────────────────────────────────────────────
create or replace function public._ai_usage_stamp()
returns trigger language plpgsql set search_path = public as $$
begin
  new.created_at := now();
  return new;
end;
$$;
revoke execute on function public._ai_usage_stamp() from public, anon, authenticated;
drop trigger if exists project_ai_usage_stamp on public.project_ai_usage;
create trigger project_ai_usage_stamp before insert on public.project_ai_usage
  for each row execute function public._ai_usage_stamp();
alter table public.project_ai_usage
  drop constraint if exists project_ai_usage_tokens_bounded;
alter table public.project_ai_usage
  add constraint project_ai_usage_tokens_bounded
  check (input_tokens <= 5000000 and output_tokens <= 1000000);

-- ── website forms: bounded and rate-limited ─────────────────────────────────
alter table public.enrollments drop constraint if exists enrollments_lengths;
alter table public.enrollments add constraint enrollments_lengths check (
  coalesce(length(name), 0) <= 200
  and coalesce(length(email), 0) <= 320
  and coalesce(length(firm), 0) <= 200
  and coalesce(length(message), 0) <= 5000
);

create or replace function public._enrollments_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.enrollments
       where lower(email) = lower(new.email) and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'too_many_requests' using errcode = 'P0001';
  end if;
  if (select count(*) from public.enrollments where created_at > now() - interval '1 hour') >= 300 then
    raise exception 'too_many_requests' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function public._enrollments_rate_limit() from public, anon, authenticated;
drop trigger if exists enrollments_rate_limit on public.enrollments;
create trigger enrollments_rate_limit before insert on public.enrollments
  for each row execute function public._enrollments_rate_limit();

-- ── app admins: a CONFIRMED email of the signed-in user ─────────────────────
create or replace function public.is_app_admin()
returns boolean
language sql
stable security definer
set search_path to 'public', 'auth'
as $function$
  select exists (
    select 1
      from auth.users u
      join public.app_admins a on a.email = lower(u.email)
     where u.id = auth.uid()
       and u.email_confirmed_at is not null
  );
$function$;

-- ── helper functions: fixed search_path ─────────────────────────────────────
alter function public.storage_project_id(text) set search_path = public;
alter function public.storage_sync_owner_folder(text) set search_path = public;

-- ── anon keeps only what the website and the public feed use ───────────────
revoke execute on function public.add_app_admin(text) from public, anon;
revoke execute on function public.remove_app_admin(text) from public, anon;
revoke execute on function public.upsert_app_service(jsonb) from public, anon;
revoke execute on function public.delete_app_service(text) from public, anon;
revoke execute on function public.list_app_admins() from public, anon;
revoke execute on function public.list_app_services() from public, anon;
revoke execute on function public.get_admin_stats() from public, anon;
revoke execute on function public.current_user_has_password() from public, anon;
revoke execute on function public.phone_upload_owner(text) from public, anon;
revoke execute on function public.is_app_admin() from public, anon;
grant execute on function public.add_app_admin(text), public.remove_app_admin(text),
  public.upsert_app_service(jsonb), public.delete_app_service(text), public.list_app_admins(),
  public.list_app_services(), public.get_admin_stats(), public.current_user_has_password(),
  public.phone_upload_owner(text), public.is_app_admin() to authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'app_admins','app_services','chat_message_reactions','chat_messages','custom_role_capabilities',
    'custom_roles','dm_conversation_keys','legal_feed_acts','legal_feed_state','legal_update_states',
    'mail_oauth_states','notifications','phone_upload_files','phone_upload_sessions','private_messages',
    'project_ai_usage','project_invitations','project_key_grants','project_key_versions','project_members',
    'projects','user_key_backups','user_mail_connections','user_public_keys','writing_profiles','writing_samples'
  ] loop
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
-- enrollments: anon inserts only; legal_updates: anon reads only.
revoke all on public.enrollments from anon;
grant insert on public.enrollments to anon;
revoke all on public.legal_updates from anon;
grant select on public.legal_updates to anon;
