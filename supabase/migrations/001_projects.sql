-- 001_projects.sql — Projects, Members, Invitations, and role machinery.
--
-- Applied via MCP `apply_migration` (project pntxlvhkqfryyyxlqytr). This file
-- is the source of truth — if you change the live schema, update this file
-- in the same commit. No automatic runner reads it; it's documentation +
-- replay for new environments.

-- ── Enum ───────────────────────────────────────────────────────────────────
create type public.project_role as enum ('owner', 'admin', 'member', 'viewer');

-- ── Tables ─────────────────────────────────────────────────────────────────
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  description text,
  created_by  uuid not null references auth.users(id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.project_members (
  project_id  uuid not null references public.projects(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        public.project_role not null default 'member',
  added_at    timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index project_members_user_idx on public.project_members (user_id);
-- Cover the projects.created_by FK to auth.users so on-cascade and audit-style
-- lookups don't seq-scan (unindexed_foreign_keys lint). project_invitations's
-- invited_by index is created after that table below.
create index projects_created_by_idx  on public.projects (created_by);

create table public.project_invitations (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  email       text not null check (length(trim(email)) > 0),
  role        public.project_role not null default 'member',
  token       text not null unique default encode(gen_random_bytes(24), 'hex'),
  invited_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz
);

-- Only one *pending* invitation per (project, lowercased email) so the
-- send-invite Edge Function can upsert and return the existing token.
create unique index project_invitations_pending_unique
  on public.project_invitations (project_id, lower(email))
  where accepted_at is null;

-- Cover the invited_by FK to auth.users (unindexed_foreign_keys lint).
create index project_invitations_invited_by_idx on public.project_invitations (invited_by);

-- ── Role hierarchy helper ──────────────────────────────────────────────────
-- SECURITY DEFINER so policies can call it without recursive RLS on
-- project_members. Wrapping auth.uid() in (select ...) is the Supabase-
-- recommended form for initplan caching.
create or replace function public.has_project_role(p_project_id uuid, p_min_role public.project_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.project_members pm
    where pm.project_id = p_project_id
      and pm.user_id    = (select auth.uid())
      and (case pm.role
             when 'owner'  then 4
             when 'admin'  then 3
             when 'member' then 2
             when 'viewer' then 1
           end)
          >=
          (case p_min_role
             when 'owner'  then 4
             when 'admin'  then 3
             when 'member' then 2
             when 'viewer' then 1
           end)
  );
$$;

-- has_project_role MUST remain callable by `authenticated` because RLS
-- policies reference it, and policy evaluation happens in the caller's role
-- context. Anon stays revoked.
revoke execute on function public.has_project_role(uuid, public.project_role) from public, anon, authenticated;
grant  execute on function public.has_project_role(uuid, public.project_role) to authenticated;

-- ── Triggers ───────────────────────────────────────────────────────────────
-- Auto-add the creator as owner. SECURITY DEFINER bypasses the project_members
-- RLS policies (which would otherwise reject 'owner' inserts from clients).
create or replace function public.add_creator_as_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

create trigger projects_add_owner
  after insert on public.projects
  for each row execute function public.add_creator_as_owner();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger projects_touch_updated_at
  before update on public.projects
  for each row execute function public.touch_updated_at();

-- ── Accept-invitation atomic RPC ───────────────────────────────────────────
-- Called by the accept-invite Edge Function under service_role. Returns the
-- project_id on success. Raises with sqlstate-coded messages on failure so
-- the function can map them to distinct HTTP statuses.
create or replace function public.accept_invitation(p_token text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.project_invitations%rowtype;
begin
  select * into v_inv from public.project_invitations
    where token = p_token for update;
  if not found            then raise exception 'invitation_not_found' using errcode = 'P0001'; end if;
  if v_inv.accepted_at is not null
                           then raise exception 'already_accepted'    using errcode = 'P0002'; end if;
  if v_inv.expires_at < now()
                           then raise exception 'expired'             using errcode = 'P0003'; end if;

  insert into public.project_members (project_id, user_id, role)
    values (v_inv.project_id, p_user_id, v_inv.role)
    on conflict (project_id, user_id) do nothing;

  update public.project_invitations set accepted_at = now() where id = v_inv.id;
  return v_inv.project_id;
end;
$$;

-- Trigger function: no client should call this directly. Revoke from every
-- public-facing role; the trigger itself fires regardless of these grants.
revoke execute on function public.add_creator_as_owner() from public, anon, authenticated;

-- accept_invitation is only called by the accept-invite Edge Function via
-- service_role, which bypasses these grants. Revoke from every client role.
revoke execute on function public.accept_invitation(text, uuid) from public, anon, authenticated;

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table public.projects             enable row level security;
alter table public.project_members      enable row level security;
alter table public.project_invitations  enable row level security;

-- projects
-- SELECT policy is an OR so the creator can always read their own projects.
-- Why both branches: has_project_role() is STABLE, so when an INSERT…RETURNING
-- evaluates the SELECT policy against the new row, the AFTER trigger's
-- project_members insert isn't visible to the function's snapshot — the
-- has_project_role branch returns false on the just-created row. The
-- created_by branch doesn't depend on project_members and always passes for
-- the creator, so INSERT…RETURNING works without a round trip.
create policy "members or creators read projects" on public.projects for select
  using (
    public.has_project_role(id, 'viewer')
    or (select auth.uid()) = created_by
  );
create policy "any authed user creates projects" on public.projects for insert
  with check ((select auth.uid()) = created_by);
create policy "admins update projects" on public.projects for update
  using (public.has_project_role(id, 'admin'));
create policy "owners delete projects" on public.projects for delete
  using (public.has_project_role(id, 'owner'));

-- project_members
create policy "members read members" on public.project_members for select
  using (public.has_project_role(project_id, 'viewer'));
create policy "admins insert non-owner members" on public.project_members for insert
  with check (public.has_project_role(project_id, 'admin') and role <> 'owner');
create policy "admins update non-owner members" on public.project_members for update
  using (public.has_project_role(project_id, 'admin'))
  with check (role <> 'owner');
-- Single merged DELETE policy: admins can remove non-owner members, and any
-- member can remove themselves (provided they're not the sole owner).
-- PostgreSQL evaluates multiple permissive policies as a logical OR; doing
-- the OR explicitly is one expression instead of two SubPlans (avoids the
-- multiple_permissive_policies performance lint).
create policy "delete members" on public.project_members for delete
  using (
    (public.has_project_role(project_id, 'admin') and role <> 'owner')
    or
    (user_id = (select auth.uid()) and role <> 'owner')
  );

-- project_invitations (clients can read+write only as admins; accept happens
-- via service-role Edge Function, which bypasses RLS).
create policy "admins read invitations" on public.project_invitations for select
  using (public.has_project_role(project_id, 'admin'));
create policy "admins create invitations" on public.project_invitations for insert
  with check (public.has_project_role(project_id, 'admin'));
create policy "admins delete invitations" on public.project_invitations for delete
  using (public.has_project_role(project_id, 'admin'));

-- ── get_member_profiles(p_user_ids uuid[]) ─────────────────────────────────
-- Returns auth.users profile data (email + names + avatar) for the requested
-- user_ids, filtered to only users who share at least one project with the
-- caller. SECURITY DEFINER (runs as postgres) because `authenticated` can't
-- read auth.users directly — that table holds everyone's PII. The WHERE
-- clause's auth.uid() is the security boundary; the JWT claim is request-
-- scoped, so the row filter stays correctly per-user even though the
-- function runs as postgres.
--
-- A function rather than a view because Supabase's linter ERRORs on
-- security_definer_view but only WARNs on security_definer_function. Same
-- security model, less linter noise.
create or replace function public.get_member_profiles(p_user_ids uuid[])
returns table (
  id         uuid,
  email      text,
  full_name  text,
  name       text,
  avatar_url text
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
    u.raw_user_meta_data->>'avatar_url'
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

-- ── Storage bucket for project files ───────────────────────────────────────
-- Path convention: {project_id}/{file_id}/{filename}. UI for uploads ships in
-- build #2; the policies are here so they're enforced from day one.
insert into storage.buckets (id, name, public) values ('projects', 'projects', false)
on conflict (id) do nothing;

create policy "members read project files" on storage.objects for select
  using (bucket_id = 'projects'
    and public.has_project_role((string_to_array(name, '/'))[1]::uuid, 'viewer'));
create policy "members upload project files" on storage.objects for insert
  with check (bucket_id = 'projects'
    and public.has_project_role((string_to_array(name, '/'))[1]::uuid, 'member'));
create policy "admins delete project files" on storage.objects for delete
  using (bucket_id = 'projects'
    and public.has_project_role((string_to_array(name, '/'))[1]::uuid, 'admin'));
