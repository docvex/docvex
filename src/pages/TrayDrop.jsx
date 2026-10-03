import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { localFolderApi } from '../lib/localFolder';
import { readProjectsDir } from '../lib/projectsDir';
import { onTrayDropFiles, pathForFile, trayDropCopyIn, windowClose } from '../lib/platform';
import DropZone from '../components/DropZone';
import './TrayDrop.css';

// The system tray's drop zone (main.js openTrayDropWindow): a small window by
// the tray — files and folders dropped here (or picked with Import, or dropped
// on the macOS menu-bar icon) are COPIED into the selected project's folder,
// each under a free name. The Files tab shows them through the index watcher.
export default function TrayDrop() {
  const { session } = useAuth();
  const { selectedProject } = useSelectedProject();
  const [dir, setDir] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  useEffect(() => {
    let alive = true;
    setDir(null);
    (async () => {
      if (!selectedProject?.id) return;
      try {
        const baseDir = readProjectsDir(session?.user?.id || '_anonymous') || undefined;
        const { path } = await localFolderApi.projectDir(selectedProject.id, selectedProject.name, baseDir);
        if (alive) setDir(path || null);
      } catch { /* shown as no folder */ }
    })();
    return () => { alive = false; };
  }, [selectedProject?.id, selectedProject?.name, session?.user?.id]);

  const copyIn = useCallback(async (paths) => {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    if (!dir) { setNote({ tone: 'danger', text: 'Open a project in DocVex first.' }); return; }
    setBusy(true);
    setNote(null);
    try {
      const { results, error } = await trayDropCopyIn(dir, list);
      if (error) { setNote({ tone: 'danger', text: error }); return; }
      const ok = results.filter((r) => r.ok);
      const failed = results.length - ok.length;
      setNote({
        tone: failed ? 'warning' : 'success',
        text: `${ok.length === 1 ? `“${ok[0].name}” added` : `${ok.length} items added`} to ${selectedProject?.name || 'the project'}${failed ? ` · ${failed} couldn’t be copied` : ''}.`,
      });
    } finally {
      setBusy(false);
    }
  }, [dir, selectedProject?.name]);

  // Files dropped on the macOS menu-bar icon arrive as paths.
  const pendingRef = React.useRef(null);
  useEffect(() => onTrayDropFiles((paths) => { pendingRef.current = paths; if (dir) copyIn(paths); }), [dir, copyIn]);
  useEffect(() => {
    if (dir && pendingRef.current) { const p = pendingRef.current; pendingRef.current = null; copyIn(p); }
  }, [dir, copyIn]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') windowClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onFiles = (files) => copyIn(Array.from(files || []).map((f) => pathForFile(f)));

  return (
    <div className="tdz">
      <header className="tdz-head">
        <span className="tdz-title">DocVex</span>
        <button type="button" className="tdz-close" onClick={windowClose} aria-label="Close">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <DropZone
        title={busy ? 'Copying…' : 'Drop files here'}
        sub={selectedProject?.name ? `Into ${selectedProject.name}` : 'No project selected'}
        disabled={busy || !dir}
        onFiles={onFiles}
      />
      {note && <p className={`tdz-note is-${note.tone}`} role="status">{note.text}</p>}
    </div>
  );
}
