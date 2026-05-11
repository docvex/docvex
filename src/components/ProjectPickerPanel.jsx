import React, { useEffect, useState } from 'react';
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

const NoProjectIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
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
  } = useSelectedProject();

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

  const onPick = (id) => {
    selectProject(id);
    closePicker();
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
                onClick={() => onPick(p.id)}
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
              onClick={() => { clearSelection(); closePicker(); }}
              title="Work without a project selected"
            >
              {NoProjectIcon}
              <span>No project</span>
            </button>
          </footer>
        )}
      </aside>
    </>
  );
}
