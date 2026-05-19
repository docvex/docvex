import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useAuth } from '../../context/AuthContext';
import { useNotifications } from '../../context/NotificationsContext';
import { listMembers } from '../../lib/projects';
import { listProjectFiles, createSignedDownloadUrl } from '../../lib/projectFiles';
import { supabase } from '../../lib/supabaseClient';
import {
  listChatMessages,
  sendChatMessage,
  editChatMessage,
  deleteChatMessage,
  subscribeChatMessages,
} from '../../lib/chat';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
import Tooltip from '../../components/Tooltip';
import FileThumbnail from '../../components/FileThumbnail';
import { useMorphPill } from '../../components/useMorphPill';
import { describeCloudFile } from '../../lib/thumbnailDescriptor';
import { openFileWindow, openDocx, isDocxFile, canOpenInApp } from '../../lib/platform';
import './ProjectScoped.css';
import './ProjectChat.css';

// Per-project team chat. Two tabs share the page: Team (realtime
// message thread between project members) and Assistant (per-user AI
// thread — placeholder while the Anthropic SDK integration ships).
//
// Architecture:
//   - messages list hydrated from chat_messages via Realtime; sorted
//     chronologically, newest at the bottom.
//   - composer at the bottom: textarea + paperclip (file picker) +
//     send. @<query> opens an inline member picker; clicking a
//     member inserts @<displayname> AND remembers the user_id in
//     draftMentions, which rides the row on insert.
//   - file attachments: a popover lists every project_file by name;
//     clicking toggles inclusion. Attached files render as cards
//     under the message body, clickable to open inline.
//   - edit/delete: hover the user's own message → pencil + trash
//     buttons. Pencil enters an inline-edit mode on the same row;
//     trash soft-deletes (deleted_at set) which renders as a
//     "Message deleted" tombstone.
//
// Mentions resolution: the body stores @<displayname> as literal
// text. draftMentions is a Set of user_ids; on send we filter to
// only keep IDs whose @<name> still appears in the body (so a
// backspace-out of the token drops the mention). Render time scans
// the body for those tokens and highlights them as <span>s.

// ───── Helpers ──────────────────────────────────────────────────────

function displayName(profile) {
  if (!profile) return 'Unknown';
  return profile.full_name || profile.name || profile.email || 'Unknown';
}

// 12-colour palette matching the AuthorAvatar pattern elsewhere
// (ChangeRequestsView.jsx). djb2-ish hash so the same user gets the
// same colour across every surface they appear in.
const AUTHOR_COLORS = [
  '#22c55e', '#ef4444', '#a855f7', '#facc15',
  '#3b82f6', '#ec4899', '#14b8a6', '#f97316',
  '#8b5cf6', '#06b6d4', '#84cc16', '#f43f5e',
];
function authorColor(authorId) {
  if (!authorId) return AUTHOR_COLORS[0];
  let h = 0;
  for (let i = 0; i < authorId.length; i++) {
    h = ((h << 5) - h) + authorId.charCodeAt(i);
    h |= 0;
  }
  return AUTHOR_COLORS[Math.abs(h) % AUTHOR_COLORS.length];
}

// Friendly time: HH:MM today, "yesterday HH:MM", "Mon HH:MM" within
// a week, full date older than that. Matches the cadence of a chat
// where most messages are minutes apart and the timestamp is just
// for orientation.
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const hhmm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hhmm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `yesterday ${hhmm}`;
  const diffDays = (now - d) / (24 * 60 * 60 * 1000);
  if (diffDays < 7) {
    return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm}`;
  }
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Absolute date + time for the morph-pill hover tooltip. The inline
// time in the bubble is relative ("yesterday 14:32"); the tooltip
// disambiguates with a full locale-formatted timestamp so a member
// reading old history can tell exactly when a message landed.
function formatFullTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return new Date(iso).toLocaleString();
  }
}

// ───── Avatar (matches the rest of the app) ─────────────────────────

function ChatAvatar({ profile, authorId, size = 32 }) {
  const url = profile?.avatar_url;
  const initial = (displayName(profile) || '?').charAt(0).toUpperCase();
  return (
    <span
      className="chat-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-label={displayName(profile)}
    >
      {url ? (
        <img
          className="chat-avatar-img"
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          draggable={false}
        />
      ) : (
        <span
          className="chat-avatar-fallback"
          style={{ background: authorColor(authorId) }}
        >
          {initial}
        </span>
      )}
    </span>
  );
}

// ───── Inline icons (no icon-lib dependency, matches app pattern) ───

const PaperclipIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.99 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);
const SendIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);
const PencilIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
);
const TrashIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);
const CloseIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const SparklesIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
  </svg>
);

// ───── Own-message bubble (interactive) ────────────────────────────
//
// Extracted as its own component because the morph-pill hook can't be
// called inline inside a .map() iteration. The bubble owns its hover
// + right-click affordances; the morph-pill renders Edit / Delete in
// the SAME visual language used by the right-click menus elsewhere
// in the app (ProjectFiles' local cards), so the chat reads as part
// of the same toolkit instead of inventing a different action surface.
//
// Hover state lives in CSS (.project-chat-msg.is-mine .project-chat-msg-text:hover)
// so the hook only wires the right-click path — no tooltip flash on
// every mouse-move, no per-cursor-pixel re-render.
function OwnBubble({ msg, renderBody, formatTime, onEdit, onDelete }) {
  // Hover tooltip body: full absolute timestamp + edited stamp.
  // The inline time in the bubble is relative; the cursor-following
  // tooltip resolves the ambiguity for messages older than a few
  // days without forcing a long-form label inside the bubble itself.
  const tooltipBody = msg.edited_at
    ? `Sent ${formatFullTime(msg.created_at)}\nEdited ${formatFullTime(msg.edited_at)}`
    : `Sent ${formatFullTime(msg.created_at)}`;
  const morphPill = useMorphPill({
    hoverContent: tooltipBody,
    // Chat-specific class lets ProjectChat.css narrow the dropdown
    // without touching the shared base in useMorphPill.css. The
    // file-grid menu has 4 items including "Show in explorer" which
    // needs ~180 px to read comfortably; the chat menu has 2 short
    // items (Edit / Delete) where the default 200 px feels oversized.
    className: 'project-chat-morph-pill',
    menuItems: [
      {
        key: 'edit',
        label: 'Edit',
        onClick: () => onEdit(msg),
      },
      {
        key: 'delete',
        label: 'Delete',
        onClick: () => onDelete(msg),
        danger: true,
        confirm: {
          title: 'Delete this message?',
          message: 'This can\'t be undone — every member will see it disappear from the thread.',
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
        },
      },
    ],
  });
  return (
    <>
      <div
        className="project-chat-msg-text"
        // Full files-tab handler set: hover follows the cursor with
        // the tooltip pill, right-click morphs the same pill into the
        // Edit/Delete menu, mouseleave hides it. Same trio
        // LocalFileCard wires.
        onMouseMove={morphPill.handleMouseMove}
        onMouseLeave={morphPill.handleMouseLeave}
        onContextMenu={morphPill.handleContextMenu}
      >
        <span className="project-chat-msg-text-body">{renderBody(msg)}</span>
        {!msg.deleted_at && (
          <span className="project-chat-msg-time-inline">
            {formatTime(msg.created_at)}
            {msg.edited_at && (
              <span className="project-chat-msg-edited-inline"> · edited</span>
            )}
          </span>
        )}
      </div>
      {morphPill.node}
    </>
  );
}

// ───── Page ─────────────────────────────────────────────────────────

export default function ProjectChat() {
  const { selectedProject, loading: loadingProject } = useSelectedProject();
  const projectId = selectedProject?.id || null;
  // /chat is a top-level route (alongside /files, /todos) — pulls
  // project state from SelectedProjectContext, not ProjectProvider
  // (which is scoped to /projects/:projectId/* by ProjectShell).
  // Members are fetched directly via the same listMembers helper
  // ProjectContext uses, so the data shape is identical and the @-
  // mention picker / message rendering needs no awareness of how
  // the page is mounted in the route tree.
  const [members, setMembers] = useState([]);
  useEffect(() => {
    if (!projectId) { setMembers([]); return undefined; }
    let cancelled = false;
    listMembers(projectId).then(({ data }) => {
      if (!cancelled) setMembers(data || []);
    });
    return () => { cancelled = true; };
  }, [projectId]);
  const { session } = useAuth();
  const viewerId = session?.user?.id || null;
  const { notify } = useNotifications();

  const [tab, setTab] = useState('team');

  // Build a (user_id → member-with-profile) map so message rendering
  // and mention resolution are O(1) lookups instead of array scans.
  const memberById = useMemo(() => {
    const m = new Map();
    for (const mem of members || []) m.set(mem.user_id, mem);
    return m;
  }, [members]);

  // ───── Messages ────────────────────────────────────────────────────
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId) { setMessages([]); return undefined; }
    let cancelled = false;
    setLoading(true);
    listChatMessages(projectId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        notify?.({
          category: 'system',
          variant: 'error',
          title: 'Could not load chat',
          body: error.message || 'Try again in a moment.',
          dedupeKey: `chat-load-error:${projectId}`,
        });
      } else {
        setMessages(data || []);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, notify]);

  // Realtime echo. Same merge pattern the BranchContext uses for
  // change_requests: dedupe INSERT by id (our optimistic insert may
  // race the echo), patch UPDATE, drop on DELETE.
  useEffect(() => {
    if (!projectId) return undefined;
    const unsub = subscribeChatMessages(projectId, ({ eventType, new: newRow, old: oldRow }) => {
      if (eventType === 'INSERT' && newRow) {
        setMessages((prev) => (
          prev.some((m) => m.id === newRow.id) ? prev : [...prev, newRow]
        ));
      } else if (eventType === 'UPDATE' && newRow) {
        setMessages((prev) => prev.map((m) => (m.id === newRow.id ? newRow : m)));
      } else if (eventType === 'DELETE' && oldRow) {
        setMessages((prev) => prev.filter((m) => m.id !== oldRow.id));
      }
    });
    return unsub;
  }, [projectId]);

  // Project file cache for attachment cards + the attach picker.
  // Fetched once per project on first chat-tab visit; realtime on the
  // chat doesn't touch project_files, so we leave the freshness to
  // the user-driven refetch path (they'll re-render after navigating
  // away and back if files changed mid-chat).
  const [projectFiles, setProjectFiles] = useState([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    listProjectFiles(projectId).then(({ data }) => {
      setProjectFiles(data || []);
      setFilesLoaded(true);
    });
  }, [projectId]);
  const fileById = useMemo(() => {
    const m = new Map();
    for (const f of projectFiles) m.set(f.id, f);
    return m;
  }, [projectFiles]);

  // Auto-scroll to bottom on new messages — only when the user is
  // already near the bottom (so we don't yank them away from a back-
  // scrolled history view when a teammate posts). When the user IS
  // scrolled up reading history, an "N new" pill appears above the
  // composer instead; clicking it scrolls down and clears the count.
  const listRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const prevMessagesLenRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setUnreadCount(0);
  }, []);

  const handleListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distFromBottom < 80;
    stickToBottomRef.current = atBottom;
    // Reaching the bottom clears the unread tally — the user has
    // visually caught up so the pill should go away even without an
    // explicit click on it.
    if (atBottom) setUnreadCount(0);
  };

  // Auto-scroll layout effect — runs after every messages state
  // commit. Stick-to-bottom is the only fast path; otherwise we
  // count NEW messages (current length > previous length) and
  // bump the unread tally so the pill knows what to show.
  useLayoutEffect(() => {
    const prev = prevMessagesLenRef.current;
    const next = messages.length;
    prevMessagesLenRef.current = next;
    const grew = next > prev;
    if (stickToBottomRef.current) {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else if (grew) {
      setUnreadCount((c) => c + (next - prev));
    }
  }, [messages, tab]);

  // ───── Composer state ──────────────────────────────────────────────
  const [draft, setDraft] = useState('');
  const [draftMentions, setDraftMentions] = useState(new Set());
  const [draftAttached, setDraftAttached] = useState(new Set());
  const [sending, setSending] = useState(false);
  const textareaRef = useRef(null);

  // @mention popover state
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const mentionTokenRef = useRef(null);  // { start, end } indices of the @… span
  const [mentionIndex, setMentionIndex] = useState(0);

  // File attach popover state
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachQuery, setAttachQuery] = useState('');

  // ───── Typing indicator (Realtime Broadcast) ───────────────────────
  // Each keystroke (throttled to once every 2 s) fires a broadcast on
  // a dedicated typing channel for this project. Other members'
  // clients receive the broadcast and stamp the sender's user_id with
  // an expiry 4 s in the future. A 500 ms pruning interval drops
  // entries past expiry, so a user who stops typing fades out of
  // everyone else's indicator without an explicit "stopped" message.
  //
  // Broadcast (vs Presence) was chosen because we don't need a
  // persistent member-list view of "who's currently in the channel"
  // — we only need a transient "this user pressed a key recently."
  // Broadcast is one round-trip per event, Presence is heavier.
  const [typingUsers, setTypingUsers] = useState(new Map());
  const typingChannelRef = useRef(null);
  const lastTypingBroadcastRef = useRef(0);

  useEffect(() => {
    if (!projectId || !viewerId) return undefined;
    const channel = supabase
      .channel(`chat-typing:${projectId}`)
      .on('broadcast', { event: 'typing' }, (msg) => {
        const uid = msg?.payload?.user_id;
        if (!uid || uid === viewerId) return;
        setTypingUsers((prev) => {
          const next = new Map(prev);
          next.set(uid, Date.now() + 4000);
          return next;
        });
      })
      .subscribe();
    typingChannelRef.current = channel;
    return () => {
      try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
      typingChannelRef.current = null;
      setTypingUsers(new Map());
    };
  }, [projectId, viewerId]);

  // Prune expired typing entries. 500 ms is the cadence that feels
  // right: a typist who pauses for ~3 s fades cleanly without the
  // indicator looking laggy or jittery.
  useEffect(() => {
    const interval = setInterval(() => {
      setTypingUsers((prev) => {
        if (prev.size === 0) return prev;
        const now = Date.now();
        let changed = false;
        const next = new Map();
        for (const [uid, exp] of prev) {
          if (exp > now) next.set(uid, exp);
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Throttled broadcast — called from the draft onChange handler.
  // The 2 s throttle is enough that a steady typist re-asserts their
  // "typing" stamp before the 4 s expiry runs out, so receivers keep
  // their indicator lit; a typist that stops sees the indicator fade
  // 4 s after their LAST keystroke (one expiry window).
  const broadcastTyping = useCallback(() => {
    const ch = typingChannelRef.current;
    if (!ch || !viewerId) return;
    const now = Date.now();
    if (now - lastTypingBroadcastRef.current < 2000) return;
    lastTypingBroadcastRef.current = now;
    ch.send({ type: 'broadcast', event: 'typing', payload: { user_id: viewerId } });
  }, [viewerId]);

  // When the textarea value or caret changes, look for an in-progress
  // @<word> token immediately before the caret. If present, open the
  // mention popover and feed it the partial-name query.
  const inspectCaretForMention = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at < 0) { setMentionOpen(false); mentionTokenRef.current = null; return; }
    // Only treat as a mention if the @ is at the very start or comes
    // after whitespace — `foo@bar` (email-like) shouldn't open the picker.
    const charBefore = at === 0 ? ' ' : before[at - 1];
    if (!/\s/.test(charBefore) && charBefore !== '\n') {
      setMentionOpen(false); mentionTokenRef.current = null; return;
    }
    const after = before.slice(at + 1);
    if (/\s/.test(after)) {
      setMentionOpen(false); mentionTokenRef.current = null; return;
    }
    setMentionOpen(true);
    setMentionQuery(after.toLowerCase());
    mentionTokenRef.current = { start: at, end: caret };
    setMentionIndex(0);
  }, []);

  const handleDraftChange = (e) => {
    setDraft(e.target.value);
    // Caret position is updated synchronously by the browser before
    // change fires; inspect right after.
    requestAnimationFrame(inspectCaretForMention);
    // Tell other members in the project channel we're typing. The
    // helper throttles to once per 2 s so a flurry of keystrokes
    // doesn't flood the realtime bus.
    broadcastTyping();
  };

  const handleDraftKeyDown = (e) => {
    if (mentionOpen) {
      const list = mentionResults; // see memo below
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, Math.max(0, list.length - 1)));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && list.length > 0) {
        e.preventDefault();
        pickMention(list[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }
    // Enter to send (Shift+Enter for newline). Disabled while editing
    // an existing message (handled by its own block).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Filtered member list for the @mention popover.
  const mentionResults = useMemo(() => {
    if (!mentionOpen) return [];
    const q = mentionQuery;
    const list = (members || [])
      .filter((m) => {
        const n = displayName(m.profile).toLowerCase();
        const e = (m.profile?.email || '').toLowerCase();
        return q === '' || n.includes(q) || e.includes(q);
      })
      .slice(0, 6);
    return list;
  }, [members, mentionOpen, mentionQuery]);

  const pickMention = (member) => {
    const name = displayName(member.profile);
    const token = mentionTokenRef.current;
    if (!token) return;
    const before = draft.slice(0, token.start);
    const after = draft.slice(token.end);
    const inserted = `@${name} `;
    const next = before + inserted + after;
    setDraft(next);
    setDraftMentions((prev) => new Set([...prev, member.user_id]));
    setMentionOpen(false);
    mentionTokenRef.current = null;
    // Restore focus and place caret just after the inserted token.
    const caret = before.length + inserted.length;
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(caret, caret);
      }
    });
  };

  // Toggle a file in the attach set.
  const toggleAttached = (fileId) => {
    setDraftAttached((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId); else next.add(fileId);
      return next;
    });
  };

  // Filtered project files for the attach popover.
  const attachResults = useMemo(() => {
    const q = (attachQuery || '').toLowerCase();
    if (!q) return projectFiles.slice(0, 12);
    return projectFiles
      .filter((f) => (f.name || '').toLowerCase().includes(q))
      .slice(0, 12);
  }, [projectFiles, attachQuery]);

  // Send the draft.
  const handleSend = async () => {
    if (sending || !projectId || !viewerId) return;
    const body = draft.trim();
    if (!body) return;
    // Filter mentions to only those whose @<name> still appears in
    // the body — handles the backspace-out-of-token case.
    const finalMentions = Array.from(draftMentions).filter((uid) => {
      const m = memberById.get(uid);
      if (!m) return false;
      return body.includes(`@${displayName(m.profile)}`);
    });
    setSending(true);
    const { data, error } = await sendChatMessage({
      projectId,
      authorId: viewerId,
      body,
      mentions: finalMentions,
      attachedFileIds: Array.from(draftAttached),
    });
    setSending(false);
    if (error) {
      notify?.({
        category: 'system',
        variant: 'error',
        title: 'Send failed',
        body: error.message || 'Try again in a moment.',
        dedupeKey: `chat-send-error:${Date.now()}`,
      });
      return;
    }
    // Force-stick-to-bottom BEFORE the state commit so the auto-
    // scroll layout effect (which reads this ref synchronously after
    // setMessages flushes) scrolls down for the sender's own send
    // regardless of whether they were scrolled up reading history.
    // The user explicitly clicked Send — yanking them to the bottom
    // is the expected behaviour.
    stickToBottomRef.current = true;
    setUnreadCount(0);
    // Optimistic insert — Realtime will echo and dedupe by id.
    if (data) {
      setMessages((prev) => (prev.some((m) => m.id === data.id) ? prev : [...prev, data]));
    }
    setDraft('');
    setDraftMentions(new Set());
    setDraftAttached(new Set());
    setMentionOpen(false);
    setAttachOpen(false);
  };

  // ───── Edit / Delete ───────────────────────────────────────────────
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const editRef = useRef(null);

  const startEdit = (msg) => {
    setEditingId(msg.id);
    setEditDraft(msg.body || '');
    requestAnimationFrame(() => {
      editRef.current?.focus();
      editRef.current?.setSelectionRange(msg.body?.length || 0, msg.body?.length || 0);
    });
  };
  const cancelEdit = () => { setEditingId(null); setEditDraft(''); };
  const saveEdit = async () => {
    if (!editingId) return;
    const body = editDraft.trim();
    if (!body) {
      notify?.({ category: 'system', variant: 'error', title: 'Empty edit', body: 'Cannot save an empty message.' });
      return;
    }
    const newMentions = (members || [])
      .filter((m) => body.includes(`@${displayName(m.profile)}`))
      .map((m) => m.user_id);
    const { error } = await editChatMessage(editingId, { body, mentions: newMentions });
    if (error) {
      notify?.({
        category: 'system',
        variant: 'error',
        title: 'Edit failed',
        body: error.message || 'Try again in a moment.',
      });
      return;
    }
    cancelEdit();
  };
  const handleDelete = async (msg) => {
    if (!msg) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm('Delete this message? This can\'t be undone.')) return;
    const { error } = await deleteChatMessage(msg.id);
    if (error) {
      notify?.({
        category: 'system',
        variant: 'error',
        title: 'Delete failed',
        body: error.message || 'Try again in a moment.',
      });
    }
  };

  // ───── Body rendering with mention highlights ──────────────────────
  // When the viewer is mentioned, every `@<viewer-display-name>` token
  // is replaced visually with `@me` so the reader sees themselves
  // addressed in first-person across the thread. The literal stored
  // body in the DB still carries the original `@<name>` so other
  // members render the name they typed — the swap is purely a
  // presentation transformation on the reading client.
  const renderBody = useCallback((msg) => {
    if (msg.deleted_at) {
      return <em className="chat-deleted">Message deleted</em>;
    }
    const body = msg.body || '';
    const tokens = [];
    for (const uid of msg.mentions || []) {
      const m = memberById.get(uid);
      if (!m) continue;
      const name = displayName(m.profile);
      tokens.push({ token: `@${name}`, userId: uid });
    }
    if (tokens.length === 0) return body;
    // Find all occurrences, sorted; render in order.
    const occurrences = [];
    for (const { token, userId } of tokens) {
      let idx = 0;
      while ((idx = body.indexOf(token, idx)) >= 0) {
        occurrences.push({ idx, token, userId });
        idx += token.length;
      }
    }
    occurrences.sort((a, b) => a.idx - b.idx);
    const parts = [];
    let cursor = 0;
    let key = 0;
    for (const occ of occurrences) {
      if (occ.idx < cursor) continue; // overlapping match — skip
      if (occ.idx > cursor) parts.push(<React.Fragment key={key++}>{body.slice(cursor, occ.idx)}</React.Fragment>);
      const mentionsViewer = occ.userId === viewerId;
      parts.push(
        <span key={key++} className={`chat-mention${mentionsViewer ? ' is-you' : ''}`}>
          {mentionsViewer ? '@me' : occ.token}
        </span>
      );
      cursor = occ.idx + occ.token.length;
    }
    if (cursor < body.length) {
      parts.push(<React.Fragment key={key++}>{body.slice(cursor)}</React.Fragment>);
    }
    return parts;
  }, [memberById, viewerId]);

  // Quick check: does this message mention the viewer? The row gets
  // a tinted background so a message addressed to the viewer reads
  // as "for you" while scrolling. Cheap array.includes — mentions
  // is small (typically 0-3 entries).
  const mentionsMe = useCallback((msg) => (
    Boolean(viewerId && (msg.mentions || []).includes(viewerId))
  ), [viewerId]);

  // ───── Attached-file card click → open viewer ──────────────────────
  const handleAttachmentClick = useCallback(async (file) => {
    if (!file?.storage_path) return;
    if (!canOpenInApp(file.mime_type, file.name)) return;
    const { data, error } = await createSignedDownloadUrl(file.storage_path, 1800);
    if (error || !data?.signedUrl) {
      notify?.({
        category: 'system',
        variant: 'error',
        title: 'Could not open file',
        body: error?.message || 'Try again in a moment.',
      });
      return;
    }
    if (isDocxFile(file.mime_type, file.name)) {
      openDocx({ cloudUrl: data.signedUrl, fileName: file.name || 'file' });
      return;
    }
    openFileWindow(data.signedUrl, file.name || 'file');
  }, [notify]);

  // ───── Early returns ───────────────────────────────────────────────
  if (loadingProject && !selectedProject) return <ProjectScopedSkeleton />;
  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to start a conversation.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  // ───── Render ──────────────────────────────────────────────────────
  return (
    <div className="project-scoped-page project-chat-page">
      <header className="project-scoped-header">
        <h1 className="project-scoped-title">Chat</h1>
        <p className="project-scoped-subtitle">
          Conversation for <strong>{selectedProject.name}</strong>.
        </p>
        <div className="project-chat-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'team'}
            className={`project-chat-tab${tab === 'team' ? ' is-active' : ''}`}
            onClick={() => setTab('team')}
          >
            Team
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'assistant'}
            className={`project-chat-tab${tab === 'assistant' ? ' is-active' : ''}`}
            onClick={() => setTab('assistant')}
          >
            {SparklesIcon} <span>Assistant</span>
          </button>
        </div>
      </header>

      {tab === 'team' && (
        <section className="project-chat-team">
          <div
            className="project-chat-messages"
            ref={listRef}
            onScroll={handleListScroll}
          >
            {loading && messages.length === 0 && (
              <div className="project-chat-empty">Loading…</div>
            )}
            {!loading && messages.length === 0 && (
              <div className="project-chat-empty">
                No messages yet. Be the first to say hi.
              </div>
            )}
            {messages.map((msg, i) => {
              const author = memberById.get(msg.author_id);
              const isMine = msg.author_id === viewerId;
              const prev = i > 0 ? messages[i - 1] : null;
              // Group consecutive messages by same author within 5
              // minutes — skip the author row for follow-ups so the
              // thread reads as a conversation, not a list of forms.
              const sameAuthorBlock = prev
                && prev.author_id === msg.author_id
                && !prev.deleted_at
                && !msg.deleted_at
                && (new Date(msg.created_at) - new Date(prev.created_at)) < 5 * 60 * 1000;
              return (
                <div
                  key={msg.id}
                  className={`project-chat-msg${isMine ? ' is-mine' : ''}${sameAuthorBlock ? ' is-follow' : ''}${msg.deleted_at ? ' is-deleted' : ''}${mentionsMe(msg) && !msg.deleted_at ? ' mentions-me' : ''}`}
                >
                  <div className="project-chat-msg-avatar">
                    {!sameAuthorBlock && (
                      <ChatAvatar profile={author?.profile} authorId={msg.author_id} size={32} />
                    )}
                  </div>
                  <div className="project-chat-msg-body">
                    {/* Meta row above the bubble — only rendered for
                        OTHER members' messages. Own messages drop the
                        name entirely (the right-aligned bubble + you
                        knowing you wrote it makes it redundant); the
                        time moves inside the bubble itself (see the
                        .project-chat-msg-time-inline span below). */}
                    {!sameAuthorBlock && !isMine && (
                      <div className="project-chat-msg-meta">
                        <span className="project-chat-msg-author">
                          {displayName(author?.profile)}
                        </span>
                        <span className="project-chat-msg-time">{formatTime(msg.created_at)}</span>
                        {msg.edited_at && !msg.deleted_at && (
                          <span className="project-chat-msg-edited">(edited)</span>
                        )}
                      </div>
                    )}
                    {editingId === msg.id ? (
                      <div className="project-chat-edit">
                        <textarea
                          ref={editRef}
                          className="project-chat-edit-input"
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              saveEdit();
                            } else if (e.key === 'Escape') {
                              cancelEdit();
                            }
                          }}
                          rows={Math.min(6, Math.max(1, (editDraft.match(/\n/g) || []).length + 1))}
                        />
                        <div className="project-chat-edit-actions">
                          <button type="button" onClick={cancelEdit} className="project-chat-edit-btn">
                            Cancel
                          </button>
                          <button type="button" onClick={saveEdit} className="project-chat-edit-btn project-chat-edit-btn-primary">
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {isMine && !msg.deleted_at ? (
                          // Interactive own-bubble: hover style via
                          // CSS, right-click opens the morph-pill
                          // menu (Edit / Delete) sharing the same
                          // toolkit the file grid uses. The bubble
                          // also carries its own inline timestamp at
                          // the bottom-right of the bubble.
                          <OwnBubble
                            msg={msg}
                            renderBody={renderBody}
                            formatTime={formatTime}
                            onEdit={startEdit}
                            onDelete={handleDelete}
                          />
                        ) : (
                          // Other authors' messages OR deleted
                          // tombstones: static bubble, no
                          // interactions, no inline timestamp (the
                          // time sits in the meta row above).
                          <div className="project-chat-msg-text">
                            <span className="project-chat-msg-text-body">{renderBody(msg)}</span>
                          </div>
                        )}
                        {!msg.deleted_at && (msg.attached_file_ids || []).length > 0 && (
                          <div className="project-chat-msg-attachments">
                            {msg.attached_file_ids.map((fid) => {
                              const file = fileById.get(fid);
                              if (!file) {
                                return (
                                  <span key={fid} className="project-chat-attachment-card is-missing">
                                    File no longer available
                                  </span>
                                );
                              }
                              // Same FileThumbnail + describeCloudFile
                              // pipeline the Files page uses, so a file
                              // shows the same poster everywhere — the
                              // cache hits across surfaces, and any
                              // future thumbnail improvement (DOCX
                              // renderer, video frame slideshow, new
                              // MIME) lands here for free.
                              return (
                                <button
                                  key={fid}
                                  type="button"
                                  className="project-chat-attachment-card"
                                  onClick={() => handleAttachmentClick(file)}
                                  title={file.name}
                                >
                                  <span className="project-chat-attachment-thumb">
                                    <FileThumbnail descriptor={describeCloudFile(file)} />
                                  </span>
                                  <span className="project-chat-attachment-text">
                                    <span className="project-chat-attachment-name">{file.name}</span>
                                    <span className="project-chat-attachment-size">
                                      {formatBytes(file.size_bytes)}
                                    </span>
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  {/* Hover edit/delete buttons are gone — the morph
                      pill that OwnBubble wires on right-click owns
                      that surface now, matching the right-click
                      menu pattern used on the file grid. */}
                </div>
              );
            })}
          </div>

          <div className="project-chat-composer">
            {/* New-messages pill — only renders when the user is
                scrolled away from the bottom AND new messages have
                arrived since they scrolled away. Click scrolls down
                + clears the count. Sits above the composer, anchored
                to it so it rides the sticky-bottom positioning. */}
            {unreadCount > 0 && (
              <button
                type="button"
                className="project-chat-new-msg-pill"
                onClick={scrollToBottom}
                aria-label={`Scroll to ${unreadCount} new message${unreadCount === 1 ? '' : 's'}`}
              >
                {unreadCount} new message{unreadCount === 1 ? '' : 's'} ↓
              </button>
            )}

            {/* Typing indicator — WhatsApp-style three-dot pulse with
                a short label naming who's typing. Realtime broadcast
                state is pruned on a 500 ms timer; an entry expires
                4 s after the last keystroke. */}
            {typingUsers.size > 0 && (() => {
              const names = Array.from(typingUsers.keys())
                .map((uid) => displayName(memberById.get(uid)?.profile))
                .filter(Boolean);
              if (names.length === 0) return null;
              const label = names.length === 1
                ? `${names[0]} is typing`
                : names.length === 2
                  ? `${names[0]} and ${names[1]} are typing`
                  : `${names.length} people are typing`;
              return (
                <div className="project-chat-typing" aria-live="polite">
                  <span className="project-chat-typing-dots" aria-hidden="true">
                    <span></span><span></span><span></span>
                  </span>
                  <span className="project-chat-typing-text">{label}</span>
                </div>
              );
            })()}

            {/* Staged attachment chips — render above the textarea so
                the user sees what they're about to send. Click ✕ to
                remove one without re-opening the picker. */}
            {draftAttached.size > 0 && (
              <div className="project-chat-staged">
                {Array.from(draftAttached).map((fid) => {
                  const file = fileById.get(fid);
                  return (
                    <span key={fid} className="project-chat-staged-chip">
                      <span className="project-chat-staged-name">
                        {file?.name || 'file'}
                      </span>
                      <button
                        type="button"
                        className="project-chat-staged-remove"
                        onClick={() => toggleAttached(fid)}
                        aria-label="Remove attachment"
                      >
                        {CloseIcon}
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            <div className="project-chat-composer-row">
              <Tooltip content={attachOpen ? 'Close file picker' : 'Attach a project file'}>
                <button
                  type="button"
                  className={`project-chat-icon-btn${attachOpen ? ' is-active' : ''}`}
                  onClick={() => setAttachOpen((v) => !v)}
                  aria-label="Attach file"
                >
                  {PaperclipIcon}
                </button>
              </Tooltip>
              <textarea
                ref={textareaRef}
                className="project-chat-input"
                value={draft}
                onChange={handleDraftChange}
                onKeyDown={handleDraftKeyDown}
                onSelect={inspectCaretForMention}
                placeholder={`Message ${selectedProject.name}…  (type @ to mention)`}
                rows={Math.min(6, Math.max(1, (draft.match(/\n/g) || []).length + 1))}
                disabled={sending}
                maxLength={4000}
              />
              <button
                type="button"
                className="project-chat-send"
                onClick={handleSend}
                disabled={sending || !draft.trim()}
                aria-label="Send message"
              >
                {SendIcon}
              </button>
            </div>

            {/* @mention popover — anchored to the bottom-left of the
                composer. Filtered member list with arrow-key + Enter
                support (handled inside handleDraftKeyDown). */}
            {mentionOpen && mentionResults.length > 0 && (
              <div className="project-chat-popover project-chat-popover-mentions">
                {mentionResults.map((m, i) => (
                  <button
                    type="button"
                    key={m.user_id}
                    className={`project-chat-popover-item${i === mentionIndex ? ' is-active' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}
                    onMouseEnter={() => setMentionIndex(i)}
                  >
                    <ChatAvatar profile={m.profile} authorId={m.user_id} size={22} />
                    <span className="project-chat-popover-name">{displayName(m.profile)}</span>
                    {m.profile?.email && (
                      <span className="project-chat-popover-email">{m.profile.email}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* File picker — same anchor as the mention popover. Lazy-
                loaded once on first project visit, then served from
                memory; the chat list isn't a long-running surface,
                so staleness across hours is unlikely to bite. */}
            {attachOpen && (
              <div className="project-chat-popover project-chat-popover-files">
                <input
                  type="text"
                  className="project-chat-popover-search"
                  placeholder="Search files…"
                  value={attachQuery}
                  onChange={(e) => setAttachQuery(e.target.value)}
                  autoFocus
                />
                {!filesLoaded && (
                  <div className="project-chat-popover-empty">Loading files…</div>
                )}
                {filesLoaded && attachResults.length === 0 && (
                  <div className="project-chat-popover-empty">
                    {attachQuery ? 'No matches.' : 'No files in this project yet.'}
                  </div>
                )}
                {attachResults.map((f) => {
                  const picked = draftAttached.has(f.id);
                  return (
                    <button
                      type="button"
                      key={f.id}
                      className={`project-chat-popover-item${picked ? ' is-picked' : ''}`}
                      onMouseDown={(e) => { e.preventDefault(); toggleAttached(f.id); }}
                    >
                      <span className="project-chat-popover-file-name">{f.name}</span>
                      <span className="project-chat-popover-file-size">
                        {formatBytes(f.size_bytes)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {tab === 'assistant' && (
        <section className="project-chat-assistant">
          <div className="project-chat-assistant-card">
            <div className="project-chat-assistant-icon" aria-hidden="true">
              {SparklesIcon}
            </div>
            <h2>Assistant — coming soon</h2>
            <p>
              A per-project conversation with Claude. Ask about the files in
              <strong> {selectedProject.name}</strong>, get summaries, draft
              follow-ups. Ships in a later build alongside the Anthropic SDK
              integration.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
