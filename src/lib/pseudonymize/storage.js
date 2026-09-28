// Where the vault lives in the app: main's `vault:get` / `vault:put`
// (src/main.js) — a file under userData encrypted with Electron's safeStorage.
// `openProjectVault(projectId)` hands out ONE vault per project per window.
//
// Two windows (the main one and a Doc Viewer) each keep their own copy in
// memory and write the whole vault back; the last write wins. Because tokens
// are numbered per entity and a value once numbered is looked up before a new
// number is given, a lost write can at worst give a value that appeared in
// only one window a different number next time — never put a wrong value back
// (every number resolves only through the copy that made it).
import { Vault } from './vault';
import { makeLayer2, knownEntitiesFrom } from './detectorLayer2';
import { projectDirOf } from '../projectIndexClient';

/** @type {import('./vault').VaultStorage} */
export const electronVaultStorage = {
  async load(projectId) {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.vaultGet) throw new Error('vault_unavailable');   // an old preload: restart the app
    const res = await api.vaultGet(projectId);
    if (res?.error) throw new Error(res.error);
    return res?.data ?? null;
  },
  async save(projectId, data) {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.vaultPut) throw new Error('vault_unavailable');
    const res = await api.vaultPut(projectId, data);
    if (res?.error) throw new Error(res.error);
  },
};

const open = new Map();   // projectId → Promise<Vault>

/**
 * The project's vault, opened once per window.
 * @param {string} projectId
 * @param {{ detectors?: import('./vault').Detector[] }} [opts]
 * @returns {Promise<Vault>}
 */
export function openProjectVault(projectId, { detectors = [] } = {}) {
  if (!projectId) return Promise.reject(new Error('no_project'));
  if (!open.has(projectId)) open.set(projectId, Vault.open(projectId, { storage: electronVaultStorage, detectors }));
  return open.get(projectId);
}

// ── Layer 2: the names the project knows ────────────────────────────────
// Read from the project's data collections (records) and the AI scan's
// parties; re-read at most once a minute. Each known name + CNP / CUI pair is
// LINKED in the vault up front, so the name and the identifier share a number
// whichever the vault meets first.
const REFRESH_MS = 60 * 1000;
const refreshed = new Map();   // projectId → { at, promise }

export function refreshKnownEntities(projectId, vault) {
  const prev = refreshed.get(projectId);
  if (prev && Date.now() - prev.at < REFRESH_MS) return prev.promise;
  const work = (async () => {
    const dir = projectDirOf(projectId);
    if (!dir) return;
    const [{ listProjectIdentities }, { loadScanIndex }] = await Promise.all([import('../identities'), import('../dataCollections')]);
    const [records, web] = await Promise.all([
      listProjectIdentities(dir).catch(() => []),
      loadScanIndex(dir, { projectId }).catch(() => null),
    ]);
    const parties = Object.values(web?.files || {}).flatMap((f) => (Array.isArray(f?.understanding?.parties) ? f.understanding.parties : []));
    const entities = knownEntitiesFrom({ records, parties });
    for (const e of entities) {
      if (e.kind === 'person' && e.cnp) vault.link({ type: 'CNP', value: e.cnp }, { type: 'PERSOANA', value: e.name });
      if (e.kind === 'company' && e.cui) vault.link({ type: 'CUI', value: e.cui }, { type: 'FIRMA', value: e.name });
    }
    vault.detectors = [makeLayer2(entities)];
    void vault.save();
  })().catch(() => { /* names unknown this time: Layer 1 still runs */ });
  // Never holds a call up for long: the first call waits at most 4 s.
  const bounded = Promise.race([work, new Promise((r) => { setTimeout(r, 4000); })]);
  refreshed.set(projectId, { at: Date.now(), promise: bounded });
  return bounded;
}
