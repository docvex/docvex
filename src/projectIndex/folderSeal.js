// Encryption of what DocVex writes INTO a case folder — the knowledge shards
// (`.docvex/knowledge/…`: text read out of documents, identity readings,
// captions, the AI scan's understanding) and the project settings
// (`.docvex/settings/…`: the scan's web index, the case timeline…). The case
// folder travels: OneDrive / Dropbox, a USB stick, account sync. What the app
// worked out about the people in it must not travel in clear (GDPR art. 25,
// 32), while every member of the project, on every machine, can still read it.
//
// So the key is the PROJECT's, not the machine's: 32 random bytes kept by the
// server per project (`project_folder_keys`, migration 045) and handed only to
// its members (`get_project_folder_key`). The renderer fetches it and gives it
// to the index service, which keeps it in the project's database (sealed with
// this machine's index key) so it works offline afterwards.
//
// A sealed file is JSON — `{ "v": 2, "alg": "A256GCM", "data": base64(iv 12 |
// tag 16 | ciphertext) }` — under its own extension, `.dvxe`, so an older
// DocVex (which reads `.json` only) never mistakes it for a shard of its own
// and never overwrites it. Plain `.json` files older builds wrote are still
// read, and replaced by a sealed file the next time they are written.

import crypto from 'node:crypto';

export const SEALED_EXT = '.dvxe';

export function isFolderKey(buf) {
  return Buffer.isBuffer(buf) && buf.length === 32;
}

export function folderKeyFromBase64(b64) {
  if (typeof b64 !== 'string') return null;
  const buf = Buffer.from(b64, 'base64');
  return isFolderKey(buf) ? buf : null;
}

export function sealForFolder(key, value) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return { v: 2, alg: 'A256GCM', data: Buffer.concat([iv, c.getAuthTag(), body]).toString('base64') };
}

export const isSealedFolderJson = (json) => !!json && typeof json === 'object'
  && json.v === 2 && json.alg === 'A256GCM' && typeof json.data === 'string';

// The value inside a sealed file. Throws without the key, or when the file
// was sealed with another one / altered — callers treat that as unreadable.
export function openFromFolder(key, json) {
  if (!isFolderKey(key)) throw new Error('folder_key_missing');
  const raw = Buffer.from(json.data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}
