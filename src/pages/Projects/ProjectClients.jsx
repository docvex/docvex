import React from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
import './ProjectScoped.css';

// Placeholder Clients page. Same shape as ProjectFiles / ProjectTodos —
// relies on SelectedProjectContext to know which project to operate on.
// Real client-record schema + CRUD UI ships in a later build; the schema
// (project_clients with name, contact_email, phone, company, notes,
// archived_at, owner-only RLS) hasn't been designed yet — open issue.
export default function ProjectClients() {
  const { selectedProject, loading } = useSelectedProject();

  if (loading && !selectedProject) {
    return <ProjectScopedSkeleton />;
  }

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to see its clients.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  return (
    <div className="project-scoped-page">
      <header className="project-scoped-header">
        <h1 className="project-scoped-title">Clients</h1>
        <p className="project-scoped-subtitle">
          Clients for <strong>{selectedProject.name}</strong>.
        </p>
      </header>

      <section className="project-scoped-coming-soon">
        <h2>Client records coming next</h2>
        <p>
          A contacts-style list keyed to this project — name, company,
          contact email, phone, free-form notes. The schema
          (<code>project_clients</code> with the owner-only RLS pattern
          the other project tables use) ships in a later build.
        </p>
      </section>
    </div>
  );
}
