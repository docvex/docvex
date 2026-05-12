-- Loosen projects.created_by FK so auth.users deletion doesn't error out
-- with a 23503 (foreign_key_violation). The original 001_projects.sql
-- migration declared this column as nullable + "set null on user delete"
-- in comments, but the actual constraint was RESTRICT, which blocks the
-- self-service delete-user Edge Function. SET NULL matches the intent:
-- deleting a user leaves the project alive but with no creator reference.
--
-- The project_members CASCADE already removes the user's owner row, so a
-- solo-owner project becomes truly orphaned (no creator, no members) —
-- documented v1 limitation, addressed by a future "transfer ownership"
-- feature.
alter table public.projects
  drop constraint projects_created_by_fkey;

alter table public.projects
  add constraint projects_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;
