import React from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import './ProjectScoped.css';

// Placeholder Generate page. AI-assisted document drafting surface keyed
// to the selected project (so the model has the case context). Real
// generation UI + prompts + the templates schema ship in a later build.
export default function ProjectGenerate() {
  const { selectedProject, loading } = useSelectedProject();

  if (loading && !selectedProject) {
    return null;
  }

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to generate documents for it.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  return (
    <div className="project-scoped-page">
      <header className="project-scoped-header">
        <h1 className="project-scoped-title">Generate</h1>
        <p className="project-scoped-subtitle">
          Draft new documents for <strong>{selectedProject.name}</strong>.
        </p>
      </header>

      <section className="project-scoped-coming-soon">
        <h2>AI document generation coming next</h2>
        <p>
          Generate briefs, motions, and client letters from the project's
          existing files — templates, prompts, and the per-project model
          context ship in a later build.
        </p>
      </section>
    </div>
  );
}
