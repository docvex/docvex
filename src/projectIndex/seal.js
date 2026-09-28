// Encryption at rest for the index's sensitive columns — the `private` table
// (advisor threads, conversations), the `knowledge` facets (text read out of
// documents, captions, face descriptors) and the project settings. The main
// process hands in a key (random, kept wrapped by the OS key store —
// safeStorage); without one, values are stored as plain JSON as before.
//
// A sealed value is `enc1:` + base64(iv 12 | tag 16 | AES-256-GCM ciphertext).
// Anything else is read as the plain JSON older builds wrote, so an existing
// database keeps working and is sealed row by row as it is written again.

import crypto from 'node:crypto';

const PREFIX = 'enc1:';
let key = null;

export function setIndexKey(buf) {
  key = buf && buf.length === 32 ? Buffer.from(buf) : null;
}

export function sealJson(value) {
  const json = JSON.stringify(value);
  if (!key) return json;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

// Throws on a value it cannot read (a sealed value without the key, or one
// that fails its tag) — callers treat that as a bad row.
export function openJson(stored) {
  const s = String(stored ?? '');
  if (!s.startsWith(PREFIX)) return JSON.parse(s);
  if (!key) throw new Error('index_key_missing');
  const raw = Buffer.from(s.slice(PREFIX.length), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}

// The same for a binary cache entry (the thumbnail cache): `DVX1` + iv + tag +
// ciphertext. Bytes without the marker are an entry older builds wrote.
const MAGIC = Buffer.from('DVX1');
export function hasIndexKey() { return !!key; }
export function sealBytes(buf) {
  if (!key) return buf;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
export function openBytes(buf) {
  if (!buf || buf.length < 4 || !buf.subarray(0, 4).equals(MAGIC)) return buf;
  if (!key) throw new Error('index_key_missing');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  return Buffer.concat([d.update(buf.subarray(32)), d.final()]);
}
