-- 012_branches_and_change_requests.sql
-- Git-like collaboration on top of project_files.
--
-- MAIN BRANCH = the existing public.project_files table (canonical
-- state every member views by default).
-- MEMBER BRANCH = lazy-materialized per (project, member). The member
-- queues add/edit/delete/replace edits as `branch_changes` rows; the
-- UI overlays those on top of main to render "their" branch.
-- COMMIT/PUSH = bundles the queued branch_changes into an immutable
-- `change_request` (with `change_request_items` snapshotting each
-- queued edit at submit time). The request goes to admin review.
-- APPROVE merges the items into project_files and bumps a project-
-- level `main_version` counter — every other member's branch now
-- shows a "Sync to main" prompt because their `base_version` is
-- behind. REJECT closes the request (member can revise + resubmit).
-- WITHDRAW lets the author cancel an open request.
--
-- One open request per (project, member) at a time. Keeps the model
-- simple: while a request is in review the member's branch_changes
-- table is empty (they were snapshotted and cleared on push). The
-- member can keep editing — those new edits accumulate for their
-- NEXT request.
--
-- Storage layout for pending uploads:
--   bucket: `projects-pending`   (separate from `projects` so the
--                                  existing storage RLS — which casts
--                                  the first path segment to uuid —
--                                  doesn't choke on a 'pending/' prefix)
--   path:   {project_id}/{user_id}/{change_id}/{filename}

-- ── Main-branch version cursor ────────────────────────────────────────
-- Bumped by +1 every time an approved change request is merged. Members
-- compare against their own branch.base_version to decide whether to
-- surface the "Sync to main" affordance.
alter table public.projects
  add column main_version bigint not null default 0;

-- ── Member branch state (lazy-materialized) ───────────────────────────
-- Implicit per (project, member). Row gets created on first edit OR
-- sync. `base_version` tracks the projects.main_version the member
-- last pulled from; when projects.main_version > branch.base_version
-- the UI shows the Sync button.
create table public.project_member_branches (
  project_id    uuid not null references public.projects(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  base_version  bigint not null default 0,
  created_at    timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- Index for project-wide queries ("which members are behind main?").
-- Composite PK already covers (project_id, user_id) lookups.
create index project_member_branches_project_idx
  on public.project_member_branches (project_id);

-- ── Uncommitted edits on a member's branch ────────────────────────────
-- Each row is one queued operation. Ordered by created_at for stable
-- display. Cleared en masse when the member pushes (snapshots move
-- into change_request_items).
create table public.branch_changes (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  kind           text not null check (kind in ('add','edit','delete','replace')),
  -- add:     null
  -- edit/delete/replace: the existing project_files row this targets.
  -- on delete cascade so a main-branch delete that removes the file
  -- automatically clears moot pending changes too (member's "edit
  -- file X" disappears if file X no longer exists on main).
  target_file_id uuid references public.project_files(id) on delete cascade,
  -- Shape by kind:
  --   add:     { name, description, mime_type, size_bytes, pending_storage_path,
  --              thumbnail_pending_path?, thumbnail_frames_pending?, duration_seconds? }
  --   replace: same as add, with target_file_id set
  --   edit:    { name?, description? }   (only the changed fields)
  --   delete:  null
  proposed       jsonb,
  created_at     timestamptz not null default now()
);

create index branch_changes_user_idx
  on public.branch_changes (project_id, user_id, created_at);

-- ── Change requests (commits awaiting review) ─────────────────────────
create table public.change_requests (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  author_id      uuid not null references auth.users(id) on delete cascade,
  title          text not null check (length(trim(title)) > 0),
  description    text,
  status         text not null default 'open'
                   check (status in ('open','approved','rejected','withdrawn')),
  submitted_at   timestamptz not null default now(),
  decided_at     timestamptz,
  decided_by     uuid references auth.users(id) on delete set null,
  decision_note  text
);

create index change_requests_project_status_idx
  on public.change_requests (project_id, status, submitted_at desc);

-- One open request per author per project. Partial unique index
-- (filters on status='open') enforces the "one in flight at a time"
-- invariant without blocking historical rows.
create unique index change_requests_one_open_per_author
  on public.change_requests (project_id, author_id)
  where status = 'open';

-- ── Immutable item snapshots ──────────────────────────────────────────
-- Captured at submit time. No FK on target_file_id — the admin may
-- have deleted the original on main between submit and review; the
-- snapshot needs to remain readable for audit even after the target
-- is gone.
create table public.change_request_items (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references public.change_requests(id) on delete cascade,
  kind           text not null check (kind in ('add','edit','delete','replace')),
  target_file_id uuid,
  proposed       jsonb,
  seq            int not null
);

create index change_request_items_request_idx
  on public.change_request_items (request_id, seq);

-- ── RLS ───────────────────────────────────────────────────────────────

alter table public.project_member_branches enable row level security;
alter table public.branch_changes          enable row level security;
alter table public.change_requests         enable row level security;
alter table public.change_request_items    enable row level security;

-- Branch state: members read their own row; admins read every row
-- in their project (so an admin dashboard can show "N members behind
-- main"). Inserts/updates only by the owning member.
create policy "members read own branch state"
  on public.project_member_branches for select
  using (
    user_id = (select auth.uid())
    or public.has_project_role(project_id, 'admin')
  );

create policy "member inserts own branch state"
  on public.project_member_branches for insert
  with check (
    user_id = (select auth.uid())
    and public.has_project_role(project_id, 'member')
  );

create policy "member updates own branch state"
  on public.project_member_branches for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Branch changes: strictly the owner. Admins see them only via the
-- change_request_items snapshots after submit — keeps work-in-progress
-- private.
create policy "member manages own branch changes"
  on public.branch_changes for all
  using (
    user_id = (select auth.uid())
    and public.has_project_role(project_id, 'member')
  )
  with check (
    user_id = (select auth.uid())
    and public.has_project_role(project_id, 'member')
  );

-- Change requests:
--   SELECT: author + project admins.
--   INSERT: author only, member+ on the project.
--   UPDATE: author can flip status to 'withdrawn'; admin can flip to
--           approved/rejected. The trigger-less approach uses two
--           policy `with check` branches that allow only those
--           transitions.
create policy "author or admin read change requests"
  on public.change_requests for select
  using (
    author_id = (select auth.uid())
    or public.has_project_role(project_id, 'admin')
  );

create policy "author inserts own change request"
  on public.change_requests for insert
  with check (
    author_id = (select auth.uid())
    and public.has_project_role(project_id, 'member')
  );

create policy "author withdraws or admin decides"
  on public.change_requests for update
  using (
    (author_id = (select auth.uid()) and status = 'open')
    or public.has_project_role(project_id, 'admin')
  )
  with check (
    (author_id = (select auth.uid()) and status in ('open','withdrawn'))
    or public.has_project_role(project_id, 'admin')
  );

-- Change request items:
--   SELECT: same audience as the parent request.
--   INSERT: by the author, only into their own open request (used
--           at submit time when the lib bulk-inserts the snapshots).
--   No UPDATE/DELETE policies — items are immutable. Cascade delete
--   handles cleanup when the parent request is removed.
create policy "read items if parent readable"
  on public.change_request_items for select
  using (exists (
    select 1 from public.change_requests cr
    where cr.id = change_request_items.request_id
      and (
        cr.author_id = (select auth.uid())
        or public.has_project_role(cr.project_id, 'admin')
      )
  ));

create policy "author inserts items into own open request"
  on public.change_request_items for insert
  with check (exists (
    select 1 from public.change_requests cr
    where cr.id = change_request_items.request_id
      and cr.author_id = (select auth.uid())
      and cr.status = 'open'
      and public.has_project_role(cr.project_id, 'member')
  ));

-- ── Storage bucket for pending uploads ────────────────────────────────
-- Separate from the canonical `projects` bucket so we don't have to
-- contort the existing storage RLS (which casts the first path segment
-- to uuid — incompatible with a string-prefixed 'pending/' path).
insert into storage.buckets (id, name, public)
  values ('projects-pending', 'projects-pending', false)
  on conflict (id) do nothing;

-- Path: {project_id}/{user_id}/{change_id}/{filename}
-- The two-uuid leading prefix lets storage RLS independently verify
-- the project (cast segment 1) AND the uploader (compare segment 2).

create policy "uploader or admin read pending"
  on storage.objects for select
  using (
    bucket_id = 'projects-pending'
    and (
      (string_to_array(name, '/'))[2] = (select auth.uid())::text
      or public.has_project_role(
        (string_to_array(name, '/'))[1]::uuid,
        'admin'
      )
    )
  );

create policy "member inserts own pending"
  on storage.objects for insert
  with check (
    bucket_id = 'projects-pending'
    and (string_to_array(name, '/'))[2] = (select auth.uid())::text
    and public.has_project_role(
      (string_to_array(name, '/'))[1]::uuid,
      'member'
    )
  );

create policy "uploader or admin delete pending"
  on storage.objects for delete
  using (
    bucket_id = 'projects-pending'
    and (
      (string_to_array(name, '/'))[2] = (select auth.uid())::text
      or public.has_project_role(
        (string_to_array(name, '/'))[1]::uuid,
        'admin'
      )
    )
  );

-- ── Realtime publication ──────────────────────────────────────────────
-- branch_changes: drives the live overlay badges in the member's UI
--                 (multi-device users see their queue stay in sync).
-- change_requests: notifies admins of new submissions + authors of
--                  decisions in real time.
-- project_member_branches: needed so a member's other open sessions
--                          see base_version bumps after they sync.
-- change_request_items: snapshots are immutable; no realtime needed.
alter publication supabase_realtime add table public.project_member_branches;
alter publication supabase_realtime add table public.branch_changes;
alter publication supabase_realtime add table public.change_requests;
