import React from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
import './ProjectScoped.css';

// Placeholder Chat page. Same shape as the other project-scoped pages
// (Files / Clients / To-dos) — relies on SelectedProjectContext to know
// which project the conversation belongs to. Real chat UI + the
// underlying messages schema ship in a later build.
export default function ProjectChat() {
  const { selectedProject, loading } = useSelectedProject();

  if (loading && !selectedProject) {
    return <ProjectScopedSkeleton />;
  }

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to start a conversation.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  return (
    <div className="project-scoped-page">
      <header className="project-scoped-header">
        <h1 className="project-scoped-title">Chat</h1>
        <p className="project-scoped-subtitle">
          Conversation for <strong>{selectedProject.name}</strong>.
        </p>
      </header>

      <section className="project-scoped-coming-soon">
        <h2>Project chat coming next</h2>
        <p>
          A per-project conversation surface — ask the assistant about the
          files in this project, get summaries, draft follow-ups. The
          messages schema and the AI plumbing ship in a later build.
        </p>
      </section>
    </div>
  );
}
