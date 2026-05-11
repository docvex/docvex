import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listMyProjects } from '../../lib/projects';
import './ProjectList.css';

// Inline SVG per the CLAUDE.md convention. Matching the stroke icons used in
// Sidebar.jsx — width 18px to fit the card header alongside the title.
const PlusIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const UsersIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

// Empty state when the user is in zero projects. Same CTA as the header so
// there's nothing to learn — first thing visible is "make one".
function EmptyState() {
  return (
    <div className="projects-empty">
      <h2>No projects yet</h2>
      <p>Projects are how you share files and notes with collaborators.</p>
      <Link to="/projects/new" className="projects-cta">
        {PlusIcon} Create your first project
      </Link>
    </div>
  );
}

// Clicking a card navigates to the per-project dashboard but no longer
// auto-selects the project as "what I'm working in" — selection is an
// explicit action via the inline picker in the sidebar's Projects section
// (state machine driven by SelectedProjectContext.pickerOpen). Keeps the
// browse-vs-switch distinction clean.
function ProjectCard({ project }) {
  return (
    <Link to={`/projects/${project.id}`} className="project-card">
      <div className="project-card-header">
        <h3 className="project-card-name">{project.name}</h3>
        <span className={`project-card-role role-${project.role}`}>{project.role}</span>
      </div>
      {project.description ? (
        <p className="project-card-description">{project.description}</p>
      ) : (
        <p className="project-card-description project-card-description-empty">
          No description.
        </p>
      )}
      <div className="project-card-meta">
        <span className="project-card-meta-item">
          {UsersIcon}
          <span>—</span>
          {/* Member count comes in step 3 when ProjectDashboard surfaces it;
              keeping the slot here so the card height doesn't jump later. */}
        </span>
      </div>
    </Link>
  );
}

export default function ProjectList() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await listMyProjects();
      if (cancelled) return;
      setProjects(data);
      setError(error);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="projects-page">
      <header className="projects-header">
        <div>
          <h1 className="projects-title">Projects</h1>
          <p className="projects-subtitle">
            Workspaces you can share with collaborators.
          </p>
        </div>
        <Link to="/projects/new" className="projects-cta">
          {PlusIcon} New project
        </Link>
      </header>

      {loading && <div className="projects-loading">Loading projects…</div>}

      {error && (
        <div className="projects-error">
          Couldn't load projects: {error.message}
        </div>
      )}

      {!loading && !error && projects.length === 0 && <EmptyState />}

      {!loading && projects.length > 0 && (
        <section className="projects-grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </section>
      )}
    </div>
  );
}
