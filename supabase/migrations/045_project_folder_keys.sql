-- 045_project_folder_keys.sql
--
-- One random 256-bit key per project, used by the desktop app to encrypt what
-- it writes about a project's files OUTSIDE the machine's own (already
-- encrypted) index: the knowledge shards and settings in the case folder's
-- `.docvex/` (text read out of documents, identity readings, the AI scan's
-- understanding and web index) and the data bundles account sync uploads to
-- the `project-sync` bucket. A case folder shared through OneDrive / Dropbox,
-- copied to a stick or held in the sync bucket then carries no readable
-- personal data (GDPR art. 25, 32), while every member reads it on any machine.
--
-- The key is handed only to members of the project (any role), through
-- get_project_folder_key(), which also creates it on first use. The table is
-- never readable directly. Deleting a project deletes its key (cascade).
-- src/projectIndex/folderSeal.js and src/lib/projectFolderKey.js are the
-- other half.

create table if not exists public.project_folder_keys (
  project_id uuid primary key references public.projects(id) on delete cascade,
  key text not null,
  created_at timestamptz not null default now()
);
alter table public.project_folder_keys enable row level security;
revoke all on public.project_folder_keys from anon, authenticated;

create or replace function public.get_project_folder_key(p_project_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  k text;
begin
  if auth.uid() is null or not public.has_project_role(p_project_id, 'viewer') then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  insert into public.project_folder_keys (project_id, key)
  values (p_project_id, encode(extensions.gen_random_bytes(32), 'base64'))
  on conflict (project_id) do nothing;
  select f.key into k from public.project_folder_keys f where f.project_id = p_project_id;
  return k;
end;
$$;
revoke all on function public.get_project_folder_key(uuid) from public, anon;
grant execute on function public.get_project_folder_key(uuid) to authenticated;
