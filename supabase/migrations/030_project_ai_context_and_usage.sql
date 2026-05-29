-- Project AI — persistent per-project context + real AI usage tracking.
--
-- Backs the two panels on the Project Overview "AI" tab (ProjectOverview.jsx),
-- which were previously local-only state + static "Sample" numbers.
--
-- Two pieces:
--   1. projects.ai_context        — free-text instructions prepended to every
--      projects.ai_context_updated_at  AI request in the project. Lives on the
--                                   projects row (one per project). Writable by
--                                   admins only (the existing "admins update
--                                   projects" RLS policy already gates this);
--                                   readable by any member who can SELECT the
--                                   project row.
--   2. project_ai_usage           — one row per AI request emitted by a
--                                   project-scoped feature (Generate / Automate
--                                   / chat assistant / summarise / …). The AI
--                                   usage panel reads monthly aggregates from
--                                   this via get_project_ai_usage(). Nothing
--                                   emits events yet (those features are stubs),
--                                   so the panel reads zeros until a feature
--                                   logs its first request — which is the point:
--                                   the numbers are real, not placeholders.

-- 1. AI context store on projects.
alter table public.projects
  add column if not exists ai_context text,
  add column if not exists ai_context_updated_at timestamptz;

-- 2. Usage log.
create table if not exists public.project_ai_usage (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  -- Nullable so a usage row survives the actor leaving / being deleted; the
  -- aggregates are project-scoped, not per-user.
  user_id       uuid references auth.users(id) on delete set null,
  action        text not null default 'generate'
                  check (action in ('generate','automate','chat','summarize','digest','other')),
  model         text,
  input_tokens  integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  -- Groups several requests into one "session" for the Sessions metric.
  -- NULL falls back to counting the row's own id as a distinct session.
  session_id    uuid,
  created_at    timestamptz not null default now()
);

-- Covers the monthly aggregate query (project_id + created_at range).
create index if not exists project_ai_usage_project_created_idx
  on public.project_ai_usage (project_id, created_at desc);

alter table public.project_ai_usage enable row level security;

-- READ: any member of the project (viewer+). Usage is shared project context,
-- not personal, so it isn't gated to the actor who made the request.
create policy "project_ai_usage: members read"
  on public.project_ai_usage
  for select
  using (public.has_project_role(project_id, 'viewer'));

-- INSERT: a member may log their own usage rows for a project they belong to.
-- (Server-side emitters — Edge Functions — use the service role and bypass
-- RLS, so this policy only governs client-side logging.)
create policy "project_ai_usage: members insert own"
  on public.project_ai_usage
  for insert
  with check (user_id = (select auth.uid()) and public.has_project_role(project_id, 'viewer'));


-- Monthly aggregate behind the AI usage panel. SECURITY INVOKER so the table's
-- RLS select policy filters rows to projects the caller belongs to — a
-- non-member gets zero rows and therefore an all-zero summary (no leak, no
-- error). Aggregates over an empty set still return exactly one row.
--
-- p_since defaults to the start of the current calendar month so the panel's
-- "resets monthly" framing is accurate.
create or replace function public.get_project_ai_usage(
  p_project_id uuid,
  p_since      timestamptz default date_trunc('month', now())
)
returns table (
  requests      bigint,
  input_tokens  bigint,
  output_tokens bigint,
  sessions      bigint,
  last_used_at  timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*)::bigint,
    coalesce(sum(u.input_tokens), 0)::bigint,
    coalesce(sum(u.output_tokens), 0)::bigint,
    count(distinct coalesce(u.session_id, u.id))::bigint,
    max(u.created_at)
  from public.project_ai_usage u
  where u.project_id = p_project_id
    and u.created_at >= p_since;
$$;

grant execute on function public.get_project_ai_usage(uuid, timestamptz) to authenticated;
