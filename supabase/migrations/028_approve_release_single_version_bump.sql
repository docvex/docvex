-- 028_approve_release_single_version_bump.sql — Approving a composed
-- release (multiple change requests merged together in the Version
-- Control view) must bump projects.main_version by exactly ONE, not
-- once per request.
--
-- Before: the "Approve release" FAB called approve_change_request once
-- per staged request, and that RPC bumps main_version by 1 each call —
-- so a release bundling N authors' requests advanced main_version by N.
-- The user expects "compose a new main branch" = +1.
--
-- Fix: factor the per-request item merge into a shared internal helper
-- (_apply_change_request_items) so the single and batch paths can't
-- drift, then add a batch RPC (approve_change_requests) that applies
-- every request's items and increments main_version a SINGLE time. The
-- existing single-request approve_change_request keeps its +1 (one
-- per-chip approve = +1; one composed release = +1 — consistent: one
-- approval action advances main by one version).
--
-- The merge loop in the helper is copied verbatim from migration 020
-- (same add / edit / delete / replace handling, including the
-- thumbnail_frames-is-array guard); approve_change_request is rewritten
-- to delegate to it (behaviour unchanged).

-- ── Shared helper: apply one request's items to project_files ──────────
-- No auth check (the public callers validate authorization), no version
-- bump, no status change, no notification — purely the byte/row merge.
-- SECURITY DEFINER so it bypasses RLS like the callers did inline; not
-- granted to clients (only the SECURITY DEFINER parents, running as the
-- owner, invoke it).
create or replace function public._apply_change_request_items(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_request public.change_requests%rowtype;
  v_item public.change_request_items%rowtype;
  v_frames text[];
begin
  select * into v_request
    from public.change_requests
    where id = p_request_id;
  if not found then
    raise exception 'Request not found';
  end if;

  for v_item in
    select * from public.change_request_items
    where request_id = p_request_id
    order by seq asc
  loop
    -- Defensive: only iterate when the value is an actual JSON array.
    -- Covers (1) key absent, (2) key present + value null, (3) wrong
    -- type written by a buggy client. (See migration 020.)
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
end;
$$;

revoke all on function public._apply_change_request_items(uuid) from public, anon, authenticated;

-- ── Single-request approve (unchanged behaviour, now delegating) ──────
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
  v_project public.projects%rowtype;
  v_caller uuid;
  v_new_main_version bigint;
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

  perform public._apply_change_request_items(p_request_id);

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

-- ── Batch approve: one composed release → ONE main_version bump ───────
create or replace function public.approve_change_requests(p_request_ids uuid[])
returns table (
  out_project_id uuid,
  out_main_version bigint
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_caller uuid;
  v_request public.change_requests%rowtype;
  v_project public.projects%rowtype;
  v_project_id uuid;
  v_new_main_version bigint;
  v_id uuid;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Not authenticated';
  end if;
  if p_request_ids is null or array_length(p_request_ids, 1) is null then
    raise exception 'No requests provided';
  end if;

  -- Validate every request up front (lock the rows): each must exist, be
  -- open, and belong to the same project; the caller must be an admin of
  -- it. A release is a single-project concept, so a cross-project array
  -- is a programming error.
  foreach v_id in array p_request_ids loop
    select * into v_request
      from public.change_requests
      where id = v_id
      for update;
    if not found then
      raise exception 'Request not found: %', v_id;
    end if;
    if v_request.status <> 'open' then
      raise exception 'Request % is not open (status = %)', v_id, v_request.status;
    end if;
    if v_project_id is null then
      v_project_id := v_request.project_id;
    elsif v_project_id <> v_request.project_id then
      raise exception 'All requests in a release must belong to the same project';
    end if;
  end loop;

  if not public.has_project_role(v_project_id, 'admin') then
    raise exception 'Not authorized';
  end if;

  -- Apply every request's items via the shared helper.
  foreach v_id in array p_request_ids loop
    perform public._apply_change_request_items(v_id);
  end loop;

  -- ONE version bump for the whole release.
  update public.projects
    set main_version = main_version + 1
    where id = v_project_id
    returning main_version into v_new_main_version;

  -- Mark all approved in one statement.
  update public.change_requests
    set status = 'approved',
        decided_at = now(),
        decided_by = v_caller
    where id = any(p_request_ids);

  -- Notify each request's author that their push made it into main.
  select * into v_project from public.projects where id = v_project_id;
  foreach v_id in array p_request_ids loop
    select * into v_request from public.change_requests where id = v_id;
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
        'project_id', v_project_id
      ),
      format('cr-approved:%s', v_request.id)
    )
    on conflict (user_id, dedupe_key) do nothing;
  end loop;

  return query select v_project_id, v_new_main_version;
end;
$$;

-- Match approve_change_request's grants: drop the default PUBLIC/anon
-- execute, leave only authenticated (the function also rejects anon at
-- runtime via the auth.uid() check, but keep the surface tight).
revoke all on function public.approve_change_requests(uuid[]) from public, anon;
grant execute on function public.approve_change_requests(uuid[]) to authenticated;
