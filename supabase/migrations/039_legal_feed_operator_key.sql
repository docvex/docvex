-- Legal Newsfeed — an operator key for `legal-feed-sync`.
--
-- Submissions are accepted from app admins' desktop apps (migration 038). That
-- leaves nothing that can run the job on demand — a backfill, a check that the
-- pipeline works, a run from a machine where nobody is signed in — without an
-- admin opening the app. This adds a second credential for exactly that: a key
-- generated here, kept in Vault, sent as the `x-feed-key` header. Whoever holds
-- it can already read Vault (it takes database access to fetch it), so it
-- grants nothing an operator doesn't have.
--
-- It is still a Romanian connection that has to read the portal (the portal
-- refuses Supabase's servers); the key only lets that machine SUBMIT.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'legal_feed_operator_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'legal_feed_operator_key',
      'x-feed-key header accepted by the legal-feed-sync Edge Function'
    );
  end if;
end $$;

-- The function asks whether a key is right. SECURITY DEFINER to read Vault;
-- the service role only.
create or replace function public.legal_feed_operator_check(p_key text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'legal_feed_operator_key'
      and decrypted_secret = p_key
      and length(coalesce(p_key, '')) >= 32
  );
$$;
revoke all on function public.legal_feed_operator_check(text) from public, anon, authenticated;
grant execute on function public.legal_feed_operator_check(text) to service_role;
