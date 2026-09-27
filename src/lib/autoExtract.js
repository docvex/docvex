// Extract text on IMPORT. Every picture that comes into a project — picked
// from the computer, dropped in, a folder imported, a phone upload accepted —
// has its text read in the background (`extractImageText`, lib/textRegions)
// and saved as its AI data (`text` facet). Opening it in the Doc Viewer then
// finds the reading ready: the Extract text button only switches the
// highlights on, and reads the picture itself only when this could not (the
// backup — offline, the file changed since, the engine failed).
//
// One picture at a time, each waiting for an idle moment, so a large import
// never stalls the window. A picture already read (same size + mtime) costs
// nothing: extractImageText answers from the store.
//
// The reader is imported only when a picture arrives: this module sits on
// the main window's startup path (lib/phoneUploadIncoming).

const PICTURE_RE = /\.(jpe?g|png|webp|bmp|gif|tiff?|heic|heif|hif)$/i;
export const isExtractablePicture = (name) => PICTURE_RE.test(String(name || ''));

const queue = [];
const queued = new Set();
let running = false;

const idle = () => new Promise((resolve) => {
  if (typeof window !== 'undefined' && window.requestIdleCallback) window.requestIdleCallback(() => resolve(), { timeout: 2000 });
  else setTimeout(resolve, 200);
});

// Chromium can't decode HEIC on Windows: hand the reader the decoded picture.
async function heicImage(path) {
  const { heicUrl } = await import('./heic');
  const url = await heicUrl(path, { key: `extract:${path}`, maxSide: 3000 });
  if (!url) return null;
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

async function pump() {
  if (running) return;
  running = true;
  try {
    const { extractImageText } = await import('./textRegions');
    while (queue.length) {
      const file = queue.shift();
      queued.delete(file.path);
      await idle();
      try {
        const el = /\.(heic|heif|hif)$/i.test(file.name) ? await heicImage(file.path).catch(() => null) : null;
        const res = await extractImageText(file, { el });
        if (res?.error) console.warn('[auto-extract]', file.name, res.error); // eslint-disable-line no-console
      } catch (err) {
        console.warn('[auto-extract]', file.name, err); // eslint-disable-line no-console
      }
    }
  } finally {
    running = false;
  }
}

/** Queue imported files for text extraction; anything not a picture is ignored. */
export function extractTextOnImport(files, projectId = null) {
  for (const f of files || []) {
    const path = f?.path;
    const name = f?.name || f?.filename || String(path || '').split(/[\\/]/).pop();
    if (!path || !isExtractablePicture(name) || queued.has(path)) continue;
    queued.add(path);
    queue.push({ path, name, projectId });
  }
  pump();
}
