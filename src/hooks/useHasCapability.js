import { useMemo } from 'react';
import { useProjectOptional } from '../context/ProjectContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useAuth } from '../context/AuthContext';
import { resolveCapability } from '../lib/customRoles';

// DEV OVERRIDE — when true, every capability check returns true for
// any signed-in user with a role on the project. Bypasses the tier
// matrix + custom-role overrides entirely. Set to false (or delete
// the early return below) to restore the real role-based gating.
// Server-side RLS still enforces actual permissions — this only
// unlocks the UI affordances.
const ALL_PERMISSIONS_OVERRIDE = true;

// Client-side mirror of the public.has_capability(project_id, capability) SQL
// function. RLS remains the authoritative gate; this hook exists so the UI
// shows / hides controls in lockstep with what the server would accept.
//
// Resolution order (matches the SQL implementation):
//   1. If the caller has a custom_role_id assigned → look up their custom
//      role's overrides for the requested capability; explicit row wins.
//   2. Otherwise → look up the built-in matrix for the caller's base tier.
//
// Context-resolution priority:
//   A. If <ProjectProvider> is mounted in scope (routes under
//      /projects/:projectId — Overview, Dashboard), read the caller's
//      `role` + `custom_role_id` from the full project context. Custom-role
//      overrides DO resolve here.
//   B. Otherwise (routes mounted outside ProjectShell — /files, /clients,
//      /todos), fall back to SelectedProjectContext.selectedProject.role —
//      the enum tier of the user's role in the currently-selected project.
//      Custom-role overrides DON'T resolve here (we don't have the
//      customRoles catalog without ProjectProvider); the answer is the
//      base-tier default. RLS still enforces the override server-side, so
//      a UI false-negative is acceptable defence-in-depth.
//   C. No role at all (signed out, or no selection) → false.
//
// Usage:
//   const canInvite = useHasCapability('members.invite');
export function useHasCapability(capability) {
  const projectCtx = useProjectOptional();      // null if no ProjectProvider
  const { selectedProject } = useSelectedProject();
  const { session } = useAuth();

  return useMemo(() => {
    const myUserId = session?.user?.id ?? null;
    const hasRole = Boolean(projectCtx?.role || selectedProject?.role);

    // DEV OVERRIDE: any signed-in user with a role on this project
    // gets every capability. RLS still enforces server-side. Flip
    // ALL_PERMISSIONS_OVERRIDE to false to restore the real gating.
    if (ALL_PERMISSIONS_OVERRIDE && hasRole && myUserId) return true;

    // Path A — full ProjectContext available
    if (projectCtx?.role) {
      const meRow = myUserId
        ? projectCtx.members.find((m) => m.user_id === myUserId)
        : null;
      const customRoleId = meRow?.custom_role_id ?? null;
      const customRole = customRoleId
        ? projectCtx.customRoles.find((cr) => cr.id === customRoleId)
        : null;
      const baseRole = customRole?.base_role ?? projectCtx.role;
      const overrides = customRole?.capabilities ?? [];
      return resolveCapability(baseRole, capability, overrides);
    }

    // Path B — SelectedProjectContext fallback. selectedProject.role is the
    // enum tier; no custom-role info available here.
    if (selectedProject?.role) {
      return resolveCapability(selectedProject.role, capability, []);
    }

    // Path C — no role
    return false;
  }, [projectCtx, selectedProject, session, capability]);
}

// Convenience for callsites that want to read multiple capabilities at once
// without N hook calls. Same context-resolution rules as useHasCapability.
export function useCapabilities(capabilities) {
  const projectCtx = useProjectOptional();
  const { selectedProject } = useSelectedProject();
  const { session } = useAuth();

  return useMemo(() => {
    const out = {};
    const myUserId = session?.user?.id ?? null;
    const hasRole = Boolean(projectCtx?.role || selectedProject?.role);

    // DEV OVERRIDE — see useHasCapability above. Same gate.
    if (ALL_PERMISSIONS_OVERRIDE && hasRole && myUserId) {
      for (const cap of capabilities) out[cap] = true;
      return out;
    }

    // Resolve once, then iterate capabilities.
    let baseRole = null;
    let overrides = [];
    if (projectCtx?.role) {
      const meRow = myUserId
        ? projectCtx.members.find((m) => m.user_id === myUserId)
        : null;
      const customRoleId = meRow?.custom_role_id ?? null;
      const customRole = customRoleId
        ? projectCtx.customRoles.find((cr) => cr.id === customRoleId)
        : null;
      baseRole = customRole?.base_role ?? projectCtx.role;
      overrides = customRole?.capabilities ?? [];
    } else if (selectedProject?.role) {
      baseRole = selectedProject.role;
    }

    if (!baseRole) {
      for (const cap of capabilities) out[cap] = false;
      return out;
    }

    for (const cap of capabilities) {
      out[cap] = resolveCapability(baseRole, cap, overrides);
    }
    return out;
  }, [projectCtx, selectedProject, session, capabilities]);
}
