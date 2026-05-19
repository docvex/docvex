-- 023_reject_change_request_item.sql
-- Per-item reject. Lets an admin decline a single file's edit without
-- nuking sibling items in the same change_request.
--
-- New requests are already 1:1 with files (see migration 022 + the
-- commitFlow.js rewrite), but legacy bundled requests still exist in
-- production data — and a future "merge same-file pushes into the
-- existing open request" optimisation could re-bundle anyway. With
-- this RPC, per-file rejection is authoritative regardless of how
-- the parent request was assembled.
--
-- Behaviour:
--   • Locks the target item + its parent request (FOR UPDATE) so a
--     concurrent approve / second reject can't half-apply.
--   • Verifies the caller has admin on the parent project (same gate
--     reject_change_request uses).
--   • Verifies the parent request is still 'open'; rejects on closed
--     requests would be nonsensical and silently lossy.
--   • Deletes the single change_request_items row.
--   • Counts surviving items on the parent request:
--       - 0 left → flip the request to 'rejected' with decided_at /
--                  decided_by / decision_note, mirroring the old
--                  request-level reject path. The author's
--                  notification fires once for the whole request.
--       - ≥1 left → leave the request 'open'. Surviving items stay
--                   visible to admins as if nothing happened.
--   • Returns the parent request_id + a flag the client uses to drive
--     "should I re-fetch the request list?" decisions.

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
    return query select v_request.id, true;
  else
    return query select v_request.id, false;
  end if;
end;
$$;

revoke execute on function public.reject_change_request_item(uuid, text) from public, anon;
grant  execute on function public.reject_change_request_item(uuid, text) to authenticated;
