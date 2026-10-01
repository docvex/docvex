// Erase what DocVex keeps about the user ON THIS COMPUTER (GDPR Art. 17).
// Called by Account → Erase data and after Delete account. Clears every
// DocVex key in localStorage (caches of extracted text, AI data, chats,
// search history, tokens…), sessionStorage, and — through the main process —
// the project index databases, the pseudonymisation vaults, the thumbnail
// cache, temp files and the browser-side caches. The case folders themselves
// (the user's own documents and their .docvex/ folder) are never touched.

import { forgetFolderKeys } from './projectFolderKey';
import { wipeSecureStore } from './secureStore';

const OURS = /^(docvex[.:]|sb-|supabase\.)/i;

export async function wipeLocalUserData() {
  forgetFolderKeys();
  // The encrypted store first: its memory is dropped and nothing pending is
  // written back into the index main is about to delete.
  try { await wipeSecureStore({ persistent: true }); } catch { /* keep going */ }
  let main = null;
  try {
    main = await window.electronAPI?.wipeLocalData?.();
  } catch (err) {
    main = { ok: false, failed: [String(err?.message || err)] };
  }
  try {
    Object.keys(localStorage).filter((k) => OURS.test(k)).forEach((k) => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
  try { sessionStorage.clear(); } catch { /* storage unavailable */ }
  return {
    ok: !main || main.ok !== false,
    failed: main?.failed || [],
  };
}
