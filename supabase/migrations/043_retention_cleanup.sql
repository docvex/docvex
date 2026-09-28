-- 043_retention_cleanup.sql
-- GDPR storage limitation (Art. 5(1)(e)): personal data is kept only as long
-- as it is needed. One function, run nightly by pg_cron, enforces the periods
-- stated in the privacy policy:
--   notifications ............................ 12 months
--   website sign-ups (enrollments) ........... 24 months
--   invitations accepted or expired .......... 90 days after that
--   phone-upload sessions (and file rows) .... 30 days after they lapsed
--   AI usage records ......................... 24 months
--   chat / private messages deleted by users . purged 30 days after deletion
--   mail OAuth handshake states .............. 1 day
-- Change a period here AND in landing/home/privacy.html §8.

create or replace function public.run_retention_cleanup()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb := '{}'::jsonb;
  n bigint;
begin
  delete from public.notifications where created_at < now() - interval '12 months';
  get diagnostics n = row_count; r := r || jsonb_build_object('notifications', n);

  delete from public.enrollments where created_at < now() - interval '24 months';
  get diagnostics n = row_count; r := r || jsonb_build_object('enrollments', n);

  delete from public.project_invitations
   where (accepted_at is not null and accepted_at < now() - interval '90 days')
      or (accepted_at is null and expires_at < now() - interval '90 days');
  get diagnostics n = row_count; r := r || jsonb_build_object('invitations', n);

  delete from public.phone_upload_sessions where expires_at < now() - interval '30 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('phone_upload_sessions', n);

  delete from public.project_ai_usage where created_at < now() - interval '24 months';
  get diagnostics n = row_count; r := r || jsonb_build_object('project_ai_usage', n);

  -- A deleted message that still has live replies is kept: removing it would
  -- cascade to the replies (chat_messages_parent_id_fkey is ON DELETE CASCADE).
  delete from public.chat_messages m
   where m.deleted_at is not null and m.deleted_at < now() - interval '30 days'
     and not exists (select 1 from public.chat_messages c where c.parent_id = m.id and c.deleted_at is null);
  get diagnostics n = row_count; r := r || jsonb_build_object('chat_messages', n);

  delete from public.private_messages where deleted_at is not null and deleted_at < now() - interval '30 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('private_messages', n);

  delete from public.mail_oauth_states where created_at < now() - interval '1 day';
  get diagnostics n = row_count; r := r || jsonb_build_object('mail_oauth_states', n);

  return r;
end;
$$;
revoke all on function public.run_retention_cleanup() from public, anon, authenticated;

select cron.schedule('docvex-retention-cleanup', '17 3 * * *', $$select public.run_retention_cleanup()$$);
