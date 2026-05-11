import React from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import './ProjectScoped.css';

// Placeholder Files page. Step 2 wires the route + selection plumbing; the
// actual upload UI ships in build #2 (storage bucket policies are already
// in place — see supabase/migrations/001_projects.sql `storage.objects`
// policies at the bottom).
export default function ProjectFiles() {
  const { selectedProject, loading } = useSelectedProject();

  if (loading && !selectedProject) {
    return <div className="project-scoped-loading">Loading project…</div>;
  }

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to see its files.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  return (
    <div className="project-scoped-page">
      <header className="project-scoped-header">
        <h1 className="project-scoped-title">Files</h1>
        <p className="project-scoped-subtitle">
          Files for <strong>{selectedProject.name}</strong>.
        </p>
      </header>

      <section className="project-scoped-coming-soon">
        <h2>Uploads coming next</h2>
        <p>
          The storage bucket and RLS policies (path convention{' '}
          <code>{`{project_id}/{file_id}/{filename}`}</code>) are already in place;
          the upload UI ships in build #2.
        </p>
      </section>
    </div>
  );
}
