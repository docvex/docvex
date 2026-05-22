import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from './AuthContext';
import { useSelectedProject } from './SelectedProjectContext';

// Tracks "unread chat messages" for the currently-selected project so
// the sidebar's Chat row can render a badge. Scoped to the selected
// project only — there's no cross-project unread aggregation yet
// because the Chat route auto-pulls the selected project anyway, so
// "unread elsewhere" wouldn't have a single navigation target.
//
// Persistence: a per-(user, project) `lastReadAt` timestamp in
// localStorage. On project change we count messages from the table
// where `created_at > lastReadAt` AND `author_id != viewer` AND not
// deleted; then a Realtime INSERT sub bumps the count for live
// arrivals. ProjectChat calls `markRead()` whenever the user is on
// the Team tab so the count clears as soon as messages are visibly
// being read.

const ChatUnreadContext = createContext({ unreadCount: 0, markRead: () => {} });
export const useChatUnread = () => useContext(ChatUnreadContext);

function storageKey(userId, projectId) {
  return `docvex.chat.lastRead.${userId}.${projectId}`;
}

export function ChatUnreadProvider({ children }) {
  const { session } = useAuth();
  const { selectedProjectId } = useSelectedProject();
  const viewerId = session?.user?.id || null;
  const projectId = selectedProjectId || null;

  const [unreadCount, setUnreadCount] = useState(0);
  // Stash the active lastReadAt in a ref so the Realtime handler can
  // compare incoming INSERT timestamps without re-subscribing every
  // time markRead() runs (which would tear down + recreate the
  // channel on each tab focus).
  const lastReadRef = useRef(null);

  useEffect(() => {
    if (!viewerId || !projectId) {
      setUnreadCount(0);
      lastReadRef.current = null;
      return undefined;
    }
    let cancelled = false;
    const key = storageKey(viewerId, projectId);
    let lastRead = null;
    try { lastRead = localStorage.getItem(key); } catch { lastRead = null; }
    // No stored timestamp → treat as "never read" so every existing
    // message lights up the badge on first visit. The user clearing
    // it just by opening the chat tab is intentional.
    if (!lastRead) lastRead = new Date(0).toISOString();
    lastReadRef.current = lastRead;

    (async () => {
      const { count, error } = await supabase
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .gt('created_at', lastRead)
        .neq('author_id', viewerId)
        .is('deleted_at', null);
      if (cancelled) return;
      if (!error) setUnreadCount(count || 0);
    })();
    return () => { cancelled = true; };
  }, [viewerId, projectId]);

  useEffect(() => {
    if (!viewerId || !projectId) return undefined;
    const channel = supabase
      .channel(`chat-unread:${projectId}:${viewerId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `project_id=eq.${projectId}`,
        },
        (payload) => {
          const row = payload?.new;
          if (!row) return;
          if (row.author_id === viewerId) return;
          if (row.deleted_at) return;
          const lastRead = lastReadRef.current || new Date(0).toISOString();
          if (row.created_at && row.created_at > lastRead) {
            setUnreadCount((c) => c + 1);
          }
        },
      )
      .subscribe();
    return () => {
      try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
    };
  }, [viewerId, projectId]);

  const markRead = useCallback(() => {
    if (!viewerId || !projectId) return;
    const now = new Date().toISOString();
    lastReadRef.current = now;
    try { localStorage.setItem(storageKey(viewerId, projectId), now); } catch { /* ignore */ }
    setUnreadCount(0);
  }, [viewerId, projectId]);

  const value = useMemo(() => ({ unreadCount, markRead }), [unreadCount, markRead]);
  return <ChatUnreadContext.Provider value={value}>{children}</ChatUnreadContext.Provider>;
}
