-- 026_reject_item_notify_author.sql
-- Notify the author when one of their files is rejected.
--
-- reject_change_request_item (migration 023) declined a single file's
-- edit but never actually inserted a notification — the comment claimed
-- "the author's notification fires once for the whole request", but no
-- INSERT existed. This recreates the function identically and adds a
-- per-file notification to the item's author, mirroring the body shape
-- reject_change_request uses (migration 014).
--
-- Notes:
--   • Fires per rejected ITEM (i.e. per file) — the natural granularity
--     now that requests are 1:1 with files. Legacy bundled requests get
--     one notification per item rejected.
--   • The filename comes from the item's proposed snapshot, falling back
--     to the canonical project_files name (for target-based edits) and
--     finally a generic label.
--   • Skips notifying when the author is the admin doing the rejecting
--     (single-admin self-review): telling yourself you rejected your own
--     file is pure noise.
--   • dedupe_key keys on the item id so a retried RPC can't double-post.

create or replace function public.reject_change_request_item(
  p_item_id uuid,
  p_note text default null
)
returns table (request_id uuid, request_emptied boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.change_request_items%rowtype;
  v_request public.change_requests%rowtype;
  v_caller uuid;
  v_remaining int;
  v_filename text;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Not authenticated';
  end if;

  -- Every column reference is table-qualified (cri / cr aliases) so
  -- it can't collide with the RETURNS TABLE output column named
  -- `request_id`. Without the aliases Postgres raises
  -- `column reference "request_id" is ambiguous` at runtime when the
  -- function body touches change_request_items.request_id.
  select * into v_item
    from public.change_request_items cri
    where cri.id = p_item_id
    for update;
  if not found then
    raise exception 'Item not found';
  end if;

  select * into v_request
    from public.change_requests cr
    where cr.id = v_item.request_id
    for update;
  if not found then
    raise exception 'Parent request not found';
  end if;
  if v_request.status <> 'open' then
    raise exception 'Request is not open (status = %)', v_request.status;
  end if;
  if not public.has_project_role(v_request.project_id, 'admin') then
    raise exception 'Not authorized';
  end if;

  delete from public.change_request_items cri where cri.id = p_item_id;

  select count(*) into v_remaining
    from public.change_request_items cri
    where cri.request_id = v_request.id;

  if v_remaining = 0 then
    update public.change_requests cr
      set status = 'rejected',
          decided_at = now(),
          decided_by = v_caller,
          decision_note = p_note
      where cr.id = v_request.id;
  end if;

  -- Notify the file's author (the parent request's author). The item
  -- row was captured into v_item above, so its proposed snapshot is
  -- still available after the delete.
  if v_request.author_id is not null and v_request.author_id <> v_caller then
    v_filename := coalesce(
      nullif(trim(v_item.proposed->>'name'), ''),
      (select pf.name from public.project_files pf where pf.id = v_item.target_file_id),
      'Your file'
    );

    insert into public.notifications (
      user_id, category, variant, priority, icon, title, body, payload, dedupe_key
    )
    values (
      v_request.author_id,
      'file',
      'error',
      'normal',
      'x',
      'File rejected',
      case when p_note is not null and length(trim(p_note)) > 0
        then format('"%s" was rejected — %s', v_filename, p_note)
        else format('"%s" was rejected by an admin.', v_filename)
      end,
      jsonb_build_object(
        'change_request_id', v_request.id,
        'project_id', v_request.project_id,
        'item_id', v_item.id,
        'file', v_filename,
        'note', p_note
      ),
      format('cri-rejected:%s', v_item.id)
    )
    on conflict (user_id, dedupe_key) do nothing;
  end if;

  if v_remaining = 0 then
    return query select v_request.id, true;
  else
    return query select v_request.id, false;
  end if;
end;
$$;

revoke execute on function public.reject_change_request_item(uuid, text) from public, anon;
grant  execute on function public.reject_change_request_item(uuid, text) to authenticated;
