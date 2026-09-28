import React, { useEffect, useState } from 'react';
import PageMasthead from '../../components/PageMasthead';
import { useAuth } from '../../context/AuthContext';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { localFolderApi } from '../../lib/localFolder';
import { readProjectsDir } from '../../lib/projectsDir';
import { openDocViewerWindow } from '../../lib/platform';
import './ProjectScoped.css';
import './ProjectNetwork.css';

// THE NEURAL NETWORK — the project's knowledge graph, a tab of its own (it was
// the Files tab's "Graph" view): the files the AI scan read and the typed
// links between them, or — the People & things lens — the people, companies,
// properties and vehicles they name. The graph itself is components/FileGraph
// (vis-network, loaded only here); this page finds the project's folder and
// hands it over. A file opens in the Doc Viewer.
const FileGraphView = React.lazy(() => import('../../components/FileGraph'));

export default function ProjectNetwork() {
  const { session } = useAuth();
  const { selectedProjectId: projectId, selectedProject } = useSelectedProject();
  const userKey = session?.user?.id || '_anonymous';
  const [dir, setDir] = useState(undefined); // undefined = looking, null = none

  useEffect(() => {
    setDir(undefined);
    if (!projectId) { setDir(null); return undefined; }
    let dead = false;
    (async () => {
      try {
        const { path } = await localFolderApi.projectDir(projectId, selectedProject?.name, readProjectsDir(userKey) || undefined);
        if (!dead) setDir(path || null);
      } catch { if (!dead) setDir(null); }
    })();
    return () => { dead = true; };
  }, [projectId, selectedProject?.name, userKey]);

  const openPath = (path, name) => openDocViewerWindow({ path, name: name || String(path).split(/[\\/]/).pop(), mime: '' });

  return (
    <div className="project-page-frame">
      <div className="pnn-page">
        <PageMasthead
          eyebrow={selectedProject?.name || 'Project'}
          title="Neural network"
          compact={false}
        >
          How this project’s files connect — what the AI scan read and the links it found between them,
          or the people, companies and properties they name.
        </PageMasthead>
        {dir === undefined ? (
          <p className="pnn-note">Opening the project’s folder…</p>
        ) : !dir ? (
          <div className="lss-card pnn-empty">
            <h3>No folder for this project</h3>
            <p>Connect the project’s folder in the Files tab, then run the AI scan — the network is built from what it reads.</p>
          </div>
        ) : (
          <React.Suspense fallback={<p className="pnn-note">Loading the network…</p>}>
            <FileGraphView dir={dir} projectId={projectId} onOpenPath={openPath} />
          </React.Suspense>
        )}
      </div>
    </div>
  );
}
