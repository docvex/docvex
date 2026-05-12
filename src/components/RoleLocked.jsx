import React from 'react';
import './RoleLocked.css';

// Padlock icon for the overlay badge. Inline SVG per the CLAUDE.md
// convention (no icon library). currentColor stroke so it inherits the
// badge's text color.
const LockIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

// RoleLocked — wraps a feature that's gated on a role and surfaces a
// "This feature is [role] only" overlay when the caller doesn't meet
// the requirement.
//
// Renders children directly when `locked` is false, so unlocked viewers
// pay zero DOM/wrapper overhead. When locked:
//   - the content stays in the tree (still visible underneath, so the
//     viewer learns the feature exists and roughly what it does)
//   - pointer-events:none + opacity + blur indicate non-interactivity
//   - a centered badge names the required role explicitly
//
// Used across the Project Overview page (Project tab, Pending invitations,
// Invite member button, …) per the strict-role-gating feedback memory.
//
// Props:
//   - locked: boolean — when true, render the overlay
//   - requiredRole: 'owner' | 'admin' | 'member' | 'viewer' — interpolated
//     into the overlay message. Lowercased on purpose to match the role
//     pills in ProjectDashboard.css.
//   - children: the feature itself
export default function RoleLocked({ locked, requiredRole, children }) {
  if (!locked) return children;
  return (
    <div className="role-locked">
      <div className="role-locked-content" aria-hidden="true">
        {children}
      </div>
      <div className="role-locked-overlay" role="note">
        <span className="role-locked-badge">
          {LockIcon}
          <span>
            This feature is <strong>{requiredRole}</strong> only
          </span>
        </span>
      </div>
    </div>
  );
}
