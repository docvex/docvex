import React from 'react';
import Tooltip from './Tooltip';

// Renders a role pill in one consistent style across the app. Two things
// this centralises:
//
//   1. Viewer → "Client" relabel. The DB enum stays `viewer` (no migration
//      risk); every UI surface that displays a role calls through here so
//      the substitution lives in one place.
//   2. Custom roles. When `customRole` is provided, the pill shows the
//      custom role's name and a base-tier subtitle ("extends Member") so
//      readers can still infer the underlying access tier at a glance.
//
// Visual styling reuses the existing `.project-dashboard-role` pills from
// ProjectDashboard.css. Custom roles use the base_role's color so they
// read as variants of the same tier rather than completely new colors —
// keeps the role vocabulary scannable.
//
// Props:
//   role          — the enum value ('owner' | 'admin' | 'member' | 'viewer')
//                   from project_members.role. Required (drives color).
//   customRole    — optional { id, name, base_role } if the member is
//                   assigned a custom role. Its `name` becomes the label;
//                   the base_role drives the color.
//   showBase      — when true and a customRole is set, render an extra
//                   "extends Member" subtitle. Used in the Members list;
//                   omitted in compact contexts (header pill).
export default function RoleBadge({ role, customRole, showBase = false, className = '' }) {
  // Color tier — driven by the underlying base, not the custom-role label.
  const baseRole = customRole?.base_role ?? role ?? 'viewer';
  // Display label. Custom roles win; otherwise rewrite viewer → Client.
  const label = customRole?.name ?? builtInLabel(role);

  const tooltipContent = customRole
    ? `Custom role — extends ${capitalize(builtInLabel(baseRole))}`
    : null;

  return (
    <Tooltip content={tooltipContent}>
      <span
        className={`project-dashboard-role role-${baseRole}${
          customRole ? ' role-custom' : ''
        } ${className}`.trim()}
      >
        {label}
        {customRole && showBase && (
          <span className="role-base-suffix"> · {builtInLabel(baseRole)}</span>
        )}
      </span>
    </Tooltip>
  );
}

// Translate the enum value into a user-facing label. The only rewrite is
// viewer → "Client" per product direction; the rest pass through.
export function builtInLabel(role) {
  if (role === 'viewer') return 'Client';
  return role ?? 'unknown';
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
