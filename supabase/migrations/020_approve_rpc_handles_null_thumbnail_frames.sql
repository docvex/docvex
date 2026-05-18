-- 020_approve_rpc_handles_null_thumbnail_frames.sql — Make the
-- approve_change_request RPC defensive against `thumbnail_frames`
-- being present but null (or any non-array value) in
-- change_request_items.proposed.
--
-- Previous behaviour (migrations 013 / 016): the function guarded
-- on `v_item.proposed ? 'thumbnail_frames'`, which returns true
-- whenever the KEY exists regardless of value. It then called
-- jsonb_array_elements_text on `proposed->'thumbnail_frames'`. When
-- that value is jsonb null (e.g. the client wrote
-- `"thumbnail_frames": null` for non-video items), Postgres raises
--   "cannot extract elements from a scalar"
-- and the whole RPC 400s. The wrapping change_request_item insert
-- aborts, the storage copies that preceded the RPC become orphans,
-- and the user sees "Approval failed".
--
-- Fix: tighten the guard to `jsonb_typeof(...) = 'array'` so only
-- actual JSON arrays enter the iteration. Missing / null / scalar
-- / object values safely yield null v_frames.
--
-- Same function signature and OUT columns as migration 016. The
-- only body change is the thumbnail_frames extraction guard at
-- the top of the for-loop. CREATE OR REPLACE keeps the existing
-- grants in place.

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
    -- Defensive: only iterate when the value is an actual JSON
    -- array. Covers (1) key absent, (2) key present + value null,
    -- (3) wrong type written by a buggy client.
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
