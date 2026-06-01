import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useUpdates, versionTagFor } from '../context/UpdatesContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useNotifications } from '../context/NotificationsContext';
import {
  listMyProjects, createProject, sendInvite, updateProject, deleteProject,
  listMembers, listInvitations, updateMemberRole, removeMember, revokeInvite,
} from '../lib/projects';
import { sortProjectsByRecent, getMostRecentProjectId, getRecentMap } from '../lib/recentProjects';
import { markLaunchConsumed } from '../lib/launchGate';
import { openExternal, openProjectWindow } from '../lib/platform';
import { localFolderApi } from '../lib/localFolder';
import { markProjectAccessed } from '../lib/recentProjects';
import useCursorSpotlight from '../hooks/useCursorSpotlight';
import DeleteProjectModal from '../components/DeleteProjectModal';
import Account from './Account';
import StatusPicker from '../components/StatusPicker';
import Tooltip from '../components/Tooltip';
import { PLAN } from '../lib/plan';
import { getStatusOption, updateStatus, DEFAULT_STATUS_KEY } from '../lib/userStatus';
import './Launch.css';
// Reuse the main app's Updates styling (banner + release cards) so the hub's
// Updates view matches it. We render the cards WITHOUT the patch-notes body.
import './Updates.css';

// Per-user store for the chosen projects directory. There's no backend for
// this preference, so it lives in localStorage like the other docvex.* keys.
const projectsDirKey = (uid) => `docvex.projectsDir.${uid || '_anonymous'}`;
function readProjectsDir(uid) {
  try { return localStorage.getItem(projectsDirKey(uid)) || ''; } catch { return ''; }
}
function writeProjectsDir(uid, val) {
  try {
    if (val) localStorage.setItem(projectsDirKey(uid), val);
    else localStorage.removeItem(projectsDirKey(uid));
  } catch { /* private mode / quota — non-fatal */ }
}

// ── Launch hub ───────────────────────────────────────────────────────────
// Unity-Hub-style launcher: the first full-screen surface an authenticated
// user sees on a cold app start (the redirect lives in App.jsx, gated on the
// launchGate flag). A left sidebar navigates between Projects (the list) and
// Learn, plus links out to Updates (the in-app page) and Documentation (the
// website). Opening a project drops the user into its Dashboard. The global
// frameless TitleBar (Theme + Account + window controls) sits above this page.

const DOCS_URL = 'https://docvex.ro/';

const PlusIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const SearchIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
const CaretIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 6 15 12 9 18" />
  </svg>
);
const UsersIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

// ── Sidebar nav icons ──
const ProjectsNavIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
  </svg>
);
const UpdatesNavIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" />
  </svg>
);
const LearnNavIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 10 12 5 2 10l10 5 10-5z" /><path d="M6 12v5c0 1 2.5 2.5 6 2.5s6-1.5 6-2.5v-5" />
  </svg>
);
const DocsNavIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);
const SignOutIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);
const ChevronUpIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="18 15 12 9 6 15" />
  </svg>
);
// Down-into-tray arrow — "an update is ready to install".
const DownloadIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);
const CheckCircleIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);
const RefreshIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);
const ExternalLinkIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);
const PlayIcon = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
);
const YoutubeIcon = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M23 12s0-3.79-.49-5.6a2.92 2.92 0 0 0-2.05-2.06C18.65 3.85 12 3.85 12 3.85s-6.65 0-8.46.49A2.92 2.92 0 0 0 1.49 6.4 30.6 30.6 0 0 0 1 12a30.6 30.6 0 0 0 .49 5.6 2.92 2.92 0 0 0 2.05 2.06c1.81.49 8.46.49 8.46.49s6.65 0 8.46-.49a2.92 2.92 0 0 0 2.05-2.06A30.6 30.6 0 0 0 23 12zM9.75 15.5v-7l6 3.5z" />
  </svg>
);

// Simulated YouTube tutorial library for the Learn view, grouped by the app's
// feature areas. Placeholder items — the URLs are stand-ins until real videos
// are published. `cat` maps to a --cat-* token for the thumbnail tint.
const LEARN_CATEGORIES = [
  { id: 'getting-started', label: 'Getting started', cat: 'system', videos: [
    { id: 'gs1', title: 'Welcome to Docvex — a 3-minute tour', duration: '3:12', url: 'https://www.youtube.com/watch?v=docvex-start-01' },
    { id: 'gs2', title: 'Install the desktop app & sign in', duration: '4:48', url: 'https://www.youtube.com/watch?v=docvex-start-02' },
    { id: 'gs3', title: 'Set up your workspace and theme', duration: '5:30', url: 'https://www.youtube.com/watch?v=docvex-start-03' },
  ] },
  { id: 'projects', label: 'Projects', cat: 'project', videos: [
    { id: 'pr1', title: 'Create your first project', duration: '2:40', url: 'https://www.youtube.com/watch?v=docvex-proj-01' },
    { id: 'pr2', title: 'Invite teammates and assign roles', duration: '6:05', url: 'https://www.youtube.com/watch?v=docvex-proj-02' },
    { id: 'pr3', title: 'Tour the project dossier', duration: '4:18', url: 'https://www.youtube.com/watch?v=docvex-proj-03' },
  ] },
  { id: 'files', label: 'Files & branching', cat: 'file', videos: [
    { id: 'fi1', title: 'Upload, preview and organise files', duration: '3:55', url: 'https://www.youtube.com/watch?v=docvex-file-01' },
    { id: 'fi2', title: 'Work in your branch — My drafts', duration: '7:20', url: 'https://www.youtube.com/watch?v=docvex-file-02' },
    { id: 'fi3', title: 'Link a local folder & the sidecar', duration: '5:02', url: 'https://www.youtube.com/watch?v=docvex-file-03' },
  ] },
  { id: 'change-requests', label: 'Change requests', cat: 'update', videos: [
    { id: 'cr1', title: 'Publish changes for review', duration: '4:33', url: 'https://www.youtube.com/watch?v=docvex-cr-01' },
    { id: 'cr2', title: 'Compose and approve a release', duration: '8:10', url: 'https://www.youtube.com/watch?v=docvex-cr-02' },
    { id: 'cr3', title: 'Resolve conflicts on the desk', duration: '6:44', url: 'https://www.youtube.com/watch?v=docvex-cr-03' },
  ] },
  { id: 'team-roles', label: 'Team & roles', cat: 'role', videos: [
    { id: 'tr1', title: 'Custom roles & capabilities', duration: '5:51', url: 'https://www.youtube.com/watch?v=docvex-role-01' },
    { id: 'tr2', title: 'Manage members and invitations', duration: '3:27', url: 'https://www.youtube.com/watch?v=docvex-role-02' },
  ] },
  { id: 'chat', label: 'Team chat', cat: 'member', videos: [
    { id: 'ct1', title: 'Team and private messaging', duration: '4:09', url: 'https://www.youtube.com/watch?v=docvex-chat-01' },
    { id: 'ct2', title: 'Threads, mentions & reactions', duration: '5:16', url: 'https://www.youtube.com/watch?v=docvex-chat-02' },
  ] },
  { id: 'newsletter', label: 'Legal newsfeed', cat: 'support', videos: [
    { id: 'nl1', title: 'Read the legal newsfeed', duration: '3:48', url: 'https://www.youtube.com/watch?v=docvex-news-01' },
    { id: 'nl2', title: 'The AI weekly digest, explained', duration: '6:22', url: 'https://www.youtube.com/watch?v=docvex-news-02' },
  ] },
];

// Parse a GitHub tag into {major, minor, patch}; null for non-semver tags.
function parseVersion(tag) {
  if (!tag) return null;
  const m = tag.replace(/^v/, '').split('-')[0].match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}
// Classify a release vs its predecessor (the next older tag) as major/minor/patch.
function releaseKind(currentTag, previousTag) {
  const c = parseVersion(currentTag);
  if (!c) return null;
  if (!previousTag) return 'major';
  const p = parseVersion(previousTag);
  if (!p) return null;
  if (c.major !== p.major) return 'major';
  if (c.minor !== p.minor) return 'minor';
  if (c.patch !== p.patch) return 'patch';
  return null;
}
function formatReleaseDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const BugNavIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="8" y="6" width="8" height="14" rx="4" />
    <path d="M12 2v4M9 4l1.5 2M15 4l-1.5 2M3 9h3M18 9h3M2 14h4M18 14h4M4 19l3-2M20 19l-3-2" />
  </svg>
);
const SettingsNavIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const FolderIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);
const CloseIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const ArrowLeftIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
  </svg>
);
const MailIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" />
  </svg>
);
const AlertIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12.5" /><circle cx="12" cy="16.2" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

// Same 12-colour djb2 avatar scheme used across the app.
const AVATAR_PALETTE = ['#0891B2', '#BE185D', '#4F46E5', '#047857', '#B45309', '#6D28D9', '#DC2626', '#0369A1', '#DB2777', '#059669', '#7C3AED', '#EA580C'];
function avatarColor(seed) {
  let h = 0;
  for (let i = 0; i < (seed || '').length; i++) { h = ((h << 5) - h) + seed.charCodeAt(i); h |= 0; }
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

function timeAgo(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function getDisplayName(user) {
  const meta = user?.user_metadata;
  if (meta?.full_name) return meta.full_name;
  if (meta?.name) return meta.name;
  if (user?.email) {
    const at = user.email.indexOf('@');
    return at > 0 ? user.email.slice(0, at) : user.email;
  }
  return 'there';
}

function AvatarStack({ members = [], max = 4 }) {
  const shown = members.slice(0, max);
  if (shown.length === 0) return null;
  return (
    <div className="lh-avatars">
      {shown.map((m) => (
        <Tooltip key={m.userId} content={m.name}>
          <span
            className="lh-avatar"
            style={m.avatarUrl ? undefined : { background: avatarColor(m.userId) }}
          >
            {m.avatarUrl
              ? <img src={m.avatarUrl} alt="" referrerPolicy="no-referrer" draggable={false} />
              : m.initials}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

// Display path for a project: the projects directory (Settings) joined with
// the project name, when a directory is set. The hub has no per-project path,
// so this is a derived display.
function projectPathFor(projectsDir, project) {
  if (!projectsDir) return 'No local folder set';
  const sep = projectsDir.includes('\\') ? '\\' : '/';
  return `${projectsDir.replace(/[\\/]+$/, '')}${sep}${project.name}`;
}

const PencilIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);
const TrashIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

function ProjectRow({ project, lastOpened, mostRecent, projectsDir, onOpen, onRename, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const [savingName, setSavingName] = useState(false);
  const menuRef = useRef(null);
  const inputRef = useRef(null);
  const cancelRef = useRef(false);
  const n = project.member_count;
  const lastAccessed = lastOpened ? timeAgo(lastOpened) : (timeAgo(project.updated_at) || '—');
  const pathLine = projectPathFor(projectsDir, project);

  // Close the cog menu on outside-click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  // Focus + select the inline rename input when entering edit mode.
  useEffect(() => {
    if (editing) requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
  }, [editing]);

  const startRename = () => { setDraftName(project.name); setMenuOpen(false); setEditing(true); };

  // Single commit path (Enter / Escape both blur; onBlur decides save vs cancel).
  const onRenameKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); inputRef.current?.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRef.current = true; inputRef.current?.blur(); }
  };
  const onRenameBlur = async () => {
    if (cancelRef.current) { cancelRef.current = false; setEditing(false); setDraftName(project.name); return; }
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === project.name) { setEditing(false); setDraftName(project.name); return; }
    setSavingName(true);
    const ok = await onRename(project, trimmed);
    setSavingName(false);
    setEditing(false);
    if (!ok) setDraftName(project.name);
  };

  return (
    <div className={`lh-row${expanded ? ' is-expanded' : ''}`}>
      <div className="lh-row-top">
        {/* Dropdown — toggles the project-data panel below. */}
        <button
          type="button"
          className="lh-row-expand"
          onClick={() => setExpanded((v) => !v)}
          aria-label="View project data"
          aria-expanded={expanded}
        >
          <span className="lh-row-expand-caret">{CaretIcon}</span>
        </button>

        {/* Name + path. Clicking opens the project; in rename mode the name
            becomes an inline input. */}
        {editing ? (
          <div className="lh-row-main lh-row-main-edit">
            <input
              ref={inputRef}
              type="text"
              className="lh-row-name-input"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={onRenameKey}
              onBlur={onRenameBlur}
              maxLength={60}
              disabled={savingName}
              aria-label="Rename project"
            />
            <span className="lh-row-path">{pathLine}</span>
          </div>
        ) : (
          <button type="button" className="lh-row-main" onClick={() => onOpen(project)}>
            <span className="lh-row-name-main">
              {project.name}
              {mostRecent && <span className="lh-recent-tag">most recent</span>}
            </span>
            <span className="lh-row-path">{pathLine}</span>
          </button>
        )}

        {/* Last accessed. */}
        <div className="lh-row-accessed">
          <span className="lh-row-accessed-label">last accessed</span>
          <span className="lh-row-accessed-val">{lastAccessed}</span>
        </div>

        {/* Cog — opens a Rename / Delete menu. */}
        <div className="lh-row-config-wrap" ref={menuRef}>
          <Tooltip content={menuOpen ? undefined : 'Project options'}>
            <button
              type="button"
              className={`lh-row-config${menuOpen ? ' is-open' : ''}`}
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Project options"
            >
              {SettingsNavIcon}
            </button>
          </Tooltip>
          {menuOpen && (
            <div className="lh-row-menu" role="menu">
              <button type="button" role="menuitem" className="lh-row-menu-item" onClick={startRename}>
                <span className="lh-row-menu-icon">{PencilIcon}</span> Rename
              </button>
              <button
                type="button"
                role="menuitem"
                className="lh-row-menu-item is-danger"
                onClick={() => { setMenuOpen(false); onDelete(project); }}
              >
                <span className="lh-row-menu-icon">{TrashIcon}</span> Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Always rendered (not conditional) so the panel can animate open AND
          closed; the `.lh-row.is-expanded` class drives the grid-rows reveal.
          The inner clip layer carries no padding/border so it collapses fully
          to 0 when minimized (the padded panel is clipped inside it). */}
      <div className="lh-row-data-anim">
        <div className="lh-row-data-clip">
        <div className="lh-row-data">
          <div className="lh-row-data-item">
            <span className="lh-row-data-key">Role</span>
            <span className={`lh-pill is-${project.role}`}>{project.role}</span>
          </div>
          <div className="lh-row-data-item">
            <span className="lh-row-data-key">Members</span>
            <span className="lh-row-data-members">
              <AvatarStack members={project.members} max={4} />
              <span className="lh-row-member-count">
                <span className="lh-users-icon">{UsersIcon}</span>
                {typeof n === 'number' ? n : '—'}
              </span>
            </span>
          </div>
          <div className="lh-row-data-item">
            <span className="lh-row-data-key">Last updated</span>
            <span className="lh-row-data-val">{timeAgo(project.updated_at) || '—'}</span>
          </div>
          <div className="lh-row-data-item lh-row-data-desc">
            <span className="lh-row-data-key">Description</span>
            <span className="lh-row-data-val">{project.description || 'No description.'}</span>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Slide-in panel to create a project: name + description + invite emails.
// Always mounted (for the slide animation); `open` drives the transform.
function CreateProjectPanel({ open, onClose, onCreated }) {
  const { notify } = useNotifications();
  const [name, setName] = useState('New project');
  // Confirmed email chips + the in-progress draft the user is still typing.
  const [emails, setEmails] = useState([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const nameRef = useRef(null);
  const emailInputRef = useRef(null);

  // Reset the form each time the panel opens, focus + select the name (so the
  // default "New project" can be typed over), and wire Esc-to-close.
  useEffect(() => {
    if (!open) return;
    setName('New project');
    setEmails([]);
    setEmailDraft('');
    setError(null);
    setSubmitting(false);
    // preventScroll: focusing inside the overflow:hidden pan viewport would
    // otherwise scroll the track to its end position, cutting the open pan
    // short so it looks faster than the (uninterrupted) close pan.
    const t = setTimeout(() => {
      nameRef.current?.focus({ preventScroll: true });
      nameRef.current?.select();
    }, 60);
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [open, onClose]);

  // Split a raw string on commas / spaces / semicolons, push every valid email
  // as a chip (de-duped), and return whatever's left over (an incomplete token
  // the user is still typing, or the last invalid one) to keep in the input.
  const addEmails = (raw) => {
    const parts = String(raw).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    const valid = [];
    let remainder = '';
    parts.forEach((p) => { if (EMAIL_RE.test(p)) valid.push(p); else remainder = p; });
    if (valid.length) {
      setEmails((prev) => {
        const seen = new Set(prev);
        const next = [...prev];
        valid.forEach((v) => { if (!seen.has(v)) { seen.add(v); next.push(v); } });
        return next;
      });
    }
    return remainder;
  };

  const onEmailChange = (e) => {
    const val = e.target.value;
    // A separator (typed or pasted) commits everything before it into chips.
    if (/[\s,;]/.test(val)) setEmailDraft(addEmails(val));
    else setEmailDraft(val);
  };
  const onEmailKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (emailDraft.trim()) setEmailDraft(addEmails(emailDraft));
    } else if (e.key === 'Backspace' && !emailDraft && emails.length) {
      setEmails((prev) => prev.slice(0, -1));
    }
  };
  const onEmailBlur = () => { if (emailDraft.trim()) setEmailDraft(addEmails(emailDraft)); };
  const removeEmail = (em) => setEmails((prev) => prev.filter((e) => e !== em));

  // Empty name → red-tint the title input + show the required hint.
  const nameEmpty = !name.trim();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) { setError('Name is required.'); return; }
    if (trimmed.length > 25) { setError('Name is too long (max 25 characters).'); return; }

    // Confirmed chips + a still-unconfirmed draft (commit it if it's valid).
    const recipients = [...emails];
    const draft = emailDraft.trim();
    if (draft) {
      if (!EMAIL_RE.test(draft)) { setError(`"${draft}" doesn't look like a valid email.`); return; }
      if (!recipients.includes(draft)) recipients.push(draft);
    }

    setSubmitting(true);
    const { data, error: createErr } = await createProject({ name: trimmed, description: '' });
    if (createErr || !data) {
      setSubmitting(false);
      setError(createErr?.message || 'Could not create the project. Try again.');
      return;
    }

    // Fire invites (best-effort; failures don't block project creation).
    let sent = 0;
    if (recipients.length) {
      const results = await Promise.allSettled(recipients.map((em) => sendInvite(data.id, em, 'member')));
      sent = results.filter((r) => r.status === 'fulfilled' && !r.value?.error).length;
    }
    setSubmitting(false);

    notify?.({
      category: 'project',
      variant: 'success',
      icon: 'folder-plus',
      title: `Project "${data.name}" created`,
      body: sent > 0 ? `${sent} invite${sent === 1 ? '' : 's'} sent.` : undefined,
      dedupeKey: `project-created-${data.id}`,
    });
    onCreated(data);
  };

  return (
    <div className="lh-create-content" aria-hidden={!open}>
        <button type="button" className="lh-create-back" onClick={onClose} aria-label="Back">
          {ArrowLeftIcon}
        </button>

        <form className="lh-create-form" onSubmit={handleSubmit} noValidate>
          <label className="lh-create-field">
            <input
              ref={nameRef}
              type="text"
              className={`lh-create-name-input${nameEmpty ? ' is-empty' : ''}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New project"
              maxLength={25}
              disabled={submitting}
            />
            {nameEmpty ? (
              <span className="lh-create-required" role="alert">
                <span className="lh-create-required-icon">{AlertIcon}</span>
                A project name is required
              </span>
            ) : (
              <span className={`lh-create-count${name.length >= 25 ? ' is-max' : ''}`}>
                {name.length}/25
              </span>
            )}
          </label>

          <div className="lh-create-field lh-create-field-invite">
            <span className="lh-create-label">Invite team members</span>
            <span className="lh-create-hint">Add emails below — they'll get an invite and join as members. Press Enter after each.</span>
            <div
              className="lh-create-chip-input"
              onClick={() => emailInputRef.current?.focus()}
            >
              {emails.map((em) => (
                <span key={em} className="lh-create-chip">
                  <span className="lh-create-chip-icon">{MailIcon}</span>
                  <span className="lh-create-chip-text">{em}</span>
                  <button
                    type="button"
                    className="lh-create-chip-x"
                    onClick={() => removeEmail(em)}
                    aria-label={`Remove ${em}`}
                    disabled={submitting}
                  >
                    {CloseIcon}
                  </button>
                </span>
              ))}
              <input
                ref={emailInputRef}
                type="text"
                className="lh-create-chip-field"
                value={emailDraft}
                onChange={onEmailChange}
                onKeyDown={onEmailKeyDown}
                onBlur={onEmailBlur}
                placeholder={emails.length ? 'Add another…' : 'teammate@email.com'}
                disabled={submitting}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          {error && <div className="lh-create-error">{error}</div>}

          <div className="lh-create-foot">
            <button type="button" className="lh-setting-btn-ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="lh-new-btn" disabled={submitting || !name.trim()}>
              {submitting ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
    </div>
  );
}

// Role display helpers — mirror the main app's role badge colours/order.
const ROLE_RANK = { owner: 3, admin: 2, member: 1, viewer: 0 };
const ASSIGNABLE_ROLES = ['admin', 'member', 'viewer']; // owner can't be set via this path
function memberName(profile) {
  return profile?.full_name || profile?.name || profile?.email || 'Member';
}

// Project settings — the second pan panel when the user clicks a row's gear.
// Replicates the main app's project settings surface (general info + team +
// invitations + danger zone), loaded directly via the projects lib. The pan
// in/out is the same scroll-to-new-section animation as the create flow.
function ProjectSettingsPanel({ open, project, onClose, onPatched, onDeleted }) {
  const { notify } = useNotifications();
  const userId = project?.__viewerId ?? null;
  const canManage = project?.role === 'owner' || project?.role === 'admin';

  // General
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [metaError, setMetaError] = useState(null);

  // Team + invitations
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loadingTeam, setLoadingTeam] = useState(true);
  const [teamError, setTeamError] = useState(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviting, setInviting] = useState(false);

  const [deleting, setDeleting] = useState(false);

  // (Re)load everything when the panel opens for a project.
  useEffect(() => {
    if (!open || !project) return;
    setName(project.name || '');
    setDesc(project.description || '');
    setMetaError(null);
    setTeamError(null);
    setInviteEmail('');
    setInviteRole('member');
    let alive = true;
    setLoadingTeam(true);
    Promise.all([listMembers(project.id), listInvitations(project.id)]).then(([m, inv]) => {
      if (!alive) return;
      setMembers((m.data || []).slice().sort((a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0)));
      setInvites(inv.data || []);
      setLoadingTeam(false);
    });
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { alive = false; window.removeEventListener('keydown', onKey); };
  }, [open, project, onClose]);

  const nameEmpty = !name.trim();
  const dirtyMeta = name.trim() !== (project?.name || '').trim()
    || (desc.trim() || '') !== ((project?.description || '').trim());

  const saveMeta = async (e) => {
    e.preventDefault();
    setMetaError(null);
    const trimmed = name.trim();
    if (!trimmed) { setMetaError('A project name is required.'); return; }
    setSavingMeta(true);
    const { data, error: err } = await updateProject(project.id, { name: trimmed, description: desc });
    setSavingMeta(false);
    if (err) { setMetaError(err.message || 'Could not save changes.'); return; }
    const patch = { id: project.id, name: data?.name || trimmed, description: data?.description ?? (desc.trim() || null) };
    notify?.({ category: 'project', variant: 'success', icon: 'folder', title: `Saved “${patch.name}”`, dedupeKey: `project-updated-${project.id}` });
    onPatched?.(patch); // keep the panel open; the hub list + panel project update in place
  };

  const changeRole = async (m, role) => {
    if (!canManage || role === m.role) return;
    const prev = m.role;
    setMembers((list) => list.map((x) => (x.user_id === m.user_id ? { ...x, role } : x)));
    const { error: err } = await updateMemberRole(project.id, m.user_id, role);
    if (err) {
      setTeamError(err.message || 'Could not change role.');
      setMembers((list) => list.map((x) => (x.user_id === m.user_id ? { ...x, role: prev } : x)));
    }
  };

  const removeMem = async (m) => {
    if (!canManage) return;
    if (!window.confirm(`Remove ${memberName(m.profile)} from this project?`)) return;
    const { error: err } = await removeMember(project.id, m.user_id);
    if (err) { setTeamError(err.message || 'Could not remove member.'); return; }
    setMembers((list) => list.filter((x) => x.user_id !== m.user_id));
  };

  const doInvite = async (e) => {
    e.preventDefault();
    setTeamError(null);
    const email = inviteEmail.trim();
    if (!EMAIL_RE.test(email)) { setTeamError('Enter a valid email address.'); return; }
    setInviting(true);
    const { error: err } = await sendInvite(project.id, email, inviteRole);
    setInviting(false);
    if (err) { setTeamError(err.message || 'Could not send the invite.'); return; }
    setInviteEmail('');
    const inv = await listInvitations(project.id);
    setInvites(inv.data || []);
    notify?.({ category: 'member', variant: 'success', icon: 'user-plus', title: `Invited ${email}`, dedupeKey: `invite-${project.id}-${email}` });
  };

  const revoke = async (inv) => {
    const { error: err } = await revokeInvite(inv.id);
    if (err) { setTeamError(err.message || 'Could not revoke the invite.'); return; }
    setInvites((list) => list.filter((x) => x.id !== inv.id));
  };

  const handleDelete = async () => {
    if (!project) return;
    if (!window.confirm(`Delete “${project.name}”? This permanently removes the project for everyone.`)) return;
    setDeleting(true);
    const { error: err } = await deleteProject(project.id);
    setDeleting(false);
    if (err) { setTeamError(err.message || 'Could not delete the project.'); return; }
    notify?.({ category: 'project', variant: 'warning', icon: 'trash', title: `Deleted “${project.name}”`, dedupeKey: `project-deleted-${project.id}` });
    onDeleted?.(project.id);
  };

  return (
    <div className="lh-create-content" aria-hidden={!open}>
      <button type="button" className="lh-create-back" onClick={onClose} aria-label="Back">
        {ArrowLeftIcon}
      </button>

      <div className="lh-pset">
        <header className="lh-pset-head">
          <span className="lh-settings-eyebrow">Project settings</span>
          <h1 className="lh-pset-title">{project?.name || 'Project'}</h1>
          {!canManage && <span className="lh-pset-readonly">You have view-only access — ask an admin to make changes.</span>}
        </header>

        {/* ── General ── */}
        <form className="lh-pset-card" onSubmit={saveMeta} noValidate>
          <h2 className="lh-pset-card-title">General</h2>
          <label className="lh-pset-field">
            <span className="lh-pset-label">Name</span>
            <input
              type="text"
              className="lh-pset-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              maxLength={60}
              disabled={!canManage || savingMeta}
            />
          </label>
          {metaError && <div className="lh-create-error">{metaError}</div>}
          {canManage && (
            <div className="lh-pset-card-foot">
              <button type="submit" className="lh-new-btn" disabled={savingMeta || nameEmpty || !dirtyMeta}>
                {savingMeta ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          )}
        </form>

        {/* ── Team ── */}
        <section className="lh-pset-card">
          <h2 className="lh-pset-card-title">
            Team <span className="lh-pset-count">{members.length}</span>
          </h2>

          {loadingTeam ? (
            <div className="lh-pset-muted">Loading members…</div>
          ) : (
            <ul className="lh-pset-members">
              {members.map((m) => {
                const isOwner = m.role === 'owner';
                const self = userId && m.user_id === userId;
                return (
                  <li key={m.user_id} className="lh-pset-member">
                    <span
                      className="lh-pset-avatar"
                      style={m.profile?.avatar_url ? undefined : { background: avatarColor(m.user_id) }}
                    >
                      {m.profile?.avatar_url
                        ? <img src={m.profile.avatar_url} alt="" referrerPolicy="no-referrer" draggable={false} />
                        : memberName(m.profile).charAt(0).toUpperCase()}
                    </span>
                    <span className="lh-pset-member-text">
                      <span className="lh-pset-member-name">
                        {memberName(m.profile)}{self && <span className="lh-pset-you"> (you)</span>}
                      </span>
                      {m.profile?.email && <span className="lh-pset-member-email">{m.profile.email}</span>}
                    </span>
                    {canManage && !isOwner && !self ? (
                      <>
                        <select
                          className="lh-pset-role-select"
                          value={m.role}
                          onChange={(e) => changeRole(m, e.target.value)}
                        >
                          {ASSIGNABLE_ROLES.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                        <Tooltip content="Remove">
                          <button type="button" className="lh-pset-icon-btn" onClick={() => removeMem(m)} aria-label={`Remove ${memberName(m.profile)}`}>
                            {CloseIcon}
                          </button>
                        </Tooltip>
                      </>
                    ) : (
                      <span className={`lh-pset-role lh-pset-role-${m.role}`}>{m.role}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Pending invitations */}
          {invites.length > 0 && (
            <div className="lh-pset-invites">
              <h3 className="lh-pset-subtitle">Pending invitations</h3>
              <ul className="lh-pset-members">
                {invites.map((inv) => (
                  <li key={inv.id} className="lh-pset-member is-pending">
                    <span className="lh-pset-avatar lh-pset-avatar-ghost">{MailIcon}</span>
                    <span className="lh-pset-member-text">
                      <span className="lh-pset-member-name">{inv.email}</span>
                      <span className="lh-pset-member-email">Invited · {inv.role}</span>
                    </span>
                    {canManage && (
                      <Tooltip content="Revoke">
                        <button type="button" className="lh-pset-icon-btn" onClick={() => revoke(inv)} aria-label={`Revoke invite for ${inv.email}`}>
                          {CloseIcon}
                        </button>
                      </Tooltip>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Invite new member */}
          {canManage && (
            <form className="lh-pset-invite-form" onSubmit={doInvite}>
              <div className="lh-pset-invite-row">
                <span className="lh-pset-invite-icon">{MailIcon}</span>
                <input
                  type="text"
                  className="lh-pset-input lh-pset-invite-input"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@email.com"
                  disabled={inviting}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <select className="lh-pset-role-select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} disabled={inviting}>
                {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <button type="submit" className="lh-new-btn" disabled={inviting || !inviteEmail.trim()}>
                {inviting ? 'Sending…' : 'Invite'}
              </button>
            </form>
          )}

          {teamError && <div className="lh-create-error">{teamError}</div>}
        </section>

        {/* ── Danger zone ── */}
        {canManage && (
          <section className="lh-pset-card lh-pset-danger">
            <h2 className="lh-pset-card-title">Danger zone</h2>
            <div className="lh-pset-danger-row">
              <div className="lh-pset-danger-text">
                <strong>Delete this project</strong>
                <span>Permanently removes the project, its files, and all member access.</span>
              </div>
              <button type="button" className="lh-pset-danger-btn" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete project'}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// iOS-style large-title header. The big headline lives INSIDE this view's own
// scroll area so it scrolls away; a compact, blurred header fades + slides in
// once the user scrolls past the title. Hysteresis (activate at 32px, release
// at 8px) keeps it from flickering right at the threshold.
function HubView({ greeting, title, hideHeadline, compactExtra, children }) {
  const [scrolled, setScrolled] = useState(false);
  const onScroll = (e) => {
    const top = e.currentTarget.scrollTop;
    setScrolled((s) => (s ? top > 8 : top > 32));
  };
  return (
    <div className="lh-view">
      <div className={`lh-compact-header${scrolled ? ' is-visible' : ''}`} aria-hidden={!scrolled}>
        <div className="lh-compact-inner">
          <span className="lh-compact-title">{title}</span>
          {compactExtra}
        </div>
      </div>
      <div className="lh-view-scroll" onScroll={onScroll}>
        <div className="lh-view-inner">
          {/* hideHeadline: the view supplies its own header (e.g. the account
              profile block), so we skip the default greeting + big title. */}
          {!hideHeadline && (
            <div className="lh-headline">
              {greeting && <p className="lh-greeting">{greeting}</p>}
              <h1 className="lh-title">{title}</h1>
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

export default function Launch() {
  const { session, loading: authLoading, signOut } = useAuth();
  const {
    currentVersion,
    latestVersion,
    hasUpdate,
    installerState,
    checkNow,
    installUpdate,
    releases,
    loading: updatesLoading,
    downloadUrl,
  } = useUpdates();
  const { selectProject, beginSwitch } = useSelectedProject();
  const { notify } = useNotifications();
  const navigate = useNavigate();
  useCursorSpotlight();

  const userId = session?.user?.id ?? null;

  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  // Which in-hub view the sidebar selects. Updates + Documentation are links
  // (navigate / external), so only Projects + Learn are real views here.
  const [view, setView] = useState('projects');
  // Account popover (footer) open state.
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef(null);
  // Dev-only force-toggle for the update banner (so it can be previewed
  // without a real update). The banner shows on a real update OR when this is
  // on.
  const [debugBanner, setDebugBanner] = useState(false);
  // Chosen projects directory (Settings view). Hydrated from localStorage when
  // the user is known.
  const [projectsDir, setProjectsDir] = useState('');
  useEffect(() => { setProjectsDir(readProjectsDir(userId)); }, [userId]);
  // Inline feedback for "Open project" (open from a folder on disk).
  const [openMsg, setOpenMsg] = useState('');
  // Slide-in detail panel (the pan track's second panel). `detailOpen` drives
  // the pan; `panelContent` says which flow to render ({mode:'create'} or
  // {mode:'configure', project}). panelContent is kept through the slide-out
  // and cleared on the pan's transitionend so the panel doesn't blank mid-close.
  const [detailOpen, setDetailOpen] = useState(false);
  const [panelContent, setPanelContent] = useState(null);
  // GitHub-style "type the name to confirm" delete dialog target.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingProject, setDeletingProject] = useState(false);
  // Status-picker popover anchor (DOMRect of the clicked status circle).
  const [statusAnchor, setStatusAnchor] = useState(null);

  useEffect(() => {
    if (!accountOpen) return;
    const onDown = (e) => {
      if (accountRef.current && !accountRef.current.contains(e.target)) setAccountOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setAccountOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [accountOpen]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await listMyProjects();
    setProjects(data || []);
    setError(err);
    setLoading(false);
  }, []);

  useEffect(() => { if (session) loadProjects(); }, [session, loadProjects]);

  const ordered = useMemo(() => sortProjectsByRecent(userId, projects), [userId, projects]);
  const mostRecentId = useMemo(() => getMostRecentProjectId(userId), [userId, projects]);
  const recentMap = useMemo(() => getRecentMap(userId), [userId, projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q),
    );
  }, [ordered, query]);

  // Auth gate — a manual nav to /launch while signed-out bounces to /auth.
  if (authLoading) {
    return (
      <div className="lh-loading">
        <div className="spinner" />
      </div>
    );
  }
  if (!session) return <Navigate to="/auth" replace />;

  // Open a project. On Electron it opens in its OWN window (the hub stays
  // open); the new window boots straight into the project's dashboard. On web
  // (no multi-window) it falls back to same-window navigation.
  const onOpen = (project) => {
    if (openProjectWindow(project.id)) {
      // Stamp recency so the hub list reorders to reflect what was just opened.
      markProjectAccessed(userId, project.id, project.name);
      return;
    }
    markLaunchConsumed();
    beginSwitch(project.name);
    selectProject(project.id, project);
    navigate(`/projects/${project.id}/dashboard`);
  };

  const closeDetail = () => setDetailOpen(false);
  // Clear the panel content only AFTER the pan-back animation finishes, so the
  // panel stays painted while it slides away.
  const onPanTransitionEnd = (e) => {
    if (e.target === e.currentTarget && e.propertyName === 'transform' && !detailOpen) {
      setPanelContent(null);
    }
  };

  const onNewProject = () => {
    // Creation requires a projects folder (we mirror the project to disk).
    if (!projectsDir) { setView('settings'); return; }
    setPanelContent({ mode: 'create' });
    setDetailOpen(true);
  };

  // Switching to another section closes the detail pane so it doesn't linger
  // next to a non-projects view.
  const selectView = (v) => { setDetailOpen(false); setView(v); };

  // After a project is created in the panel: close it, mirror it as a folder
  // (named after the project) in the chosen projects directory, link that
  // folder to the project via a sidecar so re-picking it re-attaches, then
  // refresh the list.
  const onProjectCreated = async (project) => {
    setDetailOpen(false);
    if (project?.id && project?.name) {
      if (projectsDir) {
        const res = await localFolderApi.createFolder({ dir: projectsDir, name: project.name });
        if (res?.error && res.error !== 'A folder with that name already exists') {
          notify?.({ category: 'project', variant: 'warning', icon: 'folder', title: 'Project created, but its folder couldn’t be made', body: res.error, dedupeKey: `folder-fail-${project.id}` });
        } else if (res?.path) {
          await localFolderApi.writeSidecar({ dir: res.path, json: { version: 1, projectId: project.id, entries: {} } });
        }
      } else {
        notify?.({ category: 'project', variant: 'info', icon: 'folder', title: 'Tip: set a projects folder', body: 'Choose one in Settings to auto-create a folder for each new project.', dedupeKey: 'no-projects-dir' });
      }
    }
    loadProjects();
  };

  // Rename — inline from the row title. Persists, updates the list in place,
  // and returns success so the row can revert its draft on failure.
  const onRenameProject = async (project, newName) => {
    const { data, error: err } = await updateProject(project.id, { name: newName });
    if (err) {
      notify?.({ category: 'project', variant: 'error', icon: 'alert', title: 'Could not rename project', body: err.message, dedupeKey: `rename-fail-${project.id}` });
      return false;
    }
    const finalName = data?.name || newName;
    setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, name: finalName } : p)));
    notify?.({ category: 'project', variant: 'success', icon: 'folder', title: `Renamed to “${finalName}”`, dedupeKey: `rename-${project.id}` });
    return true;
  };

  // Delete — opens the GitHub-style retype-to-confirm modal.
  const onRequestDelete = (project) => setDeleteTarget(project);
  const confirmDeleteProject = async () => {
    if (!deleteTarget) return;
    setDeletingProject(true);
    const { error: err } = await deleteProject(deleteTarget.id);
    setDeletingProject(false);
    if (err) {
      notify?.({ category: 'project', variant: 'error', icon: 'alert', title: 'Could not delete project', body: err.message, dedupeKey: `delete-fail-${deleteTarget.id}` });
      return;
    }
    const name = deleteTarget.name;
    setProjects((prev) => prev.filter((p) => p.id !== deleteTarget.id));
    setDeleteTarget(null);
    notify?.({ category: 'project', variant: 'warning', icon: 'trash', title: `Deleted “${name}”`, dedupeKey: `project-deleted-${name}` });
    loadProjects();
  };

  // Open a project from a folder on disk: pick a directory, read its
  // `.docvex.json` sidecar for the project id, and open that project if it's
  // one the user has access to. Surfaces an inline message otherwise.
  const onOpenFromDirectory = async () => {
    setOpenMsg('');
    const dir = await localFolderApi.pick();
    if (!dir) return;
    const { json } = await localFolderApi.readSidecar(dir);
    const pid = json?.projectId;
    if (!pid) {
      setOpenMsg("That folder isn't a Docvex project — no .docvex.json was found in it.");
      return;
    }
    const match = projects.find((p) => p.id === pid);
    if (!match) {
      setOpenMsg("That project isn't in your account, or you don't have access to it.");
      return;
    }
    onOpen(match);
  };

  const onSignOut = async () => { setAccountOpen(false); await signOut(); };

  // Pick a projects directory via the native folder picker; persist per-user.
  const onChooseProjectsDir = async () => {
    const picked = await localFolderApi.pick();
    if (picked) {
      setProjectsDir(picked);
      writeProjectsDir(userId, picked);
    }
  };
  const onClearProjectsDir = () => {
    setProjectsDir('');
    writeProjectsDir(userId, '');
  };

  const displayName = getDisplayName(session.user);
  const avatarUrl = session.user?.user_metadata?.avatar_url || null;
  const avatarInitial = (displayName || '?').trim().charAt(0).toUpperCase();
  // Online status + subscription tier shown on the sidebar account button.
  const statusOpt = getStatusOption(session.user?.user_metadata?.status || DEFAULT_STATUS_KEY);

  const showUpdateBanner = hasUpdate || debugBanner;

  // Update-status derivation for the in-hub Updates view — mirrors the main
  // app's StatusBanner (same variant classes from Updates.css).
  const updState = installerState?.state;
  const updChecking = updState === 'checking' || updState === 'downloading';
  let updateTitle;
  let updateSub;
  let bannerVariant = 'updates-banner-uptodate';
  let updatePrimary = null;
  if (updState === 'downloaded') {
    bannerVariant = 'updates-banner-success';
    updateTitle = 'Update ready to install';
    updateSub = `Version ${latestVersion || ''} has been downloaded. Restart to apply.`;
    updatePrimary = (
      <button type="button" className="updates-btn updates-btn-primary" onClick={installUpdate}>
        {DownloadIcon} Restart &amp; install
      </button>
    );
  } else if (updState === 'downloading') {
    bannerVariant = 'updates-banner-update';
    updateTitle = 'Downloading update…';
    updateSub = typeof installerState?.percent === 'number'
      ? `${Math.round(installerState.percent)}% complete`
      : 'Please wait…';
  } else if (hasUpdate) {
    bannerVariant = 'updates-banner-update';
    updateTitle = `New version available${latestVersion ? `: v${latestVersion}` : ''}`;
    updateSub = currentVersion ? `You're on v${currentVersion}.` : 'A newer version of Docvex is available.';
    if (downloadUrl) {
      updatePrimary = (
        <button type="button" className="updates-btn updates-btn-primary" onClick={() => openExternal(downloadUrl)}>
          {DownloadIcon} Download{latestVersion ? ` v${latestVersion}` : ''}
        </button>
      );
    }
  } else {
    updateTitle = "You're up to date";
    updateSub = currentVersion ? `Running v${currentVersion}` : 'Running the latest version.';
  }

  const navItems = [
    { id: 'projects', label: 'Projects', icon: ProjectsNavIcon, active: view === 'projects', onClick: () => selectView('projects') },
    { id: 'updates', label: 'Updates', icon: UpdatesNavIcon, active: view === 'updates', onClick: () => selectView('updates') },
    { id: 'learn', label: 'Learn', icon: LearnNavIcon, active: view === 'learn', onClick: () => selectView('learn') },
    { id: 'settings', label: 'Settings', icon: SettingsNavIcon, active: view === 'settings', onClick: () => selectView('settings') },
  ];
  // Dev-only: a Debug toggle that force-shows the update banner for previewing.
  if (import.meta.env.DEV) {
    navItems.push({
      id: 'debug',
      label: 'Debug',
      icon: BugNavIcon,
      active: debugBanner,
      onClick: () => setDebugBanner((v) => !v),
    });
  }

  return (
    <div className="lh-page">
      {/* Update-available banner — full-width strip across the top of the
          window, above the sidebar + content. Shows on a real update
          (UpdatesContext.hasUpdate) or when the dev Debug toggle is on.
          Clicking opens the Updates page. */}
      {showUpdateBanner && (
        <button type="button" className="lh-update-banner" onClick={() => setView('updates')}>
          <span className="lh-update-banner-icon">{DownloadIcon}</span>
          <span className="lh-update-banner-text">
            <span className="lh-update-banner-title">Update available</span>
            <span className="lh-update-banner-sub">
              {latestVersion ? `Version ${latestVersion} is ready — click to view` : 'A new version is ready — click to view'}
            </span>
          </span>
        </button>
      )}

      <div className="lh-body">
      <aside className="lh-sidebar">
        <nav className="lh-sb-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`lh-sb-item${item.active ? ' is-active' : ''}`}
              onClick={item.onClick}
            >
              <span className="lh-sb-icon">{item.icon}</span>
              <span className="lh-sb-label">{item.label}</span>
            </button>
          ))}
        </nav>

        {/* Account lives at the foot of the sidebar. Shows the online status +
            subscription tier; clicking opens the full account settings view. */}
        <div className="lh-sb-footer">
          <button
            type="button"
            className={`lh-account-btn${view === 'account' ? ' is-active' : ''}`}
            onClick={() => selectView('account')}
            aria-label="Account settings"
          >
            <span className="lh-account-avatar" style={avatarUrl ? undefined : { background: avatarColor(userId || displayName) }}>
              {avatarUrl
                ? <img src={avatarUrl} alt="" referrerPolicy="no-referrer" draggable={false} />
                : avatarInitial}
              {/* The status circle is its own affordance — clicking it opens the
                  status picker, NOT the account view. */}
              <Tooltip content={statusAnchor ? undefined : statusOpt.label}>
                <span
                  className="lh-account-status-dot"
                  style={{ background: statusOpt.color }}
                  role="button"
                  tabIndex={0}
                  aria-label={`Status: ${statusOpt.label}. Click to change.`}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setStatusAnchor(e.currentTarget.getBoundingClientRect()); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setStatusAnchor(e.currentTarget.getBoundingClientRect()); } }}
                />
              </Tooltip>
            </span>
            <span className="lh-account-btn-info">
              <span className="lh-account-btn-name">{displayName}</span>
              <span className="lh-account-btn-meta">
                <span className="lh-account-btn-tier">{PLAN.tier}</span>
              </span>
            </span>
          </button>
        </div>
      </aside>

      {/* Pan viewport — the sidebar (above) stays fixed while this two-panel
          track translates: the projects/views panel pans left (under the
          sidebar) as the create panel pans in from the right. */}
      <div className="lh-pan">
      <div
        className={`lh-pan-track${detailOpen ? ' is-creating' : ''}`}
        onTransitionEnd={onPanTransitionEnd}
      >
      <div className="lh-pan-panel">
      <main className="lh-main">
        {view === 'projects' && (
          <HubView greeting={`Welcome back, ${displayName}`} title="Projects">
            {/* No projects folder set → can't create. Prompt the user to pick
                one in Settings; creation stays disabled until they do. */}
            {!projectsDir && (
              <button type="button" className="lh-nofolder" onClick={() => selectView('settings')}>
                <span className="lh-nofolder-icon">{FolderIcon}</span>
                <span className="lh-nofolder-text">
                  <strong>No projects folder selected</strong>
                  <span>Choose a folder in Settings to create new projects and sync them to disk.</span>
                </span>
                <span className="lh-nofolder-cta">Open Settings</span>
              </button>
            )}

            <div className="lh-toolbar">
              <div className="lh-search">
                <span className="lh-search-icon">{SearchIcon}</span>
                <input
                  type="text"
                  className="lh-search-input"
                  placeholder="Search projects…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoFocus
                />
              </div>
              <button type="button" className="lh-open-btn" onClick={onOpenFromDirectory}>
                {FolderIcon} Open
              </button>
              <Tooltip content={!projectsDir ? 'Select a projects folder in Settings first' : undefined}>
                <button
                  type="button"
                  className="lh-new-btn"
                  onClick={onNewProject}
                  disabled={!projectsDir}
                >
                  {PlusIcon} New
                </button>
              </Tooltip>
            </div>

            {openMsg && <div className="lh-open-msg">{openMsg}</div>}

            <div className="lh-list-frame">
              {loading && (
                <div className="lh-list">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={`skel-${i}`} className="lh-row lh-row-skel" aria-hidden="true">
                      <div className="lh-skel-bar" />
                    </div>
                  ))}
                </div>
              )}

              {!loading && error && (
                <div className="lh-state lh-state-error">
                  Couldn't load projects: {error.message}
                </div>
              )}

              {!loading && !error && projects.length === 0 && (
                <div className="lh-empty">
                  <h2>No projects yet</h2>
                  <p>
                    {projectsDir
                      ? 'Projects are how you share files and notes with your team.'
                      : 'Select a projects folder in Settings to create your first project.'}
                  </p>
                  <Tooltip content={!projectsDir ? 'Select a projects folder in Settings first' : undefined}>
                    <button
                      type="button"
                      className="lh-new-btn"
                      onClick={onNewProject}
                      disabled={!projectsDir}
                    >
                      {PlusIcon} Create your first project
                    </button>
                  </Tooltip>
                </div>
              )}

              {!loading && !error && projects.length > 0 && filtered.length === 0 && (
                <div className="lh-state">No projects match “{query}”.</div>
              )}

              {!loading && !error && filtered.length > 0 && (
                <div className="lh-list">
                  {filtered.map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      lastOpened={recentMap[p.id]?.ts}
                      mostRecent={p.id === mostRecentId}
                      projectsDir={projectsDir}
                      onOpen={onOpen}
                      onRename={onRenameProject}
                      onDelete={onRequestDelete}
                    />
                  ))}
                </div>
              )}
            </div>
          </HubView>
        )}

        {view === 'learn' && (
          <HubView greeting="Resources" title="Learn">
            <div className="lh-learn-scroll">
              {/* Documentation pill — kept. */}
              <button type="button" className="lh-learn-doc" onClick={() => openExternal(DOCS_URL)}>
                <span className="lh-learn-doc-icon">{DocsNavIcon}</span>
                <span className="lh-learn-doc-text">
                  <strong>Documentation</strong>
                  <span>Read the full docs on docvex.ro.</span>
                </span>
                <span className="lh-learn-doc-arrow">{ExternalLinkIcon}</span>
              </button>

              {/* Video tutorials, grouped by feature area. */}
              {LEARN_CATEGORIES.map((cat) => (
                <section key={cat.id} className="lh-tut-section">
                  <h2 className="lh-tut-cat">{cat.label}</h2>
                  <div className="lh-tut-grid">
                    {cat.videos.map((v) => (
                      <Tooltip key={v.id} content={v.title}>
                        <button
                          type="button"
                          className="lh-tut-card"
                          onClick={() => openExternal(v.url)}
                        >
                          <span className="lh-tut-thumb" data-cat={cat.cat}>
                            <span className="lh-tut-play">{PlayIcon}</span>
                            <span className="lh-tut-duration">{v.duration}</span>
                          </span>
                          <span className="lh-tut-title">{v.title}</span>
                          <span className="lh-tut-meta">
                            <span className="lh-tut-yt">{YoutubeIcon}</span> Docvex · Tutorial
                          </span>
                        </button>
                      </Tooltip>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </HubView>
        )}

        {view === 'updates' && (
          <HubView greeting={currentVersion ? `Current version v${currentVersion}` : 'Version'} title="Updates">
            <div className="lh-updates">
              {/* Status banner — same variants as the main app's Updates page. */}
              <div className={`updates-banner ${bannerVariant}`}>
                <div>
                  <strong>{updateTitle}</strong>
                  <p>{updateSub}</p>
                </div>
                <div className="lh-update-actions">
                  {updatePrimary}
                  <button type="button" className="updates-btn" onClick={checkNow} disabled={updChecking}>
                    {RefreshIcon} {updState === 'checking' ? 'Checking…' : 'Check now'}
                  </button>
                </div>
              </div>

              {/* Release cards — like the main app, but WITHOUT the patch-notes
                  body (and so without the collapse toggle). */}
              <section className="updates-releases">
                {updatesLoading && (!releases || releases.length === 0) && (
                  <div className="updates-empty">Loading releases…</div>
                )}
                {!updatesLoading && (!releases || releases.length === 0) && (
                  <div className="updates-empty">No releases published yet.</div>
                )}
                {releases?.map((release, i) => {
                  // Resolve the real version (falls back to release.name when
                  // tag_name is electron-forge's `untagged-<sha>` placeholder).
                  const tag = versionTagFor(release);
                  const ver = tag.replace(/^v/, '');
                  const isCurrent = ver === currentVersion;
                  const prevTag = releases[i + 1] ? versionTagFor(releases[i + 1]) : null;
                  const kind = releaseKind(tag, prevTag);
                  const cardClass = ['release-card', 'is-collapsed', kind && `is-${kind}`]
                    .filter(Boolean).join(' ');
                  return (
                    <article key={release.id || tag} className={cardClass}>
                      <header className="release-header">
                        <div className="release-version-line">
                          <h2 className="release-version">{tag}</h2>
                          {kind && <span className={`release-tag release-tag-${kind}`}>{kind}</span>}
                          {isCurrent && <span className="release-tag release-tag-current">Installed</span>}
                          {release.prerelease && <span className="release-tag release-tag-pre">Pre-release</span>}
                        </div>
                        <div className="release-meta">
                          <span>{formatReleaseDate(release.published_at)}</span>
                          {release.html_url && (
                            <a
                              href={release.html_url}
                              className="release-link"
                              onClick={(e) => { e.preventDefault(); openExternal(release.html_url); }}
                            >
                              View on GitHub {ExternalLinkIcon}
                            </a>
                          )}
                        </div>
                      </header>
                    </article>
                  );
                })}
              </section>
            </div>
          </HubView>
        )}

        {view === 'settings' && (
          <HubView greeting="Preferences" title="Settings">
            <div className="lh-settings">
              <div className="lh-setting">
                <div className="lh-setting-head">
                  <span className="lh-setting-icon">{FolderIcon}</span>
                  <div className="lh-setting-headtext">
                    <h3>Projects directory</h3>
                    <p>The folder where your projects live on this computer.</p>
                  </div>
                </div>
                <div className="lh-setting-control">
                  <span className={`lh-setting-path${projectsDir ? '' : ' is-empty'}`}>
                    {projectsDir || 'No folder set'}
                  </span>
                  <div className="lh-setting-actions">
                    {projectsDir && (
                      <button type="button" className="lh-setting-btn-ghost" onClick={onClearProjectsDir}>
                        Clear
                      </button>
                    )}
                    <button type="button" className="lh-new-btn" onClick={onChooseProjectsDir}>
                      {FolderIcon} Choose folder
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </HubView>
        )}

        {view === 'account' && (
          <HubView title="Account" hideHeadline>
            <div className="lh-account-body">
              <Account />
            </div>
          </HubView>
        )}
      </main>
      </div>

      {/* Second panel in the pan track — the create-project flow. Kept mounted
          through the slide-out via panelContent. */}
      <div className="lh-pan-panel">
      {panelContent?.mode === 'create' && (
        <CreateProjectPanel
          open={detailOpen}
          onClose={closeDetail}
          onCreated={onProjectCreated}
        />
      )}
      </div>
      </div>
      </div>
      </div>

      {/* GitHub-style "type the name to confirm" delete dialog. */}
      <DeleteProjectModal
        open={!!deleteTarget}
        projectName={deleteTarget?.name || ''}
        pending={deletingProject}
        onConfirm={confirmDeleteProject}
        onCancel={() => { if (!deletingProject) setDeleteTarget(null); }}
      />

      {/* Status picker — anchored to the clicked status circle in the footer. */}
      {statusAnchor && (
        <StatusPicker
          anchorRect={statusAnchor}
          currentStatus={session.user?.user_metadata?.status || DEFAULT_STATUS_KEY}
          onPick={async (key) => { setStatusAnchor(null); await updateStatus(key); }}
          onClose={() => setStatusAnchor(null)}
        />
      )}
    </div>
  );
}
