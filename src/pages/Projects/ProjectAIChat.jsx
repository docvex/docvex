import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../../context/AuthContext';
import { usePaneChromeFooterEl, usePaneChromePortalEl } from '../../context/PaneChromeContext';
import { ICONS as I } from './aiHub';
import { askProjectAi, suggestFileActions } from '../../lib/projectAi';
import { readLocalBlob, localFolderApi } from '../../lib/localFolder';
import { listMyProjects } from '../../lib/projects';
import { extractFileText } from '../../lib/extractFileText';
import { getDraggedFiles } from '../../lib/fileDragBus';
import FileThumbnail from '../../components/FileThumbnail';
import { useMorphPill } from '../../components/useMorphPill';
import './ProjectScoped.css';
import './ProjectAI.css';
import './ProjectChatVariantB.css';
import './ProjectAIChat.css';

// Typewriter — reveals an AI answer character-by-character. The revealed slice
// is rendered through Markdown as it grows, so formatting (**bold**, ## headings,
// lists, etc.) appears live instead of showing raw syntax; once the reveal
// finishes the parent swaps in the final Markdown render. `onTick` keeps the
// thread scrolled to the bottom as text grows. Reveal speed scales with length
// and is capped so long answers don't crawl.
function Typewriter({ text, onDone, onTick }) {
  const [n, setN] = React.useState(0);
  const doneRef = React.useRef(onDone);
  const tickRef = React.useRef(onTick);
  doneRef.current = onDone;
  tickRef.current = onTick;
  React.useEffect(() => {
    const total = text.length;
    if (!total) { doneRef.current && doneRef.current(); return undefined; }
    let raf = 0;
    let start = 0;
    const dur = Math.min(Math.max(total / 90, 0.4), 6) * 1000; // ~90 chars/s, 0.4–6s
    const step = (ts) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      // Ease-out so it decelerates toward the end.
      const eased = 1 - Math.pow(1 - p, 2);
      setN(Math.floor(eased * total));
      tickRef.current && tickRef.current();
      if (p < 1) { raf = requestAnimationFrame(step); }
      else { setN(total); doneRef.current && doneRef.current(); }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text]);
  return (
    <div className="aichat-md aichat-typing">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text.slice(0, n)}</ReactMarkdown>
      <span className="aichat-caret" aria-hidden="true" />
    </div>
  );
}

// Contextual "thinking" status — replaces the wave animation while the AI is
// working. Cycles through short status words à la Claude, picked from a set
// that matches what the user asked for (math, writing, files, code, …), so the
// label reads as if the assistant is doing the relevant kind of work.
const THINKING_SETS = {
  math: ['Calculating', 'Crunching the numbers', 'Working through the math', 'Checking the figures'],
  write: ['Drafting', 'Composing', 'Choosing the words', 'Polishing'],
  legal: ['Reviewing', 'Checking the clauses', 'Weighing the details', 'Consulting the rules'],
  files: ['Searching your files', 'Scanning the documents', 'Gathering context', 'Looking things up'],
  code: ['Writing code', 'Reasoning about the logic', 'Tracing the flow', 'Working it out'],
  summary: ['Reading', 'Summarising', 'Distilling the key points', 'Pulling it together'],
  general: ['Thinking', 'Working on it', 'Reasoning', 'Putting it together'],
};

function pickThinkingSet(text) {
  const t = (text || '').toLowerCase();
  if (/(calcul|\bsum\b|total|\bmath|number|average|percent|\bcost|price|budget|amount|equation|formula|multipl|divid|add up|how much)/.test(t)) return 'math';
  if (/(write|draft|compose|email|letter|essay|paragraph|rewrite|rephrase|\bmessage\b|reply)/.test(t)) return 'write';
  if (/(legal|\blaw\b|clause|contract|statute|regulation|complian|gdpr|liabilit|court|\bcase\b|tax)/.test(t)) return 'legal';
  if (/(file|document|folder|search|\bfind\b|look up|\bpdf\b|\bdoc\b|spreadsheet|attach)/.test(t)) return 'files';
  if (/(\bcode\b|function|\bbug\b|script|\bapi\b|json|\bcss\b|html|javascript|python|\bsql\b|\berror\b|program)/.test(t)) return 'code';
  if (/(summar|tl;?dr|overview|recap|key points|\bbrief\b|explain)/.test(t)) return 'summary';
  return 'general';
}

function ThinkingStatus({ query }) {
  const set = React.useMemo(() => THINKING_SETS[pickThinkingSet(query)], [query]);
  const [i, setI] = React.useState(0);
  React.useEffect(() => {
    setI(0);
    const id = window.setInterval(() => setI((n) => (n + 1) % set.length), 2000);
    return () => window.clearInterval(id);
  }, [set]);
  return (
    <span className="aichat-thinking" role="status" aria-label="DocVex AI is working">
      <span className="aichat-thinking-text" key={i}>{set[i]}</span>
      <span className="aichat-thinking-dots" aria-hidden="true"><span /><span /><span /></span>
    </span>
  );
}

// AI — a standalone DocVex AI assistant. This is NOT scoped to a project: each
// conversation starts with a clean slate (zero project/file context), and the
// tab keeps its own navigation — a rail of saved chats with create / switch /
// rename / delete, ChatGPT-style. Threads persist per user in localStorage.
// It reuses the `.ai-hub` chat bubbles and the Chat window's footer composer.

const STORAGE_PREFIX = 'docvex.aichat.v2.';

// Deterministic colour-hashed fallback avatar (matches the AuthorAvatar /
// VbAvatar pattern used elsewhere) for users without a profile picture.
const AVATAR_COLORS = [
  '#22c55e', '#ef4444', '#a855f7', '#facc15',
  '#3b82f6', '#ec4899', '#14b8a6', '#f97316',
  '#8b5cf6', '#06b6d4', '#84cc16', '#f43f5e',
];
function hashColor(id) {
  if (!id) return AVATAR_COLORS[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) { h = ((h << 5) - h) + id.charCodeAt(i); h |= 0; }
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function uid() {
  try { return crypto.randomUUID(); } catch { return `t_${Date.now()}_${Math.round(Math.random() * 1e9)}`; }
}

// Map UI messages to the Anthropic role/content shape. Error placeholders
// never go back to the model. `apiText` (the message + any attached-file
// context) is preferred over the displayed `text` so file context carries
// across turns without cluttering the bubble.
function toApiMessages(list) {
  return list
    .filter((m) => !m.isError)
    .map((m) => ({ role: m.who === 'me' ? 'user' : 'assistant', content: m.apiText || m.text || '' }));
}

// Read attached files and build a context preamble for the model. Text, PDF and
// Word contents are extracted and inlined (capped); anything we can't read as
// text is noted by name so the model knows it only has the name for that one.
async function buildContextBlock(atts) {
  const parts = [];
  for (const a of atts) {
    try {
      // Picked-via-button attachments carry the File blob directly (Electron 42
      // no longer exposes File.path); dragged-from-Files ones resolve by path.
      const blob = a.file || await readLocalBlob(a.path);
      const res = await extractFileText(blob, a.name);
      if (res.text) {
        parts.push(`File: ${a.name}\n"""\n${res.text}${res.truncated ? '\n…[content truncated]' : ''}\n"""`);
      } else {
        parts.push(`File: ${a.name} — its contents could not be read as text (${res.error || 'unsupported type'}); only the file name is available.`);
      }
    } catch {
      parts.push(`File: ${a.name} (could not be read)`);
    }
  }
  return parts.length
    ? `The user attached the following file(s). Their full text contents are included below — read them and use them directly to answer.\n\n${parts.join('\n\n')}`
    : '';
}

function makeThread() {
  const now = Date.now();
  return { id: uid(), title: 'Unnamed chat', messages: [], createdAt: now, updatedAt: now };
}

// Short clock label (e.g. "14:05") for the message time mark — matches the
// Chat tab's inline timestamp.
function formatHM(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

// Date-grouping helpers (mirror the team/private chat). Two timestamps are the
// "same day" when their local Y-M-D match; the divider label reads Today /
// Yesterday / a full date.
function sameLocalDay(a, b) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}
function formatDayLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (sameLocalDay(d, now)) return 'Today';
  if (sameLocalDay(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

// Instant, offline suggestion set for a dropped file — shown immediately while
// the (slower) AI-tailored set loads, and the permanent fallback when the AI is
// unavailable. Lightly tuned by filename/extension; always legal-oriented since
// this is a law-firm app. The "Other" escape hatch is appended at render time.
function heuristicSuggestions(file) {
  const name = (file?.name || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const out = [
    { key: 'score', label: 'Legal risk score', prompt: 'Give this document a legal risk score from 1 to 10 and explain the key risks and red flags.' },
    { key: 'summary', label: 'Summarize', prompt: 'Summarize this document in clear, plain language.' },
    { key: 'clauses', label: 'Extract key clauses', prompt: 'Extract and list the parties, key dates, obligations, and important clauses in this document.' },
  ];
  if (/(contract|agreement|nda|lease|acord|contractul|conventie)/.test(name)) {
    out.push({ key: 'obligations', label: 'Obligations & deadlines', prompt: 'List every obligation, deadline, and penalty in this contract, grouped by party.' });
  } else if (/(invoice|factura|receipt|chitanta|bon)/.test(name)) {
    out.push({ key: 'amounts', label: 'Check amounts & dates', prompt: 'Extract all amounts, due dates, and parties from this document and flag anything unusual.' });
  } else if (/(png|jpe?g|gif|webp|bmp|heic|tif|tiff)/.test(ext)) {
    out.push({ key: 'describe', label: 'Describe this image', prompt: 'Describe what this image shows and anything legally relevant about it.' });
  } else {
    out.push({ key: 'compliance', label: 'Compliance check', prompt: 'Review this document for compliance issues, missing terms, or red flags.' });
  }
  out.push({ key: 'plain', label: 'Explain in plain terms', prompt: 'Explain what this document means in simple, non-legal terms.' });
  return out.slice(0, 5);
}

// Explanation-depth levels for the second step of the file-action flow. The
// slider index (0/1/2) maps here; `instr` is appended to the chosen action's
// prompt so the model tailors how thorough the answer is.
const DEPTH = [
  { key: 'low', label: 'Low', desc: 'Just the answer, with minimal extra information.', instr: 'Keep it brief: give just the answer with minimal extra explanation.' },
  { key: 'medium', label: 'Medium', desc: 'A clear answer with the key supporting points.', instr: 'Give a clear answer with the key supporting points and brief reasoning.' },
  { key: 'high', label: 'High', desc: 'A fully reviewed, thoroughly documented answer.', instr: 'Give a fully reviewed, thoroughly documented answer: explain your reasoning step by step, reference the relevant parts of the document, and note any caveats, assumptions and edge cases.' },
];

// The user's chosen projects directory (set in the launch hub) — the base for
// resolving each project's local folder. Mirrors ProjectFiles' readProjectsDir.
function readProjectsDir(uid2) {
  try { return localStorage.getItem(`docvex.projectsDir.${uid2 || '_anonymous'}`) || ''; }
  catch { return ''; }
}

// Collect the NAMES of every file across the user's project folders, for the
// "Use context" toggle. Names only (the edge `ask` action grounds on names, not
// contents). Best-effort + capped; Electron-only (web has no ambient folders).
async function gatherUserFileNames(userKey) {
  try {
    const projects = await listMyProjects();
    if (!Array.isArray(projects) || !projects.length) return [];
    const baseDir = readProjectsDir(userKey) || undefined;
    const names = [];
    for (const p of projects) {
      try {
        const { path } = await localFolderApi.projectDir(p.id, p.name, baseDir);
        if (!path) continue;
        const { files } = await localFolderApi.listAll(path);
        for (const f of (files || [])) if (f?.name) names.push(f.name);
      } catch { /* skip this project */ }
      if (names.length > 400) break;
    }
    return [...new Set(names)];
  } catch {
    return [];
  }
}

export default function ProjectAIChat() {
  const { session } = useAuth();
  const footerEl = usePaneChromeFooterEl();
  const chromeEl = usePaneChromePortalEl();
  const user = session?.user;
  const userKey = user?.id || '_anonymous';

  const myAvatarUrl = user?.user_metadata?.avatar_url || null;
  const myName = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || '?';
  const myInitial = myName.charAt(0).toUpperCase();
  const meAvatar = myAvatarUrl
    ? <img className="aichat-av-img" src={myAvatarUrl} alt="" referrerPolicy="no-referrer" draggable={false} />
    : <span className="aichat-av-fallback" style={{ background: hashColor(user?.id) }}>{myInitial}</span>;

  // No chats are forced — an empty list shows the "no chats" empty state.
  const [threads, setThreads] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [val, setVal] = useState('');
  const [streaming, setStreaming] = useState(false);
  // The AI message currently being revealed with the typewriter effect:
  // { threadId, index } — cleared when the animation completes.
  const [typing, setTyping] = useState(null);
  const [copiedIdx, setCopiedIdx] = useState(null); // message index showing the "Copied" state
  const [chatSearch, setChatSearch] = useState(''); // topbar search → filters the chat list
  const [attachments, setAttachments] = useState([]); // [{ name, path }] dropped from Files
  const [dropActive, setDropActive] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [dragPreview, setDragPreview] = useState(null); // [{name, path, descriptor}] while a file drag hovers the pane
  // Drop action sheet: after a file is dropped, show it on the left + a vertical
  // list of content-aware suggestion pills on the right (last = "Other").
  const [pendingDrop, setPendingDrop] = useState(null); // { files:[...], primary } awaiting an action
  const [suggestions, setSuggestions] = useState([]);   // [{ key, label, prompt }]
  const [suggestLoading, setSuggestLoading] = useState(false);
  // Step 2 of the file-action flow: the picked action + chosen explanation depth.
  const [chosenAction, setChosenAction] = useState(null); // the suggestion picked
  const [depthIdx, setDepthIdx] = useState(1);            // 0 low / 1 medium / 2 high
  const [fileSelected, setFileSelected] = useState(false); // sidebar file card selection
  const [fileProps, setFileProps] = useState(false);       // file Properties modal
  // File context is always on — the AI grounds answers in the names of all the
  // user's project files (no toggle; gathered automatically on mount).
  const useContext = true;
  const [contextFiles, setContextFiles] = useState([]); // gathered file names
  const [contextLoading, setContextLoading] = useState(false);
  const contextFilesRef = useRef([]);   // latest names for send() (avoids stale state)
  // Custom overlay scrollbar for the chat list (floats over content, no layout shift).
  const [sb, setSb] = useState({ h: 28, y: 0, enabled: false, show: false });
  const listRef = useRef(null);
  const sbHideTimer = useRef(null);
  const sbDrag = useRef(null);
  const sbThumbRef = useRef(null);   // rail thumb node — positioned via ref (no per-scroll re-render)
  const listScrollRaf = useRef(null); // rAF throttle for the rail scroll
  const dragDepth = useRef(0);
  const scroller = useRef(null);
  // Custom overlay scrollbar for the message thread (same pattern as the rail's,
  // so the native bar never reserves width / shifts the bubbles).
  const [msgSb, setMsgSb] = useState({ h: 28, y: 0, enabled: false, show: false });
  const msgSbHideTimer = useRef(null);
  const msgSbDrag = useRef(null);
  const msgThumbRef = useRef(null);    // thumb DOM node — positioned via ref, not state, to avoid per-scroll re-renders
  const msgScrollRaf = useRef(null);   // rAF throttle for scroll measuring
  const stickRef = useRef(true);       // true while the view should follow the bottom
  const loadedFor = useRef(null);
  const fileInputRef = useRef(null);
  const taRef = useRef(null);          // composer textarea (focus on "Other")
  const searchRef = useRef(null);      // chat-search input (Ctrl/Cmd+F focuses it)
  const pendingScrollRef = useRef(false); // one-shot: force the next auto-scroll (on send)
  const suggestToken = useRef(0);      // guards against stale AI suggestion results
  const rootRef = useRef(null);        // pane root, used to focus the pane on drop

  // Auto-grow the composer with its content, up to a 4-line ceiling; past that
  // it scrolls instead of pushing the thread. Runs on every value change (typing,
  // send-clear, chat switch). The cap is computed from the textarea's own
  // line-height so it tracks the font/theme: 4 lines + vertical padding.
  React.useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 22;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const maxH = Math.round(lh * 4 + padY);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
  }, [val]);

  // Ctrl/Cmd+F focuses the chat search (matches the Files tab). In split view
  // every pane shares this listener, so gate on the pane's focus state: fire
  // only when this instance lives in the focused `.sv-pane` (or single-window
  // mode, where there's no `.sv-pane`).
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        const pane = rootRef.current?.closest('.sv-pane');
        if (pane && !pane.classList.contains('is-focused')) return;
        if (!threads.length) return;
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [threads.length]);

  // Keep the bottom padding of BOTH scrollers in sync with the floating composer
  // footer's height so their last items always clear it. The footer floats
  // (absolute, full pane width) over the thread AND the chat-list rail, and
  // grows with the composer (up to 4 lines) + attachment chips; a fixed pad let
  // a tall footer hide the last message / last chat with no way to scroll them
  // into view. A ResizeObserver on the footer drives both pads live.
  React.useEffect(() => {
    const footer = taRef.current?.closest('.vb-composer-wrap');
    if (!footer) return undefined;
    const apply = () => {
      const h = footer.getBoundingClientRect().height;
      // 24px breathing gap above the footer; never below a sane minimum.
      const pad = `${Math.max(Math.round(h) + 24, 40)}px`;
      if (scroller.current) scroller.current.style.paddingBottom = pad;
      if (listRef.current) listRef.current.style.paddingBottom = pad;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(footer);
    return () => ro.disconnect();
  }, [activeId]);

  // Hydrate the user's saved chats (once per user).
  useEffect(() => {
    if (loadedFor.current === userKey) return;
    loadedFor.current = userKey;
    let saved = null;
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + userKey);
      saved = raw ? JSON.parse(raw) : null;
    } catch { saved = null; }
    if (Array.isArray(saved) && saved.length) {
      setThreads(saved);
      setActiveId(saved[0].id);
    } else {
      // No saved chats → start empty (the empty state offers a New chat button).
      setThreads([]);
      setActiveId(null);
    }
  }, [userKey]);

  // Persist (fire-and-forget; quota errors swallowed).
  useEffect(() => {
    try { localStorage.setItem(STORAGE_PREFIX + userKey, JSON.stringify(threads)); } catch { /* quota */ }
  }, [threads, userKey]);

  // Gather the user's file names so the AI can ground answers in them.
  const refreshContext = async () => {
    setContextLoading(true);
    const names = await gatherUserFileNames(userKey);
    contextFilesRef.current = names;
    setContextFiles(names);
    setContextLoading(false);
  };
  // Context is always on — gather the file names automatically on mount (and
  // whenever the signed-in user changes).
  useEffect(() => {
    refreshContext();
  }, [userKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape: close the Properties modal, else step back from the depth step,
  // else cancel the whole drop action sheet.
  useEffect(() => {
    if (!pendingDrop) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (fileProps) setFileProps(false);
      else if (chosenAction) setChosenAction(null);
      else closeActionSheet();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingDrop, chosenAction, fileProps]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeThread = threads.find((t) => t.id === activeId) || threads[0];
  const messages = activeThread?.messages || [];

  // Auto-scroll only "sticks" the view to the bottom while `stickRef` is true —
  // which the scroll handler clears the moment the user scrolls up and restores
  // when they return to the bottom. So reading mid-thread while the AI streams /
  // the typewriter reveals text is no longer yanked down. `force` overrides for
  // cases where we always want the latest in view (switching chats, sending).
  const scrollToBottom = (force = false) => {
    const el = scroller.current;
    if (!el) return;
    if (force !== true && !stickRef.current) return;
    if (force === true) stickRef.current = true;
    el.scrollTop = el.scrollHeight;
  };
  // Switching chats always jumps to the latest message.
  useEffect(() => { scrollToBottom(true); }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  // New messages / streaming only stick to the bottom if the user is there —
  // EXCEPT right after the user sends (pendingScrollRef), where we always jump
  // to their new message.
  useEffect(() => {
    scrollToBottom(pendingScrollRef.current);
    pendingScrollRef.current = false;
  }, [messages, streaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ask the model for a short title and apply it to the thread. Fire-and-forget;
  // on any failure the placeholder (the truncated first message) is kept.
  const generateTitle = async (threadId, firstQuestion) => {
    try {
      const prompt =
        'Write a concise 3 to 6 word title in Title Case for a chat that begins with the ' +
        `following user message. No quotes, no ending punctuation, no preamble — reply with ONLY the title.\n\n"${firstQuestion.slice(0, 600)}"`;
      const { text, error } = await askProjectAi({ messages: [{ role: 'user', content: prompt }], projectName: '', fileNames: [] });
      if (error) return;
      const title = (text || '').split('\n')[0].trim().replace(/^["'“”\s]+|["'“”.\s]+$/g, '').slice(0, 48);
      if (title) setThreads((ts) => ts.map((t) => (t.id === threadId ? { ...t, title } : t)));
    } catch { /* keep placeholder title */ }
  };

  // `extraAtts` lets a caller (e.g. the drop action sheet) send a turn with
  // files that aren't yet in the composer's attachment state.
  const send = async (q, extraAtts) => {
    const text = (q != null ? String(q) : val).trim();
    if (!text || streaming) return;
    setVal('');
    // A manual send while a file is pending IS the "Other" option — carry the
    // dropped file(s) and dismiss the action panel.
    let extra = extraAtts;
    if (pendingDrop && !extra) { extra = pendingDrop.files; closeActionSheet(); }
    const base = attachments;
    const atts = (extra && extra.length)
      ? [...base, ...extra.filter((a) => a?.path && !base.some((b) => b.path === a.path))]
      : base;
    setAttachments([]);
    // Files dropped onto the composer are inlined as context for this turn.
    const contextBlock = atts.length ? await buildContextBlock(atts) : '';
    const apiText = contextBlock ? `${contextBlock}\n\n---\n\n${text}` : text;
    const userMsg = {
      who: 'me',
      text,
      at: Date.now(),
      ...(contextBlock ? { apiText } : {}),
      ...(atts.length ? { attachments: atts.map((a) => a.name) } : {}),
    };
    const threadId = activeId;
    const current = threads.find((t) => t.id === threadId);
    const convo = [...(current?.messages || []), userMsg];
    const isFirstUser = !(current?.messages || []).some((m) => m.who === 'me');
    pendingScrollRef.current = true; // always jump to the just-sent message
    setThreads((ts) => ts.map((t) => (t.id === threadId
      ? { ...t, messages: convo, title: isFirstUser ? (text.slice(0, 48) || 'Unnamed chat') : t.title, updatedAt: Date.now() }
      : t)));
    setStreaming(true);
    // With "Use context" on, ground the answer in the names of all the user's
    // files; otherwise a blank-slate assistant (only the messages + attachments).
    const { text: answer, error } = await askProjectAi({
      messages: toApiMessages(convo),
      projectName: useContext ? 'your projects' : '',
      fileNames: useContext ? contextFilesRef.current : [],
    });
    setStreaming(false);
    setThreads((ts) => ts.map((t) => (t.id === threadId
      ? {
          ...t,
          updatedAt: Date.now(),
          messages: [...t.messages, error
            ? {
                who: 'ai',
                isError: true,
                text: error.message === 'ai_not_configured'
                  ? 'The AI assistant is not configured (the AI key is missing). Contact your administrator.'
                  : 'Couldn’t get an answer right now. Please try again in a moment.',
              }
            : { who: 'ai', text: answer, at: Date.now() }],
        }
      : t)));
    // Reveal the fresh AI answer with the typewriter effect (errors appear at
    // once). Its index in the thread is convo.length (convo already holds the
    // user message; the AI reply is appended right after).
    if (!error) setTyping({ threadId, index: convo.length });
    // After the first successful exchange, replace the placeholder title with an
    // AI-generated one based on the opening question.
    if (isFirstUser && !error) generateTitle(threadId, text);
  };

  // ── Per-response actions (under each AI message) ────────────────────────
  // Copy the answer to the clipboard, with a brief "Copied" confirmation.
  const copyMessage = async (text, index) => {
    try { await navigator.clipboard.writeText(text || ''); } catch { /* clipboard blocked */ }
    setCopiedIdx(index);
    window.setTimeout(() => setCopiedIdx((cur) => (cur === index ? null : cur)), 1600);
  };

  // Regenerate the AI message at `index`: drop it (and anything after it) and
  // re-ask the model with the conversation up to that point, then reveal the
  // fresh answer with the typewriter effect.
  const regenerate = async (index) => {
    if (streaming) return;
    const threadId = activeId;
    const current = threads.find((t) => t.id === threadId);
    const convo = (current?.messages || []).slice(0, index);
    if (!convo.length) return;
    setThreads((ts) => ts.map((t) => (t.id === threadId ? { ...t, messages: convo } : t)));
    setStreaming(true);
    const { text: answer, error } = await askProjectAi({
      messages: toApiMessages(convo),
      projectName: useContext ? 'your projects' : '',
      fileNames: useContext ? contextFilesRef.current : [],
    });
    setStreaming(false);
    setThreads((ts) => ts.map((t) => (t.id === threadId
      ? {
          ...t,
          updatedAt: Date.now(),
          messages: [...t.messages, error
            ? { who: 'ai', isError: true, text: 'Couldn’t get an answer right now. Please try again in a moment.' }
            : { who: 'ai', text: answer, at: Date.now() }],
        }
      : t)));
    if (!error) setTyping({ threadId, index: convo.length });
  };

  const newChat = () => {
    const t = makeThread();
    setThreads((ts) => [t, ...ts]);
    setActiveId(t.id);
    setVal('');
    setAttachments([]);
  };

  // Files dragged from the Files tab carry a docvex payload — drop them on the
  // composer to attach as context for the next message.
  const acceptsFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('application/x-docvex-files');
  const onComposerDragOver = (e) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropActive) setDropActive(true);
  };
  const onComposerDragLeave = (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropActive(false); };
  const onComposerDrop = (e) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    setDropActive(false);
    let data = null;
    try { data = JSON.parse(e.dataTransfer.getData('application/x-docvex-files')); } catch { /* malformed */ }
    // Folders can be dragged to move within the Files tab, but only files can
    // be attached as AI context — skip any folder in the payload.
    const incoming = (data?.items || []).filter((d) => d?.path && d.kind !== 'folder').map((d) => ({ name: d.name, path: d.path }));
    if (incoming.length) openActionSheet(incoming);
  };
  const removeAttachment = (path) => setAttachments((cur) => cur.filter((a) => a.path !== path));

  // Pane-wide drop zone — drag a file anywhere over the AI tab (not just the
  // composer) to attach it. While hovering we show a modal preview built from
  // the in-app drag bus (dragover can't read the dataTransfer payload itself).
  const addAttachments = (incoming) => {
    if (!incoming.length) return;
    setAttachments((cur) => {
      const seen = new Set(cur.map((a) => a.path));
      return [...cur, ...incoming.filter((a) => a.path && !seen.has(a.path))];
    });
  };

  // ── Drop action sheet ───────────────────────────────────────────────
  // On drop we don't attach immediately — instead we open a sheet showing the
  // file on the left and a vertical list of content-aware suggestion pills on
  // the right (last pill = "Other"). Picking a suggestion attaches the file(s)
  // and sends that prompt; "Other" just attaches them and focuses the composer.
  const enrichDescriptors = (items) => {
    const bus = getDraggedFiles() || [];
    const byPath = new Map(bus.map((b) => [b.path, b]));
    return items.map((it) => ({ ...it, descriptor: it.descriptor ?? byPath.get(it.path)?.descriptor }));
  };
  const openActionSheet = (incoming) => {
    const files = enrichDescriptors(incoming.filter((a) => a?.path));
    if (!files.length) return;
    // Focus this split pane so its footer (the composer) appears — a drop
    // doesn't fire the mousedown that normally selects a pane.
    try { rootRef.current?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch { /* no-op */ }
    // Auto-select a fresh AI chat for the dropped file — create one when none
    // exists, or when the current thread already has messages (so we don't pile
    // up blank chats).
    const cur = threads.find((t) => t.id === activeId);
    if (!cur || (cur.messages?.length || 0) > 0) newChat();
    const primary = files[0];
    const token = ++suggestToken.current;
    setPendingDrop({ files, primary });
    setChosenAction(null);
    setDepthIdx(1);
    setFileSelected(false);
    setFileProps(false);
    // Show skeletons until the AI's options arrive (no instant heuristic flash);
    // the count then follows whatever the AI returns.
    setSuggestions([]);
    setSuggestLoading(true);
    enhanceSuggestions(primary, token);
    // The footer is the "Other" option — focus it so the user can just type.
    requestAnimationFrame(() => taRef.current?.focus());
  };
  const enhanceSuggestions = async (file, token) => {
    setSuggestLoading(true);
    let excerpt = '';
    let mimeType = '';
    try {
      const blob = file.file || await readLocalBlob(file.path);
      mimeType = blob.type || '';
      const res = await extractFileText(blob, file.name);
      if (res.text) excerpt = res.text.slice(0, 6000);
    } catch { /* no readable content — suggest from name/type only */ }
    const { suggestions: ai, error } = await suggestFileActions({ fileName: file.name, excerpt, mimeType });
    if (token !== suggestToken.current) return; // sheet closed / superseded
    // AI options when available (variable count); otherwise the heuristic set.
    setSuggestions(!error && ai?.length
      ? ai.map((s, i) => ({ key: `ai-${i}`, label: s.label, prompt: s.prompt }))
      : heuristicSuggestions(file));
    setSuggestLoading(false);
  };
  const closeActionSheet = () => {
    suggestToken.current += 1; // invalidate any in-flight AI suggestion
    setPendingDrop(null);
    setSuggestions([]);
    setSuggestLoading(false);
    setChosenAction(null);
    setDepthIdx(1);
    setFileSelected(false);
    setFileProps(false);
  };
  // Picking an action no longer sends immediately — it advances to step 2 where
  // the user picks how detailed the answer should be (the depth slider).
  const runSuggestion = (s) => { setChosenAction(s); setDepthIdx(1); };
  // Step 2 confirm: append the chosen depth instruction to the action prompt and
  // send (carrying the dropped file as context).
  const confirmDepth = () => {
    const s = chosenAction;
    if (!s) return;
    const files = pendingDrop?.files || [];
    const instr = DEPTH[depthIdx]?.instr || '';
    const prompt = instr ? `${s.prompt}\n\n${instr}` : s.prompt;
    closeActionSheet();
    send(prompt, files);
  };
  // Sidebar dropped-file actions: open in the OS / default app.
  const openDroppedFile = () => {
    const p = pendingDrop?.primary?.path;
    if (p && !String(p).startsWith('picked:')) { try { localFolderApi.openPath(p); } catch { /* ignore */ } }
  };
  // Attach button → OS file picker. We keep the File blob on the attachment so
  // its contents can be read without a filesystem path.
  const onPickFiles = (e) => {
    const files = Array.from(e.target.files || []);
    const incoming = files.map((file, i) => ({
      name: file.name,
      path: `picked:${file.name}:${file.size}:${file.lastModified}:${i}`,
      file,
    }));
    addAttachments(incoming);
    e.target.value = ''; // allow re-picking the same file
  };
  const onPaneDragEnter = (e) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    if (!dragPreview) setDragPreview((getDraggedFiles() || []).filter((f) => f.kind !== 'folder'));
  };
  const onPaneDragOver = (e) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onPaneDragLeave = (e) => {
    if (!acceptsFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragPreview(null);
  };
  const onPaneDrop = (e) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragPreview(null);
    setDropActive(false);
    let data = null;
    try { data = JSON.parse(e.dataTransfer.getData('application/x-docvex-files')); } catch { /* malformed */ }
    let incoming = (data?.items || []).filter((d) => d?.path && d.kind !== 'folder').map((d) => ({ name: d.name, path: d.path }));
    if (!incoming.length) incoming = (getDraggedFiles() || []).filter((f) => f.kind !== 'folder').map((f) => ({ name: f.name, path: f.path }));
    incoming = incoming.filter((a) => a.path);
    if (incoming.length) openActionSheet(incoming);
  };

  const selectThread = (id) => {
    if (id === activeId) return;
    setActiveId(id);
    setVal('');
  };

  const deleteThread = (id) => {
    // Deleting the last chat leaves the list empty (no forced new chat) — the
    // empty state takes over.
    const next = threads.filter((t) => t.id !== id);
    setThreads(next);
    if (id === activeId) setActiveId(next[0]?.id ?? null);
  };

  const hasThreads = threads.length > 0;
  // Newest first.
  const orderedAll = [...threads].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  // Filter the chat list by the topbar search query (title match, case-insensitive).
  const chatQuery = chatSearch.trim().toLowerCase();
  const ordered = chatQuery
    ? orderedAll.filter((t) => (t.title || '').toLowerCase().includes(chatQuery))
    : orderedAll;

  // ── Custom overlay scrollbar ────────────────────────────────────────────
  // Native scrollbars are hidden in CSS; this thumb floats over the list's
  // right edge, so showing it never changes the items' width.
  const measureThumb = () => {
    const el = listRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 1) { setSb((s) => (s.enabled ? { ...s, enabled: false } : s)); return; }
    const h = Math.max(28, (clientHeight / scrollHeight) * clientHeight);
    const maxY = clientHeight - h;
    const denom = scrollHeight - clientHeight;
    const y = denom > 0 ? Math.min(maxY, Math.max(0, (scrollTop / denom) * maxY)) : 0;
    if (sbThumbRef.current) {
      sbThumbRef.current.style.height = `${h}px`;
      sbThumbRef.current.style.transform = `translateY(${y}px)`;
    }
    setSb((s) => (s.enabled ? s : { ...s, enabled: true }));
  };
  const flashScrollbar = () => {
    setSb((s) => (s.enabled && !s.show ? { ...s, show: true } : s));
    if (sbHideTimer.current) clearTimeout(sbHideTimer.current);
    sbHideTimer.current = setTimeout(() => { if (!sbDrag.current) setSb((s) => ({ ...s, show: false })); }, 1100);
  };
  const onListScroll = () => {
    if (listScrollRaf.current == null) {
      listScrollRaf.current = requestAnimationFrame(() => {
        listScrollRaf.current = null;
        measureThumb();
        flashScrollbar();
      });
    }
  };
  const onThumbDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = listRef.current;
    if (!el) return;
    sbDrag.current = { startY: e.clientY, startScroll: el.scrollTop };
    setSb((s) => ({ ...s, show: true }));
    const onMove = (ev) => {
      const d = sbDrag.current;
      const el2 = listRef.current;
      if (!d || !el2) return;
      const { scrollHeight, clientHeight } = el2;
      const h = Math.max(28, (clientHeight / scrollHeight) * clientHeight);
      const maxY = clientHeight - h;
      const perPx = maxY > 0 ? (scrollHeight - clientHeight) / maxY : 0;
      el2.scrollTop = d.startScroll + (ev.clientY - d.startY) * perPx;
    };
    const onUp = () => {
      sbDrag.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      flashScrollbar();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  // Recompute the thumb whenever the list's size or content changes.
  useEffect(() => {
    measureThumb();
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measureThumb());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ordered.length, hasThreads, pendingDrop, railCollapsed]); // eslint-disable-line react-hooks/exhaustive-deps
  // Clear the hide timer on unmount.
  useEffect(() => () => { if (sbHideTimer.current) clearTimeout(sbHideTimer.current); }, []);

  // ── Custom overlay scrollbar for the message thread ──────────────────────
  // Position the thumb by writing its DOM style DIRECTLY (via ref) rather than
  // through React state — updating state on every scroll frame re-rendered the
  // whole (large) component and dropped the frame rate. State is only touched
  // when `enabled` flips (rare). h/y are written to the node inline.
  const measureMsgThumb = () => {
    const el = scroller.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 1) { setMsgSb((s) => (s.enabled ? { ...s, enabled: false } : s)); return; }
    const h = Math.max(28, (clientHeight / scrollHeight) * clientHeight);
    const maxY = clientHeight - h;
    const denom = scrollHeight - clientHeight;
    const y = denom > 0 ? Math.min(maxY, Math.max(0, (scrollTop / denom) * maxY)) : 0;
    if (msgThumbRef.current) {
      msgThumbRef.current.style.height = `${h}px`;
      msgThumbRef.current.style.transform = `translateY(${y}px)`;
    }
    setMsgSb((s) => (s.enabled ? s : { ...s, enabled: true }));
  };
  const flashMsgScrollbar = () => {
    // Only re-render to SHOW when not already shown (avoids a re-render per frame).
    setMsgSb((s) => (s.enabled && !s.show ? { ...s, show: true } : s));
    if (msgSbHideTimer.current) clearTimeout(msgSbHideTimer.current);
    msgSbHideTimer.current = setTimeout(() => { if (!msgSbDrag.current) setMsgSb((s) => ({ ...s, show: false })); }, 1100);
  };
  const onMsgScroll = () => {
    // Cheap, every event: track whether the view is at the bottom so auto-scroll
    // only "sticks" while the user hasn't scrolled up.
    const el = scroller.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    // Measuring + showing the thumb is rAF-throttled so it runs once per frame.
    if (msgScrollRaf.current == null) {
      msgScrollRaf.current = requestAnimationFrame(() => {
        msgScrollRaf.current = null;
        measureMsgThumb();
        flashMsgScrollbar();
      });
    }
  };
  const onMsgThumbDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = scroller.current;
    if (!el) return;
    msgSbDrag.current = { startY: e.clientY, startScroll: el.scrollTop };
    setMsgSb((s) => ({ ...s, show: true }));
    const onMove = (ev) => {
      const d = msgSbDrag.current;
      const el2 = scroller.current;
      if (!d || !el2) return;
      const { scrollHeight, clientHeight } = el2;
      const h = Math.max(28, (clientHeight / scrollHeight) * clientHeight);
      const maxY = clientHeight - h;
      const perPx = maxY > 0 ? (scrollHeight - clientHeight) / maxY : 0;
      el2.scrollTop = d.startScroll + (ev.clientY - d.startY) * perPx;
    };
    const onUp = () => {
      msgSbDrag.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      flashMsgScrollbar();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  // Recompute the message thumb when the thread / its size changes.
  useEffect(() => {
    measureMsgThumb();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measureMsgThumb());
    ro.observe(el);
    return () => ro.disconnect();
  }, [messages.length, streaming, hasThreads, activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (msgSbHideTimer.current) clearTimeout(msgSbHideTimer.current); }, []);
  // Stop the typewriter when the user switches threads (don't re-animate an old
  // message when they come back to it).
  useEffect(() => { setTyping(null); }, [activeId]);

  // Right-click menu for the sidebar dropped-file card (the app's morph-pill
  // tooltip): Open + Properties.
  const fileMorph = useMorphPill({
    hoverContent: pendingDrop?.primary?.name || '',
    menuItems: [
      { key: 'open', label: 'Open', onClick: openDroppedFile },
      { key: 'props', label: 'Properties', onClick: () => setFileProps(true) },
    ],
  });

  // Composer — the Chat window's composer verbatim, portalled into the pane
  // footer (flattened there by ProjectChatVariantB.css's `.sv-footer` rules).
  const composer = (
    <div
      className={`vb-composer-wrap${dropActive ? ' aichat-dropping' : ''}`}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
    >
      {attachments.length > 0 && (
        <div className="aichat-attachments">
          {attachments.map((a) => (
            <span className="aichat-attach-chip" key={a.path}>
              {I.file({ width: 13, height: 13 })}
              <span className="aichat-attach-name" title={a.name}>{a.name}</span>
              <button type="button" className="aichat-attach-x" onClick={() => removeAttachment(a.path)} aria-label={`Remove ${a.name}`}>{I.x({ width: 12, height: 12 })}</button>
            </span>
          ))}
        </div>
      )}
      <div className="dvx-composer">
        <textarea
          ref={taRef}
          className="dvx-composer-textarea"
          rows={1}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={pendingDrop ? `Tell DocVex AI what to do with ${pendingDrop.primary.name}…` : 'Message DocVex AI…'}
          maxLength={4000}
        />
        <div className="dvx-composer-toolbar">
          <button type="button" className="dvx-composer-btn" title="Attach files" aria-label="Attach files" onClick={() => fileInputRef.current?.click()}>{I.paperclip({ width: 16, height: 16 })}</button>
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={onPickFiles} />
          {/* File context is always on — answers are grounded in your files
              automatically (no toggle). */}
          <div className="dvx-composer-toolbar-spacer" />
          <button type="button" className="dvx-composer-btn dvx-composer-send" onClick={() => send()} disabled={streaming || !val.trim()} title="Send" aria-label="Send">{I.send({ width: 16, height: 16 })}</button>
        </div>
      </div>
    </div>
  );

  // Per-window controls portalled into the pane chrome's row-2 slot: the icon-
  // only rail collapse toggle on the left (in line with the header), and the
  // active chat's name on the right — directly under the tab-select dropdown.
  // Nothing to show when there are no chats (sidebar hidden, no active chat).
  const chromeTools = hasThreads ? (
    <div className="aichat-chrome-tools">
      {/* Left — collapse toggle (hidden while a dropped file forces the rail open). */}
      <div className="aichat-chrome-left">
        {!pendingDrop && (
          <button
            type="button"
            className={`aichat-chrome-btn aichat-chrome-collapse${railCollapsed ? ' is-collapsed' : ''}`}
            onClick={() => setRailCollapsed((v) => !v)}
            title={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {I.panelLeft({ width: 16, height: 16 })}
          </button>
        )}
      </div>
      {/* Centre — the active chat pill. */}
      {activeThread && (
        <span className="aichat-chrome-chatname" title={activeThread.title}>
          {I.chat({ width: 16, height: 16 })}
          <span>{activeThread.title || 'Unnamed chat'}</span>
        </span>
      )}
      {/* Right — search the chat list. */}
      <div className="aichat-chrome-right">
        <div className={`aichat-chrome-search${chatSearch ? ' is-active' : ''}`}>
          {I.search({ width: 15, height: 15 })}
          <input
            ref={searchRef}
            type="text"
            value={chatSearch}
            onChange={(e) => setChatSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && chatSearch) { e.stopPropagation(); setChatSearch(''); } }}
            placeholder="Search chats"
            aria-label="Search chats"
          />
          {chatSearch ? (
            <button type="button" className="aichat-chrome-search-clear" onClick={() => { setChatSearch(''); searchRef.current?.focus(); }} aria-label="Clear search">
              {I.x({ width: 13, height: 13 })}
            </button>
          ) : (
            <span className="aichat-chrome-search-kbd">
              <kbd>{/mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd>
              <span className="aichat-chrome-search-kbd-plus">+</span>
              <kbd>F</kbd>
            </span>
          )}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div
      ref={rootRef}
      className="ai-hub ai-chat-page"
      onDragEnter={onPaneDragEnter}
      onDragOver={onPaneDragOver}
      onDragLeave={onPaneDragLeave}
      onDrop={onPaneDrop}
    >
      {dragPreview && (
        <div className="aichat-drop-modal" aria-hidden="true">
          <div className="aichat-drop-card">
            <div className="aichat-drop-heading">Attach to chat</div>
            <div className="aichat-drop-files">
              {(dragPreview.length ? dragPreview : [{ name: 'File', path: '_' }]).map((f, i) => (
                <div className="aichat-drop-file" key={f.path || i}>
                  <div className="aichat-drop-thumb">
                    <FileThumbnail descriptor={f.descriptor} />
                  </div>
                  <div className="aichat-drop-name" title={f.name}>{f.name}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {/* No pane chrome (rare) → render the window controls as an in-page bar. */}
      {!chromeEl && chromeTools && <div className="aichat-chrome-bar">{chromeTools}</div>}
      <div className="aichat-shell">
        {/* Conversation rail — hidden entirely when there are no chats (the
            empty state takes over). Titles are auto-generated (no manual rename). */}
        {hasThreads && (
        <aside className={`aichat-rail${railCollapsed && !pendingDrop ? ' is-collapsed' : ''}${pendingDrop ? ' has-dropfile' : ''}`}>
          {/* Collapse toggle + New chat now live in the window chrome (topbar). */}
          {/* Dropped file lands here as a thumbnail card while its actions show
              in the chat area; animates in/out. */}
          {pendingDrop && (
            <>
              <div
                className={`aichat-rail-file${fileSelected ? ' is-selected' : ''}`}
                key={pendingDrop.primary.path}
                role="button"
                tabIndex={0}
                onClick={() => setFileSelected(true)}
                onDoubleClick={openDroppedFile}
                onMouseMove={fileMorph.handleMouseMove}
                onMouseLeave={fileMorph.handleMouseLeave}
                onContextMenu={fileMorph.handleContextMenu}
                onKeyDown={(e) => { if (e.key === 'Enter') openDroppedFile(); }}
              >
                <div className="aichat-rail-file-thumb">
                  <FileThumbnail descriptor={pendingDrop.primary.descriptor} glyph={I.file({ width: 36, height: 36 })} />
                </div>
                <div className="aichat-rail-file-name" title={pendingDrop.primary.name}>{pendingDrop.primary.name}</div>
                {pendingDrop.files.length > 1 && (
                  <div className="aichat-rail-file-more">+{pendingDrop.files.length - 1} more file{pendingDrop.files.length - 1 === 1 ? '' : 's'}</div>
                )}
              </div>
              {fileMorph.node}
            </>
          )}
          <div
            className="aichat-list-wrap"
            onMouseEnter={() => setSb((s) => (s.enabled ? { ...s, show: true } : s))}
            onMouseLeave={() => { if (!sbDrag.current) setSb((s) => ({ ...s, show: false })); }}
          >
            <div className="aichat-list" ref={listRef} onScroll={onListScroll}>
              {/* "Chats" header with the New-chat button in line; collapsed → just the + */}
              <div className="aichat-list-head">
                <span className="aichat-list-label">Chats</span>
                <button type="button" className="aichat-list-newchat" onClick={newChat} title="New chat" aria-label="New chat">
                  {I.plus({ width: 15, height: 15 })}
                  <span className="aichat-list-newchat-label">New chat</span>
                </button>
              </div>
              {ordered.map((t) => (
                <div
                  key={t.id}
                  className={`aichat-item${t.id === activeId ? ' is-active' : ''}`}
                  style={{ '--chat-accent': hashColor(t.id) }}
                  onClick={() => selectThread(t.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') selectThread(t.id); }}
                >
                  <span className="aichat-item-ico">{I.chat({ width: 15, height: 15 })}</span>
                  <span className="aichat-item-title" title={t.title}>{t.title}</span>
                  <span className="aichat-item-actions">
                    <button type="button" title="Delete" aria-label="Delete chat" onClick={(e) => { e.stopPropagation(); deleteThread(t.id); }}>{I.x({ width: 14, height: 14 })}</button>
                  </span>
                </div>
              ))}
            </div>
            {/* Custom overlay scrollbar — floats over the list, no layout shift. */}
            <div className={`aichat-scrollbar${sb.enabled && sb.show ? ' is-visible' : ''}`} aria-hidden="true">
              <div
                ref={sbThumbRef}
                className="aichat-scrollbar-thumb"
                onMouseDown={onThumbDown}
              />
            </div>
          </div>
        </aside>
        )}

        {/* Active conversation. */}
        <div className={`aichat-main${pendingDrop ? ' has-dropactions' : ''}`}>
          {/* Suggestion pills for the dropped file — skeletons until the AI's
              options load, then a vertical list (count follows the AI). The
              footer message box is the "Other" / custom-instruction option. */}
          {pendingDrop && (
            <div className="aichat-drop-panel">
              <button type="button" className="aichat-drop-close" onClick={closeActionSheet} aria-label="Cancel" title="Cancel">{I.x({ width: 18, height: 18 })}</button>
              {!chosenAction ? (
                /* Step 1 — pick what to do. */
                <div className="aichat-drop-actions" role="dialog" aria-label="Choose what to do with the file">
                  <div className="aichat-action-head">
                    <span>What do you want to do with <strong>{pendingDrop.primary.name}</strong>?</span>
                  </div>
                  {suggestLoading && suggestions.length === 0
                    ? Array.from({ length: 4 }).map((_, i) => (
                        <div key={`sk-${i}`} className="aichat-action-pill is-skeleton" style={{ '--pill-i': i }} aria-hidden="true">
                          <span className="aichat-skeleton-bar" />
                        </div>
                      ))
                    : suggestions.map((s, idx) => (
                        <button key={s.key} type="button" className="aichat-action-pill" style={{ '--pill-i': idx }} onClick={() => runSuggestion(s)} title={s.prompt}>
                          <span className="aichat-action-pill-label">{s.label}</span>
                          {I.caret({ width: 15, height: 15 })}
                        </button>
                      ))}
                  <div className="aichat-action-other-hint">Or type your own instruction in the message box below.</div>
                </div>
              ) : (
                /* Step 2 — choose how detailed the answer should be. */
                <div className="aichat-drop-actions" role="dialog" aria-label="Choose the level of detail">
                  <div className="aichat-action-head aichat-step2-head">
                    <button type="button" className="aichat-step-back" onClick={() => setChosenAction(null)} aria-label="Back" title="Back">{I.caret({ width: 16, height: 16 })}</button>
                    <span>How detailed should the answer be?</span>
                  </div>
                  <div className="aichat-depth-chosen">{chosenAction.label}</div>
                  <div className="aichat-depth">
                    <input
                      type="range"
                      className="aichat-depth-slider"
                      min={0}
                      max={2}
                      step={1}
                      value={depthIdx}
                      onChange={(e) => setDepthIdx(Number(e.target.value))}
                      style={{ '--depth-pct': `${(depthIdx / 2) * 100}%` }}
                      aria-label="Level of detail"
                    />
                    <div className="aichat-depth-ticks">
                      {DEPTH.map((d, i) => (
                        <button key={d.key} type="button" className={`aichat-depth-tick${i === depthIdx ? ' is-active' : ''}`} onClick={() => setDepthIdx(i)}>{d.label}</button>
                      ))}
                    </div>
                    <div className="aichat-depth-desc">{DEPTH[depthIdx].desc}</div>
                  </div>
                  <button type="button" className="aichat-depth-go" onClick={confirmDepth}>{I.send({ width: 15, height: 15 })}<span>Ask DocVex AI</span></button>
                </div>
              )}
            </div>
          )}
          {/* Empty active chat → a centered hint that you can type or drag files. */}
          {hasThreads && messages.length === 0 && !streaming && !pendingDrop && (
            <div className="aichat-convo-empty">
              <div className="aichat-convo-empty-title">How can I help?</div>
              <div className="aichat-convo-empty-sub">Type a message below, or drag files anywhere here to add them as context.</div>
            </div>
          )}
          {hasThreads ? (
          <div
            className="aichat-scroll-wrap"
            onMouseEnter={() => setMsgSb((s) => (s.enabled ? { ...s, show: true } : s))}
            onMouseLeave={() => { if (!msgSbDrag.current) setMsgSb((s) => ({ ...s, show: false })); }}
          >
          <div className="aichat-scroll" ref={scroller} onScroll={onMsgScroll}>
            <div className="chat">
              {messages.map((m, i) => {
                const prev = i > 0 ? messages[i - 1] : null;
                const showDay = m.at && (!prev || !prev.at || !sameLocalDay(prev.at, m.at));
                return (
                <React.Fragment key={i}>
                {showDay && (
                  <div className="aichat-day-divider" role="separator">
                    <span className="aichat-day-divider-label">{formatDayLabel(m.at)}</span>
                  </div>
                )}
                <div className={`bubble ${m.who === 'me' ? 'me' : ''}`}>
                  <div className="bubble-c">
                    <div className="bubble-msg">
                      {m.who === 'me'
                        ? m.text
                        : (typing && typing.threadId === activeId && typing.index === i)
                          ? (
                            <Typewriter
                              text={m.text || ''}
                              onTick={scrollToBottom}
                              onDone={() => setTyping(null)}
                            />
                          )
                          : (
                            <div className="aichat-md">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text || ''}</ReactMarkdown>
                            </div>
                          )}
                    </div>
                    {m.who === 'me' && (m.attachments || []).length > 0 && (
                      <div className="aichat-msg-attachments">
                        {m.attachments.map((n, k) => (
                          <span className="aichat-attach-chip is-static" key={k}>{I.file({ width: 12, height: 12 })}<span className="aichat-attach-name" title={n}>{n}</span></span>
                        ))}
                      </div>
                    )}
                    {m.who === 'me' && m.at && (
                      <span className="aichat-time">{formatHM(m.at)}</span>
                    )}
                    {/* Per-response actions (Copy / Retry), shown under each AI
                        answer once its typewriter reveal has finished. */}
                    {m.who !== 'me' && !m.isError
                      && !(typing && typing.threadId === activeId && typing.index === i) && (
                      <div className="aichat-msg-actions">
                        <button
                          type="button"
                          className="aichat-msg-action"
                          title="Copy"
                          aria-label="Copy message"
                          onClick={() => copyMessage(m.text || '', i)}
                        >
                          {copiedIdx === i ? I.check({ width: 14, height: 14 }) : I.copy({ width: 14, height: 14 })}
                          <span>{copiedIdx === i ? 'Copied' : 'Copy'}</span>
                        </button>
                        <button
                          type="button"
                          className="aichat-msg-action"
                          title="Retry"
                          aria-label="Regenerate response"
                          onClick={() => regenerate(i)}
                          disabled={streaming}
                        >
                          {I.refresh({ width: 14, height: 14 })}
                          <span>Retry</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                </React.Fragment>
                );
              })}
              {streaming && (
                <div className="bubble">
                  <div className="bubble-c">
                    <div className="bubble-msg"><ThinkingStatus query={messages.length ? messages[messages.length - 1]?.text : ''} /></div>
                  </div>
                </div>
              )}
            </div>
          </div>
            {/* Custom overlay scrollbar — floats over the thread, no layout shift. */}
            <div className={`aichat-msg-scrollbar${msgSb.enabled && msgSb.show ? ' is-visible' : ''}`} aria-hidden="true">
              <div
                ref={msgThumbRef}
                className="aichat-msg-scrollbar-thumb"
                onMouseDown={onMsgThumbDown}
              />
            </div>
          </div>
          ) : (
            <div className="aichat-empty">
              <div className="aichat-empty-card">
                <span className="aichat-empty-glyph">{I.chat({ width: 30, height: 30 })}</span>
                <div className="aichat-empty-title">No chats yet</div>
                <div className="aichat-empty-sub">You don’t have any conversations. Start a new chat to talk with DocVex AI.</div>
                <button type="button" className="aichat-empty-btn" onClick={newChat}>
                  {I.plus({ width: 16, height: 16 })}
                  <span>New chat</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* File "Properties" modal (from the file card's right-click menu). */}
      {fileProps && pendingDrop && (
        <div className="aichat-props-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setFileProps(false); }}>
          <div className="aichat-props-card" role="dialog" aria-label="File properties">
            <div className="aichat-props-head">
              <span>Properties</span>
              <button type="button" className="aichat-props-x" onClick={() => setFileProps(false)} aria-label="Close">{I.x({ width: 16, height: 16 })}</button>
            </div>
            <div className="aichat-props-thumb">
              <FileThumbnail descriptor={pendingDrop.primary.descriptor} glyph={I.file({ width: 40, height: 40 })} />
            </div>
            <dl className="aichat-props-list">
              <div><dt>Name</dt><dd title={pendingDrop.primary.name}>{pendingDrop.primary.name}</dd></div>
              <div><dt>Type</dt><dd>{(() => { const n = pendingDrop.primary.name || ''; const i = n.lastIndexOf('.'); return i > 0 ? `${n.slice(i + 1).toUpperCase()} file` : 'File'; })()}</dd></div>
              <div><dt>Location</dt><dd title={pendingDrop.primary.path}>{String(pendingDrop.primary.path || '').startsWith('picked:') ? 'Picked file' : pendingDrop.primary.path}</dd></div>
            </dl>
          </div>
        </div>
      )}

      {chromeEl && createPortal(chromeTools, chromeEl)}
      {/* No composer when there are no chats — the empty state's button is the
          only entry point. */}
      {hasThreads && (footerEl ? createPortal(composer, footerEl) : composer)}
    </div>
  );
}
