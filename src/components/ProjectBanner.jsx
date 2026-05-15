import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelectedProject } from '../context/SelectedProjectContext';
import Tooltip from './Tooltip';
import './ProjectBanner.css';

// Tiny indigo pill at the top of the page that reads "working in <project>".
// Clicking the pill navigates to the project's Overview (Personal → Projects
// → [selected project]) — the canonical "this is the project I'm in" page.
//
// Mounted by AppShell on project-scoped routes (Files, To-dos, the per-
// project dashboard). Hidden everywhere else.
export default function ProjectBanner() {
  const { selectedProject, loading } = useSelectedProject();
  const navigate = useNavigate();

  // Don't render the pill at all while we're hydrating — otherwise a flash
  // of "working in undefined" / empty pill appears for one frame.
  if (loading || !selectedProject) return null;

  return (
    <Tooltip content={`Go to ${selectedProject.name} overview`}>
      <button
        type="button"
        className="project-banner-pill"
        onClick={() => navigate(`/projects/${selectedProject.id}`)}
      >
        <span className="project-banner-pill-prefix">working in</span>
        <span className="project-banner-pill-name">{selectedProject.name}</span>
      </button>
    </Tooltip>
  );
}
