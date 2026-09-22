-- ── Account sync: each user's PRIVATE project data ──────────────────────────
-- Migration 035's bucket holds a synced project's files, readable by every
-- member. lib/projectSyncData also syncs what a user keeps ABOUT a project that
-- is theirs alone — the Doc Viewer advisor threads and the Advisor chats — and
-- those must not be readable by teammates. They live in a folder of the user's
-- own:
--
--   project-sync/user-<auth user id>/<project id>.json
--
-- `storage_project_id('user-…')` is NULL, so every policy from 035 already
-- refuses that folder. The policies below open it to its owner and nobody else.
-- Until this migration runs the client's upload simply fails (and says so) —
-- the private bundle is never written anywhere a teammate could read it.

create or replace function public.storage_sync_owner_folder(object_name text)
returns boolean
language sql
stable
as $$
  select auth.uid() is not null
     and (storage.foldername(object_name))[1] = 'user-' || auth.uid()::text
$$;

drop policy if exists "project sync: own private data read" on storage.objects;
create policy "project sync: own private data read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'project-sync' and public.storage_sync_owner_folder(name));

drop policy if exists "project sync: own private data write" on storage.objects;
create policy "project sync: own private data write"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'project-sync' and public.storage_sync_owner_folder(name));

drop policy if exists "project sync: own private data replace" on storage.objects;
create policy "project sync: own private data replace"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'project-sync' and public.storage_sync_owner_folder(name))
  with check (bucket_id = 'project-sync' and public.storage_sync_owner_folder(name));

drop policy if exists "project sync: own private data remove" on storage.objects;
create policy "project sync: own private data remove"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'project-sync' and public.storage_sync_owner_folder(name));
