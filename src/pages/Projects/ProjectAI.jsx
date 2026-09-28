import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { withStyleSteer } from '../../lib/writingStyle';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { splitChoices, withChoicesRule, dropUnanswered } from '../../lib/aiChoices';
import AiChoices from '../../components/AiChoices';
import { nextPrompts } from '../../lib/advisorPrompts';
import { splitEdits, withEditRule, applyReplyEdits } from '../../lib/aiFileEdits';
import AiEdits from '../../components/AiEdits';
// The files an answer comes from (lib/aiSources — the Insights question box's
// sources, moved here): a ```sources block, taken out of the text first.
import { splitSources, withSourcesRule, foldRuleExchanges, resolveSources, caseStarterPrompts } from '../../lib/aiSources';
import { getAiFacet } from '../../lib/aiData';
const replyBody = (t) => splitChoices(splitEdits(splitSources(t).body).body).body;
const replyChoices = (t) => splitChoices(splitEdits(splitSources(t).body).body).choices;
const replySources = (t) => splitSources(t).sources;
import remarkGfm from 'remark-gfm';
// Cursor deltas are viewport px; CSS lengths are layout px — the two differ
// under the web display-scale zoom (see lib/appZoom).
import { toLayoutPx } from '../../lib/appZoom';
import { useMiniGlowSpot } from '../../lib/pointerSpots';
import { useAuth } from '../../context/AuthContext';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { ICONS as I } from './aiHub';
import { askProjectAi, makeAskAnswers } from '../../lib/projectAi';
import { buildDocumentBlobSmart, extOf, inferDocKind, mimeForKind } from '../../lib/documentGen';
import { notifyFilesChanged, openDocViewerWindow } from '../../lib/platform';
import { describeLocalFile } from '../../lib/thumbnailDescriptor';
import FileThumbnail from '../../components/FileThumbnail';
// The Files tab's own per-type glyph (Word blue, Excel green, PDF red…), so a
// file the advisor made looks the same here as it does in the Files grid.
import { ExtGlyph } from '../../components/fileGlyph';
import { useNotifications } from '../../context/NotificationsContext';
import AskUserPanel from '../../components/AskUserPanel';
import { readLocalBlob, localFolderApi } from '../../lib/localFolder';
import { readProjectsDir } from '../../lib/projectsDir';
import { extractFileText } from '../../lib/extractFileText';
import { buildProjectDigest } from '../../lib/aiProjectContext';
import { getDraggedFiles } from '../../lib/fileDragBus';
import { useChatFind } from '../../lib/useChatFind';
import Tooltip from '../../components/Tooltip';
import PageMasthead from '../../components/PageMasthead';
import LegalTabs, { RailToggle } from '../../components/LegalTabs';
import '../../components/LegalTabs.css';
import gavelLoader from '../../gavel-loader.svg';
import '../../lib/useChatFind.css'; // the search box's "N chats" count chip
import './ProjectScoped.css';
import {
  subscribeChats, chatsState, bindChats, setChats, selectChat, openNewChat, closeChat,
  closeOtherChats, reopenClosedChat, toggleChatPin, moveChat, isBlankChat, chatMeta,
} from '../../lib/advisorChats';
import { useRailSpotlight } from '../../lib/pointerSpots';
import { useItemSpots } from '../../components/DocRibbon';
import '../../components/LegalWorkspace.css';
import '../../components/LegalBrowser.css';
import { embedDocxSource, sourcePayload } from '../../lib/docxSource';
import './ProjectAI.css';
import '../LegalSourceStub.css';
import './ProjectChatVariantB.css';
import './ProjectAIChat.css';

// AI — the project's AI chat. Laid out like the Chat tab (ProjectChat): a big
// Files-style masthead (.dvx-mh) that scrolls away, a sticky tools/tabs bar
// (.dvx-toolbar) that pins as the mini header, the thread flowing in the page
// scroll (.dvx-scroll-area), and the composer docked in the window footer.
// Two tabs: Chat (the assistant, with a left rail of saved conversations) and
// Debug (intentionally empty for now). Conversations persist per user+project
// in localStorage. The assistant reads the files in the project's Files tab:
// their names ground every answer, and any file the user attaches (paperclip /
// drag from Files) or mentions by name gets its text extracted and inlined.

// Also read by lib/projectSyncData — keep the two in step.
const STORAGE_PREFIX = 'docvex.aichat.v3.';

// Steer note appended (transiently) to each turn: the model may CREATE real
// files in the project's Files tab via write_document, must ask_user when
// unsure, and otherwise just answers. Mirrors the Doc Viewer generate steer.
// Data collections (`.dvc`) are made by the Files tab's AI scan, never
// written by hand or by the advisor.
const DVC_STEER = 'You cannot create `.dvc` Data collection files (or the retired `.dvx` identity records): Data collections are made by the Files tab\'s AI scan — tell the user to tag the files and run it.';

const FILE_STEER = '[Meta: You can CREATE real files in this project\'s Files tab with the write_document tool — give it the COMPLETE file content. Use it when the user clearly asks you to create, draft, generate, convert or export a document/file. '
  + 'ANY file type is allowed, not only Office ones: `docx`, `pptx`, `xlsx` and `pdf` are BUILT from the text you write (its headings, lists and tables become real document structure); every text-based format — `txt`, `md`, `csv`, `json`, `xml`, `html`, `srt`, `ics`, `yaml`, source code and so on — is written EXACTLY as you give it, so for those `content` must be the finished file, valid for that format, with nothing around it (no markdown fences, no commentary). Name the file with the extension you want and it will be written. '
  + 'The tool\'s `kind` field only chooses the builder for the four Office/PDF kinds; for anything else it is ignored — put the extension you want in the filename and write the file\'s exact contents. Never refuse a format because the tool lists four kinds. '
  + 'You cannot create binary media (images, audio, video, archives) — say so and offer an alternative instead. '
  + DVC_STEER + ' '
  + 'The FIRST line of the tool\'s `summary` field MUST be a header of the exact form `[file: <filename> | folder: <folder>]`. Use the exact file name and the exact folder the user asked for; when the user did not specify a name, choose a short descriptive filename that reflects the document\'s content; when they did not specify a location, use `home` (the project\'s root Files directory). Folders are relative paths inside the project (e.g. `contracts/2026`) — never absolute paths. After that header line, write a one-sentence summary of the document. '
  + 'If you are UNSURE whether they want a file created — or which kind, or what should go in it — call ask_user FIRST instead of guessing. If they are just chatting or asking questions, answer normally in text. Never silently create a file when you are unsure.]';

// ── What the advisor can write ───────────────────────────────────────────
// The four kinds that are BUILT from the model's prose (real Office / PDF
// files, structure and all). Everything else text-based is written verbatim.
const BUILT_KINDS = new Set(['docx', 'pptx', 'xlsx', 'pdf']);
// Formats whose bytes cannot come out of a language model. Refused by name so
// the reply says why, instead of writing prose into a file called .png.
const BINARY_ONLY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'ico', 'heic', 'heif', 'psd', 'ai', 'eps', 'raw',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv',
  'zip', 'rar', '7z', 'tar', 'gz', 'exe', 'msi', 'dll', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp',
]);
// Content types for the text formats worth naming; everything else is plain
// UTF-8 text, which is what the remaining text formats actually are.
const TEXT_MIMES = {
  dvx: 'application/json', dvc: 'application/json', json: 'application/json', csv: 'text/csv', tsv: 'text/tab-separated-values',
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', log: 'text/plain',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', svg: 'image/svg+xml',
  yaml: 'application/yaml', yml: 'application/yaml', ics: 'text/calendar',
  srt: 'application/x-subrip', vtt: 'text/vtt', rtf: 'application/rtf', sql: 'application/sql',
  js: 'text/javascript', ts: 'text/plain', css: 'text/css', py: 'text/x-python',
};
const mimeForExt = (ext) => TEXT_MIMES[ext] || 'text/plain;charset=utf-8';

// Conversation-rail width bounds (px) for the drag resizer on its divider.
const RAIL_WIDTH_KEY = 'docvex.aichat.railWidth';
// Whether the rail is hidden altogether (the toolbar's panel toggle). Kept
// separate from the width so hiding and re-showing restores the width the user
// dragged to, rather than resetting it.
const RAIL_HIDDEN_KEY = 'docvex.aichat.railHidden';
// The divider band's width (.aichat-resizer's flex-basis) — the hide slide has
// to travel the rail AND its divider to clear the shell's left edge.
const RAIL_DIVIDER_W = 9.6;
const RAIL_MIN = 168;
const RAIL_MAX = 384;
const RAIL_DEFAULT = 216;

function uid() {
  try { return crypto.randomUUID(); } catch { return `t_${Date.now()}_${Math.round(Math.random() * 1e9)}`; }
}

function makeThread() {
  const now = Date.now();
  return { id: uid(), title: 'Unnamed chat', messages: [], createdAt: now, updatedAt: now };
}

// Map UI messages to the Anthropic role/content shape. Error placeholders
// never go back to the model. `apiText` (the message + any attached-file
// context) is preferred over the displayed `text` so file context carries
// across turns without cluttering the bubble.
function toApiMessages(list) {
  // A prompt whose answer never came (an error, a Stop) is dropped, or the
  // model would answer IT instead of the one just sent (lib/aiChoices).
  return dropUnanswered(list.filter((m) => !m.isError && !m.interrupted), (m) => m.who === 'me')
    .map((m) => ({ role: m.who === 'me' ? 'user' : 'assistant', content: m.apiText || m.text || '' }));
}

// Read a set of project files and build a context preamble for the model.
// Text / PDF / Word / Excel contents are extracted and inlined (capped);
// anything unreadable is noted by name so the model knows what it's missing.
async function buildContextBlock(atts, intro) {
  const parts = [];
  for (const a of atts) {
    try {
      // Picked-via-button attachments carry the File blob directly; files from
      // the project folder resolve by path (Electron) or name (web).
      const blob = a.file || await readLocalBlob(a.path || a.name);
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
  return parts.length ? `${intro}\n\n${parts.join('\n\n')}` : '';
}

// Files from the project folder the user's message refers to BY NAME — those
// get read + inlined automatically, so "summarise contract.pdf" just works
// without attaching anything. Full name or the name without its extension
// (min 4 chars, so short generic names don't false-positive); capped at 3.
function findMentionedFiles(text, files, excludeNames) {
  const t = (text || '').toLowerCase();
  const out = [];
  for (const f of files) {
    if (!f?.name || excludeNames.has(f.name)) continue;
    const full = f.name.toLowerCase();
    const base = full.replace(/\.[^.]+$/, '');
    if ((full.length >= 4 && t.includes(full)) || (base.length >= 4 && t.includes(base))) {
      out.push(f);
      if (out.length >= 3) break;
    }
  }
  return out;
}

// Highlight the matched substring of a rail item's title (Windows-Explorer-
// style search feedback). Tooltips keep the plain title.
function highlightMatch(text, q) {
  const t = String(text || '');
  if (!q) return t;
  const i = t.toLowerCase().indexOf(q);
  if (i === -1) return t;
  return (
    <>
      {t.slice(0, i)}
      <mark>{t.slice(i, i + q.length)}</mark>
      {t.slice(i + q.length)}
    </>
  );
}

// Short clock label (e.g. "14:05") for the message time mark.
function formatHM(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

// Date-grouping helpers (mirror the team/private chat).
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

// One plugin list for every Markdown render: a fresh array per render would
// defeat the memo on AiMarkdown below.
const REMARK_PLUGINS = [remarkGfm];

// A finished AI answer, rendered through Markdown. Memoised on its text: the
// page re-renders on every keystroke in the composer, every scrollbar flash and
// every rail hover, and re-parsing the whole thread's Markdown each time is the
// most expensive thing it did. The output is identical — same string in.
const AiMarkdown = React.memo(function AiMarkdown({ text }) {
  return (
    <div className="aichat-md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>
    </div>
  );
});

// Typewriter — reveals an AI answer character-by-character, rendered through
// Markdown as it grows so formatting appears live. `onTick` keeps the thread
// scrolled to the bottom while the text grows.
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
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text.slice(0, n)}</ReactMarkdown>
      <span className="aichat-caret" aria-hidden="true" />
    </div>
  );
}

// Contextual "thinking" status — cycles through short status words picked from
// a set matching what the user asked for (math, writing, files, code, …).
const THINKING_SETS = {
  math: ['Calculating', 'Crunching the numbers', 'Working through the math', 'Checking the figures'],
  write: ['Drafting', 'Composing', 'Choosing the words', 'Polishing'],
  legal: ['Reviewing', 'Checking the clauses', 'Weighing the details', 'Consulting the rules'],
  files: ['Reading your files', 'Scanning the documents', 'Gathering context', 'Looking things up'],
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
      <img className="aichat-thinking-gavel" src={gavelLoader} alt="" aria-hidden="true" />
      <span className="aichat-thinking-text" key={i}>{set[i]}</span>
      <span className="aichat-thinking-dots" aria-hidden="true"><span /><span /><span /></span>
    </span>
  );
}

export default function ProjectAI() {
  useMiniGlowSpot(); // the .mini-glow bar's spotlight (lib/pointerSpots)
  const { session } = useAuth();
  const { selectedProject, loading } = useSelectedProject();
  const user = session?.user;
  const userKey = user?.id || '_anonymous';
  const projectId = selectedProject?.id || null;

  const [tab, setTab] = useState('chat'); // 'chat' | 'debug'
  // Prompts for a lawyer, under an empty chat's greeting — a different
  // handful each time the tab is entered (lib/advisorPrompts).
  // An ENDLESS feed: more are added as the grid is scrolled toward its end.
  const [starters, setStarters] = useState(() => nextPrompts([], 24));
  // Questions about THIS case (the people the scan read), ahead of the rest.
  const [caseStarters, setCaseStarters] = useState([]);
  const moreStarters = () => setStarters((cur) => (cur.length > 600 ? cur : [...cur, ...nextPrompts(cur, 18)]));
  const startersEndRef = useRef(null);
  useEffect(() => {
    const end = startersEndRef.current;
    if (!end || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) moreStarters(); }, { root: end.parentElement, rootMargin: '0px 0px 240px 0px' });
    io.observe(end);
    return () => io.disconnect();
  });
  // The chats are TABS in a store the app sidebar reads too (lib/advisorChats).
  const chats = useSyncExternalStore(subscribeChats, chatsState);
  const threads = chats.threads;
  const activeId = chats.active;
  const setThreads = setChats;
  const setActiveId = selectChat;
  const [val, setVal] = useState('');
  const [streaming, setStreaming] = useState(false);
  // WHICH conversation the in-flight turn belongs to — switching chats/tabs
  // never cancels a turn; the thinking bubble only shows in that thread, and
  // a reply landing in a non-open thread marks it unread (rail + sidebar dot).
  const [streamingThread, setStreamingThread] = useState(null);
  // The AI message being revealed with the typewriter: { threadId, index }.
  const [typing, setTyping] = useState(null);
  const [copiedIdx, setCopiedIdx] = useState(null);
  const [attachments, setAttachments] = useState([]); // [{ name, path, file? }]
  const [dropActive, setDropActive] = useState(false);
  // A paused ask_user turn — the model asked clarifying questions (e.g. before
  // creating a file) and waits for answers. { id, input, assistantContent,
  // base (the exact api messages sent), threadId }.
  const [pendingAsk, setPendingAsk] = useState(null);
  // Selected created-file card (message index) — Files-tab-style selection.
  const [selectedFileCard, setSelectedFileCard] = useState(null);
  const { notify } = useNotifications();
  // Toolbar search — filters the conversation rail like the Windows Explorer
  // search box: type and the list narrows to chats whose title, messages or
  // attachment names contain the query.
  const [chatSearch, setChatSearch] = useState('');
  // Conversation-rail width — drag its right divider to resize (clamped,
  // persisted). Mirrors the team chat's rail splitter.
  const [railWidth, setRailWidth] = useState(() => {
    const n = Number(localStorage.getItem(RAIL_WIDTH_KEY));
    return Number.isFinite(n) && n >= RAIL_MIN && n <= RAIL_MAX ? n : RAIL_DEFAULT;
  });
  const [railResizing, setRailResizing] = useState(false);
  // Hidden rail: the whole conversation column slides out to the left and the
  // thread takes the space. Implemented as a negative margin rather than a
  // collapsing width so nothing INSIDE the rail reflows while it travels — the
  // list keeps its layout width the whole way out and the thread column, which
  // simply follows it, reads as being pushed across.
  const [railHidden, setRailHidden] = useState(() => {
    try { return localStorage.getItem(RAIL_HIDDEN_KEY) === '1'; } catch { return false; }
  });
  const toggleRail = () => {
    setRailHidden((v) => {
      const next = !v;
      try { localStorage.setItem(RAIL_HIDDEN_KEY, next ? '1' : '0'); } catch { /* quota */ }
      return next;
    });
  };
  const startRailResize = (e) => {
    e.preventDefault();
    setRailResizing(true);
    const startX = e.clientX;
    const startW = railWidth;
    let latest = startW;
    const onMove = (ev) => {
      // The rail sits on the LEFT — dragging the divider right widens it.
      latest = Math.max(RAIL_MIN, Math.min(RAIL_MAX, startW + toLayoutPx(ev.clientX - startX)));
      setRailWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setRailResizing(false);
      try { localStorage.setItem(RAIL_WIDTH_KEY, String(Math.round(latest))); } catch { /* quota */ }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // ── Chat-list scrollbar on the divider ─────────────────────────────────
  // The native list scrollbar is hidden; this thumb rides the resizer band,
  // vertically spanning the LIST's portion of the divider. Dragging the thumb
  // scrolls the list; dragging anywhere else on the band resizes the rail.
  const measureRailThumb = () => {
    const list = listRef.current;
    const rz = resizerRef.current;
    const thumb = sbThumbRef.current;
    if (!list || !rz || !thumb) return;
    const { scrollTop, scrollHeight, clientHeight } = list;
    if (scrollHeight <= clientHeight + 1) {
      setRailSb((s) => (s.enabled ? { ...s, enabled: false } : s));
      fadeRailItems(); // clears any leftover per-row fade
      return;
    }
    const listRect = list.getBoundingClientRect();
    const rzRect = rz.getBoundingClientRect();
    // Track = the list's vertical span, offset to where it starts within the
    // (taller) divider band. Rect px are viewport px → toLayoutPx for CSS.
    const track = toLayoutPx(listRect.height);
    const offsetTop = toLayoutPx(listRect.top - rzRect.top);
    const h = Math.max(28, (clientHeight / scrollHeight) * track);
    const maxY = track - h;
    const y = offsetTop + (scrollTop / (scrollHeight - clientHeight)) * maxY;
    // Rows faded (their reads) BEFORE the thumb is resized, so resizing it
    // doesn't dirty layout ahead of those reads.
    fadeRailItems();
    thumb.style.height = `${h}px`;
    thumb.style.transform = `translateY(${y}px)`;
    setRailSb((s) => (s.enabled ? s : { ...s, enabled: true }));
  };
  const flashRailThumb = () => {
    setRailSb((s) => (s.enabled && !s.show ? { ...s, show: true } : s));
    if (sbHideTimer.current) clearTimeout(sbHideTimer.current);
    sbHideTimer.current = setTimeout(() => setRailSb((s) => (s.show ? { ...s, show: false } : s)), 1100);
  };
  const onListScroll = () => {
    if (listScrollRaf.current == null) {
      listScrollRaf.current = requestAnimationFrame(() => {
        listScrollRaf.current = null;
        measureRailThumb();
        flashRailThumb();
      });
    }
  };
  // Re-measure whenever the list's size/content changes (filtering, rail
  // resize, new/deleted chats).
  useEffect(() => {
    measureRailThumb();
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measureRailThumb());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads.length, chatSearch, tab, railWidth]);
  useEffect(() => () => { if (sbHideTimer.current) clearTimeout(sbHideTimer.current); }, []);
  const showRailSb = () => setRailSb((s) => (s.enabled ? { ...s, show: true } : s));
  // Returning the same object when nothing changes lets React skip the render.
  const hideRailSb = () => setRailSb((s) => (s.show ? { ...s, show: false } : s));

  // Edge-fade the chat ITEMS (not the rail's background) by distance from the
  // list's viewport edges — JS opacity per row, so the app's dotted/spotlight
  // background never dims and the SELECTED row stays fully solid.
  const fadeRailItems = () => {
    const list = listRef.current;
    if (!list) return;
    const lr = list.getBoundingClientRect();
    const scrollable = list.scrollHeight > list.clientHeight + 1;
    // Every row is measured first and written after, so the style writes don't
    // force a fresh style/layout pass for each following row's read.
    const rows = list.querySelectorAll('.aichat-item');
    const values = [];
    rows.forEach((el) => {
      if (!scrollable || el.classList.contains('is-active')) { values.push(''); return; }
      const r = el.getBoundingClientRect();
      const c = (r.top + r.bottom) / 2;
      const o = Math.min(1, (c - lr.top) / 28, (lr.bottom - c) / 40);
      values.push(String(Math.max(0, Math.min(1, o))));
    });
    rows.forEach((el, i) => { el.style.opacity = values[i]; });
  };

  // ── Thread scrollbar (custom overlay beside the masked scroller) ───────
  const measureMsgThumb = () => {
    const el = scrollRef.current;
    const thumb = msgThumbRef.current;
    if (!el || !thumb) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 1) {
      setMsgSb((s) => (s.enabled ? { ...s, enabled: false } : s));
      return;
    }
    const track = toLayoutPx(el.getBoundingClientRect().height);
    const h = Math.max(28, (clientHeight / scrollHeight) * track);
    const maxY = track - h;
    const y = (scrollTop / (scrollHeight - clientHeight)) * maxY;
    thumb.style.height = `${h}px`;
    thumb.style.transform = `translateY(${y}px)`;
    setMsgSb((s) => (s.enabled ? s : { ...s, enabled: true }));
  };
  const flashMsgThumb = () => {
    setMsgSb((s) => (s.enabled && !s.show ? { ...s, show: true } : s));
    if (msgSbHideTimer.current) clearTimeout(msgSbHideTimer.current);
    msgSbHideTimer.current = setTimeout(() => { if (!msgSbDragRef.current) setMsgSb((s) => (s.show ? { ...s, show: false } : s)); }, 1100);
  };
  const onMsgThumbDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = scrollRef.current;
    if (!el) return;
    msgSbDragRef.current = { startY: e.clientY, startScroll: el.scrollTop };
    setMsgSb((s) => (s.show ? s : { ...s, show: true }));
    const onMove = (ev) => {
      const d = msgSbDragRef.current;
      const el2 = scrollRef.current;
      if (!d || !el2) return;
      const track = toLayoutPx(el2.getBoundingClientRect().height);
      const h = Math.max(28, (el2.clientHeight / el2.scrollHeight) * track);
      const maxY = track - h;
      const perPx = maxY > 0 ? (el2.scrollHeight - el2.clientHeight) / maxY : 0;
      el2.scrollTop = d.startScroll + toLayoutPx(ev.clientY - d.startY) * perPx;
    };
    const onUp = () => {
      msgSbDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      flashMsgThumb();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const showMsgSb = () => setMsgSb((s) => (s.enabled ? { ...s, show: true } : s));
  const hideMsgSb = () => { if (!msgSbDragRef.current) setMsgSb((s) => (s.show ? { ...s, show: false } : s)); };
  // Re-measure the thread thumb when the conversation / its size changes.
  useEffect(() => {
    measureMsgThumb();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measureMsgThumb());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, activeId, tab, streaming]);
  useEffect(() => () => { if (msgSbHideTimer.current) clearTimeout(msgSbHideTimer.current); }, []);
  // Files in the project's local folder. Names ground every answer; contents
  // are read on demand (attachments + name mentions); the full facts feed the
  // project digest. Ref-only — nothing renders from it.
  const contextFilesRef = useRef([]);
  // The project's resolved local-folder path (Electron) — where the advisor
  // writes files it creates. Null on web / before the folder resolves.
  const projectDirRef = useRef(null);

  // THE PAGE SCROLLS (not a column inside it): `scrollRef.current` is the
  // page's scroller (.sv-single-scroll), found from the thread — so the
  // stick-to-bottom, the jumps to the latest message and the find all follow
  // the page. `threadRef` is the thread itself.
  const threadRef = useRef(null);
  const scrollRef = React.useMemo(() => ({
    get current() { return threadRef.current?.closest('.sv-single-scroll, .main-content') || threadRef.current; },
    set current(_) { /* derived */ },
  }), []);
  const pageRef = useRef(null);
  const taRef = useRef(null);       // composer textarea
  const searchRef = useRef(null);   // toolbar chat-search input (Ctrl/⌘+F)
  const fileInputRef = useRef(null);
  const stickRef = useRef(true);    // follow-the-bottom flag
  // Bumped to invalidate the in-flight turn (the Stop button): when the
  // request returns, a stale sequence number means "discard the result".
  const turnSeqRef = useRef(0);
  // Chat-list scrollbar — a custom thumb that rides ON the rail's drag-handle
  // divider (the native list scrollbar is hidden). Thumb geometry is written
  // straight to the DOM (no per-scroll re-render); state only tracks
  // enabled/shown.
  const listRef = useRef(null);      // the .aichat-list scroller
  const resizerRef = useRef(null);   // the divider band the thumb lives in
  const sbThumbRef = useRef(null);
  const sbHideTimer = useRef(null);
  const listScrollRaf = useRef(null);
  const [railSb, setRailSb] = useState({ enabled: false, show: false });
  // Thread scrollbar — a custom overlay OUTSIDE the masked bubbles scroller
  // (the edge fades are a mask on the scroller, which would wash a native
  // scrollbar; this one floats beside it, fully crisp, and is draggable).
  const msgThumbRef = useRef(null);
  const msgSbHideTimer = useRef(null);
  const msgSbDragRef = useRef(null);
  const msgScrollRaf = useRef(null);
  const [msgSb, setMsgSb] = useState({ enabled: false, show: false });
  const pendingScrollRef = useRef(false); // one-shot: force scroll on send
  const loadedFor = useRef(null);
  // Latest activeId for async callbacks (their closures hold a stale one).
  const activeIdRef = useRef(null);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  // Opening a conversation clears its "done thinking" (unread) marker.
  useEffect(() => {
    if (!activeId) return;
    setThreads((ts) => (ts.some((t) => t.id === activeId && t.unreadAt)
      ? ts.map((t) => (t.id === activeId ? { ...t, unreadAt: null } : t))
      : ts));
  }, [activeId, threads]);
  // Surface advisor activity on the sidebar's Advisor item: busy while a turn
  // runs anywhere, unread once a reply landed in a non-open conversation.
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('docvex:advisor-activity', {
        detail: { busy: streaming, unread: threads.some((t) => t.unreadAt) },
      }));
    } catch { /* no-op */ }
  }, [streaming, threads]);
  // Leaving the page: the turn dies with it, so drop the busy dot (a landed
  // unread marker persists in the threads and re-reports on next mount).
  useEffect(() => () => {
    try { window.dispatchEvent(new CustomEvent('docvex:advisor-activity', { detail: { busy: false } })); } catch { /* no-op */ }
  }, []);

  // ── Persistence — one thread list per user+project ────────────────────
  const storageKey = STORAGE_PREFIX + userKey + '.' + (projectId || '_none');
  // The store holds (and saves) this user's project's chats.
  useEffect(() => { bindChats(userKey, projectId); }, [userKey, projectId]);

  // ── Project file context ───────────────────────────────────────────────
  // List the selected project's local folder (the Files tab's folder) so the
  // AI knows what files exist and can read the ones the user points at.
  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const baseDir = readProjectsDir(userKey) || undefined;
        const { path } = await localFolderApi.projectDir(projectId, selectedProject?.name, baseDir);
        // Electron resolves the fixed project dir; web lists the connected
        // folder handle (path null) — listAll handles both.
        if (!cancelled) projectDirRef.current = path || null;
        const { files } = await localFolderApi.listAll(path || undefined);
        if (cancelled) return;
        // Keep the full facts — the project digest reports folder, size and
        // modified date, and the AI file-index cache keys off size+mtime.
        const list = (files || []).filter((f) => f?.name).map((f) => ({
          name: f.name,
          path: f.path || null,
          folderPath: f.folderPath || '',
          sizeBytes: f.sizeBytes ?? null,
          mtimeIso: f.mtimeIso || null,
        }));
        contextFilesRef.current = list;
        // The people the AI scan read in the files → questions about the case.
        const scanned = list.map((f) => (f.path ? getAiFacet(f.path, 'understanding')?.data : null)).filter(Boolean);
        const people = [...new Set(scanned.flatMap((u) => (Array.isArray(u.parties) ? u.parties : [])
          .filter((p) => (p?.kind || 'person') === 'person' && p?.name).map((p) => p.name)))].slice(0, 2);
        setCaseStarters(scanned.length ? caseStarterPrompts(people) : []);
      } catch {
        if (!cancelled) contextFilesRef.current = [];
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, userKey]);

  // ── Full-project context digest ─────────────────────────────────────────
  // Everything the app knows about the project (files, team chat, timeline,
  // OCR snippets, captions, metadata, members) compacted into one text block
  // that rides on the CURRENT turn only — it's never persisted into the
  // conversation, so it stays fresh and the history stays clean. Cached ~60s
  // so rapid back-and-forth doesn't refetch chat/members every message.
  const digestCache = useRef({ key: null, at: 0, text: '' });
  const getProjectDigest = async () => {
    const key = projectId;
    const c = digestCache.current;
    if (c.key === key && Date.now() - c.at < 60_000) return c.text;
    let text = '';
    try {
      text = await buildProjectDigest({ project: selectedProject, files: contextFilesRef.current });
    } catch { text = ''; }
    digestCache.current = { key, at: Date.now(), text };
    return text;
  };
  // Wrap the outgoing turn: prepend the digest to the LAST user message so the
  // model always answers with the whole project in view.
  const withProjectContext = (apiMessages, digest) => {
    if (!digest || !apiMessages.length) return apiMessages;
    const last = apiMessages[apiMessages.length - 1];
    if (last.role !== 'user' || typeof last.content !== 'string') return apiMessages;
    return [
      ...apiMessages.slice(0, -1),
      {
        ...last,
        content: `<project_context>\nA live snapshot of everything DocVex has read from this project — details, members, files, every data collection in full (records, facts, timelines, sources, links), what the AI scan understood of each file, team chat, case timeline, OCR text, audio/video captions and file metadata. Answer questions about the project's files, people, companies, addresses, dates and links FROM IT, citing the file a fact comes from. Never say you cannot see or have no access to a file whose contents are here; only when something is genuinely absent, say what IS known and exactly what is missing (naming the file whose full text would answer it).\n\n${digest}\n</project_context>\n\n${last.content}`,
      },
    ];
  };

  const activeThread = threads.find((t) => t.id === activeId) || threads[0];
  const messages = activeThread?.messages || [];
  // The open chat has nothing in it yet ("How can I help?") — the page then
  // FITS the window and does not scroll (see --aifit-h).
  const emptyChat = tab === 'chat' && messages.length === 0 && !streaming;
  const hasThreads = threads.length > 0;
  // The tabs' own order (pinned first, then as arranged); the blank chat is
  // not listed — the rail's "New chat" stands for it.
  const ordered = threads.filter((t) => !isBlankChat(t));
  // Explorer-style filter: the rail shows only the chats that match the search
  // (by title, any message's text, or an attached file's name); no query → all.
  const searchQ = chatSearch.trim().toLowerCase();
  const visibleThreads = !searchQ ? ordered : ordered.filter((t) => (
    (t.title || '').toLowerCase().includes(searchQ)
    || (t.messages || []).some((m) => (m.text || '').toLowerCase().includes(searchQ)
      || (m.attachments || []).some((n) => (n || '').toLowerCase().includes(searchQ)))
  ));

  // Highlight EVERY occurrence of the search inside the open conversation's
  // bubbles (CSS Custom Highlight API — no DOM mutation), VS-Code/Explorer
  // style: all matches tinted, Enter / Shift+Enter cycles the active one.
  const find = useChatFind({ containerRef: scrollRef, query: chatSearch, name: 'aichat', scope: '.bubble-msg' });

  // Ctrl/⌘+F focuses the chat search (matches the Chat tab).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        if (tab !== 'chat' || !threads.length || !searchRef.current) return;
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, threads.length]);

  // ── Thread scroll: stick-to-bottom tracking. Only the bubbles column
  // scrolls — the masthead, toolbar and rail stay put. ──────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      // Track + flash the custom thread scrollbar (rAF-throttled).
      if (msgScrollRaf.current == null) {
        msgScrollRaf.current = requestAnimationFrame(() => {
          msgScrollRaf.current = null;
          measureMsgThumb();
          flashMsgThumb();
        });
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [tab, hasThreads, projectId]);

  const scrollToBottom = (force = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (force !== true && !stickRef.current) return;
    if (force === true) stickRef.current = true;
    el.scrollTop = el.scrollHeight;
  };
  // Switching chats always jumps to the latest message.
  useEffect(() => { scrollToBottom(true); }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  // New messages / streaming stick to the bottom only if the user is there —
  // except right after sending, where we always jump to the new message.
  useEffect(() => {
    scrollToBottom(pendingScrollRef.current);
    pendingScrollRef.current = false;
  }, [messages, streaming]); // eslint-disable-line react-hooks/exhaustive-deps
  // Stop the typewriter (and drop any pending question / card selection) when
  // switching threads.
  useEffect(() => { setTyping(null); setPendingAsk(null); setSelectedFileCard(null); }, [activeId]);

  // Open a created file in the Doc Viewer (double-click on its card — same
  // action as the Files tab).
  const openCreatedFile = (cf) => {
    if (!cf?.path) return;
    try { openDocViewerWindow({ path: cf.path, name: cf.name, mime: cf.mime || '' }); } catch { /* no-op */ }
  };

  // Auto-grow the composer with its content, up to a 4-line ceiling.
  useEffect(() => {
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

  // Keep the thread's bottom padding in sync with the floating composer's
  // height (it grows with the textarea, attachment chips and the ask panel)
  // so the last message can always scroll clear of it.
  useEffect(() => {
    const footer = taRef.current?.closest('.vb-composer-wrap');
    const main = threadRef.current;
    if (!footer || !main) return undefined;
    const apply = () => {
      const h = footer.getBoundingClientRect().height;
      main.style.paddingBottom = `${Math.max(Math.round(h) + 24, 88)}px`;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(footer);
    return () => ro.disconnect();
  }, [activeId, tab, hasThreads]);

  // The chat list STICKS under the mini header and ends one inset above the
  // window's foot (the Legislation rail's rule): the bar's height and the
  // scroller's are measured into --airail-top / --airail-h.
  useEffect(() => {
    const page = pageRef.current;
    const scroller = page?.closest('.sv-single-scroll, .main-content');
    if (!page || !scroller) return undefined;
    const apply = () => {
      const bar = page.querySelector('.lgt-bar');
      const inset = parseFloat(getComputedStyle(page).getPropertyValue('--chrome-inset')) || 6.4;
      const bh = bar ? bar.offsetHeight : 48;
      const top = inset + bh + 8;
      page.style.setProperty('--airail-top', `${top}px`);
      page.style.setProperty('--airail-h', `${Math.max(240, scroller.clientHeight - top - inset)}px`);
      // What is left of the window under the header, from the shell's top —
      // an EMPTY chat fits into exactly this and the page does not scroll.
      const shell = page.querySelector('.aichat-shell');
      if (shell) {
        const sr = scroller.getBoundingClientRect();
        const at = shell.getBoundingClientRect().top - sr.top + scroller.scrollTop;
        page.style.setProperty('--aifit-h', `${Math.max(200, scroller.clientHeight - at - inset)}px`);
      }
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(apply);
    ro.observe(scroller);
    const bar = page.querySelector('.lgt-bar');
    if (bar) ro.observe(bar);
    return () => ro.disconnect();
  }, [tab, hasThreads, emptyChat]);
  // An empty chat starts at the page's top (nothing to scroll to).
  useEffect(() => {
    if (!emptyChat) return;
    const scroller = pageRef.current?.closest('.sv-single-scroll, .main-content');
    if (scroller) scroller.scrollTop = 0;
  }, [emptyChat, activeId]);

  // ── Title generation (fire-and-forget) ─────────────────────────────────
  const generateTitle = async (threadId, firstQuestion) => {
    try {
      const prompt =
        'Write a concise 3 to 6 word title in Title Case for a chat that begins with the ' +
        `following user message. No quotes, no ending punctuation, no preamble — reply with ONLY the title.\n\n"${firstQuestion.slice(0, 600)}"`;
      const { text, error } = await askProjectAi({ messages: [{ role: 'user', content: prompt }], projectName: '', fileNames: [], tools: false, usageAction: 'chat' });
      if (error) return;
      const title = (text || '').split('\n')[0].trim().replace(/^["'“”\s]+|["'“”.\s]+$/g, '').slice(0, 48);
      // `updatedAt` too: account sync keeps the newer copy of a chat, and a title
      // that lands without it would never reach a device that already has the chat.
      if (title) setThreads((ts) => ts.map((t) => (t.id === threadId ? { ...t, title, updatedAt: Date.now() } : t)));
    } catch { /* keep placeholder title */ }
  };

  // ── File creation (write_document → the Files tab) ─────────────────────
  // Build a real Office file from the model's write_document call and save it
  // into the project's local folder, so it appears in the Files tab.
  // `opts.wantName` / `opts.wantFolder` come from the summary's
  // `[file: … | folder: …]` header (the user's exact wishes, relayed by the
  // model); with no name the fallback hint (summary/request) names it, and
  // with no folder it lands in the Files home directory. Returns
  // { ok, name, relPath, fullPath } | { ok: false, error }.
  const createProjectFile = async (kind, text, opts = {}) => {
    const home = projectDirRef.current;
    if (!home) {
      return { ok: false, error: 'I can only create files when the project folder is connected in the desktop app — open the Files tab once, then ask me again.' };
    }
    const sanitizeName = (s) => String(s || '')
      .replace(/[#*`"'“”[\]]/g, '')
      .replace(/[\\/:*?<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60)
      .trim();
    // Target folder — a sanitised relative path under the project root
    // ('home'/'root'/'.' or empty → the home directory itself).
    const rawFolder = String(opts.wantFolder || '').trim();
    const folder = /^(home|root|\.|\/|\\)?$/i.test(rawFolder)
      ? ''
      : rawFolder
        .replace(/\\/g, '/')
        .split('/')
        .map((s) => s.replace(/[:*?"<>|]/g, '').trim())
        .filter((s) => s && s !== '.' && s !== '..')
        .join('/');
    const dir = folder ? `${home}/${folder}` : home;
    // Filename — the user's exact name when given (its extension may also pin
    // the kind upstream), else derived from the summary/request.
    const base = sanitizeName(String(opts.wantName || '').replace(new RegExp(`\\.${kind}$`, 'i'), ''))
      || sanitizeName(String(opts.fallbackHint || '').split('\n')[0])
      || 'AI document';
    // De-dupe within the TARGET folder only.
    const norm = (p) => String(p || '').replace(/\\/g, '/');
    const taken = new Set(contextFilesRef.current
      .filter((f) => norm(f.folderPath) === folder)
      .map((f) => f.name.toLowerCase()));
    const named = (b) => `${b}.${kind}`;
    let name = named(base);
    for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = named(`${base} (${i})`);
    // A format whose bytes can't be written from text. Refused by name rather
    // than attempted: a .png holding the model's prose is a broken file, and
    // the message tells the reader (and the model) what can be done instead.
    if (BINARY_ONLY_EXTS.has(kind)) {
      return { ok: false, error: `I can’t create ${kind.toUpperCase()} files — that format is binary (a picture, sound, video or archive). I can write Word, PowerPoint, Excel and PDF documents, and any text-based format (txt, md, csv, json, xml, html…).` };
    }
    try {
      // How a file gets its bytes (a Data collection is refused — the AI scan
      // makes those):
      //   • Office / PDF are BUILT — 'skills' prefers Anthropic's Office Skills
      //     builder (high fidelity) and falls back to the local builders.
      //   • Anything else is a text format: the model's content IS the file, so
      //     it is written verbatim. This is what lets the advisor produce the
      //     formats nothing here can build — .csv, .json, .srt, code.
      let blob;
      if (kind === 'dvx' || kind === 'dvc') {
        return { ok: false, error: 'I can’t write Data collections — they are made by the Files tab’s AI scan. Tag the files for the scan and run it.' };
      } else if (!BUILT_KINDS.has(kind)) {
        blob = new Blob([String(text || '')], { type: mimeForExt(kind) });
      } else {
        blob = await buildDocumentBlobSmart(kind, text, { engine: 'skills' });
        // A Word file carries its source (lib/docxSource), so the Doc Viewer's
        // paragraph tools work on it — on this device and on any other.
        if (kind === 'docx') blob = await embedDocxSource(blob, sourcePayload([{ n: 1, text, kind }], 1));
      }
      const wr = await localFolderApi.writeFiles({ dir, files: [{ filename: name, blob }] });
      if (wr?.error || !wr?.results?.[0]?.ok) throw new Error(wr?.error || wr?.results?.[0]?.error || 'write_failed');
      notifyFilesChanged(); // other windows (the Files tab) refresh their listings
      // Refresh the file inventory + digest so the advisor immediately knows
      // about the file it just made.
      try {
        const { files } = await localFolderApi.listAll(dir);
        contextFilesRef.current = (files || []).filter((f) => f?.name).map((f) => ({
          name: f.name, path: f.path || null, folderPath: f.folderPath || '', sizeBytes: f.sizeBytes ?? null, mtimeIso: f.mtimeIso || null,
        }));
      } catch { /* keep the stale listing */ }
      digestCache.current = { key: null, at: 0, text: '' };
      notify({
        category: 'file',
        variant: 'success',
        icon: 'sparkles',
        title: 'Document created',
        body: `“${name}” was written to your project files by the advisor.`,
        silent: true,
        payload: { activity: { action: 'generate-doc', fileName: name } },
      });
      const sep = home.includes('\\') ? '\\' : '/';
      const fullPath = `${dir}${sep}${name}`.replace(/\//g, sep === '\\' ? '\\' : '/');
      return {
        ok: true,
        name,
        relPath: folder ? `${folder}/${name}` : name,
        fullPath,
        mime: BUILT_KINDS.has(kind) ? mimeForKind(kind) : mimeForExt(kind),
      };
    } catch {
      return { ok: false, error: 'Couldn’t create the file. Please try again in a moment.' };
    }
  };

  // Streaming state helpers — track which thread the turn belongs to.
  const beginStreaming = (threadId) => { setStreaming(true); setStreamingThread(threadId); };
  const endStreaming = () => { setStreaming(false); setStreamingThread(null); };

  // Append one AI message to a thread (shared by every result path). A reply
  // landing in a thread the user ISN'T looking at marks it unread — the rail
  // row and the sidebar's Advisor item show a "done thinking" dot until the
  // conversation is opened.
  const appendAiMessage = (threadId, msg) => {
    const away = activeIdRef.current !== threadId;
    setThreads((ts) => ts.map((t) => (t.id === threadId
      ? { ...t, updatedAt: Date.now(), ...(away ? { unreadAt: Date.now() } : {}), messages: [...t.messages, msg] }
      : t)));
  };

  // Apply one model result: create a file (write_document), pause on a
  // clarifying question (ask_user), or show a plain answer. `baseMsgs` is the
  // exact api payload sent (replayed on an ask_user resume); `convoLen` is the
  // visible message count BEFORE the AI reply (the typewriter index). Owns
  // dropping the thinking state: the file build can take a while (the Office
  // Skills engine runs remotely), so `streaming` stays ON until the file is
  // actually written — otherwise the page looks dead during the build. `seq`
  // lets a Stop pressed mid-build discard the outcome.
  // Whatever happens in here, the thread gets a message and the thinking
  // indicator stops. A throw used to reject the promise the turn awaits, which
  // left the advisor spinning with nothing in the thread — a file could even be
  // written and the conversation never say so.
  const applyAiResult = async (res, threadId, lastUserText, baseMsgs, convoLen, seq) => {
    try {
      await applyAiResultInner(res, threadId, lastUserText, baseMsgs, convoLen, seq);
    } catch (err) {
      console.error('[advisor] could not finish the turn', err);
      if (seq != null && turnSeqRef.current !== seq) return;   // stopped — say nothing
      endStreaming();
      appendAiMessage(threadId, {
        who: 'ai',
        isError: true,
        text: 'Something went wrong finishing that answer. Please try again — if a file was being created, check the Files tab before asking again.',
        at: Date.now(),
      });
    }
  };

  const applyAiResultInner = async (res, threadId, lastUserText, baseMsgs, convoLen, seq) => {
    if (res.tool === 'write_document' && res.toolUse?.input) {
      const input = res.toolUse.input;
      // The summary's first line carries the user's exact wishes as a
      // `[file: <name> | folder: <path>]` header (see FILE_STEER).
      const rawSummary = String(input.summary || '');
      const hdr = rawSummary.match(/^\s*\[\s*file\s*:\s*([^\]|]*)(?:\|\s*folder\s*:\s*([^\]]*))?\]\s*/i);
      const wantName = hdr ? (hdr[1] || '').trim() : '';
      const wantFolder = hdr ? (hdr[2] || '').trim() : '';
      const cleanSummary = (hdr ? rawSummary.slice(hdr[0].length) : rawSummary).trim();
      // Kind precedence: the extension on the requested filename wins — ANY
      // extension, not only a buildable one, which is what lets a `.dvx`
      // record, a `.csv` or a `.json` be asked for by name — then the tool's
      // declared kind, then inference from the request/content.
      // Alphanumeric only: the extension goes into a filename and a RegExp, and
      // whatever the model put after the last dot is not to be trusted with
      // either ("Contract v1.2", "report. docx").
      const askedExt = (extOf(wantName) || '').toLowerCase();
      const kind = (/^[a-z0-9]{1,8}$/.test(askedExt) ? askedExt : '')
        || (BUILT_KINDS.has(input.kind) ? input.kind : null)
        || inferDocKind(`${lastUserText}\n${input.content || ''}`);
      const created = await createProjectFile(kind, String(input.content || ''), {
        wantName,
        wantFolder,
        fallbackHint: cleanSummary || lastUserText,
      });
      if (seq != null && turnSeqRef.current !== seq) return; // stopped mid-build
      endStreaming();
      if (!created.ok) {
        appendAiMessage(threadId, { who: 'ai', isError: true, text: created.error, at: Date.now() });
        return;
      }
      // The reply always SAYS what was written and where. A turn that ends on
      // the tool call carries no text of its own, and the summary is about the
      // document rather than about the act of saving it — so the fallback
      // names the file and its folder, which is what the reader needs to find
      // it again. (The card under the message is the file itself.)
      const where = created.relPath.includes('/')
        ? ` in ${created.relPath.slice(0, created.relPath.lastIndexOf('/'))}`
        : '';
      const saved = `Saved “${created.name}” to your project files${where}.`;
      const said = (res.text && res.text.trim()) || cleanSummary;
      const note = said ? `${said}\n\n${saved}` : saved;
      appendAiMessage(threadId, {
        who: 'ai',
        text: note,
        at: Date.now(),
        createdFile: { name: created.name, relPath: created.relPath, path: created.fullPath, mime: created.mime },
      });
      setTyping({ threadId, index: convoLen });
      return;
    }
    endStreaming();
    if (res.tool === 'ask_user' && res.askUser) {
      appendAiMessage(threadId, { who: 'ai', text: res.text || 'A couple of quick questions first.', at: Date.now() });
      setPendingAsk({ id: res.askUser.id, input: res.askUser.input, assistantContent: res.assistantContent, base: baseMsgs, threadId });
      return;
    }
    // Guard: never render an invisible empty bubble (e.g. a truncated tool
    // call that produced neither text nor a usable tool_use).
    if (!res.text || !String(res.text).trim()) {
      appendAiMessage(threadId, { who: 'ai', isError: true, text: 'I didn’t get a usable answer back. Please try again.', at: Date.now() });
      return;
    }
    // The project files the reply changes (lib/aiFileEdits) — applied, then
    // reported under it with Undo.
    let edits = [];
    try { edits = await applyReplyEdits(res.text, contextFilesRef.current || []); } catch { edits = []; }
    appendAiMessage(threadId, { who: 'ai', text: res.text, at: Date.now(), ...(edits.length ? { edits } : null) });
    setTyping({ threadId, index: convoLen });
  };

  // Stop the in-flight turn: invalidate its result (nothing lands in the
  // thread when the request eventually returns), drop the thinking state and
  // leave an "Interrupted" marker in the thread (à la Claude Code).
  const stopTurn = () => {
    turnSeqRef.current += 1;
    endStreaming();
    if (activeId) {
      appendAiMessage(activeId, { who: 'ai', interrupted: true, text: 'Interrupted by user', at: Date.now() });
    }
  };

  // Append the file-creation steer to the last user message of an api payload,
  // then the user's own writing style from the Playbook on top of it. Both land
  // on the same turn and neither needs to know about the other.
  const withSteer = async (apiMessages) => {
    if (!apiMessages.length) return apiMessages;
    const last = apiMessages[apiMessages.length - 1];
    if (last.role !== 'user' || typeof last.content !== 'string') return apiMessages;
    const withFile = [...apiMessages.slice(0, -1), { ...last, content: `${last.content}\n\n${FILE_STEER}` }];
    return withStyleSteer(withFile);
  };

  // ── Send a turn ────────────────────────────────────────────────────────
  const send = async (q) => {
    const text = (q != null ? String(q) : val).trim();
    if (!text || streaming || !activeId) return;
    setVal('');
    // While a question is pending, a typed message answers it (free-text).
    if (pendingAsk) { resolveAsk({ typedText: text }); return; }
    const atts = attachments;
    setAttachments([]);
    // Context for this turn: explicitly attached files + any project files the
    // message names — both read + inlined so the model answers from contents.
    const attachedNames = new Set(atts.map((a) => a.name));
    const mentioned = findMentionedFiles(text, contextFilesRef.current, attachedNames);
    const blocks = [];
    if (atts.length) {
      blocks.push(await buildContextBlock(atts,
        'The user attached the following file(s). Their full text contents are included below — read them and use them directly to answer.'));
    }
    if (mentioned.length) {
      blocks.push(await buildContextBlock(mentioned,
        'The user\'s message refers to the following project file(s) by name. Their text contents are included below — use them to answer.'));
    }
    const contextBlock = blocks.filter(Boolean).join('\n\n');
    const apiText = contextBlock ? `${contextBlock}\n\n---\n\n${text}` : text;
    const shownAtts = [...atts.map((a) => a.name), ...mentioned.map((f) => f.name)];
    const userMsg = {
      who: 'me',
      text,
      at: Date.now(),
      ...(contextBlock ? { apiText } : {}),
      ...(shownAtts.length ? { attachments: shownAtts } : {}),
    };
    const threadId = activeId;
    const current = threads.find((t) => t.id === threadId);
    const convo = [...(current?.messages || []), userMsg];
    const isFirstUser = !(current?.messages || []).some((m) => m.who === 'me');
    pendingScrollRef.current = true;
    setThreads((ts) => ts.map((t) => (t.id === threadId
      ? { ...t, messages: convo, title: isFirstUser ? (text.slice(0, 48) || 'Unnamed chat') : t.title, updatedAt: Date.now() }
      : t)));
    beginStreaming(threadId);
    const seq = ++turnSeqRef.current;
    // Ground the answer in the FULL project: the live digest (files, chat,
    // timeline, snippets, captions, metadata) rides on this turn, plus the
    // file-name grounding the edge function already understands. Doc tools are
    // on: the model can create files (write_document) or pause to clarify
    // (ask_user) — the steer note tells it when to do which.
    const digest = await getProjectDigest();
    // The fixed rule for offering choices (lib/aiChoices), first and last.
    const apiMsgs = foldRuleExchanges(withSourcesRule(withChoicesRule(withEditRule(await withSteer(withProjectContext(toApiMessages(convo), digest))))));
    const res = await askProjectAi({
      messages: apiMsgs,
      projectName: selectedProject?.name || '',
      fileNames: contextFilesRef.current.map((f) => f.name),
      docTools: true,
      usageAction: 'chat',
    });
    if (turnSeqRef.current !== seq) return; // stopped — discard the result
    if (res.error) {
      endStreaming();
      appendAiMessage(threadId, {
        who: 'ai',
        isError: true,
        text: res.error.message === 'ai_not_configured'
          ? 'The AI assistant is not configured (the AI key is missing). Contact your administrator.'
          : 'Couldn’t get an answer right now. Please try again in a moment.',
        at: Date.now(),
      });
      return;
    }
    // applyAiResult owns dropping `streaming` — a file build keeps the
    // thinking indicator up until the document is actually written.
    await applyAiResult(res, threadId, text, apiMsgs, convo.length, seq);
    if (isFirstUser) generateTitle(threadId, text);
  };

  // Resolve a pending ask_user question: replay the exact turn the model saw
  // plus its tool_use and our tool_result, with the doc tools still available —
  // the answers drive whether it writes the file or just replies.
  const resolveAsk = async (opts = {}) => {
    if (!pendingAsk || streaming) return;
    const pa = pendingAsk;
    setPendingAsk(null);
    const questions = pa.input?.questions || [];
    const answers = opts.dismissed
      ? makeAskAnswers([], {}, { dismissed: true })
      : opts.typedText != null
        ? { answers: questions.map((qq) => ({ question_id: qq.id, response_type: 'free_text', text: opts.typedText })) }
        : makeAskAnswers(questions, opts.perQuestion || {});
    const threadId = pa.threadId;
    const current = threads.find((t) => t.id === threadId);
    const userMsg = { who: 'me', text: opts.dismissed ? 'Skipped.' : (opts.typedText || 'Answered.'), at: Date.now() };
    const convoLen = (current?.messages || []).length + 1;
    pendingScrollRef.current = true;
    setThreads((ts) => ts.map((t) => (t.id === threadId
      ? { ...t, updatedAt: Date.now(), messages: [...t.messages, userMsg] }
      : t)));
    beginStreaming(threadId);
    const seq = ++turnSeqRef.current;
    const apiMsgs = [
      ...pa.base,
      { role: 'assistant', content: pa.assistantContent || [{ type: 'tool_use', id: pa.id, name: 'ask_user', input: pa.input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: pa.id, content: JSON.stringify(answers) }] },
    ];
    const res = await askProjectAi({
      messages: apiMsgs,
      projectName: selectedProject?.name || '',
      fileNames: contextFilesRef.current.map((f) => f.name),
      docTools: true,
      usageAction: 'chat',
    });
    if (turnSeqRef.current !== seq) return; // stopped — discard the result
    if (res.error) {
      endStreaming();
      appendAiMessage(threadId, { who: 'ai', isError: true, text: 'Couldn’t get an answer right now. Please try again in a moment.', at: Date.now() });
      return;
    }
    await applyAiResult(res, threadId, opts.typedText || 'the answers above', apiMsgs, convoLen, seq);
  };

  // ── Per-response actions ────────────────────────────────────────────────
  const copyMessage = async (text, index) => {
    try { await navigator.clipboard.writeText(text || ''); } catch { /* clipboard blocked */ }
    setCopiedIdx(index);
    window.setTimeout(() => setCopiedIdx((cur) => (cur === index ? null : cur)), 1600);
  };
  // Regenerate the AI message at `index`: drop it (and anything after) and
  // re-ask with the conversation up to that point.
  const regenerate = async (index) => {
    if (streaming || pendingAsk) return;
    const threadId = activeId;
    const current = threads.find((t) => t.id === threadId);
    const convo = (current?.messages || []).slice(0, index);
    if (!convo.length) return;
    setThreads((ts) => ts.map((t) => (t.id === threadId ? { ...t, messages: convo, updatedAt: Date.now() } : t)));
    beginStreaming(threadId);
    const seq = ++turnSeqRef.current;
    const digest = await getProjectDigest();
    // The fixed rule for offering choices (lib/aiChoices), first and last.
    const apiMsgs = foldRuleExchanges(withSourcesRule(withChoicesRule(withEditRule(await withSteer(withProjectContext(toApiMessages(convo), digest))))));
    const res = await askProjectAi({
      messages: apiMsgs,
      projectName: selectedProject?.name || '',
      fileNames: contextFilesRef.current.map((f) => f.name),
      docTools: true,
      usageAction: 'chat',
    });
    if (turnSeqRef.current !== seq) return; // stopped — discard the result
    if (res.error) {
      endStreaming();
      appendAiMessage(threadId, { who: 'ai', isError: true, text: 'Couldn’t get an answer right now. Please try again in a moment.', at: Date.now() });
      return;
    }
    const lastUser = [...convo].reverse().find((m) => m.who === 'me');
    await applyAiResult(res, threadId, lastUser?.text || '', apiMsgs, convo.length, seq);
  };

  // ── Conversation list actions ──────────────────────────────────────────
  const newChat = () => {
    openNewChat();
    setVal('');
    setAttachments([]);
    requestAnimationFrame(() => taRef.current?.focus());
  };
  const selectThread = (id) => {
    if (id === activeId) return;
    setActiveId(id);
    setVal('');
  };
  // Closing a tab closes the chat (Ctrl+Shift+T / the menu reopen it this
  // session; account sync is told it is gone — lib/advisorChats).
  const deleteThread = (id) => closeChat(id);

  // ── The tabs' menu (right-click) and keys — the Legislation tabs' ──
  const [chatMenu, setChatMenu] = useState(null); // { id, x, y }
  const [chatDrag, setChatDrag] = useState(null); // { id, over }
  // The rail's pointer lights — the Legislation rail's (lib/pointerSpots).
  const tabRailRef = useItemSpots('.lg-rail-item', true);
  useRailSpotlight(tabRailRef);
  useEffect(() => {
    if (tab !== 'chat') return undefined;
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      const listed = chatsState().threads.filter((t) => !isBlankChat(t));
      const cur = chatsState().active;
      if (k === 't' && e.shiftKey) { e.preventDefault(); reopenClosedChat(); return; }
      if (k === 't') { e.preventDefault(); newChat(); return; }
      if (k === 'w') { e.preventDefault(); if (cur) closeChat(cur); return; }
      if (e.key === 'Tab' && listed.length) {
        e.preventDefault();
        const i = listed.findIndex((t) => t.id === cur);
        const next = listed[(i + (e.shiftKey ? -1 : 1) + listed.length) % listed.length];
        if (next) selectThread(next.id);
        return;
      }
      if (/^[1-9]$/.test(e.key) && listed.length) {
        e.preventDefault();
        const n = Number(e.key);
        const t = n === 9 ? listed[listed.length - 1] : listed[n - 1];
        if (t) selectThread(t.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // The app sidebar's Advisor row, clicked on this page: a new chat, caret in the composer.
  useEffect(() => {
    const focus = () => { setVal(''); requestAnimationFrame(() => taRef.current?.focus()); };
    window.addEventListener('docvex:advisor-focus', focus);
    return () => window.removeEventListener('docvex:advisor-focus', focus);
  }, []);
  // While the app sidebar LISTS the chats, this page's rail steps aside (the
  // Legislation tab's rule): the two are one switch.
  const [sidebarLists, setSidebarLists] = useState(() => window.__docvexAdvisorListed === true && window.__docvexSidebarCollapsed !== true);
  useEffect(() => {
    const read = () => setSidebarLists(window.__docvexAdvisorListed === true && window.__docvexSidebarCollapsed !== true);
    window.addEventListener('docvex:advisor-listed', read);
    window.addEventListener('docvex:sidebar-state', read);
    read();
    return () => { window.removeEventListener('docvex:advisor-listed', read); window.removeEventListener('docvex:sidebar-state', read); };
  }, []);

  // The tab menu — the Legislation tabs' (LegalBrowser TabMenu), for chats.
  const chatMenuEl = (() => {
    if (!chatMenu) return null;
    const t = threads.find((x) => x.id === chatMenu.id);
    if (!t) return null;
    const close = () => setChatMenu(null);
    const others = threads.some((x) => x.id !== t.id && !x.pinned && !isBlankChat(x));
    const item = (label, kbd, fn, { disabled = false } = {}) => (
      <button type="button" role="menuitem" className="lgb-menu-item" disabled={disabled} onClick={() => { fn(); close(); }}>
        <span>{label}</span>{kbd ? <span className="lgb-menu-kbd">{kbd}</span> : null}
      </button>
    );
    return createPortal(
      <>
        <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onMouseDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
        <div role="menu" className="lgb-menu" style={{ left: Math.min(chatMenu.x, window.innerWidth - 240), top: Math.min(chatMenu.y, window.innerHeight - 240), zIndex: 9999 }}>
          {item('New chat', 'Ctrl+T', newChat)}
          {item(t.pinned ? 'Unpin' : 'Pin', '', () => toggleChatPin(t.id))}
          <div className="lgb-menu-sep" />
          {item('Close', 'Ctrl+W', () => deleteThread(t.id))}
          {item('Close other chats', '', () => closeOtherChats(t.id), { disabled: !others })}
          {item('Reopen closed chat', 'Ctrl+Shift+T', reopenClosedChat, { disabled: !chatsState().closed.length })}
        </div>
      </>,
      document.body,
    );
  })();

  // ── Attachments (paperclip picker + drag from the Files tab) ───────────
  const addAttachments = (incoming) => {
    if (!incoming.length) return;
    setAttachments((cur) => {
      const seen = new Set(cur.map((a) => a.path || a.name));
      return [...cur, ...incoming.filter((a) => (a.path || a.name) && !seen.has(a.path || a.name))];
    });
  };
  const removeAttachment = (key) => setAttachments((cur) => cur.filter((a) => (a.path || a.name) !== key));
  const onPickFiles = (e) => {
    const files = Array.from(e.target.files || []);
    addAttachments(files.map((file, i) => ({
      name: file.name,
      path: `picked:${file.name}:${file.size}:${file.lastModified}:${i}`,
      file,
    })));
    e.target.value = '';
  };
  // Files dragged from the Files tab carry a docvex payload.
  const acceptsFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('application/x-docvex-files');
  const readDropPayload = (e) => {
    let data = null;
    try { data = JSON.parse(e.dataTransfer.getData('application/x-docvex-files')); } catch { /* malformed */ }
    let incoming = (data?.items || []).filter((d) => d?.path && d.kind !== 'folder').map((d) => ({ name: d.name, path: d.path }));
    if (!incoming.length) incoming = (getDraggedFiles() || []).filter((f) => f.kind !== 'folder' && f.path).map((f) => ({ name: f.name, path: f.path }));
    return incoming;
  };
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
    addAttachments(readDropPayload(e));
    requestAnimationFrame(() => taRef.current?.focus());
  };
  // Dropping anywhere on the page attaches too (not just the composer).
  const onPageDragOver = (e) => { if (acceptsFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
  const onPageDrop = (e) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    setDropActive(false);
    addAttachments(readDropPayload(e));
  };

  // ── Guards (after hooks) ───────────────────────────────────────────────
  if (loading && !selectedProject) return null;
  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to use the AI tools.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  // ── Composer (portalled into the window footer, like the Chat tab) ─────
  const composer = (
    <div
      className={`vb-composer-wrap${dropActive ? ' aichat-dropping' : ''}`}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
    >
      {/* The model's clarifying questions (ask_user) — e.g. before it creates
          a file — float with the composer, just above the input box. */}
      {pendingAsk && !streaming && (
        <div className="aichat-askpanel">
          <AskUserPanel
            questions={pendingAsk.input?.questions || []}
            onSubmit={(perQuestion) => resolveAsk({ perQuestion })}
            onDismiss={() => resolveAsk({ dismissed: true })}
          />
        </div>
      )}
      {attachments.length > 0 && (
        <div className="aichat-attachments">
          {attachments.map((a) => (
            <span className="aichat-attach-chip" key={a.path || a.name}>
              {I.file({ width: 13, height: 13 })}
              <Tooltip content={a.name}><span className="aichat-attach-name">{a.name}</span></Tooltip>
              <button type="button" className="aichat-attach-x" onClick={() => removeAttachment(a.path || a.name)} aria-label={`Remove ${a.name}`}>{I.x({ width: 12, height: 12 })}</button>
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
          placeholder={pendingAsk ? 'Type an answer…' : 'Message DocVex AI…'}
          maxLength={4000}
        />
        <div className="dvx-composer-toolbar">
          <Tooltip content="Attach files"><button type="button" className="dvx-composer-btn" aria-label="Attach files" onClick={() => fileInputRef.current?.click()}>{I.paperclip({ width: 16, height: 16 })}</button></Tooltip>
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={onPickFiles} />
          <div className="dvx-composer-toolbar-spacer" />
          {streaming ? (
            <Tooltip content="Stop"><button type="button" className="dvx-composer-btn dvx-composer-send" onClick={stopTurn} aria-label="Stop generating">{I.stop({ width: 16, height: 16 })}</button></Tooltip>
          ) : (
            <Tooltip content="Send"><button type="button" className="dvx-composer-btn dvx-composer-send" onClick={() => send()} disabled={!val.trim()} aria-label="Send">{I.arrowUp({ width: 16, height: 16 })}</button></Tooltip>
          )}
        </div>
      </div>
    </div>
  );

  // ── Masthead + tabs bar (mirrors the Chat tab's chatHeader) ────────────
  const convoCount = `${threads.length} ${threads.length === 1 ? 'conversation' : 'conversations'}`;
  const header = (
    <>
      {/* The Design system's masthead (components/PageMasthead) — as the
          Legislation tab and the Newsletter have it. */}
      <PageMasthead eyebrow="Project AI" eyebrowMuted="Powered by Claude" title="Advisor" compact={false}>
        {`${selectedProject.name} · ${convoCount} · Sees the whole project — files, chat, timeline, extractions & captions`}
      </PageMasthead>
      {/* …and its MINI HEADER (components/LegalTabs — the gallery's "Mini
          header"): the view tabs, then the second line under the hairline —
          the conversations toggle at the left, the chat search (a find over
          the open chat, Ctrl/⌘+F) at the right. Sticky; its ground is
          ALWAYS drawn here (`.ai-chat-page .lgt-bar`). */}
      <LegalTabs
        standalone
        className="aichat-bar"
        ownTabs={{
          tabs: [{ id: 'chat', label: 'Chat' }, { id: 'debug', label: 'Debug' }],
          active: tab,
          onSelect: setTab,
        }}
        tools={tab === 'chat' && hasThreads ? (
          // The Design system's rail toggle (components/LegalTabs RailToggle),
          // the Legislation tab's: pressed while the chat list is shown.
          // Showing it takes the list back from the app sidebar.
          <RailToggle
            shown={!railHidden && !sidebarLists}
            what="chats"
            onToggle={() => {
              if (!railHidden && !sidebarLists) { toggleRail(); return; }
              if (railHidden) toggleRail();
              if (sidebarLists) window.dispatchEvent(new CustomEvent('docvex:advisor-list-set', { detail: { open: false } }));
            }}
          />
        ) : null}
        noSearch={!(tab === 'chat' && hasThreads)}
        search={tab === 'chat' && hasThreads ? {
          value: chatSearch,
          onChange: setChatSearch,
          placeholder: 'Search chats…',
          find: find.supported && find.total ? { current: find.current, total: find.total, prev: find.goPrev, next: find.goNext } : null,
        } : null}
      />
    </>
  );

  // ───── Render ──────────────────────────────────────────────────────────
  return (
    <div ref={pageRef} className={`ai-hub ai-chat-page${emptyChat ? ' is-empty-chat' : ''}`} onDragOver={onPageDragOver} onDrop={onPageDrop}>
      {chatMenuEl}
      {/* Fixed column (masthead → toolbar → shell); scrolling happens ONLY
          inside the thread (.aichat-main). The .dvx-scroll-area class stays
          for its shared width-cap rules; its overflow is disabled in CSS. */}
      <div className="dvx-scroll-area">
        {header}

        {tab === 'debug' ? (
          // Debug tab — intentionally left empty for now.
          <div className="aichat-debug aichat-fill" />
        ) : !hasThreads ? (
          // No conversations yet → centred empty state; the New-chat button is
          // the only entry point.
          <div className="aichat-empty aichat-fill">
            <div className="aichat-empty-card">
              <span className="aichat-empty-glyph">{I.chat({ width: 30, height: 30 })}</span>
              <div className="aichat-empty-title">No chats yet</div>
              <div className="aichat-empty-sub">You don’t have any conversations in {selectedProject.name}. Start a new chat to talk with DocVex AI about this project and its files.</div>
              <button type="button" className="aichat-empty-btn" onClick={newChat}>
                {I.plus({ width: 16, height: 16 })}
                <span>New chat</span>
              </button>
            </div>
          </div>
        ) : (
          <div className={`aichat-shell aichat-fill${railHidden || sidebarLists ? ' rail-hidden' : ''}${railResizing ? ' is-resizing' : ''}`}>
            {/* Conversation rail — every saved AI conversation + New chat.
                Width is user-resizable via the divider next to it. */}
            <aside
              ref={tabRailRef}
              className="aichat-rail is-tabrail"
              aria-hidden={railHidden || sidebarLists}
              /* Hidden: pull the rail (and its divider) off the shell's left
                 edge. The width is untouched, so re-showing lands back on
                 exactly the width the user dragged to. */
              style={{
                flexBasis: `calc(${railWidth}px + var(--ds-divider-pull, 11.2px))`,
                marginLeft: railHidden || sidebarLists
                  ? `calc(${-(railWidth + RAIL_DIVIDER_W)}px - 2 * var(--ds-divider-pull, 11.2px))`
                  : 'calc(-1 * var(--ds-divider-pull, 11.2px))',
              }}
              inert={railHidden || sidebarLists || undefined}
            >
              {/* THE LEGISLATION TABS' RAIL, for chats (components/LegalBrowser
                  TabRail — its classes, to the letter): the head with the
                  count and the switch that hands the list to the app sidebar,
                  "New chat" where the Search tab stands, pinned chats then the
                  rest, each a two-line tab (Advisor · when, then the title)
                  with × on hover; drag to reorder, right-click for the menu. */}
              <div className="lgb-rail-head">
                <span className="lgb-rail-label">Open · {ordered.length}</span>
                <span className="lgb-rail-headbtns">
                  <Tooltip content="Show these chats in the app sidebar">
                    <button type="button" className="lgb-rail-add" aria-label="Show these chats in the app sidebar" onClick={() => window.dispatchEvent(new CustomEvent('docvex:advisor-list-set', { detail: { open: true } }))}>
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d="m15 10-2 2 2 2" /></svg>
                    </button>
                  </Tooltip>
                </span>
              </div>
              <div className="lgb-rail-list" role="tablist" aria-orientation="vertical" ref={listRef} onScroll={onListScroll}>
                <div
                  role="tab"
                  aria-selected={isBlankChat(activeThread)}
                  tabIndex={0}
                  className={`lg-rail-item lgb-rtab lgb-searchtab${isBlankChat(activeThread) ? ' is-active' : ''}`}
                  onClick={newChat}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); newChat(); } }}
                >
                  <Tooltip content="New chat (Ctrl+T)">
                    <span className="lg-rail-title">
                      <span className="lg-rail-kind lgb-rtab-kind">
                        <span className="lgb-searchtab-ico">{I.plus({ width: 11, height: 11 })}</span>
                        <span className="lgb-rtab-kindtext">New chat</span>
                      </span>
                      <span className="lg-rail-num">Ask anything</span>
                    </span>
                  </Tooltip>
                </div>
                {visibleThreads.length ? <div className="lgb-rail-div" aria-hidden="true" /> : null}
                {(() => {
                  const tabEl = (t) => {
                    const busy = streaming && streamingThread === t.id;
                    const m = chatMeta(t, { busy });
                    const on = t.id === activeId;
                    return (
                      <div
                        key={t.id}
                        role="tab"
                        aria-selected={on}
                        tabIndex={0}
                        className={`lg-rail-item lgb-rtab${on ? ' is-active' : ''}${chatDrag?.id === t.id ? ' is-dragging' : ''}${chatDrag?.over === t.id && chatDrag?.id !== t.id ? ' is-drop' : ''}`}
                        onClick={() => selectThread(t.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectThread(t.id); } }}
                        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); deleteThread(t.id); } }}
                        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
                        onContextMenu={(e) => { e.preventDefault(); setChatMenu({ id: t.id, x: e.clientX, y: e.clientY }); }}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.id); } catch { /* ignore */ } setChatDrag({ id: t.id, over: null }); }}
                        onDragOver={(e) => { e.preventDefault(); if (chatDrag?.over !== t.id) setChatDrag((d) => (d ? { ...d, over: t.id } : d)); }}
                        onDrop={(e) => { e.preventDefault(); moveChat(chatDrag?.id, t.id); setChatDrag(null); }}
                        onDragEnd={() => setChatDrag(null)}
                      >
                        <Tooltip content={t.title}>
                          <span className="lg-rail-title">
                            <span className="lg-rail-kind lgb-rtab-kind">
                              {busy
                                ? <span className="lgb-spin" style={{ '--tone': m.tone }} />
                                : <span className="lgb-dot" style={{ '--tone': t.unreadAt ? 'var(--success)' : m.tone }} />}
                              <span className="lgb-rtab-kindtext">{t.unreadAt && !busy ? 'Advisor · new reply' : m.kind}</span>
                            </span>
                            <span className="lg-rail-num">{highlightMatch(t.title, searchQ)}</span>
                          </span>
                        </Tooltip>
                        <span className="lg-rail-actions">
                          {!t.pinned ? (
                            <Tooltip content="Close chat (Ctrl+W)">
                              <button type="button" aria-label="Close chat" onClick={(e) => { e.stopPropagation(); deleteThread(t.id); }}>{I.x({ width: 12, height: 12 })}</button>
                            </Tooltip>
                          ) : null}
                        </span>
                      </div>
                    );
                  };
                  const pinned = visibleThreads.filter((t) => t.pinned);
                  const rest = visibleThreads.filter((t) => !t.pinned);
                  return (
                    <>
                      {pinned.map(tabEl)}
                      {pinned.length && rest.length ? <div className="lgb-rail-div" aria-hidden="true" /> : null}
                      {rest.map(tabEl)}
                    </>
                  );
                })()}
                {searchQ && visibleThreads.length === 0 && (
                  <div className="aichat-rail-noresults">No chats match “{chatSearch.trim()}”.</div>
                )}
                <div className="lgb-rail-end" onDragOver={(e) => { e.preventDefault(); setChatDrag((d) => (d ? { ...d, over: '__end' } : d)); }} onDrop={(e) => { e.preventDefault(); moveChat(chatDrag?.id, null); setChatDrag(null); }} />
              </div>
            </aside>

            {/* The rail's divider — a drag handle that resizes the chat list
                (the hairline paints in its centre). */}
            <div
              ref={resizerRef}
              className={`aichat-resizer${railResizing ? ' is-active' : ''}`}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat list"
              onMouseDown={startRailResize}
              onDoubleClick={() => { setRailWidth(RAIL_DEFAULT); try { localStorage.setItem(RAIL_WIDTH_KEY, String(RAIL_DEFAULT)); } catch { /* quota */ } }}
              onMouseEnter={showRailSb}
              onMouseLeave={hideRailSb}
            >
              {/* The chat list's scroll INDICATOR rides ON the divider —
                  display-only (no pointer interaction); the whole band
                  resizes the rail. */}
              <div
                ref={sbThumbRef}
                className={`aichat-resizer-thumb${railSb.enabled && railSb.show ? ' is-visible' : ''}`}
                aria-hidden="true"
              />
            </div>

            {/* Thread column: the scrolling bubbles list with the composer
                docked in-flow at its bottom (inside the column, not in the
                window footer). */}
            <div className="aichat-thread-col" onMouseEnter={showMsgSb} onMouseLeave={hideMsgSb}>
            {/* Active conversation — the ONLY scroll container on the page:
                the bubbles scroll here while masthead/toolbar/rail stay put. */}
            <div className="aichat-main" ref={threadRef}>
              {messages.length === 0 && !streaming && (
                <div className="aichat-convo-empty">
                  {/* The Design system's EMPTY STATE (pages/LegalSourceStub
                      .lss-card — the Doc Viewer advisor's): a bare thin-stroke
                      mark in the accent, the title, a muted line; centred, no frame. */}
                  <section className="lss-card">
                    <span className="lss-mark" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 12.5a7.5 7.5 0 0 1-11.1 6.6L4 20l1-4.4A7.5 7.5 0 1 1 20 12.5Z" /><path d="M9 11h6M9 14h4" />
                      </svg>
                    </span>
                    <p className="lss-title">How can I help?</p>
                    <p className="lss-plain">Ask about {selectedProject.name}, or mention / attach any file from the Files tab and I’ll read it.</p>
                    {/* Things to ask — an UNEVEN GRID of the reply pills
                        (wrapping, each as wide as its words), scrolling in
                        its own box with fading edges, ENDLESS: more arrive
                        as the end comes into view (lib/advisorPrompts). */}
                    <div className="ai-choices aichat-starters" role="group" aria-label="Things to ask">
                      {[...caseStarters, ...starters].map((c, i) => (
                        // eslint-disable-next-line react/no-array-index-key
                        <button key={i} type="button" className="ai-choice" disabled={streaming} onClick={() => send(c)}>{c}</button>
                      ))}
                      <span ref={startersEndRef} className="aichat-starters-end" aria-hidden="true" />
                    </div>
                  </section>
                </div>
              )}
              <div className="chat">
                {messages.map((m, i) => {
                  let prevAt = null;
                  for (let j = i - 1; j >= 0; j--) {
                    if (messages[j].at) { prevAt = messages[j].at; break; }
                  }
                  const showDay = m.at && (!prevAt || !sameLocalDay(prevAt, m.at));
                  return (
                    <React.Fragment key={i}>
                      {showDay && (
                        <div className="aichat-day-divider" role="separator">
                          <span className="aichat-day-divider-label">{formatDayLabel(m.at)}</span>
                        </div>
                      )}
                      {m.interrupted ? (
                        /* Stop marker (à la Claude Code) — a quiet line, not a bubble. */
                        <div className="aichat-interrupted" role="status">
                          <span className="aichat-interrupted-elbow" aria-hidden="true">⎿</span>
                          <span>{m.text || 'Interrupted by user'}</span>
                        </div>
                      ) : (
                      <div className={`bubble ${m.who === 'me' ? 'me' : ''}`}>
                        <div className="bubble-c">
                          <div className="bubble-msg">
                            {m.who === 'me'
                              ? m.text
                              : (typing && typing.threadId === activeId && typing.index === i)
                                ? (
                                  <Typewriter
                                    text={replyBody(m.text)}
                                    onTick={scrollToBottom}
                                    onDone={() => setTyping(null)}
                                  />
                                )
                                : <AiMarkdown text={replyBody(m.text)} />}
                          </div>
                          {/* The reply's options as buttons (lib/aiChoices), on
                              the latest reply once it has finished typing. */}
                          {m.who !== 'me' && m.edits?.length > 0
                            && !(typing && typing.threadId === activeId && typing.index === i) && <AiEdits edits={m.edits} />}
                          {/* The files the answer comes from — chips that open them. */}
                          {m.who !== 'me' && !(typing && typing.threadId === activeId && typing.index === i) && (() => {
                            const src = resolveSources(replySources(m.text), contextFilesRef.current);
                            if (!src.length) return null;
                            return (
                              <div className="aichat-sources">
                                <span className="aichat-sources-label">From</span>
                                {src.map((s) => (
                                  <div key={s.path || s.name} className="aichat-source">
                                    <Tooltip content={`${s.folderPath ? `${s.folderPath}/` : ''}${s.name} — open`}>
                                      <button type="button" className="aichat-attach-chip is-static aichat-source-chip" onClick={() => openCreatedFile(s)}>
                                        {I.file({ width: 12, height: 12 })}<span className="aichat-attach-name">{s.name}</span>
                                      </button>
                                    </Tooltip>
                                    {s.why && <span className="aichat-source-why">{s.why}</span>}
                                  </div>
                                ))}
                              </div>
                            );
                          })()}
                          {m.who !== 'me' && i === messages.length - 1
                            && !(typing && typing.threadId === activeId && typing.index === i) && (
                            <AiChoices
                              choices={replyChoices(m.text)}
                              disabled={streaming}
                              onPick={(c) => send(c)}
                            />
                          )}
                          {m.who === 'me' && (m.attachments || []).length > 0 && (
                            <div className="aichat-msg-attachments">
                              {m.attachments.map((n, k) => (
                                <span className="aichat-attach-chip is-static" key={k}>{I.file({ width: 12, height: 12 })}<Tooltip content={n}><span className="aichat-attach-name">{n}</span></Tooltip></span>
                              ))}
                            </div>
                          )}
                          {/* A file the advisor created in the Files tab — a
                              Files-style card under the message: click selects,
                              double-click opens it in the Doc Viewer. */}
                          {m.who !== 'me' && m.createdFile
                            && !(typing && typing.threadId === activeId && typing.index === i) && (() => {
                            const cf = typeof m.createdFile === 'string'
                              ? { name: m.createdFile, relPath: m.createdFile, path: null, mime: '' }
                              : m.createdFile;
                            return (
                              <div className="aichat-created-file">
                                <div
                                  className={`aichat-file-card${selectedFileCard === i ? ' is-selected' : ''}`}
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => setSelectedFileCard((cur) => (cur === i ? null : i))}
                                  onDoubleClick={() => openCreatedFile(cf)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') openCreatedFile(cf); }}
                                  aria-label={`Open ${cf.name}`}
                                >
                                  <div className="aichat-file-card-thumb">
                                    <FileThumbnail
                                      descriptor={cf.path ? describeLocalFile({ localFile: { name: cf.name, path: cf.path, mimeType: cf.mime } }) : null}
                                      glyph={<ExtGlyph ext={extOf(cf.name)} />}
                                    />
                                  </div>
                                  <Tooltip content={cf.relPath || cf.name}>
                                    <div className="aichat-file-card-name">{cf.name}</div>
                                  </Tooltip>
                                </div>
                              </div>
                            );
                          })()}
                          {m.who === 'me' && m.at && (
                            <span className="aichat-time">{formatHM(m.at)}</span>
                          )}
                          {m.who !== 'me' && !m.isError
                            && !(typing && typing.threadId === activeId && typing.index === i) && (
                            <div className="aichat-msg-actions">
                              <Tooltip content="Copy">
                                <button
                                  type="button"
                                  className="aichat-msg-action"
                                  aria-label="Copy message"
                                  onClick={() => copyMessage(m.text || '', i)}
                                >
                                  {copiedIdx === i ? I.check({ width: 14, height: 14 }) : I.copy({ width: 14, height: 14 })}
                                  <span>{copiedIdx === i ? 'Copied' : 'Copy'}</span>
                                </button>
                              </Tooltip>
                              <Tooltip content="Retry">
                                <button
                                  type="button"
                                  className="aichat-msg-action"
                                  aria-label="Regenerate response"
                                  onClick={() => regenerate(i)}
                                  disabled={streaming}
                                >
                                  {I.refresh({ width: 14, height: 14 })}
                                  <span>Retry</span>
                                </button>
                              </Tooltip>
                            </div>
                          )}
                        </div>
                      </div>
                      )}
                    </React.Fragment>
                  );
                })}
                {streaming && streamingThread === activeId && (
                  <div className="bubble">
                    <div className="bubble-c">
                      <div className="bubble-msg"><ThinkingStatus query={messages.length ? messages[messages.length - 1]?.text : ''} /></div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Thread scrollbar — floats beside the masked scroller so the
                edge fades never touch it. */}
            <div className={`aichat-msg-scrollbar${msgSb.enabled && msgSb.show ? ' is-visible' : ''}`} aria-hidden="true">
              <div ref={msgThumbRef} className="aichat-msg-scrollbar-thumb" onMouseDown={onMsgThumbDown} />
            </div>

            {/* Composer — floats over the bottom of the bubbles column (text
                scrolls behind its frost). Hidden on the Debug tab and while
                there are no chats (the empty state's button is the only entry
                point). */}
            {composer}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
