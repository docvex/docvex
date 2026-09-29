-- 047_e2e_keys_hardening.sql — the security advisor's findings on 046.
-- Trigger functions are not API: nobody calls them over /rest/v1/rpc.
-- _touch_updated_at gets a fixed search_path.
revoke execute on function public._on_member_removed_keys() from public, anon, authenticated;
revoke execute on function public._retire_older_key_versions() from public, anon, authenticated;
revoke execute on function public._notify_chat_mentions() from public, anon, authenticated;
alter function public._touch_updated_at() set search_path = public;
