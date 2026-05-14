-- 004_project_files_thumbnail_path.sql — Add a sibling-object pointer for
-- preview thumbnails. Generated client-side at upload time for images,
-- PDFs (first page), and videos (poster frame); uploaded to the same
-- bucket at `{project_id}/{file_id}/_thumb.jpg`. NULL means no thumbnail
-- exists (text uploads, generation failure, or files uploaded before
-- this migration landed) — the renderer falls back to a MIME-keyed
-- glyph in that case.
--
-- Nullable on purpose. Existing rows stay NULL forever (no backfill —
-- the source binary is in storage but we don't run server-side
-- thumbnailing). New uploads populate it whenever generation succeeds.
alter table public.project_files
  add column thumbnail_path text;
