// AI captions/transcript for the DocViewer's audio player AND video pane —
// made ON THIS COMPUTER (security fix V11). Nothing is uploaded: Whisper
// (OpenAI's open, multilingual speech model — Romanian included) runs locally
// through transformers.js / ONNX Runtime Web in a Web Worker
// (lib/whisper.worker.js). The model files are served by the app itself
// (public/models/, fetched once at install by scripts/copy-whisper-assets.mjs)
// and remote loading is switched off, so no audio and no request leave the
// machine. OpenAI is no longer used anywhere.
//
// Every kind of media takes the same path: the container (mp3/wav/m4a/…, or a
// video's mp4/mov/webm/mkv) is decoded by the same Chromium media stack the
// preview uses, downmixed and resampled to 16 kHz mono — Whisper's own input —
// and those samples are handed to the worker. No ffmpeg / native dependency.

// The largest file read (the whole file is decoded in memory) and the longest
// recording transcribed. Local transcription has no upload cap, but decoding a
// multi-gigabyte video would exhaust the window's memory.
export const TRANSCRIBE_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_SECONDS = 3 * 60 * 60;

// Whisper works on 16 kHz mono; everything is decoded to exactly that.
const TARGET_SAMPLE_RATE = 16000;

// ── Audio extraction (any media → 16 kHz mono samples) ───────────────
// decodeAudioData demuxes the container (mp3/wav/m4a, or a video's
// mp4/mov/webm/mkv) and hands back the decoded PCM of its audio track; we then
// downmix to mono + resample to 16 kHz. All offline (no realtime playback).

// Decode the (possibly video) container's audio track to a PCM AudioBuffer.
async function decodeMediaAudio(arrayBuffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('Audio extraction isn’t supported here.');
  const ctx = new Ctx();
  try {
    // decodeAudioData detaches the buffer it's handed; we don't reuse it after.
    return await ctx.decodeAudioData(arrayBuffer);
  } finally {
    try { await ctx.close(); } catch { /* already closed */ }
  }
}

// Downmix to mono + resample to 16 kHz via an offline render. Feeding a
// multi-channel buffer into a 1-channel destination downmixes it automatically.
async function resampleToMono16k(audioBuffer) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) throw new Error('Audio extraction isn’t supported here.');
  const frames = Math.max(1, Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE));
  const offline = new Offline(1, frames, TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  // A copy of its own, so its buffer can be transferred to the worker.
  return new Float32Array(rendered.getChannelData(0)); // mono, 16 kHz
}

// Fetch a media URL (video or audio) and return its audio track as 16 kHz
// mono Float32 samples + its duration. Throws a user-facing message on
// unreadable / audio-less / undecodable input.
async function extractAudioSamples(url, isVideo) {
  const what = isVideo ? 'video' : 'audio';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn’t read the ${what} file.`);
  const size = Number(res.headers.get('content-length')) || 0;
  if (size > TRANSCRIBE_MAX_BYTES) throw new Error(`This ${what} file is too large to transcribe here (over 1 GB).`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > TRANSCRIBE_MAX_BYTES) throw new Error(`This ${what} file is too large to transcribe here (over 1 GB).`);
  let decoded;
  try {
    decoded = await decodeMediaAudio(buf);
  } catch {
    throw new Error(`Couldn’t extract audio from this ${what} — its format may be unsupported.`);
  }
  if (!decoded || decoded.length === 0 || decoded.duration === 0) {
    throw new Error(`This ${what} has no audio track to transcribe.`);
  }
  if (decoded.duration > MAX_SECONDS) {
    throw new Error('This recording is too long to transcribe here (over 3 hours).');
  }
  const samples = await resampleToMono16k(decoded);
  return { samples, duration: decoded.duration };
}

// ── The local engine (lib/whisper.worker.js) ─────────────────────────
// Multilingual Whisper "small" (quantized 8-bit ONNX, onnx-community): good
// Romanian at a size a laptop runs. The id is also the folder the model sits in
// under public/models/ — keep it in step with scripts/copy-whisper-assets.mjs.
export const WHISPER_MODEL = 'onnx-community/whisper-small';

function appBase() {
  const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || './';
  return new URL(base.replace(/\/?$/, '/'), window.location.href).href;
}

// One worker per window, made on first use and kept (loading the model is the
// slow part). A job at a time — Whisper on one thread is CPU-bound anyway.
let worker = null;
let nextId = 0;
const waiting = new Map(); // id → { resolve, reject, onProgress }
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./whisper.worker.js', import.meta.url), { type: 'module', name: 'whisper' });
  worker.onmessage = ({ data }) => {
    const job = waiting.get(data?.id);
    if (!job) return;
    if (data.type === 'progress') { try { job.onProgress?.(data.progress); } catch { /* ignore */ } return; }
    waiting.delete(data.id);
    if (data.ok) job.resolve(data); else job.reject(new Error(data.error || 'failed'));
  };
  worker.onerror = (ev) => {
    const err = new Error(ev?.message || 'The transcription engine couldn’t start.');
    for (const job of waiting.values()) job.reject(err);
    waiting.clear();
    try { worker.terminate(); } catch { /* gone */ }
    worker = null;
  };
  return worker;
}

let queue = Promise.resolve();
function runWhisper(samples, onProgress) {
  const job = queue.then(() => new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject, onProgress });
    // The samples' buffer is transferred, not copied (it can be hundreds of MB).
    getWorker().postMessage({ id, base: appBase(), model: WHISPER_MODEL, audio: samples }, [samples.buffer]);
  }));
  queue = job.catch(() => {});
  return job;
}

// Whisper reports no language through the pipeline; Romanian is told by its
// own letters (the case this app cares about), anything else is left unknown.
function guessLanguage(text) {
  return /[ăâîșțşţĂÂÎȘȚŞŢ]/.test(text) ? 'romanian' : null;
}

function engineMessage(err) {
  const m = String(err?.message || err || '');
  if (/not found locally|allowRemoteModels|404|unreadable/i.test(m)) {
    return 'The speech model isn’t installed on this computer — reinstall DocVex (or run npm install) to add it.';
  }
  return `Couldn’t transcribe this recording${m ? ` (${m.slice(0, 160)})` : ''} — try again.`;
}

// url → { text, segments: [{ start, end, text }], language }. segments may
// be empty if Whisper found no speech (e.g. a silent file).
//
// Runs entirely on this computer — no upload, so it is NOT gated by the
// project's cloud-media setting (lib/cloudMedia). `projectId` is accepted for
// the callers' sake and unused. `onProgress` hears the model loading.
export async function transcribeAudio(url, mediaType, filename, { onProgress } = {}) {
  const isVideo = (mediaType || '').toLowerCase().startsWith('video/');
  const { samples, duration } = await extractAudioSamples(url, isVideo);
  let out;
  try {
    out = await runWhisper(samples, onProgress);
  } catch (err) {
    throw new Error(engineMessage(err));
  }
  const segments = (out.chunks || [])
    .map((c) => {
      const [s, e] = Array.isArray(c.timestamp) ? c.timestamp : [];
      const start = Number.isFinite(s) ? s : 0;
      const end = Number.isFinite(e) ? e : duration;
      return { start, end: Math.max(start, end), text: String(c.text || '').trim() };
    })
    .filter((seg) => seg.text);
  const text = String(out.text || '').trim();
  return { text, segments, language: guessLanguage(text) };
}
