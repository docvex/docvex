-- 044_newsletter_optin_and_sweeps.sql
--
-- 1. The website newsletter becomes double opt-in (Legea 506/2004 art. 12,
--    GDPR art. 7(1)): the `newsletter` Edge Function writes a PENDING row and
--    emails a confirmation link; only a confirmed row may ever be sent to.
--    Each row keeps the consent text, where it was given and when — the
--    record of consent. Service role only (RLS on, no policies).
-- 2. Retention: unconfirmed sign-ups are deleted after 7 days; newsletter
--    rows written into `enrollments` by the old footer form (never confirmed)
--    are deleted now and no longer written.
-- 3. The phone-upload bucket is swept hourly by the `phone-upload` function's
--    `sweep` action (pg_net), so files nobody collected don't wait for the
--    owner's next upload session.

create table if not exists public.newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  status text not null default 'pending' check (status in ('pending', 'confirmed')),
  confirm_hash text,
  unsubscribe_token text not null unique,
  consent_text text not null,
  consent_source text not null default 'website',
  requested_at timestamptz not null default now(),
  confirmed_at timestamptz,
  last_sent_at timestamptz
);
create index if not exists newsletter_subscribers_confirm_hash_idx on public.newsletter_subscribers (confirm_hash);
alter table public.newsletter_subscribers enable row level security;
revoke all on public.newsletter_subscribers from anon, authenticated;

-- Old, unconfirmed newsletter sign-ups: no proof of consent, so they go.
delete from public.enrollments
 where type = 'newsletter' or message = '[newsletter subscription]';

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

  return r;
end;
$$;
revoke all on function public.run_retention_cleanup() from public, anon, authenticated;

-- Hourly sweep of lapsed phone uploads (the function deletes only data whose
-- session ended a day ago, so it needs no credentials beyond the anon key).
create extension if not exists pg_net;
select cron.schedule(
  'docvex-phone-upload-sweep',
  '41 * * * *',
  $$select net.http_post(
      url := 'https://pntxlvhkqfryyyxlqytr.supabase.co/functions/v1/phone-upload',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{"action": "sweep"}'::jsonb
    )$$
);
