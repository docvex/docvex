-- 032_rls_security_fixes.sql
-- Security audit (2026-07) — close three RLS authorization-bypass bugs.
--
-- These are ALTER POLICY changes (reversible) that only ADD restrictions
-- matching each policy's documented intent — they don't loosen anything.

-- 1. project_members UPDATE — "admins update non-owner members"
--    BUG: the USING clause only checked has_capability(...,'members.change_role')
--    with NO owner guard, so an admin could target the OWNER's row and demote it
--    to viewer (WITH CHECK only validated the NEW role). Ownership can never be
--    restored via RLS → permanent, irreversible hostile takeover. The same
--    capability also let a low-tier custom role escalate ITS OWN row to admin.
--    FIX: protect the owner row in USING (Postgres evaluates USING against the
--    EXISTING row) and forbid a caller from changing their own membership row.
alter policy "admins update non-owner members" on public.project_members
  using (
    has_capability(project_id, 'members.change_role')
    and role <> 'owner'
    and user_id <> (select auth.uid())
  )
  with check (role <> 'owner');

-- 2. chat_messages UPDATE — "chat: authors edit own messages"
--    BUG: WITH CHECK only pinned author_id, and `authenticated` holds column
--    UPDATE on project_id, so a member could repoint a message's project_id to a
--    project they are NOT a member of — injecting content (and @mention
--    notifications) into another tenant's team chat.
--    FIX: re-assert membership of the (new) project_id in WITH CHECK. USING is
--    unchanged (author-only row selection is correct).
alter policy "chat: authors edit own messages" on public.chat_messages
  with check (
    author_id = (select auth.uid())
    and has_project_role(project_id, 'member')
  );

-- 3. private_messages UPDATE — "private_messages_update_sender"
--    BUG: same class — WITH CHECK only checked sender_id, so a sender could
--    repoint project_id / recipient_id.
--    FIX: mirror the INSERT policy's guarantees in WITH CHECK.
alter policy "private_messages_update_sender" on public.private_messages
  with check (
    auth.uid() = sender_id
    and has_project_role(project_id, 'viewer')
    and exists (
      select 1 from public.project_members pm
      where pm.project_id = private_messages.project_id
        and pm.user_id = private_messages.recipient_id
    )
  );

-- NOTE (follow-up, not in this migration): ownership TRANSFER now has no RLS path
-- at all (WITH CHECK forbids setting role='owner'). If the product needs it, add
-- a SECURITY DEFINER transfer_ownership(project_id, new_owner) RPC that demotes
-- the old owner and promotes the new one atomically. Also consider constraining
-- which capabilities create_custom_role/update_custom_role may grant per base
-- tier so members.change_role can't be attached to a viewer/member custom role.
