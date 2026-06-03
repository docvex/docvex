import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useUpdates } from '../context/UpdatesContext';
import { useSplitView, SPLIT_LAYOUTS, isTriLayout, rotateTri } from '../context/SplitViewContext';
import { useReportProblem } from '../context/ReportProblemContext';
import Tooltip from './Tooltip';
import { useMorphPill } from './useMorphPill';
import { DEFAULT_STATUS_KEY, getStatusOption } from '../lib/userStatus';
import { PLAN } from '../lib/plan';
import { listMembers } from '../lib/projects';
import { localFolderApi, isElectronBranch } from '../lib/localFolder';
import {
  windowMinimize,
  windowToggleMaximize,
  windowClose,
  windowIsMaximized,
  onWindowMaximizedChanged,
} from '../lib/platform';
import brandIcon from '../favicon.ico';
import './TitleBar.css';

// Custom frameless title bar (Electron only — App.jsx gates it on isElectron).
// One bar holds the Theme control AND the window controls (minimize / maximize
// / close), so they live in the same section, separated by a divider.
// Documentation / Updates / Account moved to the launch hub's own sidebar. The
// whole bar is a drag region; every interactive element opts out with
// `-webkit-app-region: no-drag` (set in TitleBar.css).

const THEME_OPTIONS = [
  { pref: 'cream', label: 'White' },
  { pref: 'ink', label: 'Dark' },
  { pref: 'system', label: 'System' },
];

const ThemeIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
  </svg>
);
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
// "Report a problem" — speech bubble with an exclamation.
const ReportIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
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
// The user's chosen projects directory (set in the hub Settings) — the base
// dir for resolving a project's local folder, so the file count matches Files.
function readProjectsDir(uid) {
  try { return localStorage.getItem(`docvex.projectsDir.${uid || '_anonymous'}`) || ''; }
  catch { return ''; }
}

// One project-member avatar (real OAuth picture or coloured initial fallback).
function TbMemberAvatar({ member }) {
  const p = member.profile || {};
  const name = p.full_name || p.name || p.email || 'Member';
  const url = p.avatar_url || null;
  return (
    <span className="tb-member-avatar" style={url ? undefined : { background: avatarColor(member.user_id) }} title={name}>
      {url ? <img src={url} alt="" referrerPolicy="no-referrer" /> : name.charAt(0).toUpperCase()}
    </span>
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

// Title-bar account control — avatar (real OAuth picture or initial fallback)
// with a DECORATIVE status dot in the corner (not clickable, not hoverable —
// it just shows the current status colour). Clicking the avatar opens Account.
function TbAccount({ user, onOpen }) {
  const avatarUrl = user?.user_metadata?.avatar_url;
  const initial = (user?.email || '?').charAt(0).toUpperCase();
  const opt = getStatusOption(user?.user_metadata?.status || DEFAULT_STATUS_KEY);
  return (
    <button type="button" className="tb-account" onClick={onOpen} aria-label="Account">
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

// Rotate glyph for the "T" split's rotate tile.
const RotateCwGlyph = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
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

export default function TitleBar() {
  const { session } = useAuth();
  const { themePreference, setTheme } = useTheme();
  const { selectedProject } = useSelectedProject();
  const { hasUpdate, latestVersion, currentVersion } = useUpdates();
  const { layout, setLayout, customLayouts, addCustomLayout, removeCustomLayout } = useSplitView();
  // Inline "save current layout" affordance in the split menu: when armed it
  // swaps the "Save current…" button for a name field.
  const [savingLayout, setSavingLayout] = useState(false);
  const [layoutName, setLayoutName] = useState('');
  const { captureAndOpen: openReportProblem, capturing: reportCapturing } = useReportProblem();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // The launch hub lives at /launch — only there does the brand read "… | HUB".
  const onHub = pathname === '/launch';

  // Project member list (for the avatar stack next to the project name).
  // Fetched once per selected project; cleared on the hub / no selection.
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
            return (
              <button
                key={id}
                type="button"
                className={`tb-split-cell${active ? ' is-active' : ''}`}
                title={SPLIT_LAYOUTS[id].label}
                aria-label={SPLIT_LAYOUTS[id].label}
                aria-pressed={active}
                onClick={() => { if (id !== 'tri' || !triActive) setLayout(id); }}
              >
                <SplitLayoutIcon id={glyphId} size={22} />
              </button>
            );
          })}
          {/* Rotate tile — spins the active "T" one quarter-turn; inert for
              the non-T layouts (which have no rotation). */}
          <button
            type="button"
            className="tb-split-cell tb-split-cell-rotate"
            title={triActive ? 'Rotate the T split' : 'Rotate (T split only)'}
            aria-label="Rotate the T split"
            disabled={!triActive}
            onClick={() => setLayout(rotateTri(layout, 1))}
          >
            {RotateCwGlyph}
          </button>
        </div>

        <div className="tb-split-divider" role="separator" />

        <div className="tb-split-custom">
          <span className="tb-split-custom-title">Custom layouts</span>
          {customLayouts.length === 0 && !savingLayout && (
            <span className="tb-split-custom-empty">Save the current split to reuse it later.</span>
          )}
          {customLayouts.map((cl) => (
            <div key={cl.id} className="tb-split-custom-row">
              <button
                type="button"
                className={`tb-split-custom-apply${layout === cl.layout ? ' is-active' : ''}`}
                onClick={() => { setLayout(cl.layout); closeMenu(); }}
                title={`Apply “${cl.name}”`}
              >
                <span className="tb-split-custom-glyph"><SplitLayoutIcon id={cl.layout} size={16} /></span>
                <span className="tb-split-custom-name">{cl.name}</span>
              </button>
              <button
                type="button"
                className="tb-split-custom-del"
                title={`Delete “${cl.name}”`}
                aria-label={`Delete ${cl.name}`}
                onClick={() => removeCustomLayout(cl.id)}
              >
                {CloseGlyph}
              </button>
            </div>
          ))}

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
  const themePill = useMorphPill({
    hoverContent: 'Theme',
    placement: 'left',
    menuItems: THEME_OPTIONS.map((opt) => ({
      key: opt.pref,
      label: (
        <span className="tb-morph-row">
          <span className="tb-morph-row-label">{opt.label}</span>
          {themePreference === opt.pref && <span className="tb-morph-check">{CheckIcon}</span>}
        </span>
      ),
      onClick: () => setTheme(opt.pref),
    })),
  });

  // Reset the "save layout" input whenever the split menu closes, so it
  // reopens in its default (button, not armed input) state.
  useEffect(() => {
    if (!splitPill.isMenuOpen) { setSavingLayout(false); setLayoutName(''); }
  }, [splitPill.isMenuOpen]);

  // Track OS maximized state so the maximize⇄restore glyph stays correct.
  useEffect(() => {
    let alive = true;
    windowIsMaximized().then((v) => { if (alive) setMaximized(!!v); });
    const off = onWindowMaximizedChanged((v) => setMaximized(!!v));
    return () => { alive = false; off?.(); };
  }, []);

  const signedIn = !!session;
  // Semver bump of the available update, used to colour the pill the same way
  // the Versions page colour-codes each release (major/minor/patch).
  const updateKind = hasUpdate ? bumpKind(currentVersion, latestVersion) : null;

  return (
    <div className="tb-bar">
      {/* Brand on the left — "DOCVEX", with a "| HUB" suffix on the launch hub.
          When a project is selected, its name renders after a divider as a
          clickable chip that opens the project's Overview (Personal → Projects
          → [project], i.e. /projects/:id). */}
      <div className="tb-brand">
        {/* Icon + DOCVEX — plain, non-interactive text (with a "| HUB" suffix
            on the launch hub). */}
        {onHub ? (
          // "DOCVEX | HUB" — the divider and HUB live INSIDE the static span so
          // the flex `gap` gives symmetric spacing on both sides of the "|".
          <span className="tb-brand-static">
            <img src={brandIcon} alt="" className="tb-brand-icon" />
            <span className="tb-brand-name">DOCVEX</span>
            <span className="tb-brand-sep" aria-hidden="true">|</span>
            <span className="tb-brand-suffix">HUB</span>
          </span>
        ) : (
          <span className="tb-brand-static">
            <img src={brandIcon} alt="" className="tb-brand-icon" />
            <span className="tb-brand-name">DOCVEX</span>
          </span>
        )}
        {/* Version pill — to the right of the app name. When a newer version
            is available it shows "Update · v<latest> · <kind>", colour-coded
            by the semver bump (major/minor/patch) to match the Versions page;
            the dot pulses. When up to date it shows the running version in a
            calm gray static gradient with no pulse. Clicking opens the
            Versions page. Hidden on the launch hub. */}
        {!onHub && signedIn && (hasUpdate ? (
          <Tooltip content={latestVersion ? `Update available — v${latestVersion}${updateKind ? ` (${updateKind})` : ''}` : 'Update available'}>
            <button
              type="button"
              className={`tb-update-badge${updateKind ? ` is-${updateKind}` : ''}`}
              onClick={() => navigate('/updates')}
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
        ) : (
          <Tooltip content={currentVersion ? `You're up to date — v${currentVersion}` : 'Up to date'}>
            <button
              type="button"
              className="tb-update-badge is-uptodate"
              onClick={() => navigate('/updates')}
              aria-label={currentVersion ? `Up to date, version ${currentVersion}. View versions.` : 'Up to date'}
            >
              <span className="tb-update-dot" aria-hidden="true" />
              <span>{currentVersion ? `Up to date · v${currentVersion}` : 'Up to date'}</span>
            </button>
          </Tooltip>
        ))}
        {!onHub && signedIn && selectedProject && (
          <>
            <span className="tb-brand-sep" aria-hidden="true">|</span>
            <button
              type="button"
              className="tb-project-name"
              /* `fromTopbar` tells the Overview to drop its "All projects"
                 back-link — opening the project from the topbar is staying
                 inside the current workspace, not drilling in from the list. */
              onClick={() => navigate(`/projects/${selectedProject.id}`, { state: { fromTopbar: true } })}
              title={`Open ${selectedProject.name}`}
            >
              {selectedProject.name}
            </button>
          </>
        )}
      </div>

      {/* Project meta next to the name: member avatars (max 5, +N) · files
          count · usage bars, dot-separated. Only with a project selected and
          off the hub. */}
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
                Hidden on the launch hub, which has no tile-able content area. */}
            {!onHub && (
              <>
                <button
                  type="button"
                  className={`tb-btn tb-btn-icon-only${splitPill.isMenuOpen ? ' is-open' : ''}${layout !== 'single' ? ' is-active' : ''}`}
                  onMouseMove={splitPill.handleMouseMove}
                  onMouseLeave={splitPill.handleMouseLeave}
                  onClick={splitPill.handleOpenMenu}
                  aria-haspopup="menu"
                  aria-expanded={splitPill.isMenuOpen}
                  aria-label="Split view"
                >
                  <span className="tb-btn-icon"><SplitLayoutIcon id={layout} /></span>
                </button>
                {splitPill.node}
              </>
            )}

            {/* Theme — icon-only trigger; the menu (White / Dark / System)
                morphs out of the cursor tooltip on left-click. */}
            <button
              type="button"
              className={`tb-btn tb-btn-icon-only${themePill.isMenuOpen ? ' is-open' : ''}`}
              onMouseMove={themePill.handleMouseMove}
              onMouseLeave={themePill.handleMouseLeave}
              onClick={themePill.handleOpenMenu}
              aria-haspopup="menu"
              aria-expanded={themePill.isMenuOpen}
              aria-label="Theme"
            >
              <span className="tb-btn-icon">{ThemeIcon}</span>
            </button>
            {themePill.node}

            {/* Account — to the right of the Theme button (replaced the status
                dot). The avatar opens the Account page. */}
            <Tooltip content={`${getDisplayName(session.user)} · ${PLAN.tier}`}>
              <TbAccount user={session.user} onOpen={() => navigate('/account')} />
            </Tooltip>
          </div>

          {/* Divider between the Theme control and the window controls. */}
          <div className="tb-divider" aria-hidden="true" />
        </>
      )}

      {/* Window controls — always present so the frameless window stays
          controllable on every screen, including /auth. */}
      <div className="tb-window-controls">
        <button type="button" className="tb-win-btn" onClick={windowMinimize} aria-label="Minimize" title="Minimize">
          {MinimizeGlyph}
        </button>
        <button type="button" className="tb-win-btn" onClick={windowToggleMaximize} aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore' : 'Maximize'}>
          {maximized ? RestoreGlyph : MaximizeGlyph}
        </button>
        <button type="button" className="tb-win-btn tb-win-close" onClick={windowClose} aria-label="Close" title="Close">
          {CloseGlyph}
        </button>
      </div>

    </div>
  );
}
