// Shared pdf.js loader. Both src/lib/thumbnails.js (first-page raster for
// the Files grid) and src/components/FilePreview.jsx (paginated full-size
// viewer in the file detail modal) call into this — keeping the worker
// port single-instance means we spin one Web Worker for the lifetime of
// the renderer instead of one per consumer.
//
// pdfjs-dist is heavy (~500KB main + ~500KB worker), so the import is
// dynamic — it only lands in the bundle when something asks for a PDF.
// The module-level promise caches the resolved namespace so the second
// caller hits a microtask, not a fresh import.

let pdfModulePromise = null;

// Returns the pdfjs-dist namespace with its global worker port wired up.
// Idempotent — repeat calls return the cached promise. On a load failure
// (transient network blip, Vite chunk 404), the cache is cleared so the
// next caller retries fresh; otherwise the first failure would poison
// every subsequent PDF render for the session.
export function loadPdfModule() {
  if (!pdfModulePromise) {
    pdfModulePromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      // Vite's `?worker` suffix bundles the worker as a separate chunk
      // and exports a constructor that returns a Worker instance. Using
      // workerPort (not workerSrc) is the modern pattern: workerSrc
      // would need the worker file served at a known URL, while
      // workerPort hands pdf.js an already-instantiated Worker that
      // Vite emitted.
      const PdfWorker = await import('pdfjs-dist/build/pdf.worker.mjs?worker');
      pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker.default();
      return pdfjs;
    })().catch((err) => {
      pdfModulePromise = null;
      throw err;
    });
  }
  return pdfModulePromise;
}
