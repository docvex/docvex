import { supabase } from './supabaseClient';

// Single source of truth for the four activity-status states. Consumed by
// the StatusBadge (color), the StatusPicker popover in the sidebar, and the
// Activity status section on the Account page — all read label/color/
// description from here so the three surfaces never drift apart.
//
// Status is stored per-user in auth.users.raw_user_meta_data->>'status'
// and surfaced to other members through the get_member_profiles RPC
// (see supabase/migrations/009_get_member_profiles_status.sql).
export const STATUS_OPTIONS = [
  {
    key: 'online',
    label: 'Online',
    color: '#23a55a',
    description: 'Available and active.',
  },
  {
    key: 'idle',
    label: 'Idle',
    color: '#f0b232',
    description: 'Away from the keyboard — replies may be delayed.',
  },
  {
    key: 'dnd',
    label: 'Do Not Disturb',
    color: '#f23f43',
    description: 'Focused work in progress — please don’t ping.',
  },
  {
    key: 'offline',
    label: 'Offline',
    color: '#80848e',
    description: 'Appear offline to other members while staying signed in.',
  },
];

const STATUS_BY_KEY = new Map(STATUS_OPTIONS.map((o) => [o.key, o]));
export const DEFAULT_STATUS_KEY = 'online';

// Resolve a status key (possibly null/unknown) to its option entry. Falls
// back to the default 'online' so callers never have to null-check the
// color / label / description fields.
export function getStatusOption(key) {
  return STATUS_BY_KEY.get(key) ?? STATUS_BY_KEY.get(DEFAULT_STATUS_KEY);
}

// Persist a new status for the current user. Stored in user_metadata so
// supabase-js's USER_UPDATED event fires on success — the local session
// (and every component reading session.user.user_metadata.status) picks
// up the change without any extra wiring. Returns { error } so callers
// can surface the failure via the existing notifications toast pattern.
export async function updateStatus(key) {
  if (!STATUS_BY_KEY.has(key)) {
    return { error: new Error(`Unknown status: ${key}`) };
  }
  const { error } = await supabase.auth.updateUser({ data: { status: key } });
  return { error };
}
