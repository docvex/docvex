import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationsContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useUpdates } from '../context/UpdatesContext';
import { accountIdentity } from '../lib/account';
import { AiUsageBar } from './AiUsageMeter';
import { useAccountMenu } from './AccountMenu';
import { isElectron, isLocalhostWeb, openExternal, listDocViewerTabs, onDocViewerTabs, focusDocViewerTab, closeDocViewerTab } from '../lib/platform';
import { supabase } from '../lib/supabaseClient';
import { toLayoutPx } from '../lib/appZoom';
import { hasNewBrief, onNewsletterChanged } from '../lib/legalFeed';
import { prefetchProjects } from '../lib/projectListPrefetch';
import { preloadProjectList } from '../AppRoutes';
import Tooltip from './Tooltip';
import FileThumbnail from './FileThumbnail';
import { glyphForFile } from './fileGlyph';
import './Sidebar.css';

// localfile:// URL for an on-disk path so the Open-files rows can show real
// thumbnails (same scheme the Files page uses). Web paths (web://…) and the
// no-path case have no streamable URL, so the thumbnail resolver falls back to
// the MIME glyph. Mirrors localUrlFor in ProjectFiles.jsx.
function docTabLocalUrl(path) {
  if (!path || (typeof path === 'string' && path.startsWith('web://'))) return null;
  return `localfile://local/${encodeURIComponent(path)}`;
}

// External documentation site, opened in the user's browser (formerly the
// launch hub's "Documentation" footer link).
const DOCS_URL = 'https://docvex.ro/';

// Account identity + the account dashboard: lib/account.js (shared with the
// Doc Viewer's title bar).

// App nav — a horizontal bar pinned directly under the frameless title bar.
// (Formerly a vertical left rail; moved to the top per product direction.)
// Project navigation (Files / Chat / AI) lives in the window topbar's
// destination dropdown; Account lives in the title bar. This bar carries the
// personal destinations (Activity / Newsletter / Versions / Settings, + Debug
// in dev), a Documentation link out to the website, and the signed-out
// "Sign in" CTA.

// 2×2 grid — "All projects" (the Hub list at /projects; formerly the
// floating DOCVEX | HUB launcher above the rail).
const AllProjectsIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

// Globe — the web build's lead rail item: back out to the marketing website.
const WebsiteIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a13.4 13.4 0 0 1 0 18 13.4 13.4 0 0 1 0-18Z" />
  </svg>
);

// Pulse/heartbeat line — reads as "activity feed".
const ActivityIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
  </svg>
);

// Newspaper glyph — folded-page outline with masthead + column lines.
// The legislative portal: a book standing open, with the pillars of a code of
// law under it — a shape of our own, drawn to the same 20px stroke grid as
// every other rail icon rather than borrowed from anywhere.
const LegislationIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 7.5C10.6 6.2 8.6 5.5 6 5.5H4v11h2c2.6 0 4.6.7 6 2" />
    <path d="M12 7.5c1.4-1.3 3.4-2 6-2h2v11h-2c-2.6 0-4.6.7-6 2" />
    <path d="M12 7.5v13" />
  </svg>
);

const NewspaperIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 22h14a2 2 0 0 0 2-2V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v16a2 2 0 0 1-2-2V8"/>
    <path d="M8 7h6M8 11h6M8 15h4"/>
  </svg>
);

// Whether the System section is unfolded. Rail-wide, not per-user: it is a
// preference about the shape of the sidebar, like its width.
const SYSTEM_OPEN_KEY = 'docvex.sidebar.systemOpen';

// The System section's fold chevron. Points down when open, right when folded
// — the same reading as the rail's own collapse control.
const FoldChevron = (
  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

// Open book with a ribbon — the Playbook destination.
const PlaybookIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4.5A1.5 1.5 0 0 1 3 15.5z" />
    <path d="M21 5.5A1.5 1.5 0 0 0 19.5 4H16v8l-2-1.4L12 12" />
  </svg>
);

// A winding route between two stops (start → where it's headed) — the Roadmap
// destination.
const RoadmapIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="19" r="3" />
    <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
    <circle cx="18" cy="5" r="3" />
  </svg>
);

// Layers/stack glyph — the Versions (release history) destination.
const VersionsIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 2 7 12 12 22 7 12 2"/>
    <polyline points="2 17 12 22 22 17"/>
    <polyline points="2 12 12 17 22 12"/>
  </svg>
);

// Envelope glyph — the personal Mail (AI inbox) destination.
const MailIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2"/>
    <path d="m22 7-10 6L2 7"/>
  </svg>
);

// Gear glyph — the app Settings destination.
const GearIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);

// Bug glyph — dev-only Debug row.
const BugIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="8" y="6" width="8" height="14" rx="4"/>
    <path d="M12 2v4M9 4l1.5 2M15 4l-1.5 2M3 9h3M18 9h3M2 14h4M18 14h4M4 19l3-2M20 19l-3-2"/>
  </svg>
);

const SignInIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
    <polyline points="10 17 15 12 10 7"/>
    <line x1="15" y1="12" x2="3" y2="12"/>
  </svg>
);


// Shield glyph — the Developer Console (Admin) destination. Only shown to
// app admins (the `app_admins` allowlist, probed via the is_app_admin RPC).
const AdminIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
);

// Open-book glyph — the Documentation link out to the website.
const DocsIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
  </svg>
);

// Document glyph (page with a folded corner + text lines) — each open
// document-viewer window in the "Open files" section.
const DocFileIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 3 14 8 19 8"/>
    <line x1="9" y1="13" x2="15" y2="13"/>
    <line x1="9" y1="17" x2="13" y2="17"/>
  </svg>
);

// WhatsApp mark — shown for an open recognised WhatsApp conversation in place of
// the generic text glyph (it opens as a .txt, so glyphForFile can't tell).
const WhatsAppTabGlyph = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-2.9.8.8-2.8-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.6-6.1c-.3-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-2-1.2 7.4 7.4 0 0 1-1.4-1.7c-.1-.3 0-.4.1-.5l.4-.5.3-.4v-.4l-.8-1.9c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 2.9 2.9 0 0 0-.9 2.2 5 5 0 0 0 1.1 2.7 11.5 11.5 0 0 0 4.4 3.9c2.6 1 2.6.7 3.1.6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .1-1.2c-.1-.1-.3-.2-.5-.3z" />
  </svg>
);

// × glyph — the per-row close button on an open-file entry.
const CloseGlyph = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="6" y1="6" x2="18" y2="18"/>
    <line x1="18" y1="6" x2="6" y2="18"/>
  </svg>
);

// Folder glyph — the project Files surface.
const FilesIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
  </svg>
);

// Speech-bubble glyph — the project Chat surface.
const ChatIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 11.5a8.38 8.38 0 0 1-9 8.5 9 9 0 0 1-4-1L3 21l1.5-4a8.5 8.5 0 0 1 4-11.5 8.38 8.38 0 0 1 12.5 6z"/>
  </svg>
);

// A vertical timeline — a rail with two event nodes, each with its entry
// beside it — the project Timeline surface. (Keep in step with SplitView's
// NAV_ICONS.events.)
const TimelineIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3v2M6 9v6M6 19v2"/>
    <circle cx="6" cy="7" r="2"/>
    <circle cx="6" cy="17" r="2"/>
    <path d="M11 7h9M11 17h6"/>
  </svg>
);

// Sliders glyph — the project Settings/Overview surface (opens /projects/:id).
const ProjectSettingsIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="21" x2="4" y2="14"/>
    <line x1="4" y1="10" x2="4" y2="3"/>
    <line x1="12" y1="21" x2="12" y2="12"/>
    <line x1="12" y1="8" x2="12" y2="3"/>
    <line x1="20" y1="21" x2="20" y2="16"/>
    <line x1="20" y1="12" x2="20" y2="3"/>
    <line x1="1" y1="14" x2="7" y2="14"/>
    <line x1="9" y1="8" x2="15" y2="8"/>
    <line x1="17" y1="16" x2="23" y2="16"/>
  </svg>
);


// Spark glyph — the project AI surface.
const AiIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z"/>
    <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/>
  </svg>
);

export default function Sidebar({ collapsed = false, offstage = false, onHubNav }) {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  // Log out is in the account row's menu, behind a confirm step (the morph
  // pill's own). Note this uses signOut(), NOT AuthContext's logout() — logout
  // quits the desktop app entirely, whereas here we want to land on the auth
  // screen so the user can sign back in (or into another account) straight away.
  const [signingOut, setSigningOut] = useState(false);
  const doSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try { await signOut(); } catch { /* the local session is cleared regardless */ }
    setSigningOut(false);
    // Explicit: only the protected routes bounce to /auth on their own, so a
    // sign-out from a public page (Activity, Versions…) would otherwise leave
    // the user sitting on it.
    navigate('/auth', { replace: true });
  };
  const { unreadCount } = useNotifications();
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const { hasUpdate, currentVersion, latestVersion } = useUpdates();

  // AI-advisor activity (dispatched by the /ai page): busy while a turn is
  // thinking, unread once a reply landed in a non-open conversation. Drives
  // the dot on the Advisor nav item.
  const [advisorActivity, setAdvisorActivity] = React.useState({ busy: false, unread: false });
  React.useEffect(() => {
    const onEvt = (e) => setAdvisorActivity((s) => ({ ...s, ...(e.detail || {}) }));
    window.addEventListener('docvex:advisor-activity', onEvt);
    return () => window.removeEventListener('docvex:advisor-activity', onEvt);
  }, []);

  // Which semver field the pending update bumps — drives the Versions pill
  // colour (major = red, minor = amber, patch = green).
  const parseVer = (v) => String(v || '').replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  let updateKind = null;
  if (hasUpdate && currentVersion && latestVersion) {
    const [cMaj, cMin] = parseVer(currentVersion);
    const [lMaj, lMin] = parseVer(latestVersion);
    updateKind = lMaj > cMaj ? 'major' : lMin > cMin ? 'minor' : 'patch';
  }

  // Newsletter "new brief" pill — a brief was published after the user's last
  // visit to the tab. Checked on mount and whenever the newsletter signals a
  // change (a visit clears it, a Debug-page insert raises it).
  const [newBrief, setNewBrief] = useState(false);
  useEffect(() => {
    const userId = session?.user?.id || null;
    if (!userId) { setNewBrief(false); return undefined; }
    let cancelled = false;
    const check = () => {
      hasNewBrief(userId).then((v) => { if (!cancelled) setNewBrief(v); }).catch(() => {});
    };
    check();
    const off = onNewsletterChanged(check);
    return () => { cancelled = true; off(); };
  }, [session?.user?.id]);

  // Account identity for the footer row (avatar + name + email).
  const {
    name: accountName, email: accountEmail, avatarUrl: accountAvatarUrl, initial: accountInitial,
  } = accountIdentity(session);

  // The account row: HOVER shows a card with the account and the selected
  // project's AI usage this month; CLICK morphs that card into a menu — Account
  // settings, Log out (which asks first, in the same pill). Shared with the Doc
  // Viewer's title-bar avatar (components/AccountMenu).
  const { aiUsage, pill: accountPill } = useAccountMenu({
    onSettings: () => navigate('/account'),
    onLogout: doSignOut,
    loggingOut: signingOut,
  });

  // Whether the signed-in user is an app admin (the `app_admins` allowlist) —
  // gates the Developer Console (Admin) tab. Probed once per session via the
  // is_app_admin SECURITY DEFINER RPC; non-admins get `false` and never see
  // the tab (the Admin page's data is server-gated anyway, so showing it to a
  // non-admin would only render a half-broken console).
  const [isAdmin, setIsAdmin] = useState(false);
  const userId = session?.user?.id || null;
  useEffect(() => {
    if (!userId) { setIsAdmin(false); return undefined; }
    let alive = true;
    supabase.rpc('is_app_admin').then(({ data }) => { if (alive) setIsAdmin(data === true); });
    return () => { alive = false; };
  }, [userId]);

  // Open document-viewer windows — each file double-clicked in the Files page
  // opens its own dedicated viewer window (one file = one window). Main keeps a
  // registry and pushes the current list here so the "Open files" section can
  // list them and refocus / close one. Empty on web (no extra windows).
  const [docTabs, setDocTabs] = useState([]);
  useEffect(() => {
    let alive = true;
    listDocViewerTabs().then((list) => { if (alive) setDocTabs(Array.isArray(list) ? list : []); });
    const off = onDocViewerTabs((list) => setDocTabs(Array.isArray(list) ? list : []));
    return () => { alive = false; off(); };
  }, []);

  // Project surfaces — shown only when a project is selected (the workspace
  // navigation that used to live in the in-content rail). These routes read
  // the active project from SelectedProjectContext.
  const projectItems = selectedProjectId ? [
    // Project settings/overview — the project name chip that used to live in
    // the window title bar now leads the Project section, opening /projects/:id
    // (Overview + Members/Roles/AI/Settings tabs). `end` so it's only active on
    // the exact overview route, not the deeper project surfaces below.
    // Electron only — the web demo has no members/roles/settings to manage,
    // so its Project section starts straight at Files.
    ...(isElectron ? [{
      to: `/projects/${selectedProjectId}`,
      label: selectedProject?.name || 'Project settings',
      icon: ProjectSettingsIcon,
      end: true,
    }] : []),
    { to: '/files', label: 'Files', icon: FilesIcon },
    { to: '/chat', label: 'Chat', icon: ChatIcon },
    { to: '/events', label: 'Timeline', icon: TimelineIcon },
    {
      to: '/ai',
      label: 'Advisor',
      icon: AiIcon,
      // Busy = a turn is thinking; done = a reply waits in a conversation.
      dot: advisorActivity.busy ? 'busy' : advisorActivity.unread ? 'done' : null,
    },
    { to: '/roadmap', label: 'Roadmap', icon: RoadmapIcon },
  ] : [];

  // Personal destinations — the user's own feeds, always available.
  const personalItems = [
    {
      to: '/', label: 'Activity', icon: ActivityIcon, end: true,
      badge: unreadCount > 0 ? (unreadCount > 9 ? '9+' : String(unreadCount)) : null,
    },
    {
      to: '/newsletter', label: 'Newsletter', icon: NewspaperIcon, end: true,
      // "New brief" pill — cleared when the user opens the tab.
      pill: newBrief ? { kind: 'brief', text: 'new' } : null,
    },
    // The national legislative portal, read in the app and kept on the machine
    // (pages/Legislation). Beside the Newsletter because the two answer the
    // same question at different ranges: what has just changed, and what the
    // law actually says.
    { to: '/legislation', label: 'Legislation', icon: LegislationIcon, end: true },
    ...(session ? [{ to: '/mail', label: 'Mail', icon: MailIcon, end: true }] : []),
    { to: '/playbook', label: 'Playbook', icon: PlaybookIcon, end: true },
    {
      to: '/versions', label: 'Versions', icon: VersionsIcon, end: true,
      // Update-available pill, colored by the pending release's bump type.
      pill: updateKind ? { kind: updateKind, text: updateKind } : null,
    },
  ];

  // System destinations. Settings is signed-in only (matches where the gear
  // used to live); Admin is app-admin only (is_app_admin probe above); Debug
  // is dev-only (import.meta.env.DEV is false in packaged + web builds).
  const systemItems = [
    ...(session ? [{ to: '/settings', label: 'Settings', icon: GearIcon, end: true }] : []),
    ...(session && isAdmin ? [{ to: '/admin', label: 'Admin', icon: AdminIcon, end: true }] : []),
    // Debug: dev builds, plus the BUILT web app when served from localhost
    // (import.meta.env.DEV is false there but it's still a dev surface).
    ...((import.meta.env.DEV || isLocalhostWeb) ? [{ to: '/debug', label: 'Debug', icon: BugIcon, end: true }] : []),
  ];

  // System section — foldable. Settings is the row anyone actually comes here
  // for; Admin, Debug, Docs and Privacy are things you look up once and then
  // want out of the way. Folded, the section keeps ONLY Settings, so the rail
  // ends on the row it ends on for most people instead of five.
  const [systemOpen, setSystemOpen] = useState(() => {
    try { return localStorage.getItem(SYSTEM_OPEN_KEY) !== '0'; } catch { return true; }
  });
  const toggleSystem = () => {
    setSystemOpen((v) => {
      const next = !v;
      try { localStorage.setItem(SYSTEM_OPEN_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };
  // What survives the fold: Settings alone. Not "the first item" — if Settings
  // is missing (signed out) the section folds to nothing, which is correct.
  const shownSystemItems = systemOpen ? systemItems : systemItems.filter((i) => i.to === '/settings');

  // Hub warm-up. Both halves are idempotent and de-duped internally (the
  // dynamic import resolves from the module cache, the fetch reuses its
  // in-flight promise / fresh snapshot), so firing this on every hover of the
  // Projects row costs nothing after the first.
  const warmHub = () => {
    preloadProjectList();
    prefetchProjects();
  };

  // Render a single NavLink nav-item from a descriptor (shared by every
  // category group).
  const renderNavItem = ({ to, label, icon, end, badge, pill, dot, onClick, onWarm }) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      onClick={onClick}
      // `onWarm` fires on hover / keyboard focus so a route can start loading
      // its chunk and its data before the click lands. Pointer-enter rather
      // than mouse-over so it fires once per entry, not per child element.
      onPointerEnter={onWarm}
      onFocus={onWarm}
      className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
    >
      <span className="icon">
        {icon}
        {/* Collapsed rail: the unread badge, the update pill and the activity
            dot all fall back to the corner dot. */}
        {(badge || pill || dot) && <span className={`nav-badge${pill ? ` is-${pill.kind}` : ''}`} aria-hidden="true" />}
      </span>
      <span className="label nav-label-row">
        {label}
        {badge && <span className="nav-badge-text">{badge}</span>}
        {pill && <span className={`nav-update-pill is-${pill.kind}`}>{pill.text}</span>}
        {/* Activity dot (e.g. the AI advisor): pulsing while busy, solid once
            a result is waiting. */}
        {dot && <span className={`nav-dot is-${dot}`} aria-hidden="true" />}
      </span>
    </NavLink>
  );

  // Cursor-following spotlight: write the pointer position (sidebar-relative,
  // layout px) into CSS vars on this node so the `.sidebar::before` radial glow
  // tracks the mouse. Scoped to the sidebar element, so the per-move style write
  // only invalidates this subtree (not the whole document).
  // The nav button the cursor was last over — so we can clear its per-button
  // spotlight coords when the pointer leaves it (otherwise a selected/active
  // button's fill stays frozen at the last cursor position).
  const lastItemRef = useRef(null);
  const clearItemSpot = (item) => {
    if (!item) return;
    item.style.removeProperty('--item-spot-x');
    item.style.removeProperty('--item-spot-y');
  };

  // The <nav> element, plus the eased rail-glow state. The rail glow
  // (`--spot-x/--spot-y` → `.sidebar::before`) CHASES the cursor target a
  // fraction of the remaining distance each frame so it trails the pointer with
  // a soft delay (matching the app-wide CursorSpotlight feel), instead of
  // snapping. The per-button highlight below stays immediate so hovered items
  // light up instantly. The loop self-parks once settled and restarts on move.
  const navRef = useRef(null);
  const spotTargetRef = useRef({ x: 0, y: 0 });
  const spotPosRef = useRef({ x: 0, y: 0, started: false });
  const spotFrameRef = useRef(null);
  const spotLastTsRef = useRef(null); // rAF timestamp of the previous tick
  const SPOT_EASE = 0.28; // per-60fps-frame ease — higher = snappier follow
  const SPOT_SETTLE = 0.5; // px — snap-and-stop threshold
  const FRAME_60 = 1000 / 60; // reference frame duration the ease is tuned for

  const tickSpot = (ts) => {
    const el = navRef.current;
    if (!el) { spotFrameRef.current = null; spotLastTsRef.current = null; return; }
    const pos = spotPosRef.current;
    const t = spotTargetRef.current;
    // FPS-independent easing: convert the per-frame ease into an exponential
    // decay over elapsed time, so the glow trails the cursor at the same rate
    // regardless of refresh rate (60Hz vs 144Hz) or dropped frames. dt is
    // clamped so a long stall (e.g. backgrounded tab) doesn't snap-teleport.
    const last = spotLastTsRef.current;
    spotLastTsRef.current = ts;
    const dt = last == null ? FRAME_60 : Math.min(ts - last, 100);
    const factor = 1 - Math.pow(1 - SPOT_EASE, dt / FRAME_60);
    const dx = t.x - pos.x;
    const dy = t.y - pos.y;
    if (Math.abs(dx) < SPOT_SETTLE && Math.abs(dy) < SPOT_SETTLE) {
      pos.x = t.x;
      pos.y = t.y;
    } else {
      pos.x += dx * factor;
      pos.y += dy * factor;
    }
    el.style.setProperty('--spot-x', `${pos.x}px`);
    el.style.setProperty('--spot-y', `${pos.y}px`);
    if (pos.x === t.x && pos.y === t.y) { spotFrameRef.current = null; spotLastTsRef.current = null; return; }
    spotFrameRef.current = requestAnimationFrame(tickSpot);
  };

  const onSpotMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    spotTargetRef.current = {
      x: toLayoutPx(e.clientX - r.left),
      y: toLayoutPx(e.clientY - r.top),
    };
    // First move after (re)entering the rail: snap the glow to the cursor so it
    // doesn't slide in from a stale/corner position, then ease from there.
    if (!spotPosRef.current.started) {
      spotPosRef.current = { ...spotTargetRef.current, started: true };
    }
    if (spotFrameRef.current == null) spotFrameRef.current = requestAnimationFrame(tickSpot);
    // Feed the nav button under the cursor its OWN (button-relative) spotlight
    // coords so its hover / selection fill brightens where the pointer is. This
    // stays immediate (no easing) so the hovered item reads as responsive. When
    // the cursor moves off a button, reset that button so its fill recenters
    // (falls back to the 50% default) instead of freezing at the last position.
    // (The account row at the foot takes the same hover as the tabs.)
    const item = e.target.closest('.nav-item, .sidebar-account-main');
    if (item !== lastItemRef.current) {
      clearItemSpot(lastItemRef.current);
      lastItemRef.current = item;
    }
    if (item) {
      const ir = item.getBoundingClientRect();
      item.style.setProperty('--item-spot-x', `${toLayoutPx(e.clientX - ir.left)}px`);
      item.style.setProperty('--item-spot-y', `${toLayoutPx(e.clientY - ir.top)}px`);
    }
    // The SELECTED tab also reacts to the spotlight even when the cursor is over
    // a different row: project the cursor onto the active item's box so its
    // gradient brightens toward the pointer. Runs after the hovered-item block
    // (which may have just cleared these vars if the active item was the one we
    // moved off of), so this re-sets them every move.
    const activeItem = e.currentTarget.querySelector('.nav-item.active');
    if (activeItem) {
      const ar = activeItem.getBoundingClientRect();
      activeItem.style.setProperty('--item-spot-x', `${toLayoutPx(e.clientX - ar.left)}px`);
      activeItem.style.setProperty('--item-spot-y', `${toLayoutPx(e.clientY - ar.top)}px`);
    }
  };
  const onSpotLeave = () => {
    clearItemSpot(lastItemRef.current);
    lastItemRef.current = null;
    // NOTE: intentionally DON'T reset the selected tab's spotlight here —
    // snapping its gradient back to centre on leave reads as the tab styling
    // "changing" as the cursor exits. Holding the last position keeps it steady;
    // it re-tracks the cursor on the next move.
    // Re-arm the snap so the next entry doesn't trail in from where it parked.
    spotPosRef.current.started = false;
  };

  // Cancel any in-flight easing frame on unmount.
  useEffect(() => () => {
    if (spotFrameRef.current != null) cancelAnimationFrame(spotFrameRef.current);
  }, []);

  return (
    <nav
      className={`sidebar${collapsed ? ' is-collapsed' : ''}`}
      ref={navRef}
      onMouseMove={onSpotMove}
      onMouseLeave={onSpotLeave}
      // Off-window on the Hub (slid out via the .app-shell.on-hub margin
      // transition) — inert so the hidden rail can't take keyboard focus.
      inert={offstage || undefined}
    >
      <ul className="sidebar-nav">
        {/* Web build only: a lead row linking back to the marketing website
            (served at the site root on the same origin). The desktop build has
            no lead row — its Projects launcher moved down into Personal. */}
        {!isElectron ? (
          <li className="sidebar-cat sidebar-cat--lead">
            <div className="sidebar-cat-items">
              <a className="nav-item" href="/">
                <span className="icon">{WebsiteIcon}</span>
                <span className="label nav-label-row">Website</span>
              </a>
            </div>
          </li>
        ) : null}

        {/* ── Personal — the user's own feeds. ── */}
        <li className="sidebar-cat">
          <span className="sidebar-cat-label">
            <span className="sidebar-cat-text">Personal</span>
          </span>
          <div className="sidebar-cat-items">
            {/* Projects (the Hub launcher) leads the Personal section — it used
                to sit above the divider as its own lead row. Opens /projects,
                where this sidebar slides out of the window so the Hub fills it;
                the click is intercepted (onHubNav → AppShell) so the current
                page fades and the rail starts sliding BEFORE the route swaps,
                with plain navigation as the fallback. */}
            {isElectron && session && renderNavItem({
              to: '/projects',
              label: 'Projects',
              icon: AllProjectsIcon,
              end: true,
              onClick: onHubNav ? (e) => { e.preventDefault(); onHubNav(); } : undefined,
              // Hovering the row loads the Hub's chunk and starts its project
              // query, so by the time the click lands the page can mount with
              // its rows already in hand instead of on an empty frame.
              onWarm: warmHub,
            })}
            {personalItems.map(renderNavItem)}
          </div>
        </li>

        {/* ── Project — the selected project's surfaces (only when one is
            picked); replaces the old in-content navigation rail. ── */}
        {projectItems.length > 0 && (
          <li className="sidebar-cat">
            <span className="sidebar-cat-label"><span className="sidebar-cat-text">Project</span></span>
            <div className="sidebar-cat-items">
              {projectItems.map(renderNavItem)}
            </div>
          </li>
        )}

        {/* ── Open files — every open document-viewer window. Clicking a row
            refocuses that window; the × closes it. Hidden when none are open
            (and always on web, where viewers open in the same tab). ── */}
        {docTabs.length > 0 && (
          <li className="sidebar-cat">
            <span className="sidebar-cat-label"><span className="sidebar-cat-text">Open files</span></span>
            <div className="sidebar-cat-items">
              {docTabs.map((t) => (
                <div key={t.id} className="doc-tab-row">
                  <Tooltip content={t.aiBusy ? `${t.name} — AI working…` : t.name}>
                    <button
                      type="button"
                      className={`nav-item doc-tab-main${t.aiBusy ? ' is-ai-busy' : ''}`}
                      onClick={() => focusDocViewerTab(t.id)}
                    >
                      <span className="icon doc-tab-icon">
                        {/* Real file thumbnail (image/video/PDF/DOCX/PPTX preview),
                            same renderer the Files page uses — falls back to the
                            per-file-type MIME glyph when no preview resolves or the
                            "Display thumbnails" pref is off. WhatsApp chats are a
                            .txt, so keep their brand glyph. */}
                        <span className={`doc-tab-thumb${t.isWhatsApp ? ' is-wa' : ''}`}>
                          {t.isWhatsApp
                            ? WhatsAppTabGlyph
                            : (
                              <FileThumbnail
                                mimeType={t.mime}
                                name={t.name}
                                sourceUrl={docTabLocalUrl(t.path)}
                                glyph={glyphForFile(t.mime, t.name)}
                              />
                            )}
                        </span>
                        {t.aiBusy && <span className="doc-tab-ai-dot" aria-label="AI working" />}
                      </span>
                      <span className="label doc-tab-name">{t.name}</span>
                      {t.aiBusy && <span className="label doc-tab-ai-tag" aria-hidden="true">AI</span>}
                    </button>
                  </Tooltip>
                  <button
                    type="button"
                    className="doc-tab-close"
                    onClick={() => closeDocViewerTab(t.id)}
                    aria-label={`Close ${t.name}`}
                  >
                    {CloseGlyph}
                  </button>
                </div>
              ))}
            </div>
          </li>
        )}

        {/* ── System — settings, admin, docs. Pinned to the bottom of the rail. ── */}
        <li className={`sidebar-cat sidebar-cat--end${systemOpen ? '' : ' is-folded'}`}>
          {/* The label is the control. A section header that folds its own
              section needs no second affordance, and a separate button would
              be another target in a rail that is mostly targets. */}
          <Tooltip content={systemOpen ? 'Fold — keep only Settings' : 'Unfold — Admin, Docs, Privacy'}>
            <button
              type="button"
              className="sidebar-cat-label sidebar-cat-fold"
              onClick={toggleSystem}
              aria-expanded={systemOpen}
            >
              <span className="sidebar-cat-text">System</span>
              <span className="sidebar-cat-chev" aria-hidden="true">{FoldChevron}</span>
            </button>
          </Tooltip>
          <div className="sidebar-cat-items">
            {shownSystemItems.map(renderNavItem)}
            {/* Documentation — external link to the website (opens in the
                browser), not an in-app route, so it's a button. */}
            {systemOpen && <Tooltip content="Open the documentation site">
              <button
                type="button"
                className="nav-item"
                onClick={() => openExternal(DOCS_URL)}
              >
                <span className="icon">{DocsIcon}</span>
                <span className="label">Docs</span>
              </button>
            </Tooltip>}
          </div>
        </li>
      </ul>

      <div className="sidebar-footer">
        {/* Account — avatar + name + email + the selected project's AI usage
            bar, one hover area. Hover: a card with the account and the AI
            usage numbers. Click: that card morphs into a menu (Account
            settings, Log out). The signed-out "Sign in" CTA shows when
            there's no session. */}
        {session ? (
          <div className="sidebar-account">
            <button
              type="button"
              className={`sidebar-account-main${accountPill.isMenuOpen ? ' is-open' : ''}`}
              onMouseMove={accountPill.handleMouseMove}
              onMouseLeave={accountPill.handleMouseLeave}
              onClick={accountPill.handleOpenMenu}
              aria-haspopup="menu"
              aria-expanded={accountPill.isMenuOpen}
              aria-label={`${accountName} — account menu`}
            >
              <span className="sidebar-avatar-wrap">
                {accountAvatarUrl
                  ? <img className="sidebar-avatar" src={accountAvatarUrl} alt="" referrerPolicy="no-referrer" />
                  : <span className="sidebar-avatar sidebar-avatar-fallback">{accountInitial}</span>}
              </span>
              <span className="sidebar-account-id">
                <span className="sidebar-account-name">{accountName}</span>
                {accountEmail && <span className="sidebar-account-email">{accountEmail}</span>}
                {/* The selected project's AI usage this month — the numbers are
                    in the hover card. */}
                {selectedProjectId && <AiUsageBar usage={aiUsage} className="sidebar-account-usage" />}
              </span>
            </button>
            {accountPill.node}
          </div>
        ) : (
          <NavLink to="/auth" className="nav-item signin-btn">
            <span className="icon">{SignInIcon}</span>
            <span className="label">Sign in</span>
          </NavLink>
        )}
      </div>

    </nav>
  );
}
