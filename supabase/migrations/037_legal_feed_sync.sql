-- Legal Newsfeed — a real source.
--
-- Until now `legal_updates` held only the hand-written sample feed seeded by
-- migration 029, and nothing ever added to it: the `legal-ai` ingest action
-- existed but had no caller. This migration gives the feed its source.
--
-- The `legal-feed-sync` Edge Function reads the newest acts from the Ministry
-- of Justice's free web service (legislatie.just.ro — the same service the
-- app's Legislation tab reads), throws out the ones that concern nobody (a
-- citizenship decree, a rectification), asks a small model which of the rest
-- matter to a law firm's clients, and writes a summarised `legal_updates` row
-- for each of those. pg_cron runs it every few hours.
--
-- Three pieces (plus a small state table, legal_feed_state):
--   1. Columns on `legal_updates` tying a row to the act it is about, so the
--      Newsletter can open the act itself (in the Legislation tab, or on the
--      portal) instead of offering a "Read full update" that went nowhere.
--   2. `legal_feed_acts` — every act the job has looked at, relevant or not,
--      with the verdict. Each run re-reads the last few Monitorul Oficial
--      issues (the portal sometimes indexes one late); this table is what
--      makes that cheap (an act is judged, and paid for, once) and what makes
--      the job's decisions auditable ("why is X not in the feed?").
--   3. The schedule — pg_cron + pg_net calling the function with a secret
--      generated here and kept in Vault. Nothing has to be typed into the
--      dashboard for it: the function checks the header against the same
--      Vault secret (legal_feed_sync_check below).

-- ── 1. legal_updates ↔ the act ──────────────────────────────────────────
alter table public.legal_updates
  add column if not exists portal_id    text,
  add column if not exists act_type     text,
  add column if not exists act_number   text,
  add column if not exists act_year     text,
  add column if not exists source_url   text,
  -- Where the row came from. 'portal' = written by legal-feed-sync from an
  -- act published in Monitorul Oficial; 'manual' = everything else (the 029
  -- sample rows, a hand-run ingest).
  add column if not exists origin       text not null default 'manual'
                                          check (origin in ('portal', 'manual'));

create unique index if not exists legal_updates_portal_id_key
  on public.legal_updates (portal_id) where portal_id is not null;

-- ── 2. What the job has looked at ───────────────────────────────────────
create table if not exists public.legal_feed_acts (
  portal_id     text primary key,              -- legislatie.just.ro DetaliiDocument id
  act_type      text not null,
  act_number    text,
  title         text not null,
  issuer        text,
  mo_ref        text,                          -- "Monitorul Oficial nr. 803 din 22 septembrie 2026"
  mo_date       date,
  in_force      date,
  link          text,
  -- skipped  = dropped by the free rules (type/shape), never shown to a model
  -- rejected = the model judged it irrelevant to the firm's clients
  -- relevant = judged relevant, waiting to be summarised
  -- ingested = summarised into legal_updates
  -- failed   = summarising failed; retried on later runs (attempts < 3)
  status        text not null
                  check (status in ('skipped', 'rejected', 'relevant', 'ingested', 'failed')),
  category      text,
  reason        text,                          -- one line: why it was kept or dropped
  attempts      int not null default 0,
  error         text,
  first_seen_at timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists legal_feed_acts_status_idx
  on public.legal_feed_acts (status, first_seen_at desc);

-- Service role only: the job writes it, an operator reads it. No client
-- policies at all, so RLS denies every signed-in user.
alter table public.legal_feed_acts enable row level security;

-- Small key/value memory between runs: the last Monitorul Oficial issue found
-- (`mo_issue:<year>`), where the next run starts walking, and the last run's
-- report (`last_run`).
create table if not exists public.legal_feed_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.legal_feed_state enable row level security;

-- ── 3. The schedule ─────────────────────────────────────────────────────
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- The shared secret between the cron job and the function, generated here so
-- it never appears in the repo or in a dashboard.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'legal_feed_sync_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'legal_feed_sync_secret',
      'Header secret between pg_cron and the legal-feed-sync Edge Function'
    );
  end if;
end $$;

-- The function asks the database whether the header it was sent is right.
-- SECURITY DEFINER so it can read Vault; callable by the service role only.
create or replace function public.legal_feed_sync_check(p_secret text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'legal_feed_sync_secret'
      and decrypted_secret = p_secret
      and length(coalesce(p_secret, '')) >= 32
  );
$$;
revoke all on function public.legal_feed_sync_check(text) from public, anon, authenticated;
grant execute on function public.legal_feed_sync_check(text) to service_role;

-- Every 3 hours, at minute 17 (off the hour, when everyone else's cron runs).
-- Monitorul Oficial publishes through the working day, so this puts an act in
-- the feed within a few hours of it being published.
select cron.unschedule('legal-feed-sync')
where exists (select 1 from cron.job where jobname = 'legal-feed-sync');

select cron.schedule(
  'legal-feed-sync',
  '17 */3 * * *',
  $cron$
  select net.http_post(
    url     := 'https://pntxlvhkqfryyyxlqytr.supabase.co/functions/v1/legal-feed-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'legal_feed_sync_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $cron$
);
