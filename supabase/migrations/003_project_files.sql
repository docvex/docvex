-- 003_project_files.sql — Per-project file metadata mirroring the storage
-- bucket from 001_projects.sql. The storage `objects` table already enforces
-- role-gated read/insert/delete via has_project_role(); this table does the
-- same so Realtime can drive the /files list without polling storage.objects.

create table public.project_files (
  -- Equals the {file_id} segment in the storage path so the row and the
  -- binary share one identity. Generated client-side BEFORE the signed
  -- upload URL is requested, hence no DB-side default.
  id            uuid primary key,
  project_id    uuid not null references public.projects(id) on delete cascade,
  name          text not null check (length(trim(name)) > 0),
  mime_type     text not null,
  size_bytes    bigint not null check (size_bytes >= 0),
  storage_path  text not null,
  -- Set NULL on user deletion — same loosening rationale as projects.created_by
  -- (002_projects_created_by_set_null.sql): a user being removed shouldn't
  -- cascade-delete project artifacts that other members still rely on.
  uploaded_by   uuid references auth.users(id) on delete set null,
  uploaded_at   timestamptz not null default now()
);

-- Covers the project_id FK (Supabase unindexed_foreign_keys lint) AND serves
-- as the read path for the list page's "newest first" ordering in one btree.
create index project_files_project_uploaded_idx
  on public.project_files (project_id, uploaded_at desc);

-- Covers the uploaded_by FK so user-deletion cascades stay fast.
create index project_files_uploaded_by_idx
  on public.project_files (uploaded_by);

alter table public.project_files enable row level security;

-- Read: any viewer+ on the project can list/load metadata. Mirrors the
-- "members read project files" storage.objects policy at 001_projects.sql:269-271.
create policy "viewers read project files"
  on public.project_files for select
  using (public.has_project_role(project_id, 'viewer'));

-- Insert: member+ can add rows; WITH CHECK pins uploaded_by to the caller so
-- a malicious client can't attribute an upload to a different user. Mirrors
-- the "members upload project files" storage.objects policy at 001_projects.sql:272-274.
-- (select auth.uid()) wraps the call so PostgreSQL caches it as an initplan
-- per the same idiom used everywhere in 001_projects.sql.
create policy "members insert project files"
  on public.project_files for insert
  with check (
    public.has_project_role(project_id, 'member')
    and uploaded_by = (select auth.uid())
  );

-- Delete: admin+ only. Mirrors the "admins delete project files"
-- storage.objects policy at 001_projects.sql:275-277. Shipped now (even
-- though there's no delete UI yet in v1) so the metadata-row and binary-
-- object gates stay in lockstep — the follow-up that adds the delete
-- button only needs to wire UI, not policy.
create policy "admins delete project files"
  on public.project_files for delete
  using (public.has_project_role(project_id, 'admin'));

-- No UPDATE policy on purpose: rows are immutable once inserted. Renames
-- would require a storage object move which is out of scope for v1.

-- Realtime publication so /files receives INSERT events (other members'
-- uploads) and DELETE events (admin deletes, once the UI ships).
alter publication supabase_realtime add table public.project_files;
