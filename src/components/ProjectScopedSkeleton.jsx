import React from 'react';
import './ProjectScopedSkeleton.css';

// Skeleton placeholder for the project-scoped placeholder pages (Files,
// To-dos) — mirrors the .project-scoped-page layout in ProjectScoped.css so
// the hand-off to real content doesn't shift the page. Box dimensions
// approximate the header + coming-soon card shape; exact pixel match isn't
// the point — what matters is the shape feels right before the data lands.
export default function ProjectScopedSkeleton() {
  return (
    <div className="project-scoped-page project-scoped-skeleton">
      <div className="project-scoped-skel-header">
        <div className="skel-bar skel-title" />
        <div className="skel-bar skel-subtitle" />
      </div>
      <div className="skel-card">
        <div className="skel-bar skel-card-title" />
        <div className="skel-bar skel-card-line" />
        <div className="skel-bar skel-card-line short" />
      </div>
    </div>
  );
}
