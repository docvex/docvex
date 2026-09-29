// End-to-end encryption of phone uploads (src/lib/phoneUploadCrypto), under
// plain Node:   npm test
// The PHONE side is sealed both ways the page can — WebCrypto (the cloud page,
// https) and @noble/ciphers (the Wi-Fi page, plain http, via the generated
// script string the page inlines) — and opened by the DESKTOP code (node:crypto
// as the main process does it, WebCrypto as the renderer does it).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import nodeCrypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let C; let NOBLE_GCM_JS; let phoneUploadPage;

before(async () => {
  const entry = path.join(os.tmpdir(), `docvex-pucrypto-entry-${process.pid}.js`);
  writeFileSync(entry, [
    `export * from ${JSON.stringify(path.join(root, 'src/lib/phoneUploadCrypto.js'))};`,
    `export { NOBLE_GCM_JS } from ${JSON.stringify(path.join(root, 'src/lib/phoneUploadCrypto.generated.js'))};`,
    `export { phoneUploadPage } from ${JSON.stringify(path.join(root, 'src/lib/phoneUploadPage.js'))};`,
  ].join('\n'));
  const out = path.join(os.tmpdir(), `docvex-pucrypto-${process.pid}.mjs`);
  await build({ entryPoints: [entry], outfile: out, format: 'esm', platform: 'node', bundle: true, logLevel: 'silent' });
  C = await import(pathToFileURL(out).href);
  ({ NOBLE_GCM_JS, phoneUploadPage } = C);
});

// The noble AES-GCM exactly as the Wi-Fi page gets it: the generated string,
// run against a stand-in window.
function nobleGcm() {
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function('window', NOBLE_GCM_JS)(win);
  assert.equal(typeof win.__dvxGcm, 'function');
  return win.__dvxGcm;
}
// The phone's sealer exactly as the page gets it: its source, evaluated alone.
function sealerFrom(g, opts) {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`return (${C.phoneSealerSource()});`)();
  return factory(g, opts);
}
const phoneGlobal = (extra = {}) => ({ crypto: globalThis.crypto, atob: globalThis.atob, isSecureContext: true, ...extra });

async function sealToBytes(sealer, key, ctx, file) {
  const k = await sealer.importKey(key);
  const parts = [];
  const offsets = [];
  await sealer.seal(k, ctx, file, async (part, info) => { offsets.push(info.offset); parts.push(part); });
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return { all, parts, offsets };
}
function randomBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) globalThis.crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
  return b;
}
// Feed the desktop's streaming opener in uneven pieces, as a socket would.
async function openStreaming(bytes, key, ctx, open, step = 70001) {
  const u = C.createUnsealer({ key, ctx, open });
  const out = [];
  for (let i = 0; i < bytes.length; i += step) out.push(...await u.push(bytes.subarray(i, i + step)));
  await u.end();
  const data = Buffer.concat(out.map((p) => Buffer.from(p)));
  return { header: u.header, data };
}

const CTX = 'tok_ABCDEFGHIJKLMNOPQRSTUV';
const CHUNK = 64 * 1024;   // small chunks so a test file spans several

for (const engine of ['webcrypto', 'noble']) {
  test(`${engine} on the phone → node:crypto and WebCrypto on the desktop, name and type round-trip`, async () => {
    const key = C.newSealKey();
    const g = phoneGlobal(engine === 'noble' ? { __dvxGcm: nobleGcm(), isSecureContext: false } : {});
    const sealer = sealerFrom(g, { chunk: CHUNK, noble: engine === 'noble' });
    assert.equal(sealer.engine, engine);
    const content = randomBytes(CHUNK * 3 + 1234);
    const file = new File([content], 'Buletin față (verso).jpg', { type: 'image/jpeg' });
    const { all, parts } = await sealToBytes(sealer, key, CTX, file);
    assert.equal(all.length, sealer.sealedSize(file), 'sealedSize matches');
    assert.equal(parts.length, 4, 'one part per chunk');
    assert.ok(C.looksSealed(all));
    // Nothing of the name travels in the clear.
    assert.equal(Buffer.from(all).indexOf(Buffer.from('Buletin')), -1);

    const viaNode = await openStreaming(all, key, CTX, C.nodeOpen(nodeCrypto));
    assert.deepEqual(viaNode.header, { name: 'Buletin față (verso).jpg', type: 'image/jpeg', size: content.length, chunk: CHUNK });
    assert.ok(Buffer.from(content).equals(viaNode.data));

    const viaWeb = await C.unsealBytes(all, { key, ctx: CTX, open: C.webOpen() });
    assert.equal(viaWeb.name, 'Buletin față (verso).jpg');
    assert.equal(viaWeb.type, 'image/jpeg');
    assert.ok(Buffer.from(content).equals(Buffer.from(viaWeb.data)));
  });
}

test('an empty file and an exact multiple of the chunk size', async () => {
  const key = C.newSealKey();
  const sealer = sealerFrom(phoneGlobal(), { chunk: CHUNK });
  for (const n of [0, CHUNK, CHUNK * 2]) {
    const content = randomBytes(n);
    const { all } = await sealToBytes(sealer, key, CTX, new File([content], 'x.bin'));
    const r = await openStreaming(all, key, CTX, C.nodeOpen(nodeCrypto), 999);
    assert.equal(r.data.length, n);
    assert.ok(Buffer.from(content).equals(r.data));
  }
});

async function expectFail(bytes, key, ctx, code) {
  await assert.rejects(openStreaming(bytes, key, ctx, C.nodeOpen(nodeCrypto)), (e) => e.code === code);
  await assert.rejects(C.unsealBytes(bytes, { key, ctx, open: C.webOpen() }), (e) => e.code === code);
}

test('a tampered chunk, header, wrong key or wrong address is refused', async () => {
  const key = C.newSealKey();
  const sealer = sealerFrom(phoneGlobal({ __dvxGcm: nobleGcm() }), { chunk: CHUNK, noble: true });
  const { all, offsets } = await sealToBytes(sealer, key, CTX, new File([randomBytes(CHUNK * 2 + 10)], 'contract.pdf', { type: 'application/pdf' }));
  const flip = (at) => { const b = all.slice(); b[at] ^= 1; return b; };
  await expectFail(flip(offsets[1] + 100), key, CTX, 'bad_tag');   // inside chunk 2
  await expectFail(flip(all.length - 1), key, CTX, 'bad_tag');     // the last tag
  await expectFail(flip(40), key, CTX, 'bad_tag');                 // the sealed header
  await expectFail(flip(10), key, CTX, 'bad_tag');                 // the file id (bound into the AAD)
  await expectFail(all, C.newSealKey(), CTX, 'bad_tag');
  await expectFail(all, key, 'another-address-token', 'bad_tag');
  const notSealed = new Uint8Array(100); notSealed.set([0x25, 0x50, 0x44, 0x46]);
  await expectFail(notSealed, key, CTX, 'bad_magic');
});

test('a file cut short is refused — at a chunk boundary too', async () => {
  const key = C.newSealKey();
  const sealer = sealerFrom(phoneGlobal(), { chunk: CHUNK });
  const { all, offsets } = await sealToBytes(sealer, key, CTX, new File([randomBytes(CHUNK * 3)], 'photo.heic'));
  await expectFail(all.subarray(0, offsets[2]), key, CTX, 'truncated');   // the last chunk missing
  await expectFail(all.subarray(0, all.length - 5), key, CTX, 'truncated');
  // Chunks 2 and 3 swapped (same length): each sits under the other's nonce.
  assert.equal(offsets.length, 3);
  assert.equal(offsets[2] - offsets[1], all.length - offsets[2]);
  const swapped = new Uint8Array(all.length);
  swapped.set(all.subarray(0, offsets[1]), 0);
  swapped.set(all.subarray(offsets[2]), offsets[1]);
  swapped.set(all.subarray(offsets[1], offsets[2]), offsets[2]);
  await expectFail(swapped, key, CTX, 'bad_tag');
  // Anything after the last chunk.
  const longer = new Uint8Array(all.length + 3); longer.set(all, 0);
  await expectFail(longer, key, CTX, 'trailing');
});

test('the pages carry the crypto they need, and a strict CSP on the cloud page', () => {
  const local = phoneUploadPage({ mode: 'local', sealer: C.phoneSealerSource(), noble: NOBLE_GCM_JS });
  assert.ok(local.includes('__dvxGcm'));
  assert.ok(local.includes('DVXP1|'));
  assert.match(local, /connect-src 'self'/);
  // Every inline script of both pages parses.
  for (const html of [local]) {
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      // eslint-disable-next-line no-new-func
      assert.doesNotThrow(() => new Function(m[1]));
    }
  }
  const hash = (js) => nodeCrypto.createHash('sha256').update(js, 'utf8').digest('base64');
  const cloud = phoneUploadPage({ mode: 'cloud', fn: 'https://pntxlvhkqfryyyxlqytr.supabase.co/functions/v1/phone-upload', anon: 'x', sealer: C.phoneSealerSource(), hash });
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(cloud);
  assert.ok(csp, 'cloud page has a CSP');
  assert.match(csp[1], /default-src 'none'/);
  assert.match(csp[1], /base-uri 'none'/);
  assert.match(csp[1], /form-action 'none'/);
  assert.match(csp[1], /connect-src https:\/\/pntxlvhkqfryyyxlqytr\.supabase\.co(?![\w.-])/);
  assert.doesNotMatch(csp[1], /script-src[^;]*https?:/);
  // Every inline script is allowed by its hash.
  const hashes = [...csp[1].matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]);
  const scripts = [...cloud.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => nodeCrypto.createHash('sha256').update(m[1], 'utf8').digest('base64'));
  assert.ok(scripts.length >= 1);
  for (const h of scripts) assert.ok(hashes.includes(h), 'inline script hashed in the CSP');
  assert.ok(cloud.includes('<meta name="referrer" content="no-referrer">'));
  assert.ok(!cloud.includes('__dvxGcm='), 'the cloud page uses WebCrypto, no bundled cipher');
  // eslint-disable-next-line no-new-func
  for (const m of cloud.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(m[1]));
});
