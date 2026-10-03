-- Regenerates the policy part of supabase/schema/live_security_snapshot.sql.
-- Run in the Supabase SQL editor (or via the MCP execute_sql tool) and paste
-- the single result value under "Part 2". Review the diff before committing:
-- a policy that changed in production without a migration shows up here.
select string_agg(
  format('create policy %I on %I.%I as %s for %s to %s%s%s;',
    policyname, schemaname, tablename, permissive, cmd, array_to_string(roles, ', '),
    coalesce(E'\n  using (' || qual || ')', ''),
    coalesce(E'\n  with check (' || with_check || ')', '')),
  E'\n\n' order by schemaname, tablename, policyname) as sql
from pg_policies
where schemaname in ('public', 'storage');

-- Functions in public with no migration file: compare this list with
-- `grep -r "function public.<name>" supabase/migrations`.
select p.proname, p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by 1;
