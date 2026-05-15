import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { listMyProjects, PROJECTS_CHANGED_EVENT } from '../lib/projects';
import { sortProjectsByRecent, getMostRecentProjectId } from '../lib/recentProjects';
import Tooltip from './Tooltip';
import './ProjectPickerPanel.css';

// Cached project count, keyed per signed-in user, so the skeleton on the next
// open matches what the user is about to see (no count-shift on hand-off).
// The cache is written after every successful listMyProjects() resolution.
// First-ever open returns null and the skeleton falls back to a small default.
// localStorage can throw in private-browsing / quota-exceeded modes — the
// reads/writes swallow those errors and the skeleton just uses the default.
const PROJECTS_COUNT_KEY = (userId) => `docvex:projects-count:${userId}`;
const DEFAULT_SKELETON_COUNT = 4;

function readCachedProjectsCount(userId) {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(PROJECTS_COUNT_KEY(userId));
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function writeCachedProjectsCount(userId, count) {
  if (!userId) return;
  try {
    localStorage.setItem(PROJECTS_COUNT_KEY(userId), String(count));
  } catch { /* see read above */ }
}

// Inline icons (match the rest of the codebase's stroke-icon convention).
const CloseIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

// Two-person silhouette for the per-row members count — same glyph used
// by .project-card-meta in ProjectList so the "N members" affordance reads
// the same on both surfaces.
const UsersIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);

// Pathname predicate: are we currently inside a "project tab" — one of
// the Projects-section sub-routes that's actually scoped to a specific
// project (Dashboard / Files / Clients / To-dos)? The SwitchProjectLoader
// only fires when this is true, so picking a project from a personal tab
// (Activity, Updates, Notifications, Account, project list/overview)
// silently swaps the sidebar's "working in" target without flashing the
// full-screen switching overlay.
function isProjectScopedPath(pathname) {
  if (pathname === '/files'    || pathname.startsWith('/files/'))    return true;
  if (pathname === '/clients'  || pathname.startsWith('/clients/'))  return true;
  if (pathname === '/todos'    || pathname.startsWith('/todos/'))    return true;
  if (pathname === '/chat'     || pathname.startsWith('/chat/'))     return true;
  if (pathname === '/generate' || pathname.startsWith('/generate/')) return true;
  if (pathname === '/automate' || pathname.startsWith('/automate/')) return true;
  // /projects/:id/dashboard — anything ending in /dashboard under /projects/
  return /^\/projects\/[^/]+\/dashboard\/?$/.test(pathname);
}

// Secondary nav column that slides out from behind the sidebar when the
// user opens the project picker. Owns its own fetch + Esc handling; the
// sidebar's only job is to call openPicker()/closePicker() via
// SelectedProjectContext. Header reads "ALL PROJECTS" in muted uppercase;
// body is the list of projects the caller is a member of.
export default function ProjectPickerPanel() {
  const { session } = useAuth();
  const {
    pickerOpen,
    closePicker,
    selectProject,
    clearSelection,
    selectedProjectId,
    beginSwitch,
  } = useSelectedProject();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [projects, setProjects] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);

  // Sort projects by per-user recency. Pinned to the (userId, projects, pickerOpen)
  // tuple so the order refreshes every time the picker reopens — the recency
  // map may have been stamped by a navigation that happened while the panel
  // was closed. pickerOpen as a dep is intentional: ordering changes are
  // user-visible only on open, so we recompute exactly then.
  const userId = session?.user?.id ?? null;
  // The pickerOpen dependency is what triggers a re-sort on each open — its
  // value is read by the hook even though we don't reference it directly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const orderedProjects = useMemo(
    () => sortProjectsByRecent(userId, projects),
    [userId, projects, pickerOpen],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mostRecentId = useMemo(
    () => getMostRecentProjectId(userId),
    [userId, projects, pickerOpen],
  );

  // Cache the project list across panel opens — the panel opens often (every
  // click on the trigger) and re-fetching on every open is wasteful. The
  // hasFetchedRef flips back to false when:
  //   - a window CustomEvent (PROJECTS_CHANGED_EVENT) fires from a mutation
  //     site (create/delete/leave), so the next open refetches authoritatively
  //   - the session changes (sign-out/sign-in) — different user, different list
  //
  // The panel is mounted unconditionally by AppShell (its lifetime equals the
  // app's lifetime), so component-local state is sufficient — no need for a
  // context.
  const hasFetchedRef = useRef(false);

  // Invalidate the cache when anyone mutates the user's projects list.
  // Refetch is deferred to the NEXT open — invalidating doesn't force the
  // panel to refetch while closed.
  useEffect(() => {
    const onChanged = () => { hasFetchedRef.current = false; };
    window.addEventListener(PROJECTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, onChanged);
  }, []);

  // Reset on session change — switching users means the cached list belongs
  // to the wrong account.
  useEffect(() => { hasFetchedRef.current = false; }, [session?.user?.id]);

  useEffect(() => {
    if (!pickerOpen || !session) return;
    if (hasFetchedRef.current) return; // cache hit — render existing `projects`
    let cancelled = false;
    setLoading(true);
    setError(null);
    listMyProjects().then(({ data, error }) => {
      if (cancelled) return;
      setProjects(data || []);
      setError(error);
      setLoading(false);
      if (!error) {
        hasFetchedRef.current = true;
        // Cache the count so the next open's skeleton matches the real list
        // length — keeps the row rhythm steady when the user reopens the
        // picker and the fetch is still in flight.
        writeCachedProjectsCount(session?.user?.id, (data || []).length);
      }
    });
    return () => { cancelled = true; };
  }, [pickerOpen, session]);

  // Esc closes the panel. Listener only attaches while open so unrelated
  // key events don't pay the cost.
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') closePicker(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen, closePicker]);

  // Pick a project from the list. If we're currently inside any project's URL
  // subtree (Overview, Dashboard, Files, …), nudge the URL to the new project
  // so the URL-driven <ProjectAutoSelect/> doesn't immediately revert our
  // state change. If we're somewhere unrelated (Activity, Notifications, …),
  // leave the URL alone — the user's context is non-project and they
  // probably just want to swap the sidebar's "working in" target without
  // being teleported.
  const onPick = (project) => {
    // No-op when the row is already the active selection — clicking the
    // current project shouldn't trigger a loader or a reroute.
    if (project.id === selectedProjectId) {
      closePicker();
      return;
    }
    // beginSwitch BEFORE any state/route change so the overlay is in place
    // before React renders the transition's intermediate frames. The name
    // surfaces as "Switching to <name>" in the loader subtitle.
    //
    // Skip the overlay entirely when the user is on a "personal" tab
    // (Activity, Updates, Notifications, Account, project list/overview):
    // in that case the picker is just swapping the sidebar's working-in
    // target and the full-screen loader would feel out of place. The
    // overlay fires only when switching between two project-scoped pages
    // — Dashboard / Files / Clients / To-dos.
    if (isProjectScopedPath(pathname)) {
      beginSwitch(project.name);
    }
    // Hand the full row to SelectedProjectContext so it skips the redundant
    // getProject() round-trip — we already have everything it needs. The
    // SwitchProjectLoader's min-visible-time floor (preserved separately)
    // still keeps the transition reading as deliberate.
    selectProject(project.id, project);
    closePicker();
    // Always land on the new project's Dashboard — that's the "working
    // surface" (recent files + activity) and is the most useful place to
    // start. Previously we preserved the user's prior subroute, but that
    // meant switching from /projects/foo (Overview) bounced to
    // /projects/bar (Overview, a static info page) instead of bar's
    // actual workbench. Dashboard is the right default landing for a
    // freshly-picked project.
    navigate(`/projects/${project.id}/dashboard`);
  };

  // "Select no project" always lands the user on Activity (/) — the
  // canonical no-project home. This both (a) gives a deliberate
  // destination instead of leaving the user staring at a page that no
  // longer has a project context, and (b) sidesteps the URL-driven auto-
  // select loop entirely: if we just cleared state but stayed at
  // /projects/foo, <ProjectAutoSelect/> would re-pick foo on the next
  // render. No name passed so the loader uses its generic copy.
  const onClear = () => {
    // Same gate as onPick — only show the overlay if we're abandoning a
    // project-scoped page. Clearing from a personal tab leaves the page
    // we're already on, so the overlay has nothing meaningful to mask.
    if (isProjectScopedPath(pathname)) {
      beginSwitch(null);
    }
    clearSelection();
    closePicker();
    navigate('/');
  };

  return (
    <>
      {pickerOpen && (
        <div
          className="project-picker-panel-backdrop"
          onClick={closePicker}
          aria-hidden="true"
        />
      )}
      <aside
        className={`project-picker-panel${pickerOpen ? ' is-open' : ''}`}
        aria-hidden={!pickerOpen}
        aria-label="Project picker"
      >
        <header className="project-picker-panel-header">
          <h2 className="project-picker-panel-title">All projects</h2>
          {/* Top-right close X — mirrors Esc / backdrop-click but gives the
              user a visible, mouse-only escape hatch right where they
              expect it on most modal-ish overlays. */}
          <Tooltip content="Close">
            <button
              type="button"
              className="project-picker-panel-close"
              onClick={closePicker}
              aria-label="Close project picker"
            >
              {CloseIcon}
            </button>
          </Tooltip>
        </header>
        <ul className="project-picker-panel-list">
          {loading && Array.from({
            // Per-user cache: the next open's skeleton renders the same number
            // of rows the user just saw. Falls back to DEFAULT_SKELETON_COUNT
            // on first-ever open (no cache yet) so we always show something.
            length: readCachedProjectsCount(session?.user?.id) ?? DEFAULT_SKELETON_COUNT,
          }).map((_, i) => (
            <li key={`skel-${i}`} className="project-picker-panel-skel-item" aria-hidden="true">
              <div className="skel-bar project-picker-panel-skel-row" />
            </li>
          ))}
          {!loading && error && (
            <li className="project-picker-panel-state project-picker-panel-state-error">
              {error.message}
            </li>
          )}
          {!loading && !error && projects.length === 0 && (
            <li className="project-picker-panel-state">No projects yet</li>
          )}
          {!loading && orderedProjects.map((p) => (
            <li key={p.id}>
              <Tooltip content={p.id === selectedProjectId ? 'Currently selected' : `Switch to ${p.name}`}>
                <button
                  type="button"
                  className={`project-picker-panel-row${p.id === selectedProjectId ? ' is-current' : ''}`}
                  onClick={() => onPick(p)}
                >
                  {/* Left column — project name on top, role pill + optional
                      "Most recent" pill stacked below. Gets the spare
                      horizontal room and ellipsizes long names. */}
                  <div className="project-picker-panel-row-main">
                    <span className="project-picker-panel-row-name">{p.name}</span>
                    <div className="project-picker-panel-row-tags">
                      {p.role && (
                        <span className={`project-picker-panel-row-role role-${p.role}`}>
                          {p.role}
                        </span>
                      )}
                      {p.id === mostRecentId && (
                        <span className="project-picker-panel-row-recent">Most recent</span>
                      )}
                    </div>
                  </div>
                  {/* Right column — members icon + count, vertically centered
                      against the whole row. Falls back to "—" when the row
                      doesn't carry a member_count (defensive; listMyProjects
                      always returns the embed count). */}
                  <span className="project-picker-panel-row-members" aria-label={
                    typeof p.member_count === 'number'
                      ? `${p.member_count} ${p.member_count === 1 ? 'member' : 'members'}`
                      : 'Members'
                  }>
                    {UsersIcon}
                    <span className="project-picker-panel-row-members-count">
                      {typeof p.member_count === 'number' ? p.member_count : '—'}
                    </span>
                  </span>
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
        {/* Clear-selection button — only meaningful when there IS a current
            selection. Clicking returns the user to the no-project state
            (sidebar shows "Select a project", Files/To-dos dim out, the
            "working in X" banner disappears) without picking a different
            project. */}
        {selectedProjectId && (
          <footer className="project-picker-panel-footer">
            <Tooltip content="Work without a project selected">
              <button
                type="button"
                className="project-picker-panel-clear"
                onClick={onClear}
              >
                Select no project
              </button>
            </Tooltip>
          </footer>
        )}
      </aside>
    </>
  );
}
