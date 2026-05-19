-- AFTER-INSERT trigger on chat_messages: fan out a notification to
-- every mentioned user (excluding the author — self-mention is a
-- common typo we shouldn't ping for). UPDATE fires the same trigger
-- so edited messages that ADD a new mention notify the new mentionee;
-- existing mentions don't re-fire because the dedupe_key collides
-- with the previous insert's `mention:<msg_id>:<user_id>`.
--
-- Scope guard: only fires when the mentioned user is actually a
-- member of the project. Anything else would be a renderer-side bug
-- (the @mention picker autocompletes from project_members) but
-- belt-and-suspenders here keeps the notification stream trustworthy.

create or replace function public._notify_chat_mentions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_project public.projects%rowtype;
begin
  if new.mentions is null or array_length(new.mentions, 1) is null then
    return new;
  end if;
  -- Skip if this is a soft-delete update (body is hidden client-side
  -- when deleted_at is set; pinging mentions on the delete echo
  -- would surface a notification for a message the user can't read).
  if new.deleted_at is not null then
    return new;
  end if;
  select * into v_project from public.projects where id = new.project_id;

  foreach v_user_id in array new.mentions
  loop
    -- Don't notify the author when they typo-mention themselves.
    if v_user_id = new.author_id then continue; end if;
    -- Member-of-project check. Otherwise the notification row
    -- wouldn't be visible to the recipient (notifications RLS gates
    -- on user_id = auth.uid()) but it'd still consume storage.
    if not exists (
      select 1 from public.project_members
        where project_id = new.project_id and user_id = v_user_id
    ) then
      continue;
    end if;
    insert into public.notifications (
      user_id, category, variant, priority, icon, title, body, payload, dedupe_key
    )
    values (
      v_user_id,
      'file',
      'info',
      'normal',
      'chat',
      'You were mentioned',
      format('You were mentioned in %s.', coalesce(v_project.name, 'a project chat')),
      jsonb_build_object(
        'message_id',  new.id,
        'project_id',  new.project_id,
        'author_id',   new.author_id
      ),
      format('chat-mention:%s:%s', new.id, v_user_id)
    )
    on conflict (user_id, dedupe_key) do nothing;
  end loop;
  return new;
end;
$$;

drop trigger if exists chat_messages_mentions_notify on public.chat_messages;
create trigger chat_messages_mentions_notify
  after insert or update of mentions, deleted_at on public.chat_messages
  for each row
  execute function public._notify_chat_mentions();
