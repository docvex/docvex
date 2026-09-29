// A project's KEY RING, held only by its members (migration 046).
//
// Each version of a project's key is 32 random bytes made on a member's
// device. The server stores it only SEALED to each member's X25519 identity
// key (`project_key_grants`), so it can't read what the key protects: the
// `.docvex/` shards and settings (src/projectIndex/folderSeal.js), the sync
// objects, manifest and bundles (lib/projectSync, lib/projectSyncData), and
// the chat / project texts (lib/chat, lib/projects).
//
//   getProjectKeyRing(projectId)  → { projectId, current, retired, canGrant,
//                                     keys: Map<version, Uint8Array> } | null
//
// Where a version comes from, in order:
//   1. this user's own grants (unsealed with the identity's private key)
//   2. the legacy server key of migration 045, adopted as VERSION 1 — then
//      granted to every member and the server's copy retired
//   3. nothing at all yet → a new project: a granter makes version 1
// After that, in the background: grant every version this device holds to
// members lacking it (the server lists them), and — when the newest version
// was retired because a member left — make the next version (rotation).
//
// A removed member keeps the versions they had: what was written before they
// left is readable to them (they could read it then). Rotation is what keeps
// them out of everything written after.

import { supabase } from '../supabaseClient';
import { getIdentity } from './identity';
import { sealTo, openSealed } from './primitives';
import { b64dec, b64enc, randomBytes } from './bytes';
import { encryptText, decryptText, isEncryptedText } from './envelope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const grantContext = (projectId, version, userId) => `project-key|${projectId}|v${version}|${userId}`;

const rings = new Map();      // projectId → Promise<ring | null>
const listeners = new Set();
export function subscribeProjectKeys(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const announce = (projectId) => { for (const fn of listeners) { try { fn(projectId); } catch { /* ignore */ } } };

async function myUserId() {
  try { return (await supabase.auth.getSession()).data.session?.user?.id || null; } catch { return null; }
}

// ── Grants ─────────────────────────────────────────────────────────────────
// All of this user's grants, every project, in ONE query — the project list
// decrypts many names at once. Kept 30 s.
let allGrants = null; // { at, userId, promise }
function myGrants(userId, { fresh = false } = {}) {
  if (!fresh && allGrants && allGrants.userId === userId && Date.now() - allGrants.at < 30000) return allGrants.promise;
  const promise = (async () => {
    const { data, error } = await supabase.from('project_key_grants')
      .select('project_id, version, wrapped, recipient_key').eq('user_id', userId);
    if (error) throw error;
    const by = new Map();
    for (const g of data || []) {
      if (!by.has(g.project_id)) by.set(g.project_id, []);
      by.get(g.project_id).push(g);
    }
    return by;
  })();
  allGrants = { at: Date.now(), userId, promise };
  promise.catch(() => { if (allGrants?.promise === promise) allGrants = null; });
  return promise;
}

async function unsealGrants(identity, projectId, grants) {
  const keys = new Map();
  for (const g of grants || []) {
    if (g.recipient_key !== identity.x25519.publicB64) continue; // sealed to an older key of ours
    try {
      const raw = await openSealed(identity.x25519, JSON.parse(g.wrapped), grantContext(projectId, g.version, identity.userId));
      if (raw.length === 32) keys.set(Number(g.version), raw);
    } catch { /* damaged / not ours — ignored, a granter re-seals it */ }
  }
  return keys;
}

async function grantTo({ projectId, userId, version, key, recipientKey, me }) {
  const wrapped = await sealTo(b64dec(recipientKey), key, grantContext(projectId, version, userId));
  const { error } = await supabase.from('project_key_grants').upsert({
    project_id: projectId,
    user_id: userId,
    version,
    wrapped: JSON.stringify(wrapped),
    recipient_key: recipientKey,
    granted_by: me,
  }, { onConflict: 'project_id,user_id,version' });
  return error || null;
}

async function versionState(projectId) {
  const { data, error } = await supabase.rpc('current_project_key_version', { p_project_id: projectId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? {
    version: Number(row.version), retired: !!row.retired, canGrant: !!row.can_grant,
    holders: row.holders == null ? null : Number(row.holders),
  } : null;
}

async function legacyServerKey(projectId) {
  try {
    const { data, error } = await supabase.rpc('get_project_folder_key', { p_project_id: projectId });
    if (error || typeof data !== 'string' || !data) return null;
    const raw = b64dec(data);
    return raw.length === 32 ? raw : null;
  } catch { return null; }
}

// ── The ring ───────────────────────────────────────────────────────────────
// `create: false` never makes a version or adopts the legacy key (the project
// list decrypting names); `fresh: true` re-reads the grants.
export function getProjectKeyRing(projectId, { create = true, fresh = false } = {}) {
  if (!projectId || !UUID.test(String(projectId))) return Promise.resolve(null);
  const cached = rings.get(projectId);
  if (cached && !fresh) {
    // A ring cached by a `create: false` read (the project list) hasn't been
    // through adoption / granting / rotation yet — a full read builds again.
    return cached.then((r) => {
      if (!create || r?.full) return r;
      const now = rings.get(projectId);
      if (now && now !== cached) return now;          // another caller is already building
      return buildAndCache(projectId, { create, fresh: !r });
    });
  }
  return buildAndCache(projectId, { create, fresh });
}

function buildAndCache(projectId, opts) {
  const p = buildRing(projectId, opts).catch(() => null);
  rings.set(projectId, p);
  p.then((r) => { if (!r && rings.get(projectId) === p) rings.delete(projectId); else if (r) announce(projectId); });
  return p;
}

async function buildRing(projectId, { create, fresh }) {
  const identity = await getIdentity();
  if (!identity) return null;
  const me = identity.userId;
  const grants = (await myGrants(me, { fresh }).catch(() => new Map())).get(projectId) || [];
  const keys = await unsealGrants(identity, projectId, grants);
  if (!create) return keys.size ? ringOf(projectId, keys, null) : null;

  let state = null;
  try { state = await versionState(projectId); } catch { /* offline: go with the grants */ }

  // Legacy (045): the server key is version 1 until retired.
  let legacy = null;
  if (!keys.has(1)) {
    legacy = await legacyServerKey(projectId);
    if (legacy) {
      if (!state) {
        const { error } = await supabase.from('project_key_versions').insert({ project_id: projectId, version: 1, created_by: me });
        if (!error || error.code === '23505') state = await versionState(projectId).catch(() => null);
      }
      keys.set(1, legacy);
      await grantTo({ projectId, userId: me, version: 1, key: legacy, recipientKey: identity.x25519.publicB64, me });
      myGrants(me, { fresh: true }).catch(() => {});
    }
  }

  // A project with no key at all: make version 1 (granters only). A newest
  // version NOBODY holds (its maker failed between registering and sealing
  // it) is stepped over the same way.
  if (!keys.size && (!state || (state.holders === 0 && state.canGrant))) {
    const v = state ? state.version + 1 : 1;
    const made = await createVersion(projectId, v, identity);
    if (made) { keys.set(v, made); state = { version: v, retired: false, canGrant: true }; }
  }
  if (!keys.size) return null;

  const ring = { ...ringOf(projectId, keys, state), full: true };
  // Background: hand out what this device holds, retire the server copy,
  // rotate when a member has left.
  maintain(projectId, ring, identity, { hadLegacy: !!legacy }).catch(() => {});
  return ring;
}

function ringOf(projectId, keys, state) {
  const current = Math.max(...keys.keys());
  return {
    projectId,
    keys,
    current,
    // The newest version this device holds is behind the server's newest:
    // it writes with what it has and waits for a grant of the newer one.
    behind: !!state && state.version > current,
    retired: !!state && state.version === current && state.retired,
    // The server's newest version is held by nobody — a granter replaces it.
    orphaned: !!state && state.version > current && state.holders === 0,
    canGrant: !!state?.canGrant,
  };
}

async function createVersion(projectId, version, identity) {
  const key = randomBytes(32);
  const { error } = await supabase.from('project_key_versions').insert({ project_id: projectId, version, created_by: identity.userId });
  if (error) return null;   // not allowed, or another device made it first
  const gErr = await grantTo({ projectId, userId: identity.userId, version, key, recipientKey: identity.x25519.publicB64, me: identity.userId });
  if (gErr) return null;
  myGrants(identity.userId, { fresh: true }).catch(() => {});
  return key;
}

const maintaining = new Map();
function maintain(projectId, ring, identity, { hadLegacy }) {
  if (maintaining.has(projectId)) return maintaining.get(projectId);
  const p = (async () => {
    // Rotation first: the next version is what the missing grants should get.
    if ((ring.retired || ring.orphaned) && ring.canGrant) await rotateProjectKey(projectId, { ring, identity });
    const fresh = rings.get(projectId) ? await rings.get(projectId) : ring;
    await grantMissing(projectId, fresh || ring, identity);
    if (hadLegacy || (fresh || ring).keys.has(1)) {
      await supabase.rpc('retire_server_folder_key', { p_project_id: projectId }).then(() => {}, () => {});
    }
  })().finally(() => { maintaining.delete(projectId); });
  maintaining.set(projectId, p);
  return p;
}

// Seal every version this device holds to each member missing it.
export async function grantMissing(projectId, ring, identity) {
  const id = identity || await getIdentity();
  if (!id || !ring) return 0;
  const { data, error } = await supabase.rpc('project_key_missing_grants', { p_project_id: projectId });
  if (error) return 0;
  let n = 0;
  for (const row of data || []) {
    const key = ring.keys.get(Number(row.version));
    if (!key || !row.x25519) continue;
    const err = await grantTo({ projectId, userId: row.user_id, version: Number(row.version), key, recipientKey: row.x25519, me: id.userId });
    if (!err) n += 1;
  }
  return n;
}

// A new version, granted to every current member with a published key. Run
// by projects.removeMember right after a removal, and on opening a project
// whose newest version was retired by a member leaving.
export async function rotateProjectKey(projectId, { ring = null, identity = null } = {}) {
  const id = identity || await getIdentity();
  if (!id) return null;
  const have = ring || await getProjectKeyRing(projectId);
  let state;
  try { state = await versionState(projectId); } catch { return null; }
  const next = (state?.version || 0) + 1;
  const key = await createVersion(projectId, next, id);
  if (!key) { rings.delete(projectId); return getProjectKeyRing(projectId, { fresh: true }); }
  const keys = new Map(have?.keys || []);
  keys.set(next, key);
  const newRing = { ...ringOf(projectId, keys, { version: next, retired: false, canGrant: true }), full: true };
  rings.set(projectId, Promise.resolve(newRing));
  announce(projectId);
  await grantMissing(projectId, newRing, id);
  return newRing;
}

export function forgetProjectKeys() {
  rings.clear();
  allGrants = null;
}

// For the index (src/projectIndex): the ring as [{ version, key: base64 }].
export const ringToIndexKeys = (ring) => (ring ? [...ring.keys].map(([version, key]) => ({ version, key: b64enc(key) })) : []);

// ── Text columns ───────────────────────────────────────────────────────────
// `purpose` names the column ('chat.body', 'project.name'…), `rowId` the row
// when it is known before writing — both bound into the ciphertext.
export async function encryptProjectText(projectId, plaintext, { purpose, rowId = '' }) {
  let ring = await getProjectKeyRing(projectId);
  // Never write with a version older than the newest: after a rotation that
  // older key is held by someone who has left.
  if (ring?.behind) ring = await getProjectKeyRing(projectId, { fresh: true });
  if (ring?.behind) throw Object.assign(new Error('The project key was renewed and this device hasn’t been given the new one yet — a project admin needs to open the project.'), { code: 'e2e_key_unavailable' });
  if (!ring) throw Object.assign(new Error('This device does not hold the project key yet — a project admin needs to open the project to grant it.'), { code: 'e2e_key_unavailable' });
  return encryptText(ring.keys.get(ring.current), plaintext, { purpose, scope: projectId, keyRef: `p${ring.current}`, rowId });
}

const lastFresh = new Map();
export const UNREADABLE_TEXT = 'Encrypted — this device does not have the key yet';

// → { text, ok }. Plain (pre-encryption) values come back as they are.
export async function decryptProjectText(projectId, value, { purpose, rowId = '', create = false } = {}) {
  if (!isEncryptedText(value)) return { text: value, ok: true, encrypted: false };
  let ring = await getProjectKeyRing(projectId, { create });
  const keyFor = async (ref) => {
    const v = /^p(\d+)$/.exec(ref);
    if (!v) return null;
    let k = ring?.keys.get(Number(v[1]));
    if (!k && Date.now() - (lastFresh.get(projectId) || 0) > 10000) {
      // A version newer than what is cached: re-read the grants (at most
      // every 10 s per project — a list of messages asks many times).
      lastFresh.set(projectId, Date.now());
      ring = await getProjectKeyRing(projectId, { create, fresh: true });
      k = ring?.keys.get(Number(v[1]));
    }
    return k || null;
  };
  return decryptText(keyFor, value, { purpose, scope: projectId, rowId });
}

// A NEW project's first key, made before the project row exists so its name
// is never stored in clear: the caller encrypts with `key` as version 1,
// inserts the project with `id`, then calls this to register the version and
// seal the key to its creator. → true when registered.
export function newProjectKey() { return randomBytes(32); }
export async function registerInitialProjectKey(projectId, key) {
  const identity = await getIdentity();
  if (!identity) return false;
  const { error } = await supabase.from('project_key_versions').insert({ project_id: projectId, version: 1, created_by: identity.userId });
  if (error) return false;
  const gErr = await grantTo({ projectId, userId: identity.userId, version: 1, key, recipientKey: identity.x25519.publicB64, me: identity.userId });
  if (gErr) return false;
  rings.set(projectId, Promise.resolve({ ...ringOf(projectId, new Map([[1, key]]), { version: 1, retired: false, canGrant: true }), full: true }));
  myGrants(identity.userId, { fresh: true }).catch(() => {});
  announce(projectId);
  return true;
}
