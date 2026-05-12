import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useProject } from '../../context/ProjectContext';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { deleteProject } from '../../lib/projects';
import DeleteProjectModal from '../../components/DeleteProjectModal';
import './ProjectDashboard.css';

// Chevron-left icon for the "< Back" link — inline SVG so we don't pull in an
// icon library, consistent with the sidebar icon convention (currentColor
// stroke so it inherits the link's hover state).
const ChevronLeftIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

// Project Overview — the landing page for /projects/:id. Reached by clicking
// a card in the Projects list. Focus: "who's on this project" + "manage it".
// The "working surface" (recent files) lives at /projects/:id/dashboard so
// users can keep two distinct mental models for the two destinations.
//
// Auto-selecting this project into SelectedProjectContext is handled by
// <ProjectAutoSelect/> at the ProjectShell level — see App.jsx.

// Resolves a human-readable display name from a member profile in the same
// order as the Sidebar/Account helpers (full_name > name > email local part).
function getMemberName(profile) {
  if (!profile) return 'Unknown member';
  if (profile.full_name) return profile.full_name;
  if (profile.name) return profile.name;
  if (profile.email) {
    const at = profile.email.indexOf('@');
    return at > 0 ? profile.email.slice(0, at) : profile.email;
  }
  return 'Unknown member';
}

function MemberAvatar({ profile }) {
  const avatarUrl = profile?.avatar_url;
  const initial = (profile?.email || profile?.full_name || '?').charAt(0).toUpperCase();
  if (avatarUrl) {
    return <img className="member-avatar" src={avatarUrl} alt="" referrerPolicy="no-referrer" />;
  }
  return <span className="member-avatar member-avatar-fallback">{initial}</span>;
}

export default function ProjectOverview() {
  const { project, role, members, loading, error } = useProject();
  const { clearSelection } = useSelectedProject();
  const navigate = useNavigate();

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

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

  const isOwner = role === 'owner';

  const handleConfirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    const { error: delErr } = await deleteProject(project.id);
    if (delErr) {
      // Typical failure: role was demoted out of 'owner' between load and
      // click and RLS now rejects. Leave the modal open so the owner can see
      // the reason and either retry or close.
      setDeleteError(delErr.message || 'Failed to delete project.');
      setDeleting(false);
      return;
    }
    // Drop the stale selection so the sidebar's picker doesn't keep naming a
    // deleted project for a frame after navigation.
    clearSelection();
    navigate('/projects', { replace: true });
  };

  return (
    <div className="project-dashboard">
      <header className="project-dashboard-header">
        <Link to="/projects" className="project-dashboard-back">
          {ChevronLeftIcon}
          <span>Back</span>
        </Link>
        <div className="project-dashboard-title-row">
          <h1 className="project-dashboard-title">{project.name}</h1>
          <span className={`project-dashboard-role role-${role}`}>{role}</span>
        </div>
        {project.description && (
          <p className="project-dashboard-description">{project.description}</p>
        )}
      </header>

      <section className="project-dashboard-card">
        <div className="project-dashboard-card-header">
          <h2 className="project-dashboard-card-title">Members</h2>
          <span className="project-dashboard-card-count">
            {members.length} {members.length === 1 ? 'person' : 'people'}
          </span>
        </div>
        <p className="project-dashboard-card-subtitle">
          Everyone with access to this project.
        </p>

        {members.length === 0 ? (
          <div className="project-dashboard-empty">No members yet.</div>
        ) : (
          <ul className="member-list">
            {members.map((m) => (
              <li key={m.user_id} className="member-row">
                <MemberAvatar profile={m.profile} />
                <div className="member-text">
                  <div className="member-name">{getMemberName(m.profile)}</div>
                  {m.profile?.email && (
                    <div className="member-email">{m.profile.email}</div>
                  )}
                </div>
                <span className={`project-dashboard-role role-${m.role}`}>{m.role}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isOwner && (
        <section className="project-dashboard-danger">
          <h2>Danger zone</h2>
          <div className="project-dashboard-danger-row">
            <div className="project-dashboard-danger-text">
              <p className="project-dashboard-danger-title">Delete this project</p>
              <p className="project-dashboard-danger-desc">
                Once deleted, you can't recover it. All members, pending
                invites, and uploaded files will be removed.
              </p>
            </div>
            <button
              type="button"
              className="project-dashboard-danger-btn"
              onClick={() => { setDeleteError(null); setDeleteOpen(true); }}
              disabled={deleting}
            >
              Delete project
            </button>
          </div>
          {deleteError && (
            <div className="project-dashboard-danger-error" role="alert">
              {deleteError}
            </div>
          )}
        </section>
      )}

      <DeleteProjectModal
        open={deleteOpen}
        projectName={project.name}
        pending={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => { if (!deleting) setDeleteOpen(false); }}
      />
    </div>
  );
}
