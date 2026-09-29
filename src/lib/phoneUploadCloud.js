// Upload from a phone THROUGH THE CLOUD — the second of the Files tab's Import
// QR codes, for a phone that isn't on the computer's network. The phone opens
// docvex.ro/upload.html?t=<token>, which sends each file to a private bucket
// through the `phone-upload` Edge Function (migration 040). This side — the
// signed-in desktop — hears each file arrive (Realtime, with a slow poll behind
// it in case Realtime is off), downloads it into the WAITING list of the folder
// the Files tab is showing (main's `phone-upload:hold-file` — accepted or
// rejected like a Wi-Fi file, never straight into the project), and deletes the
// object from the bucket at once (the bucket is a hand-off, not a store) —
// the ROW stays, marked taken, to carry the decision back to the phone
// (migration 041). The address is kept and reopened, like the Wi-Fi one.
//
// END-TO-END ENCRYPTED: every address has a random 256-bit key of its own,
// made here and put in the QR code's URL FRAGMENT
// (upload.html?t=<token>#k=<key>) — never sent to docvex.ro, Supabase or
// anyone. The page seals each file on the phone (AES-256-GCM,
// lib/phoneUploadCrypto) with its name and type inside; the bucket and the
// row see only ciphertext and "encrypted". Here each file is OPENED — every
// tag checked, the name and type restored — before it is handed to the
// waiting list; a file that does not open is deleted and never reaches it.
// The key is kept in the encrypted store (lib/phoneUploadLocal
// `saveSealKey`); "New address" makes a new one. Rows written before the
// address had a key (an older page) are still taken as they are; after that,
// only sealed files are.

import { supabase } from './supabaseClient';
import { phoneUploadHoldFile } from './platform';
import { loadSealKey, saveSealKey } from './phoneUploadLocal';
import { newSealKey, isSealKey, unsealBytes, webOpen, looksSealed, SEALED_MIME } from './phoneUploadCrypto';

export const CLOUD_UPLOAD_PAGE = 'https://docvex.ro/upload.html';
const BUCKET = 'phone-upload';
const POLL_MS = 5000;

// The cloud address is KEPT per account and project, as the Wi-Fi one is
// (lib/phoneUploadLocal): { token, sessionId } — the function reopens the
// session for the same token, so a phone can keep its page.
const keptKey = (userId, projectId) => `docvex:phone-upload:cloud:v1:${userId || '_'}:${projectId || '_'}`;
function loadKept(userId, projectId) {
  try { return JSON.parse(localStorage.getItem(keptKey(userId, projectId)) || 'null'); } catch { return null; }
}
function saveKept(userId, projectId, v) {
  try { localStorage.setItem(keptKey(userId, projectId), JSON.stringify(v)); } catch { /* storage refused */ }
}

/**
 * Start — or REOPEN, with the kept token — the project's cloud session →
 * `{ ok, token, sessionId, expiresAt, url }` or `{ ok: false, error }`.
 * `fresh` throws the old address away first ("New address").
 */
export async function startCloudUpload({ projectId, projectName, userId, fresh = false } = {}) {
  const kept = loadKept(userId, projectId);
  if (fresh && kept?.sessionId) await stopCloudUpload(kept.sessionId);
  let key = fresh ? '' : await loadSealKey('cloud', userId, projectId);
  try {
    const { data, error } = await supabase.functions.invoke('phone-upload', {
      body: { action: 'create', projectId: projectId || null, projectName: projectName || '', token: fresh ? undefined : kept?.token },
    });
    if (error) {
      // A function that isn't deployed answers 404 — the cloud route isn't set up.
      const status = error?.context?.status;
      return { ok: false, error: status === 404 ? 'not_deployed' : status === 401 ? 'not_signed_in' : 'unreachable' };
    }
    if (!data?.ok) return { ok: false, error: data?.error || 'failed' };
    // A new session (or a kept one whose key is lost) gets a new key; from
    // then on only sealed files are taken from it.
    const sameSession = kept?.sessionId === data.sessionId && kept?.token === data.token;
    let keyAt = sameSession && kept?.keyAt ? kept.keyAt : '';
    if (!sameSession || !isSealKey(key)) { key = newSealKey(); keyAt = new Date().toISOString(); }
    if (!keyAt) keyAt = new Date().toISOString();
    saveSealKey('cloud', userId, projectId, key);
    saveKept(userId, projectId, { token: data.token, sessionId: data.sessionId, keyAt });
    return {
      ...data, key, keyAt,
      url: `${CLOUD_UPLOAD_PAGE}?t=${encodeURIComponent(data.token)}#k=${key}`,
    };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}

/** Pause a session (the Import window closed) — reopened by the next start. */
export async function stopCloudUpload(sessionId) {
  if (!sessionId) return;
  try { await supabase.functions.invoke('phone-upload', { body: { action: 'close', sessionId } }); } catch { /* it expires anyway */ }
}

/** What the desktop decided about a cloud file — the phone reads it back. */
export async function reportCloudDecision(rowId, status) {
  if (!rowId) return;
  try {
    await supabase.from('phone_upload_files').update({ status, decided_at: new Date().toISOString() }).eq('id', rowId);
  } catch { /* the phone just doesn't learn it */ }
}

/**
 * Take every file of a session into `dir` as it arrives.
 * `onEvent({ type: 'start' | 'done' | 'error', id, name, size, error })`.
 * `seal` = { key, token, keyAt } from startCloudUpload: sealed files are
 * opened with it; a plain file is taken only if its row is older than `keyAt`.
 * Returns a stop function.
 */
export function watchCloudUpload(sessionId, dir, onEvent, owner = '', seal = null) {
  const open = webOpen();
  const plainBefore = seal?.keyAt ? Date.parse(seal.keyAt) : Infinity;
  // A file refused for good (it did not open): its object and its row go, and
  // the phone learns it was rejected.
  const refuse = async (row) => {
    try { await supabase.storage.from(BUCKET).remove([row.path]); } catch { /* the sweep takes it */ }
    try { await supabase.from('phone_upload_files').update({ taken_at: new Date().toISOString(), status: 'rejected', decided_at: new Date().toISOString() }).eq('id', row.id); } catch { /* nothing more to do */ }
  };
  const ownerRef = { owner };
  let stopped = false;
  const handled = new Set();
  let busy = Promise.resolve();

  const take = (row) => {
    if (!row?.id || handled.has(row.id) || stopped) return;
    handled.add(row.id);
    busy = busy.then(async () => {
      if (stopped) return;
      const sealedRow = row.mime === SEALED_MIME;
      onEvent?.({ type: 'start', id: row.id, name: sealedRow ? 'Encrypted file' : row.name, size: row.size });
      try {
        const { data: blob, error } = await supabase.storage.from(BUCKET).download(row.path);
        if (error || !blob) throw new Error('download_failed');
        let data = new Uint8Array(await blob.arrayBuffer());
        let name = String(row.name || 'upload');
        if (sealedRow || looksSealed(data)) {
          // Opened HERE, every tag checked, before anything is written.
          if (!seal?.key) throw new Error('no_key');
          let opened;
          try {
            opened = await unsealBytes(data, { key: seal.key, ctx: seal.token, open });
          } catch {
            data = null;
            await refuse(row);
            onEvent?.({ type: 'error', id: row.id, name: 'Encrypted file', size: row.size, error: 'not_decrypted' });
            return;
          }
          data = opened.data;
          name = opened.name || 'upload';
        } else {
          // A plain file: only from before this address had a key (an older
          // page); after that, it cannot be from the phone that scanned the code.
          const at = Date.parse(row.created_at || '') || 0;
          if (!(at && at < plainBefore)) {
            await refuse(row);
            onEvent?.({ type: 'error', id: row.id, name, size: row.size, error: 'not_encrypted' });
            return;
          }
        }
        // It WAITS for approval like a Wi-Fi file (main's waiting list), never
        // straight into the project.
        const held = await phoneUploadHoldFile({ dir, name, data, owner: ownerRef.owner, cloudRow: row.id });
        if (!held?.ok) throw new Error(held?.error || 'write_failed');
        // Only once it is on disk does it leave the cloud.
        await supabase.storage.from(BUCKET).remove([row.path]);
        // The row stays — it carries the decision back to the phone.
        await supabase.from('phone_upload_files').update({ taken_at: new Date().toISOString() }).eq('id', row.id);
        // A Live Photo's movement joins its picture rather than arriving as
        // a file of its own (the server's partner rule).
        if (held.partner) { if (held.id) onEvent?.({ type: 'live', heldId: held.id }); }
        else onEvent?.({ type: 'held', id: row.id, heldId: held.id, name: held.name, size: row.size, path: held.path, live: !!held.live });
      } catch (e) {
        handled.delete(row.id);   // the next poll tries again
        onEvent?.({ type: 'error', id: row.id, name: row.name, size: row.size, error: e?.message || 'failed' });
      }
    });
  };

  const channel = supabase
    .channel(`phone-upload:${sessionId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'phone_upload_files', filter: `session_id=eq.${sessionId}` }, (p) => take(p.new))
    .subscribe();

  const poll = async () => {
    if (stopped) return;
    const { data } = await supabase.from('phone_upload_files').select('id,path,name,size,mime,created_at').eq('session_id', sessionId).is('taken_at', null).order('created_at');
    for (const row of data || []) take(row);
  };
  const timer = setInterval(poll, POLL_MS);
  poll();

  return () => {
    stopped = true;
    clearInterval(timer);
    supabase.removeChannel(channel);
  };
}
