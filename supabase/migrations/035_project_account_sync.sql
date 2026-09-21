-- ── Sync a project to the signed-in account ──────────────────────────────────
-- "Sync with account" (Project → Overview) mirrors a project's local folder into
-- the user's Supabase account, so any device signed into that account can pull
-- the same files. Migration 031 removed the old cloud file store; this is NOT a
-- return to it — files are still local-only and authoritative on disk, and a
-- project is only copied up when someone switches the toggle on for it.
--
-- Deliberately NO new tables. Everything the client needs is in the bucket:
--   project-sync/<project_id>/.docvex-sync.json   the manifest (what is synced)
--   project-sync/<project_id>/<relative path>     the files themselves
-- The manifest's presence IS the toggle, and one `list('')` call tells a fresh
-- device which of the account's projects have a copy waiting — no column to keep
-- in step, and turning sync off leaves nothing behind.

-- A storage object's first path segment is the project id. Anything else (a
-- stray object at the bucket root, a non-uuid folder) yields NULL, which makes
-- every policy below fail closed rather than raising on the ::uuid cast.
create or replace function public.storage_project_id(object_name text)
returns uuid
language sql
immutable
as $$
  select case
    when (storage.foldername(object_name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((storage.foldername(object_name))[1])::uuid
    else null
  end
$$;

-- Private bucket. 50 MB per object: this syncs working documents, not media
-- libraries, and a cap the client also enforces keeps one stray video from
-- eating the project's storage quota.
insert into storage.buckets (id, name, public, file_size_limit)
values ('project-sync', 'project-sync', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- Reading: any member of the project. This is the whole point — another device
-- signed into the same account is the same member.
drop policy if exists "project sync: members read" on storage.objects;
create policy "project sync: members read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'project-sync'
    and public.storage_project_id(name) is not null
    and has_project_role(public.storage_project_id(name), 'viewer')
  );

-- Writing: the same capability that governs putting files into the project at
-- all, so sync can't be used to get around a viewer's read-only role.
drop policy if exists "project sync: uploaders write" on storage.objects;
create policy "project sync: uploaders write"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'project-sync'
    and public.storage_project_id(name) is not null
    and has_capability(public.storage_project_id(name), 'files.upload')
  );

drop policy if exists "project sync: uploaders replace" on storage.objects;
create policy "project sync: uploaders replace"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'project-sync'
    and public.storage_project_id(name) is not null
    and has_capability(public.storage_project_id(name), 'files.upload')
  )
  with check (
    bucket_id = 'project-sync'
    and public.storage_project_id(name) is not null
    and has_capability(public.storage_project_id(name), 'files.upload')
  );

-- Deleting: removing a file from the account's copy is a delete on the project,
-- so it takes the delete capability — and switching sync off (which clears the
-- whole prefix) is therefore an admin/owner action in practice.
drop policy if exists "project sync: deleters remove" on storage.objects;
create policy "project sync: deleters remove"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'project-sync'
    and public.storage_project_id(name) is not null
    and (
      has_capability(public.storage_project_id(name), 'files.delete_any')
      or owner = auth.uid()
    )
  );
