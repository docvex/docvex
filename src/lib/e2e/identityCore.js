// A user's IDENTITY KEYS — the pure part (no Supabase, no storage), so it can
// be tested in Node. lib/e2e/identity binds it to the app.
//
//   X25519   what project keys and direct-message keys are sealed TO
//   Ed25519  what this user signs with (the sync manifest)
//
// Serialised (to this machine's safeStorage vault, and inside the recovery
// backup) as { v: 1, userId, createdAt, x25519: { pub, priv }, ed25519: {
// pub, priv } } — public keys raw, private keys PKCS#8, all base64.

import {
  generateX25519, generateEd25519, importX25519Private, importEd25519Private,
  aeadEncrypt, aeadDecrypt, pbkdf2, AEAD_ALG, PBKDF2_ITERATIONS,
} from './primitives';
import { b64enc, b64dec, randomBytes, utf8 } from './bytes';

export async function generateIdentityRecord(userId) {
  const [x, e] = await Promise.all([generateX25519(), generateEd25519()]);
  return {
    v: 1,
    userId,
    createdAt: new Date().toISOString(),
    x25519: { pub: b64enc(x.publicRaw), priv: b64enc(x.privatePkcs8) },
    ed25519: { pub: b64enc(e.publicRaw), priv: b64enc(e.privatePkcs8) },
  };
}

export function isIdentityRecord(r) {
  return !!r && r.v === 1 && typeof r.userId === 'string'
    && typeof r.x25519?.pub === 'string' && typeof r.x25519?.priv === 'string'
    && typeof r.ed25519?.pub === 'string' && typeof r.ed25519?.priv === 'string';
}

// The record as usable keys. Private keys are imported NON-extractable: once
// loaded, nothing in the renderer can read them back out.
export async function loadIdentityRecord(record) {
  if (!isIdentityRecord(record)) throw new Error('bad_identity_record');
  const [xPriv, ePriv] = await Promise.all([
    importX25519Private(b64dec(record.x25519.priv)),
    importEd25519Private(b64dec(record.ed25519.priv)),
  ]);
  return {
    userId: record.userId,
    x25519: { privateKey: xPriv, publicRaw: b64dec(record.x25519.pub), publicB64: record.x25519.pub },
    ed25519: { privateKey: ePriv, publicRaw: b64dec(record.ed25519.pub), publicB64: record.ed25519.pub },
  };
}

// ── Recovery backup ────────────────────────────────────────────────────────
// { v: 1, kdf: 'PBKDF2-SHA256', iter, salt, alg: 'A256GCM', data }
// The server keeps it (user_key_backups) and can't open it without the
// passphrase; its strength IS the passphrase's, so the UI asks for a long one.
const backupAad = (userId) => utf8.enc(`docvex/e2e/v1|identity-backup|${userId}`);
export const MIN_PASSPHRASE = 12;

export async function makeBackup(record, passphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (!isIdentityRecord(record)) throw new Error('bad_identity_record');
  if (String(passphrase || '').length < MIN_PASSPHRASE) throw new Error('passphrase_too_short');
  const salt = randomBytes(16);
  const key = await pbkdf2(passphrase, salt, iterations);
  const data = await aeadEncrypt(key, utf8.enc(JSON.stringify(record)), backupAad(record.userId));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: iterations, salt: b64enc(salt), alg: AEAD_ALG, data: b64enc(data) };
}

export async function openBackup(blob, passphrase, userId) {
  if (!blob || blob.v !== 1 || blob.kdf !== 'PBKDF2-SHA256' || blob.alg !== AEAD_ALG) throw new Error('bad_backup');
  const key = await pbkdf2(passphrase, b64dec(blob.salt), Number(blob.iter) || PBKDF2_ITERATIONS);
  let plain;
  try { plain = await aeadDecrypt(key, b64dec(blob.data), backupAad(userId)); } catch { throw new Error('wrong_passphrase'); }
  const record = JSON.parse(utf8.dec(plain));
  if (!isIdentityRecord(record) || record.userId !== userId) throw new Error('bad_backup');
  return record;
}
