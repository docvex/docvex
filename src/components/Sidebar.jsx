import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationsContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useUpdates } from '../context/UpdatesContext';
import { accountIdentity } from '../lib/account';
import { AiUsageBar } from './AiUsageMeter';
import { useAccountMenu } from './AccountMenu';
import { isElectron, openExternal, openTabWindow, canOpenTabWindow, isTabWindow } from '../lib/platform';
import { toLayoutPx } from '../lib/appZoom';
import { hasNewBrief, onNewsletterChanged } from '../lib/legalFeed';
import { LEGISLATION_PATHS } from './LegalTabs';
import './RefPill.css';
import { isBlankChat } from '../lib/advisorChats';
import { researchStore, bindResearch } from '../lib/researchChats';
import { subscribeRunner as subscribeResearchRun, runnerActivity as researchRunState, anyRunning as researchAnyRunning, isThreadBusy as researchThreadBusy } from '../lib/researchRunner';
import { prefetchProjects } from '../lib/projectListPrefetch';
import { preloadProjectList } from '../AppRoutes';
import Tooltip from './Tooltip';
import { useMorphPill } from './useMorphPill';
import './Sidebar.css';
import { perfAllows } from '../lib/perf';
import { subscribePointer } from '../lib/pointer';

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

// Pulse/heartbeat line — reads as "activity feed".
const ActivityIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
  </svg>
);

// A folded newspaper — the Newsletter destination.
const NewsletterIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h11A1.5 1.5 0 0 1 18 5.5V19a1 1 0 0 0 1 1H6a2 2 0 0 1-2-2z" />
    <path d="M18 9h1.5A1.5 1.5 0 0 1 21 10.5V18a2 2 0 0 1-2 2" />
    <path d="M8 8h6M8 12h6M8 16h3" />
  </svg>
);

// Legislation — the portal, the CAEN nomenclature and the other sources, one
// entry (components/LegalTabs is the bar between them): a book standing open,
// a shape of our own, drawn to the same 20px stroke grid as every other rail
// icon rather than borrowed from anywhere.
const LegislationIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 7.5C10.6 6.2 8.6 5.5 6 5.5H4v11h2c2.6 0 4.6.7 6 2" />
    <path d="M12 7.5c1.4-1.3 3.4-2 6-2h2v11h-2c-2.6 0-4.6.7-6 2" />
    <path d="M12 7.5v13" />
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

// Layers/stack glyph — the Versions (release history) destination.
const VersionsIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 2 7 12 12 22 7 12 2"/>
    <polyline points="2 17 12 22 22 17"/>
    <polyline points="2 12 12 17 22 12"/>
  </svg>
);

// Gear glyph — the app Settings destination.
const GearIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);

// Swatches — the Design system row.
const SwatchIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="18" rx="1.5" />
    <path d="M10 8.5l4.2-4.2a1.5 1.5 0 0 1 2.1 0l3.4 3.4a1.5 1.5 0 0 1 0 2.1L12 17.5" />
    <path d="M12.5 21H19a2 2 0 0 0 2-2v-6" />
    <circle cx="6.5" cy="17" r="1" fill="currentColor" />
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


// Open-book glyph — the Documentation link out to the website.
const DocsIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
  </svg>
);

// A SIDEBAR TAB'S MORPH PILL (components/useMorphPill — the Files tiles'):
// hovering shows its name as the custom tooltip; a RIGHT-CLICK morphs that
// tooltip into a menu — Open, and Pop out (the tab in a window of its own,
// main window only). The host is display: contents, so it adds no box.
// Whether Research's dropdown (its chats) is open.
const RESEARCH_OPEN_KEY = 'docvex.sidebar.researchOpen';
// A Research chat's hover pill — the same highlight pill: what it is, its
// title, the last thing said in it, what a click does.
function chatTabPill(t, m, label = 'Research') {
  const last = [...(t.messages || [])].reverse().find((x) => String(x.text || '').trim());
  const said = last ? String(last.text).replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim() : '';
  return (
    <span className="dv-refpill" style={{ '--refpill-tone': t.unreadAt ? 'var(--success)' : 'var(--accent)' }}>
      <span className="dv-refpill-kind">{t.unreadAt ? `${label} · new reply` : m.kind}</span>
      <span className="dv-refpill-head">{m.title}</span>
      {said ? <span className="dv-refpill-line">{last.who === 'me' ? 'You: ' : ''}{said.length > 140 ? `${said.slice(0, 140)}…` : said}</span> : null}
      <span className="dv-refpill-act">Click to open · right-click for more</span>
    </span>
  );
}

// A Legislation tab's hover pill — the DOC VIEWER'S highlight pill
// (components/RefPill.css, `refPill` in pages/DocViewer.jsx): the platform in
// its colour, the item's name, what it is, what a click does.
function legalTabPill(m, page) {
  const loaded = page?.loaded || null;
  const head = loaded?.title || m.title || 'New tab';
  const kind = loaded?.kind || m.ownKind || m.kind || '';
  const shownAs = loaded?.title && m.title && loaded.title !== m.title ? m.title : '';
  return (
    <span className="dv-refpill" style={{ '--refpill-tone': m.tone || 'var(--accent)' }}>
      <span className="dv-refpill-kind">{m.siteName || m.site || 'DocVex'}</span>
      <span className="dv-refpill-head">{head}</span>
      {kind ? <span className="dv-refpill-line">{kind}</span> : null}
      {shownAs ? <span className="dv-refpill-line">Opened as “{shownAs}”</span> : null}
      <span className="dv-refpill-act">Click to open · right-click for more</span>
    </span>
  );
}

function TabMenuPill({ hover, onOpen, popRoute, popTitle, onBeforePop, children }) {
  const morph = useMorphPill({
    hoverContent: hover,
    menuItems: [
      { key: 'open', label: 'Open', onClick: onOpen },
      !isTabWindow && {
        key: 'pop',
        label: canOpenTabWindow ? 'Pop out' : 'Pop out — restart DocVex to enable',
        disabled: !canOpenTabWindow,
        onClick: () => { onBeforePop?.(); openTabWindow(popRoute, popTitle); },
      },
    ],
  });
  return (
    <span className="tab-pill-host" onMouseMove={morph.handleMouseMove} onMouseLeave={morph.handleMouseLeave} onContextMenu={morph.handleContextMenu}>
      {children}
      {morph.node}
    </span>
  );
}

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


// A line of text that shows ALL of itself, and only when the row is too
// narrow for it (the rail's width) FADES OUT at the row's edge — measured,
// so a line that fits is never faded (`.is-clipped`).
function FadeText({ className, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const check = () => el.classList.toggle('is-clipped', el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [children]);
  return <span ref={ref} className={className}>{children}</span>;
}

// The account row at the rail's foot, in a component of its own: its hover
// card is a morph pill that sets state on EVERY mouse move over the row, and
// while the hook lived in Sidebar each of those moves re-rendered the whole
// rail. Now only this row re-renders as the pointer crosses it.
function SidebarAccount({ session, selectedProjectId, onSettings, onLogout, loggingOut }) {
  // Account identity for the footer row (avatar + name + email).
  const {
    name: accountName, email: accountEmail, avatarUrl: accountAvatarUrl, initial: accountInitial,
  } = accountIdentity(session);

  // The account row: HOVER shows a card with the account and the selected
  // project's AI usage this month; CLICK morphs that card into a menu — Account
  // settings, Log out (which asks first, in the same pill). Shared with the Doc
  // Viewer's title-bar avatar (components/AccountMenu).
  const { aiUsage, pill: accountPill } = useAccountMenu({
    onSettings,
    onLogout,
    loggingOut,
  });

  return (
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
  );
}

function Sidebar({ collapsed = false, offstage = false, onHubNav }) {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
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

  // Research's running work (lib/researchRunner — it carries on when the page
  // is left): a spinner on the Research row while anything runs, and on each
  // chat tab that is working.
  const researchRun = useSyncExternalStore(subscribeResearchRun, researchRunState);
  const researchBusy = researchAnyRunning(researchRun);

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

  // Project surfaces — shown only when a project is selected (the workspace
  // navigation that used to live in the in-content rail). These routes read
  // the active project from SelectedProjectContext.
  // LEGISLATION (2026-10-02, formerly Research): one entry with tabs — Ask
  // (this route) and every source — so it is active on all of their routes.
  const RESEARCH_ITEM = { to: '/research', label: 'Legislation', icon: LegislationIcon, end: true, fold: 'research', activeOn: LEGISLATION_PATHS, dot: researchBusy ? 'spin' : null };
  const projectItems = selectedProjectId ? [
    // The project's Dashboard — its overview — leads the section (which is
    // headed by the project's own name), opening /projects/:id
    // (Overview + Members/Roles/AI/Settings tabs). `end` so it's only active on
    // the exact overview route, not the deeper project surfaces below.
    {
      to: `/projects/${selectedProjectId}`,
      label: 'Dashboard',
      icon: ProjectSettingsIcon,
      end: true,
    },
    // Research stands right under the Dashboard (it was a card of its own
    // above the rail). With no project picked it leads the DocVex section.
    RESEARCH_ITEM,
    { to: '/files', label: 'Files', icon: FilesIcon },
  ] : [];

  // Personal destinations — the user's own feeds, always available.
  const personalItems = [
    {
      to: '/', label: 'Activity', icon: ActivityIcon, end: true,
      badge: unreadCount > 0 ? (unreadCount > 9 ? '9+' : String(unreadCount)) : null,
    },
    // The Newsletter, an entry of its own again (the sources moved into the
    // Legislation entry's tabs): its "new brief" pill, cleared when opened.
    {
      to: '/newsletter', label: 'Newsletter', icon: NewsletterIcon, end: true,
      pill: newBrief ? { kind: 'brief', text: 'new' } : null,
    },
    { to: '/playbook', label: 'Playbook', icon: PlaybookIcon, end: true },
    {
      to: '/versions', label: 'Updates', icon: VersionsIcon, end: true,
      // Update-available pill, colored by the pending release's bump type.
      pill: updateKind ? { kind: updateKind, text: updateKind } : null,
    },
  ];

  // System destinations. Settings is signed-in only (matches where the gear
  // used to live); Debug
  // is dev-only (import.meta.env.DEV is false in packaged builds).
  const systemItems = [
    ...(session ? [{ to: '/settings', label: 'Settings', icon: GearIcon, end: true }] : []),
    ...(session ? [{ to: '/design', label: 'Design system', icon: SwatchIcon, end: true }] : []),
    ...(import.meta.env.DEV ? [{ to: '/debug', label: 'Debug', icon: BugIcon, end: true }] : []),
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

  // THE CHAT DROPDOWN — Research's chats (lib/researchChats, per user; the
  // store is lib/advisorChats' factory) as tabs, the Legislation
  // dropdown's twin to the letter: pinned first, the blank "New chat" not
  // listed (the entry's row opens it), drag to reorder, × to close, the row
  // click opening a new chat while on the page. One hook, one renderer
  // (useChatFold / renderChatEntry).
  useEffect(() => { bindResearch(session?.user?.id || '_anonymous', selectedProjectId); }, [session?.user?.id, selectedProjectId]);
  const researchFold = useChatFold(researchStore, { openKey: RESEARCH_OPEN_KEY, setEvent: 'docvex:research-list-set', listedEvent: 'docvex:research-listed', flag: '__docvexResearchListed' });

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
  const renderNavItem = ({ to, label, icon, end, badge, pill, dot, onClick, onWarm, activeOn, fold }) => (
    fold === 'research' ? renderResearchEntry({ to, label, icon, end, badge, pill, dot, onClick, onWarm, activeOn })
        : renderNavItemRow({ to, label, icon, end, badge, pill, dot, onClick, onWarm, activeOn }, null)
  );
  function renderNavItemRow({ to, label, icon, end, badge, pill, dot, onClick, onWarm, activeOn, notActive }, chev) {
    const name = typeof label === 'string' ? label : '';
    return (
    <TabMenuPill key={to} hover={name} onOpen={() => navigate(to)} popRoute={to} popTitle={name}>
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      // `onWarm` fires on hover / keyboard focus so a route can start loading
      // its chunk and its data before the click lands. Pointer-enter rather
      // than mouse-over so it fires once per entry, not per child element.
      onPointerEnter={onWarm}
      onFocus={onWarm}
      // `activeOn`: other routes this entry stands for (an entry with tabs of
      // its own, each on a route of its own).
      // `notActive`: the selection is one of the entry's own rows (a
      // Legislation tab), not the entry.
      className={({ isActive }) => `nav-item${(isActive || activeOn?.includes(pathname)) && !notActive ? ' active' : ''}`}
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
      {chev}
    </NavLink>
    </TabMenuPill>
    );
  }


  // A chat entry (the Advisor, Research) — renderLegalEntry's twin, over the
  // chats of `f` (useChatFold). `busy`: a turn is running on that page.
  const renderChatEntry = (item, f, { busy = false, focusEvent, listName }) => {
    const { store, chats, listed, groups, count, open, toggle, drag, setDrag, listRef, dropAt, drop } = f;
    const chev = count ? (
      <Tooltip content={open ? 'Hide the open chats' : `Show the open chats (${count})`}>
        <span
          className={`nav-fold-chev${open ? ' is-open' : ''}`}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-label={open ? 'Hide open chats' : 'Show open chats'}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); } }}
        >
          {FoldChevron}
        </span>
      </Tooltip>
    ) : null;
    const shown = open && count > 0;
    const selected = pathname === item.to;
    // ON THE PAGE, the row opens a NEW CHAT (the blank one if there is one);
    // from elsewhere it goes to the page and opens the list.
    const onRowClick = (e) => {
      item.onClick?.(e);
      if (selected) {
        e.preventDefault();
        store.openNew();
        requestAnimationFrame(() => window.dispatchEvent(new Event(focusEvent)));
        return;
      }
      if (count && !open) toggle();
    };
    const openChat = (id) => {
      store.select(id);
      if (pathname !== item.to) navigate(item.to);
    };
    const tabOnShow = selected && listed.some((t) => t.id === chats.active);
    return (
      <div key={item.to} className={`nav-fold${shown ? ' is-cat' : ''}`}>
        {renderNavItemRow({ ...item, onClick: onRowClick, notActive: tabOnShow }, chev)}
        {count > 0 && (
          <div className={`nav-cat-fold${shown ? ' is-open' : ''}`} inert={!shown} aria-hidden={!shown}>
          <div className="nav-cat-fold-inner">
          <div
            ref={listRef}
            className={`sidebar-cat-items nav-cat-list${drag ? ' is-dragging' : ''}${drag?.over === 'end' ? ' is-drop-end' : ''}`}
            role="group"
            aria-label={listName}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const over = dropAt(e.clientY);
              if (over !== drag.over) setDrag((d) => (d ? { ...d, over } : d));
            }}
            onDrop={(e) => { if (!drag) return; e.preventDefault(); drop(dropAt(e.clientY)); }}
          >
            {groups.map((g) => (
              <React.Fragment key={g.key}>
                <div className="sidebar-cat-label nav-cat-div"><span className="sidebar-cat-text">{g.label}</span></div>
                {g.tabs.map((t) => {
                  const tBusy = typeof busy === 'function' ? busy(t.id) : (busy && chats.active === t.id && pathname === item.to);
                  const m = store.meta(t, { busy: tBusy });
                  const active = selected && chats.active === t.id;
                  return (
                    <div
                      key={t.id}
                      data-tab-id={t.id}
                      className={`doc-tab-row nav-sub-row nav-cat-row${drag?.id === t.id ? ' is-dragged' : ''}${drag?.over === t.id && drag.id !== t.id ? ' is-drop' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        try { e.dataTransfer.setData('text/plain', t.id); } catch { /* some hosts refuse */ }
                        setDrag({ id: t.id, over: null });
                      }}
                      onDragEnd={() => setDrag(null)}
                    >
                      <TabMenuPill
                        hover={m.direct ? legalTabPill({ ...m, kind: m.ownKind }, null) : chatTabPill(t, m, store.label)}
                        onOpen={() => openChat(t.id)}
                        popRoute={item.to}
                        popTitle={m.title}
                      >
                        <button
                          type="button"
                          className={`nav-item nav-cat-item${active ? ' active' : ''}`}
                          onClick={() => openChat(t.id)}
                        >
                          <span className="label nav-sub-text">
                            <span className="nav-sub-kind">{tBusy ? <span className="nav-dot is-spin nav-cat-spin" aria-label="Working" /> : null}<FadeText className="nav-cat-kindtext">
                              {/* A DIRECT SEARCH reads as a Legislation tab (its platform's
                                  address in its colour · the item's kind); an AI
                                  conversation in the ACCENT (lib/researchChats describe). */}
                              {m.direct
                                ? <><span className="nav-cat-site" style={{ '--tone': m.tone }}>{m.siteName}</span>{m.ownKind ? ` · ${m.ownKind}` : ''}</>
                                : <><span className="nav-cat-site" style={{ '--tone': t.unreadAt ? 'var(--success)' : 'var(--accent)' }}>{store.label}</span>{m.kind.slice(store.label.length)}</>}
                            </FadeText></span>
                            <FadeText className="nav-sub-title">{m.title}</FadeText>
                          </span>
                        </button>
                      </TabMenuPill>
                      {!t.pinned ? (
                        <button type="button" className="doc-tab-close" onClick={() => store.close(t.id)} aria-label={`Close ${m.title}`}>
                          {CloseGlyph}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
          </div>
          </div>
        )}
      </div>
    );
  };
  const renderResearchEntry = (item) => renderChatEntry(item, researchFold, { busy: (id) => researchThreadBusy(researchRun, id), focusEvent: 'docvex:research-focus', listName: "Research's chats" });

  // Cursor-following spotlight: write the pointer position (sidebar-relative,
  // layout px) and moves the rail's light layers (`.sidebar-glow` / `.sidebar-shine`) so the glow
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
  // (the `.sidebar-glow` / `.sidebar-shine` dots, moved by transform) CHASES the cursor target a
  // fraction of the remaining distance each frame so it trails the pointer with
  // a soft delay (matching the app-wide CursorSpotlight feel), instead of
  // snapping. The per-button highlight below stays immediate so hovered items
  // light up instantly. The loop self-parks once settled and restarts on move.
  const navRef = useRef(null);
  const glowDotRef = useRef(null);
  const shineDotRef = useRef(null);
  const SPOT_EASE = 0.28; // per-60fps-frame ease — higher = snappier follow
  const SPOT_SETTLE = 0.5; // px — snap-and-stop threshold
  const FRAME_60 = 1000 / 60; // reference frame duration the ease is tuned for
  // The glow's state: where it is (x, y), where it's heading (tx, ty).
  const spotRef = useRef({ x: 0, y: 0, tx: 0, ty: 0, started: false, lastTs: null, easing: false, inside: false });

  // ALL OF IT runs on the SHARED pointer (lib/pointer) — the app's one mouse
  // listener — once a frame: the READ pass measures the rail, the hovered
  // item, an open dropdown and the selected tab; the WRITE pass sets the
  // per-item lights and moves the glow. No listener, rAF loop or rect read of
  // the sidebar's own any more, and nothing here ever reads after a write.
  useEffect(() => subscribePointer({
    read: (p) => {
      const nav = navRef.current;
      if (!nav || !p.moved) return null;
      const inside = !!p.target && nav.contains(p.target);
      if (!inside || !perfAllows('spotlight')) return { inside };
      const item = p.target.closest('.nav-item, .sidebar-account-main');
      // An entry whose list is open wears its row's hover over the whole of it
      // (`.nav-fold.is-open`), so it takes the coords too, relative to itself.
      const fold = p.target.closest('.nav-fold.is-open');
      // The SELECTED tab also reacts to the spotlight even when the cursor is over
      // a different row: project the cursor onto the active item's box so its
      // gradient brightens toward the pointer.
      const activeItem = nav.querySelector('.nav-item.active');
      return {
        inside,
        r: nav.getBoundingClientRect(),
        item, ir: item ? item.getBoundingClientRect() : null,
        fold, fr: fold ? fold.getBoundingClientRect() : null,
        activeItem, ar: activeItem ? activeItem.getBoundingClientRect() : null,
      };
    },
    write: (p, got) => {
      const s = spotRef.current;
      if (got && !got.inside && s.inside) {
        // Left the rail: clear the hovered item's light. NOTE: intentionally
        // DON'T reset the selected tab's spotlight — snapping its gradient back
        // to centre on leave reads as the tab styling "changing" as the cursor
        // exits. Re-arm the snap so the next entry doesn't trail in from where
        // it parked.
        clearItemSpot(lastItemRef.current);
        lastItemRef.current = null;
        s.started = false;
        s.inside = false;
      } else if (got && got.inside && got.r) {
        s.inside = true;
        s.tx = toLayoutPx(p.x - got.r.left);
        s.ty = toLayoutPx(p.y - got.r.top);
        // First move after (re)entering the rail: snap the glow to the cursor so
        // it doesn't slide in from a stale position, then ease from there.
        if (!s.started) { s.x = s.tx; s.y = s.ty; s.started = true; }
        s.easing = true;
        // The nav button under the cursor gets its OWN (button-relative) coords,
        // immediate (no easing) so the hovered item reads as responsive; the
        // one it left is cleared (its fill recentres at the 50% default).
        const { item, ir, fold, fr, activeItem, ar } = got;
        if (item !== lastItemRef.current) {
          clearItemSpot(lastItemRef.current);
          lastItemRef.current = item;
        }
        if (item) {
          item.style.setProperty('--item-spot-x', `${toLayoutPx(p.x - ir.left)}px`);
          item.style.setProperty('--item-spot-y', `${toLayoutPx(p.y - ir.top)}px`);
        }
        if (fold) {
          fold.style.setProperty('--item-spot-x', `${toLayoutPx(p.x - fr.left)}px`);
          fold.style.setProperty('--item-spot-y', `${toLayoutPx(p.y - fr.top)}px`);
        }
        // After the hovered-item block (which may have just cleared these if the
        // active item was the one we moved off), so this re-sets them.
        if (activeItem) {
          activeItem.style.setProperty('--item-spot-x', `${toLayoutPx(p.x - ar.left)}px`);
          activeItem.style.setProperty('--item-spot-y', `${toLayoutPx(p.y - ar.top)}px`);
        }
      }
      if (!s.easing) return false;
      // FPS-independent easing: the per-frame ease as an exponential decay over
      // elapsed time, so the glow trails the cursor at the same rate at 60Hz or
      // 144Hz; dt is clamped so a long stall doesn't snap-teleport.
      const dt = s.lastTs == null ? FRAME_60 : Math.min(p.ts - s.lastTs, 100);
      s.lastTs = p.ts;
      const factor = 1 - Math.pow(1 - SPOT_EASE, dt / FRAME_60);
      const dx = s.tx - s.x;
      const dy = s.ty - s.y;
      if (Math.abs(dx) < SPOT_SETTLE && Math.abs(dy) < SPOT_SETTLE) { s.x = s.tx; s.y = s.ty; }
      else { s.x += dx * factor; s.y += dy * factor; }
      // Move the two pre-drawn light layers (Sidebar.css .sidebar-glow /
      // .sidebar-shine): a composited transform, no repaint and no restyle.
      // Each dot is 528px with the light at its centre, so its corner goes to
      // pointer − 264px. `left/top` leave their centred default on the first move.
      const t3d = `translate3d(${s.x - 264}px, ${s.y - 264}px, 0)`;
      for (const dot of [glowDotRef.current, shineDotRef.current]) {
        if (!dot) continue;
        if (!dot.dataset.moved) { dot.style.left = '0'; dot.style.top = '0'; dot.dataset.moved = '1'; }
        dot.style.transform = t3d;
      }
      if (s.x === s.tx && s.y === s.ty) { s.easing = false; s.lastTs = null; return false; }
      return true; // still travelling: another frame
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  return (
    <>
    <nav
      className={`sidebar${collapsed ? ' is-collapsed' : ''}`}
      ref={navRef}
      // Off-window on the Hub (slid out via the .app-shell.on-hub margin
      // transition) — inert so the hidden rail can't take keyboard focus.
      inert={offstage || undefined}
    >
      {/* The cursor light (see Sidebar.css .sidebar-glow / .sidebar-shine). */}
      <span className="sidebar-glow" aria-hidden="true"><span className="sidebar-glow-dot" ref={glowDotRef} /></span>
      <span className="sidebar-shine" aria-hidden="true"><span className="sidebar-shine-dot" ref={shineDotRef} /></span>
      <ul className="sidebar-nav">
        {/* ── DocVex — the user's own feeds (formerly "Personal"). ── */}
        <li className="sidebar-cat">
          <span className="sidebar-cat-label">
            <span className="sidebar-cat-text">DocVex</span>
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
            {!selectedProjectId && renderNavItem(RESEARCH_ITEM)}
            {personalItems.map(renderNavItem)}
          </div>
        </li>

        {/* ── The selected project's surfaces (only when one is picked),
            headed by the project's own name; replaces the old in-content
            navigation rail. ── */}
        {projectItems.length > 0 && (
          <li className="sidebar-cat">
            <span className="sidebar-cat-label"><span className="sidebar-cat-text">{selectedProject?.name || 'Project'}</span></span>
            <div className="sidebar-cat-items">
              {projectItems.map(renderNavItem)}
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
          <SidebarAccount
            session={session}
            selectedProjectId={selectedProjectId}
            onSettings={() => navigate('/account')}
            onLogout={doSignOut}
            loggingOut={signingOut}
          />
        ) : (
          <NavLink to="/auth" className="nav-item signin-btn">
            <span className="icon">{SignInIcon}</span>
            <span className="label">Sign in</span>
          </NavLink>
        )}
      </div>

    </nav>
    </>
  );
}

// Memoised: the shell re-renders on things that are none of the rail's business
// (a resize drag starting or ending, the end of the collapse ride, an entrance
// fade clearing) and each used to re-render this whole list with it. Everything
// the rail shows comes from its own hooks (route, auth, notifications…), which
// still re-render it; the shell hands it stable props (AppShell).
// A CHAT DROPDOWN's state (the Advisor's, Research's): the store's chats as
// tabs grouped Pinned / Open, whether the dropdown is open (per device), the
// drag-to-reorder with its FLIP glide, and the handshake with the page's own
// rail — the page asks for the list (`setEvent`) and hears back whether the
// sidebar is listing it (`listedEvent` + `window[flag]`).
function useChatFold(store, { openKey, setEvent, listedEvent, flag }) {
  const chats = useSyncExternalStore(store.subscribe, store.getState);
  const listed = chats.threads.filter((t) => !isBlankChat(t));
  const pinned = listed.filter((t) => t.pinned);
  const rest = listed.filter((t) => !t.pinned);
  const groups = [
    { key: 'pinned', label: 'Pinned', tabs: pinned },
    { key: 'open', label: pinned.length ? 'Open' : 'Open chats', tabs: rest },
  ].filter((g) => g.tabs.length);
  const count = listed.length;
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(openKey) !== '0'; } catch { return true; }
  });
  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try { localStorage.setItem(openKey, next ? '1' : '0'); } catch { /* ignore */ } // secure-store-ok: a fold's open state (openKey is a UI key)
      return next;
    });
  };
  const [drag, setDrag] = useState(null);
  const listRef = useRef(null);
  const dropAt = (y) => {
    const rows = listRef.current ? [...listRef.current.querySelectorAll('.nav-cat-row[data-tab-id]')] : [];
    for (const r of rows) { const b = r.getBoundingClientRect(); if (y < b.top + b.height / 2) return r.dataset.tabId; }
    return 'end';
  };
  const flipFrom = useRef(null);
  const drop = (over) => {
    const d = drag;
    setDrag(null);
    if (!d || !over || over === d.id) return;
    const rows = listRef.current ? [...listRef.current.querySelectorAll('.nav-cat-row[data-tab-id]')] : [];
    const from = new Map(rows.map((r) => [r.dataset.tabId, r.getBoundingClientRect().top]));
    const ids = rows.map((r) => r.dataset.tabId);
    if (over !== 'end' && ids[ids.indexOf(d.id) + 1] === over) return;
    if (over === 'end' && ids[ids.length - 1] === d.id) return;
    flipFrom.current = from;
    store.move(d.id, over === 'end' ? null : over);
  };
  const order = chats.threads.map((t) => t.id).join('|');
  useLayoutEffect(() => {
    const from = flipFrom.current;
    flipFrom.current = null;
    const list = listRef.current;
    if (!from || !list) return;
    if (document.documentElement.dataset.reduceMotion === 'true') return;
    const rows = [...list.querySelectorAll('.nav-cat-row[data-tab-id]')];
    const moved = [];
    for (const r of rows) {
      const was = from.get(r.dataset.tabId);
      if (was == null) continue;
      const dy = toLayoutPx(was - r.getBoundingClientRect().top);
      if (Math.abs(dy) < 0.5) continue;
      r.style.transition = 'none';
      r.style.transform = `translateY(${dy}px)`;
      moved.push(r);
    }
    if (!moved.length) return;
    void list.offsetHeight;
    for (const r of moved) {
      r.style.transition = 'transform 260ms cubic-bezier(0.16, 1, 0.3, 1)';
      r.style.transform = '';
      const done = () => { r.style.transition = ''; r.removeEventListener('transitionend', done); };
      r.addEventListener('transitionend', done);
    }
  }, [order]);
  useEffect(() => {
    const onSet = (e) => {
      const next = !!e.detail?.open;
      setOpen(next);
      try { localStorage.setItem(openKey, next ? '1' : '0'); } catch { /* ignore */ } // secure-store-ok: a fold's open state (openKey is a UI key)
    };
    window.addEventListener(setEvent, onSet);
    return () => window.removeEventListener(setEvent, onSet);
  }, [openKey, setEvent]);
  const isListed = open && count > 0;
  useEffect(() => {
    window[flag] = isListed;
    window.dispatchEvent(new CustomEvent(listedEvent, { detail: { listed: isListed } }));
  }, [isListed, flag, listedEvent]);
  return { store, chats, listed, groups, count, open, toggle, drag, setDrag, listRef, dropAt, drop };
}

export default React.memo(Sidebar);
