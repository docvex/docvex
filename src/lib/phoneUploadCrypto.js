// END-TO-END ENCRYPTION of the files a phone sends through the Files tab's
// Import (both routes: the local network and the DocVex cloud).
//
// The desktop makes a random 256-bit KEY per upload address and puts it in the
// QR code's URL FRAGMENT (`…#k=<base64url>`) — a fragment is never sent to any
// server (not docvex.ro, not Supabase, not the office network). The phone page
// reads it, takes it out of the address bar, and seals EVERY file before it
// leaves the phone; the desktop opens it, checking every tag, before the file
// ever reaches the waiting list. Anything that does not open is deleted.
//
// THE SEALED FILE (one format for both routes):
//
//   0   "DVXP"                 magic (4)
//   4   1                      version (1)
//   5   file id                16 random bytes (in the clear; bound into every AAD)
//   21  nonce prefix           8 random bytes
//   29  header length          uint32 BE — the sealed header's length, tag included
//   33  sealed header          AES-256-GCM of JSON { n: name, t: mime, s: size, c: chunk size }
//   …   sealed chunks          the file in `c`-byte pieces (the last shorter; an
//                              empty file is ONE empty chunk), each + a 16-byte tag
//
//   nonce(i) = prefix ‖ uint32 BE i        i = 0 for the header, 1…n for the chunks
//   AAD(i)   = "DVXP1|<ctx>|<file id hex>|<i>|<last ? 1 : 0>"
//
// `ctx` is the upload address's token (both sides know it), so a sealed file
// cannot be replayed into another address. The header is authenticated, so the
// number of chunks is known; the LAST flag in the AAD makes a file cut short
// at a chunk boundary fail too (its new last chunk was sealed as not-last).
//
// Two halves:
//   - `phoneSealer` — the PHONE's half. Self-contained on purpose: the page
//     inlines its source (`phoneSealerSource()`), so it may not use anything
//     outside its own body. AES-GCM by WebCrypto where the page is a secure
//     context (the cloud page, https) and by @noble/ciphers where it is not
//     (the Wi-Fi page is plain http, where browsers switch WebCrypto off) —
//     the page bundles noble's `gcm` as `__dvxGcm` (phoneUploadCrypto.generated.js).
//   - `createUnsealer` — the DESKTOP's half, streaming: bytes in as they
//     arrive, plaintext out chunk by chunk, every tag checked. The AES-GCM
//     `open` is handed in: node:crypto in the main process (`nodeOpen` in
//     phoneUploadServer), WebCrypto in the renderer (`webOpen` below).

export const SEAL_MAGIC = 'DVXP';
export const SEAL_VERSION = 1;
export const SEAL_CHUNK = 4 * 1024 * 1024;
export const SEALED_MIME = 'application/x-docvex-sealed';
export const SEALED_NAME = 'encrypted';
const PREFIX_LEN = 33;
const TAG = 16;
const MAX_HEADER = 64 * 1024;

// ── Keys ────────────────────────────────────────────────────────────────
export function b64urlEncode(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
/** A fresh 256-bit key, base64url. */
export function newSealKey() {
  return b64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}
export function isSealKey(k) {
  return typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k);
}

// ── Shared arithmetic ────────────────────────────────────────────────────
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function sealNonce(prefix, index) {
  const n = new Uint8Array(12);
  n.set(prefix, 0);
  new DataView(n.buffer).setUint32(8, index >>> 0, false);
  return n;
}
export function sealAad(ctx, fileId, index, last) {
  return new TextEncoder().encode(`DVXP1|${ctx}|${hex(fileId)}|${index}|${last ? 1 : 0}`);
}
export const chunkCount = (size, chunk) => Math.max(1, Math.ceil(size / chunk));

// ── The desktop's half ───────────────────────────────────────────────────

/** WebCrypto AES-GCM open (the renderer). `subtle` defaults to the global one. */
export function webOpen(subtle = globalThis.crypto?.subtle) {
  const keys = new Map();
  return async (key, nonce, aad, sealed) => {
    const id = b64urlEncode(key);
    let k = keys.get(id);
    if (!k) { k = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']); keys.set(id, k); }
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, k, sealed));
  };
}

/** node:crypto AES-GCM open (the main process) — `c` is node:crypto, handed in
 *  so this module stays importable by the renderer. */
export function nodeOpen(c) {
  return async (key, nonce, aad, sealed) => {
    if (sealed.length < TAG) throw new Error('short');
    const d = c.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
    d.setAAD(aad);
    d.setAuthTag(sealed.subarray(sealed.length - TAG));
    const a = d.update(sealed.subarray(0, sealed.length - TAG));
    const b = d.final();
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  };
}

export class SealError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/**
 * A streaming opener for ONE sealed file.
 *   key       Uint8Array(32) or base64url
 *   ctx       the address's token (bound into every AAD)
 *   open      async (key, nonce, aad, sealedWithTag) → plaintext; throws on a bad tag
 *   maxBytes  the largest plaintext accepted
 * → { push(bytes) → Promise<Uint8Array[]>, end() → Promise<void>, header, fileId }
 * Every error is a SealError: bad_magic, bad_version, bad_header, too_large,
 * bad_tag (tampered, wrong key or wrong address), truncated, trailing.
 */
export function createUnsealer({ key, ctx, open, maxBytes = Infinity }) {
  const k = typeof key === 'string' ? b64urlDecode(key) : key;
  if (!k || k.length !== 32) throw new SealError('no_key');
  let pieces = [];
  let have = 0;
  let fileId = null; let prefix = null; let hdrLen = 0;
  let header = null;
  let index = 0; let n = 0; let done = false;
  let failed = null;

  const take = (len) => {
    const out = new Uint8Array(len);
    let at = 0;
    while (at < len) {
      const p = pieces[0];
      const need = len - at;
      if (p.length <= need) { out.set(p, at); at += p.length; pieces.shift(); }
      else { out.set(p.subarray(0, need), at); pieces[0] = p.subarray(need); at += need; }
    }
    have -= len;
    return out;
  };
  const tryOpen = async (i, last, sealed) => {
    try { return await open(k, sealNonce(prefix, i), sealAad(ctx, fileId, i, last), sealed); } catch { throw new SealError('bad_tag'); }
  };
  const fail = (e) => { failed = e instanceof SealError ? e : new SealError('bad_tag'); throw failed; };

  const api = {
    get header() { return header; },
    get fileId() { return fileId ? hex(fileId) : ''; },
    get done() { return done; },
    async push(bytes) {
      if (failed) throw failed;
      const out = [];
      if (!bytes || !bytes.length) return out;
      if (done) fail(new SealError('trailing'));
      pieces.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      have += bytes.length;
      try {
        for (;;) {
          if (!prefix) {
            if (have < PREFIX_LEN) break;
            const p = take(PREFIX_LEN);
            if (String.fromCharCode(p[0], p[1], p[2], p[3]) !== SEAL_MAGIC) throw new SealError('bad_magic');
            if (p[4] !== SEAL_VERSION) throw new SealError('bad_version');
            fileId = p.slice(5, 21); prefix = p.slice(21, 29);
            hdrLen = new DataView(p.buffer, p.byteOffset + 29, 4).getUint32(0, false);
            if (hdrLen < TAG + 2 || hdrLen > MAX_HEADER) throw new SealError('bad_header');
            continue;
          }
          if (!header) {
            if (have < hdrLen) break;
            const plain = await tryOpen(0, false, take(hdrLen));
            let h;
            try { h = JSON.parse(new TextDecoder().decode(plain)); } catch { throw new SealError('bad_header'); }
            const size = Number(h?.s); const c = Number(h?.c);
            if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(c) || c < 1024 || c > 16 * 1024 * 1024) throw new SealError('bad_header');
            if (size > maxBytes) throw new SealError('too_large');
            header = { name: String(h.n || ''), type: String(h.t || ''), size, chunk: c };
            n = chunkCount(size, c);
            continue;
          }
          if (done) { if (have) throw new SealError('trailing'); break; }
          const i = index + 1;
          const last = i === n;
          const plainLen = last ? header.size - (n - 1) * header.chunk : header.chunk;
          if (have < plainLen + TAG) break;
          const plain = await tryOpen(i, last, take(plainLen + TAG));
          if (plain.length !== plainLen) throw new SealError('bad_tag');
          index = i;
          if (plain.length) out.push(plain);
          if (last) done = true;
        }
      } catch (e) { fail(e); }
      return out;
    },
    async end() {
      if (failed) throw failed;
      if (!done) fail(new SealError('truncated'));
      if (have) fail(new SealError('trailing'));
    },
  };
  return api;
}

/** Open a whole sealed file held in memory → { name, type, size, data }. */
export async function unsealBytes(bytes, { key, ctx, open, maxBytes }) {
  const u = createUnsealer({ key, ctx, open, maxBytes });
  const parts = await u.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  await u.end();
  const data = new Uint8Array(u.header.size);
  let at = 0;
  for (const p of parts) { data.set(p, at); at += p.length; }
  return { ...u.header, data };
}

/** Does this look like a sealed file (the magic)? */
export function looksSealed(bytes) {
  return !!bytes && bytes.length >= PREFIX_LEN && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === SEAL_MAGIC;
}

// ── The phone's half ─────────────────────────────────────────────────────
// SELF-CONTAINED (the page inlines `String(phoneSealer)`): nothing from outside
// this function body may be used in it. `g` is the page's global object.
//
//   var S = phoneSealer(window);
//   var key = await S.importKey('<base64url>');
//   S.sealedSize(file, key)                → the sealed length (for `sign`)
//   await S.seal(key, ctx, file, async function (part, info) { … })
//        parts in order: the first carries the prefix, header and chunk 1;
//        each later one a chunk. info = { offset, last, plainDone }.
export function phoneSealer(g, opts) {
  var CHUNK = (opts && opts.chunk) || 4 * 1024 * 1024;
  var subtle = !(opts && opts.noble) && g.crypto && g.crypto.subtle && g.isSecureContext !== false ? g.crypto.subtle : null;
  var gcm = g.__dvxGcm || null;
  var enc = new TextEncoder();
  function b64d(str) {
    var s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    var bin = g.atob(s + '==='.slice((s.length + 3) % 4));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  function hexOf(b) { var s = ''; for (var i = 0; i < b.length; i += 1) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  function nonce(prefix, i) { var n = new Uint8Array(12); n.set(prefix, 0); new DataView(n.buffer).setUint32(8, i >>> 0, false); return n; }
  function aad(ctx, fileId, i, last) { return enc.encode('DVXP1|' + ctx + '|' + hexOf(fileId) + '|' + i + '|' + (last ? 1 : 0)); }
  function headerBytes(file) {
    return enc.encode(JSON.stringify({ n: String(file.name || 'file'), t: String(file.type || ''), s: file.size || 0, c: CHUNK }));
  }
  async function sealOne(key, n, a, pt) {
    if (key.web) return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: n, additionalData: a, tagLength: 128 }, key.web, pt));
    return gcm(key.raw, n, a).encrypt(pt);
  }
  return {
    available: !!(subtle || gcm),
    engine: subtle ? 'webcrypto' : gcm ? 'noble' : '',
    importKey: async function (b64) {
      var raw = b64d(b64);
      if (raw.length !== 32) throw new Error('bad_key');
      if (subtle) return { raw: raw, web: await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']) };
      if (!gcm) throw new Error('no_crypto');
      return { raw: raw, web: null };
    },
    sealedSize: function (file) {
      var size = file.size || 0;
      return 33 + headerBytes(file).length + 16 + size + 16 * Math.max(1, Math.ceil(size / CHUNK));
    },
    seal: async function (key, ctx, file, onPart) {
      var size = file.size || 0;
      var n = Math.max(1, Math.ceil(size / CHUNK));
      var fileId = g.crypto.getRandomValues(new Uint8Array(16));
      var prefix = g.crypto.getRandomValues(new Uint8Array(8));
      var hdr = await sealOne(key, nonce(prefix, 0), aad(ctx, fileId, 0, false), headerBytes(file));
      var head = new Uint8Array(33 + hdr.length);
      head.set([68, 86, 88, 80, 1], 0);   // "DVXP", v1
      head.set(fileId, 5);
      head.set(prefix, 21);
      new DataView(head.buffer).setUint32(29, hdr.length, false);
      head.set(hdr, 33);
      var offset = 0;
      for (var i = 1; i <= n; i += 1) {
        var from = (i - 1) * CHUNK;
        var to = Math.min(size, from + CHUNK);
        var slice = file.slice(from, to);
        var pt = new Uint8Array(slice.arrayBuffer ? await slice.arrayBuffer() : await new Response(slice).arrayBuffer());
        var ct = await sealOne(key, nonce(prefix, i), aad(ctx, fileId, i, i === n), pt);
        var part = ct;
        if (i === 1) { part = new Uint8Array(head.length + ct.length); part.set(head, 0); part.set(ct, head.length); }
        await onPart(part, { offset: offset, last: i === n, plainDone: to, fileId: hexOf(fileId) });
        offset += part.length;
      }
      return { fileId: hexOf(fileId), size: offset };
    },
  };
}

/** The phone half as source, for the page to inline. */
export function phoneSealerSource() {
  return String(phoneSealer);
}
