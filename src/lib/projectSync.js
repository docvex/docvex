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
import { syncProjectData, removeProjectData } from './projectSyncData';
import { currentAppVersion, compareVersions, isKnownVersion } from './appVersion';

export const PROJECT_SYNC_BUCKET = 'project-sync';
export const MANIFEST_NAME = '.docvex-sync.json';
// The largest file sync carries. The bucket's own limit is 50 MB per OBJECT
// (migration 035), so anything bigger goes up in parts (see `uploadFile`); this
// cap is about the renderer, which holds a file whole while sending or writing
// it — a recording of a few hundred MB is fine, a multi-GB disk image is not.
export const MAX_SYNC_FILE_BYTES = 2 * 1024 * 1024 * 1024;
// Filesystem timestamps don't survive a round trip to the byte: a copied file
// can land a second or two off. Anything inside this counts as unchanged.
const MTIME_SLACK_MS = 2000;

const bucket = () => supabase.storage.from(PROJECT_SYNC_BUCKET);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── The manifest ────────────────────────────────────────────────────────────
// { version, projectId, at, by, files: { [key]: { path, size, mtime } } }
const emptyManifest = (projectId) => ({ version: 1, projectId, gen: null, at: null, by: null, files: {}, folders: {} });

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
    return { manifest: { ...emptyManifest(projectId), ...parsed, files: parsed.files || {}, folders: parsed.folders || {} }, error: null };
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
  // Folders only, and only project ids — `user-<id>` is the private data folder
  // (lib/projectSyncData), not a project.
  const ids = new Set((data || []).filter((e) => e && !e.id && UUID_RE.test(e.name)).map((e) => e.name));
  return { ids, error: null };
}

// ── What this device last had synced ────────────────────────────────────────
// The third leg of the comparison: without it, a file that is in the manifest
// and not on disk is either one a teammate added or one deleted here — and a
// file on disk that is not in the manifest is either new here or deleted
// elsewhere. The ledger answers both: what this device held, and at what
// modified time, the last time it was in step with the account.
//
//   { gen, files: { [key]: mtime }, folders: { [rel]: 1 } }
//
// `gen` is the manifest's generation: switching sync off and on again starts a
// NEW copy, and a ledger from the old one must not be read as "this device had
// these files" — it would make every file here look deleted elsewhere.
const ledgerKey = (projectId) => `docvex:sync:ledger:${projectId}`;
function readLedger(projectId) {
  try {
    const raw = localStorage.getItem(ledgerKey(projectId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return { gen: null, files: {}, folders: {} };
    // Before generations: a plain { [key]: 1 } map. It still says what was
    // synced (so deletions here keep propagating), but not when — so nothing is
    // ever deleted HERE on its word (see planSync).
    if (!parsed.files) return { gen: null, files: parsed, folders: {}, legacy: true };
    return { gen: parsed.gen || null, files: parsed.files || {}, folders: parsed.folders || {} };
  } catch { return { gen: null, files: {}, folders: {} }; }
}
function writeLedger(projectId, ledger) {
  try { localStorage.setItem(ledgerKey(projectId), JSON.stringify(ledger)); } catch { /* full or blocked */ }
}
export function forgetLedger(projectId) {
  try { localStorage.removeItem(ledgerKey(projectId)); } catch { /* ignore */ }
}
// The ledger that applies to `manifest` — empty when it belongs to another copy.
function ledgerFor(projectId, manifest) {
  const l = readLedger(projectId);
  if (!manifest) return { files: {}, folders: {} };
  // A pre-generation ledger can only have come from this same copy's early
  // days, and never deletes anything here (it carries no times), so it stands.
  if (l.legacy) return l;
  if (!l.gen || l.gen !== manifest.gen) return { files: {}, folders: {} };
  return l;
}
const newGen = () => {
  try { return crypto.randomUUID(); } catch { return `g_${Date.now()}_${Math.round(Math.random() * 1e9)}`; }
};

// ── Reading the folder ──────────────────────────────────────────────────────
const relPathOf = (f) => (f.folderPath ? `${f.folderPath}/${f.name}` : f.name);

async function readLocalTree(dir) {
  const { files, dirs, error } = await localFolderApi.listAll(dir);
  if (error) return { entries: [], dirs: [], error: new Error(error) };
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
  return { entries, dirs: Array.isArray(dirs) ? dirs : [], error: null };
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
//   push        new or changed here → up
//   pull        new or changed in the account → down
//   dropRemote  deleted here → removed from the account
//   dropLocal   deleted elsewhere → moved to this device's Trash (recoverable)
//   skipped     too big to carry
//   folders     { add, create, dropRemote, dropLocal } — the same for folders,
//               so the structure (empty folders included) is the same too
export function planSync({ manifest, entries, dirs = [], ledger }) {
  const files = manifest?.files || {};
  const known = ledger?.files || {};
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const push = [];
  const pull = [];
  const dropRemote = [];
  const dropLocal = [];
  const skipped = [];

  for (const e of entries) {
    if (e.size > MAX_SYNC_FILE_BYTES) { skipped.push({ ...e, why: 'too big' }); continue; }
    const remote = files[e.key];
    if (!remote) {
      // Not in the account. Deleted elsewhere if this device had synced it —
      // unless it has been changed here since (then the change wins, and it
      // goes back up). A legacy ledger has no times, so it never deletes.
      const had = known[e.key];
      if (had && typeof had === 'string' && newer(e.mtime, had) <= MTIME_SLACK_MS) dropLocal.push(e);
      else push.push(e);
      continue;
    }
    const drift = newer(e.mtime, remote.mtime);
    if (drift > MTIME_SLACK_MS) push.push(e);
    else if (drift < -MTIME_SLACK_MS) pull.push({ ...remote, key: e.key });
    else if ((remote.size || 0) !== e.size) push.push(e);   // same minute, different bytes
  }
  for (const [key, remote] of Object.entries(files)) {
    if (byKey.has(key)) continue;
    // Gone from disk: deleted here if this device ever had it, otherwise it is
    // simply a file this device hasn't got yet.
    if (known[key]) dropRemote.push({ ...remote, key });
    else pull.push({ ...remote, key });
  }

  const remoteDirs = manifest?.folders || {};
  const knownDirs = ledger?.folders || {};
  const localDirs = new Set(dirs);
  const folders = { add: [], create: [], dropRemote: [], dropLocal: [] };
  for (const d of localDirs) {
    if (remoteDirs[d]) continue;
    if (knownDirs[d]) folders.dropLocal.push(d); else folders.add.push(d);
  }
  for (const d of Object.keys(remoteDirs)) {
    if (localDirs.has(d)) continue;
    if (knownDirs[d]) folders.dropRemote.push(d); else folders.create.push(d);
  }
  return { push, pull, dropRemote, dropLocal, skipped, folders };
}

// ── Big files travel in parts ───────────────────────────────────────────────
// The bucket takes at most 50 MB per object, so a bigger file is stored as
// numbered parts (`<key>.p0`, `<key>.p1` …) and the manifest records how many.
const PART_BYTES = 45 * 1024 * 1024;
const objectsOf = (projectId, entry) => (entry?.parts
  ? Array.from({ length: entry.parts }, (_, i) => `${projectId}/${entry.key}.p${i}`)
  : [`${projectId}/${entry.key}`]);

async function uploadFile(projectId, key, blob) {
  const type = blob.type || 'application/octet-stream';
  if (blob.size <= PART_BYTES) {
    const { error } = await bucket().upload(`${projectId}/${key}`, blob, { upsert: true, contentType: type });
    if (error) throw error;
    return { parts: 0 };
  }
  const parts = Math.ceil(blob.size / PART_BYTES);
  for (let i = 0; i < parts; i += 1) {
    const { error } = await bucket().upload(`${projectId}/${key}.p${i}`, blob.slice(i * PART_BYTES, (i + 1) * PART_BYTES), {
      upsert: true,
      contentType: 'application/octet-stream',
    });
    if (error) throw error;
  }
  return { parts };
}

async function downloadFile(projectId, entry) {
  if (!entry.parts) {
    const { data, error } = await bucket().download(`${projectId}/${entry.key}`);
    if (error) throw error;
    return data;
  }
  const chunks = [];
  for (const name of objectsOf(projectId, entry)) {
    const { data, error } = await bucket().download(name);
    if (error) throw error;
    chunks.push(data);
  }
  return new Blob(chunks);
}

// ── The sync itself ─────────────────────────────────────────────────────────
// `onProgress({ phase, done, total, name })` — phases: 'reading', 'up', 'down',
// 'cleaning', 'data', 'done'.
export async function syncProject({ projectId, dir, onProgress = () => {}, enable = false }) {
  if (!projectId) return { ok: false, error: 'No project' };
  if (!dir) return { ok: false, error: 'This project has no folder on this device yet.' };

  onProgress({ phase: 'reading', done: 0, total: 0 });
  const { manifest: existing, error: mErr, missingBucket } = await readManifest(projectId);
  if (missingBucket) return { ok: false, error: 'Account sync isn’t set up on this Supabase project yet — apply migration 035.' };
  if (mErr) return { ok: false, error: mErr.message || String(mErr) };
  if (!existing && !enable) return { ok: false, error: 'This project isn’t synced with your account.' };

  // An older app than the one that last synced the project keeps its hands off.
  const appVersion = await currentAppVersion();
  if (existing?.appVersion && isKnownVersion(existing.appVersion) && isKnownVersion(appVersion)
    && compareVersions(existing.appVersion, appVersion) > 0) {
    rememberVersion(projectId, existing.appVersion);
    return {
      ok: false,
      needsVersion: existing.appVersion,
      error: `This project was last synced with Docvex ${existing.appVersion}. This computer has ${appVersion} — update the app to sync it.`,
    };
  }

  const manifest = existing || emptyManifest(projectId);
  const ledger = ledgerFor(projectId, existing);
  if (!manifest.gen) manifest.gen = newGen();
  const { entries, dirs, error: lErr } = await readLocalTree(dir);
  if (lErr) return { ok: false, error: lErr.message };

  const { push, pull, dropRemote, dropLocal, skipped, folders: fplan } = planSync({ manifest, entries, dirs, ledger });
  const files = { ...manifest.files };
  const failed = [];

  // ── up ──
  let done = 0;
  let pushed = 0;
  for (const e of push) {
    onProgress({ phase: 'up', done, total: push.length, name: e.relPath });
    try {
      const blob = await readLocalBlob(e.path);
      const prev = files[e.key];
      const { parts } = await uploadFile(projectId, e.key, blob);
      // A file that shrank below (or grew past) the part size leaves objects
      // of its old shape behind — clear them.
      if (prev && (prev.parts || 0) !== parts) {
        const stale = objectsOf(projectId, { ...prev, key: e.key }).filter((n) => !objectsOf(projectId, { key: e.key, parts }).includes(n));
        if (stale.length) await bucket().remove(stale);
      }
      files[e.key] = { path: e.relPath, size: e.size, mtime: e.mtime, ...(parts ? { parts } : {}) };
      pushed += 1;
    } catch (err) {
      failed.push({ path: e.relPath, error: err?.message || String(err) });
    }
    done += 1;
  }

  // ── down — one file at a time, so a big project never sits in memory whole ──
  done = 0;
  let pulled = 0;
  for (const r of pull) {
    onProgress({ phase: 'down', done, total: pull.length, name: r.path });
    try {
      const blob = await downloadFile(projectId, r);
      const { results, error } = await localFolderApi.writeTree({ dir, files: [{ relPath: r.path, blob, mtime: r.mtime || null }] });
      const res = results?.[0];
      if (error || !res?.ok) throw new Error(error || res?.error || 'write failed');
      pulled += 1;
    } catch (err) {
      failed.push({ path: r.path, error: err?.message || String(err) });
    }
    done += 1;
  }

  // ── what has gone from every device that reported in ──
  const removedPaths = [];
  if (dropRemote.length) {
    onProgress({ phase: 'cleaning', done: 0, total: dropRemote.length });
    const { error } = await bucket().remove(dropRemote.flatMap((r) => objectsOf(projectId, r)));
    if (error) failed.push({ path: '(removing deleted files)', error: error.message });
    else for (const r of dropRemote) { delete files[r.key]; removedPaths.push(r.path); }
  }
  // Deleted on another device: into this device's Trash, never straight off
  // the disk — the Files tab's bin can still bring it back for 30 days.
  let trashed = 0;
  for (const e of dropLocal) {
    try {
      const res = await localFolderApi.trashFile({ dir, path: e.path });
      if (res?.ok === false) throw new Error(res.error || 'could not move it to the Trash');
      trashed += 1;
    } catch (err) {
      failed.push({ path: e.relPath, error: err?.message || String(err) });
    }
  }

  // ── folders ──
  const remoteFolders = { ...(manifest.folders || {}) };
  for (const d of fplan.add) remoteFolders[d] = 1;
  for (const d of fplan.dropRemote) delete remoteFolders[d];
  if (fplan.create.length) {
    const { error } = await localFolderApi.writeTree({ dir, files: [], dirs: fplan.create });
    if (error) failed.push({ path: '(making folders)', error });
  }
  if (fplan.dropLocal.length) {
    // Only folders that are empty here go; one still holding files stays, and
    // goes back into the account's structure.
    const { removed } = await localFolderApi.removeEmptyDirs({ dir, rels: fplan.dropLocal });
    const gone = new Set(removed || []);
    for (const d of fplan.dropLocal) if (!gone.has(d)) remoteFolders[d] = 1;
  }

  // Stamped with this app's version — never lowered (an unknown version, e.g.
  // a web build made without one, leaves the stamp as it was).
  const stamp = isKnownVersion(appVersion)
    && !(manifest.appVersion && compareVersions(manifest.appVersion, appVersion) > 0)
    ? appVersion : (manifest.appVersion || null);
  const next = {
    ...manifest,
    appVersion: stamp,
    files,
    folders: remoteFolders,
    by: (await supabase.auth.getSession()).data.session?.user?.id || manifest.by,
  };
  const { error: wErr } = await writeManifest(projectId, next);
  if (wErr) return { ok: false, error: wErr.message || String(wErr) };
  rememberVersion(projectId, next.appVersion);

  // This device now holds exactly what the manifest lists — recorded with each
  // file's modified time AS IT IS HERE, which is what tells a later deletion
  // elsewhere apart from a change made here since.
  const after = await readLocalTree(dir);
  const localMtime = new Map((after.entries || []).map((e) => [e.key, e.mtime]));
  writeLedger(projectId, {
    gen: next.gen,
    files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, localMtime.get(k) || f.mtime || ''])),
    folders: Object.fromEntries(Object.keys(remoteFolders).map((d) => [d, 1])),
  });

  // ── everything DocVex keeps ABOUT the files (lib/projectSyncData) ──
  // After the files, so the data can be tied to the versions now on disk. A
  // failure here doesn't undo the file sync — it is reported beside it.
  onProgress({ phase: 'data', done: 0, total: 1 });
  let data;
  try {
    data = await syncProjectData({ projectId, dir, manifest: next, removedPaths });
  } catch (err) {
    data = { ok: false, error: err?.message || String(err), applied: 0, privateError: null };
  }
  onProgress({ phase: 'done', done: 1, total: 1 });
  return {
    ok: true,
    error: null,
    pushed,
    pulled,
    removed: removedPaths.length,
    trashed,
    folders: fplan.add.length + fplan.create.length,
    skipped,
    failed,
    data,
    manifest: next,
  };
}

// ── The app version a project was synced with ─────────────────────────────
// Every sync stamps the manifest with the version of the app that ran it
// (`appVersion`). An OLDER app may not touch the project after that — neither
// open it (components/ProjectVersionGate) nor sync it (`syncProject`): it may
// not understand what the newer one saved, and its next write would quietly
// overwrite it. A newer app is fine, and its next sync raises the stamp.
//
// The last stamp seen is remembered per project, so the gate still holds with
// no connection, and answers at once while a fresh read is on its way.
const versionKey = (projectId) => `docvex:sync:app-version:${projectId}`;
// Stored as the version, or '-' for "checked: no version to honour".
function rememberVersion(projectId, version) {
  try { localStorage.setItem(versionKey(projectId), version || '-'); } catch { /* full or blocked */ }
}
// { checked, required } — what this device last learned, without asking.
export function rememberedProjectVersion(projectId) {
  let raw = null;
  try { raw = localStorage.getItem(versionKey(projectId)); } catch { /* unavailable */ }
  return { checked: raw != null, required: raw && raw !== '-' ? raw : null };
}
const knownProjectVersion = (projectId) => rememberedProjectVersion(projectId).required;
// Whether `required` shuts out an app at `current`.
export function versionBlocks(required, current) {
  return !!(required && isKnownVersion(required) && isKnownVersion(current)
    && compareVersions(required, current) > 0);
}

// { required, current, blocked, fresh } — `required` is the version the
// project was last synced with (null when it isn't synced, or was synced before
// versions were recorded); `fresh` says it came from the account just now
// rather than from the remembered stamp.
export async function projectVersionCheck(projectId) {
  const current = await currentAppVersion();
  let required = knownProjectVersion(projectId);
  let fresh = false;
  if (projectId) {
    const { manifest, error } = await readManifest(projectId);
    if (!error) {
      required = manifest?.appVersion || null;
      rememberVersion(projectId, required);
      fresh = true;
    }
  }
  return { required, current, blocked: versionBlocks(required, current), fresh };
}

// Switching it ON is an ordinary sync that is allowed to create the manifest.
export const enableSync = (args) => syncProject({ ...args, enable: true });

// Switching it OFF removes the account's copy — the files on this machine are
// untouched, which is the whole point of saying so in the confirm.
export async function disableSync(projectId) {
  const { manifest, error, missingBucket } = await readManifest(projectId);
  if (missingBucket) return { ok: true, error: null };            // nothing was ever there
  if (error) return { ok: false, error: error.message || String(error) };
  const keys = Object.entries(manifest?.files || {}).flatMap(([key, f]) => objectsOf(projectId, { ...f, key }));
  // The manifest goes last: while it is there, the project still reads as
  // synced, so a failure part way through leaves a state the next sync can fix
  // rather than orphaned objects nothing knows about.
  if (keys.length) {
    const { error: rErr } = await bucket().remove(keys);
    if (rErr) return { ok: false, error: rErr.message };
  }
  const { error: dErr } = await removeProjectData(projectId);
  if (dErr && !notFound(dErr)) return { ok: false, error: dErr.message };
  const { error: mErr } = await bucket().remove([`${projectId}/${MANIFEST_NAME}`]);
  if (mErr) return { ok: false, error: mErr.message };
  forgetLedger(projectId);
  rememberVersion(projectId, null);
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
  const { entries, dirs, error: lErr } = await readLocalTree(dir);
  if (lErr) return { ...base, plan: null };
  return { ...base, plan: planSync({ manifest, entries, dirs, ledger: ledgerFor(projectId, manifest) }) };
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
