import React, { useEffect, useRef, useState } from 'react';
import ConfirmModal from './ConfirmModal';
import { useUpdates } from '../context/UpdatesContext';

// App-wide "restart to finish updating" prompt. Watches the installer
// lifecycle and opens ONCE per session when the update reaches 'downloaded'
// (Squirrel has fully downloaded + staged the new build — it applies on the
// next launch). "Restart now" quits and installs immediately; "Later" leaves
// the Versions-page banner + persistent notification as the standing
// reminder. Mounted at the shell level so the prompt reaches the user
// wherever they are when the download completes, not only on /versions.
export default function UpdateRestartModal() {
  const { installerState, installUpdate, latestVersion } = useUpdates();
  const [open, setOpen] = useState(false);
  // Once-per-session latch — without it, any re-broadcast of the
  // 'downloaded' status (e.g. a later manual "Check now") would re-open the
  // modal the user already dismissed with "Later".
  const promptedRef = useRef(false);

  const downloaded = installerState?.state === 'downloaded';
  useEffect(() => {
    if (downloaded && !promptedRef.current) {
      promptedRef.current = true;
      setOpen(true);
    }
  }, [downloaded]);

  // Same version-string preference as the Versions-page banner: Squirrel's
  // releaseName when it reported one, else the latest GitHub release tag.
  const version = installerState?.releaseName || latestVersion;

  return (
    <ConfirmModal
      open={open}
      title="Update installed"
      message={
        `${version ? `Version ${version}` : 'The latest version'} has been downloaded and installed. ` +
        'Restart DocVex now to finish applying the update — until you restart, ' +
        'you keep running the current version.'
      }
      confirmLabel="Restart now"
      cancelLabel="Later"
      onConfirm={() => {
        setOpen(false);
        installUpdate();
      }}
      onCancel={() => setOpen(false)}
    />
  );
}
