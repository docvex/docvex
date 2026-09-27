-- ── Upload from a phone, through the cloud ──────────────────────────────────
-- The Files tab's Import shows two QR codes. One sends the phone straight to
-- the desktop app over the local network (no cloud at all). THIS is the other:
-- for a phone that isn't on the same network. The phone is not signed in, so
-- it never talks to storage directly with rights of its own — it holds a
-- short-lived random TOKEN, and the `phone-upload` Edge Function (service role)
-- hands it a signed upload URL per file. The desktop app, signed in as the
-- session's owner, is told of each file (Realtime), downloads it into the
-- project folder and deletes it here at once — the bucket is a hand-off, not
-- a store.
--
--   phone_upload_sessions   one per QR code shown (owner, project, token, expiry)
--   phone_upload_files      one per file received, until the desktop takes it
--   phone-upload (bucket)   <session id>/<random id>  — private, 50 MB a file

create table if not exists public.phone_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete cascade,
  -- Only a HASH of the token is kept: the token itself exists only in the QR
  -- code, so reading this table (a leak, a backup) gives no way to upload.
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz,
  file_count int not null default 0,
  byte_count bigint not null default 0
);
create index if not exists phone_upload_sessions_user_idx on public.phone_upload_sessions (user_id, created_at desc);

create table if not exists public.phone_upload_files (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.phone_upload_sessions (id) on delete cascade,
  path text not null,              -- the object in the bucket
  name text not null,              -- the filename the phone gave
  size bigint not null default 0,
  mime text,
  created_at timestamptz not null default now()
);
create index if not exists phone_upload_files_session_idx on public.phone_upload_files (session_id);

alter table public.phone_upload_sessions enable row level security;
alter table public.phone_upload_files enable row level security;

-- The owner sees and ends their own sessions; creating one goes through the
-- function (it mints the token), so there is no insert policy.
drop policy if exists "phone upload: owner reads sessions" on public.phone_upload_sessions;
create policy "phone upload: owner reads sessions"
  on public.phone_upload_sessions for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "phone upload: owner deletes sessions" on public.phone_upload_sessions;
create policy "phone upload: owner deletes sessions"
  on public.phone_upload_sessions for delete to authenticated
  using (user_id = auth.uid());

-- The owner reads the files arriving in their sessions and removes each once
-- it is on disk. Rows are written by the function only.
drop policy if exists "phone upload: owner reads files" on public.phone_upload_files;
create policy "phone upload: owner reads files"
  on public.phone_upload_files for select to authenticated
  using (exists (select 1 from public.phone_upload_sessions s where s.id = session_id and s.user_id = auth.uid()));
drop policy if exists "phone upload: owner deletes files" on public.phone_upload_files;
create policy "phone upload: owner deletes files"
  on public.phone_upload_files for delete to authenticated
  using (exists (select 1 from public.phone_upload_sessions s where s.id = session_id and s.user_id = auth.uid()));

-- The desktop is told of each file as it lands.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'phone_upload_files'
  ) then
    alter publication supabase_realtime add table public.phone_upload_files;
  end if;
end $$;

-- ── The bucket ───────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('phone-upload', 'phone-upload', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- An object's first path segment is its session. The session's owner may read
-- and delete it; uploads come only through the function's signed URLs.
create or replace function public.phone_upload_owner(object_name text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.user_id from public.phone_upload_sessions s
  where (storage.foldername(object_name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and s.id = ((storage.foldername(object_name))[1])::uuid
$$;

drop policy if exists "phone upload: owner reads objects" on storage.objects;
create policy "phone upload: owner reads objects"
  on storage.objects for select to authenticated
  using (bucket_id = 'phone-upload' and public.phone_upload_owner(name) = auth.uid());
drop policy if exists "phone upload: owner deletes objects" on storage.objects;
create policy "phone upload: owner deletes objects"
  on storage.objects for delete to authenticated
  using (bucket_id = 'phone-upload' and public.phone_upload_owner(name) = auth.uid());
