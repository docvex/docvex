// Upload pipeline for project files. Kept separate from projectFiles.js
// because it owns runtime concerns (XHR, AbortController, progress) that
// the supabase-js SDK doesn't expose on its `.upload()` method. The data
// access helpers (insert / list / sign / subscribe) live next door.
//
// Pipeline:
//   1. Validate MIME against the allowlist (PDF / image / video / text).
//   2. Mint a UUID for the file_id — also becomes the project_files.id.
//      The storage path includes it so the row and the binary share one
//      identity: `{project_id}/{file_id}/{filename}`.
//   3. Ask supabase-js for a one-shot signed upload URL.
//   4. PUT the raw File to that URL via XMLHttpRequest (the only way to
//      get upload.onprogress + xhr.abort()). The Blob streams through
//      Chromium; we never read it into memory.
//   5. On 2xx, insert the project_files row. If THAT fails, best-effort
//      delete the orphan storage object (admin-only per RLS; non-admin
//      members get a silent failure — a server-side sweeper can mop up).
//
// Cancellation: caller passes an AbortSignal; signal.abort() → xhr.abort()
// → onabort fires → returns { error: AbortError }. The signed-upload-URL
// flow is a single PUT (no multi-part stub), so there's no orphan to
// clean up after a mid-transfer cancel.

import {
  createSignedUploadTarget,
  insertProjectFileRow,
  deleteStorageObject,
} from './projectFiles';
import {
  generateThumbnail,
  generateVideoFrames,
  buildThumbnailPath,
  buildVideoFramePath,
} from './thumbnails';

// MIME allowlist. Reject anything else client-side so the user gets an
// immediate "Unsupported file type" instead of a confusing 4xx after the
// binary started uploading. Defence in depth: storage RLS still enforces
// membership, so this is a UX guard, not a security boundary.
export function isAcceptedMime(type) {
  if (!type) return false;
  if (type === 'application/pdf') return true;
  if (type.startsWith('image/')) return true;
  if (type.startsWith('video/')) return true;
  if (type.startsWith('text/')) return true;
  return false;
}

// Build the canonical storage path. Exported so the orchestrator can
// log it / display it without re-deriving inside the upload function.
export function buildStoragePath(projectId, fileId, filename) {
  return `${projectId}/${fileId}/${filename}`;
}

// PUT the file to a signed storage URL with progress + abort. Returns
// { ok: true } on 2xx; { ok: false, error } on any failure (including
// abort, which surfaces as a DOMException of name 'AbortError' so the
// orchestrator can branch on it).
//
// Body is the raw File (Blob). Chromium streams it through the XHR —
// no slice / readAsArrayBuffer / memory copy. `Content-Type` carries
// the MIME; `x-upsert: false` makes a re-upload to the same path 409
// instead of silently overwriting (the {file_id} segment is unique
// per upload anyway, but this catches programmer error early).
function putFileWithProgress({ url, file, signal, onProgress }) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'false');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          error: new Error(`Upload failed (${xhr.status}): ${xhr.responseText || xhr.statusText || 'unknown'}`),
        });
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: new Error('Network error during upload') });
    xhr.onabort = () => resolve({ ok: false, error: new DOMException('Aborted', 'AbortError') });

    if (signal) {
      // If the caller cancelled BEFORE we even started, short-circuit.
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      // `once: true` so we don't leak a listener if the upload completes
      // normally and the signal is later aborted by another consumer.
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}

// Main entry point. Returns `{ data, error }`:
//   data = { fileId, storagePath, row }  on success
//   error = Error | DOMException(AbortError) | rejection reason on failure
//
// `onProgress(loaded, total)` is called as bytes go up the wire. `signal`
// is an AbortSignal owned by the orchestrator (UploadsContext keeps one
// AbortController per upload in a Map keyed by upload id).
export async function uploadProjectFile({
  projectId,
  file,
  uploadedBy,
  signal,
  onProgress,
}) {
  if (!projectId)  return { data: null, error: new Error('Missing projectId') };
  if (!file)       return { data: null, error: new Error('Missing file') };
  if (!uploadedBy) return { data: null, error: new Error('Missing uploadedBy') };

  if (!isAcceptedMime(file.type)) {
    return { data: null, error: new Error(`Unsupported file type: ${file.type || 'unknown'}`) };
  }

  // crypto.randomUUID is available everywhere in Electron's Chromium
  // (renderer process) and in the web build's target browsers. No
  // polyfill needed.
  const fileId = crypto.randomUUID();
  const storagePath = buildStoragePath(projectId, fileId, file.name);

  // 1. Get a signed upload URL.
  const { data: target, error: signErr } = await createSignedUploadTarget(storagePath);
  if (signErr || !target?.signedUrl) {
    return { data: null, error: signErr || new Error('Failed to obtain signed upload URL') };
  }

  // 2. Kick off thumbnail generation in PARALLEL with the main upload.
  // Both run against local resources (canvas / pdf.js / a hidden <video>
  // and an XHR), so they don't fight for bandwidth — by the time the
  // main PUT finishes, the thumbnail Blob is usually ready too. If the
  // generator yields null (unsupported MIME, decode failure, timeout)
  // we just skip the thumbnail leg and leave thumbnail_path null; the
  // FileCard falls back to a glyph in that case. Never throws — the
  // generator catches its own errors and yields null.
  //
  // Video files take the multi-frame path: generateVideoFrames returns up
  // to 5 JPEG blobs for the hover slideshow. The single-frame
  // generateThumbnail still runs for image/PDF as before. We don't run
  // both for video — the frames already cover the static-poster need
  // (frame 0 is shipped to thumbnail_path for back-compat).
  const isVideo = (file.type || '').startsWith('video/');
  const thumbnailPromise = isVideo ? Promise.resolve(null) : generateThumbnail(file);
  const videoFramesPromise = isVideo ? generateVideoFrames(file) : Promise.resolve([]);

  // 3. Stream the file to the signed URL.
  const putResult = await putFileWithProgress({
    url: target.signedUrl,
    file,
    signal,
    onProgress,
  });
  if (!putResult.ok) {
    // Main PUT failed (network, abort, or 4xx). Discard the in-flight
    // thumbnail too — there's no row to point at it, and uploading a
    // thumbnail for a file that never landed would just leak storage.
    return { data: null, error: putResult.error };
  }

  // 4. Wait for the thumbnail (likely already done) and ship it.
  // Failures at this step are non-fatal: the main file uploaded
  // successfully, so we still want a metadata row — just without a
  // thumbnail_path. The fallback glyph in the UI covers the gap.
  let thumbnailPath = null;
  let thumbnailFrames = null;

  if (isVideo) {
    // Video path — upload up to 5 frames in parallel for the hover
    // slideshow. Frame 0 doubles as the legacy thumbnail_path so any
    // code path still keyed off thumbnail_path keeps working unchanged.
    const frameBlobs = await videoFramesPromise;
    if (frameBlobs.length > 0 && !signal?.aborted) {
      const uploads = frameBlobs.map(async (blob, i) => {
        const fPath = buildVideoFramePath(projectId, fileId, i);
        const { data: fTarget } = await createSignedUploadTarget(fPath);
        if (!fTarget?.signedUrl) return null;
        const fResult = await putFileWithProgress({
          url: fTarget.signedUrl,
          file: new File([blob], `_thumb_${i}.jpg`, { type: 'image/jpeg' }),
          signal,
        });
        return fResult.ok ? fPath : null;
      });
      const settled = await Promise.all(uploads);
      const succeededPaths = settled.filter(Boolean);
      if (succeededPaths.length > 0) {
        thumbnailFrames = succeededPaths;
        thumbnailPath = succeededPaths[0]; // back-compat poster
      }
      // If every frame failed to upload, leave both null — the card
      // falls back to its MIME glyph, same as if generation failed.
    }
  } else {
    // Image / PDF / text — original single-frame path.
    const thumbnailBlob = await thumbnailPromise;
    if (thumbnailBlob && !signal?.aborted) {
      const tPath = buildThumbnailPath(projectId, fileId);
      const { data: tTarget } = await createSignedUploadTarget(tPath);
      if (tTarget?.signedUrl) {
        // No progress callback for the thumbnail — it's a few tens of KB
        // and the UI doesn't surface a separate progress bar for it. We
        // still pass the abort signal so cancelling the parent upload
        // also kills an in-flight thumbnail PUT.
        const tResult = await putFileWithProgress({
          url: tTarget.signedUrl,
          // Wrap the Blob in a File so putFileWithProgress's `file.type`
          // / `file.name` reads work uniformly with the main-upload path.
          file: new File([thumbnailBlob], '_thumb.jpg', { type: 'image/jpeg' }),
          signal,
        });
        if (tResult.ok) thumbnailPath = tPath;
        // tResult.ok === false: thumbnail PUT failed; thumbnailPath stays
        // null. Don't bubble — the main upload's success isn't conditional
        // on the thumbnail.
      }
    }
  }

  // 5. Insert the metadata row. If THIS fails the binary is now orphaned
  // — fire-and-forget the deletes so we don't leak storage. The user
  // already saw the upload "succeed" (bytes hit the server); surfacing
  // a second error here is correct: the file isn't queryable through
  // the app's lists until a row exists. Clean BOTH the main object and
  // the thumbnail (if one was uploaded) — admin-only per RLS, silent
  // failure for members; a sweeper / admin can mop those orphans up.
  const { data: row, error: insertErr } = await insertProjectFileRow({
    id: fileId,
    projectId,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    storagePath,
    thumbnailPath,
    thumbnailFrames,
    uploadedBy,
  });
  if (insertErr) {
    deleteStorageObject(storagePath).catch(() => { /* swallowed — admin sweeper covers it */ });
    if (thumbnailFrames) {
      // Clean up every frame, not just the poster — leaving frames 1-4
      // would leak storage equivalent to the rest of the slideshow.
      for (const fPath of thumbnailFrames) {
        deleteStorageObject(fPath).catch(() => { /* same */ });
      }
    } else if (thumbnailPath) {
      deleteStorageObject(thumbnailPath).catch(() => { /* same */ });
    }
    return { data: null, error: insertErr };
  }

  return { data: { fileId, storagePath, thumbnailPath, thumbnailFrames, row }, error: null };
}
