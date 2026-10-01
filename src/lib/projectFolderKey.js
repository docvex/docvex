// The project's FOLDER KEY — what seals everything DocVex writes about a
// project's files outside this machine's own index: the knowledge shards and
// settings in the case folder's `.docvex/` (src/projectIndex/folderSeal.js)
// and the data bundles account sync uploads (lib/projectSyncData).
//
// Since migration 046 it is the project's END-TO-END key ring
// (lib/e2e/projectKeys): made on a member's device, stored on the server only
// sealed to each member's identity key, versioned (a new version after a
// member leaves). A project from before 046 used the server-held key of
// migration 045 — that key is adopted as version 1, handed to every member as
// a grant, and then deleted from the server (`retire_server_folder_key`).
//
// Fetched once per project per session; a failure (offline, signed out, no
// grant yet) is not remembered, so the next ask retries. The index keeps the
// ring it was given, so it works offline after that.

import { ipc } from './projectIndexClient';
import {
  getProjectKeyRing, ringToIndexKeys, forgetProjectKeys, subscribeProjectKeys,
} from './e2e/projectKeys';
import { forgetIdentity } from './e2e/identity';
import { forgetDmKeys } from './e2e/dmKeys';
import {
  isJsonEnvelope, sealJsonDoc, openJsonDoc,
} from './e2e/envelope';
import { b64dec, b64enc } from './e2e/bytes';

// The ring, or null.
export const projectKeyRing = (projectId) => getProjectKeyRing(projectId);

// The CURRENT key (base64) — for callers that only write.
export async function projectFolderKey(projectId) {
  const ring = await getProjectKeyRing(projectId);
  return ring ? b64enc(ring.keys.get(ring.current)) : null;
}

// Fetch the ring and give it to the index (which seals the folder with it).
// Fire-and-forget safe: never throws. Handed again whenever the ring changes
// (a rotation, a newer grant arriving).
const handed = new Map(); // projectId → signature of the ring handed
const ringSig = (ring) => [...ring.keys.keys()].sort((a, b) => a - b).join(',');
export async function ensureFolderKey(projectId) {
  try {
    const ring = await getProjectKeyRing(projectId);
    if (!ring) return null;
    const sig = ringSig(ring);
    if (handed.get(projectId) !== sig) {
      const res = await ipc.projectFolderKey({
        projectId,
        key: b64enc(ring.keys.get(ring.current)),
        version: ring.current,
        keys: ringToIndexKeys(ring),
      });
      if (res?.ok) handed.set(projectId, sig);
    }
    return b64enc(ring.keys.get(ring.current));
  } catch { return null; }
}
// A ring that changed after it was handed (rotation) reaches the index too.
subscribeProjectKeys((projectId) => { if (handed.has(projectId)) ensureFolderKey(projectId); });

// Forget everything (sign-out / erase data).
export function forgetFolderKeys() {
  handed.clear();
  forgetProjectKeys();
  forgetDmKeys();
  forgetIdentity();
}

// ── Sealing a sync bundle ──────────────────────────────────────────────────
// New bundles: the e2e JSON envelope (lib/e2e/envelope), bound to its purpose,
// project and key version. Old ones: `{ v: 2, alg: 'A256GCM', data }` under
// the legacy key (= version 1), still read.
export const isLegacySealedBundle = (json) => !!json && typeof json === 'object'
  && json.v === 2 && json.alg === 'A256GCM' && typeof json.data === 'string' && json.e2e == null;
export const isSealedBundle = (json) => isJsonEnvelope(json) || isLegacySealedBundle(json);

// `ring` from projectKeyRing; `purpose` e.g. 'sync.data.shared'; `scope` the
// project id (plus the user id for a private bundle).
export async function sealBundle(ring, value, { purpose, scope }) {
  if (!ring) throw new Error('no_project_key');
  return sealJsonDoc(ring.keys.get(ring.current), ring.current, value, { purpose, scope });
}

export async function openBundle(ring, json, { purpose, scope }) {
  if (!ring) throw new Error('no_project_key');
  if (isJsonEnvelope(json)) return openJsonDoc(async (kv) => ring.keys.get(kv) || null, json, { purpose, scope });
  // Legacy (045): iv 12 | tag 16 | ciphertext, no AAD, the v1 key.
  const k1 = ring.keys.get(1);
  if (!k1) throw new Error('no_key_for_version');
  const key = await crypto.subtle.importKey('raw', k1, 'AES-GCM', false, ['decrypt']);
  const raw = b64dec(json.data);
  const joined = new Uint8Array(raw.length - 12);
  joined.set(raw.subarray(28), 0);
  joined.set(raw.subarray(12, 28), raw.length - 28);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, joined);
  return JSON.parse(new TextDecoder().decode(plain));
}
