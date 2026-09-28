// HOW THE LEGISLATION TAB SHOWS AN ITEM: 'source' — the data exactly as the
// platform's service gave it (the default, at the user's request) — or
// 'docvex' — DocVex's restyled page. One switch for every platform, at the
// left of the address row (LegalBrowser's AddressRow), kept per device.
import { useSyncExternalStore } from 'react';

const KEY = 'docvex:legal-view:v1';
let mode = (() => { try { return localStorage.getItem(KEY) === 'docvex' ? 'docvex' : 'source'; } catch { return 'source'; } })();
const subs = new Set();

export const getLegalViewMode = () => mode;
export function setLegalViewMode(next) {
  const m = next === 'docvex' ? 'docvex' : 'source';
  if (m === mode) return;
  mode = m;
  try { localStorage.setItem(KEY, m); } catch { /* unavailable */ }
  subs.forEach((f) => f());
}
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
export const useLegalViewMode = () => useSyncExternalStore(subscribe, getLegalViewMode, getLegalViewMode);
