// Where a web address LANDS and its site's icon — cached (2026-10-03).
//
// The Doc Viewer's code tooltip (a QR code / barcode holding a link) shows the
// site a press would land on with that site's own icon. Main finds both
// (`link:preview`: redirects followed by hand, private networks refused); this
// module keeps the answers so a hover never waits on the network twice:
//   · in memory, read SYNCHRONOUSLY by the tooltip (`peekLinkPreview`) — the
//     pill is drawn complete on its first frame once the answer is known;
//   · in the ENCRYPTED store (lib/secureStore, `docvex:link-preview:v1` — the
//     addresses come out of the user's photos), so it survives a restart;
//   · one request per address at a time (`loadLinkPreview` shares it).
// The icon is redrawn as a 32px PNG before it is kept: a site's favicon.ico can
// hold several large images, which the pill decoded on every hover.
import { linkPreview } from './platform';
import { secureGet, secureSet, whenSecureStoreReady } from './secureStore';

const KEY = 'docvex:link-preview:v1';
const MAX = 300;                       // addresses kept (oldest out)
const FAIL_TTL = 10 * 60 * 1000;       // an unreachable site is asked again after this
const ICON_PX = 32;

const mem = new Map();                 // url → { ok, host, icon, at }
const inflight = new Map();            // url → Promise
const subs = new Set();
let loaded = false;

function hydrate() {
  if (loaded) return;
  try {
    const all = JSON.parse(secureGet(KEY) || '{}');
    for (const [u, v] of Object.entries(all)) if (!mem.has(u)) mem.set(u, v);
    loaded = true;
  } catch { /* store not ready yet: tried again on the next read */ }
}
whenSecureStoreReady?.().then(() => { loaded = false; hydrate(); subs.forEach((fn) => fn()); }).catch(() => {});

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const keep = [...mem.entries()].filter(([, v]) => v.ok).slice(-MAX);
    try { secureSet(KEY, JSON.stringify(Object.fromEntries(keep))); } catch { /* full / not ready */ }
  }, 400);
}

// A site's icon, redrawn small. Anything that cannot be drawn is dropped (the
// pill shows the site's initial).
function shrinkIcon(dataUrl) {
  return new Promise((resolve) => {
    if (!dataUrl) { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = ICON_PX; c.height = ICON_PX;
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, ICON_PX, ICON_PX);
        resolve(c.toDataURL('image/png'));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/** The answer known for `url` right now (null when it has not been asked). */
export function peekLinkPreview(url) {
  hydrate();
  const v = mem.get(url);
  if (!v) return null;
  if (!v.ok && Date.now() - (v.at || 0) > FAIL_TTL) return null;
  return v;
}

/** Ask once (shared while it runs); resolves to `{ ok, host, icon }`. */
export function loadLinkPreview(url) {
  if (!/^https?:\/\//i.test(url || '')) return Promise.resolve({ ok: false });
  const known = peekLinkPreview(url);
  if (known) return Promise.resolve(known);
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    const r = await linkPreview(url).catch(() => null);
    const v = r?.ok
      ? { ok: true, host: r.host, icon: await shrinkIcon(r.icon), at: Date.now() }
      : { ok: false, at: Date.now() };
    mem.delete(url); mem.set(url, v);
    if (v.ok) save();
    inflight.delete(url);
    subs.forEach((fn) => fn());
    return v;
  })();
  inflight.set(url, p);
  return p;
}

export function subscribeLinkPreviews(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
