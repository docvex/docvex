-- LIVE SECURITY SNAPSHOT of Supabase project pntxlvhkqfryyyxlqytr
-- Taken 2026-10-01 from production (pg_policies, pg_proc, information_schema)
-- after migration 048. Security fix: until now part of the database's access
-- rules lived ONLY in production — seven tables, two functions and several
-- policies were created from the dashboard / MCP and never committed, so the
-- rules could not be reviewed or rebuilt from the repository.
--
-- This file is a RECORD, not a migration: every object below already exists in
-- production. Part 1 is the DDL that is in no migration file; part 2 is EVERY
-- row-level-security policy as it stands (public + storage), including the ones
-- migrations also create, so the whole rule set can be read in one place.
--
-- Rebuilding from scratch: run the migrations in order, then part 1 of this file
-- after 024 (its tables reference chat_messages / projects). Regenerate the
-- file with scripts/db-security-snapshot.sql (paste into the SQL editor) and
-- review the diff whenever a policy changes.

-- ═══ Part 1 — objects that exist only in production ══════════════════════

create table if not exists public.app_admins (
  email text not null,
  added_by uuid,
  added_at timestamp with time zone not null default now(),
  constraint app_admins_pkey PRIMARY KEY (email),
  constraint app_admins_added_by_fkey FOREIGN KEY (added_by) REFERENCES auth.users(id) ON DELETE SET NULL
);
alter table public.app_admins enable row level security;

create table if not exists public.app_services (
  id text not null,
  provider text not null,
  category text,
  plan text,
  icon text default 'generic'::text,
  accent text default '#6366F1'::text,
  amount numeric default 0,
  currency text default 'USD'::text,
  cycle text default 'monthly'::text,
  next_renewal date,
  status text default 'active'::text,
  status_label text,
  meta text,
  summary text,
  stats jsonb default '[]'::jsonb,
  sort integer default 0,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  dashboard_url text,
  constraint app_services_pkey PRIMARY KEY (id)
);
alter table public.app_services enable row level security;

create table if not exists public.chat_message_reactions (
  id uuid not null default gen_random_uuid(),
  message_id uuid not null,
  project_id uuid not null,
  user_id uuid not null,
  emoji text not null,
  created_at timestamp with time zone not null default now(),
  constraint chat_message_reactions_message_id_user_id_emoji_key UNIQUE (message_id, user_id, emoji),
  constraint chat_message_reactions_pkey PRIMARY KEY (id),
  constraint chat_message_reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
  constraint chat_message_reactions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  constraint chat_message_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE INDEX chat_message_reactions_message_idx ON public.chat_message_reactions USING btree (message_id);
CREATE INDEX chat_message_reactions_project_idx ON public.chat_message_reactions USING btree (project_id);
alter table public.chat_message_reactions enable row level security;

create table if not exists public.enrollments (
  id uuid not null default gen_random_uuid(),
  type text not null,
  name text,
  email text not null,
  firm text,
  message text,
  created_at timestamp with time zone not null default now(),
  constraint enrollments_pkey PRIMARY KEY (id),
  constraint enrollments_lengths CHECK (((COALESCE(length(name), 0) <= 200) AND (COALESCE(length(email), 0) <= 320) AND (COALESCE(length(firm), 0) <= 200) AND (COALESCE(length(message), 0) <= 5000))),
  constraint enrollments_type_check CHECK ((type = ANY (ARRAY['demo'::text, 'waitlist'::text])))
);
alter table public.enrollments enable row level security;

create table if not exists public.mail_oauth_states (
  nonce text not null,
  user_id uuid not null,
  provider text not null,
  created_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null,
  constraint mail_oauth_states_pkey PRIMARY KEY (nonce),
  constraint mail_oauth_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE INDEX idx_mail_oauth_states_expires ON public.mail_oauth_states USING btree (expires_at);
alter table public.mail_oauth_states enable row level security;

create table if not exists public.private_messages (
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  sender_id uuid not null,
  recipient_id uuid not null,
  body text not null,
  created_at timestamp with time zone not null default now(),
  edited_at timestamp with time zone,
  deleted_at timestamp with time zone,
  constraint private_messages_pkey PRIMARY KEY (id),
  constraint private_messages_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  constraint private_messages_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint private_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint private_messages_body_nonempty CHECK (((deleted_at IS NOT NULL) OR (length(TRIM(BOTH FROM body)) > 0))),
  constraint private_messages_distinct_users CHECK ((sender_id <> recipient_id))
);
CREATE INDEX private_messages_recipient_created_idx ON public.private_messages USING btree (recipient_id, created_at DESC);
CREATE INDEX private_messages_thread_idx ON public.private_messages USING btree (project_id, LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), created_at DESC);
alter table public.private_messages enable row level security;

create table if not exists public.user_mail_connections (
  user_id uuid not null,
  provider text not null,
  email text,
  access_token text,
  refresh_token text,
  token_expiry timestamp with time zone,
  scope text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint user_mail_connections_pkey PRIMARY KEY (user_id),
  constraint user_mail_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint user_mail_connections_provider_check CHECK ((provider = ANY (ARRAY['gmail'::text, 'outlook'::text])))
);
alter table public.user_mail_connections enable row level security;

CREATE OR REPLACE FUNCTION public.set_chat_message_pin(p_message_id uuid, p_pinned boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_project uuid;
begin
  select project_id into v_project from public.chat_messages where id = p_message_id;
  if v_project is null then
    raise exception 'message not found';
  end if;
  if not public.has_project_role(v_project, 'member') then
    raise exception 'not a project member';
  end if;
  update public.chat_messages
    set pinned_at = case when p_pinned then now() else null end,
        pinned_by = case when p_pinned then (select auth.uid()) else null end
    where id = p_message_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.touch_user_mail_connections()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

-- Table privileges held by the API roles on these tables as found (RLS still
-- decides every row; a table with RLS on and no policy for a role answers
-- nothing). Migration 049 then REVOKED truncate, trigger and references from
-- anon and authenticated on every public table — the lines below list them as
-- they were before that.
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on app_admins to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on app_services to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on chat_message_reactions to authenticated;
grant INSERT on enrollments to anon;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on enrollments to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on mail_oauth_states to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE on private_messages to authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on user_mail_connections to authenticated;

-- ═══ Part 2 — every RLS policy, as live (70) ═════════════════════════════

create policy "reactions: members add own" on public.chat_message_reactions as PERMISSIVE for INSERT to public
  with check ((has_project_role(project_id, 'member'::project_role) AND (user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM chat_messages m
  WHERE ((m.id = chat_message_reactions.message_id) AND (m.project_id = chat_message_reactions.project_id))))));

create policy "reactions: members read" on public.chat_message_reactions as PERMISSIVE for SELECT to public
  using (has_project_role(project_id, 'member'::project_role));

create policy "reactions: remove own" on public.chat_message_reactions as PERMISSIVE for DELETE to public
  using ((user_id = ( SELECT auth.uid() AS uid)));

create policy "chat: authors edit own messages" on public.chat_messages as PERMISSIVE for UPDATE to public
  using ((author_id = ( SELECT auth.uid() AS uid)))
  with check (((author_id = ( SELECT auth.uid() AS uid)) AND has_project_role(project_id, 'member'::project_role)));

create policy "chat: members post own messages" on public.chat_messages as PERMISSIVE for INSERT to public
  with check ((has_project_role(project_id, 'member'::project_role) AND (author_id = ( SELECT auth.uid() AS uid))));

create policy "chat: members read project messages" on public.chat_messages as PERMISSIVE for SELECT to public
  using (has_project_role(project_id, 'member'::project_role));

create policy "admins delete custom role caps" on public.custom_role_capabilities as PERMISSIVE for DELETE to public
  using ((EXISTS ( SELECT 1
   FROM custom_roles cr
  WHERE ((cr.id = custom_role_capabilities.custom_role_id) AND has_project_role(cr.project_id, 'admin'::project_role)))));

create policy "admins insert custom role caps" on public.custom_role_capabilities as PERMISSIVE for INSERT to public
  with check ((EXISTS ( SELECT 1
   FROM custom_roles cr
  WHERE ((cr.id = custom_role_capabilities.custom_role_id) AND has_project_role(cr.project_id, 'admin'::project_role)))));

create policy "admins update custom role caps" on public.custom_role_capabilities as PERMISSIVE for UPDATE to public
  using ((EXISTS ( SELECT 1
   FROM custom_roles cr
  WHERE ((cr.id = custom_role_capabilities.custom_role_id) AND has_project_role(cr.project_id, 'admin'::project_role)))));

create policy "viewers read custom role caps" on public.custom_role_capabilities as PERMISSIVE for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM custom_roles cr
  WHERE ((cr.id = custom_role_capabilities.custom_role_id) AND has_project_role(cr.project_id, 'viewer'::project_role)))));

create policy "admins delete custom roles" on public.custom_roles as PERMISSIVE for DELETE to public
  using (has_project_role(project_id, 'admin'::project_role));

create policy "admins insert custom roles" on public.custom_roles as PERMISSIVE for INSERT to public
  with check ((has_project_role(project_id, 'admin'::project_role) AND (base_role <> 'owner'::project_role)));

create policy "admins update custom roles" on public.custom_roles as PERMISSIVE for UPDATE to public
  using (has_project_role(project_id, 'admin'::project_role))
  with check ((has_project_role(project_id, 'admin'::project_role) AND (base_role <> 'owner'::project_role)));

create policy "viewers read custom roles" on public.custom_roles as PERMISSIVE for SELECT to public
  using (has_project_role(project_id, 'viewer'::project_role));

create policy "dm keys: one of the two makes" on public.dm_conversation_keys as PERMISSIVE for INSERT to public
  with check (((created_by = ( SELECT auth.uid() AS uid)) AND ((( SELECT auth.uid() AS uid) = user_low) OR (( SELECT auth.uid() AS uid) = user_high)) AND is_project_member(project_id, user_low) AND is_project_member(project_id, user_high) AND (low_key = ( SELECT k.x25519
   FROM user_public_keys k
  WHERE (k.user_id = dm_conversation_keys.user_low))) AND (high_key = ( SELECT k.x25519
   FROM user_public_keys k
  WHERE (k.user_id = dm_conversation_keys.user_high)))));

create policy "dm keys: the two read" on public.dm_conversation_keys as PERMISSIVE for SELECT to public
  using (((( SELECT auth.uid() AS uid) = user_low) OR (( SELECT auth.uid() AS uid) = user_high)));

create policy "anyone can submit enrollment" on public.enrollments as PERMISSIVE for INSERT to anon, authenticated
  with check (true);

create policy "legal_update_states: delete own" on public.legal_update_states as PERMISSIVE for DELETE to public
  using ((user_id = ( SELECT auth.uid() AS uid)));

create policy "legal_update_states: insert own" on public.legal_update_states as PERMISSIVE for INSERT to public
  with check ((user_id = ( SELECT auth.uid() AS uid)));

create policy "legal_update_states: read own" on public.legal_update_states as PERMISSIVE for SELECT to public
  using ((user_id = ( SELECT auth.uid() AS uid)));

create policy "legal_update_states: update own" on public.legal_update_states as PERMISSIVE for UPDATE to public
  using ((user_id = ( SELECT auth.uid() AS uid)))
  with check ((user_id = ( SELECT auth.uid() AS uid)));

create policy "legal_updates: public read" on public.legal_updates as PERMISSIVE for SELECT to public
  using (true);

create policy legal_updates_admin_delete on public.legal_updates as PERMISSIVE for DELETE to authenticated
  using (is_app_admin());

create policy legal_updates_admin_insert on public.legal_updates as PERMISSIVE for INSERT to authenticated
  with check (is_app_admin());

create policy "users delete own" on public.notifications as PERMISSIVE for DELETE to public
  using ((( SELECT auth.uid() AS uid) = user_id));

create policy "users insert own" on public.notifications as PERMISSIVE for INSERT to public
  with check ((( SELECT auth.uid() AS uid) = user_id));

create policy "users select own" on public.notifications as PERMISSIVE for SELECT to public
  using ((( SELECT auth.uid() AS uid) = user_id));

create policy "users update own" on public.notifications as PERMISSIVE for UPDATE to public
  using ((( SELECT auth.uid() AS uid) = user_id));

create policy "phone upload: owner deletes files" on public.phone_upload_files as PERMISSIVE for DELETE to authenticated
  using ((EXISTS ( SELECT 1
   FROM phone_upload_sessions s
  WHERE ((s.id = phone_upload_files.session_id) AND (s.user_id = auth.uid())))));

create policy "phone upload: owner reads files" on public.phone_upload_files as PERMISSIVE for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM phone_upload_sessions s
  WHERE ((s.id = phone_upload_files.session_id) AND (s.user_id = auth.uid())))));

create policy "phone upload: owner updates files" on public.phone_upload_files as PERMISSIVE for UPDATE to authenticated
  using ((EXISTS ( SELECT 1
   FROM phone_upload_sessions s
  WHERE ((s.id = phone_upload_files.session_id) AND (s.user_id = auth.uid())))))
  with check ((EXISTS ( SELECT 1
   FROM phone_upload_sessions s
  WHERE ((s.id = phone_upload_files.session_id) AND (s.user_id = auth.uid())))));

create policy "phone upload: owner deletes sessions" on public.phone_upload_sessions as PERMISSIVE for DELETE to authenticated
  using ((user_id = auth.uid()));

create policy "phone upload: owner reads sessions" on public.phone_upload_sessions as PERMISSIVE for SELECT to authenticated
  using ((user_id = auth.uid()));

create policy private_messages_insert on public.private_messages as PERMISSIVE for INSERT to authenticated
  with check (((auth.uid() = sender_id) AND has_project_role(project_id, 'viewer'::project_role) AND (EXISTS ( SELECT 1
   FROM project_members pm
  WHERE ((pm.project_id = private_messages.project_id) AND (pm.user_id = private_messages.recipient_id))))));

create policy private_messages_select on public.private_messages as PERMISSIVE for SELECT to authenticated
  using ((((auth.uid() = sender_id) OR (auth.uid() = recipient_id)) AND has_project_role(project_id, 'viewer'::project_role)));

create policy private_messages_update_sender on public.private_messages as PERMISSIVE for UPDATE to authenticated
  using ((auth.uid() = sender_id))
  with check (((auth.uid() = sender_id) AND has_project_role(project_id, 'viewer'::project_role) AND (EXISTS ( SELECT 1
   FROM project_members pm
  WHERE ((pm.project_id = private_messages.project_id) AND (pm.user_id = private_messages.recipient_id))))));

create policy "project_ai_usage: members insert own" on public.project_ai_usage as PERMISSIVE for INSERT to public
  with check (((user_id = ( SELECT auth.uid() AS uid)) AND has_project_role(project_id, 'viewer'::project_role)));

create policy "project_ai_usage: members read" on public.project_ai_usage as PERMISSIVE for SELECT to public
  using (has_project_role(project_id, 'viewer'::project_role));

create policy "admins create invitations" on public.project_invitations as PERMISSIVE for INSERT to public
  with check ((has_capability(project_id, 'members.invite'::project_capability) AND (role <> 'owner'::project_role) AND invite_role_allowed(project_id, role, custom_role_id)));

create policy "admins delete invitations" on public.project_invitations as PERMISSIVE for DELETE to public
  using (has_capability(project_id, 'members.invite'::project_capability));

create policy "admins read invitations" on public.project_invitations as PERMISSIVE for SELECT to public
  using (has_capability(project_id, 'members.invite'::project_capability));

create policy "grants: drop own" on public.project_key_grants as PERMISSIVE for DELETE to public
  using ((user_id = ( SELECT auth.uid() AS uid)));

create policy "grants: give" on public.project_key_grants as PERMISSIVE for INSERT to public
  with check (((granted_by = ( SELECT auth.uid() AS uid)) AND is_project_member(project_id, user_id) AND (recipient_key = ( SELECT k.x25519
   FROM user_public_keys k
  WHERE (k.user_id = project_key_grants.user_id))) AND (((user_id = ( SELECT auth.uid() AS uid)) AND has_project_role(project_id, 'viewer'::project_role)) OR can_grant_project_keys(project_id))));

create policy "grants: re-seal" on public.project_key_grants as PERMISSIVE for UPDATE to public
  using (((user_id = ( SELECT auth.uid() AS uid)) OR can_grant_project_keys(project_id)))
  with check (((granted_by = ( SELECT auth.uid() AS uid)) AND is_project_member(project_id, user_id) AND (recipient_key = ( SELECT k.x25519
   FROM user_public_keys k
  WHERE (k.user_id = project_key_grants.user_id))) AND (((user_id = ( SELECT auth.uid() AS uid)) AND has_project_role(project_id, 'viewer'::project_role)) OR can_grant_project_keys(project_id))));

create policy "grants: read own" on public.project_key_grants as PERMISSIVE for SELECT to public
  using ((user_id = ( SELECT auth.uid() AS uid)));

create policy "key versions: members read" on public.project_key_versions as PERMISSIVE for SELECT to public
  using (has_project_role(project_id, 'viewer'::project_role));

create policy "key versions: next one" on public.project_key_versions as PERMISSIVE for INSERT to public
  with check (((created_by = ( SELECT auth.uid() AS uid)) AND (retired = false) AND (version = next_project_key_version(project_id)) AND (can_grant_project_keys(project_id) OR ((version = 1) AND has_project_role(project_id, 'viewer'::project_role) AND has_legacy_folder_key(project_id)))));

create policy "admins update non-owner members" on public.project_members as PERMISSIVE for UPDATE to public
  using ((has_capability(project_id, 'members.change_role'::project_capability) AND (role <> 'owner'::project_role) AND (user_id <> ( SELECT auth.uid() AS uid)) AND ((role <> 'admin'::project_role) OR has_project_role(project_id, 'admin'::project_role))))
  with check (((role <> 'owner'::project_role) AND invite_role_allowed(project_id, role, custom_role_id)));

create policy "delete members" on public.project_members as PERMISSIVE for DELETE to public
  using (((has_capability(project_id, 'members.remove'::project_capability) AND (role <> 'owner'::project_role) AND ((role <> 'admin'::project_role) OR has_project_role(project_id, 'admin'::project_role))) OR ((user_id = ( SELECT auth.uid() AS uid)) AND (role <> 'owner'::project_role))));

create policy "members read members" on public.project_members as PERMISSIVE for SELECT to public
  using (has_project_role(project_id, 'viewer'::project_role));

create policy "admins update projects" on public.projects as PERMISSIVE for UPDATE to public
  using (has_project_role(id, 'admin'::project_role));

create policy "any authed user creates projects" on public.projects as PERMISSIVE for INSERT to public
  with check ((( SELECT auth.uid() AS uid) = created_by));

create policy "members or creators read projects" on public.projects as PERMISSIVE for SELECT to public
  using ((has_project_role(id, 'viewer'::project_role) OR (( SELECT auth.uid() AS uid) = created_by)));

create policy "owners delete projects" on public.projects as PERMISSIVE for DELETE to public
  using (has_project_role(id, 'owner'::project_role));

create policy "backups: own only" on public.user_key_backups as PERMISSIVE for ALL to public
  using ((user_id = ( SELECT auth.uid() AS uid)))
  with check ((user_id = ( SELECT auth.uid() AS uid)));

create policy "keys: publish own" on public.user_public_keys as PERMISSIVE for INSERT to public
  with check ((user_id = ( SELECT auth.uid() AS uid)));

create policy "keys: read own or co-members" on public.user_public_keys as PERMISSIVE for SELECT to public
  using (((user_id = ( SELECT auth.uid() AS uid)) OR shares_project_with(user_id)));

create policy "keys: replace own" on public.user_public_keys as PERMISSIVE for UPDATE to public
  using ((user_id = ( SELECT auth.uid() AS uid)))
  with check ((user_id = ( SELECT auth.uid() AS uid)));

create policy writing_profiles_own on public.writing_profiles as PERMISSIVE for ALL to public
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy writing_samples_own on public.writing_samples as PERMISSIVE for ALL to public
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy "phone upload: owner deletes objects" on storage.objects as PERMISSIVE for DELETE to authenticated
  using (((bucket_id = 'phone-upload'::text) AND (phone_upload_owner(name) = auth.uid())));

create policy "phone upload: owner reads objects" on storage.objects as PERMISSIVE for SELECT to authenticated
  using (((bucket_id = 'phone-upload'::text) AND (phone_upload_owner(name) = auth.uid())));

create policy "project sync: deleters remove" on storage.objects as PERMISSIVE for DELETE to authenticated
  using (((bucket_id = 'project-sync'::text) AND (storage_project_id(name) IS NOT NULL) AND (has_capability(storage_project_id(name), 'files.delete_any'::project_capability) OR ((owner = auth.uid()) AND has_capability(storage_project_id(name), 'files.delete_own'::project_capability)))));

create policy "project sync: members read" on storage.objects as PERMISSIVE for SELECT to authenticated
  using (((bucket_id = 'project-sync'::text) AND (storage_project_id(name) IS NOT NULL) AND has_project_role(storage_project_id(name), 'viewer'::project_role)));

create policy "project sync: own private data read" on storage.objects as PERMISSIVE for SELECT to authenticated
  using (((bucket_id = 'project-sync'::text) AND storage_sync_owner_folder(name)));

create policy "project sync: own private data remove" on storage.objects as PERMISSIVE for DELETE to authenticated
  using (((bucket_id = 'project-sync'::text) AND storage_sync_owner_folder(name)));

create policy "project sync: own private data replace" on storage.objects as PERMISSIVE for UPDATE to authenticated
  using (((bucket_id = 'project-sync'::text) AND storage_sync_owner_folder(name)))
  with check (((bucket_id = 'project-sync'::text) AND storage_sync_owner_folder(name)));

create policy "project sync: own private data write" on storage.objects as PERMISSIVE for INSERT to authenticated
  with check (((bucket_id = 'project-sync'::text) AND storage_sync_owner_folder(name)));

create policy "project sync: uploaders replace" on storage.objects as PERMISSIVE for UPDATE to authenticated
  using (((bucket_id = 'project-sync'::text) AND (storage_project_id(name) IS NOT NULL) AND has_capability(storage_project_id(name), 'files.upload'::project_capability)))
  with check (((bucket_id = 'project-sync'::text) AND (storage_project_id(name) IS NOT NULL) AND has_capability(storage_project_id(name), 'files.upload'::project_capability)));

create policy "project sync: uploaders write" on storage.objects as PERMISSIVE for INSERT to authenticated
  with check (((bucket_id = 'project-sync'::text) AND (storage_project_id(name) IS NOT NULL) AND has_capability(storage_project_id(name), 'files.upload'::project_capability)));
