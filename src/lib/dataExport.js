// "Download my data" (GDPR Art. 15 access / Art. 20 portability).
// Everything the account holds on DocVex's servers (the export-my-data Edge
// Function) plus what this computer keeps that is the user's OWN — their AI
// conversations and every setting keyed to their account — as one JSON file.
// Case files are not included: they are already ordinary files in the user's
// own folders.

import { supabase } from './supabaseClient';
import { listConversations } from './conversationHistory';

async function localPart(userId) {
  const out = { conversations: [], keys: {} };
  try { out.conversations = await listConversations(); } catch { /* index not answering */ }
  try {
    for (const k of Object.keys(localStorage)) {
      if (!/^docvex[.:]/i.test(k) || !userId || !k.includes(userId)) continue;
      const raw = localStorage.getItem(k);
      try { out.keys[k] = JSON.parse(raw); } catch { out.keys[k] = raw; }
    }
  } catch { /* storage unavailable */ }
  return out;
}

/** Builds the export and saves it as a .json download. Returns { ok, error? }. */
export async function downloadMyData() {
  const { data: session } = await supabase.auth.getSession();
  const userId = session?.session?.user?.id || null;
  const { data, error } = await supabase.functions.invoke('export-my-data', { body: {} });
  if (error || !data || data.error) return { ok: false, error: error?.message || data?.error || 'export_failed' };
  const doc = { ...data, this_computer: await localPart(userId) };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `docvex-my-data-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { ok: true };
}
