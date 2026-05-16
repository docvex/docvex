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
import {
  generateThumbnail,
  generateVideoFrames,
  extractVideoDuration,
} from '../lib/thumbnails';

// Upload-orchestration state.
//
// The visual (UploadModal) reads from `useUploads()` to render
// `modalOpen` → fully open: header, dropzone, staged + in-flight
// list, Send footer. Neither → renders null. The modal is opened
// by the FAB on the Files page, OR automatically when the user
// drags a file anywhere in the renderer window — the window-level
// dragenter listener flips `modalOpen` and the drop listener
// stages the files into the same review-before-send list.
//
// Cancellation: each upload owns an AbortController held in
// `controllersRef` (a Map keyed by upload id). `cancelAllUploads()` /
// `closeModal()` iterate and call .abort() — the in-flight XHRs hear
// the signal and resolve with AbortError. Files that already finished
// stay finished; the cancel doesn't roll them back.

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
let _stagedSeq = 0;
const nextStagedId = () => `staged-${Date.now()}-${++_stagedSeq}`;

export function UploadsProvider({ children }) {
  const { session } = useAuth();
  const userId = session?.user?.id || null;
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const { notify } = useNotifications();

  // ── Modal state ─────────────────────────────────────────────────────────
  // Lives in context (vs. local to ProjectFiles) so any caller that
  // ever needs to open the modal programmatically can. Today the only
  // trigger is the FAB on the Files page.
  // `closeModal` is defined later (further down in this provider)
  // because it also aborts in-flight uploads + clears the staged /
  // uploads arrays, and needs access to refs declared below.
  const [modalOpen, setModalOpen] = useState(false);
  const openModal  = useCallback(() => setModalOpen(true), []);

  // Drag-active is a SEPARATE flag from modalOpen. While the user is
  // mid-drag (file held over the renderer, not yet released), the
  // modal renders in a stripped-down "drag-only" mode showing just
  // the dashed dropzone — no header, no list, no footer. On drop we
  // flip modalOpen=true and dragActive=false, which reveals the full
  // chrome around the SAME dropzone DOM node (kept mounted via CSS
  // display:none on the chrome, not unmounting). modalOpenRef mirrors
  // the state so the window-level listeners (attached once) can decide
  // whether a fresh dragenter should trigger drag-only mode or leave
  // the already-open modal alone.
  const [dragActive, setDragActive] = useState(false);
  const modalOpenRef = useRef(false);
  useEffect(() => { modalOpenRef.current = modalOpen; }, [modalOpen]);

  // ── Pre-send prep ───────────────────────────────────────────────────────
  // Thumbnail / video-frame / duration generation used to run inside
  // runUpload — that meant clicking Send waited on local CPU work
  // (PDF rastering, video decoding) before the network PUT could even
  // start. Now the same work fires the moment a file is staged, runs
  // in the background, and the resolved Blobs/numbers get stashed on
  // the staged entry. By the time the user clicks Send the assets are
  // usually ready, so the upload starts immediately. If the user
  // beats prep, sendStaged awaits the outstanding prep promises and
  // the Send button shows a spinner via the `sending` flag.
  const [sending, setSending] = useState(false);
  // id → Promise resolving to { thumbnail, thumbnailFrames, durationSeconds }.
  // Kept in a ref (not state) because callers `.then()`/`await` against
  // it imperatively — no rendering depends on the Map itself.
  const prepPromisesRef = useRef(new Map());

  // ── Staging area ────────────────────────────────────────────────────────
  // Files the user has picked / dropped but not yet sent. Both the
  // FAB-modal pick flow AND the global drag-drop flow funnel into this
  // single array. The actual network upload only kicks off when the
  // user clicks Send (or sendStaged() is invoked programmatically).
  // Each entry is { id, file } so trash buttons can target by id
  // instead of index (which goes wrong the moment a row is removed
  // between two trash clicks).
  const [staged, setStaged] = useState([]);

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

  // Project switch invalidates anything in the staging area — the
  // staged files were picked with one project in mind and shouldn't
  // silently get sent to a different project the user just selected.
  useEffect(() => {
    setStaged([]);
    prepPromisesRef.current.clear();
  }, [selectedProjectId]);

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
      displayName: entry.name,
      description: entry.description,
      uploadedBy: entry.uploadedBy,
      signal: controller.signal,
      onProgress: (loaded, total) => patchUpload(entry.id, { loaded, total }),
      // Pre-computed at staging time. uploadProjectFile skips
      // generation when prepped is non-null, so Send-to-PUT is
      // basically instant on warm prep.
      prepped: entry.prepped,
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
          category: 'file',
          variant: 'error',
          icon: 'upload',
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
  // Side effects (calling runUpload, mutating startedRef / inFlightRef)
  // live INSIDE the setUploads updater. They have to: setState only
  // QUEUES the updater — running it is deferred to React's next render.
  // Moving the dispatch outside (`let toStart; setUploads(...); for...`)
  // means the for loop runs BEFORE the updater has been invoked, so
  // toStart is still empty and nothing ever fires. Entries sit on
  // 'pending' (rendered as "QUEUED") forever.
  //
  // The trick is making the side effects idempotent so StrictMode dev's
  // double-invocation of the updater doesn't double-fire uploads:
  //
  //   • `startedRef.has(id)` — each entry's runUpload fires at most
  //     once per id. First invocation adds the id; second invocation
  //     sees it in the Set and skips.
  //   • `inFlightRef.current` (not prev.filter) — live in-flight count
  //     INCLUDING entries we just kicked off inside this loop. The
  //     first invocation's runUploads bump the ref synchronously; the
  //     second invocation reads the bumped count and either breaks
  //     early or doesn't loop at all.
  //
  // Result: StrictMode runs the updater twice, but runUpload is called
  // exactly once per entry, and we never exceed MAX_CONCURRENT.
  const startedRef = useRef(new Set());
  const drainQueue = useCallback(() => {
    setUploads((prev) => {
      const slots = MAX_CONCURRENT - inFlightRef.current;
      if (slots <= 0) return prev;
      let started = 0;
      for (const u of prev) {
        if (started >= slots) break;
        if (u.status !== 'pending') continue;
        if (startedRef.current.has(u.id)) continue;
        startedRef.current.add(u.id);
        runUpload(u).then(() => {
          startedRef.current.delete(u.id);
          drainQueue();
        });
        started += 1;
      }
      return prev;
    });
  }, [runUpload]);

  // ── Staging actions ─────────────────────────────────────────────────────
  // Pre-send prep for a single staged file. Runs thumbnail/frame/
  // duration extraction (whichever apply for the MIME) and patches
  // the staged entry with the resolved values + prepReady: true.
  // Errors are NON-fatal: a prep failure just leaves the assets null
  // and the upload pipeline falls back to its in-flight generation.
  // Returns the prep results so sendStaged can `await` directly off
  // the stored promise.
  const prepStagedFile = useCallback(async (id, file) => {
    const isVideo = (file.type || '').startsWith('video/');
    try {
      const [thumbnail, thumbnailFrames, durationSeconds] = await Promise.all([
        isVideo ? Promise.resolve(null) : generateThumbnail(file),
        isVideo ? generateVideoFrames(file) : Promise.resolve(null),
        isVideo ? extractVideoDuration(file) : Promise.resolve(null),
      ]);
      setStaged((prev) => prev.map((s) => (
        s.id === id
          ? { ...s, thumbnail, thumbnailFrames, durationSeconds, prepReady: true }
          : s
      )));
      return { thumbnail, thumbnailFrames, durationSeconds };
    } catch {
      // Mark as ready (so the spinner clears) but with null assets —
      // the upload pipeline's fallback path will regenerate inline.
      setStaged((prev) => prev.map((s) => (
        s.id === id
          ? { ...s, prepReady: true }
          : s
      )));
      return { thumbnail: null, thumbnailFrames: null, durationSeconds: null };
    }
  }, []);

  // MIME-rejects pre-flight (rejected files toast + skip — they never
  // reach the staging area). Acceptable files appear as 'staged' rows
  // in the modal and stay there until the user clicks Send.
  const stageFiles = useCallback((files) => {
    const fileArray = Array.from(files || []);
    if (fileArray.length === 0) return;

    const accepted = [];
    let rejectedCount = 0;
    for (const f of fileArray) {
      if (isAcceptedMime(f.type)) accepted.push(f);
      else rejectedCount += 1;
    }
    if (rejectedCount > 0) {
      notify({
        category: 'file',
        variant: 'error',
        icon: 'file-x',
        title: 'Unsupported file type',
        body: `${rejectedCount} file${rejectedCount === 1 ? '' : 's'} skipped. Allowed: PDF, image, video, text.`,
        dedupeKey: 'upload-staging-mime-rejected',
      });
    }
    if (accepted.length === 0) return;
    const newEntries = accepted.map((file) => ({
      id: nextStagedId(),
      file,
      // Editable display name — defaults to the file's original
      // filename WITHOUT its extension so users don't have to
      // manually delete ".pdf" / ".mp4" / etc. before typing a
      // nicer title. The extension is still preserved on the
      // storage_path (which always uses file.name) and surfaces
      // on the Files-grid card as a corner tag — splitting it off
      // here just cleans up the editable display name. Split on
      // the LAST dot only, ignore leading dots (".env" stays
      // intact), trailing dots, and "extensions" > 8 chars (likely
      // part of the actual name, not a real extension).
      name: (() => {
        const n = file.name;
        const i = n.lastIndexOf('.');
        if (i <= 0 || i === n.length - 1) return n;
        if (n.length - i - 1 > 8) return n;
        return n.slice(0, i);
      })(),
      // Optional description — empty until the user types into
      // the row's description textarea. Written to the row's
      // `description` column at insert time; null when blank.
      description: '',
      // Pre-send prep slots — filled by prepStagedFile() below. The
      // upload pipeline reads them at Send time; if they're still
      // null (prep hasn't finished and Send isn't awaiting), the
      // pipeline regenerates inline. prepReady drives the row's
      // "Preparing…" → "Ready to send" status flip and the Send
      // button's spinner.
      thumbnail: null,
      thumbnailFrames: null,
      durationSeconds: null,
      prepReady: false,
    }));
    setStaged((prev) => [...prev, ...newEntries]);
    // Kick off prep for each new entry. Store the promise so
    // sendStaged can await any still-in-flight prep when the user
    // hits Send before it completes.
    for (const entry of newEntries) {
      prepPromisesRef.current.set(entry.id, prepStagedFile(entry.id, entry.file));
    }
  }, [notify, prepStagedFile]);

  const removeStaged = useCallback((id) => {
    setStaged((prev) => prev.filter((s) => s.id !== id));
    // Abandon the in-flight prep promise. We can't actually cancel
    // PDF/video generation (the underlying APIs don't expose it), but
    // dropping the map entry means sendStaged won't await it later.
    prepPromisesRef.current.delete(id);
  }, []);

  const clearStaged = useCallback(() => {
    setStaged([]);
    prepPromisesRef.current.clear();
  }, []);

  // Per-row editors for the staged inputs. The modal calls these from
  // onChange handlers as the user types — cheap because `staged` is
  // rarely > 20 entries.
  const updateStagedName = useCallback((id, name) => {
    setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  }, []);

  const updateStagedDescription = useCallback((id, description) => {
    setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, description } : s)));
  }, []);

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
        category: 'file',
        variant: 'error',
        icon: 'file-x',
        title: 'Unsupported file type',
        body: `${rejectedCount} file${rejectedCount === 1 ? '' : 's'} skipped. Allowed: PDF, image, video, text.`,
        dedupeKey: 'upload-mime-rejected',
      });
    }

    // Kick off whatever fits in the concurrency budget.
    drainQueue();
  }, [drainQueue, notify, scheduleDismiss]);

  // Commit the staging area to the upload pipeline. KEEPS each
  // staged row's id and reuses it as the upload entry id, so when
  // the row transitions from "Ready to send" → "Queued" → "Uploading"
  // the React key in UploadModal's list matches across both arrays
  // and the same <li> DOM node is updated in place — no remount, no
  // entrance-animation replay, no visual flicker as the modal would
  // otherwise briefly contract (old <li> unmounts) and expand (new
  // <li> mounts and animates). Skips beginUpload's MIME re-check and
  // rejection branch because staged files were already filtered
  // through `isAcceptedMime` at staging time.
  const sendStaged = useCallback(async () => {
    if (sending) return;
    if (staged.length === 0) return;
    const projectId = selectedProjectIdRef.current;
    const projectName = selectedProjectNameRef.current;
    const uploadedBy = userIdRef.current;
    if (!projectId || !uploadedBy) {
      setStaged([]);
      prepPromisesRef.current.clear();
      return;
    }
    // Snapshot the staging list at click time so files added during
    // the prep-await aren't silently sent or dropped — they stay
    // staged for a subsequent Send.
    const snapshot = staged;
    const snapshotIds = new Set(snapshot.map((s) => s.id));

    setSending(true);
    // Await every in-flight prep. Already-resolved promises return
    // immediately; the spinner on Send only stays up if the user
    // beat prep. Falls back to nulls if a prep promise rejected or
    // was never registered (defensive; shouldn't happen).
    const prepResults = await Promise.all(
      snapshot.map(async (s) => {
        const p = prepPromisesRef.current.get(s.id);
        if (!p) return null;
        try { return await p; }
        catch { return null; }
      }),
    );

    const entries = snapshot.map(({ id, file, name, description }, i) => ({
      id,
      file,
      // Carry the staged name + description into the upload entry
      // so runUpload can hand them to uploadProjectFile, and so the
      // synthetic row in the modal keeps showing the user-chosen
      // name during in-flight/done states instead of reverting to
      // file.name.
      name,
      description,
      projectId,
      projectName,
      uploadedBy,
      status: 'pending',
      loaded: 0,
      total: file.size,
      error: null,
      // Pre-computed thumbnail / video frames / duration — passed
      // through to uploadProjectFile so it can skip generation and
      // start the network PUT immediately. Null per-field is OK
      // (the pipeline treats null as "no thumb" / "no duration"
      // rather than re-generating).
      prepped: prepResults[i] || {
        thumbnail: null, thumbnailFrames: null, durationSeconds: null,
      },
    }));

    // Drop the snapshot from staged + the prep map. Anything added
    // mid-await stays on staged untouched.
    setStaged((prev) => prev.filter((s) => !snapshotIds.has(s.id)));
    for (const id of snapshotIds) prepPromisesRef.current.delete(id);

    setUploads((prev) => [...prev, ...entries]);
    setSending(false);
    drainQueue();

    // Close the modal once the uploads are queued — the user asked
    // for Send to dismiss the dialog. The in-flight uploads keep
    // running in the background (their AbortControllers + entries
    // are still in the uploads array); the modal can be reopened
    // via the FAB to inspect status, and completed uploads
    // auto-dismiss via the existing TERMINAL_DISMISS_MS timer. We
    // intentionally do NOT call closeModal() here — that would
    // abort the in-flight uploads + wipe the uploads array, which
    // is the user-initiated cancel path, not the post-send path.
    setModalOpen(false);
  }, [staged, sending, drainQueue]);

  // Per-row trash action used by the upload modal's list. Aborts the
  // upload if it's in flight (the XHR resolves with AbortError, runUpload
  // patches to 'canceled', scheduleDismiss fires), and unconditionally
  // removes the entry from `uploads` so the row disappears immediately
  // rather than waiting for the auto-dismiss timer. For 'done' rows the
  // file stays in storage — this only clears the entry from the in-memory
  // upload log; actual file deletion happens from FileDetailModal.
  const dismissUpload = useCallback((id) => {
    const controller = controllersRef.current.get(id);
    if (controller) {
      try { controller.abort(); } catch { /* swallow */ }
      controllersRef.current.delete(id);
    }
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

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

  // Close the modal AND wipe everything that was visible inside it.
  // Closing is treated as "dismiss what I was reviewing" — staged
  // files (never uploaded) are dropped, in-flight uploads are
  // aborted (uploadProjectFile's orphan-cleanup branch handles any
  // partial bytes in storage), and the row list is cleared. Files
  // that already finished uploading stay in storage — those are
  // durable from the moment the upload succeeded; only their list
  // row is removed.
  const closeModal = useCallback(() => {
    setModalOpen(false);
    setDragActive(false);
    setSending(false);
    for (const controller of controllersRef.current.values()) {
      try { controller.abort(); } catch { /* swallow */ }
    }
    controllersRef.current.clear();
    startedRef.current.clear();
    inFlightRef.current = 0;
    setStaged([]);
    setUploads([]);
    prepPromisesRef.current.clear();
  }, []);

  // Window-level drag-and-drop. Two distinct visual states:
  //   • dragenter (mid-drag, modal was closed): flip dragActive=true,
  //     which renders the modal in drag-only mode (dropzone only).
  //   • drop: flip dragActive=false + modalOpen=true and stage the
  //     files, which reveals the full chrome around the now-staged
  //     rows. The dropzone DOM node stays mounted across this
  //     transition (chrome is hidden via CSS, not unmounted) so the
  //     dropzone doesn't visually pop/relayout when the chrome
  //     appears.
  //
  // dragenter/dragleave bubble up from every nested element the
  // cursor crosses (e.g. moving from page background onto a card
  // fires leave-on-bg + enter-on-card in the same gesture). A simple
  // boolean would flicker; instead we count depth — incrementing on
  // every dragenter, decrementing on every dragleave — and only
  // consider the drag truly gone when the counter returns to zero.
  // drop resets to zero unconditionally because no further dragleave
  // fires after a successful drop.
  //
  // Modal-already-open case: a second drag while modalOpen=true does
  // NOT set dragActive — the full chrome stays put and the drop just
  // appends to the staging list. dragActive only governs the "modal
  // was closed, drag opened it as a teaser" state.
  //
  // preventDefault on dragover is REQUIRED for drop to fire — without
  // it the renderer treats the page as a non-drop-target and the OS
  // default ("open this file in a new tab") takes over, navigating
  // the SPA away. preventDefault on drop suppresses that same
  // fallback for the terminal event.
  useEffect(() => {
    let dragDepth = 0;

    const carriesFiles = (e) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      for (let i = 0; i < types.length; i++) {
        if (types[i] === 'Files') return true;
      }
      return false;
    };

    const onDragEnter = (e) => {
      if (!carriesFiles(e)) return;
      if (!selectedProjectIdRef.current) return;
      e.preventDefault();
      dragDepth += 1;
      if (!modalOpenRef.current) setDragActive(true);
    };

    const onDragOver = (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = (e) => {
      if (!carriesFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragActive(false);
    };

    const onDrop = (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      setDragActive(false);
      if (!selectedProjectIdRef.current) return;
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length === 0) return;
      setModalOpen(true);
      stageFiles(files);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [stageFiles]);

  const value = useMemo(() => ({
    uploads,
    uploadingCount,
    overallProgress,
    beginUpload,
    cancelAllUploads,
    dismissUpload,
    // Staging + modal — surfaces consume these to render the
    // review-before-send list and the FAB → modal trigger respectively.
    staged,
    stageFiles,
    removeStaged,
    clearStaged,
    sendStaged,
    updateStagedName,
    updateStagedDescription,
    modalOpen,
    openModal,
    closeModal,
    dragActive,
    sending,
  }), [
    uploads, uploadingCount, overallProgress, beginUpload,
    cancelAllUploads, dismissUpload,
    staged, stageFiles, removeStaged, clearStaged, sendStaged,
    updateStagedName, updateStagedDescription,
    modalOpen, openModal, closeModal, dragActive, sending,
  ]);

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
