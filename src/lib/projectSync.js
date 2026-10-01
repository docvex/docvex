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
// last had synced — kept per device in the encrypted store (`ledgerKey`), which is what
// tells a file deleted here apart from a file added there.
//
// END-TO-END (migration 046, lib/e2e/syncCrypto): nothing in the bucket is
// readable by the server. Every file is encrypted before upload under a
// random per-file key (wrapped by the project key), in parts sealed one by
// one, and stored under a RANDOM object id. The manifest — the only place the
// paths, sizes and times and the file keys live — is sealed with the project
// key and SIGNED with the writer's Ed25519 identity key; a device verifies the
// signature against the signer's published key before reading it, and
// refuses one older (by `seq`) than the last it saw. The path-hash `key`
// below is now only the manifest's internal map key (and the ledger's) — it
// never reaches the server outside the encrypted manifest.
//
// Upgrading: a plaintext manifest from before is read ONCE on a device that
// has never seen an encrypted one, and rewritten encrypted by that sync;
// afterwards that device refuses a plaintext manifest. Plaintext objects of
// the old shape (`<project>/<hash>` / `.p<i>`) are re-uploaded encrypted by
// the next sync on a device that holds the file, then deleted.
import { supabase } from './supabaseClient';
import { localFolderApi, readLocalBlob } from './localFolder';
import { projectKeyRing } from './projectFolderKey';
import { secureStorage, whenSecureStoreReady } from './secureStore';
import { getIdentity, publicKeysOf } from './e2e/identity';
import {
  newFileEntry, fileKeyOf, objectNamesOf, encryptFilePart, decryptFilePart,
  sealManifest, openManifest, isEncryptedManifest,
} from './e2e/syncCrypto';
import { syncProjectData, removeProjectData } from './projectSyncData';
import { currentAppVersion, compareVersions, isKnownVersion } from './appVersion';
import { ipc, hydrateProject } from './projectIndexClient';

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

// ── What this device has seen of the manifest ─────────────────────────────
// `e2e`: it has read or written an ENCRYPTED manifest for this project — from
// then on a plaintext one is refused (the server writing one would otherwise
// be a way to feed this device files). `seq`: the highest sequence number
// seen — an older manifest is refused (the server serving back a past state).
const seenKey = (projectId) => `docvex:sync:e2e-seen:${projectId}`;
function readSeen(projectId) {
  try { const j = JSON.parse(localStorage.getItem(seenKey(projectId)) || 'null'); return j && typeof j === 'object' ? j : { e2e: false, seq: 0 }; } catch { return { e2e: false, seq: 0 }; }
}
function writeSeen(projectId, seen) {
  try { localStorage.setItem(seenKey(projectId), JSON.stringify(seen)); } catch { /* full or blocked */ }
}

async function signerKeyOf(userId) {
  const m = await publicKeysOf([userId]);
  return m.get(userId)?.ed25519 || null;
}
async function isMemberOf(projectId, userId) {
  const { data, error } = await supabase.from('project_members').select('user_id')
    .eq('project_id', projectId).eq('user_id', userId).maybeSingle();
  return !error && !!data;
}

// → { manifest, error, missingBucket?, legacy?, ring? }. `legacy: true` = a
// plaintext manifest from before end-to-end encryption, to be rewritten.
export async function readManifest(projectId, { ring = null } = {}) {
  if (!projectId) return { manifest: null, error: new Error('No project') };
  const { data, error } = await bucket().download(`${projectId}/${MANIFEST_NAME}`);
  if (error) {
    if (bucketMissing(error)) return { manifest: null, error, missingBucket: true };
    // No manifest = this project isn't synced. Not an error.
    if (notFound(error)) return { manifest: null, error: null };
    return { manifest: null, error };
  }
  let parsed;
  try {
    parsed = JSON.parse(await data.text());
    if (!parsed || typeof parsed !== 'object') throw new Error('bad manifest');
  } catch (err) {
    return { manifest: null, error: err };
  }
  const seen = readSeen(projectId);
  if (!isEncryptedManifest(parsed)) {
    if (seen.e2e) {
      return { manifest: null, error: Object.assign(new Error('The synced copy in the account is not signed — it was not written by DocVex. Sync stopped.'), { code: 'manifest_unsigned' }) };
    }
    return {
      manifest: { ...emptyManifest(projectId), ...parsed, files: parsed.files || {}, folders: parsed.folders || {}, seq: 0 },
      error: null,
      legacy: true,
    };
  }
  const r = ring || await projectKeyRing(projectId);
  if (!r) return { manifest: null, error: Object.assign(new Error('The project key isn’t on this device yet — a project admin needs to open the project to grant it.'), { code: 'no_key' }) };
  try {
    const opened = await openManifest(r, projectId, parsed, {
      signerKeyOf,
      isMember: (uid) => isMemberOf(projectId, uid),
    });
    if (opened.seq < (Number(seen.seq) || 0)) {
      return { manifest: null, error: Object.assign(new Error('The account handed back an OLDER copy of this project than this device has already seen. Sync stopped.'), { code: 'manifest_rollback' }) };
    }
    writeSeen(projectId, { e2e: true, seq: Math.max(opened.seq, Number(seen.seq) || 0) });
    const m = opened.manifest;
    return {
      manifest: { ...emptyManifest(projectId), ...m, files: m.files || {}, folders: m.folders || {}, seq: opened.seq },
      error: null,
      signerLeft: opened.signerLeft,
      ring: r,
    };
  } catch (err) {
    return { manifest: null, error: err };
  }
}

async function writeManifest(projectId, manifest, { ring, identity }) {
  const seen = readSeen(projectId);
  const seq = Math.max(Number(manifest.seq) || 0, Number(seen.seq) || 0) + 1;
  const { seq: _drop, ...rest } = manifest;
  const doc = await sealManifest(ring, identity, projectId, { ...rest, projectId, at: new Date().toISOString() }, seq);
  const body = new Blob([JSON.stringify(doc)], { type: 'application/json' });
  const { error } = await bucket().upload(`${projectId}/${MANIFEST_NAME}`, body, {
    upsert: true,
    contentType: 'application/json',
  });
  if (!error) writeSeen(projectId, { e2e: true, seq });
  return { error, seq };
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
// Kept in the ENCRYPTED store (lib/secureStore) — it lists the synced paths.
function readLedger(projectId) {
  try {
    const raw = secureStorage.getItem(ledgerKey(projectId));
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
  try { secureStorage.setItem(ledgerKey(projectId), JSON.stringify(ledger)); } catch { /* full or blocked */ }
}
export function forgetLedger(projectId) {
  try { secureStorage.removeItem(ledgerKey(projectId)); } catch { /* ignore */ }
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

// The project's `.docvex/` folder (src/projectIndex/README.md) travels too —
// `ids.json`, `knowledge/**` and `settings/**` — even though the listing (like
// the Files tab) never shows a dot-folder: it is where everything DocVex knows
// about the files lives now. It is listed on its own, from inside it (its
// children are not dot-names), and its paths are prefixed back. The machine
// index lives in userData and is never part of this.
export const DOCVEX_DIR = '.docvex';
const isDocvexRel = (rel) => rel === DOCVEX_DIR || String(rel).startsWith(`${DOCVEX_DIR}/`);

async function listDocvexDir(dir) {
  const root = `${String(dir).replace(/[\\/]+$/, '')}${String(dir).includes('\\') ? '\\' : '/'}${DOCVEX_DIR}`;
  let res = null;
  try {
    // Straight to main's recursive listing where there is one: this is a plain
    // folder walk, not a project's listing.
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    res = typeof api?.listRecursive === 'function' ? await api.listRecursive(root) : await localFolderApi.listAll(root);
  } catch { res = null; }
  if (!res || res.error) return { files: [], dirs: [] };
  const files = (res.files || []).map((f) => ({ ...f, folderPath: f.folderPath ? `${DOCVEX_DIR}/${f.folderPath}` : DOCVEX_DIR }));
  const dirs = [DOCVEX_DIR, ...(Array.isArray(res.dirs) ? res.dirs.map((d) => `${DOCVEX_DIR}/${d}`) : [])];
  return files.length ? { files, dirs } : { files: [], dirs: [] };
}

async function readLocalTree(dir) {
  const { files, dirs, error } = await localFolderApi.listAll(dir);
  if (error) return { entries: [], dirs: [], error: new Error(error) };
  const own = await listDocvexDir(dir);
  const entries = [];
  for (const f of [...(files || []), ...own.files]) {
    const relPath = relPathOf(f);
    entries.push({
      relPath,
      path: f.path || relPath,
      size: f.sizeBytes || 0,
      mtime: f.mtimeIso || null,
      key: await keyFor(relPath),
    });
  }
  return { entries, dirs: [...(Array.isArray(dirs) ? dirs : []), ...own.dirs], error: null };
}

// How many files the project has on THIS device — what "not on this device"
// means for the Hub. A folder that exists but is empty counts as not here: on
// the desktop every project gets a folder made for it whether or not anything
// was ever put in it.
export async function countLocalFiles(dir) {
  if (!dir) return 0;
  const { files } = await localFolderApi.listAll(dir);
  // The project file (`<name>.docvex`) is written the moment a folder is
  // linked — it is not "the project's files being here".
  return (files || []).filter((f) => !/\.docvex$/i.test(f.name || '')).length;
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

// ── Files travel encrypted, in parts ───────────────────────────────────────
// An ENCRYPTED entry (`enc: 1`, lib/e2e/syncCrypto) is `parts` objects named
// `<project>/<random obj id>.<i>`. A LEGACY entry (before 046) is the plain
// file at `<project>/<key>`, or `<key>.p0…` for a big one.
const isEncEntry = (entry) => entry?.enc === 1 && typeof entry.obj === 'string';
const objectsOf = (projectId, entry) => {
  if (isEncEntry(entry)) return objectNamesOf(projectId, entry);
  return entry?.parts
    ? Array.from({ length: entry.parts }, (_, i) => `${projectId}/${entry.key}.p${i}`)
    : [`${projectId}/${entry.key}`];
};

// Encrypt and upload a file. → the manifest's crypto fields for it.
async function uploadFile(projectId, ring, blob) {
  const { entry, fileKey } = await newFileEntry(ring, projectId, blob.size);
  const read = async (a, b) => new Uint8Array(await blob.slice(a, b).arrayBuffer());
  for (let i = 0; i < entry.parts; i += 1) {
    const ct = await encryptFilePart(fileKey, projectId, entry, i, read, blob.size);
    const { error } = await bucket().upload(`${objectNamesOf(projectId, entry)[i]}`, new Blob([ct], { type: 'application/octet-stream' }), {
      upsert: false,
      contentType: 'application/octet-stream',
    });
    if (error) {
      // Nothing points at what went up so far — take it back.
      await bucket().remove(objectNamesOf(projectId, entry).slice(0, i)).catch(() => {});
      throw error;
    }
  }
  return entry;
}

async function downloadFile(projectId, ring, entry) {
  if (!isEncEntry(entry)) {
    // A legacy plaintext object (re-uploaded encrypted by a later sync).
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
  const fileKey = await fileKeyOf(ring, projectId, entry);
  const chunks = [];
  const names = objectNamesOf(projectId, entry);
  for (let i = 0; i < names.length; i += 1) {
    const { data, error } = await bucket().download(names[i]);
    if (error) throw error;
    chunks.push(await decryptFilePart(fileKey, projectId, entry, i, new Uint8Array(await data.arrayBuffer())));
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
  // The ledger lives in the encrypted store, which hydrates after sign-in; an
  // empty ledger read too early would make deletions here look like files to
  // pull back.
  const storeReady = await Promise.race([whenSecureStoreReady(), new Promise((r) => setTimeout(() => r(false), 10000))]);
  if (!storeReady) return { ok: false, error: 'This device’s encrypted store isn’t ready yet — try again in a moment.' };
  // Encryption first: without the project key and this user's identity (to
  // sign the manifest) nothing is read or written.
  const identity = await getIdentity();
  if (!identity) return { ok: false, error: 'This device has no encryption keys yet — set them up (or restore them) in Account → Encryption keys.', code: 'no_identity' };
  const ring = await projectKeyRing(projectId);
  if (!ring) return { ok: false, error: 'The project key isn’t on this device yet — a project admin needs to open the project to grant it.', code: 'no_key' };
  if (ring.behind) return { ok: false, error: 'The project key was renewed and this device hasn’t been given the new one yet — a project admin needs to open the project.', code: 'no_key' };
  const { manifest: existing, error: mErr, missingBucket, legacy: legacyManifest } = await readManifest(projectId, { ring });
  if (missingBucket) return { ok: false, error: 'Account sync isn’t set up on this Supabase project yet — apply migration 035.' };
  if (mErr) return { ok: false, error: mErr.message || String(mErr), code: mErr.code || null };
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

  const plan = planSync({ manifest, entries, dirs, ledger });
  const { pull, dropRemote, dropLocal, skipped, folders: fplan } = plan;
  // Files still stored in the account IN CLEAR (before 046) that this device
  // holds unchanged are re-uploaded encrypted now; their old objects go once
  // the new manifest is written.
  const pushKeys = new Set(plan.push.map((e) => e.key));
  const reencrypt = entries.filter((e) => !pushKeys.has(e.key) && manifest.files[e.key]
    && !isEncEntry(manifest.files[e.key]) && e.size <= MAX_SYNC_FILE_BYTES
    && !pull.some((r) => r.key === e.key) && !dropLocal.some((d) => d.key === e.key));
  const push = [...plan.push, ...reencrypt];
  const files = { ...manifest.files };
  const failed = [];
  // Objects to delete once the manifest no longer points at them.
  const garbage = [];

  // ── up ──
  let done = 0;
  let pushed = 0;
  for (const e of push) {
    onProgress({ phase: 'up', done, total: push.length, name: e.relPath });
    try {
      const blob = await readLocalBlob(e.path);
      const prev = files[e.key];
      const enc = await uploadFile(projectId, ring, blob);
      if (prev) garbage.push(...objectsOf(projectId, { ...prev, key: e.key }));
      files[e.key] = { path: e.relPath, size: e.size, mtime: e.mtime, ...enc };
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
      const blob = await downloadFile(projectId, ring, r);
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
    // Out of the manifest now; the objects go once the new manifest is written.
    for (const r of dropRemote) {
      garbage.push(...objectsOf(projectId, r));
      delete files[r.key];
      removedPaths.push(r.path);
    }
  }
  // Deleted on another device: into this device's Trash, never straight off
  // the disk — the Files tab's bin can still bring it back for 30 days.
  // `.docvex/` files are the app's own bookkeeping, not documents — one gone
  // elsewhere (a merged conflict copy, a shard nothing references) is simply
  // removed, not put in the user's Trash.
  let trashed = 0;
  for (const e of dropLocal) {
    if (isDocvexRel(e.relPath)) {
      try { await localFolderApi.deleteFiles({ dir, paths: [e.path] }); } catch { /* the next sync tries again */ }
      continue;
    }
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
  // a dev build with none, leaves the stamp as it was).
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
  let wErr;
  try { ({ error: wErr } = await writeManifest(projectId, next, { ring, identity })); } catch (err) { wErr = err; }
  if (wErr) {
    // The manifest still points at the old objects; the new ones are orphans.
    const fresh = Object.entries(files).filter(([k, f]) => f !== manifest.files[k] && isEncEntry(f))
      .flatMap(([k, f]) => objectsOf(projectId, { ...f, key: k }));
    if (fresh.length) await bucket().remove(fresh).catch(() => {});
    return { ok: false, error: wErr.message || String(wErr) };
  }
  // What the old manifest pointed at and the new one doesn't: replaced
  // versions, and the plaintext objects of files now stored encrypted.
  if (garbage.length) {
    const { error: gErr } = await bucket().remove([...new Set(garbage)]);
    if (gErr) failed.push({ path: '(removing replaced copies)', error: gErr.message });
  }
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

  // What arrived in `.docvex/` (another device's knowledge, settings, ids) is
  // main's to read: ask it to reconcile, then re-read the project's copy in
  // this window so the new knowledge shows without a restart.
  if (pulled && pull.some((r) => isDocvexRel(r.path))) {
    try { await ipc.projectReconcile({ projectId }); } catch { /* main picks it up on its next open */ }
    try { await hydrateProject(projectId, { force: true, dir }); } catch { /* read lazily instead */ }
  }

  // ── everything else DocVex keeps ABOUT the files (lib/projectSyncData) ──
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
    reencrypted: reencrypt.length,
    upgradedManifest: !!legacyManifest,
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
  // Everything in the project's folder goes, whatever it is: the objects are
  // named at random and the list of them lives in the ENCRYPTED manifest, so a
  // device without the key (or a manifest that can't be read) still clears
  // the account's copy fully.
  const { error: lErr0 } = await bucket().list(projectId, { limit: 1 });
  if (lErr0) {
    if (bucketMissing(lErr0)) return { ok: true, error: null };   // nothing was ever there
    return { ok: false, error: lErr0.message || String(lErr0) };
  }
  // The manifest goes last: while it is there, the project still reads as
  // synced, so a failure part way through leaves a state the next sync can fix.
  const keep = new Set([MANIFEST_NAME]);
  for (let round = 0; round < 1000; round += 1) {
    const { data, error: lErr } = await bucket().list(projectId, { limit: 1000 });
    if (lErr) return { ok: false, error: lErr.message };
    const names = (data || []).filter((o) => o?.name && o.id && !keep.has(o.name)).map((o) => `${projectId}/${o.name}`);
    if (!names.length) break;
    const { error: rErr } = await bucket().remove(names);
    if (rErr) return { ok: false, error: rErr.message };
  }
  const { error: dErr } = await removeProjectData(projectId);
  if (dErr && !notFound(dErr)) return { ok: false, error: dErr.message };
  const { error: mErr } = await bucket().remove([`${projectId}/${MANIFEST_NAME}`]);
  if (mErr) return { ok: false, error: mErr.message };
  forgetLedger(projectId);
  rememberVersion(projectId, null);
  try { localStorage.removeItem(seenKey(projectId)); } catch { /* ignore */ }
  return { ok: true, error: null };
}

// The state line: is it synced, how much is in the account, and what a sync
// would do right now. Cheap enough to run on opening the panel (one download +
// one folder walk) but it does read the folder, so callers shouldn't poll it.
export async function syncStatus({ projectId, dir }) {
  const { manifest, error, missingBucket } = await readManifest(projectId);
  if (missingBucket) return { enabled: false, missingBucket: true, error: null };
  // A copy exists but can't be read here (no key yet / unverified): it IS
  // synced — say why nothing more can be shown.
  if (error) return { enabled: error.code ? true : false, error: error.message || String(error), code: error.code || null };
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
