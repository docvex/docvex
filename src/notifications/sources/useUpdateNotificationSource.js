import { useEffect, useRef } from 'react';
import { useUpdates } from '../../context/UpdatesContext';

/**
 * Translates UpdatesContext transitions into notify() calls.
 *
 * The cornerstone is edge-triggering: we keep refs for the previous
 * `hasUpdate` and `installerState.state` so the toast fires once per
 * transition rather than on every poll. `coalesce` dedupe is the safety net
 * if the same edge somehow fires twice (StrictMode dev double-mount, etc).
 *
 * Notifications:
 *   hasUpdate false → true                  → "Update available v{x}"  (info, View action)
 *   installerState → 'downloaded'           → "Update ready to install" (success, persistent, Restart action)
 *   installerState → 'error'                → "Update error: …"        (error)
 *
 * Action closures are NOT embedded in the notification — they're rebuilt at
 * render time from actionRegistry so rehydrated rows still have working
 * buttons after a restart.
 *
 * @param {(payload: object) => string} notify
 * @param {{ ready: boolean }} [opts]
 */
export function useUpdateNotificationSource(notify, { ready = true } = {}) {
  const { hasUpdate, latestVersion, installerState } = useUpdates();
  const prevHasUpdateRef = useRef(false);
  const prevInstallerStateRef = useRef(null);

  // Transition: no update → update available.
  useEffect(() => {
    if (!ready) return;
    if (hasUpdate && !prevHasUpdateRef.current) {
      notify({
        category: 'update',
        variant: 'info',
        priority: 'high',
        icon: 'download',
        title: `Update available${latestVersion ? ` v${latestVersion}` : ''}`,
        body: 'A newer version of docvex is ready to download.',
        payload: { latestVersion },
        dedupeKey: 'update-available',
        dedupeStrategy: 'coalesce',
      });
    }
    prevHasUpdateRef.current = hasUpdate;
  }, [hasUpdate, latestVersion, ready, notify]);

  // Transitions inside installerState.
  useEffect(() => {
    if (!ready) return;
    const cur = installerState?.state;
    const prev = prevInstallerStateRef.current;
    prevInstallerStateRef.current = cur;

    if (!cur || cur === prev) return;

    if (cur === 'downloaded') {
      notify({
        category: 'update',
        variant: 'success',
        priority: 'high',
        icon: 'download',
        title: 'Update ready to install',
        body: installerState?.releaseName
          ? `Restart docvex to apply ${installerState.releaseName}.`
          : 'Restart docvex to apply the update.',
        payload: { releaseName: installerState?.releaseName ?? null },
        dedupeKey: 'update-downloaded',
        // Replace the earlier "update-available" row with the more actionable one.
        dedupeStrategy: 'replace',
        persistent: true,
      });
    } else if (cur === 'error') {
      notify({
        category: 'update',
        variant: 'error',
        priority: 'critical',
        title: 'Update error',
        body: installerState?.message || 'The auto-updater reported a problem.',
        payload: { message: installerState?.message ?? null },
        dedupeKey: 'update-error',
        dedupeStrategy: 'replace',
      });
    }
    // 'checking', 'downloading', 'up-to-date', 'idle', 'dev' → silent.
  }, [installerState, ready, notify]);
}
