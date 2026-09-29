// The cryptographic primitives of end-to-end encryption — WebCrypto only
// (Chromium in Electron 42, and Node 22 for the tests):
//
//   AES-256-GCM        content, key wrapping (a 12-byte random IV per message,
//                      the 16-byte tag appended — WebCrypto's layout)
//   X25519 + HKDF      `sealTo(pub, bytes)` / `openSealed(priv, blob)`: an
//                      ECIES-style box — an EPHEMERAL X25519 key agrees a secret
//                      with the recipient's key, HKDF-SHA256 (salt = both public
//                      keys) derives an AES-256-GCM key, the payload goes under
//                      it. Anyone can seal to a public key; only the private key
//                      opens it. No sender authentication — callers that need
//                      it sign separately (Ed25519).
//   Ed25519            signatures (the sync manifest)
//   PBKDF2-SHA256      the recovery passphrase (600,000 iterations)
//
// `alg` names travel in every envelope so a hybrid post-quantum KEM
// (X25519 + ML-KEM-768) can be added as another value without touching what
// is already stored — see SEAL_ALG and `sealTo`'s switch.

import { concat, toBytes, utf8, b64enc, b64dec } from './bytes';

const subtle = () => globalThis.crypto.subtle;

export const AEAD_ALG = 'A256GCM';
export const SEAL_ALG = 'X25519-HKDF-SHA256-A256GCM';
export const SIG_ALG = 'Ed25519';
export const PBKDF2_ITERATIONS = 600000;

// ── AES-256-GCM ────────────────────────────────────────────────────────────
export async function importAesKey(raw, usages = ['encrypt', 'decrypt']) {
  const b = toBytes(raw);
  if (b.length !== 32) throw new Error('bad_key_length');
  return subtle().importKey('raw', b, 'AES-GCM', false, usages);
}
const asAesKey = async (k) => (k instanceof Uint8Array || ArrayBuffer.isView(k) ? importAesKey(k) : k);

// → iv(12) | ciphertext | tag(16)
export async function aeadEncrypt(key, plaintext, aad) {
  const k = await asAesKey(key);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const params = { name: 'AES-GCM', iv };
  if (aad != null) params.additionalData = toBytes(aad);
  const ct = new Uint8Array(await subtle().encrypt(params, k, toBytes(plaintext)));
  return concat(iv, ct);
}
export async function aeadDecrypt(key, blob, aad) {
  const k = await asAesKey(key);
  const b = toBytes(blob);
  if (b.length < 28) throw new Error('ciphertext_too_short');
  const params = { name: 'AES-GCM', iv: b.subarray(0, 12) };
  if (aad != null) params.additionalData = toBytes(aad);
  return new Uint8Array(await subtle().decrypt(params, k, b.subarray(12)));
}

// ── HKDF ───────────────────────────────────────────────────────────────────
export async function hkdf(ikm, { salt = new Uint8Array(0), info = '', length = 32 } = {}) {
  const base = await subtle().importKey('raw', toBytes(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: toBytes(salt), info: toBytes(info) }, base, length * 8);
  return new Uint8Array(bits);
}

// ── X25519 ─────────────────────────────────────────────────────────────────
export async function generateX25519() {
  const kp = await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits']);
  return {
    publicRaw: new Uint8Array(await subtle().exportKey('raw', kp.publicKey)),
    privatePkcs8: new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey)),
  };
}
export const importX25519Public = (raw) => subtle().importKey('raw', toBytes(raw), { name: 'X25519' }, true, []);
export const importX25519Private = (pkcs8, extractable = false) => subtle().importKey('pkcs8', toBytes(pkcs8), { name: 'X25519' }, extractable, ['deriveBits']);

async function x25519(priv, pub) {
  return new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: pub }, priv, 256));
}

// ── Ed25519 ────────────────────────────────────────────────────────────────
export async function generateEd25519() {
  const kp = await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    publicRaw: new Uint8Array(await subtle().exportKey('raw', kp.publicKey)),
    privatePkcs8: new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey)),
  };
}
export const importEd25519Public = (raw) => subtle().importKey('raw', toBytes(raw), { name: 'Ed25519' }, true, ['verify']);
export const importEd25519Private = (pkcs8, extractable = false) => subtle().importKey('pkcs8', toBytes(pkcs8), { name: 'Ed25519' }, extractable, ['sign']);

export async function sign(privKey, message) {
  return new Uint8Array(await subtle().sign({ name: 'Ed25519' }, privKey, toBytes(message)));
}
export async function verify(pubKeyOrRaw, signature, message) {
  try {
    const pub = pubKeyOrRaw instanceof Uint8Array || typeof pubKeyOrRaw === 'string'
      ? await importEd25519Public(typeof pubKeyOrRaw === 'string' ? b64dec(pubKeyOrRaw) : pubKeyOrRaw)
      : pubKeyOrRaw;
    return await subtle().verify({ name: 'Ed25519' }, pub, toBytes(signature), toBytes(message));
  } catch { return false; }
}

// ── Sealed box (ECIES) ─────────────────────────────────────────────────────
// Blob: { alg, epk: b64(ephemeral public 32), ct: b64(iv|ciphertext|tag) }
// `context` (a string: purpose + scope, e.g. "project-key|<pid>|v3") is bound
// twice — in the HKDF info and as AAD — so a wrapped key can't be replayed
// into another slot.
export async function sealTo(recipientPublicRaw, plaintext, context = '') {
  const rpub = toBytes(typeof recipientPublicRaw === 'string' ? b64dec(recipientPublicRaw) : recipientPublicRaw);
  if (rpub.length !== 32) throw new Error('bad_public_key');
  const eph = await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const epk = new Uint8Array(await subtle().exportKey('raw', eph.publicKey));
  const shared = await x25519(eph.privateKey, await importX25519Public(rpub));
  const key = await hkdf(shared, { salt: concat(epk, rpub), info: `docvex/e2e/seal/v1|${context}` });
  const ct = await aeadEncrypt(key, plaintext, utf8.enc(`${SEAL_ALG}|${context}`));
  return { alg: SEAL_ALG, epk: b64enc(epk), ct: b64enc(ct) };
}

// `recipient` = { privateKey: CryptoKey (X25519), publicRaw: Uint8Array }.
export async function openSealed(recipient, blob, context = '') {
  if (!blob || typeof blob !== 'object') throw new Error('bad_sealed_blob');
  if (blob.alg !== SEAL_ALG) throw new Error(`unsupported_alg:${blob.alg}`);
  const epk = b64dec(blob.epk);
  const shared = await x25519(recipient.privateKey, await importX25519Public(epk));
  const key = await hkdf(shared, { salt: concat(epk, toBytes(recipient.publicRaw)), info: `docvex/e2e/seal/v1|${context}` });
  return aeadDecrypt(key, b64dec(blob.ct), utf8.enc(`${SEAL_ALG}|${context}`));
}

// ── Passphrase ─────────────────────────────────────────────────────────────
export async function pbkdf2(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle().importKey('raw', utf8.enc(String(passphrase).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: toBytes(salt), iterations }, base, 256);
  return new Uint8Array(bits);
}

// A short, human-comparable fingerprint of a public key (safety number): the
// first 20 bytes of SHA-256 as 5 groups of 8 hex digits.
export async function fingerprint(publicRaw) {
  const d = new Uint8Array(await subtle().digest('SHA-256', toBytes(typeof publicRaw === 'string' ? b64dec(publicRaw) : publicRaw)));
  const hex = Array.from(d.subarray(0, 20), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{8}/g).join(' ');
}
