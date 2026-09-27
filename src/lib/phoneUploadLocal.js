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
// Stored: localStorage `docvex:phone-upload:local:v2:<userId>:<projectId>` →
//   { token, dir, folder, project, port }. (v1 keys, per project only, are
//   dropped — their owner is unknown.)

import { phoneUploadStart, phoneUploadStop } from './platform';

const PREFIX = 'docvex:phone-upload:local:v2:';
const key = (userId, projectId) => `${PREFIX}${userId || '_'}:${projectId || '_'}`;

export function loadLocalLink(userId, projectId) {
  try { return JSON.parse(localStorage.getItem(key(userId, projectId)) || 'null'); } catch { return null; }
}
function saveLocalLink(userId, projectId, link) {
  try { localStorage.setItem(key(userId, projectId), JSON.stringify(link)); } catch { /* storage refused */ }
}
export function clearLocalLink(userId, projectId) {
  try { localStorage.removeItem(key(userId, projectId)); } catch { /* storage refused */ }
}

/**
 * Start (or go on with) the project's local upload session — the kept token,
 * files into `dir`, owned by `userId`. `fresh` throws the old address away first.
 * → the main process's answer: `{ ok, token, urls, port, computer, expiresAt }` or `{ ok: false, error }`.
 */
export async function ensureLocalLink({ userId, projectId, dir, project, folder, fresh = false, hold = false }) {
  const kept = loadLocalLink(userId, projectId);
  if (fresh && kept?.token) { await phoneUploadStop(kept.token); clearLocalLink(userId, projectId); }
  const res = await phoneUploadStart({
    dir, project: project || kept?.project || '', folder, hold, owner: userId || '',
    token: fresh ? undefined : kept?.token, port: kept?.port,
  });
  if (res?.ok) saveLocalLink(userId, projectId, { token: res.token, dir, folder, project: project || kept?.project || '', port: res.port });
  return res;
}

// The signed-in account's kept addresses, brought back when the app starts or
// the account changes (the incoming store does this), HOLDING what arrives.
export async function resumeLocalLinks(userId) {
  const mine = `${PREFIX}${userId || '_'}:`;
  const ids = [];
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith('docvex:phone-upload:local:v1:')) { localStorage.removeItem(k); continue; }
      if (k.startsWith(mine)) ids.push(k.slice(mine.length));
    }
  } catch { return; }
  for (const projectId of ids) {
    const kept = loadLocalLink(userId, projectId);
    if (kept?.token && kept.dir) await ensureLocalLink({ userId, projectId, dir: kept.dir, folder: kept.folder || '', hold: true });
  }
}
