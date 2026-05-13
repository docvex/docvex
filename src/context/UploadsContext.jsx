import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';
import { useSelectedProject } from './SelectedProjectContext';
import { useNotifications } from './NotificationsContext';
import { uploadProjectFile, isAcceptedMime } from '../lib/uploadProjectFile';

// Global drag-detection + upload-orchestration state.
//
// One context, two responsibilities — they live together because the
// drag listener is what triggers `beginUpload`, so splitting would just
// force a second context to consume the first. The visual (UploadOverlay)
// reads from `useUploads()` to render its three branches:
//
//   dragActive && !selectedProjectId  → "select a project first" card
//   dragActive && selectedProjectId   → "drop files here to upload to X" card
//   !dragActive && uploadingCount > 0 → bottom-right progress panel
//   !dragActive && uploadingCount = 0 → renders null
//
// Window-level dragenter/dragleave/dragover/drop listeners are attached
// once per provider mount (the cleanup removes them on unmount). The
// overlay itself has NO drag handlers — `pointer-events: none` on its
// elements means drops always reach the window listener, regardless of
// where on the screen the user releases the mouse.
//
// Cancellation: each upload owns an AbortController held in
// `controllersRef` (a Map keyed by upload id). `cancelAllUploads()`
// iterates and calls .abort() — the in-flight XHRs hear the signal and
// resolve with AbortError. Files that already finished stay finished;
// the cancel doesn't roll them back.

const UploadsContext = createContext(null);

// Max number of XHRs in flight at any given time. Surplus uploads queue
// (status: 'pending') and start as earlier ones finish. Cancel drains the
// queue too. Three is enough to saturate most home connections without
// stomping each other's TCP windows; bump if/when the user base routinely
// uploads large batches over fast pipes.
const MAX_CONCURRENT = 3;

// How long a rejected/failed/canceled row sits in the progress panel
// before auto-dismissing itself. Long enough for the user to read the
// error message; short enough not to clutter the panel.
const TERMINAL_DISMISS_MS = 5000;

// Stable id generator for upload entries. Distinct from the file_id
// (which is the storage path UUID) — this is just a list-key for React
// + a Map key for AbortControllers. Doesn't need to be cryptographically
// random.
let _seq = 0;
const nextId = () => `upload-${Date.now()}-${++_seq}`;

export function UploadsProvider({ children }) {
  const { session } = useAuth();
  const userId = session?.user?.id || null;
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const { notify } = useNotifications();

  // ── Drag-detection state ────────────────────────────────────────────────
  // dragenter/dragleave fire on every nested element boundary the cursor
  // crosses, not just on the window edge. The counter pattern absorbs the
  // spurious child-boundary events — we only flip dragActive when the
  // counter transitions through 0 (true window exit/entry).
  const dragCounterRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  // ── Upload-orchestration state ──────────────────────────────────────────
  // uploads: ordered array, newest-last so the panel shows them in roll
  // order. Each entry:
  //   { id, file, projectId, projectName, status, loaded, total, error }
  //   status ∈ 'pending' | 'uploading' | 'done' | 'rejected' | 'error' | 'canceled'
  const [uploads, setUploads] = useState([]);
  // Live count of uploads currently in flight (status === 'uploading').
  // Derived from uploads via useMemo below; also tracked in a ref so the
  // scheduling code (which runs inside setState callbacks) can read it
  // without recomputing from the array.
  const inFlightRef = useRef(0);
  const controllersRef = useRef(new Map()); // id → AbortController

  // Mirror selectedProjectId / projectName + userId into refs so the
  // window-level listeners (attached once) can read the latest values
  // without re-attaching every time the selection changes.
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedProjectNameRef = useRef(selectedProject?.name || null);
  const userIdRef = useRef(userId);
  useEffect(() => { selectedProjectIdRef.current = selectedProjectId; }, [selectedProjectId]);
  useEffect(() => { selectedProjectNameRef.current = selectedProject?.name || null; }, [selectedProject]);
  useEffect(() => { userIdRef.current = userId; }, [userId]);

  // ── Derived state ───────────────────────────────────────────────────────
  const uploadingCount = useMemo(
    () => uploads.filter((u) => u.status === 'uploading' || u.status === 'pending').length,
    [uploads],
  );

  // Overall progress across all uploads that have a meaningful byte count
  // (uploading/done). Rejected/canceled entries are excluded — they didn't
  // contribute bytes. Returns 0..1; 0 when nothing tracked yet.
  const overallProgress = useMemo(() => {
    let loaded = 0;
    let total = 0;
    for (const u of uploads) {
      if (u.status === 'uploading' || u.status === 'done') {
        loaded += u.loaded || 0;
        total += u.total || 0;
      }
    }
    return total > 0 ? loaded / total : 0;
  }, [uploads]);

  // ── Mutation helpers ────────────────────────────────────────────────────
  // Patch one upload row by id. Cheap because uploads is rarely > 20.
  const patchUpload = useCallback((id, patch) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }, []);

  // Auto-dismiss a terminal row after TERMINAL_DISMISS_MS. Idempotent —
  // calling twice on the same id just runs two timers, the second of
  // which finds the row already gone and no-ops.
  const scheduleDismiss = useCallback((id) => {
    setTimeout(() => {
      setUploads((prev) => prev.filter((u) => u.id !== id));
    }, TERMINAL_DISMISS_MS);
  }, []);

  // ── Upload execution ────────────────────────────────────────────────────
  // Starts one upload. Wraps the lib/uploadProjectFile call with progress
  // patches + status transitions + the AbortController plumbing. Returns
  // a Promise that resolves when the upload finishes for any reason.
  const runUpload = useCallback(async (entry) => {
    const controller = new AbortController();
    controllersRef.current.set(entry.id, controller);
    inFlightRef.current += 1;
    patchUpload(entry.id, { status: 'uploading' });

    const { data, error } = await uploadProjectFile({
      projectId: entry.projectId,
      file: entry.file,
      uploadedBy: entry.uploadedBy,
      signal: controller.signal,
      onProgress: (loaded, total) => patchUpload(entry.id, { loaded, total }),
    });

    controllersRef.current.delete(entry.id);
    inFlightRef.current = Math.max(0, inFlightRef.current - 1);

    if (error) {
      const isAbort = error.name === 'AbortError';
      patchUpload(entry.id, {
        status: isAbort ? 'canceled' : 'error',
        error: isAbort ? null : (error.message || 'Upload failed'),
      });
      if (!isAbort) {
        // Surface non-abort failures as a toast too — the user might
        // have navigated away from the progress panel by the time the
        // failure lands.
        notify({
          category: 'system',
          variant: 'error',
          title: 'Upload failed',
          body: `${entry.file.name}: ${error.message || 'Unknown error'}`,
          dedupeKey: `upload-error:${entry.id}`,
        });
      }
      scheduleDismiss(entry.id);
    } else {
      patchUpload(entry.id, {
        status: 'done',
        loaded: entry.file.size,
        total: entry.file.size,
        rowId: data?.fileId || null,
      });
      scheduleDismiss(entry.id);
    }
  }, [patchUpload, scheduleDismiss, notify]);

  // Pull pending entries off the head of the list and run them up to
  // the concurrency cap. Re-invoked whenever an upload finishes so the
  // next pending one fills the freed slot.
  //
  // CRITICAL: do NOT call runUpload from inside the setUploads updater.
  // React StrictMode (dev) intentionally invokes state-updater callbacks
  // TWICE to surface impurity — calling runUpload inside the callback
  // would fly two XHRs per pending entry and create two project_files
  // rows per dropped file (manifesting as duplicate cards in /files).
  // Instead, compute the list of entries to start inside the updater,
  // assign it to a closure variable, and dispatch runUpload AFTER the
  // updater returns. The closure-variable assignment is idempotent
  // (same `prev` → same `toStart` on both invocations), so the for
  // loop runs once with the correct value.
  //
  // We also guard each pending entry against being scheduled twice by
  // tracking already-dispatched ids in `startedRef`. Belt-and-suspenders:
  // even if drainQueue gets called twice in overlapping render cycles
  // before the 'uploading' status patch has been observed by the next
  // updater, we won't re-start an entry that's already in flight.
  const startedRef = useRef(new Set());
  const drainQueue = useCallback(() => {
    let toStart = [];
    setUploads((prev) => {
      const inFlight = prev.filter((u) => u.status === 'uploading').length;
      const slots = MAX_CONCURRENT - inFlight;
      if (slots <= 0) { toStart = []; return prev; }
      const candidates = [];
      for (const u of prev) {
        if (candidates.length >= slots) break;
        if (u.status === 'pending' && !startedRef.current.has(u.id)) {
          candidates.push(u);
        }
      }
      toStart = candidates;
      return prev;
    });
    for (const entry of toStart) {
      startedRef.current.add(entry.id);
      runUpload(entry).then(() => {
        startedRef.current.delete(entry.id);
        drainQueue();
      });
    }
  }, [runUpload]);

  // ── Public actions ──────────────────────────────────────────────────────

  // Append N files as new upload entries. MIME-rejects pre-flight so
  // unsupported types never reach the network. Captures projectId/name
  // at call time so a project switch mid-upload doesn't redirect the
  // in-flight bytes to the wrong place.
  const beginUpload = useCallback((files) => {
    const projectId = selectedProjectIdRef.current;
    const projectName = selectedProjectNameRef.current;
    const uploadedBy = userIdRef.current;
    if (!projectId) {
      // Shouldn't happen — the window-drop listener gates on this too —
      // but defence in depth: silently no-op rather than enqueue
      // uploads with a null projectId that would fail RLS later.
      return;
    }
    if (!uploadedBy) return;

    const fileArray = Array.from(files || []);
    if (fileArray.length === 0) return;

    let rejectedCount = 0;
    const entries = fileArray.map((file) => {
      const accepted = isAcceptedMime(file.type);
      if (!accepted) rejectedCount += 1;
      return {
        id: nextId(),
        file,
        projectId,
        projectName,
        uploadedBy,
        status: accepted ? 'pending' : 'rejected',
        loaded: 0,
        total: file.size,
        error: accepted ? null : 'Unsupported file type',
      };
    });

    setUploads((prev) => [...prev, ...entries]);

    // Schedule a dismiss timer for each rejected entry so they don't
    // pile up in the panel.
    for (const entry of entries) {
      if (entry.status === 'rejected') scheduleDismiss(entry.id);
    }

    if (rejectedCount > 0) {
      notify({
        category: 'system',
        variant: 'error',
        title: 'Unsupported file type',
        body: `${rejectedCount} file${rejectedCount === 1 ? '' : 's'} skipped. Allowed: PDF, image, video, text.`,
        dedupeKey: 'upload-mime-rejected',
      });
    }

    // Kick off whatever fits in the concurrency budget.
    drainQueue();
  }, [drainQueue, notify, scheduleDismiss]);

  // Abort every in-flight upload + drop the queued pending ones. Already-
  // finished entries are left alone (their files are in storage and have
  // metadata rows — undoing them would require a separate "uploaded by
  // me, just-now" cleanup which we're not building in v1).
  const cancelAllUploads = useCallback(() => {
    // Abort each AbortController. Each XHR's onabort fires, runUpload
    // patches status to 'canceled', and scheduleDismiss queues removal.
    for (const controller of controllersRef.current.values()) {
      try { controller.abort(); } catch { /* swallow */ }
    }
    // Mark pending (not-yet-started) entries as canceled too. They never
    // had an AbortController, so they need an explicit status patch.
    setUploads((prev) => prev.map((u) => (
      u.status === 'pending' ? { ...u, status: 'canceled' } : u
    )));
    // Schedule dismiss for pending-→canceled rows. In-flight cancels are
    // already scheduled by runUpload's error branch.
    setTimeout(() => {
      setUploads((prev) => prev.filter((u) => u.status !== 'canceled'));
    }, TERMINAL_DISMISS_MS);
  }, []);

  // ── Window-level drag listeners ─────────────────────────────────────────
  // Attached once per provider mount. The overlay component has no drag
  // handlers of its own; everything is captured at the window level so
  // drops anywhere over the app land in beginUpload.
  useEffect(() => {
    const isFileDrag = (dt) => {
      if (!dt) return false;
      const types = dt.types;
      // DOMStringList exposes both .length and array indexing; .includes
      // is unsupported on Chromium's legacy DOMStringList, so iterate.
      for (let i = 0; i < types.length; i++) {
        if (types[i] === 'Files') return true;
      }
      return false;
    };

    const onDragEnter = (e) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) setDragActive(true);
    };

    const onDragLeave = (e) => {
      if (!isFileDrag(e.dataTransfer)) return;
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setDragActive(false);
    };

    const onDragOver = (e) => {
      if (!isFileDrag(e.dataTransfer)) return;
      // REQUIRED: without preventDefault on dragover, Electron Chromium
      // treats the drop as a default-action navigation to file://… —
      // the renderer would replace itself with the dropped file. This
      // is the single most important line in the file.
      e.preventDefault();
      // Reflect the gate in the OS cursor: with a project selected the
      // cursor gains a "+" copy badge; without one it gets the "no"
      // badge so the user sees the gate before they even release.
      e.dataTransfer.dropEffect = selectedProjectIdRef.current ? 'copy' : 'none';
    };

    const onDrop = (e) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      dragCounterRef.current = 0;
      setDragActive(false);
      // Gate: no project selected → no-op. The overlay's "select a project
      // first" copy already explained the gate to the user.
      if (!selectedProjectIdRef.current) return;
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length === 0) return;
      beginUpload(files);
    };

    // Belt-and-suspenders: if the user Alt-Tabs away mid-drag, some
    // platforms swallow the final dragleave. Resetting on window blur
    // ensures the overlay doesn't stay stuck open.
    const onBlur = () => {
      dragCounterRef.current = 0;
      setDragActive(false);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('blur', onBlur);
    };
  }, [beginUpload]);

  const value = useMemo(() => ({
    dragActive,
    uploads,
    uploadingCount,
    overallProgress,
    beginUpload,
    cancelAllUploads,
  }), [dragActive, uploads, uploadingCount, overallProgress, beginUpload, cancelAllUploads]);

  return (
    <UploadsContext.Provider value={value}>
      {children}
    </UploadsContext.Provider>
  );
}

export function useUploads() {
  const ctx = useContext(UploadsContext);
  if (!ctx) throw new Error('useUploads must be used inside <UploadsProvider>');
  return ctx;
}
