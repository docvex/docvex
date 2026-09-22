// Keeps an OLDER app out of a project a newer one has synced.
//
// Account sync stamps a project with the app version that last synced it
// (lib/projectSync → `appVersion`). Wraps every project-scoped route: when this
// app is older than that stamp, the project doesn't open — an old version may
// not understand what the new one saved, and its next write would overwrite
// it. Instead the user is sent to update. Projects that aren't synced, or were
// synced before versions were recorded, open as always; so does a NEWER app
// (its next sync raises the stamp).
//
// The decision is taken from the stamp this device remembers, at once, and
// confirmed against the account in the background (and again when the window
// regains focus, since another device may have synced in the meantime). With no
// stamp remembered yet it waits for the account — up to a few seconds, after
// which an unreachable account lets the project open: being offline must not
// lock anyone out of their own files.
import React, { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useUpdates } from '../context/UpdatesContext';
import { projectVersionCheck, rememberedProjectVersion, versionBlocks } from '../lib/projectSync';
import { compareVersions } from '../lib/appVersion';
import './ProjectVersionGate.css';

const WAIT_MS = 4000;
const RECHECK_MS = 60 * 1000;
const PROJECT_PATH_RE = /^\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export default function ProjectVersionGate() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const { currentVersion, latestVersion, hasUpdate } = useUpdates();
  const projectId = PROJECT_PATH_RE.exec(pathname)?.[1] || selectedProjectId || null;

  // { projectId, required, settled } — `settled` once there is an answer to act on.
  const [gate, setGate] = useState(() => {
    const r = rememberedProjectVersion(projectId);
    return { projectId, required: r.required, settled: r.checked };
  });

  useEffect(() => {
    if (!projectId) return undefined;
    let alive = true;
    const r = rememberedProjectVersion(projectId);
    setGate({ projectId, required: r.required, settled: r.checked });
    let lastCheck = 0;
    const check = async () => {
      lastCheck = Date.now();
      const res = await projectVersionCheck(projectId);
      if (alive) setGate({ projectId, required: res.required, settled: true });
    };
    check();
    const giveUp = window.setTimeout(() => {
      if (alive) setGate((g) => (g.projectId === projectId && !g.settled ? { ...g, settled: true } : g));
    }, WAIT_MS);
    const onFocus = () => { if (Date.now() - lastCheck > RECHECK_MS) check(); };
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.clearTimeout(giveUp);
      window.removeEventListener('focus', onFocus);
    };
  }, [projectId]);

  if (!projectId) return <Outlet />;
  const current = gate.projectId === projectId ? gate : { ...rememberedProjectVersion(projectId), settled: false };
  if (!current.settled) {
    return (
      <div className="pvg-wait"><div className="spinner" /></div>
    );
  }
  if (!versionBlocks(current.required, currentVersion)) return <Outlet />;

  const name = selectedProject?.id === projectId ? selectedProject?.name : null;
  const updateReaches = hasUpdate && latestVersion && compareVersions(latestVersion, current.required) >= 0;
  return (
    <div className="pvg">
      <div className="pvg-card" role="alert">
        <div className="pvg-eyebrow">Update needed</div>
        <h1 className="pvg-title">Update Docvex to open {name ? `“${name}”` : 'this project'}</h1>
        <p className="pvg-body">
          This project was last synced with <strong>Docvex {current.required}</strong>. This computer
          has <strong>{currentVersion}</strong>. An older version may not understand what the newer one
          saved, and could overwrite it — so the project stays closed here until the app is updated.
        </p>
        <div className="pvg-versions">
          <span><em>Needed</em>{current.required} or later</span>
          <span><em>This computer</em>{currentVersion}</span>
        </div>
        <div className="pvg-actions">
          <button type="button" className="pvg-btn is-primary" onClick={() => navigate('/versions')}>
            {updateReaches ? `Update to ${latestVersion}` : 'Check for updates'}
          </button>
          <button type="button" className="pvg-btn" onClick={() => navigate('/projects')}>
            Back to projects
          </button>
        </div>
      </div>
    </div>
  );
}
