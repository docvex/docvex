// Encryption of what DocVex writes INTO a case folder — the knowledge shards
// (`.docvex/knowledge/…`: text read out of documents, identity readings,
// captions) and the project settings
// (`.docvex/settings/…`: the scan's web index, the case timeline…). The case
// folder travels: OneDrive / Dropbox, a USB stick, account sync. What the app
// worked out about the people in it must not travel in clear (GDPR art. 25,
// 32), while every member of the project, on every machine, can still read it.
//
// So the key is the PROJECT's, not the machine's. Since migration 046 it is
// made and held ONLY by the project's members (lib/e2e/projectKeys: a random
// key per KEY VERSION, wrapped to each member's X25519 identity key) — the
// server never sees it. A project that predates 046 used the server-held key
// of migration 045 as its version 1. The renderer hands the index the whole
// KEY RING (every version it can unwrap; the newest is written with); the
// index keeps it in the project's database (sealed with this machine's index
// key) so it works offline afterwards.
//
// A sealed file is JSON — `{ "v": 2, "alg": "A256GCM", "kv": 3, "data":
// base64(iv 12 | tag 16 | ciphertext) }` — under its own extension, `.dvxe`,
// so an older DocVex (which reads `.json` only) never mistakes it for a shard
// of its own and never overwrites it. `kv` is the key version it was sealed
// with (absent = version 1, written exactly as before 046 — no AAD); a file WITH `kv`
// binds it as AAD, so the field can't be changed to steer a reader to another
// key. Plain `.json` files older builds wrote are still read, and replaced by a
// sealed file the next time they are written.

import crypto from 'node:crypto';

export const SEALED_EXT = '.dvxe';

const isKeyBuf = (buf) => Buffer.isBuffer(buf) && buf.length === 32;

// A KEY RING: { current: Buffer(32), version: n, keys: Map<n, Buffer(32)> }.
// Every function below takes either a ring or a bare 32-byte Buffer (= a ring
// holding that key as version 1), so callers that only pass a key through
// (knowledge.js) need not care which it is.
export function makeFolderKeyRing(entries) {
  const keys = new Map();
  for (const e of entries || []) {
    const v = Number(e?.version) || 1;
    const buf = Buffer.isBuffer(e?.key) ? e.key : folderKeyFromBase64(e?.key);
    if (isKeyBuf(buf) && v >= 1) keys.set(v, buf);
  }
  if (!keys.size) return null;
  const version = Math.max(...keys.keys());
  return { current: keys.get(version), version, keys };
}

const isRing = (k) => !!k && typeof k === 'object' && !Buffer.isBuffer(k)
  && isKeyBuf(k.current) && k.keys instanceof Map;

export function isFolderKey(k) {
  return isKeyBuf(k) || isRing(k);
}

export function folderKeyFromBase64(b64) {
  if (typeof b64 !== 'string') return null;
  const buf = Buffer.from(b64, 'base64');
  return isKeyBuf(buf) ? buf : null;
}

// Two rings (or keys) holding the same versions and bytes.
export function sameFolderKeys(a, b) {
  const ra = isRing(a) ? a : (isKeyBuf(a) ? makeFolderKeyRing([{ version: 1, key: a }]) : null);
  const rb = isRing(b) ? b : (isKeyBuf(b) ? makeFolderKeyRing([{ version: 1, key: b }]) : null);
  if (!ra || !rb || ra.keys.size !== rb.keys.size) return false;
  for (const [v, buf] of ra.keys) if (!rb.keys.get(v)?.equals(buf)) return false;
  return true;
}

// For keeping a ring in the index's meta table (sealed there by the caller).
export function folderRingToJson(k) {
  const ring = isRing(k) ? k : (isKeyBuf(k) ? makeFolderKeyRing([{ version: 1, key: k }]) : null);
  if (!ring) return null;
  return [...ring.keys].map(([version, buf]) => ({ version, key: buf.toString('base64') }));
}

const aadFor = (kv) => Buffer.from(`docvex/folder/v2|kv=${kv}`, 'utf8');

export function sealForFolder(key, value) {
  const ring = isRing(key) ? key : null;
  const buf = ring ? ring.current : key;
  if (!isKeyBuf(buf)) throw new Error('folder_key_missing');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', buf, iv);
  // Version 1 (a bare key, or a ring whose newest is 1) is written as before
  // 046 — no kv, no AAD — so an older build holding the same key still reads
  // it. Only a ROTATED key (version 2+) is marked and bound.
  const kv = ring && ring.version > 1 ? ring.version : null;
  if (kv != null) c.setAAD(aadFor(kv));
  const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  const out = { v: 2, alg: 'A256GCM', data: Buffer.concat([iv, c.getAuthTag(), body]).toString('base64') };
  if (kv != null) out.kv = kv;
  return out;
}

export const isSealedFolderJson = (json) => !!json && typeof json === 'object'
  && json.v === 2 && json.alg === 'A256GCM' && typeof json.data === 'string';

// The value inside a sealed file. Throws without the key (or the key VERSION
// it was sealed with), or when it was sealed with another key / altered —
// callers treat that as unreadable.
export function openFromFolder(key, json) {
  if (!isFolderKey(key)) throw new Error('folder_key_missing');
  const kv = json && json.kv != null ? Number(json.kv) : null;
  let buf;
  if (isRing(key)) buf = key.keys.get(kv == null ? 1 : kv);
  else buf = key;
  if (!isKeyBuf(buf)) throw new Error('folder_key_version_missing');
  const raw = Buffer.from(json.data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', buf, raw.subarray(0, 12));
  if (kv != null) d.setAAD(aadFor(kv));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}
