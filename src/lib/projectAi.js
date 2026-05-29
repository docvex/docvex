// Client wrapper for the `project-ai` Edge Function — live Claude for the
// project AI hub (the /ai surface). Mirrors the invoke pattern in
// legalFeed.getWeeklyDigest: the function returns a 200 with
// `{ ok:false, error }` when the AI key isn't configured, so callers fall
// back gracefully instead of throwing on a non-2xx.

import { supabase } from './supabaseClient';

function unwrap(data, error) {
  if (error) return { error };
  if (!data || data.ok === false) {
    return { error: new Error(data?.error || 'ai_unavailable') };
  }
  return { data };
}

// Q&A turn. `messages` is the running conversation as
// [{ role: 'user' | 'assistant', content }]. Returns `{ text }` or `{ error }`.
export async function askProjectAi({ messages, projectName, fileNames }) {
  const { data, error } = await supabase.functions.invoke('project-ai', {
    body: { action: 'ask', messages, projectName, fileNames },
  });
  const res = unwrap(data, error);
  if (res.error) return res;
  return { text: res.data.text || '' };
}

// Draft a document. Returns `{ text }` or `{ error }`.
export async function generateDocument({ template, instructions, projectName, fileNames }) {
  const { data, error } = await supabase.functions.invoke('project-ai', {
    body: { action: 'generate', template, instructions, projectName, fileNames },
  });
  const res = unwrap(data, error);
  if (res.error) return res;
  return { text: res.data.text || '' };
}
