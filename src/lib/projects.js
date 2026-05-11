// Thin Supabase wrappers for the projects + members + invitations tables.
//
// Every read goes through RLS scoped on auth.uid() via has_project_role(),
// so callers don't need to add their own user-id filters for safety. Every
// function returns `{ data, error }` — same idiom as supabase-js itself, no
// throwing. Inspired by src/lib/notificationsRepo.js.
//
// The Edge Function calls (sendInvite / acceptInvite / revokeInvite) hand off
// to the deployed functions via supabase.functions.invoke(); their bodies and
// auth handling live in supabase/functions/<name>/index.ts.

import { supabase } from './supabaseClient';

// ── Projects ──────────────────────────────────────────────────────────────

// All projects the caller is a member of, newest-active first, with their
// role joined in. We query project_members as the base (RLS scopes it to
// just the caller's rows via the "members read members" policy that consults
// has_project_role(project_id, 'viewer')) and embed the project relation.
export async function listMyProjects() {
  const { data, error } = await supabase
    .from('project_members')
    .select('role, added_at, project:projects(id, name, description, created_at, updated_at, created_by)')
    .order('added_at', { ascending: false });

  if (error) return { data: [], error };

  // Flatten { role, project: {...} } → { ...project, role }. The filter drops
  // rows where the embedded project is null (would happen only mid-delete
  // race; defensive).
  const flat = (data || [])
    .filter((r) => r.project)
    .map((r) => ({ ...r.project, role: r.role }));
  return { data: flat, error: null };
}

// Create a new project. The projects_add_owner trigger automatically inserts
// the creator into project_members as 'owner', so by the time this returns
// the caller already has full access.
export async function createProject({ name, description = null }) {
  const userResult = await supabase.auth.getUser();
  const userId = userResult.data.user?.id;
  if (!userId) return { data: null, error: new Error('Not signed in') };

  const { data, error } = await supabase
    .from('projects')
    .insert({ name: name?.trim(), description: description?.trim() || null, created_by: userId })
    .select('*')
    .single();
  return { data, error };
}

// Fetch a single project plus the caller's role on it. Two queries because
// the role lives in project_members and PostgREST embedding for the "current
// user's row" requires an awkward filter.
export async function getProject(projectId) {
  const userResult = await supabase.auth.getUser();
  const userId = userResult.data.user?.id;
  if (!userId) return { data: null, error: new Error('Not signed in') };

  const [{ data: project, error: pErr }, { data: membership, error: mErr }] = await Promise.all([
    supabase.from('projects').select('*').eq('id', projectId).maybeSingle(),
    supabase.from('project_members').select('role').eq('project_id', projectId).eq('user_id', userId).maybeSingle(),
  ]);
  if (pErr) return { data: null, error: pErr };
  if (mErr) return { data: null, error: mErr };
  if (!project) return { data: null, error: new Error('Project not found') };

  return { data: { ...project, role: membership?.role ?? null }, error: null };
}

// Patch a project. RLS "admins update projects" enforces admin+; non-admins
// get an empty result with no error (Postgres just returns 0 rows).
export async function updateProject(projectId, patch) {
  const allowed = {};
  if (typeof patch.name === 'string') allowed.name = patch.name.trim();
  if ('description' in patch) allowed.description = patch.description?.trim() || null;
  if (Object.keys(allowed).length === 0) return { data: null, error: new Error('No fields to update') };

  const { data, error } = await supabase
    .from('projects')
    .update(allowed)
    .eq('id', projectId)
    .select('*')
    .single();
  return { data, error };
}

// Owner-only via RLS. Cascade clears project_members + project_invitations.
export async function deleteProject(projectId) {
  const { error } = await supabase.from('projects').delete().eq('id', projectId);
  return { data: null, error };
}

// ── Members ───────────────────────────────────────────────────────────────

// Members of a project with their auth.users profile data joined client-side.
// Two queries because RLS blocks direct client access to auth.users — we go
// through the SECURITY DEFINER get_member_profiles() RPC which reads
// auth.users on our behalf, filtered to "users you share a project with"
// based on the caller's auth.uid().
export async function listMembers(projectId) {
  const { data: members, error: mErr } = await supabase
    .from('project_members')
    .select('user_id, role, added_at')
    .eq('project_id', projectId)
    .order('added_at', { ascending: true });
  if (mErr) return { data: [], error: mErr };
  if (!members?.length) return { data: [], error: null };

  const userIds = members.map((m) => m.user_id);
  const { data: profiles, error: pErr } = await supabase
    .rpc('get_member_profiles', { p_user_ids: userIds });
  if (pErr) return { data: [], error: pErr };

  const profileById = new Map((profiles || []).map((p) => [p.id, p]));
  return {
    data: members.map((m) => ({
      user_id: m.user_id,
      role: m.role,
      added_at: m.added_at,
      profile: profileById.get(m.user_id) ?? null,
    })),
    error: null,
  };
}

// Admin-only via RLS. Updating the 'owner' role is rejected by the policy's
// WITH CHECK clause (role <> 'owner'); ownership transfer needs a different
// mechanism we'll add when the use case comes up.
export async function updateMemberRole(projectId, userId, role) {
  if (role === 'owner') {
    return { data: null, error: new Error('Cannot promote to owner via this path') };
  }
  const { data, error } = await supabase
    .from('project_members')
    .update({ role })
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .select('*')
    .single();
  return { data, error };
}

// Admin-only via RLS. The "delete members" policy guards role <> 'owner',
// so trying to remove an owner just no-ops (zero rows) — explicit check here
// gives a clearer error to the caller.
export async function removeMember(projectId, userId) {
  const { error } = await supabase
    .from('project_members')
    .delete()
    .eq('project_id', projectId)
    .eq('user_id', userId);
  return { data: null, error };
}

// Self-removal. RLS allows it via the "delete members" policy's second branch
// (user_id = auth.uid() and role <> 'owner') — owners must transfer ownership
// or delete the project; they can't just leave.
export async function leaveProject(projectId) {
  const userResult = await supabase.auth.getUser();
  const userId = userResult.data.user?.id;
  if (!userId) return { data: null, error: new Error('Not signed in') };
  return removeMember(projectId, userId);
}

// ── Invitations ───────────────────────────────────────────────────────────

// Pending invitations (accepted_at is null) on a project. Admin-only via RLS
// "admins read invitations" policy.
export async function listInvitations(projectId) {
  const { data, error } = await supabase
    .from('project_invitations')
    .select('id, email, role, token, expires_at, created_at, invited_by')
    .eq('project_id', projectId)
    .is('accepted_at', null)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

// Edge Function calls. Each function bundles auth + admin check + the
// service-role-dependent work (Resend send, RPC-based atomic accept).
// supabase.functions.invoke automatically sends the user JWT in the
// Authorization header so the function can verify it.

export async function sendInvite(projectId, email, role) {
  const { data, error } = await supabase.functions.invoke('send-invite', {
    body: { project_id: projectId, email, role },
  });
  return { data, error };
}

export async function acceptInvite(token) {
  const { data, error } = await supabase.functions.invoke('accept-invite', {
    body: { token },
  });
  return { data, error };
}

export async function revokeInvite(invitationId) {
  const { data, error } = await supabase.functions.invoke('revoke-invite', {
    body: { invitation_id: invitationId },
  });
  return { data, error };
}
