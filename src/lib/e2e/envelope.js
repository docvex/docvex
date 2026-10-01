// The stored formats of end-to-end encryption. Every one names its version
// and algorithm, and binds WHERE it belongs as AES-GCM additional data (AAD),
// so a ciphertext copied into another row, project, key version or purpose
// fails to open instead of being read as something it isn't.
//
//   TEXT (a text column — chat bodies, project names…)
//     e2e:v1:<keyRef>:<base64url(iv | ciphertext | tag)>
//     keyRef = "p<version>" (the project's key of that version)
//            | "d<keyId>"   (a direct-message conversation key)
//     AAD    = docvex/e2e/v1|text|<purpose>|<scope>|<keyRef>|<rowId>
//
//   JSON (a whole document — a sync bundle, the sync manifest's body)
//     { e2e: 1, alg: "A256GCM", kv, purpose, data: base64(iv | ct | tag) }
//     AAD    = docvex/e2e/v1|json|<purpose>|<scope>|kv=<kv>
//
//   FILE PART (one object of a synced file, lib/projectSync)
//     raw bytes: iv | ciphertext | tag, under the file's own random key
//     AAD    = docvex/e2e/v1|part|<projectId>|<fileKeyId>|<index>|<total>|<kv>
//
//   WRAPPED KEY (a file key under the project key)
//     base64(iv | ct | tag); AAD = docvex/e2e/v1|wrap|<purpose>|<scope>|<id>|kv=<kv>
//
// Values that don't start with `e2e:v1:` are rows written before encryption
// and are read as they are (`isEncryptedText`).

import { aeadDecrypt, aeadEncrypt, AEAD_ALG, sign, verify } from './primitives';
import { b64dec, b64enc, b64urldec, b64urlenc, canonicalJson, utf8 } from './bytes';

export const TEXT_PREFIX = 'e2e:v1:';

// ── Text ───────────────────────────────────────────────────────────────────
const textAad = ({ purpose, scope, keyRef, rowId }) => utf8.enc(
  `docvex/e2e/v1|text|${purpose || ''}|${scope || ''}|${keyRef}|${rowId || ''}`,
);

export const isEncryptedText = (s) => typeof s === 'string' && s.startsWith(TEXT_PREFIX);

export function parseTextEnvelope(s) {
  if (!isEncryptedText(s)) return null;
  const rest = s.slice(TEXT_PREFIX.length);
  const i = rest.indexOf(':');
  if (i <= 0) return null;
  const keyRef = rest.slice(0, i);
  if (!/^(p\d+|d[0-9a-zA-Z-]+)$/.test(keyRef)) return null;
  return { keyRef, data: rest.slice(i + 1) };
}

export async function encryptText(key, plaintext, { purpose, scope, keyRef, rowId = '' }) {
  if (!keyRef) throw new Error('keyRef required');
  const ct = await aeadEncrypt(key, utf8.enc(String(plaintext ?? '')), textAad({ purpose, scope, keyRef, rowId }));
  return `${TEXT_PREFIX}${keyRef}:${b64urlenc(ct)}`;
}

// `keyFor(keyRef)` → key bytes / CryptoKey, or null when this device lacks it.
// Returns { text, ok } — ok false when it can't be opened (no key, tampered).
export async function decryptText(keyFor, value, { purpose, scope, rowId = '' }) {
  if (!isEncryptedText(value)) return { text: value, ok: true, encrypted: false };
  const env = parseTextEnvelope(value);
  if (!env) return { text: null, ok: false, encrypted: true, reason: 'malformed' };
  const key = await keyFor(env.keyRef);
  if (!key) return { text: null, ok: false, encrypted: true, reason: 'no_key', keyRef: env.keyRef };
  try {
    const plain = await aeadDecrypt(key, b64urldec(env.data), textAad({ purpose, scope, keyRef: env.keyRef, rowId }));
    return { text: utf8.dec(plain), ok: true, encrypted: true };
  } catch {
    return { text: null, ok: false, encrypted: true, reason: 'bad_ciphertext', keyRef: env.keyRef };
  }
}

// ── JSON documents ─────────────────────────────────────────────────────────
const jsonAad = ({ purpose, scope, kv }) => utf8.enc(`docvex/e2e/v1|json|${purpose}|${scope}|kv=${kv}`);

export const isJsonEnvelope = (j) => !!j && typeof j === 'object' && j.e2e === 1
  && typeof j.alg === 'string' && typeof j.data === 'string' && Number.isInteger(j.kv);

export async function sealJsonDoc(key, kv, value, { purpose, scope }) {
  const data = await aeadEncrypt(key, utf8.enc(JSON.stringify(value)), jsonAad({ purpose, scope, kv }));
  return { e2e: 1, alg: AEAD_ALG, kv, purpose, data: b64enc(data) };
}

// `keyFor(kv)` → key or null.
export async function openJsonDoc(keyFor, env, { purpose, scope }) {
  if (!isJsonEnvelope(env)) throw new Error('not_an_envelope');
  if (env.alg !== AEAD_ALG) throw new Error(`unsupported_alg:${env.alg}`);
  if (env.purpose !== purpose) throw new Error('wrong_purpose');
  const key = await keyFor(env.kv);
  if (!key) throw Object.assign(new Error('no_key_for_version'), { code: 'no_key', kv: env.kv });
  const plain = await aeadDecrypt(key, b64dec(env.data), jsonAad({ purpose, scope, kv: env.kv }));
  return JSON.parse(utf8.dec(plain));
}

// ── Wrapped keys ───────────────────────────────────────────────────────────
const wrapAad = ({ purpose, scope, id, kv }) => utf8.enc(`docvex/e2e/v1|wrap|${purpose}|${scope}|${id}|kv=${kv}`);
export async function wrapKeyWith(kek, keyBytes, ctx) {
  return b64enc(await aeadEncrypt(kek, keyBytes, wrapAad(ctx)));
}
export async function unwrapKeyWith(kek, wrapped, ctx) {
  return aeadDecrypt(kek, b64dec(wrapped), wrapAad(ctx));
}

// ── File parts ─────────────────────────────────────────────────────────────
const partAad = ({ projectId, fileKeyId, index, total, kv }) => utf8.enc(
  `docvex/e2e/v1|part|${projectId}|${fileKeyId}|${index}|${total}|${kv}`,
);
export const encryptPart = (fileKey, bytes, ctx) => aeadEncrypt(fileKey, bytes, partAad(ctx));
export const decryptPart = (fileKey, bytes, ctx) => aeadDecrypt(fileKey, bytes, partAad(ctx));
// A part's ciphertext is its plaintext + 28 bytes (IV + tag).
export const PART_OVERHEAD = 28;

// ── Signed documents ───────────────────────────────────────────────────────
// The signature covers every field of the document but `sig` itself, in
// canonical JSON, under a domain tag naming what it is.
const signedMessage = (domain, doc) => {
  const { sig, ...rest } = doc;
  return utf8.enc(`docvex/e2e/v1|sig|${domain}|${canonicalJson(rest)}`);
};
export async function signDoc(signingKey, domain, doc) {
  const s = await sign(signingKey, signedMessage(domain, doc));
  return { ...doc, sig: b64enc(s) };
}
export async function verifyDoc(publicRaw, domain, doc) {
  if (!doc || typeof doc.sig !== 'string') return false;
  return verify(publicRaw, b64dec(doc.sig), signedMessage(domain, doc));
}
