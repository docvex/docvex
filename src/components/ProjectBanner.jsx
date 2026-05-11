import React from 'react';
import { useSelectedProject } from '../context/SelectedProjectContext';
import './ProjectBanner.css';

// Tiny indigo pill at the top of the page that reads "working in <project>".
// Clicking the pill toggles the project-picker panel — the trigger from the
// banner is the same as the sidebar's trigger, so anywhere the user is in
// the project subtree they can switch with one click.
//
// Mounted by AppShell on project-scoped routes (Files, To-dos, the per-
// project dashboard). Hidden everywhere else.
export default function ProjectBanner() {
  const { selectedProject, loading, togglePicker } = useSelectedProject();

  // Don't render the pill at all while we're hydrating — otherwise a flash
  // of "working in undefined" / empty pill appears for one frame.
  if (loading || !selectedProject) return null;

  return (
    <button
      type="button"
      className="project-banner-pill"
      onClick={togglePicker}
      title="Switch project"
    >
      <span className="project-banner-pill-prefix">working in</span>
      <span className="project-banner-pill-name">{selectedProject.name}</span>
    </button>
  );
}
