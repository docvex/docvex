-- 046_e2e_project_keys.sql
--
-- END-TO-END project keys. Migration 045 had the SERVER make and hold each
-- project's folder key, so anyone with the service role (or a database dump)
-- could open the "encrypted" `.docvex/` shards and sync bundles; viewers got
-- it, removed members kept it, and it was never rotated. From here on the
-- server only stores keys it cannot open:
--
--   user_public_keys     each user's X25519 (key agreement) + Ed25519
--                        (signatures) PUBLIC keys. Private keys never leave the
--                        user's devices (src/lib/e2e/identity.js).
--   user_key_backups     the user's private keys encrypted under a key derived
--                        from a recovery passphrase only they know (PBKDF2-SHA256,
--                        600k iterations) — opaque to the server.
--   project_key_versions one row per version of a project's key (the key
--                        itself is NOT here). A new version is made by a member
--                        who can grant, on removal of a member (rotation).
--   project_key_grants   the project key of one version, sealed (X25519 + HKDF
--                        + AES-256-GCM, ephemeral sender key) to ONE member's
--                        published X25519 key. A member reads only their own.
--   dm_conversation_keys a direct-message conversation's key, sealed to both
--                        people in it.
--
-- MIGRATING FROM 045: a client that can still fetch the legacy server key
-- (get_project_folder_key) registers it as VERSION 1, grants it to every
-- member who has a published key, and calls retire_server_folder_key(), which
-- deletes the server's copy only once every current member holds a grant of
-- the newest version. get_project_folder_key no longer CREATES keys: a new
-- project's key is made on a client (src/lib/e2e/projectKeys.js).
--
-- Order: apply after 045. Clients before this migration keep working on the
-- legacy key until it is retired (their writes under v1 stay readable).

-- ── helpers ─────────────────────────────────────────────────────────────────
create or replace function public.is_project_member(p_project_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  -- Answers only about a project the CALLER belongs to (no membership oracle).
  select exists (select 1 from public.project_members where project_id = p_project_id and user_id = (select auth.uid()))
     and exists (select 1 from public.project_members where project_id = p_project_id and user_id = p_user_id);
$$;
revoke all on function public.is_project_member(uuid, uuid) from public, anon;
grant execute on function public.is_project_member(uuid, uuid) to authenticated;

create or replace function public.shares_project_with(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.project_members a
      join public.project_members b on b.project_id = a.project_id
     where a.user_id = (select auth.uid()) and b.user_id = p_user_id
  );
$$;
revoke all on function public.shares_project_with(uuid) from public, anon;
grant execute on function public.shares_project_with(uuid) to authenticated;

-- Who may hand the project key to OTHER members: owners, admins, and anyone
-- whose (custom) role carries members.invite.
create or replace function public.can_grant_project_keys(p_project_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_project_role(p_project_id, 'admin')
      or public.has_capability(p_project_id, 'members.invite');
$$;
revoke all on function public.can_grant_project_keys(uuid) from public, anon;
grant execute on function public.can_grant_project_keys(uuid) to authenticated;

create or replace function public.has_legacy_folder_key(p_project_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.project_folder_keys where project_id = p_project_id);
$$;
revoke all on function public.has_legacy_folder_key(uuid) from public, anon;
grant execute on function public.has_legacy_folder_key(uuid) to authenticated;

-- ── user_public_keys ───────────────────────────────────────────────────────
create table if not exists public.user_public_keys (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  x25519     text not null check (length(x25519) between 40 and 64),
  ed25519    text not null check (length(ed25519) between 40 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.user_public_keys enable row level security;
drop policy if exists "keys: read own or co-members" on public.user_public_keys;
create policy "keys: read own or co-members" on public.user_public_keys for select
  using (user_id = (select auth.uid()) or public.shares_project_with(user_id));
drop policy if exists "keys: publish own" on public.user_public_keys;
create policy "keys: publish own" on public.user_public_keys for insert
  with check (user_id = (select auth.uid()));
drop policy if exists "keys: replace own" on public.user_public_keys;
create policy "keys: replace own" on public.user_public_keys for update
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create or replace function public._touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists user_public_keys_touch on public.user_public_keys;
create trigger user_public_keys_touch before update on public.user_public_keys
  for each row execute function public._touch_updated_at();

-- ── user_key_backups ───────────────────────────────────────────────────────
create table if not exists public.user_key_backups (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  blob       text not null check (length(blob) < 20000),
  updated_at timestamptz not null default now()
);
alter table public.user_key_backups enable row level security;
drop policy if exists "backups: own only" on public.user_key_backups;
create policy "backups: own only" on public.user_key_backups for all
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ── project_key_versions ───────────────────────────────────────────────────
create table if not exists public.project_key_versions (
  project_id uuid not null references public.projects(id) on delete cascade,
  version    integer not null check (version >= 1),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  retired    boolean not null default false,   -- no longer written with
  retired_at timestamptz,
  primary key (project_id, version)
);
alter table public.project_key_versions enable row level security;

create or replace function public.next_project_key_version(p_project_id uuid)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(max(version), 0) + 1 from public.project_key_versions where project_id = p_project_id;
$$;
revoke all on function public.next_project_key_version(uuid) from public, anon;
grant execute on function public.next_project_key_version(uuid) to authenticated;

drop policy if exists "key versions: members read" on public.project_key_versions;
create policy "key versions: members read" on public.project_key_versions for select
  using (public.has_project_role(project_id, 'viewer'));
-- A new version is always the NEXT one. Granters make it; any member may
-- register version 1 when it is the legacy server key being adopted.
drop policy if exists "key versions: next one" on public.project_key_versions;
create policy "key versions: next one" on public.project_key_versions for insert
  with check (
    created_by = (select auth.uid())
    and retired = false
    and version = public.next_project_key_version(project_id)
    and (
      public.can_grant_project_keys(project_id)
      or (version = 1 and public.has_project_role(project_id, 'viewer') and public.has_legacy_folder_key(project_id))
    )
  );

-- A new version retires every older one for writing (they stay readable).
create or replace function public._retire_older_key_versions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.project_key_versions
     set retired = true, retired_at = coalesce(retired_at, now())
   where project_id = new.project_id and version < new.version and not retired;
  return new;
end;
$$;
drop trigger if exists project_key_versions_retire_older on public.project_key_versions;
create trigger project_key_versions_retire_older after insert on public.project_key_versions
  for each row execute function public._retire_older_key_versions();

-- ── project_key_grants ─────────────────────────────────────────────────────
create table if not exists public.project_key_grants (
  project_id    uuid not null,
  user_id       uuid not null references auth.users(id) on delete cascade,
  version       integer not null,
  wrapped       text not null check (length(wrapped) < 4000),
  recipient_key text not null,            -- the X25519 key it was sealed to
  granted_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (project_id, user_id, version),
  foreign key (project_id, version) references public.project_key_versions(project_id, version) on delete cascade
);
create index if not exists project_key_grants_user_idx on public.project_key_grants (user_id);
alter table public.project_key_grants enable row level security;

drop policy if exists "grants: read own" on public.project_key_grants;
create policy "grants: read own" on public.project_key_grants for select
  using (user_id = (select auth.uid()));
-- Sealed to the recipient's CURRENT published key, to a CURRENT member; for
-- oneself by any member, for others by granters only.
drop policy if exists "grants: give" on public.project_key_grants;
create policy "grants: give" on public.project_key_grants for insert
  with check (
    granted_by = (select auth.uid())
    and public.is_project_member(project_id, user_id)
    and recipient_key = (select k.x25519 from public.user_public_keys k where k.user_id = project_key_grants.user_id)
    and (
      (user_id = (select auth.uid()) and public.has_project_role(project_id, 'viewer'))
      or public.can_grant_project_keys(project_id)
    )
  );
drop policy if exists "grants: re-seal" on public.project_key_grants;
create policy "grants: re-seal" on public.project_key_grants for update
  using (user_id = (select auth.uid()) or public.can_grant_project_keys(project_id))
  with check (
    granted_by = (select auth.uid())
    and public.is_project_member(project_id, user_id)
    and recipient_key = (select k.x25519 from public.user_public_keys k where k.user_id = project_key_grants.user_id)
    and (
      (user_id = (select auth.uid()) and public.has_project_role(project_id, 'viewer'))
      or public.can_grant_project_keys(project_id)
    )
  );
drop policy if exists "grants: drop own" on public.project_key_grants;
create policy "grants: drop own" on public.project_key_grants for delete
  using (user_id = (select auth.uid()));

drop trigger if exists project_key_grants_touch on public.project_key_grants;
create trigger project_key_grants_touch before update on public.project_key_grants
  for each row execute function public._touch_updated_at();

-- A member leaves / is removed: their grants go, and the newest key version
-- is retired so the next granter to open the project rotates it (the client
-- that removed them usually does it at once — src/lib/projects.js).
create or replace function public._on_member_removed_keys()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.project_key_grants where project_id = old.project_id and user_id = old.user_id;
  update public.project_key_versions
     set retired = true, retired_at = coalesce(retired_at, now())
   where project_id = old.project_id
     and version = (select max(version) from public.project_key_versions where project_id = old.project_id)
     and not retired;
  return old;
end;
$$;
drop trigger if exists project_members_removed_keys on public.project_members;
create trigger project_members_removed_keys after delete on public.project_members
  for each row execute function public._on_member_removed_keys();

-- ── RPCs ────────────────────────────────────────────────────────────────────
-- The newest version, whether it needs rotating (retired = a member left
-- since it was made), whether the caller may grant, and how many members hold
-- it (0 = its maker failed to keep it: a granter makes the next one).
create or replace function public.current_project_key_version(p_project_id uuid)
returns table (version integer, retired boolean, can_grant boolean, holders integer)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if auth.uid() is null or not public.has_project_role(p_project_id, 'viewer') then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  return query
    select v.version, v.retired, public.can_grant_project_keys(p_project_id),
           (select count(*)::int from public.project_key_grants g
             where g.project_id = p_project_id and g.version = v.version)
      from public.project_key_versions v
     where v.project_id = p_project_id
     order by v.version desc limit 1;
end;
$$;
revoke all on function public.current_project_key_version(uuid) from public, anon;
grant execute on function public.current_project_key_version(uuid) to authenticated;

-- (member, version) pairs lacking a grant sealed to that member's CURRENT
-- published key. A granter sees every member (all versions — a new member
-- also needs the old ones to read what was written before they joined); any
-- other member sees only their own gaps.
create or replace function public.project_key_missing_grants(p_project_id uuid)
returns table (user_id uuid, version integer, x25519 text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_all boolean;
begin
  if auth.uid() is null or not public.has_project_role(p_project_id, 'viewer') then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  v_all := public.can_grant_project_keys(p_project_id);
  return query
    select m.user_id, v.version, k.x25519
      from public.project_members m
      join public.user_public_keys k on k.user_id = m.user_id
      cross join public.project_key_versions v
     where m.project_id = p_project_id
       and v.project_id = p_project_id
       and (v_all or m.user_id = auth.uid())
       and not exists (
         select 1 from public.project_key_grants g
          where g.project_id = p_project_id and g.user_id = m.user_id
            and g.version = v.version and g.recipient_key = k.x25519
       )
     order by v.version desc, m.user_id;
end;
$$;
revoke all on function public.project_key_missing_grants(uuid) from public, anon;
grant execute on function public.project_key_missing_grants(uuid) to authenticated;

-- Delete the server-held legacy key (045) once nobody needs it: every current
-- member holds a grant of the newest version, sealed to their current key.
-- Returns true when the key is gone (now or already).
create or replace function public.retire_server_folder_key(p_project_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_latest integer;
begin
  if auth.uid() is null or not public.has_project_role(p_project_id, 'viewer') then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  if not exists (select 1 from public.project_folder_keys where project_id = p_project_id) then
    return true;
  end if;
  select max(version) into v_latest from public.project_key_versions where project_id = p_project_id;
  if v_latest is null then return false; end if;
  if exists (
    select 1 from public.project_members m
     where m.project_id = p_project_id
       and not exists (
         select 1 from public.project_key_grants g
           join public.user_public_keys k on k.user_id = g.user_id and k.x25519 = g.recipient_key
          where g.project_id = p_project_id and g.user_id = m.user_id and g.version = v_latest
       )
  ) then
    return false;
  end if;
  delete from public.project_folder_keys where project_id = p_project_id;
  return true;
end;
$$;
revoke all on function public.retire_server_folder_key(uuid) from public, anon;
grant execute on function public.retire_server_folder_key(uuid) to authenticated;

-- 045's getter: now ONLY hands out a legacy key that still exists — it never
-- makes one. Null once the key is retired or for a project made after 046.
create or replace function public.get_project_folder_key(p_project_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  k text;
begin
  if auth.uid() is null or not public.has_project_role(p_project_id, 'viewer') then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  select f.key into k from public.project_folder_keys f where f.project_id = p_project_id;
  return k;
end;
$$;
revoke all on function public.get_project_folder_key(uuid) from public, anon;
grant execute on function public.get_project_folder_key(uuid) to authenticated;

-- ── dm_conversation_keys ───────────────────────────────────────────────────
create table if not exists public.dm_conversation_keys (
  id           uuid primary key,              -- chosen by the client (named in each message)
  project_id   uuid not null references public.projects(id) on delete cascade,
  user_low     uuid not null references auth.users(id) on delete cascade,
  user_high    uuid not null references auth.users(id) on delete cascade,
  wrapped_low  text not null check (length(wrapped_low) < 4000),
  wrapped_high text not null check (length(wrapped_high) < 4000),
  low_key      text not null,
  high_key     text not null,
  created_by   uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  check (user_low < user_high)
);
create index if not exists dm_conversation_keys_pair_idx on public.dm_conversation_keys (project_id, user_low, user_high);
alter table public.dm_conversation_keys enable row level security;
drop policy if exists "dm keys: the two read" on public.dm_conversation_keys;
create policy "dm keys: the two read" on public.dm_conversation_keys for select
  using ((select auth.uid()) in (user_low, user_high));
drop policy if exists "dm keys: one of the two makes" on public.dm_conversation_keys;
create policy "dm keys: one of the two makes" on public.dm_conversation_keys for insert
  with check (
    created_by = (select auth.uid())
    and (select auth.uid()) in (user_low, user_high)
    and public.is_project_member(project_id, user_low)
    and public.is_project_member(project_id, user_high)
    and low_key  = (select k.x25519 from public.user_public_keys k where k.user_id = user_low)
    and high_key = (select k.x25519 from public.user_public_keys k where k.user_id = user_high)
  );

-- ── the mention notification no longer quotes the project name ─────────────
-- Names are ciphertext now (`e2e:v1:…`); the notification says "a project" and
-- carries the project id, which the app turns back into the name it can read.
create or replace function public._notify_chat_mentions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_name text;
begin
  if new.mentions is null or array_length(new.mentions, 1) is null then
    return new;
  end if;
  if new.deleted_at is not null then
    return new;
  end if;
  select p.name into v_name from public.projects p where p.id = new.project_id;
  if v_name like 'e2e:%' then v_name := null; end if;

  foreach v_user_id in array new.mentions
  loop
    if v_user_id = new.author_id then continue; end if;
    if not exists (
      select 1 from public.project_members
        where project_id = new.project_id and user_id = v_user_id
    ) then
      continue;
    end if;
    insert into public.notifications (
      user_id, category, variant, priority, icon, title, body, payload, dedupe_key
    )
    values (
      v_user_id, 'file', 'info', 'normal', 'chat',
      'You were mentioned',
      format('You were mentioned in %s.', coalesce(v_name, 'a project chat')),
      jsonb_build_object('message_id', new.id, 'project_id', new.project_id, 'author_id', new.author_id),
      format('chat-mention:%s:%s', new.id, v_user_id)
    )
    on conflict (user_id, dedupe_key) do nothing;
  end loop;
  return new;
end;
$$;
