// The Import window's "Same Wi-Fi" address, KEPT per ACCOUNT and project on this
// device, so it is the same every time the window opens: a phone can leave the
// upload page open and go on sending — with the window closed, and after
// DocVex restarts (the incoming store resumes the signed-in account's links).
// "New address" revokes it.
//
// Per account because several people can use one computer: the next person
// signed in must never get the last one's files (the server lists and keeps
// sessions per owner — phoneUploadServer). The PORT is kept too, so a phone's
// saved address reaches this instance again after a restart, not another
// DocVex on the same machine.
//
// Stored: the encrypted secure store (lib/secureStore) `docvex:phone-upload:local:v2:<userId>:<projectId>` →
//   { token, dir, folder, project, port }. (v1 keys, per project only, are
//   dropped — their owner is unknown.)
// The address's FILE KEY (the QR code's fragment, lib/phoneUploadCrypto) is
// NOT kept there: it is in the encrypted store (lib/secureStore,
// `docvex:phone-upload-key:<route>:<userId>:<projectId>`). "New address" makes
// a new token AND a new key.

import { phoneUploadStart, phoneUploadStop } from './platform';
import { secureGet, secureSet, secureRemove, whenSecureStoreReady, secureStorage, secureKeys } from './secureStore';

// ── The addresses' file keys, in the encrypted store ─────────────────────
const sealKeyKey = (route, userId, projectId) => `docvex:phone-upload-key:${route}:${userId || '_'}:${projectId || '_'}`;
// The store answers from memory once hydrated; wait for that (briefly) so a
// kept key isn't taken for a missing one right after launch.
async function storeReady() {
  try { await Promise.race([whenSecureStoreReady(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* answer from what is there */ }
}
export async function loadSealKey(route, userId, projectId) {
  await storeReady();
  try { return secureGet(sealKeyKey(route, userId, projectId)) || ''; } catch { return ''; }
}
export function saveSealKey(route, userId, projectId, key) {
  try { if (key) secureSet(sealKeyKey(route, userId, projectId), key); else secureRemove(sealKeyKey(route, userId, projectId)); } catch { /* memory only */ }
}

const PREFIX = 'docvex:phone-upload:local:v2:';
const key = (userId, projectId) => `${PREFIX}${userId || '_'}:${projectId || '_'}`;

export function loadLocalLink(userId, projectId) {
  try { return JSON.parse(secureStorage.getItem(key(userId, projectId)) || 'null'); } catch { return null; }
}
function saveLocalLink(userId, projectId, link) {
  try { secureStorage.setItem(key(userId, projectId), JSON.stringify(link)); } catch { /* storage refused */ }
}
export function clearLocalLink(userId, projectId) {
  try { secureStorage.removeItem(key(userId, projectId)); } catch { /* storage refused */ }
  saveSealKey('local', userId, projectId, '');
}

/**
 * Start (or go on with) the project's local upload session — the kept token,
 * files into `dir`, owned by `userId`. `fresh` throws the old address away first.
 * → the main process's answer: `{ ok, token, urls, port, computer, expiresAt }` or `{ ok: false, error }`.
 */
export async function ensureLocalLink({ userId, projectId, dir, project, folder, fresh = false, hold = false }) {
  const kept = loadLocalLink(userId, projectId);
  if (fresh && kept?.token) { await phoneUploadStop(kept.token); clearLocalLink(userId, projectId); saveSealKey('local', userId, projectId, ''); }
  const keptKey = fresh ? '' : await loadSealKey('local', userId, projectId);
  const res = await phoneUploadStart({
    dir, project: project || kept?.project || '', folder, hold, owner: userId || '',
    token: fresh ? undefined : kept?.token, key: keptKey || undefined, port: kept?.port,
  });
  if (res?.ok) {
    saveLocalLink(userId, projectId, { token: res.token, dir, folder, project: project || kept?.project || '', port: res.port });
    if (res.key) saveSealKey('local', userId, projectId, res.key);
  }
  return res;
}

// The signed-in account's kept addresses, brought back when the app starts or
// the account changes (the incoming store does this), HOLDING what arrives.
export async function resumeLocalLinks(userId) {
  const mine = `${PREFIX}${userId || '_'}:`;
  const ids = [];
  try {
    for (const k of secureKeys(mine)) ids.push(k.slice(mine.length));
  } catch { return; }
  for (const projectId of ids) {
    const kept = loadLocalLink(userId, projectId);
    if (kept?.token && kept.dir) await ensureLocalLink({ userId, projectId, dir: kept.dir, folder: kept.folder || '', hold: true });
  }
}
