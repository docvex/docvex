import React from 'react';
import { Link } from 'react-router-dom';
import { useProject } from '../../context/ProjectContext';
import './ProjectDashboard.css';

// Project Dashboard — the "working surface" for /projects/:id/dashboard.
// Reached from the Projects sidebar's Dashboard sub-item. Focus: the user's
// recent activity inside this project (currently just files; will grow to
// include todos, activity feed, etc.).
//
// Project metadata + member management live on the Overview page
// (/projects/:id) — reached by clicking a card in the Projects list. The
// split keeps each page focused on one job; this one is for getting work
// done, the overview is for managing who's on the project.
//
// Auto-selecting the project into SelectedProjectContext happens at the
// ProjectShell level — see <ProjectAutoSelect/> in App.jsx.
export default function ProjectDashboard() {
  const { project, role, loading, error } = useProject();

  if (loading) {
    return (
      <div className="project-dashboard">
        <div className="project-dashboard-loading">Loading project…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="project-dashboard">
        <div className="project-dashboard-error">
          {error.message}
          <Link to="/projects" className="project-dashboard-back-link">Back to projects</Link>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="project-dashboard">
        <div className="project-dashboard-error">
          Project not found.
          <Link to="/projects" className="project-dashboard-back-link">Back to projects</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="project-dashboard">
      <header className="project-dashboard-header">
        {/* No back link here — the "working in" banner above already names
            the project and clicking it opens the picker, and the sidebar
            still shows which project we're in. The Overview is one click
            away via the Projects sidebar or the banner. */}
        <div className="project-dashboard-title-row">
          <h1 className="project-dashboard-title">Dashboard</h1>
          <span className={`project-dashboard-role role-${role}`}>{role}</span>
        </div>
      </header>

      <section className="project-dashboard-card">
        <div className="project-dashboard-card-header">
          <h2 className="project-dashboard-card-title">Recent files</h2>
        </div>
        <p className="project-dashboard-card-subtitle">
          Latest uploads in this project.
        </p>
        <div className="project-dashboard-empty">
          No files yet. Uploads will appear here once the file UI ships.
        </div>
      </section>
    </div>
  );
}
