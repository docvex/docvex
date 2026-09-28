// OCR (text extraction) for the DocViewer's "Extract text" selection tool
// on photos and paused video frames.
//
// The cropped selection is sent to the `doc-ai` Edge Function (task "ocr"),
// where Claude transcribes it — the Anthropic key stays server-side and the
// call rides the user's Supabase session like every other doc-ai task.
import { supabase } from './supabaseClient';
import { isCloudMediaAllowed } from './cloudMedia';

// LOCAL BY DEFAULT: unless the project allows cloud reading of images
// (lib/cloudMedia), the canvas is read on this computer by PaddleOCR
// (lib/paddleOcr, in its worker) and nothing leaves the machine.
async function recognizeLocally(canvas, onProgress) {
  onProgress?.({ label: 'Reading text on this computer…', progress: null });
  const { readLines } = await import('./paddleOcr');
  const lines = await readLines(canvas);
  return lines.map((l) => l.text).join('\n').trim();
}

// Claude internally downsizes anything over ~1568 px on the long edge —
// shipping more pixels only slows the upload. Callers use this to scale the
// crop canvas before recognizing.
export const OCR_MAX_EDGE = 1568;

// canvas → recognized text (trimmed). onProgress receives
// { label, progress: 0..1 | null } — the API gives no incremental progress,
// so this is a single indeterminate stage.
// `cloud` — true / false to force a route; left out, the project's switch decides.
export async function recognizeCanvas(canvas, onProgress, { cloud } = {}) {
  if (!(cloud ?? isCloudMediaAllowed())) return recognizeLocally(canvas, onProgress);
  onProgress?.({ label: 'Reading text…', progress: null });
  // JPEG keeps photo crops small (Claude caps images at ~5 MB); text stays
  // perfectly legible at this quality.
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const image = dataUrl.slice(dataUrl.indexOf(',') + 1);

  const { data, error } = await supabase.functions.invoke('doc-ai', {
    body: { task: 'ocr', image, mediaType: 'image/jpeg' },
  });
  if (error) throw new Error('Couldn’t reach the AI service — make sure you’re signed in and online.');
  if (!data?.ok) {
    throw new Error(data?.error === 'ai_not_configured'
      ? 'The AI key isn’t configured on the server.'
      : 'The AI couldn’t read the selection — try again.');
  }
  return (data.text || '').trim();
}
