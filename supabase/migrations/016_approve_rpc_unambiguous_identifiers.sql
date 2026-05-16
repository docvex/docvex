-- 016_approve_rpc_unambiguous_identifiers.sql
-- Fixes "column reference 'request_id' is ambiguous" inside
-- approve_change_request. The RPC's RETURNS TABLE declared OUT
-- columns named request_id / project_id / main_version — plpgsql
-- treats those as variables inside the function body, and any
-- table-column reference with the same name (e.g. `where request_id
-- = p_request_id` against change_request_items.request_id, or the
-- `set main_version = main_version + 1` increment on projects)
-- raised an ambiguity error.
--
-- Two changes:
--   1. Rename the OUT columns with an `out_` prefix so they can't
--      collide with table columns. The client (lib/branches.js)
--      doesn't read the result by name so this is a no-op on the
--      JS side.
--   2. Add `#variable_conflict use_column` at the top of the body
--      so any future identifier collision resolves to the column,
--      not the variable — matches what we want everywhere here.

-- CREATE OR REPLACE can't change the OUT parameter types of an
-- existing function, so we DROP first. Safe because we recreate
-- below with the same signature minus the OUT renames.
drop function if exists public.approve_change_request(uuid);

create function public.approve_change_request(p_request_id uuid)
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
    if v_item.proposed is not null and v_item.proposed ? 'thumbnail_frames' then
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
        content_hash, uploaded_by
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
        v_request.author_id
      );

    elsif v_item.kind = 'edit' then
      update public.project_files
        set name = case when v_item.proposed ? 'name'
                        then v_item.proposed->>'name'
                        else name end,
            description = case when v_item.proposed ? 'description'
                              then v_item.proposed->>'description'
                              else description end
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
