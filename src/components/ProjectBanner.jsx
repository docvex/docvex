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

  // selectedProject carries `.role` (owner / admin / member / viewer)
  // from getProject() — the caller's role on this project, joined in
  // from project_members. Rendered as a small pill after "as" so the
  // banner reads "working in <project> as <role>". If the role isn't
  // available yet (very brief window during initial load) the
  // "as <pill>" suffix is omitted rather than rendered as a blank
  // pill.
  const role = selectedProject.role;

  return (
    <Tooltip content={`Go to ${selectedProject.name} overview`}>
      <button
        type="button"
        className="project-banner-pill"
        onClick={() => navigate(`/projects/${selectedProject.id}`)}
      >
        <span className="project-banner-pill-prefix">working in</span>
        <span className="project-banner-pill-name">{selectedProject.name}</span>
        {role && (
          <>
            <span className="project-banner-pill-prefix">as</span>
            <span className={`project-banner-role-pill role-${role}`}>
              {role}
            </span>
          </>
        )}
      </button>
    </Tooltip>
  );
}
