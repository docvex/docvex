-- 049: rate limit for the AI Edge Functions (security fix, 2026-10-01).
--
-- project-ai, doc-ai and legal-ai's digest count the caller's AI calls here
-- (supabase/functions/_shared/guard.ts, with the service-role key) before
-- every Claude call — the last minute and the last day, across every function
-- and edge isolate — refuse past the limits, and record the call. The log holds
-- no content: who, which function, when — kept two days.

set local lock_timeout = '5s';

create table if not exists public.ai_call_log (
  id bigserial primary key,
  -- No foreign key to auth.users: it would lock that table to create, and
  -- the rows expire after two days anyway.
  user_id uuid not null,
  fn text not null,
  at timestamptz not null default now()
);
create index if not exists ai_call_log_user_at on public.ai_call_log (user_id, at desc);

-- No client role may read or write it: only the Edge Functions' service role.
alter table public.ai_call_log enable row level security;
revoke all on table public.ai_call_log from public, anon, authenticated;
revoke all on sequence public.ai_call_log_id_seq from public, anon, authenticated;

-- ── Privilege cleanup (found while snapshotting the live rules, see
-- supabase/schema/live_security_snapshot.sql) ─────────────────────────────
-- The API roles held TRUNCATE, TRIGGER and REFERENCES on public tables.
-- PostgREST never issues them, but TRUNCATE in particular is NOT governed by
-- row-level security — a role holding it could empty a table outright through
-- any other path to the database. Nothing in the app needs any of the three.
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('revoke truncate, trigger, references on table public.%I from anon, authenticated', r.relname);
  end loop;
end $$;
