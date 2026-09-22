// The running app's version, and how two versions compare — what account sync
// stamps on a project (lib/projectSync) and what the project version gate
// (components/ProjectVersionGate) checks before letting an OLDER app open a
// project a newer one has synced.
import { getAppVersion } from './platform';

// major.minor.patch only; a leading `v` and any pre-release suffix are ignored
// (same rule as UpdatesContext's semverGT).
function parts(v) {
  return String(v || '').trim().replace(/^v/i, '').split('-')[0].split('.').map((n) => Number(n) || 0);
}

// A version worth comparing: x.y.z with something other than zeros (the web
// build reports `0.0.0-web` when it was built without a version).
export function isKnownVersion(v) {
  if (!/^v?\d+\.\d+\.\d+/.test(String(v || '').trim())) return false;
  return parts(v).some((n) => n > 0);
}

// <0 when a is older than b, 0 when equal, >0 when newer.
export function compareVersions(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

let cached = null;
export async function currentAppVersion() {
  if (cached) return cached;
  try { cached = String(await getAppVersion() || ''); } catch { cached = ''; }
  return cached;
}
