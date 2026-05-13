import React from 'react';
import './ProjectDashboardSkeleton.css';

// Skeleton placeholder for the /projects/:id/dashboard page. Mirrors the
// .project-dashboard layout in ProjectDashboard.css — header (title + role
// pill) + one card (card title, subtitle, and a dashed empty-state box). Box
// dimensions approximate the real content so hand-off doesn't shift the
// page when the fetch resolves.
export default function ProjectDashboardSkeleton() {
  return (
    <div className="project-dashboard project-dashboard-skeleton">
      <div className="project-dashboard-skel-header">
        <div className="project-dashboard-skel-title-row">
          <div className="skel-bar skel-dash-title" />
          <div className="skel-bar skel-dash-role" />
        </div>
      </div>
      <div className="skel-dash-card">
        <div className="skel-dash-card-header">
          <div className="skel-bar skel-dash-card-title" />
        </div>
        <div className="skel-bar skel-dash-card-subtitle" />
        <div className="skel-dash-empty">
          <div className="skel-bar skel-dash-empty-line" />
        </div>
      </div>
    </div>
  );
}
