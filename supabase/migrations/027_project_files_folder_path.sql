-- 027_project_files_folder_path.sql
-- Team-synced folders. Files keep their flat per-file storage path
-- (`{project_id}/{file_id}/{filename}`); the folder a file lives in is
-- pure metadata carried in a new `folder_path` column (relative path
-- from the project root, '' = root, forward-slash separated, no leading
-- or trailing slash). The branch flow threads this through `proposed`
-- so a teammate's download recreates the same folder structure.
--
-- Additive + backfilled to '' so every existing (flat) file is
-- unaffected and keeps rendering at the root.

alter table public.project_files
  add column if not exists folder_path text not null default '';

-- Recreate approve_change_request so the merge persists folder_path.
-- Body is migration 020's verbatim plus folder_path on the add insert
-- and the edit / replace updates. Everything else is identical.
create or replace function public.approve_change_request(p_request_id uuid)
returns table (
  out_request_id uuid,
  out_project_id uuid,
  out_main_version bigint
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_request public.change_requests%rowtype;
  v_item public.change_request_items%rowtype;
  v_project public.projects%rowtype;
  v_caller uuid;
  v_new_main_version bigint;
  v_frames text[];
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_request
    from public.change_requests
    where id = p_request_id
    for update;
  if not found then
    raise exception 'Request not found';
  end if;
  if v_request.status <> 'open' then
    raise exception 'Request is not open (status = %)', v_request.status;
  end if;
  if not public.has_project_role(v_request.project_id, 'admin') then
    raise exception 'Not authorized';
  end if;

  for v_item in
    select * from public.change_request_items
    where request_id = p_request_id
    order by seq asc
  loop
    if v_item.proposed is not null
       and jsonb_typeof(v_item.proposed->'thumbnail_frames') = 'array' then
      v_frames := ARRAY(
        select jsonb_array_elements_text(v_item.proposed->'thumbnail_frames')
      );
    else
      v_frames := null;
    end if;

    if v_item.kind = 'add' then
      insert into public.project_files (
        id, project_id, name, description, mime_type, size_bytes,
        storage_path, thumbnail_path, thumbnail_frames, duration_seconds,
        content_hash, folder_path, uploaded_by
      )
      values (
        coalesce((v_item.proposed->>'id')::uuid, gen_random_uuid()),
        v_request.project_id,
        v_item.proposed->>'name',
        v_item.proposed->>'description',
        v_item.proposed->>'mime_type',
        (v_item.proposed->>'size_bytes')::bigint,
        v_item.proposed->>'storage_path',
        v_item.proposed->>'thumbnail_path',
        v_frames,
        case when v_item.proposed ? 'duration_seconds'
             then (v_item.proposed->>'duration_seconds')::int
             else null end,
        v_item.proposed->>'content_hash',
        coalesce(v_item.proposed->>'folder_path', ''),
        v_request.author_id
      );

    elsif v_item.kind = 'edit' then
      update public.project_files
        set name = case when v_item.proposed ? 'name'
                        then v_item.proposed->>'name'
                        else name end,
            description = case when v_item.proposed ? 'description'
                              then v_item.proposed->>'description'
                              else description end,
            folder_path = case when v_item.proposed ? 'folder_path'
                               then coalesce(v_item.proposed->>'folder_path', '')
                               else folder_path end
        where id = v_item.target_file_id;

    elsif v_item.kind = 'delete' then
      delete from public.project_files
        where id = v_item.target_file_id;

    elsif v_item.kind = 'replace' then
      update public.project_files
        set storage_path = v_item.proposed->>'storage_path',
            thumbnail_path = v_item.proposed->>'thumbnail_path',
            thumbnail_frames = v_frames,
            duration_seconds = case when v_item.proposed ? 'duration_seconds'
                                    then (v_item.proposed->>'duration_seconds')::int
                                    else null end,
            mime_type = coalesce(v_item.proposed->>'mime_type', mime_type),
            size_bytes = coalesce((v_item.proposed->>'size_bytes')::bigint, size_bytes),
            name = case when v_item.proposed ? 'name'
                        then v_item.proposed->>'name'
                        else name end,
            description = case when v_item.proposed ? 'description'
                              then v_item.proposed->>'description'
                              else description end,
            folder_path = case when v_item.proposed ? 'folder_path'
                               then coalesce(v_item.proposed->>'folder_path', '')
                               else folder_path end,
            content_hash = case when v_item.proposed ? 'content_hash'
                                then v_item.proposed->>'content_hash'
                                else content_hash end
        where id = v_item.target_file_id;
    end if;
  end loop;

  update public.projects
    set main_version = main_version + 1
    where id = v_request.project_id
    returning main_version into v_new_main_version;

  update public.change_requests
    set status = 'approved',
        decided_at = now(),
        decided_by = v_caller
    where id = p_request_id;

  select * into v_project from public.projects where id = v_request.project_id;
  insert into public.notifications (
    user_id, category, variant, priority, icon, title, body, payload, dedupe_key
  )
  values (
    v_request.author_id,
    'file',
    'success',
    'normal',
    'check',
    'Push approved',
    format('"%s" was merged into main of %s.', v_request.title, coalesce(v_project.name, 'the project')),
    jsonb_build_object(
      'change_request_id', v_request.id,
      'project_id', v_request.project_id
    ),
    format('cr-approved:%s', v_request.id)
  )
  on conflict (user_id, dedupe_key) do nothing;

  return query select p_request_id, v_request.project_id, v_new_main_version;
end;
$$;

revoke execute on function public.approve_change_request(uuid) from public, anon;
grant  execute on function public.approve_change_request(uuid) to authenticated;
