import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useUpdates } from '../context/UpdatesContext';
import { useReportProblem } from '../context/ReportProblemContext';
import Tooltip, { useTooltip } from './Tooltip';
import FpsMeter from './FpsMeter';
import { useMorphPill } from './useMorphPill';
import { listMembers } from '../lib/projects';
import { localFolderApi, isElectronBranch } from '../lib/localFolder';
import { readProjectsDir } from '../lib/projectsDir';
import {
  isMac,
  windowMinimize,
  windowToggleMaximize,
  windowClose,
  windowIsMaximized,
  onWindowMaximizedChanged,
  windowIsFullscreen,
  onWindowFullscreenChanged,
} from '../lib/platform';

import brandIcon from '../favicon.ico';
import './TitleBar.css';

// Custom frameless title bar (Electron only — App.jsx gates it on isElectron).
// One bar holds the Theme control AND the window controls (minimize / maximize
// / close), so they live in the same section, separated by a divider. The
// account control + Versions + Documentation live in the Sidebar. The whole
// bar is a drag region; every interactive element opts
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
  const { selectedProject } = useSelectedProject();
  const { hasUpdate, latestVersion, currentVersion } = useUpdates();
  const { captureAndOpen: openReportProblem, capturing: reportCapturing } = useReportProblem();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  // The doc-viewer is a secondary window (boots at /doc-viewer); it's a plain
  // file viewer, so it hides the project chrome and shows the open file's name
  // (carried in the boot query string) in its place.
  const onDocViewer = pathname === '/doc-viewer';
  const docViewerFileName = onDocViewer
    ? (new URLSearchParams(search).get('name') || 'Document')
    : null;
  // The Hub is the projects launcher (/projects). There the brand reads
  // "DOCVEX | HUB" and ALL selected-project chrome (name chip + member avatars
  // + file count + usage meters) is hidden — you're between projects, not in one.
  const onHub = pathname === '/projects';
  // The signed-out screen (/auth). There the bar goes transparent and drops the
  // brand mark so the auth window reads as one full-bleed surface with just the
  // window controls floating on top.
  const onAuth = pathname === '/auth';

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
      {/* Centre slot for the doc-viewer window — the office "Reconstruction"
          pill portals into this (by id) so it sits centred in the title bar. */}
      {onDocViewer && <div id="tb-docview-center" className="tb-docview-center" />}
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
            {onDocViewer && (
              <>
                <span className="tb-brand-sep tb-brand-sep--solid" aria-hidden="true">-</span>
                <span className="tb-brand-suffix tb-brand-suffix--solid">FILE VIEWER</span>
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
        {/* Doc-viewer window: show the open file's name in place of the
            project chrome (name chip + file count + usage meters). */}
        {onDocViewer && docViewerFileName && (
          <>
            <span className="tb-brand-sep" aria-hidden="true">|</span>
            <span className="tb-docviewer-file" title={docViewerFileName}>{docViewerFileName}</span>
          </>
        )}
        {/* Project name — plain, non-interactive text. The clickable chip that
            opened the project Overview moved to the sidebar's Project section
            (above Files) — see Sidebar.jsx; here it's just a label. */}
        {!onHub && !onDocViewer && signedIn && selectedProject && (
          <>
            <span className="tb-brand-sep" aria-hidden="true">|</span>
            <span className="tb-project-name" title={selectedProject.name}>
              {selectedProject.name}
            </span>
          </>
        )}
      </div>

      {/* Project meta next to the name: member avatars (max 5, +N) · files
          count · usage bars, dot-separated. Only with a project selected and
          not on the Hub. */}
      {!onHub && !onDocViewer && signedIn && selectedProject && (
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
                  {usageMeters.map(({ key, ...m }) => (
                    <TbUsageMeter key={key} {...m} />
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
            {/* The account control moved to the bottom of the Sidebar. */}
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
