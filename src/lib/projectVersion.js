// The app-version stamp a synced project carries — the small, synchronous half
// of it, kept apart from lib/projectSync so the version gate
// (components/ProjectVersionGate), which wraps every project route, can answer
// from what this device remembers without loading the whole account-sync code
// (Supabase storage, the E2E keys, the data bundles). The network check itself
// (`projectVersionCheck`) stays in lib/projectSync and is loaded on demand.
import { compareVersions, isKnownVersion } from './appVersion';

const versionKey = (projectId) => `docvex:sync:app-version:${projectId}`;

// Stored as the version, or '-' for "checked: no version to honour".
export function rememberVersion(projectId, version) {
  try { localStorage.setItem(versionKey(projectId), version || '-'); } catch { /* full or blocked */ }
}

// { checked, required } — what this device last learned, without asking.
export function rememberedProjectVersion(projectId) {
  let raw = null;
  try { raw = localStorage.getItem(versionKey(projectId)); } catch { /* unavailable */ }
  return { checked: raw != null, required: raw && raw !== '-' ? raw : null };
}

// Whether `required` shuts out an app at `current`.
export function versionBlocks(required, current) {
  return !!(required && isKnownVersion(required) && isKnownVersion(current)
    && compareVersions(required, current) > 0);
}
