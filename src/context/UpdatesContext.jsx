import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const UpdatesContext = createContext(null);

const REPO = 'petreluca1105-dotcom/docvex';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases`;

// Tiny semver comparator (major.minor.patch). Returns true if a > b.
// Strips any leading "v" and ignores pre-release suffixes — sufficient for
// the simple x.y.z tags Squirrel produces.
function semverGT(a, b) {
  const norm = (v) => String(v || '').replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return true;
    if (da < db) return false;
  }
  return false;
}

export function UpdatesProvider({ children }) {
  const [currentVersion, setCurrentVersion] = useState(null);
  const [isPackaged, setIsPackaged] = useState(false);
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [installerState, setInstallerState] = useState({ state: 'idle' });

  const latestVersion = releases[0]?.tag_name?.replace(/^v/, '') || null;
  const hasUpdate = !!(currentVersion && latestVersion && semverGT(latestVersion, currentVersion));

  const fetchReleases = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
      const data = await res.json();
      // Filter out drafts; user only cares about published releases.
      setReleases(data.filter((r) => !r.draft));
    } catch (e) {
      setError(e.message || 'Failed to load releases');
    } finally {
      setLoading(false);
    }
  }, []);

  // One-time bootstrap: current version, packaged flag, release list, status sub.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = null;

    (async () => {
      try {
        if (window.electronAPI?.getAppVersion) {
          const v = await window.electronAPI.getAppVersion();
          if (!cancelled) setCurrentVersion(v);
        }
        if (window.electronAPI?.isPackaged) {
          const p = await window.electronAPI.isPackaged();
          if (!cancelled) setIsPackaged(p);
        }
      } catch {
        /* preload missing — fall back to no version */
      }
    })();

    if (window.electronAPI?.onUpdateStatus) {
      unsubscribe = window.electronAPI.onUpdateStatus((payload) => {
        setInstallerState(payload);
      });
    }

    fetchReleases();

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, [fetchReleases]);

  const checkNow = useCallback(async () => {
    await fetchReleases();
    if (window.electronAPI?.checkForUpdates) {
      try {
        const s = await window.electronAPI.checkForUpdates();
        if (s) setInstallerState(s);
      } catch {
        /* non-fatal */
      }
    }
  }, [fetchReleases]);

  const installUpdate = useCallback(() => {
    window.electronAPI?.installUpdate?.();
  }, []);

  const value = {
    currentVersion,
    latestVersion,
    isPackaged,
    releases,
    loading,
    error,
    hasUpdate,
    installerState,
    checkNow,
    installUpdate,
  };

  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}

export function useUpdates() {
  const ctx = useContext(UpdatesContext);
  if (!ctx) throw new Error('useUpdates must be used inside <UpdatesProvider>');
  return ctx;
}
