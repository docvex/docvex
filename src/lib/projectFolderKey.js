// The project's FOLDER KEY — what seals everything DocVex writes about a
// project's files outside this machine's own index: the knowledge shards and
// settings in the case folder's `.docvex/` (src/projectIndex/folderSeal.js)
// and the data bundles account sync uploads (lib/projectSyncData). One key per
// project, made and kept by the server (`get_project_folder_key`, migration
// 045) and handed only to the project's members, so every member reads the
// same folder on every machine while a copy of the folder on its own (a
// OneDrive share, a USB stick, the sync bucket) holds no readable text.
//
// Fetched once per project per session; a failure (offline, signed out, a
// server without the migration) is not remembered, so the next ask retries.
// The index keeps the key it was given, so it works offline after that.

import { supabase } from './supabaseClient';
import { ipc } from './projectIndexClient';

const keys = new Map(); // projectId → Promise<string | null>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function projectFolderKey(projectId) {
  if (!projectId || !UUID.test(String(projectId))) return Promise.resolve(null);
  let p = keys.get(projectId);
  if (!p) {
    p = (async () => {
      try {
        const { data, error } = await supabase.rpc('get_project_folder_key', { p_project_id: projectId });
        return !error && typeof data === 'string' && data ? data : null;
      } catch { return null; }
    })();
    keys.set(projectId, p);
    p.then((k) => { if (!k && keys.get(projectId) === p) keys.delete(projectId); });
  }
  return p;
}

// Fetch the key and give it to the index (which seals the folder with it).
// Fire-and-forget safe: never throws.
const handed = new Set();
export async function ensureFolderKey(projectId) {
  const key = await projectFolderKey(projectId);
  if (key && !handed.has(projectId)) {
    const res = await ipc.projectFolderKey({ projectId, key });
    if (res?.ok) handed.add(projectId);
  }
  return key;
}

// Forget everything (sign-out / erase data).
export function forgetFolderKeys() {
  keys.clear();
  handed.clear();
}

// ── Sealing a sync bundle (WebCrypto, same format as folderSeal.js) ─────────
const b64 = {
  enc: (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); },
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
const importKey = (keyB64) => crypto.subtle.importKey('raw', b64.dec(keyB64), 'AES-GCM', false, ['encrypt', 'decrypt']);

export const isSealedBundle = (json) => !!json && typeof json === 'object'
  && json.v === 2 && json.alg === 'A256GCM' && typeof json.data === 'string';

// → { v: 2, alg, data: base64(iv 12 | tag 16 | ciphertext) }
export async function sealBundle(keyB64, value) {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))));
  // WebCrypto appends the 16-byte tag; the folder format puts it after the iv.
  const ct = out.subarray(0, out.length - 16);
  const tag = out.subarray(out.length - 16);
  const all = new Uint8Array(12 + 16 + ct.length);
  all.set(iv, 0); all.set(tag, 12); all.set(ct, 28);
  return { v: 2, alg: 'A256GCM', data: b64.enc(all) };
}

export async function openBundle(keyB64, json) {
  const key = await importKey(keyB64);
  const raw = b64.dec(json.data);
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const joined = new Uint8Array(ct.length + 16);
  joined.set(ct, 0); joined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, joined);
  return JSON.parse(new TextDecoder().decode(plain));
}
