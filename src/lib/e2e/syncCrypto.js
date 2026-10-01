// End-to-end encryption of ACCOUNT SYNC (lib/projectSync) — pure functions
// over a key ring and an identity, so they can be tested without Supabase.
//
// A FILE goes up under a key of its own: 32 random bytes (`fileKey`, id
// `kid`), wrapped by the project key of the current version and kept — with
// the file's path, size and modified time — only inside the encrypted
// manifest. The file is cut into parts (≤45 MB of plaintext each, the
// bucket's 50 MB cap less headroom) and each part sealed on its own: a fresh
// IV, AAD = project | kid | index | total | key version. Objects are named by
// a RANDOM id — nothing about the path reaches the server.
//
// The MANIFEST is a JSON document sealed with the project key (purpose
// 'sync.manifest') and SIGNED with the writer's Ed25519 identity key. The
// signature covers the envelope — ciphertext, key version, project, signer,
// sequence number — so a manifest can be neither forged nor edited by the
// server; `seq` rises with every write, so a device refuses an older one it
// is handed back (rollback).

import { randomBytes, randomId, toBytes } from './bytes';
import {
  sealJsonDoc, openJsonDoc, isJsonEnvelope, signDoc, verifyDoc,
  wrapKeyWith, unwrapKeyWith, encryptPart, decryptPart,
} from './envelope';
import { SIG_ALG } from './primitives';

export const MANIFEST_KIND = 'docvex/sync-manifest';
export const PART_PLAIN_BYTES = 45 * 1024 * 1024;

const fileWrapCtx = (projectId, kid, kv) => ({ purpose: 'sync.file', scope: projectId, id: kid, kv });

// ── Files ──────────────────────────────────────────────────────────────────
// A new file key + where the file's parts will go. `size` decides the part
// count; zero-byte files still have one (empty) part.
export async function newFileEntry(ring, projectId, size, { partBytes = PART_PLAIN_BYTES } = {}) {
  const kv = ring.current;
  const fileKey = randomBytes(32);
  const kid = randomId(12);
  const fk = await wrapKeyWith(ring.keys.get(kv), fileKey, fileWrapCtx(projectId, kid, kv));
  const parts = Math.max(1, Math.ceil((Number(size) || 0) / partBytes));
  return { entry: { enc: 1, obj: randomId(16), kid, fk, kv, parts, psize: partBytes }, fileKey };
}

export async function fileKeyOf(ring, projectId, entry) {
  const pk = ring.keys.get(Number(entry.kv));
  if (!pk) throw Object.assign(new Error('no_key_for_version'), { code: 'no_key', kv: entry.kv });
  const k = await unwrapKeyWith(pk, entry.fk, fileWrapCtx(projectId, entry.kid, Number(entry.kv)));
  if (k.length !== 32) throw new Error('bad_file_key');
  return k;
}

export const partObjectName = (projectId, entry, i) => `${projectId}/${entry.obj}.${i}`;
export const objectNamesOf = (projectId, entry) => Array.from({ length: entry.parts }, (_, i) => partObjectName(projectId, entry, i));

const partCtx = (projectId, entry, index) => ({
  projectId, fileKeyId: entry.kid, index, total: entry.parts, kv: Number(entry.kv),
});

// `read(start, end)` → Promise<Uint8Array | ArrayBuffer> of the plaintext.
export async function encryptFilePart(fileKey, projectId, entry, index, read, size) {
  const start = index * entry.psize;
  const end = Math.min(Number(size) || 0, start + entry.psize);
  const plain = end > start ? toBytes(await read(start, end)) : new Uint8Array(0);
  return encryptPart(fileKey, plain, partCtx(projectId, entry, index));
}

export async function decryptFilePart(fileKey, projectId, entry, index, bytes) {
  return decryptPart(fileKey, toBytes(bytes), partCtx(projectId, entry, index));
}

// ── The manifest ───────────────────────────────────────────────────────────
export const isEncryptedManifest = (j) => isJsonEnvelope(j) && j.kind === MANIFEST_KIND;

// identity: { userId, ed25519: { privateKey, publicB64 } }
export async function sealManifest(ring, identity, projectId, manifest, seq) {
  const env = await sealJsonDoc(ring.keys.get(ring.current), ring.current, { ...manifest, seq }, { purpose: 'sync.manifest', scope: projectId });
  const doc = {
    ...env,
    kind: MANIFEST_KIND,
    projectId,
    seq,
    signer: identity.userId,
    signerKey: identity.ed25519.publicB64,
    sigAlg: SIG_ALG,
    at: new Date().toISOString(),
  };
  return signDoc(identity.ed25519.privateKey, MANIFEST_KIND, doc);
}

// `signerKeyOf(userId)` → the signer's PUBLISHED Ed25519 key (base64) or null;
// `isMember(userId)` → whether they are (still) in the project. Throws with a
// `code`: manifest_wrong_project | manifest_unverified | no_key.
export async function openManifest(ring, projectId, doc, { signerKeyOf, isMember }) {
  if (!isEncryptedManifest(doc)) throw Object.assign(new Error('not an encrypted manifest'), { code: 'manifest_plain' });
  if (doc.projectId !== projectId) throw Object.assign(new Error('The synced copy belongs to another project.'), { code: 'manifest_wrong_project' });
  const published = await signerKeyOf(doc.signer);
  if (!published || published !== doc.signerKey || !(await verifyDoc(published, MANIFEST_KIND, doc))) {
    throw Object.assign(new Error('The synced copy’s signature could not be verified — it was not written by a member of this project, or has been altered.'), { code: 'manifest_unverified', signer: doc.signer });
  }
  // Someone who has since LEFT signed it: storage rules stopped their writes
  // the moment they left, so it was written while they were a member — read,
  // flagged, and replaced by this device's next write.
  const signerLeft = isMember ? !(await isMember(doc.signer)) : false;
  const manifest = await openJsonDoc(async (kv) => ring.keys.get(kv) || null, doc, { purpose: 'sync.manifest', scope: projectId });
  if (Number(manifest.seq) !== Number(doc.seq)) throw Object.assign(new Error('The synced copy has been altered.'), { code: 'manifest_unverified' });
  return { manifest, signer: doc.signer, signerLeft, seq: Number(doc.seq) || 0 };
}

