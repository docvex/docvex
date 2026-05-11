import React from 'react';
import { useUpdates } from '../context/UpdatesContext';
import './UpdateProgressBar.css';

// Bottom-of-screen progress strip shown during the active phases of an
// update (checking the feed, then downloading the installer). The bar is
// INDETERMINATE because Electron's built-in autoUpdater (Squirrel.Windows
// backend via update-electron-app) doesn't emit a `download-progress`
// event with byte counts — only `update-available` → silent download →
// `update-downloaded`. So we sweep a striped fill instead of tracking %.
//
// Visible when installerState is 'checking' or 'downloading'.
// Hidden in every other state (idle, up-to-date, downloaded, error, dev).
export default function UpdateProgressBar() {
  const { installerState, latestVersion } = useUpdates();
  const state = installerState?.state;

  const visible = state === 'checking' || state === 'downloading';
  if (!visible) return null;

  const label =
    state === 'checking'
      ? 'Checking for updates…'
      : `Downloading update${latestVersion ? ` v${latestVersion}` : ''}…`;

  return (
    <div className="update-progress" role="status" aria-live="polite">
      <div className="update-progress-track">
        <div className="update-progress-bar" />
      </div>
      <span className="update-progress-label">{label}</span>
    </div>
  );
}
