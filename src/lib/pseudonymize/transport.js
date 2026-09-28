// The vault at the TRANSPORT layer: lib/projectAi asks `vaultForCall` before
// every text call, masks the body with it and re-identifies the answer — so
// every caller (the scan, the advisor, Research) keeps seeing real values and
// nothing else changes.
//
// FAILURE: a call that should be masked but cannot be (no project, the vault's
// storage refused — safeStorage unavailable, an old preload) FAILS CLOSED for
// the bulk readers (`FAIL_CLOSED`: the scan, the MRZ reader) — they answer
// `vault_unavailable` and nothing is sent — and goes out unmasked, with a
// warning, for everything else.

import { getAiUsageProject } from '../aiTokenMeter';
import { isPseudonymizeOn, isGuessNamesOn, FAIL_CLOSED } from '../pseudonymizeSetting';
import { openProjectVault, refreshKnownEntities } from './storage';
import { maskBody, makeStreamReidentifier, bodyText } from './wire';
import { detectLayer3 } from './detectorLayer3';
import { recordSent } from './sentLog';

const wire = { maskBody, makeStreamReidentifier, bodyText, recordSent };

export const VAULT_UNAVAILABLE = 'vault_unavailable';

/**
 * @param {string|null|undefined} usageProject — undefined = the selected project
 * @param {string} usageAction
 * @returns {Promise<{ vault: import('./vault').Vault|null, wire?: typeof wire, maskOpts?: { detectors: Function[] }, projectId?: string|null, reason?: string } | { error: string, projectId?: string|null }>}
 */
export async function vaultForCall(usageProject, usageAction) {
  const projectId = usageProject === undefined ? getAiUsageProject() : usageProject;
  const wanted = isPseudonymizeOn(projectId, usageAction) || (!projectId && FAIL_CLOSED.has(usageAction) && usageProject !== null);
  if (!wanted) return { vault: null, projectId };
  const refuse = (why) => {
    if (FAIL_CLOSED.has(usageAction)) {
      recordSent({ usageAction, projectId, masked: false, sent: false, reason: `not sent: ${why}` });
      return { error: VAULT_UNAVAILABLE, projectId };
    }
    // eslint-disable-next-line no-console
    console.warn(`[pseudonymize] sending "${usageAction}" UNMASKED: ${why}`);
    return { vault: null, projectId, reason: `sent unmasked: ${why}` };
  };
  if (!projectId) return refuse('no project');
  try {
    const vault = await openProjectVault(projectId);
    if (vault.storageError) return refuse(vault.storageError);
    await refreshKnownEntities(projectId, vault);
    // Layer 3 (guessed names) rides on this call only, after the vault's own.
    const maskOpts = { detectors: isGuessNamesOn(projectId, usageAction) ? [detectLayer3] : [] };
    return { vault, wire, maskOpts, projectId };
  } catch (err) {
    return refuse(err?.message || String(err));
  }
}
