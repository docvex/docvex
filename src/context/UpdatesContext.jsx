import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as platform from '../lib/platform';

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

// Pick the best downloadable installer asset for a given OS / CPU arch from a
// release's asset list. Used by the manual-download update fallback on
// platforms where the in-app Squirrel updater can't run (today: the unsigned
// macOS build). Preference is most-specific first so an Apple-Silicon Mac gets
// the arm64 build, not the Intel one. Returns null when the release shipped no
// matching asset (callers then fall back to the release's html_url).
export function installerAssetFor(release, osPlatform, osArch) {
  const assets = release?.assets;
  if (!Array.isArray(assets) || assets.length === 0) return null;

  if (osPlatform === 'darwin') {
    // Default to Apple Silicon when arch is unknown — it's the common case
    // for current Macs, and Rosetta runs an x64 build on arm64 anyway.
    const archRe = osArch === 'x64' ? /(x64|x86_64|intel)/i : /(arm64|aarch64)/i;
    const isDmg = (a) => /\.dmg$/i.test(a.name || '');
    const isDarwinZip = (a) => /darwin/i.test(a.name || '') && /\.zip$/i.test(a.name || '');
    return (
      assets.find((a) => isDmg(a) && archRe.test(a.name)) ||
      assets.find((a) => isDarwinZip(a) && archRe.test(a.name)) ||
      assets.find(isDmg) ||
      assets.find(isDarwinZip) ||
      null
    );
  }

  if (osPlatform === 'win32') {
    // Only the runnable installer — skip the RELEASES manifest + .nupkg deltas.
    return assets.find((a) => /\.Setup\.exe$/i.test(a.name || '')) || null;
  }

  // Linux: .deb → .rpm → AppImage.
  return (
    assets.find((a) => /\.deb$/i.test(a.name || '')) ||
    assets.find((a) => /\.rpm$/i.test(a.name || '')) ||
    assets.find((a) => /\.AppImage$/i.test(a.name || '')) ||
    null
  );
}

export function UpdatesProvider({ children }) {
  const [currentVersion, setCurrentVersion] = useState(null);
  const [isPackaged, setIsPackaged] = useState(false);
  const [osPlatform, setOsPlatform] = useState(null);
  const [osArch, setOsArch] = useState(null);
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

  // Whether the in-app Squirrel updater can actually apply an update in place.
  // Only the Windows build is signed/Squirrel-backed; macOS & Linux are
  // unsigned, so they use the manual browser-download fallback (downloadUpdate
  // below). Mirrors AUTO_UPDATE_SUPPORTED in src/main.js.
  const canAutoUpdate = isPackaged && osPlatform === 'win32';

  // Resolved download URL for the latest release's installer on this platform,
  // used by the manual-download fallback. Falls back to the release page when
  // no matching asset is found.
  const latestAsset = osPlatform ? installerAssetFor(releases[0], osPlatform, osArch) : null;
  const downloadUrl = latestAsset?.browser_download_url || releases[0]?.html_url || null;

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

    (async () => {
      try {
        const v = await platform.getAppVersion();
        if (!cancelled) setCurrentVersion(v);
        const p = await platform.isPackaged();
        if (!cancelled) setIsPackaged(p);
        const info = await platform.getPlatformInfo();
        if (!cancelled) {
          setOsPlatform(info?.platform ?? null);
          setOsArch(info?.arch ?? null);
        }
      } catch {
        /* adapter / IPC missing — fall back to no version */
      }
    })();

    // Subscribe to autoUpdater lifecycle events. On web this is a no-op
    // unsubscribe — installerState stays at 'idle' for the page's lifetime,
    // which is what the web build wants (no installer surface).
    const unsubscribe = platform.onUpdateStatus((payload) => {
      setInstallerState(payload);
    });

    fetchReleases();

    return () => {
      cancelled = true;
      unsubscribe();
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
      const s = await platform.checkForUpdates();
      await finishAfterMinDelay();
      // On Electron dev (state: 'dev'), the web build (state: 'web'), and
      // unsigned macOS/Linux packaged builds (state: 'unsupported') no
      // autoUpdater events will follow — clear the spinner ourselves so the
      // UI quiesces instead of getting stuck on 'checking'. Packaged Windows
      // builds short-circuit on this branch: their checkForUpdates returns a
      // different shape and the autoUpdater status subscription drives
      // installerState past 'checking' via update:status events.
      if (s?.state === 'dev' || s?.state === 'web' || s?.state === 'unsupported') {
        setInstallerState({ state: 'idle' });
      }
    } catch {
      await finishAfterMinDelay();
      setInstallerState({ state: 'idle' });
    }
  }, [fetchReleases]);

  const installUpdate = useCallback(() => {
    platform.installUpdate();
  }, []);

  // Manual-download fallback: open the new build's installer (or the release
  // page when no matching asset exists) in the user's browser. Used as the
  // escape hatch when the in-app self-update fails (e.g. no write access to
  // the app bundle), so the user can still grab the build by hand.
  const downloadUpdate = useCallback(() => {
    if (downloadUrl) platform.openExternal(downloadUrl);
  }, [downloadUrl]);

  // One-click self-update for platforms without a working Squirrel updater
  // (today: the unsigned macOS build). Main downloads the new build, swaps the
  // .app bundle, and relaunches; progress flows back through the update:status
  // subscription as { state: 'downloading', percent } → 'installing'. On
  // success the app quits and the new version relaunches automatically; on
  // failure we surface the error so the UI can offer the browser fallback.
  const downloadAndInstall = useCallback(async () => {
    if (!downloadUrl) return;
    setInstallerState({ state: 'downloading', percent: 0 });
    try {
      const res = await platform.downloadAndInstallUpdate(downloadUrl);
      if (res && res.ok === false) {
        setInstallerState({ state: 'error', message: res.error || 'Update failed.' });
      }
      // On success the app is quitting — no further UI work needed.
    } catch (e) {
      setInstallerState({ state: 'error', message: String(e?.message || e) });
    }
  }, [downloadUrl]);

  const value = {
    currentVersion,
    latestVersion,
    isPackaged,
    osPlatform,
    osArch,
    canAutoUpdate,
    releases,
    loading,
    error,
    hasUpdate,
    installerState,
    checkNow,
    installUpdate,
    downloadUpdate,
    downloadAndInstall,
    downloadUrl,
  };

  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}

export function useUpdates() {
  const ctx = useContext(UpdatesContext);
  if (!ctx) throw new Error('useUpdates must be used inside <UpdatesProvider>');
  return ctx;
}
