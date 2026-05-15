-- ── project_files.thumbnail_frames ────────────────────────────────────────
-- Adds an ordered list of frame paths for video files. Populated by the
-- upload pipeline when a video uploads successfully and >=2 frames could
-- be extracted; NULL otherwise. The renderer cycles through the array as
-- a hover slideshow; legacy rows (NULL) keep falling back to the single
-- thumbnail_path render path.
--
-- thumbnail_path is still set to thumbnail_frames[0] for new video uploads
-- so existing code paths that read thumbnail_path keep working unchanged.

alter table public.project_files
  add column if not exists thumbnail_frames text[];

comment on column public.project_files.thumbnail_frames is
  '5-frame video slideshow paths (ordered). NULL for non-video or legacy '
  'rows; renderer falls back to thumbnail_path in that case.';
