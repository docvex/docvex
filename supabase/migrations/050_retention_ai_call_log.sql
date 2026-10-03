-- 050: the AI rate-limit log expires on its own (security audit 2026-10-01).
--
-- ai_call_log (049) promised "kept two days", but old rows were only pruned
-- when that same user made another call — a user who stopped (or deleted the
-- account; the table has no foreign key) kept theirs for good. The nightly
-- retention job now removes every row older than two days. The rest of the
-- function is 044's, unchanged.

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

  delete from public.newsletter_subscribers
   where status = 'pending' and requested_at < now() - interval '7 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('newsletter_pending', n);

  delete from public.project_invitations
   where (accepted_at is not null and accepted_at < now() - interval '90 days')
      or (accepted_at is null and expires_at < now() - interval '90 days');
  get diagnostics n = row_count; r := r || jsonb_build_object('invitations', n);

  delete from public.phone_upload_sessions where expires_at < now() - interval '30 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('phone_upload_sessions', n);

  delete from public.project_ai_usage where created_at < now() - interval '24 months';
  get diagnostics n = row_count; r := r || jsonb_build_object('project_ai_usage', n);

  delete from public.chat_messages m
   where m.deleted_at is not null and m.deleted_at < now() - interval '30 days'
     and not exists (select 1 from public.chat_messages c where c.parent_id = m.id and c.deleted_at is null);
  get diagnostics n = row_count; r := r || jsonb_build_object('chat_messages', n);

  delete from public.private_messages where deleted_at is not null and deleted_at < now() - interval '30 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('private_messages', n);

  delete from public.mail_oauth_states where created_at < now() - interval '1 day';
  get diagnostics n = row_count; r := r || jsonb_build_object('mail_oauth_states', n);

  delete from public.ai_call_log where at < now() - interval '2 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('ai_call_log', n);

  return r;
end;
$$;
revoke all on function public.run_retention_cleanup() from public, anon, authenticated;
