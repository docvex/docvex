import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useUpdates, versionTagFor } from '../context/UpdatesContext';
import ConfirmModal from '../components/ConfirmModal';
import Tooltip from '../components/Tooltip';
import { isElectron, openExternal as platformOpenExternal } from '../lib/platform';
import './Updates.css';

// URL shown to web users in the "Get the desktop app" CTA. Linking to the
// marketing site (not directly to a release asset) so the user lands on
// the install/download page that already exists.
const DESKTOP_DOWNLOAD_URL = 'https://docvex.ro/';

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Parse a GitHub tag_name into a {major, minor, patch} triple. Strips a
// leading `v` and any pre-release suffix (`-beta.1` etc.). Returns null for
// non-semver tags so callers can opt out cleanly (e.g. electron-forge's
// draft `untagged-...` tags).
function parseVersion(tag) {
  if (!tag) return null;
  const cleaned = tag.replace(/^v/, '').split('-')[0];
  const m = cleaned.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

// Classify a release relative to the version that preceded it (the next
// older entry in the newest-first list). The oldest visible release has no
// predecessor — we tag it as 'major' since that's how the project began.
function releaseKind(currentTag, previousTag) {
  const c = parseVersion(currentTag);
  if (!c) return null;
  if (!previousTag) return 'major';
  const p = parseVersion(previousTag);
  if (!p) return null;
  if (c.major !== p.major) return 'major';
  if (c.minor !== p.minor) return 'minor';
  if (c.patch !== p.patch) return 'patch';
  return null;
}

const KIND_LABEL = { major: 'Major', minor: 'Minor', patch: 'Patch' };

// Short commit reference for a release's footer. GitHub's `target_commitish`
// is usually a branch name ("main"); only show it when it actually looks
// like a commit sha so the foot reads like the design's "v5.1.0 · 8f3ac21".
function shortCommit(release) {
  const c = release?.target_commitish;
  if (typeof c === 'string' && /^[0-9a-f]{7,40}$/i.test(c)) return c.slice(0, 7);
  return null;
}

// ── Icons ────────────────────────────────────────────────────────────────
// Inline SVG constants — no icon library (house convention). Stroke icons
// inherit currentColor so they pick up hover/active states.
const RefreshIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"/>
    <polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
);

const DownloadIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);

const ExternalLinkIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    <polyline points="15 3 21 3 21 9"/>
    <line x1="10" y1="14" x2="21" y2="3"/>
  </svg>
);

const RevertIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10"/>
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
  </svg>
);

// Disclosure chevron — points down when expanded, CSS rotates it to point
// right when collapsed.
const ChevronIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);

const TagIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
    <line x1="7" y1="7" x2="7.01" y2="7"/>
  </svg>
);

// Pick the Squirrel installer asset out of a release's asset list. Skips
// the RELEASES manifest and the per-version .nupkg deltas — those are part
// of the auto-update protocol, not user-runnable installers. Returns null
// if the release shipped without a Setup.exe (drafts, source-only tags).
function setupAssetFor(release) {
  if (!release?.assets) return null;
  return release.assets.find((a) => /\.Setup\.exe$/i.test(a.name)) ?? null;
}

function openExternal(e, url) {
  e.preventDefault();
  platformOpenExternal(url);
}

// Web-only banner. The Electron install/restart UI doesn't apply on the
// web build — show release-notes context plus a CTA back to the desktop
// download page. Doubles as cross-promotion.
function DesktopAppBanner() {
  const { latestVersion } = useUpdates();
  return (
    <div className="updates-banner updates-banner-update">
      <div>
        <strong>Get the desktop app{latestVersion ? ` — v${latestVersion}` : ''}</strong>
        <p>
          Docvex's desktop build for Windows installs locally, runs offline,
          and auto-updates in the background. Release notes for the desktop
          builds are below.
        </p>
      </div>
      <button
        className="updates-btn updates-btn-primary"
        onClick={(e) => openExternal(e, DESKTOP_DOWNLOAD_URL)}
      >
        {DownloadIcon} Download for Windows
      </button>
    </div>
  );
}

function StatusBanner() {
  const {
    currentVersion,
    latestVersion,
    hasUpdate,
    loading,
    error,
    releases,
    isPackaged,
    canAutoUpdate,
    installerState,
    checkNow,
    installUpdate,
    downloadUpdate,
    downloadAndInstall,
    downloadUrl,
  } = useUpdates();

  // Bump kind of the available update (latest vs installed), used to colour
  // the "New version available" banner the same way the release cards are
  // colour-coded (major → red, minor → blue, patch → neutral).
  const updateKind = releaseKind(latestVersion, currentVersion);
  const updateBannerClass = `updates-banner updates-banner-update${updateKind ? ` is-${updateKind}` : ''}`;

  // Web build: no installer state to manage. Render the cross-promotion
  // CTA instead and let the release-notes section below handle the
  // changelog. Errors and the initial-loading state still fall through to
  // the desktop branch (they're useful signal on both targets).
  if (!isElectron && !loading && !error) {
    return <DesktopAppBanner />;
  }

  if (loading && releases.length === 0) {
    return <div className="updates-banner updates-banner-info">Checking GitHub for releases…</div>;
  }

  if (error) {
    return (
      <div className="updates-banner updates-banner-error">
        <div>
          <strong>Couldn't reach GitHub.</strong>
          <p>{error}</p>
        </div>
        <button className="updates-btn" onClick={checkNow}>
          {RefreshIcon} Retry
        </button>
      </div>
    );
  }

  const installerReady = installerState.state === 'downloaded';
  const checking = installerState.state === 'checking' || installerState.state === 'downloading';

  if (installerReady) {
    return (
      <div className="updates-banner updates-banner-success">
        <div>
          <strong>Update ready to install</strong>
          <p>Version {installerState.releaseName || latestVersion} has been downloaded. Restart to apply.</p>
        </div>
        <button className="updates-btn updates-btn-primary" onClick={installUpdate}>
          {DownloadIcon} Restart &amp; install
        </button>
      </div>
    );
  }

  // The in-app Squirrel updater errored (e.g. a transient network/feed
  // failure on Windows). Don't leave the user stranded — offer the manual
  // download of the latest build. Only surfaced when there's actually a
  // newer version to grab.
  if (installerState.state === 'error' && hasUpdate) {
    return (
      <div className="updates-banner updates-banner-error">
        <div>
          <strong>Couldn't install the update automatically</strong>
          <p>
            {installerState.message || 'The in-app updater hit an error.'}{' '}
            You can download v{latestVersion} manually instead.
          </p>
        </div>
        <button
          className="updates-btn updates-btn-primary"
          onClick={downloadUpdate}
          disabled={!downloadUrl}
        >
          {DownloadIcon} Download v{latestVersion}
        </button>
      </div>
    );
  }

  // Platforms whose packaged build can't auto-update via Squirrel (today: the
  // unsigned macOS build) get a one-click self-update: main downloads the new
  // build, swaps the .app bundle, and relaunches automatically. Progress shows
  // in the button label; the browser-download fallback lives in the error
  // banner above if the swap can't complete (e.g. no write access).
  if (hasUpdate && isPackaged && !canAutoUpdate) {
    const downloading = installerState.state === 'downloading';
    const installing = installerState.state === 'installing' || installerState.state === 'ready-relaunch';
    const busy = downloading || installing;
    const pct = typeof installerState.percent === 'number' ? installerState.percent : null;
    let label = `Update to v${latestVersion}`;
    if (downloading) label = pct != null ? `Downloading… ${pct}%` : 'Downloading…';
    else if (installing) label = 'Installing…';
    return (
      <div className={updateBannerClass}>
        <div>
          <strong>New version available — v{latestVersion}</strong>
          <p>
            You're on v{currentVersion}.{' '}
            {busy
              ? 'Downloading and installing — the app will restart automatically when it’s ready.'
              : 'Click below to download and install it; the app restarts automatically to apply the update.'}
          </p>
        </div>
        <Tooltip content={!downloadUrl ? 'No downloadable build on this release yet' : undefined}>
          <button
            className="updates-btn updates-btn-primary"
            onClick={downloadAndInstall}
            disabled={busy || !downloadUrl}
          >
            {DownloadIcon} {label}
          </button>
        </Tooltip>
      </div>
    );
  }

  if (hasUpdate) {
    // Primary action when an update is available. In packaged builds, clicking
    // kicks autoUpdater.checkForUpdates() which begins Squirrel's background
    // download — the bottom progress bar appears while that runs. In dev we
    // can't actually install, so the button explains itself instead.
    return (
      <div className={updateBannerClass}>
        <div>
          <strong>New version available — v{latestVersion}</strong>
          <p>
            You're on v{currentVersion}.{' '}
            {isPackaged
              ? 'Download the installer; DocVex restarts to apply it once ready.'
              : 'Auto-update is only active in packaged builds.'}
          </p>
        </div>
        <Tooltip content={!isPackaged ? 'Available in packaged builds only' : undefined}>
          <button
            className="updates-btn updates-btn-primary"
            onClick={checkNow}
            disabled={checking || !isPackaged}
          >
            {DownloadIcon} {checking ? 'Downloading…' : 'Install update'}
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="updates-banner updates-banner-uptodate">
      <div>
        <strong>You're up to date</strong>
        <p>Running v{currentVersion || '—'}</p>
      </div>
      <button className="updates-btn" onClick={checkNow} disabled={checking}>
        {RefreshIcon} {checking ? 'Checking…' : 'Check now'}
      </button>
    </div>
  );
}

// ── One release card ───────────────────────────────────────────────────────
// GitHub-style collapsible release card. The version tag/date live in the
// timeline rail to the left (rail variant); inside the card the version is
// repeated as `.ver-inline` for the no-rail fallback and hidden by CSS when
// the rail is shown.
function ReleaseCard({ release, tag, kind, isLatest, isCurrent, expanded, onToggle, onRevert }) {
  const commit = shortCommit(release);
  const cls = [
    'card',
    isCurrent && 'is-installed',
    isLatest && 'is-latest',
  ].filter(Boolean).join(' ');

  return (
    <article className={cls}>
      <header className="card-head">
        <div className="card-titles">
          <button
            type="button"
            className={`disclose${expanded ? ' open' : ''}`}
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse notes for ${tag}` : `Expand notes for ${tag}`}
            onClick={onToggle}
          >
            {ChevronIcon}
          </button>
          <div className="card-title-stack">
            <div className="badge-row">
              <span className="ver-inline">{tag}</span>
              {isLatest && <span className="pill pill-latest">Latest</span>}
              {isCurrent && <span className="pill pill-installed">Installed</span>}
              {kind && <span className={`pill pill-kind kind-${kind}`}>{KIND_LABEL[kind]}</span>}
              {release.prerelease && <span className="pill pill-kind kind-pre">Pre-release</span>}
            </div>
            {/* Every release gets a header — the release name when it differs
                from the tag, otherwise the version tag itself so no card is
                left title-less. */}
            <h3 className="card-name">
              {release.name && release.name !== tag ? release.name : tag}
            </h3>
          </div>
        </div>
        <div className="card-meta">
          <span className="meta-date">{formatDate(release.published_at)}</span>
          <a
            href={release.html_url}
            className="ghlink"
            onClick={(e) => openExternal(e, release.html_url)}
          >
            View on GitHub {ExternalLinkIcon}
          </a>
        </div>
      </header>

      {expanded && (
        <div className="card-body">
          {release.body ? (
            <div className="md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a href={href} onClick={(e) => openExternal(e, href)}>
                      {children}
                    </a>
                  ),
                }}
              >
                {release.body}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="md release-empty">No notes provided.</p>
          )}

          <div className="card-foot">
            <span className="commit">
              {TagIcon} {tag}{commit ? ` · ${commit}` : ''}
            </span>
            {/* Revert is a download of an older Setup.exe — Electron only,
                hidden on the installed version (no-op) and on web (no local
                install to roll back). Disabled when the release shipped no
                installer asset. */}
            {isElectron && !isCurrent && (() => {
              const setup = setupAssetFor(release);
              return (
                <Tooltip
                  content={
                    setup
                      ? `Download v${tag.replace(/^v/, '')}'s installer to revert. Heads up: auto-update will pull the latest version again on next launch.`
                      : 'No Setup.exe asset on this release.'
                  }
                >
                  <button
                    type="button"
                    className="btn btn-revert"
                    onClick={() => setup && onRevert(release)}
                    disabled={!setup}
                  >
                    {RevertIcon} Revert to this version
                  </button>
                </Tooltip>
              );
            })()}
          </div>
        </div>
      )}
    </article>
  );
}

export default function Updates() {
  const { releases, currentVersion, latestVersion, hasUpdate, loading, error } = useUpdates();

  // Compact-header-on-scroll, mirroring the launch hub. The page scrolls inside
  // the single-window pane's `.sv-single-scroll` (falling back to `.main-content`
  // if the structure ever changes); we listen there and toggle a fixed, blurred
  // bar in once the big title has scrolled away. Hysteresis (show past 32px,
  // hide under 8px) prevents flicker at the edge.
  const pageRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const scroller = pageRef.current?.closest('.sv-single-scroll, .main-content');
    if (!scroller) return undefined;
    const onScroll = () => {
      const top = scroller.scrollTop;
      setScrolled((s) => (s ? top > 8 : top > 32));
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  // Clicking the compact-header status pill jumps back to the top (smooth),
  // which also fades the compact bar back out as the big header reappears.
  const scrollToTop = () => {
    const scroller = pageRef.current?.closest('.sv-single-scroll, .main-content');
    scroller?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Revert-confirmation modal state. `pendingRevert` holds the release the
  // user is about to roll back to (null when no modal). One state object for
  // the whole page so only one modal can be open at a time.
  const [pendingRevert, setPendingRevert] = useState(null);

  // Per-release collapse state. Track EXPANDED ids so the default is
  // collapsed; the newest release opens by default so the user lands on the
  // most relevant notes.
  const [expandedIds, setExpandedIds] = useState(() => {
    const first = releases[0];
    return new Set(first ? [first.id] : []);
  });
  const toggleCollapsed = (id) => setExpandedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const requestRevert = (release) => setPendingRevert(release);
  const cancelRevert = () => setPendingRevert(null);
  const confirmRevert = () => {
    const setup = setupAssetFor(pendingRevert);
    if (setup?.browser_download_url) {
      platformOpenExternal(setup.browser_download_url);
    }
    setPendingRevert(null);
  };

  const pendingVer = pendingRevert ? versionTagFor(pendingRevert).replace(/^v/, '') : '';

  // major/minor/patch tag per release, computed from the ORIGINAL
  // newest-first order — each release vs the one that preceded it — so it
  // stays correct regardless of how the list is displayed.
  const kindById = React.useMemo(() => {
    const m = new Map();
    releases.forEach((r, i) => {
      const prev = releases[i + 1] ? versionTagFor(releases[i + 1]) : null;
      m.set(r.id, releaseKind(versionTagFor(r), prev));
    });
    return m;
  }, [releases]);

  // The newest release (releases[0], already semver-sorted desc) is "Latest".
  const latestId = releases[0]?.id ?? null;

  // Update status for the compact header's chip — colour-coded by bump kind
  // when an update is available, gray when up to date (mirrors the status
  // banner + the title-bar pill).
  const compactKind = hasUpdate ? releaseKind(latestVersion, currentVersion) : null;
  const compactStatusClass = hasUpdate
    ? `versions-compact-status is-update${compactKind ? ` is-${compactKind}` : ''}`
    : 'versions-compact-status is-uptodate';

  return (
    <div className="updates-page" ref={pageRef}>
      {/* Compact header — fades/slides in once the big "Versions" title has
          scrolled away, like the launch hub. Fixed to the content area. Carries
          the same up-to-date / update-available status as the banner below. */}
      <div className={`versions-compact${scrolled ? ' is-visible' : ''}`} aria-hidden={!scrolled}>
        <span className="mini-head-text">
          <span className="versions-compact-title">Versions</span>
          <span className="versions-compact-sep" aria-hidden="true">·</span>
          <span className="versions-compact-eyebrow">Release history</span>
        </span>
        {/* Status pill pinned to the right of the mini header (back-to-top). */}
        <Tooltip content="Back to top">
          <button
            type="button"
            className={`${compactStatusClass} mini-head-status`}
            onClick={scrollToTop}
          >
            <span className="versions-compact-dot" aria-hidden="true" />
            {hasUpdate
              ? `Update available${latestVersion ? ` — v${latestVersion}` : ''}`
              : `Up to date${currentVersion ? ` · v${currentVersion}` : ''}`}
          </button>
        </Tooltip>
      </div>
      <div className="page">
        {/* Masthead — mirrors the Projects page: accent eyebrow + muted kicker,
            big display title, then a stat line summarising the release history
            (count + the build you're on vs. the latest). */}
        <header className="updates-masthead">
          <div className="updates-mh-left">
            <div className="updates-mh-eyebrow">
              <span>Release history</span>
              <span className="updates-mh-muted">· Every build, newest first</span>
            </div>
            <h1 className="updates-mh-title">Versions.</h1>
            <p className="updates-mh-kicker">
              {releases.length > 0 ? (
                <>
                  <strong>{releases.length} {releases.length === 1 ? 'release' : 'releases'}</strong> published
                  {currentVersion && <> — you're on <strong>v{currentVersion}</strong></>}
                  {hasUpdate && latestVersion
                    ? <>, latest is <strong>v{latestVersion}</strong>.</>
                    : currentVersion ? <>, the latest build.</> : '.'}
                </>
              ) : (
                <>Release notes and version history for DocVex{currentVersion && <> — you're on <strong>v{currentVersion}</strong></>}.</>
              )}
            </p>
          </div>
        </header>

        <div className="updates-body">
          <StatusBanner />

          <section className="updates-releases">
            {loading && releases.length === 0 && (
              <div className="updates-empty">Loading release notes…</div>
            )}

            {!loading && releases.length === 0 && !error && (
              <div className="updates-empty">No releases published yet.</div>
            )}

            {releases.length > 0 && (
              <div className="rel-list rail rail-rail">
                {releases.map((release) => {
                  const tag = versionTagFor(release);
                  const ver = tag.replace(/^v/, '');
                  const isCurrent = ver === currentVersion;
                  const isLatest = release.id === latestId;
                  const kind = kindById.get(release.id);
                  const expanded = expandedIds.has(release.id);
                  return (
                    <div
                      className={`rel-row${isLatest ? ' row-latest' : ''}`}
                      key={release.id}
                    >
                      <div className={`rail-col node-${kind || 'patch'}${isLatest ? ' is-latest' : ''}`}>
                        <span className="rail-node" aria-hidden="true" />
                        <div className="rail-label">
                          <span className="rail-tag">{tag}</span>
                          <span className="rail-date">{formatDate(release.published_at)}</span>
                        </div>
                      </div>
                      <ReleaseCard
                        release={release}
                        tag={tag}
                        kind={kind}
                        isLatest={isLatest}
                        isCurrent={isCurrent}
                        expanded={expanded}
                        onToggle={() => toggleCollapsed(release.id)}
                        onRevert={requestRevert}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Confirm before triggering a downgrade download. Reverting opens a
          system installer and replaces the running app's files — not
          destructive, but it interrupts the user, and the wording surfaces
          the auto-update caveat (Squirrel re-pulls the latest on next
          launch) where the user is already paying attention. */}
      <ConfirmModal
        open={!!pendingRevert}
        title={`Revert to v${pendingVer}?`}
        message={
          `Your browser will download the v${pendingVer} installer. Run it to roll back to that version. ` +
          `Heads up: auto-update will re-install the latest release the next time you launch Docvex — ` +
          `this is for ad-hoc testing of older builds, not a permanent pin.`
        }
        confirmLabel="Download installer"
        cancelLabel="Cancel"
        onConfirm={confirmRevert}
        onCancel={cancelRevert}
      />
    </div>
  );
}
