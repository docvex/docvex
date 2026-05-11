import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useProject } from '../../context/ProjectContext';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import './ProjectDashboard.css';

// Placeholder for step 2 of the build. Step 3 will fill in the full
// dashboard: editable description, member-count badge, recent activity, and
// sub-nav to Files / Members / Settings. For now it just confirms the
// ProjectContext is wired correctly so the create flow has a landing page.
export default function ProjectDashboard() {
  const { project, role, members, loading, error } = useProject();
  const { selectedProjectId, selectProject } = useSelectedProject();

  // Deep-linking to /projects/:id (back button, bookmark, OAuth resume)
  // should make this project the user's working project — otherwise the
  // sidebar's Projects section would stay empty even though the user is
  // clearly inside a project.
  useEffect(() => {
    if (project?.id && project.id !== selectedProjectId) {
      selectProject(project.id);
    }
  }, [project?.id, selectedProjectId, selectProject]);

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
        <Link to="/projects" className="project-dashboard-back">← All projects</Link>
        <div className="project-dashboard-title-row">
          <h1 className="project-dashboard-title">{project.name}</h1>
          <span className={`project-dashboard-role role-${role}`}>{role}</span>
        </div>
        {project.description && (
          <p className="project-dashboard-description">{project.description}</p>
        )}
      </header>

      <section className="project-dashboard-coming-soon">
        <h2>Members, Files, Settings — coming next</h2>
        <p>
          The full dashboard (member list, invites, file uploads, project
          settings) ships in step 3 of the build.
        </p>
        <p className="project-dashboard-stats">
          You're a {role} on this project. There {members.length === 1 ? 'is' : 'are'}{' '}
          {members.length} member{members.length === 1 ? '' : 's'}.
        </p>
      </section>
    </div>
  );
}
