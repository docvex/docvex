-- ── project_files.duration_seconds ───────────────────────────────────────
-- Video runtime captured at upload time so the Files grid + upload modal
-- can render a duration badge on video cards without re-fetching the
-- binary to read metadata. The uploader extracts the duration via a
-- hidden <video> element's `loadedmetadata` event in parallel with the
-- thumbnail-frame extraction it already runs.
--
-- NULL for non-video files and for video rows uploaded before this
-- migration — those legacy rows simply skip the badge in the UI.

alter table public.project_files
  add column if not exists duration_seconds real;

comment on column public.project_files.duration_seconds is
  'Video runtime in seconds (4-byte float). NULL for non-video files and '
  'for video rows uploaded before migration 011.';
