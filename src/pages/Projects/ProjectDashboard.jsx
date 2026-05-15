import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useProject } from '../../context/ProjectContext';
import ProjectDashboardSkeleton from '../../components/ProjectDashboardSkeleton';
import TeamTree from './TeamTree';
import './ProjectDashboard.css';

// Project Dashboard — the "working surface" for /projects/:id/dashboard.
// Reached from the Projects sidebar's Dashboard sub-item. Today it hosts
// two tabs: Members (a visual team tree, ordered left→right by permission
// strength) and Activity (placeholder for an upcoming feed).
//
// Project metadata + member management live on the Overview page
// (/projects/:id) — reached by clicking a card in the Projects list. The
// split keeps each page focused on one job; this one is for getting work
// done, the overview is for managing who's on the project.
//
// Auto-selecting the project into SelectedProjectContext happens at the
// ProjectShell level — see <ProjectAutoSelect/> in App.jsx.
export default function ProjectDashboard() {
  const { project, role, members, customRoles, loading, error } = useProject();
  // Members is the default tab — the team tree gives the page immediate
  // visual content, vs. Activity which is currently just a placeholder.
  const [activeTab, setActiveTab] = useState('members');

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

  if (!loading && !project) {
    return (
      <div className="project-dashboard">
        <div className="project-dashboard-error">
          Project not found.
          <Link to="/projects" className="project-dashboard-back-link">Back to projects</Link>
        </div>
      </div>
    );
  }

  const tabs = [
    { id: 'members', label: 'Members', count: members.length },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <div className="project-dashboard">
      <header className="project-dashboard-header">
        {/* Static title renders immediately — nothing about "Dashboard" is
            async, so it should never flash a skeleton. The role pill IS
            async (depends on members fetch); it gets a small placeholder
            until `role` resolves so the horizontal space next to the
            title doesn't reflow when the real pill drops in. */}
        <div className="project-dashboard-title-row">
          <h1 className="project-dashboard-title">Dashboard</h1>
          {role
            ? <span className={`project-dashboard-role role-${role}`}>{role}</span>
            : <span className="skel-bar skel-dash-role" aria-hidden="true" />}
        </div>
      </header>

      {loading ? (
        <ProjectDashboardSkeleton />
      ) : (
        <>
          {/* Tab bar — same underline pattern as ProjectOverview. role="tablist"
              so screen readers announce the relationship; each button is a tab
              whose pressed state mirrors activeTab. */}
          <div className="project-tabs" role="tablist" aria-label="Dashboard sections">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={activeTab === t.id}
                className={`project-tab ${activeTab === t.id ? 'is-active' : ''}`}
                onClick={() => setActiveTab(t.id)}
              >
                <span>{t.label}</span>
                {typeof t.count === 'number' && (
                  <span className="project-tab-count">{t.count}</span>
                )}
              </button>
            ))}
          </div>

          {activeTab === 'members' && (
            <TeamTree members={members} customRoles={customRoles} />
          )}

          {activeTab === 'activity' && (
            <section className="project-dashboard-card">
              <div className="project-dashboard-card-header">
                <h2 className="project-dashboard-card-title">Activity</h2>
              </div>
              <div className="project-dashboard-empty">
                Activity feed coming soon.
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
