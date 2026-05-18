-- 017_change_requests_visible_to_members.sql
-- Broaden SELECT visibility on change_requests + change_request_items
-- so any project member can see every commit in the project, not just
-- their own.
--
-- Why: the Version control tab on the Project Dashboard renders a
-- compose-release view that aggregates every team member's proposed
-- changes side-by-side. That's only useful if members can see each
-- other's work — under the old RLS (author OR admin), a member testing
-- the app would see 1 of N open commits while the owner saw all N,
-- and the compose view's "files with changes" list was incomplete.
--
-- Scope:
--   • SELECT: widened to any project MEMBER (member/admin/owner via
--     the role hierarchy). Viewers (the read-only role) stay
--     restricted — collaboration history is for collaborators.
--   • INSERT / UPDATE / DELETE: unchanged. Only the author can
--     submit / withdraw their own request; only admins can decide
--     someone else's. Read access doesn't imply write access.
--   • change_request_items SELECT mirrors the parent request's
--     SELECT scope so the items show up wherever the request shows.

drop policy if exists "author or admin read change requests" on public.change_requests;

create policy "members read project change requests"
  on public.change_requests for select
  using (public.has_project_role(project_id, 'member'));

drop policy if exists "read items if parent readable" on public.change_request_items;

create policy "read items if parent readable"
  on public.change_request_items for select
  using (exists (
    select 1 from public.change_requests cr
    where cr.id = change_request_items.request_id
      and public.has_project_role(cr.project_id, 'member')
  ));
