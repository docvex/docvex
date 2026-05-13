import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const UpdatesContext = createContext(null);

const REPO = 'petreluca1105-dotcom/docvex';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases`;

// sessionStorage cache for the GitHub /releases response. Keyed by version so a
// schema change to the cached shape is a free invalidation (bump :v1 → :v2).
// sessionStorage (not localStorage) intentionally: cache survives in-window
// navigation but evicts on app quit, which lines up with the auto-updater
// possibly having installed a newer build by the next launch.
const CACHE_KEY = 'docvex:releases-cache:v1';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function readReleasesCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.releases) || typeof parsed.fetchedAt !== 'number') return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed.releases;
  } catch {
    // Corrupt payload, quota error, or sessionStorage unavailable — ignore
    // and let the caller refetch. Cache poison can't outlive one bad read.
    return null;
  }
}

function writeReleasesCache(releases) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ releases, fetchedAt: Date.now() }));
  } catch {
    /* quota / private-mode — non-fatal, just lose the cache for this session */
  }
}

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

const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+/;

// Resolve the user-meaningful version string for a GitHub release. Normally
// this is `tag_name` (e.g. "v1.1.0"), but electron-forge's publisher creates
// drafts with `tag_name="untagged-<sha>"`; if the user clicks "Publish release"
// on GitHub without picking a real tag from the dropdown, that placeholder
// sticks around forever. The real version is still available in `release.name`,
// so we prefer tag_name when it parses as semver and fall back to name when
// it doesn't. Exported so the Updates page renders the same string.
export function versionTagFor(release) {
  if (release?.tag_name && SEMVER_TAG_RE.test(release.tag_name)) return release.tag_name;
  if (release?.name && SEMVER_TAG_RE.test(release.name)) return release.name;
  return release?.tag_name || release?.name || '';
}

export function UpdatesProvider({ children }) {
  const [currentVersion, setCurrentVersion] = useState(null);
  const [isPackaged, setIsPackaged] = useState(false);
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [installerState, setInstallerState] = useState({ state: 'idle' });

  // Tracks an in-flight fetch promise so concurrent callers (mount effect +
  // a rapid "Check now" click) share one network request instead of stacking.
  // Cleared in the finally block of the fetch.
  const inFlightRef = useRef(null);

  const latestVersion = releases[0] ? versionTagFor(releases[0]).replace(/^v/, '') : null;
  const hasUpdate = !!(currentVersion && latestVersion && semverGT(latestVersion, currentVersion));

  // fetchReleases({ force }) — when force is false (default) and a fresh
  // sessionStorage cache exists, hydrate from cache and skip the network.
  // Manual "Check now" passes force=true to bypass and always hit the API.
  const fetchReleases = useCallback(async ({ force = false } = {}) => {
    // Cache hit — hydrate synchronously and we're done.
    if (!force) {
      const cached = readReleasesCache();
      if (cached) {
        setReleases(cached);
        setLoading(false);
        setError(null);
        return cached;
      }
    }

    // Dedup concurrent callers — return the in-flight promise instead of
    // stacking a second fetch.
    if (inFlightRef.current) return inFlightRef.current;

    setLoading(true);
    setError(null);

    const promise = (async () => {
      try {
        const res = await fetch(RELEASES_URL, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
        const data = await res.json();
        // Filter out drafts (user only cares about published releases) and
        // sort by semver desc — version-based, not chronological. This is
        // intentional: if a backport patch (say v1.0.5) is ever published
        // AFTER a newer minor (v1.1.0), the chronological order would put
        // v1.0.5 on top, which is misleading for release notes. Version
        // ordering keeps "what's the latest" honest and also keeps the
        // Updates page's color-coding correct, since releaseKind() assumes
        // releases[idx+1] is the next-lower version.
        const published = data
          .filter((r) => !r.draft)
          .sort((a, b) => {
            const av = versionTagFor(a);
            const bv = versionTagFor(b);
            if (semverGT(av, bv)) return -1;
            if (semverGT(bv, av)) return 1;
            return 0;
          });
        setReleases(published);
        writeReleasesCache(published);
        return published;
      } catch (e) {
        setError(e.message || 'Failed to load releases');
        return null;
      } finally {
        setLoading(false);
        inFlightRef.current = null;
      }
    })();

    inFlightRef.current = promise;
    return promise;
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
    // Show the user that *something* is happening: flip to 'checking' immediately
    // so the bottom progress bar appears and the button label switches to
    // "Checking…". Without this, dev-mode clicks were a silent no-op because
    // update:check short-circuits to {state:'dev'} (which has no UI) and the
    // GitHub fetch alone gives no signal.
    setInstallerState({ state: 'checking' });
    // Minimum visible duration so a fast GitHub fetch (sometimes <500ms)
    // doesn't blink the spinner past too quickly to read. 2s is long enough
    // for one full sweep of the progress-bar animation (1.4s cycle) plus a
    // bit of dwell, short enough not to feel sluggish.
    const MIN_VISIBLE_MS = 2000;
    const start = Date.now();
    const finishAfterMinDelay = async () => {
      const elapsed = Date.now() - start;
      const remaining = MIN_VISIBLE_MS - elapsed;
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    };
    try {
      // Manual "Check now" — always hit GitHub. The MIN_VISIBLE_MS floor
      // above still keeps the spinner up long enough to read.
      await fetchReleases({ force: true });
      if (window.electronAPI?.checkForUpdates) {
        const s = await window.electronAPI.checkForUpdates();
        await finishAfterMinDelay();
        if (s?.state === 'dev') {
          // No autoUpdater events will follow in dev — clear the spinner
          // ourselves so the UI quiesces instead of getting stuck on 'checking'.
          setInstallerState({ state: 'idle' });
        }
        // In packaged builds the subsequent autoUpdater events (checking →
        // downloading/up-to-date/error) drive installerState via the
        // update:status subscription, so we deliberately don't overwrite with
        // the IPC return value here. If those events arrived during the
        // min-delay wait, they've already updated installerState past
        // 'checking'; if not, it stays on 'checking' until they do.
      } else {
        await finishAfterMinDelay();
        setInstallerState({ state: 'idle' });
      }
    } catch {
      await finishAfterMinDelay();
      setInstallerState({ state: 'idle' });
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
