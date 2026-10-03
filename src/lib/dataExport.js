// "Download my data" (GDPR Art. 15 access / Art. 20 portability).
// Everything the account holds on DocVex's servers (the export-my-data Edge
// Function) plus what this computer keeps that is the user's OWN — their AI
// conversations and every setting keyed to their account — as one JSON file.
// Case files are not included: they are already ordinary files in the user's
// own folders.

import { supabase } from './supabaseClient';
import { listConversations } from './conversationHistory';
import { readStoreForSync, secureKeys, secureStorage } from './secureStore';

async function localPart(userId) {
  const out = { conversations: [], keys: {} };
  try { out.conversations = await listConversations(); } catch { /* index not answering */ }
  // Both homes: the settings in localStorage and the content in the
  // encrypted store (lib/secureStore).
  const all = { ...readStoreForSync('docvex') };
  for (const [k, raw] of Object.entries(all)) {
    if (!/^docvex[.:]/i.test(k) || !userId || !k.includes(userId) || raw == null) continue;
    try { out.keys[k] = JSON.parse(raw); } catch { out.keys[k] = raw; }
  }
  // The encrypted store is THIS USER's (hydrated per account): everything in
  // it is theirs — histories, research chats, kept answers — whether or not
  // its key names the account (security audit 2026-10-01: those keyed by a
  // path or a tab were left out).
  for (const k of secureKeys('')) {
    if (k in out.keys) continue;
    const raw = secureStorage.getItem(k);
    if (raw == null) continue;
    try { out.keys[k] = JSON.parse(raw); } catch { out.keys[k] = raw; }
  }
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
