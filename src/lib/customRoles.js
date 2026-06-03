// Thin Supabase wrappers for the custom_roles + custom_role_capabilities
// tables. Patterned after src/lib/projectFiles.js and src/lib/projects.js —
// every function returns { data, error }, never throws. RLS does the
// authorization on every read/write.
//
// `capabilities` shape passed in/out: an array of { capability, granted }.
// `granted=true` means the capability is ADDED on top of the base tier;
// `granted=false` means REVOKED from the base tier. Inherited capabilities
// don't appear in the array at all.
//
// Schema reference: supabase/migrations/008_custom_roles_and_capabilities.sql.

import { supabase } from './supabaseClient';

// The seven capabilities a custom role can override. Mirrors the
// public.project_capability enum in migration 008. Order here drives the
// display order in the editor modal.
export const CAPABILITIES = Object.freeze([
  { id: 'files.view',          group: 'Files',   label: 'View files',         hint: 'See the file list and open / download files.' },
  { id: 'files.upload',        group: 'Files',   label: 'Upload files',       hint: 'Add new files to this project.' },
  { id: 'files.delete_own',    group: 'Files',   label: 'Delete own files',   hint: 'Remove files this user uploaded themselves.' },
  { id: 'files.delete_any',    group: 'Files',   label: 'Delete any file',    hint: 'Remove any file in the project, regardless of who uploaded it.' },
  { id: 'members.invite',      group: 'Members', label: 'Invite members',     hint: 'Send invitations + revoke pending ones.' },
  { id: 'members.remove',      group: 'Members', label: 'Remove members',     hint: 'Kick non-owner members from the project.' },
  { id: 'members.change_role', group: 'Members', label: 'Change member role', hint: 'Switch a member between built-in roles or custom ones.' },
]);

// Per-tier default capability matrix — mirrors the CASE statement inside the
// has_capability() SQL function. Used by useHasCapability + the editor
// modal's "Inherited" labels so the UI matches RLS without an extra query.
//
// Owner is INCLUDED here but isn't a valid custom-role base (the migration's
// CHECK + RPCs reject it). We still need the row so the matrix can answer
// "does the actor (who is an owner) have capability X?" — useful for the
// useHasCapability hook running on the owner's session.
const TIER_DEFAULTS = Object.freeze({
  owner:  Object.freeze(new Set(CAPABILITIES.map((c) => c.id))),
  admin:  Object.freeze(new Set(CAPABILITIES.map((c) => c.id))),
  member: Object.freeze(new Set(['files.view', 'files.upload', 'files.delete_own'])),
  viewer: Object.freeze(new Set(['files.view'])),
});

// Resolve a capability against a base role + override list (the shape this
// lib returns from listCustomRoles). Pure function so it can be called from
// both useHasCapability (for the actor) and from the editor modal (to show
// "Effective: granted" hints per row).
export function resolveCapability(baseRole, capability, overrides) {
  // overrides may be undefined / null for built-in tiers — no overrides.
  if (overrides?.length) {
    const o = overrides.find((x) => x.capability === capability);
    if (o) return o.granted;
  }
  return TIER_DEFAULTS[baseRole]?.has(capability) ?? false;
}

// Tri-state cycle for a single capability on a custom role. Pure function
// that operates on the array shape `[{capability, granted}, ...]` (same
// shape listCustomRoles returns and updateCustomRole accepts), so the
// matrix and the editor share one implementation.
//
//   Inherit (no override)              → flip to opposite of base default
//   Explicit override (opposite base)  → clear override (back to inherit)
//   Explicit override matching base    → flip to opposite (edge case from
//                                        a base-tier switch that left a
//                                        now-redundant override behind)
//
// Returns a NEW array — never mutates the input — so callers can hand the
// result straight to React state without aliasing concerns.
export function cycleCapability(baseRole, capId, capabilities) {
  const baseDefault = resolveCapability(baseRole, capId, []);
  const existing = (capabilities || []).find((c) => c.capability === capId);

  if (!existing) {
    // From inherited → flip to opposite of base default.
    return [...(capabilities || []), { capability: capId, granted: !baseDefault }];
  }
  if (existing.granted === !baseDefault) {
    // From "explicit opposite" → clear the override.
    return (capabilities || []).filter((c) => c.capability !== capId);
  }
  // From "explicit match base" (redundant override) → flip to opposite.
  return (capabilities || []).map((c) =>
    c.capability === capId ? { ...c, granted: !baseDefault } : c,
  );
}

// List custom roles for a project, with their capability overrides nested.
// PostgREST does the join via the FK between custom_role_capabilities and
// custom_roles, so a single round-trip returns the full role catalog.
//
// Returns: [{ id, name, description, base_role, created_at,
//             capabilities: [{ capability, granted }] }, ...]
export async function listCustomRoles(projectId) {
  if (!projectId) return { data: [], error: new Error('Missing projectId') };
  const { data, error } = await supabase
    .from('custom_roles')
    .select(`
      id, name, description, base_role, created_at, created_by,
      capabilities:custom_role_capabilities ( capability, granted )
    `)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) return { data: [], error };
  // Normalise so consumers never see a null capabilities array — empty list
  // and null both mean "no overrides".
  return {
    data: (data || []).map((r) => ({
      ...r,
      capabilities: r.capabilities ?? [],
    })),
    error: null,
  };
}

// Create a custom role + its initial capability overrides atomically via
// the SECURITY INVOKER RPC `create_custom_role`. Returns the new role id.
// RLS enforces admin+ via the create_custom_role function's invoker context.
export async function createCustomRole({ projectId, name, description, baseRole, capabilities }) {
  if (!projectId) return { data: null, error: new Error('Missing projectId') };
  const { data, error } = await supabase.rpc('create_custom_role', {
    p_project_id:   projectId,
    p_name:         name,
    p_description:  description ?? null,
    p_base_role:    baseRole,
    p_capabilities: capabilities ?? [],
  });
  return { data, error };
}

// Update + REPLACE the capability set wholesale. The UI sends the desired
// final state (the full set of overrides); the RPC delete-alls + re-inserts
// inside a single transaction. Cheap because the set is small (≤ 7 rows).
export async function updateCustomRole({ id, name, description, baseRole, capabilities }) {
  if (!id) return { data: null, error: new Error('Missing id') };
  const { error } = await supabase.rpc('update_custom_role', {
    p_role_id:      id,
    p_name:         name,
    p_description:  description ?? null,
    p_base_role:    baseRole,
    p_capabilities: capabilities ?? [],
  });
  return { data: null, error };
}

// Delete a custom role. Cascade clears its capability overrides; the FK on
// project_members.custom_role_id is ON DELETE SET NULL so any member
// assigned to this role reverts cleanly to their base tier (their enum
// role column was already kept in sync at assign time).
export async function deleteCustomRole(id) {
  if (!id) return { data: null, error: new Error('Missing id') };
  const { error } = await supabase
    .from('custom_roles')
    .delete()
    .eq('id', id);
  return { data: null, error };
}

// Assign a custom role to an existing project member. This is a thin
// wrapper around an UPDATE on project_members — it sets BOTH the
// custom_role_id pointer AND syncs the enum `role` to the custom role's
// base_role in one statement. Keeping the enum in sync is what lets the
// legacy has_project_role() ladder keep returning the right tier without
// knowing about custom roles. Pass customRoleId=null to revert to the
// built-in role of your choice (pass baseRole then).
//
// RLS gate: has_capability(project_id, 'members.change_role').
export async function setMemberRole({ projectId, userId, baseRole, customRoleId }) {
  if (!projectId || !userId || !baseRole) {
    return { data: null, error: new Error('Missing required field') };
  }
  if (baseRole === 'owner') {
    return { data: null, error: new Error('Cannot promote to owner via this path') };
  }
  const { data, error } = await supabase
    .from('project_members')
    .update({ role: baseRole, custom_role_id: customRoleId ?? null })
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .select('user_id, role, custom_role_id')
    .single();
  return { data, error };
}

// Subscribe to custom_roles + custom_role_capabilities changes for a project.
// Mirrors src/lib/projectFiles.js#subscribeForProject. The capabilities
// channel can't filter by project_id directly (the column lives on the
// parent row), so we subscribe unfiltered and rely on a debounced refetch
// to keep state consistent — same trade-off as the members realtime in
// ProjectContext.
export function subscribeForProjectRoles(projectId, onChange) {
  if (!projectId) return () => {};
  // Unique topic suffix so two subscribers for the same project (e.g. the
  // primary pane and a split-view pane both viewing it) don't collide on a
  // fixed `custom_roles:<id>` channel name.
  const suffix = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  const channel = supabase
    .channel(`custom_roles:${projectId}:${suffix}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'custom_roles',
        filter: `project_id=eq.${projectId}`,
      },
      (payload) => onChange?.({ source: 'custom_roles', ...payload }),
    )
    .on(
      'postgres_changes',
      {
        // No filter — we get every project's capability changes and rely on
        // a debounced refetch to reconcile. Volume is low (capability rows
        // change only when an admin edits a custom role).
        event: '*',
        schema: 'public',
        table: 'custom_role_capabilities',
      },
      (payload) => onChange?.({ source: 'custom_role_capabilities', ...payload }),
    )
    .subscribe();
  return () => {
    try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
  };
}
