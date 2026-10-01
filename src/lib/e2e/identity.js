// The signed-in user's identity keys on THIS device (lib/e2e/identityCore).
//
// Where they live:
//   private keys  this machine only — main's safeStorage vault (the same
//                 `vault:get` / `vault:put` bridge the pseudonymisation vault
//                 uses, id `identity-<userId>`), never in localStorage
//   public keys   `user_public_keys` (migration 046) — readable by users who
//                 share a project, written only by their owner
//   recovery      `user_key_backups` — the private keys under a key derived
//                 from a passphrase only the user knows (PBKDF2, 600k)
//
// ONE identity per user, across their devices: the first device generates it;
// every later device must RESTORE it from the recovery backup (status
// 'needs-recovery') — generating a second one would orphan every project key
// already sealed to the first. `resetIdentity` exists for a user who lost the
// passphrase too: it publishes a new key, and every project key must then be
// granted again by another member (lib/e2e/projectKeys does that on its own
// when the member next opens the project).

import { supabase } from '../supabaseClient';
import {
  generateIdentityRecord, isIdentityRecord, loadIdentityRecord, makeBackup, openBackup,
} from './identityCore';

const vaultId = (userId) => `identity-${userId}`;

let storage = {
  async load(userId) {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.vaultGet) throw new Error('vault_unavailable');
    const res = await api.vaultGet(vaultId(userId));
    if (res?.error) throw new Error(res.error);
    return res?.data ? JSON.parse(res.data) : null;
  },
  async save(userId, record) {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.vaultPut) throw new Error('vault_unavailable');
    const res = await api.vaultPut(vaultId(userId), record ? JSON.stringify(record) : '');
    if (res?.error) throw new Error(res.error);
  },
};
// Tests swap the store.
export function setIdentityStorage(s) { storage = s; }

// ── State the UI can follow (components/KeyRecoveryPanel) ──────────────────
//   unknown         not looked yet
//   ready           keys loaded and matching what is published
//   needs-recovery  published elsewhere, not on this device → restore
//   mismatch        this device holds a key that is NOT the published one
//   unavailable     no safe place to keep a private key (no vault bridge /
//                   no OS encryption) — nothing end-to-end works here
//   signed-out
let state = { status: 'unknown', userId: null, error: null, hasBackup: null };
const listeners = new Set();
function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) { try { fn(state); } catch { /* a listener */ } }
}
export const identityState = () => state;
export function subscribeIdentity(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let loaded = null;       // { userId, identity }
let ensuring = null;     // Promise

async function currentUserId() {
  try { return (await supabase.auth.getSession()).data.session?.user?.id || null; } catch { return null; }
}

async function fetchPublished(userId) {
  const { data, error } = await supabase.from('user_public_keys')
    .select('user_id, x25519, ed25519').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function publish(record, { replace = false } = {}) {
  const row = { user_id: record.userId, x25519: record.x25519.pub, ed25519: record.ed25519.pub };
  const q = replace
    ? supabase.from('user_public_keys').upsert(row, { onConflict: 'user_id' })
    : supabase.from('user_public_keys').insert(row);
  const { error } = await q;
  return error || null;
}

const matches = (record, pub) => !!pub && pub.x25519 === record.x25519.pub && pub.ed25519 === record.ed25519.pub;

// The identity, made ready if it can be. Never throws; null when not ready
// (see identityState().status for why).
export function ensureIdentity() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const userId = await currentUserId();
    if (!userId) { loaded = null; setState({ status: 'signed-out', userId: null }); return null; }
    if (loaded?.userId === userId && state.status === 'ready') return loaded.identity;
    let record = null;
    try { record = await storage.load(userId); } catch (err) {
      setState({ status: 'unavailable', userId, error: String(err?.message || err) });
      return null;
    }
    if (record && !isIdentityRecord(record)) record = null;
    let published;
    try { published = await fetchPublished(userId); } catch (err) {
      // Offline: a local identity still works for everything local (opening
      // what was already granted); nothing new is published.
      if (record) {
        loaded = { userId, identity: await loadIdentityRecord(record) };
        setState({ status: 'ready', userId, error: null });
        return loaded.identity;
      }
      setState({ status: 'unknown', userId, error: String(err?.message || err) });
      return null;
    }
    if (record) {
      if (!published) {
        const err = await publish(record);
        if (err) {
          // Another device of this user published first (a race) — theirs wins.
          const again = await fetchPublished(userId).catch(() => null);
          if (again && !matches(record, again)) { setState({ status: 'mismatch', userId }); return null; }
        }
      } else if (!matches(record, published)) {
        setState({ status: 'mismatch', userId, error: null });
        return null;
      }
      loaded = { userId, identity: await loadIdentityRecord(record) };
      setState({ status: 'ready', userId, error: null });
      return loaded.identity;
    }
    if (published) { setState({ status: 'needs-recovery', userId, error: null }); return null; }
    // First device: make it.
    const fresh = await generateIdentityRecord(userId);
    try { await storage.save(userId, fresh); } catch (err) {
      setState({ status: 'unavailable', userId, error: String(err?.message || err) });
      return null;
    }
    const pErr = await publish(fresh);
    if (pErr) {
      const again = await fetchPublished(userId).catch(() => null);
      if (!again || !matches(fresh, again)) {
        await storage.save(userId, null).catch(() => {});
        setState({ status: again ? 'needs-recovery' : 'unknown', userId, error: again ? null : String(pErr.message || pErr) });
        return null;
      }
    }
    loaded = { userId, identity: await loadIdentityRecord(fresh) };
    setState({ status: 'ready', userId, error: null, hasBackup: false });
    return loaded.identity;
  })().finally(() => { ensuring = null; });
  return ensuring;
}

export async function getIdentity() {
  const userId = await currentUserId();
  if (loaded && loaded.userId === userId && state.status === 'ready') return loaded.identity;
  return ensureIdentity();
}

// Sign-out / erase data.
export function forgetIdentity() {
  loaded = null;
  setState({ status: 'unknown', userId: null, error: null, hasBackup: null });
}

// ── Public keys of others ──────────────────────────────────────────────────
const pubCache = new Map(); // userId → { at, row }
const PUB_TTL = 60 * 1000;
export async function publicKeysOf(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const out = new Map();
  const need = [];
  for (const id of ids) {
    const c = pubCache.get(id);
    if (c && Date.now() - c.at < PUB_TTL) { if (c.row) out.set(id, c.row); } else need.push(id);
  }
  if (need.length) {
    const { data, error } = await supabase.from('user_public_keys').select('user_id, x25519, ed25519').in('user_id', need);
    if (!error) {
      const got = new Map((data || []).map((r) => [r.user_id, r]));
      for (const id of need) { pubCache.set(id, { at: Date.now(), row: got.get(id) || null }); if (got.get(id)) out.set(id, got.get(id)); }
    }
  }
  return out;
}

// ── Recovery ───────────────────────────────────────────────────────────────
export async function hasRecoveryBackup() {
  const userId = await currentUserId();
  if (!userId) return false;
  const { data, error } = await supabase.from('user_key_backups').select('user_id').eq('user_id', userId).maybeSingle();
  const has = !error && !!data;
  setState({ hasBackup: has });
  return has;
}

// Save (or replace) the recovery copy of THIS device's keys.
export async function saveRecoveryBackup(passphrase) {
  const userId = await currentUserId();
  if (!userId) throw new Error('signed_out');
  const record = await storage.load(userId);
  if (!isIdentityRecord(record)) throw new Error('no_identity_on_this_device');
  const blob = await makeBackup(record, passphrase);
  const { error } = await supabase.from('user_key_backups')
    .upsert({ user_id: userId, blob: JSON.stringify(blob), updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
  setState({ hasBackup: true });
  return true;
}

// Bring the keys onto this device from the recovery copy.
export async function restoreIdentity(passphrase) {
  const userId = await currentUserId();
  if (!userId) throw new Error('signed_out');
  const { data, error } = await supabase.from('user_key_backups').select('blob').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data?.blob) throw new Error('no_backup');
  const record = await openBackup(JSON.parse(data.blob), passphrase, userId);
  const published = await fetchPublished(userId).catch(() => null);
  if (published && !matches(record, published)) throw new Error('backup_is_not_the_published_key');
  await storage.save(userId, record);
  loaded = null;
  return ensureIdentity();
}

// Last resort: a NEW identity (everything sealed to the old one becomes
// unreadable to this user until another member grants it again).
export async function resetIdentity() {
  const userId = await currentUserId();
  if (!userId) throw new Error('signed_out');
  const fresh = await generateIdentityRecord(userId);
  await storage.save(userId, fresh);
  const err = await publish(fresh, { replace: true });
  if (err) throw err;
  // The old backup no longer matches — drop it so it can't be "restored".
  await supabase.from('user_key_backups').delete().eq('user_id', userId);
  pubCache.delete(userId);
  loaded = null;
  setState({ hasBackup: false });
  return ensureIdentity();
}
