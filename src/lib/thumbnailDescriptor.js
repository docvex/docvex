// Descriptor builders for the unified thumbnail system. Each builder
// takes a domain object (a project_files row, a local-folder file
// listing, a change_request_items proposed payload) and produces the
// shape lib/thumbnailResolver.js's useThumbnail hook consumes.
//
// Pure functions, no side effects. The actual signing / fetching /
// regen happens inside the hook; these just decide what to consult
// and in what order.
//
// Why builders instead of letting each surface roll its own descriptor:
//   • Cache invalidation depends on a *stable* contentKey derived from
//     the right inputs (content_hash for cloud, mtime for local, the
//     pending UUID for in-flight uploads). Centralising the derivation
//     means three surfaces can't accidentally key on different things
//     for the same file.
//   • The poster fallback order ("cloud thumb wins on Main, pending
//     thumb wins in the version-control view") used to be inlined in
//     each surface's resolver. Capturing it here keeps the priority
//     rules in one place.

// ── Cloud-only file (Main branch, or any cloud-baked row) ────────────
//
// Source of truth: a project_files row from the projects bucket. The
// row's thumbnail_path is the pre-baked thumb the upload pipeline
// produced; thumbnail_frames is the optional 5-frame array for the
// video hover slideshow. content_hash is the cache key — when the
// admin approves a replace, the row's hash changes and every surface
// recomputes from scratch.
export function describeCloudFile(row) {
  if (!row) return null;
  return {
    name: row.name || '',
    mime: row.mime_type || '',
    contentKey: row.content_hash
      ? `cloud:${row.id}:${row.content_hash}`
      : `cloud:${row.id}:${row.storage_path || ''}`,
    posters: row.thumbnail_path
      ? [{ kind: 'cloud', path: row.thumbnail_path }]
      : [],
    framePaths: Array.isArray(row.thumbnail_frames) && row.thumbnail_frames.length > 1
      ? row.thumbnail_frames
      : null,
    source: row.storage_path
      ? { kind: 'cloud', path: row.storage_path }
      : null,
    duration: row.duration_seconds || null,
  };
}

// ── Local file on My branch, optionally paired with a cloud row ──────
//
// Two cases:
//   1. Paired with a cloud row, local bytes IDENTICAL to cloud — show
//      the cloud thumb so the My-branch grid looks like Main. The card
//      already knows this via `bytesChanged=false` and skips passing
//      a local source.
//   2. Local bytes DIVERGE from cloud (or no cloud counterpart at all)
//      — the cloud thumb is stale. Use local bytes as the source so the
//      resolver regenerates from disk; contentKey folds in mtime so
//      every save invalidates the cache.
//
// `localUrl` is the pre-built URL pointing at on-disk bytes
// (`localfile://` on Electron, `blob:` from the cached FSA handle on
// web). Adding mtime as a query string is the caller's job — see
// useLocalPreviewUrl in ProjectFiles.jsx; we just consume the string.
export function describeLocalFile({ localFile, localUrl, cloud, bytesChanged, localContentHash }) {
  if (!localFile) return null;
  const usableLocalUrl = localUrl || null;
  // contentKey priority — must be stable across re-renders but break
  // on any byte change. Local hash (if known) wins because it's
  // content-derived; otherwise mtime; otherwise just the path (rare,
  // happens during the bootstrap window before mtime lands).
  const localKeyPart = localContentHash
    || localFile.mtimeIso
    || localFile.path
    || '';
  // When local bytes are stale-equal to cloud (no edit), the cloud
  // poster is canonical. Otherwise local bytes are authoritative.
  const preferLocal = bytesChanged || !cloud;
  const cloudPoster = cloud?.thumbnail_path
    ? [{ kind: 'cloud', path: cloud.thumbnail_path }]
    : [];
  const posters = preferLocal && usableLocalUrl
    ? [] // bypass cloud thumb — go straight to regenerating from local bytes
    : cloudPoster;
  const source = usableLocalUrl
    ? { kind: 'url', url: usableLocalUrl }
    : (cloud?.storage_path ? { kind: 'cloud', path: cloud.storage_path } : null);
  return {
    name: localFile.name || cloud?.name || '',
    mime: localFile.mimeType || cloud?.mime_type || '',
    contentKey: preferLocal
      ? `local:${localFile.path || ''}:${localKeyPart}`
      : `cloud:${cloud?.id || ''}:${cloud?.content_hash || cloud?.storage_path || ''}`,
    posters,
    framePaths: !preferLocal && Array.isArray(cloud?.thumbnail_frames) && cloud.thumbnail_frames.length > 1
      ? cloud.thumbnail_frames
      : null,
    source,
    duration: cloud?.duration_seconds || null,
  };
}

// ── Change-request item (Dashboard / Version control compose view) ──
//
// Two ways the item's bytes might live:
//   1. Pre-baked thumb already uploaded to projects-pending (the
//      commit flow uploads a `_thumb` alongside the proposed file).
//      Prefer this so the dashboard reads instantly.
//   2. No thumb — fetch the proposed bytes from projects-pending and
//      regenerate. Slower but always works.
//
// `cloud` is the existing cloud row for edit/replace/delete kinds; for
// 'add' there's no cloud row yet. We use cloud's thumb as a tertiary
// fallback so a file that was just renamed (proposed has no
// thumbnail_pending_path because bytes didn't change) still shows the
// right poster from cloud.
//
// `preferPending` is true on the per-author version chips (we want to
// see THIS author's proposed version) and false on the file-column
// header (we want main's current look). The fallback chain order
// flips based on this flag.
export function describeChangeRequestItem({ item, cloud, preferPending = true }) {
  if (!item && !cloud) return null;
  const proposed = item?.proposed || {};
  const name = proposed.name || cloud?.name || '';
  const mime = proposed.mime_type || cloud?.mime_type || '';
  const pendingThumb = proposed.thumbnail_pending_path
    ? { kind: 'pending', path: proposed.thumbnail_pending_path }
    : null;
  const cloudThumb = cloud?.thumbnail_path
    ? { kind: 'cloud', path: cloud.thumbnail_path }
    : null;
  const pendingBytes = proposed.pending_storage_path
    ? { kind: 'pending', path: proposed.pending_storage_path }
    : null;
  const cloudBytes = cloud?.storage_path
    ? { kind: 'cloud', path: cloud.storage_path }
    : null;
  // Priority list — drop nulls so the resolver doesn't waste a
  // round-trip on absent candidates.
  const posters = (preferPending
    ? [pendingThumb, cloudThumb]
    : [cloudThumb, pendingThumb]
  ).filter(Boolean);
  const source = preferPending
    ? (pendingBytes || cloudBytes)
    : (cloudBytes || pendingBytes);
  // contentKey: the pending bucket path embeds a unique change_id
  // (one path per pending upload), so it's perfectly stable AND
  // unique. When the request is approved + the bytes move to cloud,
  // we fall back to the cloud row's content_hash.
  const keyPart = preferPending
    ? (proposed.pending_storage_path || cloud?.content_hash || cloud?.storage_path || item?.id)
    : (cloud?.content_hash || cloud?.storage_path || proposed.pending_storage_path || item?.id);
  return {
    name,
    mime,
    contentKey: `cr:${item?.id || cloud?.id || ''}:${keyPart || ''}`,
    posters,
    framePaths: (preferPending
      ? (Array.isArray(proposed.thumbnail_frames) && proposed.thumbnail_frames.length > 1
          ? proposed.thumbnail_frames
          : null)
      : null)
      || (Array.isArray(cloud?.thumbnail_frames) && cloud.thumbnail_frames.length > 1
          ? cloud.thumbnail_frames
          : null),
    source,
    duration: proposed.duration_seconds || cloud?.duration_seconds || null,
  };
}
