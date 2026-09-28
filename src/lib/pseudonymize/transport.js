// The vault at the TRANSPORT layer: lib/projectAi asks `vaultForCall` before
// every text call, masks the body with it and re-identifies the answer — so
// every caller (the scan, the advisor, Research) keeps seeing real values and
// nothing else changes.
//
// FAILURE: a call that should be masked but cannot be (no project, the vault's
// storage refused — safeStorage unavailable, an old preload) FAILS CLOSED: it
// answers `vault_unavailable` and nothing is sent.

import { getAiUsageProject } from '../aiTokenMeter';
import { isPseudonymizeOn, isGuessNamesOn, FAIL_CLOSED } from '../pseudonymizeSetting';
import { openProjectVault, refreshKnownEntities } from './storage';
import { maskBody, makeStreamReidentifier, bodyText } from './wire';
import { detectLayer3 } from './detectorLayer3';
import { recordSent } from './sentLog';

const wire = { maskBody, makeStreamReidentifier, bodyText, recordSent };

export const VAULT_UNAVAILABLE = 'vault_unavailable';

/** The personal vault's id for the signed-in user, or null when signed out. */
export async function personalVaultId() {
  try {
    const { supabase } = await import('../supabaseClient');
    const uid = (await supabase.auth.getSession()).data.session?.user?.id;
    return uid ? `personal-${uid}` : null;
  } catch { return null; }
}

/**
 * Mask a text with the user's personal vault before it is STORED anywhere
 * off this computer (the Playbook's writing samples). Nothing to put back:
 * a writing style reads the same with placeholders. Throws when masking
 * cannot run, so the caller stores nothing rather than the clear text.
 */
export async function maskPersonalText(text) {
  const id = await personalVaultId();
  if (!id) throw new Error(VAULT_UNAVAILABLE);
  const vault = await openProjectVault(id);
  if (vault.storageError) throw new Error(VAULT_UNAVAILABLE);
  const out = vault.mask(String(text || ''), { detectors: [detectLayer3] });
  await vault.save();
  return out;
}

/**
 * @param {string|null|undefined} usageProject — undefined = the selected project
 * @param {string} usageAction
 * @returns {Promise<{ vault: import('./vault').Vault|null, wire?: typeof wire, maskOpts?: { detectors: Function[] }, projectId?: string|null, reason?: string } | { error: string, projectId?: string|null }>}
 */
export async function vaultForCall(usageProject, usageAction) {
  const projectId = usageProject === undefined ? getAiUsageProject() : usageProject;
  const wanted = isPseudonymizeOn(projectId, usageAction) || (!projectId && FAIL_CLOSED.has(usageAction) && usageProject !== null);
  if (!wanted) return { vault: null, projectId };
  // A call that should be masked but cannot be is NOT sent (fail closed) —
  // sending it unmasked would silently undo the protection the user relies on.
  const refuse = (why) => {
    recordSent({ usageAction, projectId, masked: false, sent: false, reason: `not sent: ${why}` });
    return { error: VAULT_UNAVAILABLE, projectId };
  };
  // No project: the signed-in user's personal vault (Mail, the Playbook,
  // Research with nothing selected).
  const vaultId = projectId || await personalVaultId();
  if (!vaultId) return refuse('not signed in');
  try {
    const vault = await openProjectVault(vaultId);
    if (vault.storageError) return refuse(vault.storageError);
    if (projectId) await refreshKnownEntities(projectId, vault);
    // Layer 3 (guessed names) rides on this call only, after the vault's own.
    const maskOpts = { detectors: isGuessNamesOn(projectId, usageAction) ? [detectLayer3] : [] };
    return { vault, wire, maskOpts, projectId };
  } catch (err) {
    return refuse(err?.message || String(err));
  }
}
