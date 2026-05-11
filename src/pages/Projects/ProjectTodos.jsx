import React from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import './ProjectScoped.css';

// Placeholder To-dos page. Same shape as ProjectFiles — relies on the
// SelectedProjectContext to know which project to operate on. Real to-do
// schema + UI ships in a later build.
export default function ProjectTodos() {
  const { selectedProject, loading } = useSelectedProject();

  if (loading && !selectedProject) {
    return <div className="project-scoped-loading">Loading project…</div>;
  }

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to see its to-dos.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  return (
    <div className="project-scoped-page">
      <header className="project-scoped-header">
        <h1 className="project-scoped-title">To-dos</h1>
        <p className="project-scoped-subtitle">
          To-dos for <strong>{selectedProject.name}</strong>.
        </p>
      </header>

      <section className="project-scoped-coming-soon">
        <h2>Task tracking coming next</h2>
        <p>
          A simple per-project task list lands in a later build. The schema
          (project_todos with title, status, assignee, due_at) hasn't been
          designed yet — open issue.
        </p>
      </section>
    </div>
  );
}
