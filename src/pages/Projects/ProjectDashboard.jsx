import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useProject } from '../../context/ProjectContext';
import TeamTree from './TeamTree';
import './ProjectDashboard.css';

// Crossfade window between the loading spinner and the team tree on the
// Members tab. Has to match the CSS transition duration on
// .project-dashboard-members-loading.is-fading-out — keep these two in
// sync if you tweak the feel. 250ms is short enough to feel instant
// but long enough that the eye reads "the spinner left, the tree
// arrived" instead of "something flashed".
const MEMBERS_FADE_MS = 250;

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

  // Tracks the spinner's mounted lifetime separately from `loading` so
  // we can keep it on the page during its fade-out animation after the
  // fetch resolves. While loading is true the spinner is mounted at
  // full opacity. When loading flips false we apply the fading-out
  // class (CSS transitions opacity to 0), then unmount the spinner
  // after MEMBERS_FADE_MS. The tree mounts immediately when loading
  // resolves and fades in via its own keyframes — the two animations
  // overlap, producing a crossfade.
  const [spinnerMounted, setSpinnerMounted] = useState(loading);
  useEffect(() => {
    if (loading) {
      setSpinnerMounted(true);
      return undefined;
    }
    const timer = setTimeout(() => setSpinnerMounted(false), MEMBERS_FADE_MS);
    return () => clearTimeout(timer);
  }, [loading]);

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
    { id: 'members', label: 'Members' },
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

      {/* Tab bar — same underline pattern as ProjectOverview. role="tablist"
          so screen readers announce the relationship; each button is a tab
          whose pressed state mirrors activeTab. Renders immediately (no
          skeleton on the bar itself). Only the Members count pill is
          gated on `loading` — when true it shows a small shimmering
          placeholder so the tab width doesn't reflow when the real
          count drops in. */}
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
            {t.id === 'members' && (
              loading
                ? <span className="project-tab-count project-tab-count-skel skel-bar" aria-hidden="true" />
                : <span className="project-tab-count">{members.length}</span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'members' && (
        <>
          {/* Spinner overlay. Mounted while loading AND for one fade
              window after loading resolves so the opacity transition
              has time to complete. Reuses the global .spinner class
              from Sidebar.css. */}
          {spinnerMounted && (
            <div
              className={`project-dashboard-members-loading${loading ? '' : ' is-fading-out'}`}
              role="status"
              aria-live="polite"
            >
              <span className="spinner" aria-label="Loading members" />
            </div>
          )}
          {/* Team tree mounts as soon as loading resolves and fades in
              via its own keyframes (see .project-dashboard-members-fade-in
              in the CSS). Mounting it eagerly while the spinner is still
              fading out lets the two animations overlap — the eye reads
              this as a crossfade rather than a hard swap. */}
          {!loading && (
            <div className="project-dashboard-members-fade-in">
              <TeamTree members={members} customRoles={customRoles} />
            </div>
          )}
        </>
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
    </div>
  );
}
