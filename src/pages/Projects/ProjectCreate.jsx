import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createProject } from '../../lib/projects';
import { useNotifications } from '../../context/NotificationsContext';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import './ProjectCreate.css';

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
      category: 'system',
      variant: 'success',
      title: `Project "${data.name}" created`,
      dedupeKey: `project-created-${data.id}`,
    });
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
