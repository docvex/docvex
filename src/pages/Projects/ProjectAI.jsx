import React from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import './ProjectScoped.css';
import './ProjectAI.css';

// AI — the project's AI tab. The previous AI hub (Command Center landing +
// Generate / Review / Research / Automate / Compliance tools) was removed; the
// tab is intentionally empty. The old surface lives in git history, and the
// `ProjectAITools.jsx` / `aiHub.jsx` modules remain on disk (orphaned) if it's
// ever rebuilt.
export default function ProjectAI() {
  const { selectedProject, loading } = useSelectedProject();

  if (loading && !selectedProject) return null;

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to use the AI tools.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  return <div className="ai-hub" />;
}
