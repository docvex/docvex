-- 014_content_hash_and_notifications.sql
-- Three follow-ups on top of the branch / change-request infrastructure:
--   • content_hash column on project_files — SHA-256 of the file's
--     bytes, populated at upload time. Lets the branch diff catch
--     same-size content edits (an image re-encode that keeps the
--     byte count constant would otherwise read as unchanged).
--   • approve_change_request RPC updated to write content_hash from
--     each item's proposed payload, AND to insert a notification for
--     the request's author when the request flips to approved.
--   • reject_change_request RPC inserts an author notification on
--     reject too.
--   • AFTER INSERT trigger on change_requests fires admin
--     notifications when a member submits.
--
-- Notifications are inserted via SECURITY DEFINER functions because
-- the RLS on `public.notifications` pins INSERTs to the caller's
-- own user_id (so members can't notify each other directly). The
-- definer functions belong to the postgres role and bypass that
-- check — they're only callable in well-defined places (the
-- approve/reject RPCs + the change_requests INSERT trigger) and
-- each performs its own authorization check before firing.

-- ── content_hash column ───────────────────────────────────────────────
-- Hex-encoded SHA-256 (64 chars). Nullable for rows uploaded before
-- this migration — the diff falls back to size comparison for those.
alter table public.project_files
  add column content_hash text;

-- ── approve_change_request (recreated to thread content_hash + notify) ──
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

  -- Notify the author. SECURITY DEFINER bypasses the notifications
  -- RLS (which pins INSERTs to auth.uid() == user_id) so we can
  -- insert a row addressed to a different user.
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

-- ── reject_change_request (recreated to add author notification) ─────
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
  v_project public.projects%rowtype;
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

  -- Notify the author.
  select * into v_project from public.projects where id = v_request.project_id;
  insert into public.notifications (
    user_id, category, variant, priority, icon, title, body, payload, dedupe_key
  )
  values (
    v_request.author_id,
    'file',
    'error',
    'normal',
    'x',
    'Push rejected',
    case when p_note is not null and length(trim(p_note)) > 0
      then format('"%s" was rejected — %s', v_request.title, p_note)
      else format('"%s" was rejected by an admin.', v_request.title)
    end,
    jsonb_build_object(
      'change_request_id', v_request.id,
      'project_id', v_request.project_id,
      'note', p_note
    ),
    format('cr-rejected:%s', v_request.id)
  )
  on conflict (user_id, dedupe_key) do nothing;
end;
$$;

revoke execute on function public.reject_change_request(uuid, text) from public, anon;
grant  execute on function public.reject_change_request(uuid, text) to authenticated;

-- ── Trigger: notify admins when a member submits a request ──────────
-- AFTER INSERT trigger fans out a notification to every admin
-- (project_role owner or admin) of the project. SECURITY DEFINER on
-- the function so it can write to notifications without tripping the
-- author-pins-uid RLS.
create or replace function public._notify_admins_of_change_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin record;
  v_project public.projects%rowtype;
  v_author_name text;
begin
  -- Only fire on initial open submissions, not on later status flips.
  if new.status <> 'open' then
    return new;
  end if;
  select * into v_project from public.projects where id = new.project_id;
  -- Cheap human-readable author label for the toast body. We avoid
  -- pulling from auth.users (no SELECT grant) so this stays minimal.
  v_author_name := 'A member';
  for v_admin in
    select pm.user_id
      from public.project_members pm
      where pm.project_id = new.project_id
        and pm.role in ('owner', 'admin')
        and pm.user_id <> new.author_id
  loop
    insert into public.notifications (
      user_id, category, variant, priority, icon, title, body, payload, dedupe_key
    )
    values (
      v_admin.user_id,
      'file',
      'info',
      'normal',
      'upload',
      'New change request',
      format('%s submitted "%s" in %s.', v_author_name, new.title, coalesce(v_project.name, 'a project')),
      jsonb_build_object(
        'change_request_id', new.id,
        'project_id', new.project_id,
        'author_id', new.author_id
      ),
      format('cr-submitted:%s', new.id)
    )
    on conflict (user_id, dedupe_key) do nothing;
  end loop;
  return new;
end;
$$;

revoke execute on function public._notify_admins_of_change_request() from public, anon, authenticated;

drop trigger if exists notify_admins_of_change_request on public.change_requests;
create trigger notify_admins_of_change_request
  after insert on public.change_requests
  for each row execute function public._notify_admins_of_change_request();
