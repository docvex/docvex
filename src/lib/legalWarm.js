// WARMING THE LEGISLATION PLATFORMS' DATA while the window is idle, once
// after sign-in (AppShell): the CAEN nomenclature and its notes (bundled, so
// the CAEN tab and every CAEN card open with them in hand), the libraries
// the platform pages and the one search load on first use, and — on the
// desktop — the archive's index (main keeps it in memory from then on).
// Nothing here reaches the network.
import { isElectron } from './platform';

let started = false;
export function warmLegalData() {
  if (started) return;
  started = true;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 80));
  const steps = [
    () => import('./caen').then((m) => m.loadCaen()),
    () => import('./legalSearch'),
    () => import('./legislation').then((m) => (isElectron ? m.listArchive() : null)),
    () => import('./courts'),
    () => import('./anaf'),
    () => import('./caen').then((m) => m.loadCaenNotes()),
  ];
  const next = () => {
    const step = steps.shift();
    if (!step) return;
    Promise.resolve().then(step).catch(() => { /* warmed on first use instead */ }).finally(() => idle(next, { timeout: 2000 }));
  };
  idle(next, { timeout: 2000 });
}
