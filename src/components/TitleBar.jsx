import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useUpdates } from '../context/UpdatesContext';
import { useSplitView, SPLIT_LAYOUTS, isTriLayout, rotateTri } from '../context/SplitViewContext';
import { useReportProblem } from '../context/ReportProblemContext';
import Tooltip, { useTooltip } from './Tooltip';
import FpsMeter from './FpsMeter';
import { useMorphPill } from './useMorphPill';
import { DEFAULT_STATUS_KEY, getStatusOption, STATUS_OPTIONS, updateStatus } from '../lib/userStatus';
import { listMembers } from '../lib/projects';
import { localFolderApi, isElectronBranch } from '../lib/localFolder';
import { readProjectsDir } from '../lib/projectsDir';
import {
  isMac,
  openExternal,
  windowMinimize,
  windowToggleMaximize,
  windowClose,
  windowIsMaximized,
  onWindowMaximizedChanged,
  windowIsFullscreen,
  onWindowFullscreenChanged,
} from '../lib/platform';

// The marketing site's account dashboard (docvex.ro/account.html). "Open
// account" in the title bar opens this in the user's browser, handing the
// current Supabase session across in the URL fragment (see openAccount) so the
// site adopts it and opens straight on the dashboard.
const ACCOUNT_DASHBOARD_URL = 'https://docvex.ro/account.html';
import brandIcon from '../favicon.ico';
import './TitleBar.css';

// Custom frameless title bar (Electron only — App.jsx gates it on isElectron).
// One bar holds the Theme control AND the window controls (minimize / maximize
// / close), so they live in the same section, separated by a divider. Account
// lives here too (TbAccount → /account); Versions + Documentation live in the
// Sidebar nav. The whole bar is a drag region; every interactive element opts
// out with `-webkit-app-region: no-drag` (set in TitleBar.css).

const ChevronDownIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);
const CheckIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
// "Report a problem" — a flag.
const ReportIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
    <line x1="4" y1="22" x2="4" y2="15" />
  </svg>
);

// djb2 avatar palette (same 12-colour scheme used across the app).
const AVATAR_PALETTE = ['#0891B2', '#BE185D', '#4F46E5', '#047857', '#B45309', '#6D28D9', '#DC2626', '#0369A1', '#DB2777', '#059669', '#7C3AED', '#EA580C'];
function djb2(seed) {
  let h = 0;
  for (let i = 0; i < (seed || '').length; i++) { h = ((h << 5) - h) + seed.charCodeAt(i); h |= 0; }
  return Math.abs(h);
}
function avatarColor(seed) { return AVATAR_PALETTE[djb2(seed) % AVATAR_PALETTE.length]; }

// Classify the available update by how it bumps the installed version
// (major / minor / patch) — used to colour the update pill the same way the
// Versions page colour-codes each release. Returns null for non-semver input.
function bumpKind(from, to) {
  const parse = (v) => {
    const m = String(v || '').replace(/^v/, '').split('-')[0].match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return null;
  if (b[0] !== a[0]) return 'major';
  if (b[1] !== a[1]) return 'minor';
  if (b[2] !== a[2]) return 'patch';
  return null;
}
// One project-member avatar (real OAuth picture or coloured initial fallback).
function TbMemberAvatar({ member }) {
  const p = member.profile || {};
  const name = p.full_name || p.name || p.email || 'Member';
  const url = p.avatar_url || null;
  // Hook form (not the wrapper): avatars overlap via `:first-child`, which a
  // display:contents wrapper would break.
  const { triggerProps, tooltip } = useTooltip(name);
  return (
    <>
      <span className="tb-member-avatar" style={url ? undefined : { background: avatarColor(member.user_id) }} {...triggerProps}>
        {url ? <img src={url} alt="" referrerPolicy="no-referrer" /> : name.charAt(0).toUpperCase()}
      </span>
      {tooltip}
    </>
  );
}

// Display name resolution — same precedence used across the app.
function getDisplayName(user) {
  const meta = user?.user_metadata;
  if (meta?.full_name) return meta.full_name;
  if (meta?.name) return meta.name;
  if (user?.email) {
    const at = user.email.indexOf('@');
    return at > 0 ? user.email.slice(0, at) : user.email;
  }
  return 'Account';
}

// Title-bar account control — the avatar (real OAuth picture or initial
// fallback) with a status dot in the corner. Hovering shows the name as a
// cursor tooltip; left-clicking morphs that tooltip straight into a dropdown
// menu (same useMorphPill FLIP the Split control uses) — an identity header
// (avatar + name + email), a row of status pills to change activity status
// inline, and buttons to open the full Account page / sign out. The pill is
// anchored LEFT (`placement: 'left'`) so it grows inward from the bar's right
// edge instead of off-screen.
function TbAccount({ user, onOpen, onSignOut }) {
  const avatarUrl = user?.user_metadata?.avatar_url;
  const initial = (user?.email || '?').charAt(0).toUpperCase();
  const statusKey = user?.user_metadata?.status || DEFAULT_STATUS_KEY;
  const opt = getStatusOption(statusKey);
  const name = getDisplayName(user);
  const email = user?.email || '';

  const accountPill = useMorphPill({
    hoverContent: name,
    placement: 'left',
    className: 'tb-account-pill',
    stickyMenu: true,
    menuHeader: (closeMenu) => (
      <div className="tb-account-pop">
        {/* Identity header — avatar, name, email. */}
        <div className="tb-account-menu-head">
          {avatarUrl
            ? <img className="tb-account-menu-avatar" src={avatarUrl} alt="" referrerPolicy="no-referrer" />
            : <span className="tb-account-menu-avatar tb-account-avatar-fallback">{initial}</span>}
          <span className="tb-account-menu-id">
            <span className="tb-account-menu-name">{name}</span>
            {email && <span className="tb-account-menu-email">{email}</span>}
          </span>
        </div>

        {/* Status pills — change activity status inline (persists to
            user_metadata; the active pill follows the session). */}
        <div className="tb-account-menu-status">
          <span className="tb-account-menu-label">Status</span>
          <div className="tb-account-status-pills">
            {STATUS_OPTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`tb-status-pill${s.key === statusKey ? ' is-active' : ''}${s.key === 'offline' ? ' is-offline' : ''}`}
                style={{ '--status-color': s.color }}
                onClick={() => updateStatus(s.key)}
                aria-pressed={s.key === statusKey}
              >
                <span className="tb-status-pill-dot" aria-hidden="true" />
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Open the full Account page + sign out. */}
        <div className="tb-account-menu-actions">
          <button
            type="button"
            className="tb-account-menu-open"
            onClick={() => { closeMenu(); onOpen(); }}
          >
            Open account
          </button>
          <button
            type="button"
            className="tb-account-menu-signout"
            onClick={() => { closeMenu(); onSignOut?.(); }}
          >
            Sign out
          </button>
        </div>
      </div>
    ),
  });

  return (
    <div className="tb-account-wrap">
      <button
        type="button"
        className={`tb-account${accountPill.isMenuOpen ? ' is-open' : ''}`}
        onMouseMove={accountPill.handleMouseMove}
        onMouseLeave={accountPill.handleMouseLeave}
        onClick={accountPill.handleOpenMenu}
        aria-haspopup="menu"
        aria-expanded={accountPill.isMenuOpen}
        aria-label="Account"
      >
        <span className="tb-account-avatar-wrap">
          {avatarUrl
            ? <img className="tb-account-avatar" src={avatarUrl} alt="" referrerPolicy="no-referrer" />
            : <span className="tb-account-avatar tb-account-avatar-fallback">{initial}</span>}
          <span
            className={`tb-account-status${opt.key === 'offline' ? ' is-offline' : ''}`}
            style={{ '--status-color': opt.color }}
            aria-hidden="true"
          />
        </span>
      </button>
      {accountPill.node}
    </div>
  );
}

// Compact usage meter for the title bar (moved from the Project Overview's
// "Usage" panel). A short label over a thin bar; the full label + value lives
// in the cursor tooltip. Most values are static placeholders (no data source
// yet) — only the seat count is real, off the selected project's member_count.
function TbUsageMeter({ used, total, tint }) {
  const pct = total ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;
  return (
    <div className="tb-usage-meter">
      <span className="tb-usage-track">
        <span className="tb-usage-fill" style={{ width: `${pct}%`, background: tint }} />
      </span>
    </div>
  );
}

// ── Split-view layout glyphs ──
// Each glyph mirrors the pane arrangement it selects: a 16×16 frame with the
// pane rectangles drawn inside (single / vertical / horizontal / T / quad).
function SplitLayoutIcon({ id, size = 16 }) {
  const frame = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 };
  const solid = { fill: 'currentColor', opacity: 0.9 };
  const line = { stroke: 'currentColor', strokeWidth: 1.5 };
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" {...frame} />
      {id === 'vertical' && <line x1="8" y1="1.5" x2="8" y2="14.5" {...line} />}
      {id === 'horizontal' && <line x1="1.5" y1="8" x2="14.5" y2="8" {...line} />}
      {/* "T" orientations — the full divider plus the half-divider that
          splits the two-pane side. The glyph mirrors which edge the single
          full-span pane occupies (top / right / bottom / left). */}
      {id === 'tri' && (
        <>
          <line x1="1.5" y1="8" x2="14.5" y2="8" {...line} />
          <line x1="8" y1="8" x2="8" y2="14.5" {...line} />
        </>
      )}
      {id === 'tri-bottom' && (
        <>
          <line x1="1.5" y1="8" x2="14.5" y2="8" {...line} />
          <line x1="8" y1="1.5" x2="8" y2="8" {...line} />
        </>
      )}
      {id === 'tri-left' && (
        <>
          <line x1="8" y1="1.5" x2="8" y2="14.5" {...line} />
          <line x1="8" y1="8" x2="14.5" y2="8" {...line} />
        </>
      )}
      {id === 'tri-right' && (
        <>
          <line x1="8" y1="1.5" x2="8" y2="14.5" {...line} />
          <line x1="1.5" y1="8" x2="8" y2="8" {...line} />
        </>
      )}
      {id === 'quad' && (
        <>
          <line x1="8" y1="1.5" x2="8" y2="14.5" {...line} />
          <line x1="1.5" y1="8" x2="14.5" y2="8" {...line} />
        </>
      )}
      {id === 'single' && <rect x="4" y="4" width="8" height="8" rx="1" {...solid} />}
    </svg>
  );
}
const SPLIT_ORDER = ['single', 'vertical', 'horizontal', 'tri', 'quad'];

// "Update" glyph (overwrite a saved layout with the current arrangement).
const UpdateGlyph = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.6-6.4" /><polyline points="21 3 21 8 16 8" />
  </svg>
);
// "Edit" glyph (rename a saved layout).
const EditGlyph = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
  </svg>
);

// ── Window-control glyphs (Windows-ish line icons) ──
const MinimizeGlyph = (
  <svg viewBox="0 0 12 12" width="11" height="11"><rect x="1.5" y="5.5" width="9" height="1" fill="currentColor" /></svg>
);
const MaximizeGlyph = (
  <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.7" y="1.7" width="8.6" height="8.6" /></svg>
);
const RestoreGlyph = (
  <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="1.6" y="3.4" width="6.6" height="6.6" /><path d="M3.8 3.4V1.7h6.6v6.6H8.6" />
  </svg>
);
const CloseGlyph = (
  <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <line x1="2" y1="2" x2="10" y2="10" /><line x1="10" y1="2" x2="2" y2="10" />
  </svg>
);

// Routes where the Split-view button is hidden — the top-level personal / nav
// pages that open fullscreen and have no tile-able content area. Kept in sync
// with Sidebar.jsx's PERSONAL_ROUTES.
const SPLIT_HIDDEN_ROUTES = new Set(['/', '/newsletter', '/versions', '/settings', '/admin', '/debug', '/account', '/mail', '/projects']);

export default function TitleBar() {
  const { session, logout } = useAuth();
  const { selectedProject } = useSelectedProject();
  const { hasUpdate, latestVersion, currentVersion } = useUpdates();
  const { layout, setLayout, customLayouts, addCustomLayout, applyCustomLayout, updateCustomLayout, renameCustomLayout, removeCustomLayout, activeCustomLayout } = useSplitView();
  // Inline "save current layout" affordance in the split menu: when armed it
  // swaps the "Save current…" button for a name field.
  const [savingLayout, setSavingLayout] = useState(false);
  const [layoutName, setLayoutName] = useState('');
  // Inline rename ("Edit") for a saved layout: id being edited + its draft name.
  const [editingLayoutId, setEditingLayoutId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const { captureAndOpen: openReportProblem, capturing: reportCapturing } = useReportProblem();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // "Open account" opens the website's account dashboard in the user's default
  // browser instead of the in-app Account page. The app and the site are
  // different origins, so the session can't transfer through shared storage —
  // we hand it across in the URL fragment (dvx_at / dvx_rt) and the site adopts
  // it, landing straight on the dashboard instead of prompting sign-in. A
  // fragment never reaches a server, and the site strips it from the URL the
  // moment it's consumed.
  const openAccount = () => {
    let url = ACCOUNT_DASHBOARD_URL;
    const at = session?.access_token;
    const rt = session?.refresh_token;
    if (at && rt) {
      url += '#dvx_at=' + encodeURIComponent(at) + '&dvx_rt=' + encodeURIComponent(rt);
    }
    openExternal(url);
  };
  // The doc-viewer is a secondary window (boots at /doc-viewer); it's a plain
  // file viewer, so it hides the Split-layout and Theme controls.
  const onDocViewer = pathname === '/doc-viewer';
  // The Hub is the projects launcher (/projects). There the brand reads
  // "DOCVEX | HUB" and ALL selected-project chrome (name chip + member avatars
  // + file count + usage meters) is hidden — you're between projects, not in one.
  const onHub = pathname === '/projects';
  // The signed-out screen (/auth). There the bar goes transparent and drops the
  // brand mark so the auth window reads as one full-bleed surface with just the
  // window controls floating on top.
  const onAuth = pathname === '/auth';
  // The Split-view button only makes sense on the project workspace pages
  // (Files / Chat / AI / … and a project's own /projects/:id pages), where the
  // content area can tile into independently-navigable panes. On the top-level
  // personal / nav pages it's just noise, so hide it there (and on the
  // doc-viewer window). Mirrors Sidebar's PERSONAL_ROUTES.
  const hideSplitButton = onDocViewer || SPLIT_HIDDEN_ROUTES.has(pathname);

  // Project member list (for the avatar stack next to the project name).
  // Fetched once per selected project; cleared when there's no selection /
  // on the Hub.
  const [members, setMembers] = useState([]);
  const projectId = selectedProject?.id || null;
  useEffect(() => {
    if (onHub || !projectId) { setMembers([]); return undefined; }
    let alive = true;
    listMembers(projectId).then(({ data }) => { if (alive) setMembers(data || []); });
    return () => { alive = false; };
  }, [projectId, onHub]);

  // Real local file count for the selected project (matches the Files page).
  // Electron only — the web build has no ambient folder, so it stays null.
  const userId = session?.user?.id || null;
  const [fileCount, setFileCount] = useState(null);
  useEffect(() => {
    if (onHub || !projectId || !isElectronBranch) { setFileCount(null); return undefined; }
    let alive = true;
    (async () => {
      try {
        const { path } = await localFolderApi.projectDir(projectId, selectedProject?.name, readProjectsDir(userId) || undefined);
        if (!path) { if (alive) setFileCount(null); return; }
        const { files, error } = await localFolderApi.listAll(path);
        if (alive) setFileCount(error ? null : (files || []).length);
      } catch { if (alive) setFileCount(null); }
    })();
    return () => { alive = false; };
  }, [projectId, onHub, selectedProject?.name, userId]);

  // Usage meters shown next to the project name (moved here from the Project
  // Overview). Seats is real (member_count); the rest are placeholders that
  // mirror the old Overview gauges until real data sources land.
  const usageMeters = selectedProject ? [
    { key: 'seats', short: 'Seats',   label: 'Active members',    used: selectedProject.member_count ?? 1, total: 10,   unit: 'seats',      tint: 'var(--cat-file)' },
    { key: 'mem',   short: 'Storage', label: 'Project memory',    used: 2.4,                               total: 5,    unit: 'GB',         tint: 'var(--accent)' },
    { key: 'req',   short: 'AI req',  label: 'AI requests',       used: 418,                               total: 1000, unit: 'this month', tint: 'var(--cat-update)' },
    { key: 'tok',   short: 'Tokens',  label: 'AI context tokens', used: 6.2,                               total: 12,   unit: 'K tokens',   tint: 'var(--cat-member)' },
  ] : [];

  const [maximized, setMaximized] = useState(false);

  // Split / Theme menus reuse the file grid's morph-pill — here opened on
  // LEFT click (handleOpenMenu), so the cursor tooltip morphs straight into
  // the menu, matching the right-click feel. Menu items carry rich content
  // (layout glyph / label + a check on the active choice); their onClick
  // fires then the pill closes itself.
  // ── Split-view menu ───────────────────────────────────────────────────────
  // Top: a 2×3 grid of icon-only layout tiles (single / vertical / horizontal /
  // T / quad + a rotate tile for spinning the active "T" through its four
  // orientations). Below a divider: user-saved custom layouts (named presets of
  // the current arrangement) + a "Save current…" affordance. The whole thing is
  // rendered as the pill's menuHeader so the menu stays open while the user
  // tries layouts, rotates, names, and saves; menuItems is empty.
  const triActive = isTriLayout(layout);
  const commitSaveLayout = () => {
    const entry = addCustomLayout(layoutName);
    if (entry) { setLayoutName(''); setSavingLayout(false); }
  };
  const splitPill = useMorphPill({
    hoverContent: 'Split view',
    placement: 'left',
    className: 'tb-split-pill',
    stickyMenu: true,
    menuHeader: (closeMenu) => (
      <div className="tb-split-menu">
        <div className="tb-split-grid" role="group" aria-label="Split layouts">
          {SPLIT_ORDER.map((id) => {
            const active = id === 'tri' ? triActive : layout === id;
            const glyphId = id === 'tri' && triActive ? layout : id;
            // The "T" tile doubles as its own rotate control: pressing it while
            // it's already active spins the T one quarter-turn (there's no
            // separate rotate button anymore).
            const label = id === 'tri' && triActive ? 'Rotate the T split' : SPLIT_LAYOUTS[id].label;
            return (
              <Tooltip key={id} content={label}>
                <button
                  type="button"
                  className={`tb-split-cell${active ? ' is-active' : ''}`}
                  aria-label={label}
                  aria-pressed={active}
                  onClick={() => {
                    if (id === 'tri') setLayout(triActive ? rotateTri(layout, 1) : 'tri');
                    else setLayout(id);
                  }}
                >
                  <SplitLayoutIcon id={glyphId} size={22} />
                </button>
              </Tooltip>
            );
          })}
        </div>

        <div className="tb-split-divider" role="separator" />

        <div className="tb-split-custom">
          <span className="tb-split-custom-title">Custom layouts</span>
          {customLayouts.length === 0 && !savingLayout && (
            <span className="tb-split-custom-empty">Save the current split to reuse it later.</span>
          )}
          {customLayouts.map((cl) => {
            const isActive = activeCustomLayout?.id === cl.id;
            const isEditing = editingLayoutId === cl.id;
            const commitRename = () => {
              renameCustomLayout(cl.id, editingName);
              setEditingLayoutId(null);
              setEditingName('');
            };
            return (
              <div key={cl.id} className={`tb-split-custom-entry${isActive ? ' is-active' : ''}`}>
                {isEditing ? (
                  // Inline rename form (the "Edit" action).
                  <form
                    className="tb-split-add-form"
                    onSubmit={(e) => { e.preventDefault(); commitRename(); }}
                  >
                    <span className="tb-split-add-glyph"><SplitLayoutIcon id={cl.layout} size={16} /></span>
                    <input
                      type="text"
                      className="tb-split-add-input"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { e.stopPropagation(); setEditingLayoutId(null); setEditingName(''); }
                      }}
                      placeholder="Layout name…"
                      maxLength={40}
                      autoFocus
                      aria-label={`Rename ${cl.name}`}
                    />
                    <button type="submit" className="tb-split-add-save" disabled={!editingName.trim()}>Save</button>
                  </form>
                ) : (
                  <Tooltip content={`Apply “${cl.name}”`}>
                    <button
                      type="button"
                      className={`tb-split-custom-apply${isActive ? ' is-active' : ''}`}
                      onClick={() => { applyCustomLayout(cl); closeMenu(); }}
                    >
                      <span className="tb-split-custom-glyph"><SplitLayoutIcon id={cl.layout} size={16} /></span>
                      <span className="tb-split-custom-name">{cl.name}</span>
                    </button>
                  </Tooltip>
                )}

                {/* Edit / Update / Delete sit BELOW the selected layout. */}
                {isActive && !isEditing && (
                  <div className="tb-split-custom-actions">
                    <button
                      type="button"
                      className="tb-split-custom-action"
                      onClick={() => { setEditingLayoutId(cl.id); setEditingName(cl.name); }}
                    >
                      {EditGlyph}<span>Edit</span>
                    </button>
                    <button
                      type="button"
                      className="tb-split-custom-action"
                      onClick={() => updateCustomLayout(cl.id)}
                    >
                      {UpdateGlyph}<span>Update</span>
                    </button>
                    <button
                      type="button"
                      className="tb-split-custom-action is-danger"
                      onClick={() => removeCustomLayout(cl.id)}
                    >
                      {CloseGlyph}<span>Delete</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {savingLayout ? (
            <form
              className="tb-split-add-form"
              onSubmit={(e) => { e.preventDefault(); commitSaveLayout(); }}
            >
              <span className="tb-split-add-glyph"><SplitLayoutIcon id={layout} size={16} /></span>
              <input
                type="text"
                className="tb-split-add-input"
                value={layoutName}
                onChange={(e) => setLayoutName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.stopPropagation(); setSavingLayout(false); setLayoutName(''); }
                }}
                placeholder="Layout name…"
                maxLength={40}
                autoFocus
                aria-label="Custom layout name"
              />
              <button type="submit" className="tb-split-add-save" disabled={!layoutName.trim()}>Save</button>
            </form>
          ) : (
            <button type="button" className="tb-split-add" onClick={() => setSavingLayout(true)}>
              <span className="tb-split-add-plus" aria-hidden="true">+</span> Save current layout
            </button>
          )}
        </div>
      </div>
    ),
  });
  // Reset the "save layout" input whenever the split menu closes, so it
  // reopens in its default (button, not armed input) state.
  useEffect(() => {
    if (!splitPill.isMenuOpen) { setSavingLayout(false); setLayoutName(''); setEditingLayoutId(null); setEditingName(''); }
  }, [splitPill.isMenuOpen]);

  // Track OS maximized state so the maximize⇄restore glyph stays correct.
  useEffect(() => {
    let alive = true;
    windowIsMaximized().then((v) => { if (alive) setMaximized(!!v); });
    const off = onWindowMaximizedChanged((v) => setMaximized(!!v));
    return () => { alive = false; off?.(); };
  }, []);

  // Flag <html> while in native fullscreen so the macOS brand inset (which
  // clears the traffic lights) drops — fullscreen hides the lights. Class-based
  // so it's a pure CSS concern; no re-render needed.
  useEffect(() => {
    if (!isMac) return undefined;
    const root = document.documentElement;
    const apply = (v) => root.classList.toggle('is-fullscreen', !!v);
    let alive = true;
    windowIsFullscreen().then((v) => { if (alive) apply(v); });
    const off = onWindowFullscreenChanged(apply);
    return () => { alive = false; off?.(); root.classList.remove('is-fullscreen'); };
  }, []);

  const signedIn = !!session;
  // Semver bump of the available update, used to colour the pill the same way
  // the Versions page colour-codes each release (major/minor/patch).
  const updateKind = hasUpdate ? bumpKind(currentVersion, latestVersion) : null;

  return (
    <div className={`tb-bar${onAuth ? ' is-auth' : ''}`}>
      {/* FPS indicator — fixed at the top-centre of the window. */}
      <FpsMeter />
      {/* Brand on the left — "DOCVEX", with a "| HUB" suffix on the Hub
          (/projects). When a project is selected (and not on the Hub), its name
          renders after a divider as a clickable chip that opens the project's
          Overview (Personal → Projects → [project], i.e. /projects/:id). */}
      <div className="tb-brand">
        {/* Icon + DOCVEX — plain, non-interactive text (with a "| HUB" suffix
            on the Hub; the divider + HUB live INSIDE the static span so the
            flex `gap` spaces both sides of the "|" symmetrically). */}
        {/* Brand mark — hidden on the signed-out screen so the auth window
            reads clean (just the window controls on the transparent bar). */}
        {!onAuth && (
          <span className="tb-brand-static">
            <img src={brandIcon} alt="" className="tb-brand-icon" />
            <span className="tb-brand-name">DOCVEX</span>
            {onHub && (
              <>
                <span className="tb-brand-sep" aria-hidden="true">|</span>
                <span className="tb-brand-suffix">HUB</span>
              </>
            )}
          </span>
        )}
        {/* Version pill — to the right of the app name. ONLY shown when a newer
            version is available: "Update · v<latest> · <kind>", colour-coded by
            the semver bump (major/minor/patch) to match the Versions page; the
            dot pulses. Clicking opens the Versions page. Up to date = no pill. */}
        {signedIn && hasUpdate && (
          <Tooltip content={latestVersion ? `Update available — v${latestVersion}${updateKind ? ` (${updateKind})` : ''}` : 'Update available'}>
            <button
              type="button"
              className={`tb-update-badge${updateKind ? ` is-${updateKind}` : ''}`}
              onClick={() => navigate('/versions')}
              aria-label={latestVersion ? `Update available, version ${latestVersion}` : 'Update available'}
            >
              <span className="tb-update-dot" aria-hidden="true" />
              <span>
                {latestVersion
                  ? `Update · v${latestVersion}${updateKind ? ` · ${updateKind}` : ''}`
                  : 'Update available'}
              </span>
            </button>
          </Tooltip>
        )}
        {!onHub && signedIn && selectedProject && (
          <>
            <span className="tb-brand-sep" aria-hidden="true">|</span>
            <Tooltip content={`Open ${selectedProject.name}`}>
              <button
                type="button"
                className="tb-project-name"
                /* `fromTopbar` tells the Overview to drop its "All projects"
                   back-link — opening the project from the topbar is staying
                   inside the current workspace, not drilling in from the list. */
                onClick={() => navigate(`/projects/${selectedProject.id}`, { state: { fromTopbar: true } })}
              >
                {selectedProject.name}
              </button>
            </Tooltip>
          </>
        )}
      </div>

      {/* Project meta next to the name: member avatars (max 5, +N) · files
          count · usage bars, dot-separated. Only with a project selected and
          not on the Hub. */}
      {!onHub && signedIn && selectedProject && (
        <div className="tb-meta">
          {members.length > 1 && (
            <>
              <span className="tb-meta-sep" aria-hidden="true">·</span>
              <span className="tb-meta-avatars">
                {members.slice(0, 5).map((m) => (
                  <TbMemberAvatar key={m.user_id} member={m} />
                ))}
                {members.length > 5 && (
                  <span className="tb-meta-more">+{members.length - 5}</span>
                )}
              </span>
            </>
          )}

          {fileCount != null && (
            <>
              <span className="tb-meta-sep" aria-hidden="true">·</span>
              <span className="tb-meta-files">{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>
            </>
          )}

          {usageMeters.length > 0 && (
            <>
              <span className="tb-meta-sep" aria-hidden="true">·</span>
              {/* Hovering the bars shows all metrics as a color-coded list. */}
              <Tooltip
                className="tb-usage-tip-pill"
                content={(
                  <span className="tb-usage-tip-list">
                    {usageMeters.map((m) => {
                      const pct = m.total ? Math.round(Math.max(0, Math.min(100, (m.used / m.total) * 100))) : 0;
                      return (
                        <span key={m.key} className="tb-usage-tip-row">
                          <span className="tb-usage-tip-dot" style={{ background: m.tint }} />
                          <span className="tb-usage-tip-label">{m.label}</span>
                          <span className="tb-usage-tip-value" style={{ color: m.tint }}>
                            {m.used} / {m.total} {m.unit} · {pct}%
                          </span>
                        </span>
                      );
                    })}
                  </span>
                )}
              >
                <div className="tb-usage">
                  {usageMeters.map((m) => (
                    <TbUsageMeter key={m.key} {...m} />
                  ))}
                </div>
              </Tooltip>
            </>
          )}
        </div>
      )}

      {/* The bar's flex pushes the cluster to the right. */}
      <div className="tb-drag-spacer" />

      {signedIn && (
        <>
          {/* Report / Split / Theme share ONE actions cluster so the buttons
              sit tightly together (the container's small gap is the only
              spacing between them). */}
          <div className="tb-actions">
            {/* Report a problem — captures a screenshot (html2canvas) and
                opens the report modal. Moved here from the sidebar. */}
            <Tooltip content={reportCapturing ? 'Capturing screenshot…' : 'Report a problem'}>
              <button
                type="button"
                className="tb-btn tb-btn-icon-only"
                onClick={openReportProblem}
                disabled={reportCapturing}
                aria-label="Report a problem"
              >
                <span className="tb-btn-icon">{ReportIcon}</span>
              </button>
            </Tooltip>

            {/* Split view — tile the content area into 1/2/3/4 independently-
                navigable panes. Left-click morphs the cursor tooltip into the
                menu (same useMorphPill the file grid uses on right-click).
                Hidden on the doc-viewer window and the top-level personal / nav
                pages (see SPLIT_HIDDEN_ROUTES), which have no tile-able content
                area. */}
            {!hideSplitButton && (
              <>
                <button
                  type="button"
                  className={`tb-btn tb-split-btn${splitPill.isMenuOpen ? ' is-open' : ''}${layout !== 'single' ? ' is-active' : ''}${activeCustomLayout ? ' has-name' : ' tb-btn-icon-only'}`}
                  onMouseMove={splitPill.handleMouseMove}
                  onMouseLeave={splitPill.handleMouseLeave}
                  onClick={splitPill.handleOpenMenu}
                  aria-haspopup="menu"
                  aria-expanded={splitPill.isMenuOpen}
                  aria-label="Split view"
                >
                  <span className="tb-btn-icon"><SplitLayoutIcon id={layout} /></span>
                  {/* When the active arrangement is a saved custom layout, name
                      it to the right of the glyph. */}
                  {activeCustomLayout && <span className="tb-split-btn-name">{activeCustomLayout.name}</span>}
                </button>
                {splitPill.node}
              </>
            )}

            {/* Account — to the right of the Split button. The avatar opens a
                dropdown (identity + status pills + "Open account"). */}
            <TbAccount user={session.user} onOpen={openAccount} onSignOut={logout} />
          </div>

          {/* Divider between the Theme control and the window controls.
              Dropped on macOS, where the native traffic lights (not our custom
              controls) terminate the bar. */}
          {!isMac && <div className="tb-divider" aria-hidden="true" />}
        </>
      )}

      {/* Window controls — minimize / maximize / close. Present on Windows &
          Linux (frameless) so the window stays controllable on every screen,
          including /auth. Hidden on macOS, which keeps its native traffic-light
          buttons at top-left (titleBarStyle:'hidden'). */}
      {!isMac && (
        <div className="tb-window-controls">
          <Tooltip content="Minimize">
            <button type="button" className="tb-win-btn" onClick={windowMinimize} aria-label="Minimize">
              {MinimizeGlyph}
            </button>
          </Tooltip>
          <Tooltip content={maximized ? 'Restore' : 'Maximize'}>
            <button type="button" className="tb-win-btn" onClick={windowToggleMaximize} aria-label={maximized ? 'Restore' : 'Maximize'}>
              {maximized ? RestoreGlyph : MaximizeGlyph}
            </button>
          </Tooltip>
          <Tooltip content="Close">
            <button type="button" className="tb-win-btn tb-win-close" onClick={windowClose} aria-label="Close">
              {CloseGlyph}
            </button>
          </Tooltip>
        </div>
      )}

    </div>
  );
}
