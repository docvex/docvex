// AI captions/transcript for the DocViewer's audio player AND video pane.
//
// The audio bytes are sent to the `doc-ai` Edge Function (task "transcribe"),
// where OpenAI Whisper does the actual speech-to-text — the OpenAI key stays
// server-side and the call rides the user's Supabase session like every
// other doc-ai task.
//
// Videos can't be shipped whole: Whisper caps the upload at 25 MB and a video
// is almost entirely non-audio bytes, so the raw file blows past the cap on
// anything but a few seconds of footage. For videos we extract just the audio
// track in the renderer (see extractAudioWav) and send that compact WAV
// instead — no ffmpeg/native dep, the same Chromium media stack the <video>
// preview already uses does the demux + decode.
import { supabase } from './supabaseClient';

// Whisper's hard cap is 25 MB of raw audio; base64 inflates that by ~4/3.
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;

// Whisper resamples everything to 16 kHz mono internally, so extracting the
// audio at exactly that rate loses no speech detail while shrinking the payload
// dramatically. 16 kHz mono 16-bit PCM is 32 KB/s, so the 25 MB cap fits
// ~13 minutes of speech — comfortably more than the clips this panel targets.
const TARGET_SAMPLE_RATE = 16000;

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── Audio extraction (video → WAV) ───────────────────────────────────
// decodeAudioData demuxes the container (mp4/mov/webm/mkv/…) and hands back the
// decoded PCM of its audio track; we then downmix to mono + resample to 16 kHz
// and re-wrap as a small WAV. All offline (no realtime playback), so a short
// clip extracts in well under a second.

function writeAsciiString(view, offset, str) {
  for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
}

// Mono Float32 samples → 16-bit PCM WAV (ArrayBuffer).
function monoFloatToWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAsciiString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAsciiString(view, 8, 'WAVE');
  writeAsciiString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                              // fmt chunk size
  view.setUint16(20, 1, true);                               // format = PCM
  view.setUint16(22, 1, true);                               // channels = mono
  view.setUint32(24, sampleRate, true);                      // sample rate
  view.setUint32(28, sampleRate * bytesPerSample, true);     // byte rate (mono)
  view.setUint16(32, bytesPerSample, true);                  // block align
  view.setUint16(34, 16, true);                              // bits per sample
  writeAsciiString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

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
  return rendered.getChannelData(0); // Float32Array, mono, 16 kHz
}

// Fetch a media URL (video or audio) and return compact 16 kHz mono WAV bytes
// of its audio track. Throws a user-facing message on unreadable / audio-less
// / undecodable input.
async function extractAudioWav(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Couldn’t read the video file.');
  const buf = await res.arrayBuffer();
  let decoded;
  try {
    decoded = await decodeMediaAudio(buf);
  } catch {
    throw new Error('Couldn’t extract audio from this video — its format may be unsupported.');
  }
  if (!decoded || decoded.length === 0 || decoded.duration === 0) {
    throw new Error('This video has no audio track to transcribe.');
  }
  const samples = await resampleToMono16k(decoded);
  return monoFloatToWav(samples, TARGET_SAMPLE_RATE);
}

// Map a server-side `{ ok:false, error, detail }` payload to a user-facing
// message. Shared by the HTTP-error path and the (rarer) 200-with-ok:false path.
function messageForServerError(code, detail) {
  switch (code) {
    case 'ai_not_configured':
      return 'Audio transcription isn’t configured on the server (the OpenAI key is missing).';
    case 'audio_too_large':
      return 'This file is too large to transcribe (over 25 MB).';
    case 'missing_audio':
      return 'No audio was sent to transcribe.';
    case 'invalid_audio':
      return 'The audio file couldn’t be read.';
    case 'ai_failed':
      return `The AI couldn’t transcribe this audio${detail ? ` (${detail})` : ''} — try again.`;
    default:
      return 'The AI couldn’t transcribe this audio — try again.';
  }
}

// supabase-js turns ANY non-2xx response into `error` (a FunctionsHttpError)
// whose `.context` is the raw Response — the real `{ ok:false, error }` body
// lives there, not in `data`. Pull it out so the user sees the actual reason
// (server not configured, OpenAI rejected the key, etc.) instead of a blanket
// "you’re offline". Returns null only when there’s no readable body — i.e. a
// genuine network/relay failure where we really couldn’t reach the service.
async function serverErrorMessage(error) {
  try {
    const res = error?.context;
    if (res && typeof res.json === 'function') {
      const body = await res.clone().json();
      if (body?.error) return messageForServerError(body.error, body.detail);
    }
  } catch {
    // No JSON body to read — fall through to the network message.
  }
  return null;
}

// url → { text, segments: [{ start, end, text }], language }. segments may
// be empty if Whisper returned no timed segments (e.g. silent file).
//
// For videos the whole file is far too big for Whisper, so we pull just the
// audio track out and ship it as a small WAV; audio files go straight through.
export async function transcribeAudio(url, mediaType, filename) {
  const isVideo = (mediaType || '').toLowerCase().startsWith('video/');

  let buf;
  let sendMediaType;
  let sendFilename;
  if (isVideo) {
    buf = await extractAudioWav(url);
    sendMediaType = 'audio/wav';
    sendFilename = filename ? `${filename.replace(/\.[^./\\]+$/, '')}.wav` : 'audio.wav';
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Couldn’t read the audio file.');
    buf = await res.arrayBuffer();
    sendMediaType = mediaType;
    sendFilename = filename;
  }

  if (buf.byteLength > TRANSCRIBE_MAX_BYTES) {
    throw new Error(isVideo
      ? 'This video’s audio is too long to transcribe (over ~13 minutes).'
      : 'This file is too large to transcribe (over 25 MB).');
  }
  const audio = arrayBufferToBase64(buf);

  const { data, error } = await supabase.functions.invoke('doc-ai', {
    body: { task: 'transcribe', audio, mediaType: sendMediaType, filename: sendFilename },
  });
  if (error) {
    const serverMessage = await serverErrorMessage(error);
    throw new Error(serverMessage
      ?? 'Couldn’t reach the AI service — make sure you’re signed in and online.');
  }
  if (!data?.ok) {
    throw new Error(messageForServerError(data?.error, data?.detail));
  }
  return {
    text: (data.text || '').trim(),
    segments: Array.isArray(data.segments) ? data.segments : [],
    language: data.language || null,
  };
}
