import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useUpdates, versionTagFor } from '../context/UpdatesContext';
import './Updates.css';

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

function openExternal(e, url) {
  e.preventDefault();
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, '_blank');
  }
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
    installerState,
    checkNow,
    installUpdate,
  } = useUpdates();

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
          {DownloadIcon} Restart & install
        </button>
      </div>
    );
  }

  if (hasUpdate) {
    // Primary action when an update is available. In packaged builds, clicking
    // kicks autoUpdater.checkForUpdates() which begins Squirrel's background
    // download — the bottom progress bar appears while that runs. In dev we
    // can't actually install, so the button explains itself instead.
    return (
      <div className="updates-banner updates-banner-update">
        <div>
          <strong>New version available: v{latestVersion}</strong>
          <p>
            You're on v{currentVersion}.{' '}
            {isPackaged
              ? 'Click below to download the installer; the app will restart to apply it once ready.'
              : 'Auto-update is only active in packaged builds.'}
          </p>
        </div>
        <button
          className="updates-btn updates-btn-primary"
          onClick={checkNow}
          disabled={checking || !isPackaged}
          title={!isPackaged ? 'Available in packaged builds only' : undefined}
        >
          {DownloadIcon} {checking ? 'Downloading…' : 'Install update'}
        </button>
      </div>
    );
  }

  return (
    <div className="updates-banner updates-banner-uptodate">
      <div>
        <strong >You're up to date</strong>
        <p>Running v{currentVersion || '—'}</p>
      </div>
      <button className="updates-btn" onClick={checkNow} disabled={checking}>
        {RefreshIcon} {checking ? 'Checking…' : 'Check now'}
      </button>
    </div>
  );
}

export default function Updates() {
  const { releases, currentVersion, loading, error } = useUpdates();

  return (
    <div className="updates-page">
      <header className="updates-header">
        <h1 className="updates-title">Updates</h1>
        <p className="updates-subtitle">Version history and release notes from GitHub.</p>
      </header>

      <StatusBanner />

      <section className="updates-releases">
        {loading && releases.length === 0 && (
          <div className="updates-empty">Loading release notes…</div>
        )}

        {!loading && releases.length === 0 && !error && (
          <div className="updates-empty">No releases published yet.</div>
        )}

        {releases.map((release, idx) => {
          // Use the resolved version tag (falls back to release.name when
          // tag_name is the electron-forge `untagged-<sha>` placeholder).
          const tag = versionTagFor(release);
          const ver = tag.replace(/^v/, '');
          const isCurrent = ver === currentVersion;
          // List is newest-first → the previous (older) release is the next index.
          const kind = releaseKind(tag, releases[idx + 1] ? versionTagFor(releases[idx + 1]) : null);
          const cardClass = [
            'release-card',
            isCurrent && 'is-current',
            kind && `is-${kind}`,
          ].filter(Boolean).join(' ');
          return (
            <article key={release.id} className={cardClass}>
              <header className="release-header">
                <div className="release-version-line">
                  <h2 className="release-version">{tag}</h2>
                  {kind && (
                    <span className={`release-tag release-tag-${kind}`}>{kind}</span>
                  )}
                  {isCurrent && <span className="release-tag release-tag-current">Installed</span>}
                  {release.prerelease && <span className="release-tag release-tag-pre">Pre-release</span>}
                </div>
                <div className="release-meta">
                  <span>{formatDate(release.published_at)}</span>
                  <a
                    href={release.html_url}
                    className="release-link"
                    onClick={(e) => openExternal(e, release.html_url)}
                  >
                    View on GitHub {ExternalLinkIcon}
                  </a>
                </div>
              </header>

              {release.name && release.name !== tag && (
                <h3 className="release-name">{release.name}</h3>
              )}

              <div className="release-body">
                {release.body ? (
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
                ) : (
                  <p className="release-empty">No notes provided.</p>
                )}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
