-- 005_project_files_description_and_delete_rls.sql
-- Description column for the file-detail modal + loosened RLS so uploaders
-- can manage their own files (matches the auth pattern on both project_files
-- and storage.objects for the `projects` bucket).

alter table public.project_files
  add column description text;

-- UPDATE: uploader OR admin. WITH CHECK same as USING so a row can't be
-- "stolen" by changing uploaded_by during an update (RLS would re-evaluate
-- with the new value and reject if not authorized for the new state).
create policy "uploader or admin update project files"
  on public.project_files for update
  using (
    public.has_project_role(project_id, 'admin')
    or uploaded_by = (select auth.uid())
  )
  with check (
    public.has_project_role(project_id, 'admin')
    or uploaded_by = (select auth.uid())
  );

-- DELETE on the metadata row: replace admin-only with uploader-or-admin.
drop policy if exists "admins delete project files" on public.project_files;
create policy "uploader or admin delete project files"
  on public.project_files for delete
  using (
    public.has_project_role(project_id, 'admin')
    or uploaded_by = (select auth.uid())
  );

-- DELETE on the storage object: same broadening. Admins use the path's
-- first segment for the project membership check (as before); uploaders
-- use an EXISTS subquery against project_files (matched on storage_path
-- OR thumbnail_path) so both the binary AND the _thumb.jpg sibling are
-- deletable by the same authorized caller in one .remove([…]) call.
drop policy if exists "admins delete project files" on storage.objects;
create policy "uploader or admin delete project files"
  on storage.objects for delete
  using (
    bucket_id = 'projects'
    and (
      public.has_project_role(
        (string_to_array(name, '/'))[1]::uuid,
        'admin'
      )
      or exists (
        select 1 from public.project_files pf
        where (pf.storage_path = storage.objects.name
               or pf.thumbnail_path = storage.objects.name)
          and pf.uploaded_by = (select auth.uid())
      )
    )
  );
