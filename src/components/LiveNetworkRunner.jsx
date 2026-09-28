// Runs the live neural network (lib/liveNetwork) for the selected project, in
// the main window, whatever tab is on show. No UI of its own: its controls are
// in the Files tab's AI scan card (components/ScanGauges).
import { useEffect } from 'react';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useNotifications } from '../context/NotificationsContext';
import { projectIndexApi } from '../lib/localFolder';
import { startLiveNetwork } from '../lib/liveNetwork';

export default function LiveNetworkRunner() {
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const { notify } = useNotifications();
  const name = selectedProject?.name;
  useEffect(() => {
    if (!selectedProjectId || !projectIndexApi?.locate) return undefined;
    let stop = null;
    let dead = false;
    (async () => {
      try {
        const loc = await projectIndexApi.locate(selectedProjectId);
        if (dead || !loc?.dir) return;
        stop = startLiveNetwork({ projectId: selectedProjectId, dir: loc.dir, projectName: name, notify });
      } catch { /* no index here — nothing to watch */ }
    })();
    return () => { dead = true; stop?.(); };
  }, [selectedProjectId, name, notify]);
  return null;
}
