// Module-level LRU cache for parsed pdf.js document handles.
//
// pdf.js's getDocument(...) is the heaviest part of opening a PDF preview:
// the URL fetch (binary download) + the parse (cross-reference table,
// page tree, embedded fonts) typically takes 500ms–2s on a cold open.
// The result is a document handle that holds the parsed structure in
// memory — opening the same file a second time and re-running getDocument
// would do all that work again, even though the data hasn't changed.
//
// This cache keeps recently-opened documents alive across modal opens so
// re-entering a file is effectively instant: getPage(1).render(...) runs
// against the cached handle in ~50ms instead of starting from scratch.
//
// Sizing: capped at MAX_PDF_CACHE entries. Each handle's memory cost is
// proportional to the PDF's size (often several MB for image-heavy PDFs),
// so the cap is intentionally small. LRU eviction means the user's most-
// recently-touched files stay warm; less-recently-used handles get
// .destroy()'d to free their pdf.js worker structures.
//
// Lifecycle:
//   - getCachedPdf(path, url): returns a cached handle if present, else
//     loads via pdf.js and stores. On hit, the entry is moved to "most
//     recent" by delete + re-set (Map preserves insertion order).
//   - evictPdf(path): manual eviction, called from the delete-file path
//     so a deleted file's stale handle isn't reused.
//   - clearPdfCache(): nuclear option for sign-out flows; destroys every
//     cached handle.

import { loadPdfModule } from './pdfWorker';

const MAX_PDF_CACHE = 5;
const _pdfCache = new Map();   // storagePath → pdf document handle
// In-flight promises so two near-simultaneous opens of the same file don't
// race and end up parsing twice. Keyed by storagePath; cleared on resolve.
const _pendingLoads = new Map(); // storagePath → Promise<pdfDoc>

export async function getCachedPdf(storagePath, signedUrl) {
  if (!storagePath || !signedUrl) {
    throw new Error('getCachedPdf requires storagePath and signedUrl');
  }

  // Cache hit — LRU touch (delete + re-set bumps to most-recent insertion).
  if (_pdfCache.has(storagePath)) {
    const doc = _pdfCache.get(storagePath);
    _pdfCache.delete(storagePath);
    _pdfCache.set(storagePath, doc);
    return doc;
  }

  // De-dupe concurrent loads. If two PdfPreview instances mount with the
  // same storagePath before the first parse resolves, the second one
  // awaits the first's promise instead of kicking off a duplicate fetch.
  if (_pendingLoads.has(storagePath)) {
    return _pendingLoads.get(storagePath);
  }

  const loadPromise = (async () => {
    const pdfjs = await loadPdfModule();
    const doc = await pdfjs.getDocument({ url: signedUrl }).promise;
    _pdfCache.set(storagePath, doc);

    // Evict oldest while over cap. Map iteration order is insertion order,
    // and we re-insert on every cache hit, so .keys().next() yields the LRU.
    while (_pdfCache.size > MAX_PDF_CACHE) {
      const oldestKey = _pdfCache.keys().next().value;
      if (oldestKey === undefined || oldestKey === storagePath) break;
      const oldestDoc = _pdfCache.get(oldestKey);
      _pdfCache.delete(oldestKey);
      try { oldestDoc?.destroy(); } catch { /* worker may already be gone */ }
    }
    return doc;
  })();

  _pendingLoads.set(storagePath, loadPromise);
  try {
    return await loadPromise;
  } finally {
    _pendingLoads.delete(storagePath);
  }
}

// Evict a single entry. Safe to call repeatedly.
export function evictPdf(storagePath) {
  if (!storagePath) return;
  const doc = _pdfCache.get(storagePath);
  if (doc) {
    _pdfCache.delete(storagePath);
    try { doc.destroy(); } catch { /* ignore */ }
  }
}

// Nuke everything — call on sign-out so a different user's signed URLs
// don't get reused against a now-stale auth bearer.
export function clearPdfCache() {
  for (const doc of _pdfCache.values()) {
    try { doc.destroy(); } catch { /* ignore */ }
  }
  _pdfCache.clear();
  _pendingLoads.clear();
}
