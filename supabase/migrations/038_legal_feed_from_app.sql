-- Legal Newsfeed — the desktop app reads the portal, not the server.
--
-- Migration 037 scheduled `legal-feed-sync` to read legislatie.just.ro from
-- Supabase itself. It cannot: the portal geo-checks every caller (its nginx
-- stamps `X-Country` / `X-Block` on each answer) and drops every connection
-- from Supabase's eu-west-1 region, even for its public home page, while the
-- same requests from a Romanian connection succeed. So the DESKTOP APP walks
-- the new Monitorul Oficial issues over the user's own connection
-- (lib/legalFeedSync.js, app admins only) and submits the records; the
-- function keeps the judging and the summaries.
--
-- Which leaves the schedule and its shared secret with nothing to do, and
-- needs one thing the old design didn't: an act judged relevant may wait for a
-- later submission to be summarised, and the server can no longer fetch it
-- again — so its text is kept with it (`body`, cleared once summarised).

alter table public.legal_feed_acts add column if not exists body text;

select cron.unschedule('legal-feed-sync')
where exists (select 1 from cron.job where jobname = 'legal-feed-sync');

drop function if exists public.legal_feed_sync_check(text);

delete from vault.secrets where name = 'legal_feed_sync_secret';
