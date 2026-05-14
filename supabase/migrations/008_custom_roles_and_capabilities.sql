-- 008_custom_roles_and_capabilities.sql
--
-- Adds project-scoped CUSTOM ROLES on top of the existing 4-tier enum
-- (owner/admin/member/viewer). A custom role picks a base tier and may
-- explicitly grant or revoke specific capabilities relative to that base.
--
-- Strategy summary (see C:\Users\Luca\.claude\plans for full plan):
--   1. New `project_capability` enum + `custom_roles` + `custom_role_capabilities`.
--   2. Add `custom_role_id` to `project_members` (and `project_invitations`).
--      When set, capability resolution flows through the custom role; the
--      legacy `role` enum column stays in sync with `custom_roles.base_role`
--      so the existing `has_project_role(...)` ladder still answers correctly
--      for callsites that haven't migrated to `has_capability(...)`.
--   3. New `has_capability(project_id, capability)` function — SECURITY DEFINER,
--      single point of truth used by RLS on file + member ops.
--   4. Refactor existing RLS policies on project_files, storage.objects (the
--      `projects` bucket), project_invitations and project_members to call
--      `has_capability` instead of `has_project_role` — without this, custom
--      roles would be visually configurable but powerless.
--   5. Update `accept_invitation()` to propagate `custom_role_id` from the
--      invitation row into the resulting project_members row.
--   6. Add SECURITY INVOKER RPCs `create_custom_role` and `update_custom_role`
--      that atomically write the role + its overrides in one transaction.
--   7. Add the two new tables to `supabase_realtime` publication with
--      REPLICA IDENTITY FULL (same pattern as migrations 006/007).
--
-- Owner is intentionally NOT a valid `base_role` for custom roles: it carries
-- the non-grantable `project.delete` power, and reproducing it via a custom
-- role would break the "one owner per project" invariant.

-- ── 1. Capability enum ─────────────────────────────────────────────────────
create type public.project_capability as enum (
  'files.view',
  'files.upload',
  'files.delete_any',
  'files.delete_own',
  'members.invite',
  'members.remove',
  'members.change_role'
);

-- ── 2. custom_roles table ──────────────────────────────────────────────────
create table public.custom_roles (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  description text,
  -- Owner is excluded at the constraint level so a stray UPDATE can't smuggle
  -- it in. RLS WITH CHECK below repeats the rule for defence in depth.
  base_role   public.project_role not null check (base_role in ('admin','member','viewer')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Case-insensitive uniqueness per project so "Designer" and "designer" can't
-- coexist (they'd be indistinguishable in the picker UI). Expressed as a
-- unique index because column-level UNIQUE doesn't accept expressions.
create unique index custom_roles_project_lower_name_idx
  on public.custom_roles (project_id, lower(name));

-- Covers the project_id FK so cascade-deletes don't seq-scan
-- (unindexed_foreign_keys lint).
create index custom_roles_project_id_idx on public.custom_roles (project_id);
create index custom_roles_created_by_idx on public.custom_roles (created_by);

-- ── 3. custom_role_capabilities table ──────────────────────────────────────
-- `granted` semantics:
--   true  → capability is added on top of the base tier's defaults.
--   false → capability is revoked from the base tier's defaults.
-- A row's ABSENCE means "inherit from base tier" — there is no need to
-- enumerate inherited capabilities; the function falls back to the base.
create table public.custom_role_capabilities (
  custom_role_id uuid not null references public.custom_roles(id) on delete cascade,
  capability     public.project_capability not null,
  granted        boolean not null,
  primary key (custom_role_id, capability)
);

-- ── 4. project_members.custom_role_id ─────────────────────────────────────
-- When set, it's the truth for that member's display + capability resolution.
-- The `role` enum column is always kept in sync with custom_roles.base_role
-- so any legacy RLS policy still calling has_project_role(...) returns the
-- correct tier — no audit of those callsites required.
alter table public.project_members
  add column custom_role_id uuid references public.custom_roles(id) on delete set null;

create index project_members_custom_role_id_idx on public.project_members (custom_role_id);

-- ── 5. project_invitations.custom_role_id ─────────────────────────────────
-- Inviting at a custom role propagates the role through accept_invitation().
-- Nullable: invitations without a custom role behave exactly as before.
alter table public.project_invitations
  add column custom_role_id uuid references public.custom_roles(id) on delete set null;

create index project_invitations_custom_role_id_idx on public.project_invitations (custom_role_id);

-- ── 6. has_capability function ────────────────────────────────────────────
-- SECURITY DEFINER mirrors has_project_role's posture. The auth.uid() filter
-- inside the body is the security boundary; the function reads custom_roles
-- and custom_role_capabilities which are RLS-protected, but as definer it
-- bypasses RLS so policies can call it without recursion.
create or replace function public.has_capability(
  p_project_id uuid,
  p_capability public.project_capability
) returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
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

  -- Look up caller's membership. Not found → no access at all.
  select pm.role, pm.custom_role_id
    into v_role, v_custom_role_id
  from public.project_members pm
  where pm.project_id = p_project_id
    and pm.user_id    = v_uid;

  if not found then
    return false;
  end if;

  -- If a custom role is assigned, it supersedes the enum role for capability
  -- resolution. We still need the base_role from the custom_roles row to
  -- compute the "inherited" answer when the capability has no explicit
  -- override.
  if v_custom_role_id is not null then
    select cr.base_role into v_base_role
    from public.custom_roles cr
    where cr.id = v_custom_role_id;

    if not found then
      -- Race: custom role got deleted between this caller's last refresh
      -- and now (the FK is ON DELETE SET NULL but UPDATE hasn't flushed the
      -- row out of the cache yet, or a manual NULL assignment is racing).
      -- Fall back to the enum role — the next refresh will catch up.
      v_base_role := v_role;
    else
      -- Check for an explicit override on this specific capability.
      select crc.granted into v_override
      from public.custom_role_capabilities crc
      where crc.custom_role_id = v_custom_role_id
        and crc.capability     = p_capability;

      if found then
        return v_override;
      end if;
      -- else fall through to the base-tier matrix below
    end if;
  else
    v_base_role := v_role;
  end if;

  -- Built-in capability matrix per base tier:
  --   owner  → every capability (also the exclusive `project.delete` power,
  --            which isn't toggleable and isn't expressible here)
  --   admin  → every capability
  --   member → file view + upload + delete-own
  --   viewer → file view only (UI label: "Client")
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
$$;

revoke execute on function public.has_capability(uuid, public.project_capability)
  from public, anon, authenticated;
grant  execute on function public.has_capability(uuid, public.project_capability)
  to authenticated;

-- ── 7. RLS on the two new tables ──────────────────────────────────────────
alter table public.custom_roles enable row level security;
alter table public.custom_role_capabilities enable row level security;

-- custom_roles: any viewer+ on the project can read the role catalog (so the
-- Members list can show "extends Member" hints to everyone). Admin+ writes.
create policy "viewers read custom roles" on public.custom_roles for select
  using (public.has_project_role(project_id, 'viewer'));

create policy "admins insert custom roles" on public.custom_roles for insert
  with check (
    public.has_project_role(project_id, 'admin')
    and base_role <> 'owner'
  );

create policy "admins update custom roles" on public.custom_roles for update
  using  (public.has_project_role(project_id, 'admin'))
  with check (
    public.has_project_role(project_id, 'admin')
    and base_role <> 'owner'
  );

create policy "admins delete custom roles" on public.custom_roles for delete
  using (public.has_project_role(project_id, 'admin'));

-- custom_role_capabilities: gated via the parent custom_roles row's project.
-- Splitting read/write keeps the EXISTS subqueries focused.
create policy "viewers read custom role caps" on public.custom_role_capabilities for select
  using (exists (
    select 1 from public.custom_roles cr
    where cr.id = custom_role_capabilities.custom_role_id
      and public.has_project_role(cr.project_id, 'viewer')
  ));

create policy "admins insert custom role caps" on public.custom_role_capabilities for insert
  with check (exists (
    select 1 from public.custom_roles cr
    where cr.id = custom_role_capabilities.custom_role_id
      and public.has_project_role(cr.project_id, 'admin')
  ));

create policy "admins update custom role caps" on public.custom_role_capabilities for update
  using (exists (
    select 1 from public.custom_roles cr
    where cr.id = custom_role_capabilities.custom_role_id
      and public.has_project_role(cr.project_id, 'admin')
  ));

create policy "admins delete custom role caps" on public.custom_role_capabilities for delete
  using (exists (
    select 1 from public.custom_roles cr
    where cr.id = custom_role_capabilities.custom_role_id
      and public.has_project_role(cr.project_id, 'admin')
  ));

-- ── 8. Refactor existing RLS policies to use has_capability ──────────────
-- These policies were tier-gated; switching them to capability-gated is what
-- makes custom-role overrides actually mean something. The legacy enum
-- column stays in sync (set to base_role at assign time), so any policy NOT
-- listed below — projects.update (admin+), projects.delete (owner) — still
-- works correctly with has_project_role().

-- project_files: SELECT, INSERT, DELETE — files.view/upload/delete_any/delete_own
drop policy if exists "viewers read project files" on public.project_files;
create policy "viewers read project files" on public.project_files for select
  using (public.has_capability(project_id, 'files.view'));

drop policy if exists "members insert project files" on public.project_files;
create policy "members insert project files" on public.project_files for insert
  with check (
    public.has_capability(project_id, 'files.upload')
    and uploaded_by = (select auth.uid())
  );

drop policy if exists "uploader or admin delete project files" on public.project_files;
create policy "uploader or admin delete project files" on public.project_files for delete
  using (
    public.has_capability(project_id, 'files.delete_any')
    or (
      uploaded_by = (select auth.uid())
      and public.has_capability(project_id, 'files.delete_own')
    )
  );

-- UPDATE on project_files (description edit) is NOT in the capability set —
-- it stays uploader-or-admin via the legacy ladder. The "uploader or admin
-- update project files" policy from migration 005 is unchanged.

-- storage.objects (projects bucket): mirror the files policies via path-encoded project_id
drop policy if exists "members read project files" on storage.objects;
create policy "members read project files" on storage.objects for select
  using (
    bucket_id = 'projects'
    and public.has_capability((string_to_array(name, '/'))[1]::uuid, 'files.view')
  );

drop policy if exists "members upload project files" on storage.objects;
create policy "members upload project files" on storage.objects for insert
  with check (
    bucket_id = 'projects'
    and public.has_capability((string_to_array(name, '/'))[1]::uuid, 'files.upload')
  );

drop policy if exists "uploader or admin delete project files" on storage.objects;
create policy "uploader or admin delete project files" on storage.objects for delete
  using (
    bucket_id = 'projects'
    and (
      public.has_capability((string_to_array(name, '/'))[1]::uuid, 'files.delete_any')
      or exists (
        select 1 from public.project_files pf
        where (pf.storage_path = storage.objects.name
               or pf.thumbnail_path = storage.objects.name)
          and pf.uploaded_by = (select auth.uid())
          and public.has_capability(pf.project_id, 'files.delete_own')
      )
    )
  );

-- project_invitations: read/insert/delete all gated on members.invite
drop policy if exists "admins read invitations" on public.project_invitations;
create policy "admins read invitations" on public.project_invitations for select
  using (public.has_capability(project_id, 'members.invite'));

drop policy if exists "admins create invitations" on public.project_invitations;
create policy "admins create invitations" on public.project_invitations for insert
  with check (public.has_capability(project_id, 'members.invite'));

drop policy if exists "admins delete invitations" on public.project_invitations;
create policy "admins delete invitations" on public.project_invitations for delete
  using (public.has_capability(project_id, 'members.invite'));

-- project_members: INSERT/UPDATE/DELETE swapped to capability gates.
-- INSERT still gated as "members.invite" — that's the capability that
-- represents "I can add users to this project". The accept_invitation()
-- function runs SECURITY DEFINER and bypasses RLS, so this doesn't affect
-- the invite-accept path; it only affects direct INSERTs.
drop policy if exists "admins insert non-owner members" on public.project_members;
create policy "admins insert non-owner members" on public.project_members for insert
  with check (
    public.has_capability(project_id, 'members.invite')
    and role <> 'owner'
  );

drop policy if exists "admins update non-owner members" on public.project_members;
create policy "admins update non-owner members" on public.project_members for update
  using (public.has_capability(project_id, 'members.change_role'))
  with check (role <> 'owner');

drop policy if exists "delete members" on public.project_members;
create policy "delete members" on public.project_members for delete
  using (
    (public.has_capability(project_id, 'members.remove') and role <> 'owner')
    or
    (user_id = (select auth.uid()) and role <> 'owner')
  );

-- ── 9. Update accept_invitation to propagate custom_role_id ──────────────
-- Same security posture as before (SECURITY DEFINER, only callable through
-- the accept-invite Edge Function under service_role). New logic: if the
-- invitation row references a custom role, look up its base_role and use
-- THAT for the project_members.role enum column so has_project_role() stays
-- honest. The custom_role_id is also carried through so capability checks
-- via has_capability() see the override.
create or replace function public.accept_invitation(p_token text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv  public.project_invitations%rowtype;
  v_cr   public.custom_roles%rowtype;
  v_role public.project_role;
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

  -- Resolve the enum role to write. If the invitation pointed at a custom
  -- role, use its base_role so has_project_role(...) returns the right tier
  -- for the new member. Otherwise use the invitation's own enum role.
  if v_inv.custom_role_id is not null then
    select * into v_cr from public.custom_roles where id = v_inv.custom_role_id;
    if found then
      v_role := v_cr.base_role;
    else
      -- Custom role was deleted between invite-send and accept. The
      -- invitation's enum role was set to the base_role at invite-send
      -- time (see send-invite Edge Function), so it's still the right
      -- fallback.
      v_role := v_inv.role;
    end if;
  else
    v_role := v_inv.role;
  end if;

  insert into public.project_members (project_id, user_id, role, custom_role_id)
    values (v_inv.project_id, p_user_id, v_role, v_inv.custom_role_id)
    on conflict (project_id, user_id) do nothing;

  update public.project_invitations set accepted_at = now() where id = v_inv.id;
  return v_inv.project_id;
end;
$$;

-- The grant matches the previous definition: revoked from clients; only
-- service_role calls this through the accept-invite Edge Function.
revoke execute on function public.accept_invitation(text, uuid) from public, anon, authenticated;

-- ── 10. Atomic CRUD RPCs for custom roles ────────────────────────────────
-- Both run as SECURITY INVOKER so RLS still gates them (admin+ on the
-- target project). One transaction so the role + its capability set never
-- get out of step.

-- create_custom_role: returns the new role's id.
-- p_capabilities is a JSONB array of {capability: text, granted: boolean}.
-- Empty / null array is allowed (no overrides == "inherit everything from
-- the base tier"). The capability strings must be valid project_capability
-- enum values; the cast will raise on typos.
create or replace function public.create_custom_role(
  p_project_id   uuid,
  p_name         text,
  p_description  text,
  p_base_role    public.project_role,
  p_capabilities jsonb
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_role_id uuid;
begin
  -- Defence in depth: also enforced by the check constraint on the table
  -- and the RLS WITH CHECK clause, but raising here gives a clean Postgres
  -- error message instead of a 23514 constraint violation surfaced to the
  -- client.
  if p_base_role = 'owner' then
    raise exception 'owner cannot be a custom role base' using errcode = '22023';
  end if;

  insert into public.custom_roles (project_id, name, description, base_role, created_by)
    values (p_project_id, trim(p_name), nullif(trim(coalesce(p_description, '')), ''),
            p_base_role, (select auth.uid()))
    returning id into v_role_id;

  if p_capabilities is not null and jsonb_array_length(p_capabilities) > 0 then
    insert into public.custom_role_capabilities (custom_role_id, capability, granted)
    select v_role_id,
           (item->>'capability')::public.project_capability,
           (item->>'granted')::boolean
    from jsonb_array_elements(p_capabilities) as item;
  end if;

  return v_role_id;
end;
$$;

revoke execute on function public.create_custom_role(uuid, text, text, public.project_role, jsonb)
  from public, anon, authenticated;
grant  execute on function public.create_custom_role(uuid, text, text, public.project_role, jsonb)
  to authenticated;

-- update_custom_role: rewrites the role + REPLACES its capability set
-- wholesale (delete-all + insert-all). The UI doesn't have to diff
-- capability changes — just send the desired final state.
create or replace function public.update_custom_role(
  p_role_id      uuid,
  p_name         text,
  p_description  text,
  p_base_role    public.project_role,
  p_capabilities jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_project_id uuid;
begin
  if p_base_role = 'owner' then
    raise exception 'owner cannot be a custom role base' using errcode = '22023';
  end if;

  update public.custom_roles
     set name        = trim(p_name),
         description = nullif(trim(coalesce(p_description, '')), ''),
         base_role   = p_base_role
   where id = p_role_id
   returning project_id into v_project_id;

  if not found then
    raise exception 'custom role not found' using errcode = 'P0001';
  end if;

  -- If the base_role changed, every member assigned to this role needs
  -- their project_members.role enum updated so has_project_role(...) stays
  -- in sync. UPDATE is no-op for members where role already matches.
  update public.project_members
     set role = p_base_role
   where custom_role_id = p_role_id
     and role <> p_base_role;

  -- Replace capabilities atomically.
  delete from public.custom_role_capabilities where custom_role_id = p_role_id;

  if p_capabilities is not null and jsonb_array_length(p_capabilities) > 0 then
    insert into public.custom_role_capabilities (custom_role_id, capability, granted)
    select p_role_id,
           (item->>'capability')::public.project_capability,
           (item->>'granted')::boolean
    from jsonb_array_elements(p_capabilities) as item;
  end if;
end;
$$;

revoke execute on function public.update_custom_role(uuid, text, text, public.project_role, jsonb)
  from public, anon, authenticated;
grant  execute on function public.update_custom_role(uuid, text, text, public.project_role, jsonb)
  to authenticated;

-- ── 11. Realtime: publish + replica identity full ────────────────────────
-- Same pattern as migrations 006 (project_files) and 007 (project_members):
-- without REPLICA IDENTITY FULL the DELETE event's OLD payload only contains
-- the primary key, so a filter like `project_id=eq.X` on the postgres_changes
-- channel rejects every DELETE before it reaches subscribers.
alter publication supabase_realtime add table public.custom_roles;
alter publication supabase_realtime add table public.custom_role_capabilities;
alter table public.custom_roles               replica identity full;
alter table public.custom_role_capabilities   replica identity full;
