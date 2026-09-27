-- ── Upload from a phone through the cloud: the same behaviour as Wi-Fi ───────
-- (migration 040 made the route.) Three things the Wi-Fi route does that the
-- cloud one could not:
--
--   1. The SAME address every time — a session is kept (7 days, sliding) and
--      REOPENED when the Import window opens again (`phone-upload` `create`
--      with the kept token); closing the window only pauses it (closed_at).
--   2. Every file WAITS for approval on the computer, and the phone is told
--      what became of it — `status` here, written by the owner's desktop when
--      the file is imported or rejected, read by the phone through the
--      function's `status` action.
--   3. So a row now OUTLIVES the hand-off: the object is still deleted from the
--      bucket the moment the desktop has it (`taken_at`), but the row stays to
--      carry the decision. Rows go with their session (the function's
--      housekeeping removes sessions a day past their end).

alter table public.phone_upload_files
  add column if not exists status text not null default 'waiting',
  add column if not exists taken_at timestamptz,
  add column if not exists decided_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'phone_upload_files_status_chk') then
    alter table public.phone_upload_files
      add constraint phone_upload_files_status_chk check (status in ('waiting', 'accepted', 'rejected'));
  end if;
end $$;

-- The owner's desktop marks a file taken and records the decision.
drop policy if exists "phone upload: owner updates files" on public.phone_upload_files;
create policy "phone upload: owner updates files"
  on public.phone_upload_files for update to authenticated
  using (exists (select 1 from public.phone_upload_sessions s where s.id = session_id and s.user_id = auth.uid()))
  with check (exists (select 1 from public.phone_upload_sessions s where s.id = session_id and s.user_id = auth.uid()));
