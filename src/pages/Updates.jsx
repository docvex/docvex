import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useUpdates, versionTagFor } from '../context/UpdatesContext';
import { useAuth } from '../context/AuthContext';
import { useReportProblem } from '../context/ReportProblemContext';
import ConfirmModal from '../components/ConfirmModal';
import Tooltip from '../components/Tooltip';
import { isElectron, openExternal as platformOpenExternal } from '../lib/platform';
import './Updates.css';

// URL shown to web users in the "Get the desktop app" CTA. Linking to the
// marketing site (not directly to a release asset) so the user lands on
// the install/download page that already exists.
const DESKTOP_DOWNLOAD_URL = 'https://docvex.ro/';
const DOCVEX_SITE = 'https://docvex.ro/';
const SUPPORT_EMAIL = 'customersupport@docvex.ro';
const TEAM_EMAIL = 'docvexteam@docvex.ro';

// Single subtitle shared across all three tabs (Updates / About /
// Contact us). One line covers all of them since they're three views
// of the same "about the app" surface.
const ABOUT_SUBTITLE = 'Learn about DocVex, browse release notes, and get in touch.';

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

const RevertIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {/* Curved arrow pointing back-left — same shape we use for the
        Updates header's RefreshIcon family, just stopping at "back to
        a previous state". */}
    <polyline points="1 4 1 10 7 10"/>
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
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
    installerState,
    checkNow,
    installUpdate,
  } = useUpdates();

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
        <strong >You're up to date</strong>
        <p>Running v{currentVersion || '—'}</p>
      </div>
      <button className="updates-btn" onClick={checkNow} disabled={checking}>
        {RefreshIcon} {checking ? 'Checking…' : 'Check now'}
      </button>
    </div>
  );
}

// Body content for the About tab — what DocVex is and what you can do
// with it. Pulled out as a sibling component so the main Updates page
// reads cleanly with three small tab-body components rather than a
// 200-line render. No top-level <header> because the page already owns
// the title + subtitle row above the tab bar.
function AboutTabBody() {
  const { currentVersion } = useUpdates();
  const openSite = (e) => {
    if (!isElectron) return;
    e.preventDefault();
    platformOpenExternal(DOCVEX_SITE);
  };
  return (
    <div className="updates-about-body">
      <section className="updates-card">
        <h2 className="updates-card-title">What DocVex is</h2>
        <p className="updates-card-body">
          DocVex is a workspace built for legal teams — a single place to
          organise projects, share documents with clients, and keep day-to-day
          work moving without juggling email threads or scattered folders.
        </p>
      </section>

      <section className="updates-card">
        <h2 className="updates-card-title">What you can do here</h2>
        <ul className="updates-card-list">
          <li>Create projects and invite teammates with role-based access.</li>
          <li>Upload, preview, and annotate files alongside your team.</li>
          <li>Manage clients and track to-dos inside each project.</li>
          <li>Stay current with in-app notifications and release updates.</li>
        </ul>
      </section>

      <footer className="updates-about-footer">
        <a
          href={DOCVEX_SITE}
          className="updates-about-link"
          target="_blank"
          rel="noreferrer"
          onClick={openSite}
        >
          docvex.ro
        </a>
        <span className="updates-about-sep">·</span>
        <span>
          {currentVersion ? `Version ${currentVersion}` : 'Desktop & web client'}
        </span>
        <span className="updates-about-sep">·</span>
        <span>© {new Date().getFullYear()} DocVex</span>
      </footer>
    </div>
  );
}

// Body content for the Contact us tab. Surfaces three ways to reach
// the team: the in-app Report-a-problem flow (signed-in only — the
// support function reads the user's JWT), and two mailto links for
// general questions. On Electron we delegate the mailto: open to the
// main process so the default-handler fires there rather than
// navigating the renderer.
function ContactTabBody() {
  const { session } = useAuth();
  const { captureAndOpen: openReportProblem, capturing } = useReportProblem();

  const openMail = (address) => (e) => {
    if (!isElectron) return;
    e.preventDefault();
    platformOpenExternal(`mailto:${address}`);
  };
  const openSite = (e) => {
    if (!isElectron) return;
    e.preventDefault();
    platformOpenExternal(DOCVEX_SITE);
  };

  return (
    <div className="updates-about-body">
      {session && (
        <section className="updates-card">
          <h2 className="updates-card-title">Report a problem</h2>
          <p className="updates-card-body">
            Send the team a description plus an automatic screenshot of what
            you're looking at right now. Fastest path for anything that's
            broken or behaving unexpectedly.
          </p>
          <button
            type="button"
            className="updates-card-cta"
            onClick={openReportProblem}
            disabled={capturing}
          >
            {capturing ? 'Capturing screenshot…' : 'Open report form'}
          </button>
        </section>
      )}

      <section className="updates-card">
        <h2 className="updates-card-title">Email us</h2>
        <p className="updates-card-body">
          For general questions, partnership enquiries, or anything that
          doesn't fit a bug report.
        </p>
        <ul className="updates-contact-list">
          <li>
            <span className="updates-contact-label">Support</span>
            <a
              className="updates-about-link"
              href={`mailto:${SUPPORT_EMAIL}`}
              onClick={openMail(SUPPORT_EMAIL)}
            >
              {SUPPORT_EMAIL}
            </a>
          </li>
          <li>
            <span className="updates-contact-label">Team</span>
            <a
              className="updates-about-link"
              href={`mailto:${TEAM_EMAIL}`}
              onClick={openMail(TEAM_EMAIL)}
            >
              {TEAM_EMAIL}
            </a>
          </li>
        </ul>
      </section>

      <footer className="updates-about-footer">
        <a
          href={DOCVEX_SITE}
          className="updates-about-link"
          target="_blank"
          rel="noreferrer"
          onClick={openSite}
        >
          docvex.ro
        </a>
      </footer>
    </div>
  );
}

export default function Updates() {
  const { releases, currentVersion, loading, error } = useUpdates();

  // Active tab. Defaults to 'updates' because that was the page's prior
  // sole purpose; About + Contact us are the new additions that joined
  // the same hub when the sidebar's brand button started routing here.
  const [activeTab, setActiveTab] = useState('updates');

  // Revert-confirmation modal state. `pendingRevert` holds the release the
  // user is about to roll back to (null when no modal). One state object
  // for the whole page rather than per-card so only one modal can be open
  // at a time and the confirm handler has direct access to the release.
  const [pendingRevert, setPendingRevert] = useState(null);

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

  const tabs = [
    { id: 'updates', label: 'Updates' },
    { id: 'about',   label: 'About' },
    { id: 'contact', label: 'Contact us' },
  ];

  return (
    <div className="updates-page">
      <header className="updates-header">
        <h1 className="updates-title">About</h1>
        <p className="updates-subtitle">{ABOUT_SUBTITLE}</p>
      </header>

      {/* Tab bar — same underline pattern as ProjectDashboard. role="tablist"
          so screen readers announce the relationship; each button is a tab
          whose pressed state mirrors activeTab. */}
      <div className="updates-tabs" role="tablist" aria-label="About sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={`updates-tab ${activeTab === t.id ? 'is-active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {activeTab === 'about'   && <AboutTabBody />}
      {activeTab === 'contact' && <ContactTabBody />}

      {activeTab === 'updates' && (
      <>
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

              {/* Revert action lives at the bottom-right of the card so it
                  doesn't compete with the release title/notes for attention.
                  Only shown on OTHER versions (current = no-op). Disabled
                  when the release didn't ship a Setup.exe asset (drafts,
                  source-only tags). Click triggers a browser download of
                  the Squirrel installer; the user runs it manually.
                  Caveat surfaced via title attr: update-electron-app will
                  re-pull the latest release on next launch — this is for
                  ad-hoc testing of older builds, not a long-term pin.
                  Hidden on web — web users have no local install to
                  roll back; the top-of-page CTA already covers their
                  "download the desktop app" path. */}
              {isElectron && !isCurrent && (() => {
                const setup = setupAssetFor(release);
                // Button is position: absolute (see .release-revert-btn in
                // Updates.css) so it floats over the card's bottom-right
                // corner without consuming layout space — release notes
                // flow as if the button weren't there.
                return (
                  <Tooltip
                    content={
                      setup
                        ? `Download v${ver}'s installer to revert. Heads up: auto-update will pull the latest version again on next launch.`
                        : 'No Setup.exe asset on this release.'
                    }
                  >
                    <button
                      type="button"
                      className="release-revert-btn"
                      onClick={() => setup && requestRevert(release)}
                      disabled={!setup}
                    >
                      {RevertIcon} Revert to this version
                    </button>
                  </Tooltip>
                );
              })()}
            </article>
          );
        })}
      </section>
      </>
      )}

      {/* Confirm before triggering a downgrade download. Two reasons:
          (1) Reverting opens a system installer and replaces the running
              app's files — not destructive, but it interrupts whatever
              the user is doing, so a brief "are you sure" is warranted.
          (2) The wording also surfaces the auto-update caveat (Squirrel
              will re-pull the latest on next launch) where the user is
              already paying attention. */}
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
