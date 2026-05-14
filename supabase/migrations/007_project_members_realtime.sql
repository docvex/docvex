-- 007_project_members_realtime.sql — Wire `project_members` into Supabase
-- Realtime so member additions, role changes and removals propagate live
-- to every client viewing the project.
--
-- Two things happen here:
--
-- 1. Add the table to the supabase_realtime publication so the realtime
--    server forwards row-level events for it at all. Without this, the
--    subscription set up in src/context/ProjectContext.jsx (the
--    `project_members` postgres_changes handler) connects fine but never
--    receives any events — the publication is the gate.
--
-- 2. Set REPLICA IDENTITY FULL so DELETE events include every old column
--    value in the WAL (not just the primary key). The channel's filter
--    `project_id=eq.${projectId}` is evaluated against OLD for deletes;
--    by default Postgres only writes the PK to OLD, which means the
--    filter rejects every DELETE event and the kick-member feature (or
--    any cross-device removal) would silently never reach subscribers.
--    Same fix as migration 006 applied to project_files.
--
-- Cost: a few extra bytes per UPDATE/DELETE WAL record on a narrow
-- table. Negligible at this table's expected change rate.

alter publication supabase_realtime add table public.project_members;
alter table public.project_members replica identity full;
