import { supabase } from './supabaseClient';

// Global platform aggregates for the in-app Developer Console (Admin page).
// Backed by the `get_admin_stats` SECURITY DEFINER RPC (migration
// admin_stats_rpc), which reads auth.users + storage.objects and rolls up
// counts across every project. The RPC is gated to an admin email allowlist
// server-side, so a normal member receives a "not authorized" error rather
// than global numbers. Returns { data, error } — data is null on failure.
export async function getAdminStats() {
  const { data, error } = await supabase.rpc('get_admin_stats');
  return { data: data ?? null, error };
}

// ── Admin allowlist management (the `app_admins` table) ─────────────────────
// All three are SECURITY DEFINER RPCs gated on the caller already being an
// admin (is_app_admin()). The allowlist drives who can open the Developer
// Console; removing the last admin is refused server-side to prevent lockout.

// Returns the authorized emails with who added each + when.
export async function listAppAdmins() {
  const { data, error } = await supabase.rpc('list_app_admins');
  return { data: data ?? [], error };
}

// Add an authorized email (idempotent server-side, basic validation).
export async function addAppAdmin(email) {
  const { error } = await supabase.rpc('add_app_admin', { p_email: email });
  return { error };
}

// Remove an authorized email (refused if it's the last admin).
export async function removeAppAdmin(email) {
  const { error } = await supabase.rpc('remove_app_admin', { p_email: email });
  return { error };
}

// ── Service inventory (the `app_services` table) ────────────────────────────
// Owner-maintained subscription list driving the Admin renewals timeline +
// spend math + service cards. All three RPCs are admin-gated SECURITY DEFINER.

// List the full inventory (ordered by sort, provider).
export async function listAppServices() {
  const { data, error } = await supabase.rpc('list_app_services');
  return { data: data ?? [], error };
}

// Insert (no id) or update (with id) a service from a plain object; returns
// the saved row.
export async function upsertAppService(service) {
  const { data, error } = await supabase.rpc('upsert_app_service', { p: service });
  return { data: data ?? null, error };
}

// Delete a service by id.
export async function deleteAppService(id) {
  const { error } = await supabase.rpc('delete_app_service', { p_id: id });
  return { error };
}
