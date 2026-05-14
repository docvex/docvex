-- 006_project_files_replica_identity_full.sql — Make Realtime DELETE
-- events on project_files actually reach subscribed clients.
--
-- Background: src/lib/projectFiles.js#subscribeForProject sets a
-- postgres_changes filter `project_id=eq.${projectId}` on its channel.
-- Supabase Realtime evaluates that filter against the OLD row for
-- DELETE events. By default Postgres only writes the primary key into
-- the WAL's OLD payload (the implicit `REPLICA IDENTITY DEFAULT` uses
-- the PK), so `project_id` is missing from OLD and the filter rejects
-- every DELETE event before it leaves the realtime server. INSERT and
-- UPDATE work because the filter is checked against NEW, which has
-- every column.
--
-- Setting REPLICA IDENTITY FULL writes ALL old column values into the
-- WAL on UPDATE/DELETE, which makes the filter match and the DELETE
-- echo land on every subscribed client. The cost is a few extra bytes
-- per UPDATE/DELETE WAL record — negligible for a metadata table this
-- narrow.

alter table public.project_files replica identity full;
