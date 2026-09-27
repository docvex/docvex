// Files a phone sent while the Import window was closed — HELD by the desktop
// (phoneUploadServer: `<folder>/.docvex-incoming`) until accepted or rejected.
// This is the renderer's one list of them, shared by the notifier that posts
// them as toasts (components/PhoneIncomingNotifier) and the toast actions that
// decide them (notifications/actionRegistry, category 'file' +
// `payload.phoneUpload`) — a module-level store, since toast actions are
// rebuilt from a notification's payload and can't carry a closure.

import {
  isElectron, onPhoneUploadEvent, phoneUploadPending, phoneUploadAccept, phoneUploadReject, phoneUploadRelease, notifyFilesChanged,
} from './platform';
import { reportCloudDecision } from './phoneUploadCloud';

const pending = new Map();   // id → { id, name, size, path, dir, at }
const arrivedSubs = new Set();
const subs = new Set();
const emit = () => { const list = [...pending.values()]; subs.forEach((fn) => fn(list)); };

export const listIncoming = () => [...pending.values()];
export function subscribeIncoming(fn) { subs.add(fn); fn(listIncoming()); return () => subs.delete(fn); }
/** Called once per file as it ARRIVES (not for files already waiting at start). */
export function onIncomingArrived(fn) { arrivedSubs.add(fn); return () => arrivedSubs.delete(fn); }

let started = false;
let quiet = false;    // the Import window is open and shows arrivals itself — no toast
/** While the Import window is open its Received section is the announcement. */
export function setIncomingQuiet(on) { quiet = !!on; }
let owner = null;     // the signed-in account the list belongs to
let ownerSeq = 0;
/**
 * The signed-in account (null when signed out): its kept addresses come back,
 * its waiting files are listed — and EVERY OTHER account's sessions end, so
 * files sent to the last person's address never reach this one. Called by the
 * notifier whenever the account changes.
 */
export function setIncomingOwner(userId) {
  if (!isElectron) return;
  const next = userId || '';
  if (owner === next) return;
  owner = next;
  const seq = ++ownerSeq;
  pending.clear();
  emit();
  (async () => {
    await phoneUploadRelease({ owner: next });
    if (!next) return;
    // (Kept addresses are NOT revived here: the phone portal works only while
    // the Import window is open — PhoneUploadModal starts and stops it.)
    const list = await phoneUploadPending({ owner: next });
    if (seq !== ownerSeq) return;   // the account changed again meanwhile
    for (const it of list) pending.set(it.id, it);
    emit();
  })();
}

/** Listen for held files — once per window. */
export function startIncoming() {
  if (started || !isElectron) return;
  started = true;
  onPhoneUploadEvent((ev) => {
    // The phone took it back (its × on the page): gone from the Files tab.
    if (ev?.type === 'withdrawn') { if (pending.delete(ev.id)) emit(); return; }
    if (ev?.type !== 'held') return;
    const it = { id: ev.id, name: ev.name, size: ev.size, path: ev.path, dir: ev.dir, at: ev.at || Date.now() };
    pending.set(ev.id, it);
    emit();
    if (!quiet) arrivedSubs.forEach((fn) => fn(it));
  });
}

/** Accept (into the folder it was sent to) or reject (deleted) one held file. */
export async function decideIncoming(id, accept) {
  const it = pending.get(id);
  const res = accept ? await phoneUploadAccept(id) : await phoneUploadReject(id);
  if (res?.ok) {
    pending.delete(id); emit();
    // A cloud file: its phone learns the decision too (the Wi-Fi one asks the server).
    if (it?.cloudRow) reportCloudDecision(it.cloudRow, accept ? 'accepted' : 'rejected');
  }
  // A failed decision offers the file again: its toast closed as the button
  // was pressed, and `retry` tells the notifier it was not put away for later.
  else if (it) { pending.set(id, { ...it, retry: Date.now() }); emit(); }
  if (accept && res?.ok) notifyFilesChanged();
  return { ...res, item: it };
}

export const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${Math.round(v / 1024)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1).replace(/\.0$/, '')} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
};
