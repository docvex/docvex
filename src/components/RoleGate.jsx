import React from 'react';
import { useProject } from '../context/ProjectContext';

// Ordered rank of project roles so we can compare "is at least X" with a
// single integer comparison. Kept in lock-step with the project_role enum in
// supabase/migrations/001_projects.sql.
const RANK = Object.freeze({
  viewer: 0,
  member: 1,
  admin:  2,
  owner:  3,
});

// <RoleGate minRole="admin">…</RoleGate>
//
// Renders children only when the caller's role on the current project is
// >= minRole. Returns `fallback` otherwise (default: null — i.e. the gated
// content disappears silently).
//
// Purely a UI convenience. Real enforcement lives in RLS + the
// has_project_role() Postgres helper, so a determined client that bypasses
// React still can't escalate. Don't try to make this the security boundary.
export default function RoleGate({ minRole, fallback = null, children }) {
  const { role } = useProject();
  const haveRank = role != null ? RANK[role] : undefined;
  const needRank = RANK[minRole];

  if (haveRank === undefined || needRank === undefined) return fallback;
  return haveRank >= needRank ? <>{children}</> : fallback;
}

// Hook form for cases where conditional rendering inside JSX is awkward
// (e.g. building an array of buttons with role-conditional handlers).
export function useHasRole(minRole) {
  const { role } = useProject();
  const haveRank = role != null ? RANK[role] : undefined;
  const needRank = RANK[minRole];
  if (haveRank === undefined || needRank === undefined) return false;
  return haveRank >= needRank;
}
