import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createProject } from '../../lib/projects';
import { useNotifications } from '../../context/NotificationsContext';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useAuth } from '../../context/AuthContext';
import { localFolderApi, isElectronBranch } from '../../lib/localFolder';
import { readProjectsDir } from '../../lib/projectsDir';
import './ProjectCreate.css';

// Mirror a newly-created project to disk: create + register its folder under
// the user's chosen projects directory (the shared resolver, so the Files page
// later resolves to this same folder) and drop a `.docvex.json` sidecar so the
// folder re-attaches to the project without prompting. Electron only — web has
// no ambient projects directory. Best-effort: surfaces a toast on failure but
// never blocks navigation. Migrated from the old launch hub's create flow.
async function mirrorProjectToDisk(project, userId, notify) {
  if (!isElectronBranch || !project?.id || !project?.name) return;
  const projectsDir = readProjectsDir(userId);
  if (!projectsDir) {
    notify?.({
      category: 'project', variant: 'info', icon: 'folder',
      title: 'Tip: set a projects folder',
      body: 'Choose one in Settings to auto-create a folder for each new project.',
      dedupeKey: 'no-projects-dir',
    });
    return;
  }
  const { path: dir, error } = await localFolderApi.projectDir(project.id, project.name, projectsDir);
  if (error || !dir) {
    notify?.({
      category: 'project', variant: 'warning', icon: 'folder',
      title: 'Project created, but its folder couldn’t be made',
      body: error || 'Unknown error', dedupeKey: `folder-fail-${project.id}`,
    });
    return;
  }
  await localFolderApi.writeSidecar({ dir, json: { version: 1, projectId: project.id, entries: {} } });
}

const ArrowLeftIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="19" y1="12" x2="5" y2="12" />
    <polyline points="12 19 5 12 12 5" />
  </svg>
);

export default function ProjectCreate() {
  const navigate = useNavigate();
  const { notify } = useNotifications();
  const { selectProject } = useSelectedProject();
  const { session } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Inline error for form-level failures (matches the AuthPage pattern where
  // form errors stay local and toasts are reserved for background async).
  const [formError, setFormError] = useState(null);

  const onSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);

    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setFormError('Name is required.');
      return;
    }
    if (trimmed.length > 80) {
      setFormError('Name is too long (max 80 characters).');
      return;
    }

    setSubmitting(true);
    const { data, error } = await createProject({ name: trimmed, description });
    setSubmitting(false);

    if (error || !data) {
      setFormError(error?.message || 'Could not create the project. Try again.');
      return;
    }

    // Background success toast — the navigation immediately moves the user
    // off this page so the inline confirmation has no time to be read.
    notify({
      category: 'project',
      variant: 'success',
      icon: 'folder-plus',
      title: `Project "${data.name}" created`,
      dedupeKey: `project-created-${data.id}`,
    });
    // Mirror the project to a local folder (Electron, when a projects folder
    // is set) so the Files page resolves straight to it. Best-effort, awaited
    // so the sidecar is in place before we navigate to the project.
    await mirrorProjectToDisk(data, session?.user?.id ?? null, notify);
    // The just-created project becomes the user's working project — it'd
    // be jarring to land on its dashboard and have the sidebar's project
    // section still empty.
    selectProject(data.id);
    navigate(`/projects/${data.id}`);
  };

  return (
    <div className="project-create-page">
      <header className="project-create-header">
        <Link to="/projects" className="project-create-back">
          {ArrowLeftIcon} Projects
        </Link>
        <h1 className="project-create-title">New project</h1>
        <p className="project-create-subtitle">
          You'll be added as the owner. You can invite others from the Members page after creating.
        </p>
      </header>

      <form className="project-create-form" onSubmit={onSubmit} noValidate>
        <label className="project-create-field">
          <span className="project-create-label">
            Name <span className="project-create-required">*</span>
          </span>
          <input
            type="text"
            className="project-create-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Marketing rebrand"
            autoFocus
            maxLength={80}
            disabled={submitting}
            required
          />
        </label>

        <label className="project-create-field">
          <span className="project-create-label">Description</span>
          <textarea
            className="project-create-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this project about? (optional)"
            rows={4}
            maxLength={500}
            disabled={submitting}
          />
        </label>

        {formError && <div className="project-create-error">{formError}</div>}

        <div className="project-create-actions">
          <Link to="/projects" className="project-create-cancel">
            Cancel
          </Link>
          <button
            type="submit"
            className="project-create-submit"
            disabled={submitting || name.trim().length === 0}
          >
            {submitting ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </div>
  );
}
