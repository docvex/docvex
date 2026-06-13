// AI captions/transcript for the DocViewer's audio player.
//
// The audio bytes are sent to the `doc-ai` Edge Function (task "transcribe"),
// where OpenAI Whisper does the actual speech-to-text — the OpenAI key stays
// server-side and the call rides the user's Supabase session like every
// other doc-ai task.
import { supabase } from './supabaseClient';

// Whisper's hard cap is 25 MB of raw audio; base64 inflates that by ~4/3.
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// url → { text, segments: [{ start, end, text }], language }. segments may
// be empty if Whisper returned no timed segments (e.g. silent file).
export async function transcribeAudio(url, mediaType, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Couldn’t read the audio file.');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > TRANSCRIBE_MAX_BYTES) {
    throw new Error('This file is too large to transcribe (over 25 MB).');
  }
  const audio = arrayBufferToBase64(buf);

  const { data, error } = await supabase.functions.invoke('doc-ai', {
    body: { task: 'transcribe', audio, mediaType, filename },
  });
  if (error) throw new Error('Couldn’t reach the AI service — make sure you’re signed in and online.');
  if (!data?.ok) {
    throw new Error(data?.error === 'ai_not_configured'
      ? 'Audio transcription isn’t configured on the server.'
      : 'The AI couldn’t transcribe this audio — try again.');
  }
  return {
    text: (data.text || '').trim(),
    segments: Array.isArray(data.segments) ? data.segments : [],
    language: data.language || null,
  };
}
