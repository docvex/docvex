-- 015_author_manages_open_request_items.sql
-- Loosens the change_request_items RLS so the author can mutate
-- items inside their own OPEN change request. Needed for the
-- merge-into-existing-open-request flow: when a member pushes a
-- second commit while their first is still under review, the lib
-- should fold the new items into the existing request rather than
-- spawn a duplicate (which would 23505 on
-- `change_requests_one_open_per_author`).
--
-- Restricted to:
--   • Author of the parent request
--   • Status = 'open'
-- Admins continue to have no direct write access to items — they
-- approve/reject via the SECURITY DEFINER RPCs only.

create policy "author updates own open request items"
  on public.change_request_items for update
  using (exists (
    select 1 from public.change_requests cr
    where cr.id = change_request_items.request_id
      and cr.author_id = (select auth.uid())
      and cr.status = 'open'
  ))
  with check (exists (
    select 1 from public.change_requests cr
    where cr.id = change_request_items.request_id
      and cr.author_id = (select auth.uid())
      and cr.status = 'open'
  ));

create policy "author deletes own open request items"
  on public.change_request_items for delete
  using (exists (
    select 1 from public.change_requests cr
    where cr.id = change_request_items.request_id
      and cr.author_id = (select auth.uid())
      and cr.status = 'open'
  ));
