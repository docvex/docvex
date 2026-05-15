import React from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
import './ProjectScoped.css';

// Placeholder Automate page. Per-project workflows / triggers — "when X
// happens, do Y" rules scoped to this project. Real workflow builder +
// the underlying triggers/actions schema ship in a later build.
export default function ProjectAutomate() {
  const { selectedProject, loading } = useSelectedProject();

  if (loading && !selectedProject) {
    return <ProjectScopedSkeleton />;
  }

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to build automations for it.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  return (
    <div className="project-scoped-page">
      <header className="project-scoped-header">
        <h1 className="project-scoped-title">Automate</h1>
        <p className="project-scoped-subtitle">
          Workflows for <strong>{selectedProject.name}</strong>.
        </p>
      </header>

      <section className="project-scoped-coming-soon">
        <h2>Per-project automation coming next</h2>
        <p>
          Build "when X happens, do Y" workflows for this project — auto-tag
          uploaded files, ping the team when deadlines approach, route
          incoming documents to the right folder. The triggers/actions
          schema ships in a later build.
        </p>
      </section>
    </div>
  );
}
