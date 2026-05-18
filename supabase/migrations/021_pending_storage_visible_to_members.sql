-- 021_pending_storage_visible_to_members.sql
-- Broaden SELECT on the projects-pending storage bucket so every
-- project member can read pending bytes + thumbnails — not just the
-- uploader and admins.
--
-- Why: migration 017 widened change_requests + change_request_items
-- SELECT to all project members so the Version control tab can list
-- everyone's proposed edits. But the storage RLS from migration 012
-- still restricted pending-bucket reads to the uploader OR admins,
-- so non-admin members loading the compose view get a 400 from
-- createSignedUrl when CrThumb tries to fetch another member's
-- pending bytes / thumbnail (e.g. for DOCX rich regen, or the
-- bytes-fallback thumbnail path).
--
-- Scope:
--   • SELECT: widened to any project MEMBER. Mirrors the 017 scope
--     on the parent change_request_items rows.
--   • INSERT: unchanged — only the uploader (path segment 2 =
--     auth.uid()) and a member+ on the project can write.
--   • DELETE: unchanged — uploader OR admin only. Read access
--     doesn't imply ability to mop up someone else's pending bytes.

drop policy if exists "uploader or admin read pending" on storage.objects;

create policy "members read pending"
  on storage.objects for select
  using (
    bucket_id = 'projects-pending'
    and public.has_project_role(
      (string_to_array(name, '/'))[1]::uuid,
      'member'
    )
  );
