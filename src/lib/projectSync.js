// ── Sync a project to the signed-in account ──────────────────────────────────
// A project's files live in a folder on the user's machine (migration 031 —
// there is no cloud file store). "Sync with account" is an explicit, per-project
// opt-in that mirrors that folder into the user's own Supabase storage, so a
// second device signed into the same account can pull the same working set.
//
// Deliberately NO tables (migration 035 adds only a private bucket). Everything
// is in the bucket itself:
//
//   project-sync/<project id>/.docvex-sync.json   the manifest
//   project-sync/<project id>/<key>               one object per file
//
// The MANIFEST is the state: what is synced, under which key, at what size and
// modified time. Its existence is the toggle — there is no column to keep in
// step, switching sync off leaves nothing behind, and one `list('')` call tells
// a device it has never seen this project on which of the account's projects
// have a copy waiting.
//
// An object's KEY IS A HASH of the file's path inside the project, not the path
// itself: Romanian case files are full of spaces, diacritics and brackets, and a
// storage key that has to carry them faithfully is a fight nobody wins. The
// manifest maps key → path, which is the only direction anything needs.
//
// WHICH COPY WINS: the newer one, by modified time. A proper three-way merge
// needs a common base, and the one thing a device can honestly record is what IT
// last had synced — kept per device in localStorage (`ledgerKey`), which is what
// tells a file deleted here apart from a file added there.
import { supabase } from './supabaseClient';
import { localFolderApi, readLocalBlob, isElectronBranch } from './localFolder';

export const PROJECT_SYNC_BUCKET = 'project-sync';
export const MANIFEST_NAME = '.docvex-sync.json';
// Matches the bucket's own limit (migration 035). This syncs working documents,
// not media libraries: one stray video would otherwise eat the whole quota.
export const MAX_SYNC_FILE_BYTES = 50 * 1024 * 1024;
// Filesystem timestamps don't survive a round trip to the byte: a copied file
// can land a second or two off. Anything inside this counts as unchanged.
const MTIME_SLACK_MS = 2000;

const bucket = () => supabase.storage.from(PROJECT_SYNC_BUCKET);

// ── The manifest ────────────────────────────────────────────────────────────
// { version, projectId, at, by, files: { [key]: { path, size, mtime } } }
const emptyManifest = (projectId) => ({ version: 1, projectId, at: null, by: null, files: {} });

// A missing bucket means migration 035 hasn't been applied — a state worth
// naming, since every other error here is transient.
function bucketMissing(error) {
  const m = (error?.message || '').toLowerCase();
  return m.includes('bucket not found') || m.includes('does not exist');
}
function notFound(error) {
  const m = (error?.message || '').toLowerCase();
  return m.includes('not found') || m.includes('no such') || error?.statusCode === '404';
}

// The object key for a file at `relPath` inside the project. Stable across
// devices (the same path always hashes the same), so re-uploading a changed file
// replaces the object rather than piling up copies.
async function keyFor(relPath) {
  const bytes = new TextEncoder().encode(relPath);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 40);
}

export async function readManifest(projectId) {
  if (!projectId) return { manifest: null, error: new Error('No project') };
  const { data, error } = await bucket().download(`${projectId}/${MANIFEST_NAME}`);
  if (error) {
    if (bucketMissing(error)) return { manifest: null, error, missingBucket: true };
    // No manifest = this project isn't synced. Not an error.
    if (notFound(error)) return { manifest: null, error: null };
    return { manifest: null, error };
  }
  try {
    const parsed = JSON.parse(await data.text());
    if (!parsed || typeof parsed !== 'object') throw new Error('bad manifest');
    return { manifest: { ...emptyManifest(projectId), ...parsed, files: parsed.files || {} }, error: null };
  } catch (err) {
    return { manifest: null, error: err };
  }
}

async function writeManifest(projectId, manifest) {
  const body = new Blob([JSON.stringify({ ...manifest, projectId, at: new Date().toISOString() }, null, 2)], {
    type: 'application/json',
  });
  const { error } = await bucket().upload(`${projectId}/${MANIFEST_NAME}`, body, {
    upsert: true,
    contentType: 'application/json',
  });
  return { error };
}

// Which of the account's projects have a copy in it. ONE call: the bucket's top
// level is one folder per project, and storage RLS already limits it to projects
// the caller is a member of.
export async function listSyncedProjectIds() {
  const { data, error } = await bucket().list('', { limit: 1000 });
  if (error) return { ids: new Set(), error, missingBucket: bucketMissing(error) };
  const ids = new Set((data || []).filter((e) => e && !e.id).map((e) => e.name));
  return { ids, error: null };
}

// ── What this device last had synced ────────────────────────────────────────
// The third leg of the comparison: without it, a file that is in the manifest
// and not on disk is either one a teammate added or one deleted here, and sync
// would either lose the deletion or resurrect the file.
const ledgerKey = (projectId) => `docvex:sync:ledger:${projectId}`;
function readLedger(projectId) {
  try {
    const raw = localStorage.getItem(ledgerKey(projectId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function writeLedger(projectId, keys) {
  try { localStorage.setItem(ledgerKey(projectId), JSON.stringify(keys)); } catch { /* full or blocked */ }
}
export function forgetLedger(projectId) {
  try { localStorage.removeItem(ledgerKey(projectId)); } catch { /* ignore */ }
}

// ── Reading the folder ──────────────────────────────────────────────────────
const relPathOf = (f) => (f.folderPath ? `${f.folderPath}/${f.name}` : f.name);

async function readLocalTree(dir) {
  const { files, error } = await localFolderApi.listAll(dir);
  if (error) return { entries: [], error: new Error(error) };
  const entries = [];
  for (const f of files || []) {
    const relPath = relPathOf(f);
    entries.push({
      relPath,
      path: f.path || relPath,
      size: f.sizeBytes || 0,
      mtime: f.mtimeIso || null,
      key: await keyFor(relPath),
    });
  }
  return { entries, error: null };
}

// How many files the project has on THIS device — what "not on this device"
// means for the Hub. A folder that exists but is empty counts as not here: on
// the desktop every project gets a folder made for it whether or not anything
// was ever put in it.
export async function countLocalFiles(dir) {
  if (!dir) return 0;
  const { files } = await localFolderApi.listAll(dir);
  return (files || []).length;
}

const newer = (a, b) => new Date(a || 0).getTime() - new Date(b || 0).getTime();

// What a sync would do, without doing any of it. The Overview panel shows this
// as the state line, and `syncProject` runs it.
export function planSync({ manifest, entries, ledger }) {
  const files = manifest?.files || {};
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const push = [];
  const pull = [];
  const dropRemote = [];
  const skipped = [];

  for (const e of entries) {
    if (e.size > MAX_SYNC_FILE_BYTES) { skipped.push({ ...e, why: 'too big' }); continue; }
    const remote = files[e.key];
    if (!remote) { push.push(e); continue; }
    const drift = newer(e.mtime, remote.mtime);
    if (drift > MTIME_SLACK_MS) push.push(e);
    else if (drift < -MTIME_SLACK_MS) pull.push({ ...remote, key: e.key });
    else if ((remote.size || 0) !== e.size) push.push(e);   // same minute, different bytes
  }
  for (const [key, remote] of Object.entries(files)) {
    if (byKey.has(key)) continue;
    // Gone from disk: deleted here if this device ever had it, otherwise it is
    // simply a file this device hasn't got yet.
    if (ledger[key]) dropRemote.push({ ...remote, key });
    else pull.push({ ...remote, key });
  }
  return { push, pull, dropRemote, skipped };
}

// ── The sync itself ─────────────────────────────────────────────────────────
// `onProgress({ phase, done, total, name })` — phases: 'reading', 'up', 'down',
// 'cleaning', 'done'.
export async function syncProject({ projectId, dir, onProgress = () => {}, enable = false }) {
  if (!projectId) return { ok: false, error: 'No project' };
  if (!dir) return { ok: false, error: 'This project has no folder on this device yet.' };

  onProgress({ phase: 'reading', done: 0, total: 0 });
  const { manifest: existing, error: mErr, missingBucket } = await readManifest(projectId);
  if (missingBucket) return { ok: false, error: 'Account sync isn’t set up on this Supabase project yet — apply migration 035.' };
  if (mErr) return { ok: false, error: mErr.message || String(mErr) };
  if (!existing && !enable) return { ok: false, error: 'This project isn’t synced with your account.' };

  const manifest = existing || emptyManifest(projectId);
  const { entries, error: lErr } = await readLocalTree(dir);
  if (lErr) return { ok: false, error: lErr.message };

  const ledger = readLedger(projectId);
  const { push, pull, dropRemote, skipped } = planSync({ manifest, entries, ledger });
  const files = { ...manifest.files };
  const failed = [];

  // ── up ──
  let done = 0;
  for (const e of push) {
    onProgress({ phase: 'up', done, total: push.length, name: e.relPath });
    try {
      const blob = await readLocalBlob(e.path);
      const { error } = await bucket().upload(`${projectId}/${e.key}`, blob, {
        upsert: true,
        contentType: blob.type || 'application/octet-stream',
      });
      if (error) throw error;
      files[e.key] = { path: e.relPath, size: e.size, mtime: e.mtime };
    } catch (err) {
      failed.push({ path: e.relPath, error: err?.message || String(err) });
    }
    done += 1;
  }

  // ── down ──
  const incoming = [];
  done = 0;
  for (const r of pull) {
    onProgress({ phase: 'down', done, total: pull.length, name: r.path });
    try {
      const { data, error } = await bucket().download(`${projectId}/${r.key}`);
      if (error) throw error;
      incoming.push({ relPath: r.path, blob: data });
    } catch (err) {
      failed.push({ path: r.path, error: err?.message || String(err) });
    }
    done += 1;
  }
  if (incoming.length) {
    const { results, error } = await localFolderApi.writeTree({ dir, files: incoming });
    if (error) failed.push({ path: '(writing files)', error });
    for (const r of results || []) if (!r.ok) failed.push({ path: r.relPath, error: r.error });
  }

  // ── what has gone from every device that reported in ──
  if (dropRemote.length) {
    onProgress({ phase: 'cleaning', done: 0, total: dropRemote.length });
    const { error } = await bucket().remove(dropRemote.map((r) => `${projectId}/${r.key}`));
    if (error) failed.push({ path: '(removing deleted files)', error: error.message });
    else for (const r of dropRemote) delete files[r.key];
  }

  const next = { ...manifest, files, by: (await supabase.auth.getSession()).data.session?.user?.id || manifest.by };
  const { error: wErr } = await writeManifest(projectId, next);
  if (wErr) return { ok: false, error: wErr.message || String(wErr) };

  // This device now holds exactly what the manifest lists.
  writeLedger(projectId, Object.fromEntries(Object.keys(files).map((k) => [k, 1])));
  onProgress({ phase: 'done', done: 1, total: 1 });
  return {
    ok: true,
    error: null,
    pushed: push.length - failed.length,
    pulled: incoming.length,
    removed: dropRemote.length,
    skipped,
    failed,
    manifest: next,
  };
}

// Switching it ON is an ordinary sync that is allowed to create the manifest.
export const enableSync = (args) => syncProject({ ...args, enable: true });

// Switching it OFF removes the account's copy — the files on this machine are
// untouched, which is the whole point of saying so in the confirm.
export async function disableSync(projectId) {
  const { manifest, error, missingBucket } = await readManifest(projectId);
  if (missingBucket) return { ok: true, error: null };            // nothing was ever there
  if (error) return { ok: false, error: error.message || String(error) };
  const keys = Object.keys(manifest?.files || {}).map((k) => `${projectId}/${k}`);
  // The manifest goes last: while it is there, the project still reads as
  // synced, so a failure part way through leaves a state the next sync can fix
  // rather than orphaned objects nothing knows about.
  if (keys.length) {
    const { error: rErr } = await bucket().remove(keys);
    if (rErr) return { ok: false, error: rErr.message };
  }
  const { error: mErr } = await bucket().remove([`${projectId}/${MANIFEST_NAME}`]);
  if (mErr) return { ok: false, error: mErr.message };
  forgetLedger(projectId);
  return { ok: true, error: null };
}

// The state line: is it synced, how much is in the account, and what a sync
// would do right now. Cheap enough to run on opening the panel (one download +
// one folder walk) but it does read the folder, so callers shouldn't poll it.
export async function syncStatus({ projectId, dir }) {
  const { manifest, error, missingBucket } = await readManifest(projectId);
  if (missingBucket) return { enabled: false, missingBucket: true, error: null };
  if (error) return { enabled: false, error: error.message || String(error) };
  if (!manifest) return { enabled: false, error: null };
  const remoteFiles = Object.values(manifest.files || {});
  const base = {
    enabled: true,
    error: null,
    at: manifest.at,
    remoteCount: remoteFiles.length,
    remoteBytes: remoteFiles.reduce((n, f) => n + (f.size || 0), 0),
  };
  if (!dir) return { ...base, plan: null };
  const { entries, error: lErr } = await readLocalTree(dir);
  if (lErr) return { ...base, plan: null };
  return { ...base, plan: planSync({ manifest, entries, ledger: readLedger(projectId) }) };
}

// Everything in the account's copy, onto a device that hasn't got it — what the
// Hub's cloud-marked projects offer. It is just a sync: with nothing on disk and
// no ledger, every file in the manifest is something to pull.
export async function pullProject({ projectId, dir, onProgress }) {
  forgetLedger(projectId);
  return syncProject({ projectId, dir, onProgress });
}

// Web has no folder tree (the File System Access backend tracks one flat
// directory), so a pull there lands every file in that one folder. Worth saying
// out loud rather than quietly flattening someone's structure.
export const syncKeepsFolders = isElectronBranch;
