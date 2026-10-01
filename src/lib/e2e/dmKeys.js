// A direct-message conversation's key (migration 046, `dm_conversation_keys`):
// 32 random bytes made by whichever of the two writes first, sealed to BOTH
// people's X25519 identity keys. Each message names the key it was written
// with (`e2e:v1:d<keyId>:…`), so a second key made in a race — or after one of
// them reset their identity — doesn't cost the older messages.

import { supabase } from '../supabaseClient';
import { getIdentity, publicKeysOf } from './identity';
import { sealTo, openSealed } from './primitives';
import { b64dec, randomBytes } from './bytes';
import { encryptText, decryptText, isEncryptedText } from './envelope';

const pairOf = (a, b) => (a < b ? [a, b] : [b, a]);
const ctx = (projectId, keyId, userId) => `dm-key|${projectId}|${keyId}|${userId}`;
const cache = new Map();   // `${projectId}|${low}|${high}` → Promise<{ keys: Map<id, bytes>, newest }>

async function loadPair(projectId, a, b, { fresh = false } = {}) {
  const [low, high] = pairOf(a, b);
  const k = `${projectId}|${low}|${high}`;
  if (!fresh && cache.has(k)) return cache.get(k);
  const p = (async () => {
    const identity = await getIdentity();
    if (!identity) return null;
    const { data, error } = await supabase.from('dm_conversation_keys')
      .select('id, user_low, user_high, wrapped_low, wrapped_high, low_key, high_key, created_at')
      .eq('project_id', projectId).eq('user_low', low).eq('user_high', high)
      .order('created_at', { ascending: true });
    if (error) throw error;
    const keys = new Map();
    let newest = null;
    for (const row of data || []) {
      const mine = identity.userId === row.user_low
        ? { wrapped: row.wrapped_low, pub: row.low_key }
        : { wrapped: row.wrapped_high, pub: row.high_key };
      if (mine.pub !== identity.x25519.publicB64) continue;
      try {
        const raw = await openSealed(identity.x25519, JSON.parse(mine.wrapped), ctx(projectId, row.id, identity.userId));
        if (raw.length === 32) { keys.set(row.id, raw); newest = row.id; }
      } catch { /* not openable on this key */ }
    }
    return { keys, newest, identity };
  })();
  cache.set(k, p);
  p.catch(() => cache.delete(k));
  return p;
}

// The key to WRITE with: the newest this device can open, or a new one when
// there is none and both people have published keys.
async function keyForWriting(projectId, me, partner) {
  const got = await loadPair(projectId, me, partner);
  if (!got) return null;
  if (got.newest) {
    // Still sealed to the partner's current key? If they reset theirs, a new
    // conversation key is made so they can read what is sent from now on.
    const pubs = await publicKeysOf([partner]);
    const cur = pubs.get(partner)?.x25519;
    const { data } = await supabase.from('dm_conversation_keys')
      .select('user_low, low_key, high_key').eq('id', got.newest).maybeSingle();
    const theirs = data ? (data.user_low === partner ? data.low_key : data.high_key) : null;
    if (!cur || cur === theirs) return { id: got.newest, key: got.keys.get(got.newest) };
  }
  const pubs = await publicKeysOf([me, partner]);
  const myPub = got.identity.x25519.publicB64;
  const theirPub = pubs.get(partner)?.x25519;
  if (!theirPub) return null;
  const [low, high] = pairOf(me, partner);
  const id = globalThis.crypto.randomUUID();
  const key = randomBytes(32);
  const lowPub = low === me ? myPub : theirPub;
  const highPub = high === me ? myPub : theirPub;
  const row = {
    id,
    project_id: projectId,
    user_low: low,
    user_high: high,
    wrapped_low: JSON.stringify(await sealTo(b64dec(lowPub), key, ctx(projectId, id, low))),
    wrapped_high: JSON.stringify(await sealTo(b64dec(highPub), key, ctx(projectId, id, high))),
    low_key: lowPub,
    high_key: highPub,
    created_by: me,
  };
  const { error } = await supabase.from('dm_conversation_keys').insert(row);
  if (error) return null;
  cache.delete(`${projectId}|${low}|${high}`);
  return { id, key };
}

export async function encryptDmText(projectId, me, partner, plaintext, { rowId = '' } = {}) {
  const k = await keyForWriting(projectId, me, partner);
  if (!k) throw Object.assign(new Error('This message can’t be encrypted yet — the other person hasn’t opened the updated DocVex.'), { code: 'e2e_key_unavailable' });
  return encryptText(k.key, plaintext, { purpose: 'dm.body', scope: `${projectId}|${pairOf(me, partner).join('|')}`, keyRef: `d${k.id}`, rowId });
}

export async function decryptDmText(projectId, a, b, value, { rowId = '' } = {}) {
  if (!isEncryptedText(value)) return { text: value, ok: true, encrypted: false };
  let got = await loadPair(projectId, a, b).catch(() => null);
  const keyFor = async (ref) => {
    const id = ref.startsWith('d') ? ref.slice(1) : null;
    if (!id) return null;
    if (!got?.keys.has(id)) got = await loadPair(projectId, a, b, { fresh: true }).catch(() => null);
    return got?.keys.get(id) || null;
  };
  return decryptText(keyFor, value, { purpose: 'dm.body', scope: `${projectId}|${pairOf(a, b).join('|')}`, rowId });
}

export function forgetDmKeys() { cache.clear(); }
