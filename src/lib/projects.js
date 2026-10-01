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

//
// END-TO-END (migration 046): a project's `name`, `description` and
// `ai_context` are stored as ciphertext (`e2e:v1:p<version>:…`) under the
// project's key (lib/e2e/projectKeys), bound to the project's id and the
// column. Every function here DECRYPTS on the way out, so callers see plain
// text; a name this device can't open yet reads as ENCRYPTED_PROJECT_NAME
// with `name_unreadable: true`. Projects from before keep their plain values
// until an admin opens them (`getProject` re-writes them encrypted).
// Realtime rows (ProjectContext) must go through `decryptProjectRow`.

import { supabase } from './supabaseClient';
import { coerceJurisdictionCode } from './jurisdictions';
import {
  encryptProjectText, decryptProjectText, newProjectKey, registerInitialProjectKey,
  rotateProjectKey,
} from './e2e/projectKeys';
import { encryptText, isEncryptedText } from './e2e/envelope';
import { E2E_REQUIRED } from './e2e/policy';

export const ENCRYPTED_PROJECT_NAME = 'Encrypted project';
const FIELDS = [
  ['name', 'project.name'],
  ['description', 'project.description'],
  ['ai_context', 'project.ai_context'],
];

// A project row with its text columns decrypted. `create: true` may make /
// adopt the project's key (opening the project); the list passes false.
export async function decryptProjectRow(row, { create = false } = {}) {
  if (!row || !row.id) return row;
  const out = { ...row };
  for (const [col, purpose] of FIELDS) {
    if (!isEncryptedText(row[col])) continue;
    try {
      const r = await decryptProjectText(row.id, row[col], { purpose, rowId: row.id, create });
      if (r.ok) { out[col] = r.text; continue; }
    } catch { /* below */ }
    out[col] = col === 'name' ? ENCRYPTED_PROJECT_NAME : null;
    out[`${col}_unreadable`] = true;
  }
  return out;
}

async function sealField(projectId, col, value) {
  if (value == null || value === '') return value;
  const purpose = FIELDS.find(([c]) => c === col)[1];
  try {
    return await encryptProjectText(projectId, value, { purpose, rowId: projectId });
  } catch (err) {
    if (E2E_REQUIRED) throw err;
    return value;
  }
}

// Background: an admin opening a project whose texts are still plain writes
// them back encrypted. Never throws.
async function encryptLegacyFields(project) {
  try {
    if (!project?.id || !['owner', 'admin'].includes(project.role)) return;
    const plain = FIELDS.filter(([c]) => typeof project[c] === 'string' && project[c] && !isEncryptedText(project[c]));
    if (!plain.length) return;
    const { data: raw } = await supabase.from('projects').select('id, name, description, ai_context').eq('id', project.id).maybeSingle();
    if (!raw) return;
    const patch = {};
    for (const [c] of FIELDS) {
      if (typeof raw[c] === 'string' && raw[c] && !isEncryptedText(raw[c])) patch[c] = await sealField(project.id, c, raw[c]);
    }
    if (Object.keys(patch).length) await supabase.from('projects').update(patch).eq('id', project.id);
  } catch { /* next open tries again */ }
}

// Name of the window CustomEvent the picker (and any other consumer of the
// caller's project list) listens for to invalidate cached project lists.
// Dispatched after any mutation that changes which projects the caller is a
// member of: createProject, deleteProject, leaveProject. Centralised here so
// publishers and subscribers can't drift.
export const PROJECTS_CHANGED_EVENT = 'docvex:projects-changed';

// Convenience for publishers: fire-and-forget dispatch. Wrapped in a
// try/catch because non-browser contexts (e.g. a unit test) may not have
// `window` available, and a missing CustomEvent shouldn't break the caller.
export function notifyProjectsChanged() {
  try {
    window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
  } catch { /* non-browser context */ }
}

// Up-to-two-letter initials from a display name, for avatar fallbacks.
function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

// ── Projects ──────────────────────────────────────────────────────────────

// All projects the caller is a member of, newest-active first, with their
// role + total member count joined in. We query project_members as the base
// and embed the project relation; the project relation then re-embeds
// project_members as a `count` aggregate so the card grid can render
// "5 members" without an N+1.
//
// MUST filter by user_id = self on the outer query. The "members read members"
// RLS policy lets any member SELECT every project_members row for projects
// they belong to (so the Members card can render the full list). Without an
// explicit user_id filter here, a project with N members would come back as
// N rows — each embedding the same project — and the renderer would show
// N duplicate project cards. The bug surfaces the moment someone accepts an
// invite, because the project flips from "just me" to "me + inviter".
//
// The inner `member_count:project_members(count)` embed runs through RLS
// independently and counts every row the caller can see for that project —
// for a project the caller is a member of, that's the full membership, so
// the number matches what the Project Overview's Members card would show.
export async function listMyProjects() {
  // getSession() reads the persisted session from storage; getUser() is a
  // round-trip to /auth/v1/user. This runs on every Hub open, where it used to
  // add a whole request's latency before the first query could even start, so
  // prefer the local read and only fall back to the network one.
  const sessionResult = await supabase.auth.getSession();
  let userId = sessionResult.data.session?.user?.id;
  if (!userId) {
    const userResult = await supabase.auth.getUser();
    userId = userResult.data.user?.id;
  }
  if (!userId) return { data: [], error: new Error('Not signed in') };

  const { data, error } = await supabase
    .from('project_members')
    .select(`
      role,
      added_at,
      project:projects(
        id, name, description, created_at, updated_at, created_by,
        member_count:project_members(count)
      )
    `)
    .eq('user_id', userId)
    .order('added_at', { ascending: false });

  if (error) return { data: [], error };

  // Flatten { role, project: {...} } → { ...project, role, member_count }.
  // PostgREST returns the count aggregate as [{ count: N }] (it's an embedded
  // resource, always an array even when aggregated) so we unwrap the first
  // element. Default to 1 — the caller is at minimum a member of any project
  // returned here, so 0 would be lying.
  const flat = await Promise.all((data || [])
    .filter((r) => r.project)
    .map(async (r) => ({
      ...(await decryptProjectRow(r.project)),
      role: r.role,
      member_count: r.project.member_count?.[0]?.count ?? 1,
      members: [],
    })));

  // Best-effort: attach a few member profiles per project so the card grid can
  // render an avatar stack instead of a bare count. RLS lets a member read
  // every project_members row for projects they belong to, so one batched
  // query covers all the caller's projects; the profiles (incl. avatar_url)
  // come from the SECURITY DEFINER get_member_profiles RPC because auth.users
  // is blocked from direct client reads. A failure here leaves members: []
  // and the count still renders — never blanks the list.
  const projectIds = flat.map((p) => p.id);
  if (projectIds.length) {
    const { data: memberRows } = await supabase
      .from('project_members')
      .select('project_id, user_id, added_at')
      .in('project_id', projectIds)
      .order('added_at', { ascending: true });

    if (memberRows?.length) {
      const uniqueIds = [...new Set(memberRows.map((m) => m.user_id))];
      const { data: profiles } = await supabase.rpc('get_member_profiles', { p_user_ids: uniqueIds });
      const profileById = new Map((profiles || []).map((p) => [p.id, p]));
      const byProject = new Map();
      for (const m of memberRows) {
        if (!byProject.has(m.project_id)) byProject.set(m.project_id, []);
        const prof = profileById.get(m.user_id) || null;
        const name = prof?.full_name || prof?.name || prof?.email || 'Member';
        byProject.get(m.project_id).push({
          userId: m.user_id,
          name,
          initials: initialsOf(name),
          avatarUrl: prof?.avatar_url || null,
        });
      }
      for (const p of flat) p.members = byProject.get(p.id) || [];
    }
  }

  return { data: flat, error: null };
}

// Create a new project. The projects_add_owner trigger automatically inserts
// the creator into project_members as 'owner', so by the time this returns
// the caller already has full access. Fires PROJECTS_CHANGED_EVENT on success
// so the picker's cached list invalidates without each caller having to
// remember.
export async function createProject({ name, description = null }) {
  const userResult = await supabase.auth.getUser();
  const userId = userResult.data.user?.id;
  if (!userId) return { data: null, error: new Error('Not signed in') };

  // The project's first key is made HERE, before the row exists, so the name
  // is never stored in clear (not even for the moment between two writes).
  const id = globalThis.crypto.randomUUID();
  const key = newProjectKey();
  const plainName = name?.trim();
  const plainDesc = description?.trim() || null;
  const seal = (v, purpose) => (v ? encryptText(key, v, { purpose, scope: id, keyRef: 'p1', rowId: id }) : null);
  const { data, error } = await supabase
    .from('projects')
    .insert({
      id,
      name: await seal(plainName, 'project.name'),
      description: await seal(plainDesc, 'project.description'),
      created_by: userId,
    })
    .select('*')
    .single();
  if (error) return { data, error };
  // The trigger has made the creator owner — register the key and seal it to
  // them. Should that fail, the texts are written back in clear rather than
  // lost for good (and the key made again on the next open).
  const ok = await registerInitialProjectKey(id, key).catch(() => false);
  if (!ok) {
    // A later open (getProject → encryptLegacyFields) encrypts them again.
    await supabase.from('projects').update({ name: plainName, description: plainDesc }).eq('id', id);
  }
  notifyProjectsChanged();
  return { data: { ...data, name: plainName, description: plainDesc }, error: null };
}

// Fetch a single project plus the caller's role on it. Two queries because
// the role lives in project_members and PostgREST embedding for the "current
// user's row" requires an awkward filter.
//
// Field list covers what the JSX consumers read: id, name, description, AI
// context, plus the dossier-hero metadata (`created_at`, `updated_at`).
// `created_by` is still omitted (nothing renders it). Keep this in lockstep
// with updateProject()'s select below so the two return shapes stay aligned.
//
// `ai_context` / `ai_context_updated_at` back the Project Overview AI tab —
// included here so the textarea seeds from the project row (and stays in sync
// via ProjectContext's Realtime UPDATE merge, which carries the new columns).
// Does `projects.jurisdiction` (migration 033) exist on this deployment?
// null = not yet known, false = confirmed missing. PostgREST rejects a select
// naming an unknown column outright (400 / 42703), so the first such failure is
// remembered and every later query drops the column instead of re-failing —
// otherwise every project fetch, in every window, logs another 400. Resets on
// reload, which is when a freshly-applied migration gets picked up.
let hasJurisdiction = null;
const projectFields = (extra = '') => (
  `id, name, description${hasJurisdiction === false ? '' : ', jurisdiction'}, ai_context, ai_context_updated_at${extra}`
);
// Called with the error (if any) from a select that named the column.
function noteJurisdictionSupport(error) {
  if (error?.code === '42703') { hasJurisdiction = false; return false; }
  if (!error) hasJurisdiction = hasJurisdiction === false ? false : true;
  return hasJurisdiction !== false;
}

export async function getProject(projectId) {
  const userResult = await supabase.auth.getUser();
  const userId = userResult.data.user?.id;
  if (!userId) return { data: null, error: new Error('Not signed in') };

  const [{ data: project, error: pErr }, { data: membership, error: mErr }] = await Promise.all([
    supabase.from('projects').select(projectFields(', created_at, updated_at')).eq('id', projectId).maybeSingle(),
    supabase.from('project_members').select('role').eq('project_id', projectId).eq('user_id', userId).maybeSingle(),
  ]);
  // `jurisdiction` arrives with migration 033. Until that's applied PostgREST
  // rejects the whole select with 42703 (undefined column), which would take
  // the project page down rather than just losing one field — so retry once on
  // the pre-033 column list and remember not to ask again. Safe to delete, along
  // with `hasJurisdiction`, after the migration ships.
  if (!noteJurisdictionSupport(pErr)) {
    const { data: legacy, error: lErr } = await supabase
      .from('projects')
      .select(projectFields(', created_at, updated_at'))
      .eq('id', projectId)
      .maybeSingle();
    if (lErr) return { data: null, error: lErr };
    if (!legacy) return { data: null, error: new Error('Project not found') };
    const out = { ...(await decryptProjectRow(legacy, { create: true })), jurisdiction: null, role: membership?.role ?? null };
    encryptLegacyFields(out);
    return { data: out, error: null };
  }
  if (pErr) return { data: null, error: pErr };
  if (mErr) return { data: null, error: mErr };
  if (!project) return { data: null, error: new Error('Project not found') };

  const out = { ...(await decryptProjectRow(project, { create: true })), role: membership?.role ?? null };
  encryptLegacyFields(out);
  return { data: out, error: null };
}

// Patch a project. RLS "admins update projects" enforces admin+; non-admins
// get an empty result with no error (Postgres just returns 0 rows).
export async function updateProject(projectId, patch) {
  const allowed = {};
  try {
    if (typeof patch.name === 'string') allowed.name = await sealField(projectId, 'name', patch.name.trim());
    if ('description' in patch) allowed.description = await sealField(projectId, 'description', patch.description?.trim() || null);
  } catch (err) { return { data: null, error: err }; }
  if (Object.keys(allowed).length === 0) return { data: null, error: new Error('No fields to update') };

  // Match getProject's narrowed shape — keeps the two return values
  // interchangeable for consumers that read back the updated row.
  const { data, error } = await supabase
    .from('projects')
    .update(allowed)
    .eq('id', projectId)
    .select(projectFields())
    .single();
  // Same pre-migration-033 guard as getProject: without the column PostgREST
  // rejects the whole statement, which would break renaming a project rather
  // than just omitting a field. The UPDATE itself is fine — only the returning
  // clause is — so retry the read-back without it. Delete once 033 is applied.
  if (!noteJurisdictionSupport(error)) {
    const { data: legacy, error: lErr } = await supabase
      .from('projects')
      .update(allowed)
      .eq('id', projectId)
      .select(projectFields())
      .single();
    if (lErr) return { data: null, error: lErr };
    return { data: { ...(await decryptProjectRow(legacy)), jurisdiction: null }, error: null };
  }
  return { data: data ? await decryptProjectRow(data) : data, error };
}

// ── Project AI: context + usage tracking ────────────────────────────────────
// Backs the Project Overview "AI" tab. See migration 030.

// Persist the per-project AI context (free-text instructions prepended to
// every AI request in the project). Admin-only via the same "admins update
// projects" RLS policy that guards name/description — a non-admin save just
// returns zero rows (the UI gates the editor to admins anyway). Empty string
// is stored as NULL so "configured" is a simple `is not null` check. Stamps
// ai_context_updated_at so the usage/overview surfaces can show "updated N ago".
export async function updateProjectAiContext(projectId, aiContext) {
  const value = typeof aiContext === 'string' ? aiContext.trim() : '';
  let stored = null;
  try { stored = value.length ? await sealField(projectId, 'ai_context', value) : null; } catch (err) { return { data: null, error: err }; }
  const { data, error } = await supabase
    .from('projects')
    .update({
      ai_context: stored,
      ai_context_updated_at: new Date().toISOString(),
    })
    .eq('id', projectId)
    .select('id, ai_context, ai_context_updated_at')
    .single();
  return { data: data ? { ...data, ai_context: value.length ? value : null } : data, error };
}

// Persist the project's jurisdiction — which country's law the AI works under
// (migration 033). Admin-only via the same "admins update projects" RLS policy
// as name / description / ai_context. `code` is an entry from
// lib/jurisdictions (or null to clear, which puts the project back on the app
// default); anything unknown is coerced to null rather than stored.
export async function updateProjectJurisdiction(projectId, code) {
  const value = coerceJurisdictionCode(code);
  if (hasJurisdiction === false) {
    return { data: null, error: new Error('This Supabase project is missing the `jurisdiction` column — apply migration 033.') };
  }
  const { data, error } = await supabase
    .from('projects')
    .update({ jurisdiction: value })
    .eq('id', projectId)
    .select('id, jurisdiction')
    .single();
  return { data, error };
}

// Monthly AI usage aggregates for a project, via the get_project_ai_usage RPC
// (SECURITY INVOKER → RLS filters to projects the caller belongs to; a
// non-member or a project with no usage yields an all-zero row). The RPC
// returns a single-row table, so unwrap the first element. Returns a plain
// object { requests, input_tokens, output_tokens, sessions, last_used_at } or
// null on error.
export async function getProjectAiUsage(projectId) {
  const { data, error } = await supabase.rpc('get_project_ai_usage', { p_project_id: projectId });
  if (error) return { data: null, error };
  const row = Array.isArray(data) ? data[0] : data;
  return { data: row || null, error: null };
}

// Logging primitive for project-scoped AI features (Generate / Automate / chat
// assistant / summarise / …) to record one request's token usage. Inserts a
// row attributed to the caller; the "members insert own" RLS policy gates it to
// project members. Fire-and-forget at call sites — a failed log shouldn't break
// the AI feature that emitted it. Server-side emitters (Edge Functions) use the
// service role and write to this table directly instead.
export async function logProjectAiUsage({
  projectId,
  action = 'generate',
  model = null,
  inputTokens = 0,
  outputTokens = 0,
  sessionId = null,
}) {
  const userResult = await supabase.auth.getUser();
  const userId = userResult.data.user?.id ?? null;
  const { data, error } = await supabase
    .from('project_ai_usage')
    .insert({
      project_id: projectId,
      user_id: userId,
      action,
      model,
      input_tokens: Math.max(0, Math.round(Number(inputTokens) || 0)),
      output_tokens: Math.max(0, Math.round(Number(outputTokens) || 0)),
      session_id: sessionId,
    })
    .select('id')
    .single();
  return { data, error };
}

// Owner-only via RLS. Cascade clears project_members + project_invitations.
// Fires PROJECTS_CHANGED_EVENT on success so picker caches invalidate.
export async function deleteProject(projectId) {
  // Remove the project's synced copy in the account first (lib/projectSync),
  // while this user still holds the rights to delete it — once the row is
  // gone nothing would ever know to erase those files. Best effort: a failure
  // here must not block deleting the project.
  try {
    const { disableSync } = await import('./projectSync');
    await disableSync(projectId);
  } catch { /* nothing synced, offline, or no bucket */ }
  const { error } = await supabase.from('projects').delete().eq('id', projectId);
  if (!error) notifyProjectsChanged();
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
    .select('user_id, role, added_at, custom_role_id')
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
      // custom_role_id (nullable). When set, ProjectContext joins it against
      // its customRoles catalog so consumers can read the resolved role
      // name + base_role straight from the member row.
      custom_role_id: m.custom_role_id ?? null,
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
//
// End-to-end: the database drops the removed member's key grants and retires
// the project key's newest version; an admin removing someone then makes the
// NEXT version at once (lib/e2e/projectKeys.rotateProjectKey), so nothing
// written from now on is readable with a key the removed member holds. What
// they already had (files synced, texts read) cannot be taken back.
export async function removeMember(projectId, userId) {
  const { error } = await supabase
    .from('project_members')
    .delete()
    .eq('project_id', projectId)
    .eq('user_id', userId);
  if (!error) {
    const me = (await supabase.auth.getSession()).data.session?.user?.id || null;
    if (me && me !== userId) rotateProjectKey(projectId).catch(() => {});
  }
  return { data: null, error };
}

// Self-removal. RLS allows it via the "delete members" policy's second branch
// (user_id = auth.uid() and role <> 'owner') — owners must transfer ownership
// or delete the project; they can't just leave. Fires PROJECTS_CHANGED_EVENT
// on success so picker caches invalidate.
export async function leaveProject(projectId) {
  const userResult = await supabase.auth.getUser();
  const userId = userResult.data.user?.id;
  if (!userId) return { data: null, error: new Error('Not signed in') };
  const result = await removeMember(projectId, userId);
  if (!result.error) notifyProjectsChanged();
  return result;
}

// ── Invitations ───────────────────────────────────────────────────────────

// Pending invitations (accepted_at is null) on a project. Admin-only via RLS
// "admins read invitations" policy.
export async function listInvitations(projectId) {
  const { data, error } = await supabase
    .from('project_invitations')
    .select('id, email, role, custom_role_id, token, expires_at, created_at, invited_by')
    .eq('project_id', projectId)
    .is('accepted_at', null)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

// Edge Function calls. Each function bundles auth + admin check + the
// service-role-dependent work (Resend send, RPC-based atomic accept).
// supabase.functions.invoke automatically sends the user JWT in the
// Authorization header so the function can verify it.

// Optional customRoleId is the id of a `custom_roles` row for the project.
// When set, the Edge Function persists it on the invitation; accept_invitation
// then uses the custom role's base_role for the project_members.role enum
// AND copies custom_role_id onto the new member row. Backward-compat: omit
// the arg and behaviour is identical to before.
//
// End-to-end: the stored project name is ciphertext the function can't read,
// so the name the INVITER sees is sent along as `project_display_name` for
// the email alone (the send-invite function should prefer it over the stored
// name when that starts with `e2e:`). It is not stored — but it does reach the
// server and the mail provider, as any name in an email does.
export async function sendInvite(projectId, email, role, customRoleId = null) {
  const body = { project_id: projectId, email, role };
  if (customRoleId) body.custom_role_id = customRoleId;
  try {
    const { data: row } = await supabase.from('projects').select('id, name').eq('id', projectId).maybeSingle();
    const plain = row ? await decryptProjectRow(row) : null;
    if (plain?.name && !plain.name_unreadable) body.project_display_name = plain.name;
  } catch { /* the email falls back to "a project" */ }
  const { data, error } = await supabase.functions.invoke('send-invite', { body });
  return { data, error };
}

// Debug-only: trigger the invite Edge Function with `debug: true`. The
// function skips its capability/upsert path and sends a brand-styled
// preview to the caller's own email — used by the DEBUG menu's "Send
// all email previews" item. No project context required.
export async function sendInviteDebug() {
  const { data, error } = await supabase.functions.invoke('send-invite', {
    body: { debug: true },
  });
  return { data, error };
}

export async function acceptInvite(token) {
  const { data, error } = await supabase.functions.invoke('accept-invite', {
    body: { token },
  });
  // The name comes back as stored — ciphertext. The new member has no key
  // grant yet (an admin's device makes it when they next open the project),
  // so it usually can't be read yet: say "the project" rather than show it.
  if (data && isEncryptedText(data.project_name)) {
    let name = null;
    try {
      const r = await decryptProjectText(data.project_id, data.project_name, { purpose: 'project.name', rowId: data.project_id });
      if (r.ok) name = r.text;
    } catch { /* not granted yet */ }
    return { data: { ...data, project_name: name }, error };
  }
  return { data, error };
}

export async function revokeInvite(invitationId) {
  const { data, error } = await supabase.functions.invoke('revoke-invite', {
    body: { invitation_id: invitationId },
  });
  return { data, error };
}
