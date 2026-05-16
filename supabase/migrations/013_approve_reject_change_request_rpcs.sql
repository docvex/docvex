-- 013_approve_reject_change_request_rpcs.sql
-- Server-side merge for change requests. Storage operations happen
-- client-side (Supabase JS can copy across buckets); the DB writes
-- happen here in a single transaction so an interrupted approval
-- can't half-apply a request and corrupt main.
--
-- Both functions are SECURITY DEFINER because they need to insert
-- project_files rows attributed to the original AUTHOR
-- (uploaded_by = request.author_id), not the admin who approved —
-- the project_files INSERT RLS pins uploaded_by to auth.uid()
-- otherwise. The function authorizes the caller as admin EXPLICITLY
-- via has_project_role before doing anything else, so the elevated
-- privilege is safe.
--
-- Ordering for the client-side caller:
--   1. Admin client moves pending storage objects to canonical paths
--      (using Supabase storage's cross-bucket copy).
--   2. Admin client calls approve_change_request(id) — this RPC.
--   3. On success, admin client deletes pending objects + old
--      canonical objects (for replace items).
-- If (2) fails after (1), orphan canonical files exist but nothing
-- references them — cleanable by a future sweep. If (3) fails, orphan
-- pending objects — same.

create or replace function public.approve_change_request(p_request_id uuid)
returns table (
  request_id uuid,
  project_id uuid,
  main_version bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.change_requests%rowtype;
  v_item public.change_request_items%rowtype;
  v_caller uuid;
  v_new_main_version bigint;
  v_new_file_id uuid;
  v_frames text[];
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Not authenticated';
  end if;

  -- Lock the request to prevent concurrent decisions.
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

  -- Apply each item in submitted order so dependent operations
  -- (e.g. a delete followed by an add of the same name) behave
  -- deterministically.
  for v_item in
    select * from public.change_request_items
    where request_id = p_request_id
    order by seq asc
  loop
    -- Pre-compute the frames array if the proposed payload carries one.
    -- jsonb_array_elements_text is the canonical way to fold a JSON
    -- text array into a Postgres text[].
    if v_item.proposed is not null and v_item.proposed ? 'thumbnail_frames' then
      v_frames := ARRAY(
        select jsonb_array_elements_text(v_item.proposed->'thumbnail_frames')
      );
    else
      v_frames := null;
    end if;

    if v_item.kind = 'add' then
      -- New file. The client should have already copied the binary
      -- to the canonical storage_path before calling this RPC. The
      -- canonical id is taken from the proposed payload so the
      -- storage path's {file_id} segment (set client-side at copy
      -- time) matches the row id.
      insert into public.project_files (
        id, project_id, name, description, mime_type, size_bytes,
        storage_path, thumbnail_path, thumbnail_frames, duration_seconds,
        uploaded_by
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
        v_request.author_id
      );

    elsif v_item.kind = 'edit' then
      -- Metadata-only patch. `?` checks whether the key was provided
      -- so an absent key means "leave this column alone" (vs an
      -- explicit null which clears the column).
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
      -- Re-uploaded bytes for an existing file. Storage path moves
      -- to a new {file_id} folder (the client minted a new id at
      -- copy time, mirroring how an upload via the normal pipeline
      -- always uses a fresh path), so we update storage_path along
      -- with the size/mime/thumbnail metadata.
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
                              else description end
        where id = v_item.target_file_id;
    end if;
  end loop;

  -- Bump main version so every other member's branch shows the Sync
  -- prompt next time they load.
  update public.projects
    set main_version = main_version + 1
    where id = v_request.project_id
    returning main_version into v_new_main_version;

  -- Mark the request decided.
  update public.change_requests
    set status = 'approved',
        decided_at = now(),
        decided_by = v_caller
    where id = p_request_id;

  return query select p_request_id, v_request.project_id, v_new_main_version;
end;
$$;

revoke execute on function public.approve_change_request(uuid) from public, anon;
grant  execute on function public.approve_change_request(uuid) to authenticated;

-- Reject is much simpler — just flip status. Storage cleanup
-- (deleting pending objects) happens client-side after this returns.
create or replace function public.reject_change_request(
  p_request_id uuid,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.change_requests%rowtype;
  v_caller uuid;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Not authenticated';
  end if;
  select * into v_request from public.change_requests
    where id = p_request_id for update;
  if not found then
    raise exception 'Request not found';
  end if;
  if v_request.status <> 'open' then
    raise exception 'Request is not open (status = %)', v_request.status;
  end if;
  if not public.has_project_role(v_request.project_id, 'admin') then
    raise exception 'Not authorized';
  end if;
  update public.change_requests
    set status = 'rejected',
        decided_at = now(),
        decided_by = v_caller,
        decision_note = p_note
    where id = p_request_id;
end;
$$;

revoke execute on function public.reject_change_request(uuid, text) from public, anon;
grant  execute on function public.reject_change_request(uuid, text) to authenticated;
