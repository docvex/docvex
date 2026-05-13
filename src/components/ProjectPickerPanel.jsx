import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { listMyProjects } from '../lib/projects';
import './ProjectPickerPanel.css';

// Inline icons (match the rest of the codebase's stroke-icon convention).
const CloseIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

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

  const [projects, setProjects] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);

  // Lazy-load on every open so a project created in another window/page
  // shows up without a manual refresh. The list is small (≤ hundreds of
  // rows in practice) so re-fetching is cheap.
  useEffect(() => {
    if (!pickerOpen || !session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listMyProjects().then(({ data, error }) => {
      if (cancelled) return;
      setProjects(data || []);
      setError(error);
      setLoading(false);
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
    beginSwitch(project.name);
    selectProject(project.id);
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
    beginSwitch(null);
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
          <button
            type="button"
            className="project-picker-panel-close"
            onClick={closePicker}
            aria-label="Close project picker"
            title="Close"
          >
            {CloseIcon}
          </button>
        </header>
        <ul className="project-picker-panel-list">
          {loading && (
            <li className="project-picker-panel-state">Loading…</li>
          )}
          {!loading && error && (
            <li className="project-picker-panel-state project-picker-panel-state-error">
              {error.message}
            </li>
          )}
          {!loading && !error && projects.length === 0 && (
            <li className="project-picker-panel-state">No projects yet</li>
          )}
          {!loading && projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`project-picker-panel-row${p.id === selectedProjectId ? ' is-current' : ''}`}
                onClick={() => onPick(p)}
                title={p.id === selectedProjectId ? 'Currently selected' : `Switch to ${p.name}`}
              >
                {p.name}
              </button>
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
            <button
              type="button"
              className="project-picker-panel-clear"
              onClick={onClear}
              title="Work without a project selected"
            >
              Select no project
            </button>
          </footer>
        )}
      </aside>
    </>
  );
}
