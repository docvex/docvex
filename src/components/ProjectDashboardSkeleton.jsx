import React from 'react';
import './ProjectDashboardSkeleton.css';

// Skeleton placeholder for the tab content area of /projects/:id/dashboard.
// The real page header (title "Dashboard" + role pill) renders above this
// component now — the title is static so it never needs a skeleton, and
// the role pill has its own inline .skel-dash-role placeholder in
// ProjectDashboard.jsx that swaps in when `role` resolves. This component
// covers only the tabs+content below: card title, subtitle, dashed empty
// box. Dimensions approximate the real content so hand-off doesn't shift
// the page when the fetch resolves.
export default function ProjectDashboardSkeleton() {
  return (
    <div className="project-dashboard-skeleton">
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
