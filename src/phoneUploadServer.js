// Upload from a phone over the LOCAL NETWORK — the first of the Files tab's two
// Import QR codes. The desktop app runs a small HTTP server on this machine's
// Wi-Fi / Ethernet address; the QR code carries the link
// http://<lan ip>:<port>/p#t=<token>&k=<key>, the phone opens it, and every file
// it sends waits in the folder the Files tab is showing. Nothing goes through
// the cloud.
//
// ENCRYPTED (plain http cannot be, so the FILES are): the token and a random
// 256-bit key per address ride in the URL FRAGMENT, which a browser never
// sends over the network. The page seals every file on the phone (AES-256-GCM,
// lib/phoneUploadCrypto — @noble/ciphers inlined, since http pages have no
// WebCrypto) and sends it in pieces to /api/up with the token in a header;
// this server opens each piece, checks every tag and deletes anything that
// does not open. Name and type travel sealed. That defeats anyone LISTENING
// on the network; someone who can TAMPER with it could serve the phone a
// different page, which is why the Import window recommends the cloud route on
// shared or guest networks. (The older /u/<token>/… routes stay for saved
// addresses and the Shortcut, which posts plain files.)
//
// Safety:
//   - a session is a random 144-bit token. It is KEPT: the renderer remembers
//     it per project (lib/phoneUploadLocal) and hands it back on every start, so
//     the address in the QR code stays the same and a phone can keep its page
//     open and go on sending — with the Import window closed, and after the app
//     restarts. It lapses after SESSION_MS without use (sliding: every open of
//     the window and every file pushes it back) and is revoked by "New
//     address" (phone-upload:stop);
//   - everything but /u/<live token>/… is a 404; the token is compared in
//     constant time;
//   - a filename is reduced to one sanitised segment and never overwrites —
//     "scan.jpg" arriving twice becomes "scan (2).jpg";
//   - a file is streamed to a hidden ".part" beside its destination and only
//     renamed into place once complete, so a dropped connection leaves nothing
//     half-written in the project;
//   - MAX_BYTES a file.
//
// SEVERAL PEOPLE, ONE NETWORK (or one computer): a file can only reach the
// app whose token its link carries — every computer runs its own server with
// its own random tokens, so a phone pointed at another machine (an address
// that moved to someone else's computer) just gets a 404. On ONE computer:
//   - each session has an OWNER (the signed-in account); waiting files are
//     listed per owner (`phone-upload:pending` { owner }) and a change of
//     account releases every other owner's session (`phone-upload:release`),
//     so the next person signed in is never sent the previous one's files;
//   - the port is KEPT with the link (`port` on start is tried first), so
//     after a restart a phone's saved address still reaches THIS instance and
//     not another DocVex running on the same machine;
//   - the page names the computer it sends to (os.hostname(), `/info`).
//
// HELD while the Import window is closed (`hold`): a file then does NOT go into
// the project — it waits in `<folder>/.docvex-incoming/<id>__<name>` (a dotfolder,
// never listed) and the renderer shows it as a card to Accept (moved into the
// folder under a free name) or Reject (deleted). Held files outlive a restart:
// starting a session rereads the folder's waiting files.
//
// Registered from main.js (`registerPhoneUpload`). IPC:
//   phone-upload:start  { dir, project, folder, token?, key?, owner?, port? } → { ok, token, key, urls, port, computer, expiresAt }
//                       (`token` + `key`: kept ones to go on using — the address stays the same)
//   phone-upload:stop   token
//   phone-upload:hold   { token, hold }        hold new files for approval, or not
//   phone-upload:pending { owner } → [{ id, token, name, size, path, at }]  that owner's files waiting
//   phone-upload:release { owner }  end every session not that owner's (a change of account)
//   phone-upload:hold-file { dir, name, data, owner } → a file the CLOUD route brought, put in the
//                       same waiting list as a Wi-Fi one ('held' event) — nothing reaches a project unapproved
//   phone-upload:accept  id → { ok, name, path }   into the folder
//   phone-upload:reject  id → { ok }                deleted
//   phone-upload:event  (main → renderer) { token, type: 'start'|'progress'|'done'|'error'|'held'|'withdrawn', id, name, size, received, path, error }
//   POST /u/<token>/withdraw?id=  the phone takes back a file still waiting (409 not_waiting once decided)
//   phone-upload:firewall { allow? } → { ok, platform, allowed } — WINDOWS FIREWALL: a phone's
//                       connection is refused unless an inbound rule lets it in (on a network marked
//                       Public there is no prompt at all). `allow` adds one — ports PORTS, any profile —
//                       through an elevated PowerShell (Windows asks the user to approve).
//   GET  /u/<token>/status?ids=a,b  → { ok, status: { id: 'waiting'|'accepted'|'rejected'|'unknown' } } —
//                       the phone page asks after the files it sent, so a rejected one says so there

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { app } from 'electron';
import { phoneUploadPage } from './lib/phoneUploadPage';
import { PHONE_GLYPHS, PHONE_GLYPH_CATS, PHONE_GLYPH_CSS } from './lib/phoneUploadGlyphs';
import { createUnsealer, nodeOpen, isSealKey, phoneSealerSource } from './lib/phoneUploadCrypto';
import { NOBLE_GCM_JS } from './lib/phoneUploadCrypto.generated';

// The Files tab's file-type icons for the page (it can't import them itself),
// and the page's encryption: the phone's half as source, noble's AES-GCM (the
// page is plain http, where WebCrypto is off) and the CSP's script hashes.
const GLYPHS = { icons: PHONE_GLYPHS, cats: PHONE_GLYPH_CATS, css: PHONE_GLYPH_CSS };
const PAGE_CRYPTO = {
  sealer: phoneSealerSource(),
  noble: NOBLE_GCM_JS,
  hash: (js) => crypto.createHash('sha256').update(js, 'utf8').digest('base64'),
};
const OPEN = nodeOpen(crypto);

// ── Hot reload in development ──────────────────────────────────────────────
// Under `npm start` the page is NOT the copy bundled into main (a main-process
// change needs a restart): src/lib/phoneUploadPage.js is read from disk on every
// request and evaluated fresh, so an edit shows on the next load — and the page
// itself asks `/dev` for the file's mtime every second and reloads when it
// changes (never mid-upload). Packaged builds use the bundled copy only.
// The module is plain string building with two `export`s, which are stripped;
// if the file can't be read or evaluated (a half-saved edit) the last good
// version is served and the error logged.
const DEV = !app?.isPackaged;
const PAGE_SRC = DEV ? path.join(app.getAppPath(), 'src', 'lib', 'phoneUploadPage.js') : null;
let devPage = { mtime: 0, fn: null };
function pageMtime() {
  try { return fs.statSync(PAGE_SRC).mtimeMs; } catch { return 0; }
}
function renderPage(cfg) {
  if (!DEV) return phoneUploadPage({ ...cfg, ...PAGE_CRYPTO, glyphs: GLYPHS });
  const mtime = pageMtime();
  if (mtime && mtime !== devPage.mtime) {
    try {
      const src = fs.readFileSync(PAGE_SRC, 'utf8')
        .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
        .replace(/^export\s+(function|const|let)\s/gm, '$1 ');
      // eslint-disable-next-line no-new-func
      const fn = new Function(`${src}\nreturn phoneUploadPage;`)();
      if (typeof fn === 'function') devPage = { mtime, fn };
    } catch (err) {
      console.warn('[phone-upload] page reload failed — serving the last good version:', err?.message || err);
      devPage = { mtime, fn: devPage.fn };
    }
  }
  return (devPage.fn || phoneUploadPage)({ ...cfg, ...PAGE_CRYPTO, glyphs: GLYPHS, dev: true });
}

const PORTS = [47810, 47811, 47812, 47813, 47814, 47815];
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{24,64}$/;
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
// The unencrypted upload route (the planned Apple Shortcut) — off; see handle().
const ALLOW_PLAIN_UPLOADS = false;
const PROGRESS_MS = 200;

const sessions = new Map();   // token → { dir, project, folder, expiresAt, sender, hold, owner, key }
const owners = new Map();     // token → owner — outlives the session, so a held file's owner is known after it ends
const COMPUTER = (() => { try { return os.hostname() || ''; } catch { return ''; } })();
const pending = new Map();    // id → { id, token, name, size, path, dir, at }
// What became of a waiting file (accept / reject), for the phone page to ask:
// id → { token, status }. The newest DECIDED_CAP only.
const decided = new Map();
const DECIDED_CAP = 2000;
function decide(p, status, final = '') {
  if (!p) return;
  decided.set(p.id, { token: p.token, status, final });
  if (decided.size > DECIDED_CAP) decided.delete(decided.keys().next().value);
}
const INCOMING = '.docvex-incoming';

// ── LIVE PHOTOS ──────────────────────────────────────────────────────────
// A picture's movement travels as a PARTNER: the phone page sends the video
// named `<picture stem>.live.<ext>` (and, on the Wi-Fi route, `partner=<the
// picture's held id>`) once the picture itself is up. It never becomes a
// waiting file of its own — it is kept beside the picture's held copy
// (`.docvex-incoming/<picture id>.live.<ext>`) and follows the picture's
// decision: accepted, it is written as `<the picture's final stem>.<ext>`
// (so the Doc Viewer pairs them); rejected, deleted. A partner whose picture
// was already ACCEPTED waits on its own under the picture's final stem; one
// whose picture has not arrived yet waits up to ORPHAN_MS for it and is then
// listed on its own. A `.livp` (iOS's ZIP of the pair) is unpacked on arrival
// into a picture with its partner.
const LIVE_EXT = /^(mov|mp4|m4v|webm)$/i;
const PICTURE_RE = /\.(heic|heif|hif|jpe?g|png)$/i;
const ORPHAN_MS = 90 * 1000;
const stemOfName = (n) => String(n || '').replace(/\.[^.]+$/, '');
const extOfName = (n) => ((/\.([a-z0-9]{1,5})$/i.exec(String(n || '')) || [])[1] || '').toLowerCase();
function partnerOf(name) {
  const m = /^(.*)\.live\.([a-z0-9]{2,5})$/i.exec(String(name || ''));
  return m && LIVE_EXT.test(m[2]) ? { stem: m[1], ext: m[2].toLowerCase() } : null;
}
const acceptedStems = new Map();   // `${dir}|${stem lower}` → the picture's final stem
const orphans = new Map();         // `${token}|${dir}|${stem lower}` → { path, ext, size, timer }
const stemKey = (dir, stem) => `${dir}|${String(stem).toLowerCase()}`;

async function attachLive(image, fromPath, ext, size) {
  const livePath = path.join(image.dir, INCOMING, `${image.id}.live.${ext}`);
  if (image.live?.path && image.live.path !== livePath) await fsp.rm(image.live.path, { force: true }).catch(() => {});
  await fsp.rename(fromPath, livePath);
  image.live = { path: livePath, ext, size };
  return image;
}
function announce(sender, token, msg) {
  if (sender && !sender.isDestroyed()) sender.send('phone-upload:event', { token, ...msg });
}
// A new held picture: a partner that came first is attached now.
async function claimOrphan(image, sender) {
  const key = `${image.token}|${stemKey(image.dir, stemOfName(image.name))}`;
  const o = orphans.get(key);
  if (!o) return;
  orphans.delete(key);
  clearTimeout(o.timer);
  try { await attachLive(image, o.path, o.ext, o.size); announce(sender, image.token, { type: 'live', id: image.id }); } catch { /* the movement is lost; the picture stands */ }
}
// Hold a file as waiting — a new pending entry — and announce it.
async function holdPlain({ token, dir, name, fromPath, size, sender, cloudRow = null }) {
  const id = crypto.randomBytes(6).toString('hex');
  const held = path.join(dir, INCOMING, `${id}__${name}`);
  await fsp.rename(fromPath, held);
  const entry = { id, token, name, size, path: held, dir, at: Date.now(), cloudRow };
  pending.set(id, entry);
  announce(sender, token, { type: 'held', ...entry, received: size });
  if (PICTURE_RE.test(name)) await claimOrphan(entry, sender);
  return entry;
}
// A partner video that has arrived (at `fromPath`, already in the hold folder).
async function holdPartner({ token, dir, stem, ext, fromPath, size, sender, partnerId = '' }) {
  let image = partnerId ? pending.get(partnerId) : null;
  if (image && image.token !== token) image = null;
  if (!image) {
    const want = String(stem).toLowerCase();
    image = [...pending.values()].reverse().find((p) => p.token === token && p.dir === dir && PICTURE_RE.test(p.name) && stemOfName(p.name).toLowerCase() === want) || null;
  }
  if (image) {
    await attachLive(image, fromPath, ext, size);
    announce(sender, token, { type: 'live', id: image.id });
    return { ok: true, id: image.id, partner: true };
  }
  const d = partnerId ? decided.get(partnerId) : null;
  if (d && d.token === token && d.status === 'rejected') {
    await fsp.rm(fromPath, { force: true }).catch(() => {});
    return { ok: false, error: 'rejected' };
  }
  const finalStem = (d && d.final ? stemOfName(d.final) : null) || acceptedStems.get(stemKey(dir, stem));
  if (finalStem) {
    // The picture is in the project already: the movement waits on its own,
    // named to pair with it.
    const e = await holdPlain({ token, dir, name: `${finalStem}.${ext}`, fromPath, size, sender });
    return { ok: true, id: e.id, held: true };
  }
  // The picture has not arrived yet (the cloud route can deliver out of order).
  const key = `${token}|${stemKey(dir, stem)}`;
  const prev = orphans.get(key);
  if (prev) { clearTimeout(prev.timer); await fsp.rm(prev.path, { force: true }).catch(() => {}); }
  const o = { path: fromPath, ext, size, timer: null };
  o.timer = setTimeout(() => {
    if (orphans.get(key) !== o) return;
    orphans.delete(key);
    holdPlain({ token, dir, name: `${stem}.${ext}`, fromPath: o.path, size, sender }).catch(() => {});
  }, ORPHAN_MS);
  orphans.set(key, o);
  return { ok: true, id: null, partner: true, waiting: true };
}
// A `.livp`: the picture held as a waiting file, its video as its partner.
async function holdLivp({ token, dir, name, fromPath, size, sender, cloudRow = null }) {
  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await fsp.readFile(fromPath));
    let img = null; let vid = null;
    for (const f of Object.values(zip.files)) {
      if (f.dir) continue;
      if (!img && PICTURE_RE.test(f.name)) img = f;
      else if (!vid && LIVE_EXT.test(extOfName(f.name))) vid = f;
    }
    if (!img) throw new Error('no_picture');
    const stem = stemOfName(name) || 'Live Photo';
    const holdDir = path.join(dir, INCOMING);
    const tmpImg = path.join(holdDir, `.docvex-livp-${crypto.randomBytes(4).toString('hex')}`);
    const imgBuf = await img.async('nodebuffer');
    await fsp.writeFile(tmpImg, imgBuf);
    await fsp.rm(fromPath, { force: true }).catch(() => {});
    const entry = await holdPlain({ token, dir, name: `${stem}.${extOfName(img.name)}`, fromPath: tmpImg, size: imgBuf.length, sender, cloudRow });
    if (vid) {
      const tmpVid = path.join(holdDir, `.docvex-livp-${crypto.randomBytes(4).toString('hex')}`);
      const vidBuf = await vid.async('nodebuffer');
      await fsp.writeFile(tmpVid, vidBuf);
      await attachLive(entry, tmpVid, extOfName(vid.name), vidBuf.length);
      announce(sender, token, { type: 'live', id: entry.id });
    }
    return entry;
  } catch {
    // Not a readable .livp: it waits as the file it is.
    return holdPlain({ token, dir, name, fromPath, size, sender, cloudRow });
  }
}
// Route one arrived file (already on disk at `fromPath`, inside the hold folder).
async function holdArrived({ token, dir, name, fromPath, size, sender, cloudRow = null, partnerId = '' }) {
  const partner = partnerOf(name);
  if (partner) return holdPartner({ token, dir, stem: partner.stem, ext: partner.ext, fromPath, size, sender, partnerId });
  if (/\.livp$/i.test(name)) {
    const e = await holdLivp({ token, dir, name, fromPath, size, sender, cloudRow });
    return { ok: true, id: e.id, held: true, name: e.name, path: e.path, size: e.size };
  }
  const e = await holdPlain({ token, dir, name, fromPath, size, sender, cloudRow });
  return { ok: true, id: e.id, held: true, name: e.name, path: e.path, size: e.size };
}
let server = null;
let port = 0;

// Every IPv4 address this machine has on a real network, the likeliest first:
// private ranges (192.168 → 10 → 172.16–31), then anything else that isn't
// loopback or link-local (169.254). Virtual adapters (Hyper-V, VirtualBox,
// VPNs) are pushed to the end by name, since a phone can't reach them.
function lanAddresses() {
  const out = [];
  const virtual = /vethernet|virtualbox|vmware|hyper-v|docker|wsl|tailscale|zerotier|vpn|loopback|utun|tap|tun/i;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      const ip = a.address;
      let rank = 3;
      if (ip.startsWith('192.168.')) rank = 0;
      else if (ip.startsWith('10.')) rank = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) rank = 2;
      if (virtual.test(name)) rank += 10;
      out.push({ ip, rank, name });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((a) => a.ip);
}

function sameToken(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function findSession(token) {
  for (const [t, s] of sessions) if (sameToken(t, token)) return { token: t, s };
  return null;
}

function cleanName(raw) {
  let n = String(raw || '').split(/[\\/]/).pop() || '';
  n = n.replace(/[:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 200);
  return n || `upload-${Date.now()}`;
}
async function freeName(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i += 1) {
    const candidate = i === 1 ? name : `${base} (${i})${ext}`;
    try { await fsp.access(path.join(dir, candidate)); } catch { return candidate; }
  }
  return `${base} (${Date.now()})${ext}`;
}

function send(s, token, msg) {
  if (s?.sender && !s.sender.isDestroyed()) s.sender.send('phone-upload:event', { token, ...msg });
}
function reply(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function receive(req, res, token, s, rawName, partnerId = '') {
  const size = Number(req.headers['content-length']) || 0;
  if (size > MAX_BYTES) { req.resume(); return reply(res, 413, { ok: false, error: 'too_large', maxBytes: MAX_BYTES }); }
  s.expiresAt = Date.now() + SESSION_MS;
  const id = crypto.randomBytes(6).toString('hex');
  const name = cleanName(rawName);
  const hold = !!s.hold;
  const holdDir = path.join(s.dir, INCOMING);
  if (hold) { try { await fsp.mkdir(holdDir, { recursive: true }); } catch { /* the write below reports it */ } }
  const part = path.join(hold ? holdDir : s.dir, `.docvex-upload-${id}.part`);
  // A Live Photo's movement is not a file of its own to the window: no tile
  // is started for it (it joins its picture's).
  const quiet = !!partnerOf(name);
  const notify = (msg) => { if (!quiet) send(s, token, msg); };
  notify({ type: 'start', id, name, size, received: 0 });
  let received = 0;
  let last = 0;
  let failed = false;
  const out = fs.createWriteStream(part);
  const fail = async (error, status = 500) => {
    if (failed) return;
    failed = true;
    out.destroy();
    await fsp.rm(part, { force: true }).catch(() => {});
    notify({ type: 'error', id, name, size, received, error });
    if (!res.headersSent) reply(res, status, { ok: false, error });
  };
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_BYTES) { req.destroy(); fail('too_large', 413); return; }
    const now = Date.now();
    if (now - last > PROGRESS_MS) { last = now; notify({ type: 'progress', id, name, size, received }); }
  });
  req.on('aborted', () => fail('connection_lost', 499));
  out.on('error', (e) => fail(e?.message || 'write_failed'));
  req.pipe(out);
  out.on('finish', async () => {
    if (failed) return;
    try {
      if (hold) {
        const r = await holdArrived({ token, dir: s.dir, name, fromPath: part, size: received, sender: s.sender, partnerId });
        reply(res, r.ok ? 200 : 409, r.ok ? { ...r, size: received } : r);
        return;
      }
      // Not held (an older session): a partner is written beside its
      // picture under the picture's stem.
      const partner = partnerOf(name);
      const final = await freeName(s.dir, partner ? `${partner.stem}.${partner.ext}` : name);
      const dest = path.join(s.dir, final);
      await fsp.rename(part, dest);
      send(s, token, { type: 'done', id, name: final, size: received, received, path: dest });
      reply(res, 200, { ok: true, name: final, size: received });
    } catch (e) {
      fail(e?.message || 'write_failed');
    }
  });
}

// ── SEALED uploads (the page's own route) ────────────────────────────────
// The page seals every file with the address's key (lib/phoneUploadCrypto —
// the key travels only in the QR code's fragment) and sends it a piece at a
// time: POST /api/up?u=<file id>&o=<offset>&end=<0|1>[&partner=], each body
// the next bytes of the sealed file (~one 4 MB chunk). Each piece is OPENED as
// it arrives — every tag checked — and only plaintext that passed is written
// to the hidden .part; anything that fails to open (tampered, wrong key, cut
// short, pieces out of order) deletes the .part and is refused. The name and
// type come out of the sealed header.
const PIECE_MAX = 16 * 1024 * 1024 + 70 * 1024;   // the largest chunk + the header
const UPLOAD_IDLE_MS = 10 * 60 * 1000;
const UPLOADS_PER_ADDRESS = 8;
const uploads = new Map();   // `${token}|${file id}` → state
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0; let over = false;
    req.on('data', (c) => { if (over) return; n += c.length; if (n > max) { over = true; parts.length = 0; req.resume(); } else parts.push(c); });
    req.on('end', () => (over ? reject(Object.assign(new Error('too_large'), { status: 413 })) : resolve(Buffer.concat(parts, n))));
    req.on('aborted', () => reject(Object.assign(new Error('connection_lost'), { status: 499 })));
    req.on('error', reject);
  });
}
function writeAll(out, bufs) {
  return new Promise((resolve, reject) => {
    const next = (i) => {
      if (i >= bufs.length) return resolve();
      const ok = out.write(bufs[i], (err) => { if (err) reject(err); });
      if (ok) next(i + 1); else out.once('drain', () => next(i + 1));
    };
    next(0);
  });
}
async function dropUpload(st, error, notifyIt = true) {
  if (st.gone) return;
  st.gone = true;
  clearTimeout(st.timer);
  uploads.delete(st.key);
  try { st.out.destroy(); } catch { /* closed */ }
  await fsp.rm(st.part, { force: true }).catch(() => {});
  if (notifyIt && st.announced && !st.quiet) send(st.s, st.token, { type: 'error', id: st.id, name: st.name, size: st.size, received: st.received, error });
}
async function receiveSealed(req, res, token, s, url) {
  const u = String(url.searchParams.get('u') || '');
  const offset = Number(url.searchParams.get('o'));
  const end = url.searchParams.get('end') === '1';
  if (!/^[a-f0-9]{32}$/.test(u) || !Number.isSafeInteger(offset) || offset < 0) { req.resume(); return reply(res, 400, { ok: false, error: 'bad_request' }); }
  if (!s.key) { req.resume(); return reply(res, 409, { ok: false, error: 'no_key' }); }
  const key = `${token}|${u}`;
  let st = uploads.get(key);
  if (!st) {
    if (offset !== 0) { req.resume(); return reply(res, 409, { ok: false, error: 'unknown_upload' }); }
    if ([...uploads.values()].filter((x) => x.token === token).length >= UPLOADS_PER_ADDRESS) { req.resume(); return reply(res, 429, { ok: false, error: 'too_many' }); }
    const id = crypto.randomBytes(6).toString('hex');
    const hold = !!s.hold;
    const holdDir = path.join(s.dir, INCOMING);
    if (hold) { try { await fsp.mkdir(holdDir, { recursive: true }); } catch { /* the write reports it */ } }
    const part = path.join(hold ? holdDir : s.dir, `.docvex-upload-${id}.part`);
    st = {
      key, token, s, id, hold, part, offset: 0, received: 0, size: 0, name: '', quiet: false, announced: false, busy: false, gone: false,
      unsealer: createUnsealer({ key: s.key, ctx: token, open: OPEN, maxBytes: MAX_BYTES }),
      out: fs.createWriteStream(part), last: 0, timer: null,
    };
    st.out.on('error', () => { dropUpload(st, 'write_failed'); });
    uploads.set(key, st);
  } else if (st.busy) {
    req.resume(); return reply(res, 409, { ok: false, error: 'busy' });
  } else if (offset !== st.offset) {
    req.resume(); return reply(res, 409, { ok: false, error: 'bad_offset', offset: st.offset });
  }
  st.busy = true;
  clearTimeout(st.timer);
  st.timer = setTimeout(() => { dropUpload(st, 'timed_out'); }, UPLOAD_IDLE_MS);
  s.expiresAt = Date.now() + SESSION_MS;
  let body;
  try { body = await readBody(req, PIECE_MAX); } catch (e) {
    st.busy = false;
    if (e?.status === 413) await dropUpload(st, 'too_large');
    // A dropped connection: the piece can be sent again at the same offset.
    return reply(res, e?.status || 500, { ok: false, error: e?.message || 'failed' });
  }
  try {
    const plain = await st.unsealer.push(body);
    if (!st.announced && st.unsealer.header) {
      const h = st.unsealer.header;
      st.name = cleanName(h.name);
      st.size = h.size;
      st.quiet = !!partnerOf(st.name);
      st.announced = true;
      if (!st.quiet) send(s, token, { type: 'start', id: st.id, name: st.name, size: st.size, received: 0 });
    }
    if (plain.length) await writeAll(st.out, plain);
    st.offset += body.length;
    st.received += plain.reduce((n, p) => n + p.length, 0);
    const now = Date.now();
    if (!st.quiet && now - st.last > PROGRESS_MS) { st.last = now; send(s, token, { type: 'progress', id: st.id, name: st.name, size: st.size, received: st.received }); }
    if (!end) { st.busy = false; return reply(res, 200, { ok: true, offset: st.offset }); }
    await st.unsealer.end();
  } catch (e) {
    // Did not open: tampered, the wrong key or address, cut short. Nothing of
    // it is kept.
    await dropUpload(st, 'not_decrypted');
    return reply(res, 400, { ok: false, error: e?.code === 'too_large' ? 'too_large' : 'not_decrypted' });
  }
  clearTimeout(st.timer);
  uploads.delete(key);
  st.gone = true;
  await new Promise((resolve) => st.out.end(resolve));
  const partnerId = String(url.searchParams.get('partner') || '').slice(0, 24);
  try {
    if (st.hold) {
      const r = await holdArrived({ token, dir: s.dir, name: st.name, fromPath: st.part, size: st.received, sender: s.sender, partnerId });
      return reply(res, r.ok ? 200 : 409, r.ok ? { ...r, size: st.received } : r);
    }
    const partner = partnerOf(st.name);
    const final = await freeName(s.dir, partner ? `${partner.stem}.${partner.ext}` : st.name);
    const dest = path.join(s.dir, final);
    await fsp.rename(st.part, dest);
    send(s, token, { type: 'done', id: st.id, name: final, size: st.received, received: st.received, path: dest });
    return reply(res, 200, { ok: true, name: final, size: st.received });
  } catch (e) {
    await fsp.rm(st.part, { force: true }).catch(() => {});
    if (!st.quiet) send(s, token, { type: 'error', id: st.id, name: st.name, size: st.size, received: st.received, error: e?.message || 'write_failed' });
    return reply(res, 500, { ok: false, error: e?.message || 'write_failed' });
  }
}

// Routes:
//   GET  /p                      the page (no token in the path — the QR code's
//                                address is /p#t=<token>&k=<key>, and a fragment
//                                never crosses the network)
//   *    /api/<sub>              the page's requests; the token in the
//                                `x-docvex-token` header
//   *    /u/<token>[/<sub>]      the older form, token in the path (kept: saved
//                                addresses, and the Shortcut, which cannot
//                                encrypt and posts plain files to /u/<token>/file)
function handle(req, res) {
  const url = new URL(req.url || '/', 'http://x');
  if (req.method === 'GET' && (url.pathname === '/p' || url.pathname === '/p/')) {
    return reply(res, 200, renderPage({ mode: 'local' }), 'text/html; charset=utf-8');
  }
  let tok = ''; let sub = '';
  const m = /^\/u\/([A-Za-z0-9_-]{16,64})(\/[a-z]*)?$/.exec(url.pathname);
  if (m) { tok = m[1]; sub = m[2] || ''; } else {
    const a = /^\/api(\/[a-z]+)$/.exec(url.pathname);
    if (a) { tok = String(req.headers['x-docvex-token'] || ''); sub = a[1]; }
  }
  const found = tok && /^[A-Za-z0-9_-]{16,64}$/.test(tok) ? findSession(tok) : null;
  if (!found) { req.resume(); return reply(res, 404, 'Not found', 'text/plain; charset=utf-8'); }
  const { token, s } = found;
  const live = Date.now() < s.expiresAt;
  if (req.method === 'GET' && m && (sub === '' || sub === '/')) {
    // An older saved address: the page, which asks for the key the QR code
    // carries (it has none here) — the project is not named on it.
    return reply(res, 200, renderPage({ mode: 'local' }), 'text/html; charset=utf-8');
  }
  // What became of the files this phone sent (the page's rejected / added marks).
  if (req.method === 'GET' && sub === '/status') {
    const status = {};
    for (const id of String(url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 200)) {
      const p = pending.get(id);
      const d = decided.get(id);
      status[id] = p && p.token === token ? 'waiting' : d && d.token === token ? d.status : 'unknown';
    }
    return reply(res, 200, { ok: true, status });
  }
  if (DEV && req.method === 'GET' && sub === '/dev') {
    return reply(res, 200, { v: pageMtime() });
  }
  if (req.method === 'GET' && sub === '/info') {
    if (!live) return reply(res, 410, { ok: false, error: 'expired' });
    return reply(res, 200, { ok: true, projectName: s.project, folder: s.folder, computer: COMPUTER, maxBytes: MAX_BYTES, expiresAt: s.expiresAt });
  }
  // The phone takes back a file still waiting for approval (its × on the
  // page): only one THIS session sent, and only while it waits — once it is
  // accepted it is a project file and not the phone's to delete.
  if (req.method === 'POST' && sub === '/withdraw') {
    const id = url.searchParams.get('id') || '';
    const p = pending.get(id);
    if (!p || p.token !== token) {
      return reply(res, 409, { ok: false, error: 'not_waiting' });
    }
    if (p.live?.path) fsp.rm(p.live.path, { force: true }).catch(() => {});
    fsp.rm(p.path, { force: true }).catch(() => {}).then(async () => {
      pending.delete(id);
      await fsp.rmdir(path.join(p.dir, INCOMING)).catch(() => {});
      send(s, token, { type: 'withdrawn', id, name: p.name });
      reply(res, 200, { ok: true });
    });
    return undefined;
  }
  if (req.method === 'POST' && sub === '/up') {
    if (!live) { req.resume(); return reply(res, 410, { ok: false, error: 'expired' }); }
    receiveSealed(req, res, token, s, url).catch((e) => { if (!res.headersSent) reply(res, 500, { ok: false, error: e?.message || 'failed' }); });
    return undefined;
  }
  // Plain (unencrypted) — for the Shortcut only; the page always seals. OFF
  // (security audit 2026-10-01): the file would cross the network in clear.
  // The Shortcut is not built yet; when it is, it must seal like the page.
  if (req.method === 'POST' && sub === '/file' && !ALLOW_PLAIN_UPLOADS) {
    req.resume();
    return reply(res, 410, { ok: false, error: 'sealed_only' });
  }
  if (req.method === 'POST' && sub === '/file') {
    if (!live) { req.resume(); return reply(res, 410, { ok: false, error: 'expired' }); }
    return receive(req, res, token, s, url.searchParams.get('name'), String(url.searchParams.get('partner') || '').slice(0, 24));
  }
  return reply(res, 404, 'Not found', 'text/plain; charset=utf-8');
}

// ── Windows Firewall ─────────────────────────────────────────────────────
const FW_RULE = 'DocVex phone upload';
function ps(command, timeout = 20000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || '').trim() });
    });
  });
}
// Is there an enabled inbound ALLOW rule that covers us — ours (by name), or
// one for this executable (the rule Windows' own prompt makes)? null = can't tell.
async function firewallAllows() {
  const exe = process.execPath.replace(/'/g, "''");
  const res = await ps(
    `$n = @(Get-NetFirewallRule -DisplayName '${FW_RULE}' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }).Count;`
    + ` $p = @(Get-NetFirewallApplicationFilter -Program '${exe}' -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }).Count;`
    + ' $n + $p',
  );
  if (!res.ok) return null;
  return Number(res.out) > 0;
}

// `prefer`: the port the kept link was made on — tried first, so a phone's
// saved address reaches this instance again after a restart.
function listen(prefer) {
  if (server) return Promise.resolve(port);
  const order = prefer && !PORTS.includes(prefer) ? [prefer, ...PORTS] : prefer ? [prefer, ...PORTS.filter((p) => p !== prefer)] : PORTS;
  return new Promise((resolve, reject) => {
    const tryAt = (i) => {
      const srv = http.createServer(handle);
      srv.requestTimeout = 0;   // a 2 GB video over Wi-Fi takes a while
      srv.headersTimeout = 30000;
      // …but a connection that SENDS nothing for two minutes is dropped, and
      // only so many are held open at once (a slow-body flood from the
      // network otherwise ties the server up — security audit 2026-10-01).
      srv.timeout = 120000;
      srv.maxConnections = 32;
      srv.once('error', (err) => {
        if (err?.code === 'EADDRINUSE' && i + 1 < order.length + 1) tryAt(i + 1);
        else reject(err);
      });
      // The last attempt takes any free port.
      srv.listen(i < order.length ? order[i] : 0, '0.0.0.0', () => {
        server = srv;
        port = srv.address().port;
        resolve(port);
      });
    };
    tryAt(0);
  });
}
function closeIfIdle() {
  const now = Date.now();
  for (const [t, s] of sessions) if (now >= s.expiresAt + 60000 || s.sender?.isDestroyed?.()) sessions.delete(t);
  if (!sessions.size && server) { server.close(); server = null; port = 0; }
}

// A cloud download handed to hold-file: the bucket's own cap per object.
const HOLD_FILE_MAX = 50 * 1024 * 1024;

export function registerPhoneUpload({ ipcMain, guardDir = () => null }) {
  ipcMain.handle('phone-upload:start', async (e, payload) => {
    const dir = payload?.dir;
    if (!dir) return { ok: false, error: 'no_folder' };
    // Files from the phone are written here: never a protected location
    // (main.js protectedPathReason).
    if (guardDir(dir)) return { ok: false, error: 'no_folder' };
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) return { ok: false, error: 'no_folder' };
    } catch { return { ok: false, error: 'no_folder' }; }
    const ips = lanAddresses();
    if (!ips.length) return { ok: false, error: 'no_network' };
    const prefer = Number(payload?.port) > 1023 && Number(payload?.port) < 65536 ? Number(payload.port) : 0;
    try { await listen(prefer); } catch (err) { return { ok: false, error: err?.code || 'listen_failed' }; }
    // A kept token goes on being used — the same address as before; the
    // session (new after a restart) takes the folder being shown now.
    const kept = TOKEN_RE.test(String(payload?.token || '')) ? String(payload.token) : null;
    const token = (kept && findSession(kept)?.token) || kept || crypto.randomBytes(18).toString('base64url');
    const expiresAt = Date.now() + SESSION_MS;
    // The address's file key (the QR code's fragment): the kept one, else the
    // running session's, else a new one — a new address always has a new key.
    const key = isSealKey(payload?.key) && kept ? String(payload.key)
      : (kept && findSession(kept)?.s?.key) || crypto.randomBytes(32).toString('base64url');
    sessions.set(token, {
      dir, project: String(payload?.project || ''), folder: String(payload?.folder || ''), expiresAt, sender: e.sender,
      hold: !!payload?.hold, owner: String(payload?.owner || ''), key,
    });
    owners.set(token, String(payload?.owner || ''));
    // Files still waiting from before (a restart) are waiting again.
    try {
      const names = await fsp.readdir(path.join(dir, INCOMING));
      for (const f of names) {
        const m = /^([a-f0-9]{12})__(.+)$/.exec(f);
        if (!m || pending.has(m[1])) continue;
        const full = path.join(dir, INCOMING, f);
        const st = await fsp.stat(full);
        pending.set(m[1], { id: m[1], token, name: m[2], size: st.size, path: full, dir, at: st.mtimeMs });
      }
      // A picture's kept movement (`<id>.live.<ext>`) goes back onto it.
      for (const f of names) {
        const m = /^([a-f0-9]{12})\.live\.([a-z0-9]{2,5})$/i.exec(f);
        const image = m && pending.get(m[1]);
        if (!image) continue;
        const full = path.join(dir, INCOMING, f);
        const st = await fsp.stat(full).catch(() => null);
        if (st) image.live = { path: full, ext: m[2].toLowerCase(), size: st.size };
      }
    } catch { /* nothing waiting */ }
    return { ok: true, token, key, port, computer: COMPUTER, expiresAt, urls: ips.map((ip) => `http://${ip}:${port}/p#t=${token}&k=${key}`) };
  });
  ipcMain.handle('phone-upload:hold', (_e, payload) => {
    const f = payload?.token ? findSession(payload.token) : null;
    if (f) f.s.hold = !!payload.hold;
    return { ok: !!f };
  });
  // Only the asking account's waiting files (a file whose owner is unknown —
  // no session has claimed its folder yet — is nobody's until one does).
  ipcMain.handle('phone-upload:pending', (_e, payload) => {
    const owner = String(payload?.owner || '');
    return [...pending.values()].filter((p) => (owners.get(p.token) ?? null) === owner);
  });
  // A file the cloud route downloaded (lib/phoneUploadCloud): it WAITS like a
  // Wi-Fi one — written into `<dir>/.docvex-incoming`, listed as pending, and
  // announced to the window that asked.
  ipcMain.handle('phone-upload:hold-file', async (e, payload) => {
    const dir = payload?.dir;
    if (!dir) return { ok: false, error: 'no_folder' };
    // The same folder rules as a session's (main.js protectedPathReason + the
    // write allow-list), and the cloud route's own size cap.
    if (guardDir(dir)) return { ok: false, error: 'no_folder' };
    if (((payload?.data?.byteLength ?? payload?.data?.length) || 0) > HOLD_FILE_MAX) return { ok: false, error: 'too_large' };
    const owner = String(payload?.owner || '');
    const token = `cloud-${owner || '_'}`;
    owners.set(token, owner);
    const name = cleanName(payload?.name);
    try {
      const holdDir = path.join(dir, INCOMING);
      await fsp.mkdir(holdDir, { recursive: true });
      const tmp = path.join(holdDir, `.docvex-upload-${crypto.randomBytes(6).toString('hex')}.part`);
      const size = (payload?.data?.byteLength ?? payload?.data?.length) || 0;
      await fsp.writeFile(tmp, Buffer.from(payload?.data || []));
      const r = await holdArrived({ token, dir, name, fromPath: tmp, size, sender: e.sender, cloudRow: payload?.cloudRow ? String(payload.cloudRow) : null });
      if (!r.ok) return r;
      if (r.partner) return { ok: true, partner: true, id: r.id };
      return { ok: true, ...pending.get(r.id) };
    } catch (err) {
      return { ok: false, error: err?.message || 'write_failed' };
    }
  });
  // A change of account: every session that isn't the new owner's ends now.
  ipcMain.handle('phone-upload:firewall', async (_e, payload) => {
    if (process.platform !== 'win32') return { ok: true, platform: process.platform, allowed: true };
    if (payload?.allow) {
      const inner = `New-NetFirewallRule -DisplayName '${FW_RULE}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORTS[0]}-${PORTS[PORTS.length - 1]} -Profile Any | Out-Null`;
      // Elevated: Windows shows its approval prompt; declining makes Start-Process throw.
      const outer = `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',"${inner}"`;
      const res = await ps(outer, 120000);
      if (!res.ok) return { ok: false, platform: 'win32', allowed: false, error: 'declined' };
    }
    return { ok: true, platform: 'win32', allowed: await firewallAllows() };
  });
  ipcMain.handle('phone-upload:release', (_e, payload) => {
    const owner = String(payload?.owner || '');
    for (const [t, s] of sessions) if (s.owner !== owner) sessions.delete(t);
    closeIfIdle();
    return { ok: true };
  });
  ipcMain.handle('phone-upload:accept', async (_e, id) => {
    const p = pending.get(id);
    if (!p) return { ok: false, error: 'gone' };
    // The folder it is going into is checked again at the moment it lands.
    if (guardDir(p.dir)) return { ok: false, error: 'no_folder' };
    try {
      const final = await freeName(p.dir, p.name);
      const dest = path.join(p.dir, final);
      await fsp.rename(p.path, dest);
      pending.delete(id);
      decide(p, 'accepted', final);
      acceptedStems.set(stemKey(p.dir, stemOfName(p.name)), stemOfName(final));
      if (acceptedStems.size > DECIDED_CAP) acceptedStems.delete(acceptedStems.keys().next().value);
      // A Live Photo: its movement goes in beside it, under the same stem.
      if (p.live?.path) {
        const liveName = await freeName(p.dir, `${stemOfName(final)}.${p.live.ext}`);
        await fsp.rename(p.live.path, path.join(p.dir, liveName)).catch(() => {});
      }
      await fsp.rmdir(path.join(p.dir, INCOMING)).catch(() => {});   // only when empty
      return { ok: true, name: final, path: dest };
    } catch (err) {
      return { ok: false, error: err?.message || 'move_failed' };
    }
  });
  ipcMain.handle('phone-upload:reject', async (_e, id) => {
    const p = pending.get(id);
    if (!p) return { ok: true };
    await fsp.rm(p.path, { force: true }).catch(() => {});
    if (p.live?.path) await fsp.rm(p.live.path, { force: true }).catch(() => {});
    pending.delete(id);
    decide(p, 'rejected');
    await fsp.rmdir(path.join(p.dir, INCOMING)).catch(() => {});
    return { ok: true };
  });
  ipcMain.handle('phone-upload:stop', (_e, token) => {
    const f = token ? findSession(token) : null;
    if (f) sessions.delete(f.token);
    if (f) for (const st of [...uploads.values()]) if (st.token === f.token) dropUpload(st, 'closed');
    closeIfIdle();
    return { ok: true };
  });
}
