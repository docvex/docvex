// End-to-end encryption primitives and formats (src/lib/e2e, and the folder
// seal's key ring in src/projectIndex/folderSeal.js), under plain Node:
//   npm test
// Bundled first (Vite-style extensionless imports), as the other suites are.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let P; let E; let I; let S; let B; let F;

before(async () => {
  const entry = path.join(os.tmpdir(), `docvex-e2e-entry-${process.pid}.js`);
  const f = (p) => JSON.stringify(path.join(root, p));
  writeFileSync(entry, [
    `export * as P from ${f('src/lib/e2e/primitives.js')};`,
    `export * as E from ${f('src/lib/e2e/envelope.js')};`,
    `export * as I from ${f('src/lib/e2e/identityCore.js')};`,
    `export * as S from ${f('src/lib/e2e/syncCrypto.js')};`,
    `export * as B from ${f('src/lib/e2e/bytes.js')};`,
  ].join('\n'));
  const out = path.join(os.tmpdir(), `docvex-e2e-${process.pid}.mjs`);
  await build({ entryPoints: [entry], outfile: out, format: 'esm', platform: 'node', bundle: true, logLevel: 'silent' });
  ({ P, E, I, S, B } = await import(pathToFileURL(out).href));
  F = await import(pathToFileURL(path.join(root, 'src/projectIndex/folderSeal.js')).href);
});

const rejects = (p) => assert.rejects(p);
const ringOf = (entries) => {
  const keys = new Map(entries);
  return { keys, current: Math.max(...keys.keys()) };
};

test('AES-GCM: round trip, AAD bound, tamper refused', async () => {
  const key = B.randomBytes(32);
  const ct = await P.aeadEncrypt(key, B.utf8.enc('secret'), B.utf8.enc('aad-1'));
  assert.equal(B.utf8.dec(await P.aeadDecrypt(key, ct, B.utf8.enc('aad-1'))), 'secret');
  await rejects(P.aeadDecrypt(key, ct, B.utf8.enc('aad-2')));
  const bad = ct.slice(); bad[20] ^= 1;
  await rejects(P.aeadDecrypt(key, bad, B.utf8.enc('aad-1')));
  await rejects(P.aeadDecrypt(B.randomBytes(32), ct, B.utf8.enc('aad-1')));
});

test('sealed box (X25519 + HKDF + AES-GCM): only the recipient, only in its context', async () => {
  const rec = await P.generateX25519();
  const other = await P.generateX25519();
  const recipient = { privateKey: await P.importX25519Private(rec.privatePkcs8), publicRaw: rec.publicRaw };
  const payload = B.randomBytes(32);
  const blob = await P.sealTo(rec.publicRaw, payload, 'project-key|p|v1|u');
  assert.equal(blob.alg, P.SEAL_ALG);
  assert.ok(B.equalBytes(await P.openSealed(recipient, blob, 'project-key|p|v1|u'), payload));
  // Base64 public keys are accepted too.
  const blob2 = await P.sealTo(B.b64enc(rec.publicRaw), payload, 'c');
  assert.ok(B.equalBytes(await P.openSealed(recipient, blob2, 'c'), payload));
  await rejects(P.openSealed(recipient, blob, 'project-key|p|v2|u'));
  const wrong = { privateKey: await P.importX25519Private(other.privatePkcs8), publicRaw: other.publicRaw };
  await rejects(P.openSealed(wrong, blob, 'project-key|p|v1|u'));
  await rejects(P.openSealed(recipient, { ...blob, alg: 'X25519-MLKEM768' }, 'project-key|p|v1|u'));
  // Two seals of the same key differ (ephemeral sender key).
  assert.notEqual((await P.sealTo(rec.publicRaw, payload, 'c')).epk, blob2.epk);
});

test('Ed25519: sign / verify', async () => {
  const k = await P.generateEd25519();
  const priv = await P.importEd25519Private(k.privatePkcs8);
  const sig = await P.sign(priv, B.utf8.enc('hello'));
  assert.equal(await P.verify(k.publicRaw, sig, B.utf8.enc('hello')), true);
  assert.equal(await P.verify(B.b64enc(k.publicRaw), sig, B.utf8.enc('hello')), true);
  assert.equal(await P.verify(k.publicRaw, sig, B.utf8.enc('hellO')), false);
});

test('text envelope: bound to purpose, scope, key version and row; plain passes through', async () => {
  const k1 = B.randomBytes(32);
  const ctx = { purpose: 'chat.body', scope: 'proj-1', keyRef: 'p1', rowId: 'row-1' };
  const s = await E.encryptText(k1, 'Salut — ședință mâine la 10', ctx);
  assert.ok(s.startsWith('e2e:v1:p1:'));
  assert.equal(E.isEncryptedText(s), true);
  assert.deepEqual(E.parseTextEnvelope(s).keyRef, 'p1');
  const keyFor = async (ref) => (ref === 'p1' ? k1 : null);
  const r = await E.decryptText(keyFor, s, { purpose: 'chat.body', scope: 'proj-1', rowId: 'row-1' });
  assert.equal(r.ok, true); assert.equal(r.text, 'Salut — ședință mâine la 10');
  assert.equal((await E.decryptText(keyFor, s, { purpose: 'chat.body', scope: 'proj-1', rowId: 'row-2' })).ok, false);
  assert.equal((await E.decryptText(keyFor, s, { purpose: 'project.name', scope: 'proj-1', rowId: 'row-1' })).ok, false);
  assert.equal((await E.decryptText(keyFor, s, { purpose: 'chat.body', scope: 'proj-2', rowId: 'row-1' })).ok, false);
  // The key version is part of the AAD: relabelling it doesn't work.
  const relabelled = s.replace('e2e:v1:p1:', 'e2e:v1:p2:');
  assert.equal((await E.decryptText(async () => k1, relabelled, { purpose: 'chat.body', scope: 'proj-1', rowId: 'row-1' })).ok, false);
  const none = await E.decryptText(async () => null, s, { purpose: 'chat.body', scope: 'proj-1', rowId: 'row-1' });
  assert.equal(none.reason, 'no_key');
  const plain = await E.decryptText(keyFor, 'an old plain message', { purpose: 'chat.body', scope: 'proj-1' });
  assert.deepEqual([plain.ok, plain.text, plain.encrypted], [true, 'an old plain message', false]);
});

test('JSON document envelope: key version, purpose and scope', async () => {
  const ring = ringOf([[1, B.randomBytes(32)], [2, B.randomBytes(32)]]);
  const doc = await E.sealJsonDoc(ring.keys.get(2), 2, { a: 1, t: 'text' }, { purpose: 'sync.data.shared', scope: 'p' });
  assert.equal(doc.kv, 2); assert.equal(E.isJsonEnvelope(doc), true);
  const keyFor = async (kv) => ring.keys.get(kv) || null;
  assert.deepEqual(await E.openJsonDoc(keyFor, doc, { purpose: 'sync.data.shared', scope: 'p' }), { a: 1, t: 'text' });
  await rejects(E.openJsonDoc(keyFor, doc, { purpose: 'sync.data.private', scope: 'p' }));
  await rejects(E.openJsonDoc(keyFor, doc, { purpose: 'sync.data.shared', scope: 'q' }));
  await rejects(E.openJsonDoc(keyFor, { ...doc, kv: 1 }, { purpose: 'sync.data.shared', scope: 'p' }));
  await rejects(E.openJsonDoc(async () => null, doc, { purpose: 'sync.data.shared', scope: 'p' }));
});

test('key wrap (file key under the project key)', async () => {
  const kek = B.randomBytes(32); const fk = B.randomBytes(32);
  const ctx = { purpose: 'sync.file', scope: 'p', id: 'kid', kv: 3 };
  const w = await E.wrapKeyWith(kek, fk, ctx);
  assert.ok(B.equalBytes(await E.unwrapKeyWith(kek, w, ctx), fk));
  await rejects(E.unwrapKeyWith(kek, w, { ...ctx, id: 'other' }));
});

test('identity: generate, load, recovery backup (right / wrong passphrase)', async () => {
  const rec = await I.generateIdentityRecord('user-1');
  assert.equal(I.isIdentityRecord(rec), true);
  const id = await I.loadIdentityRecord(rec);
  assert.equal(id.x25519.publicRaw.length, 32);
  assert.equal(id.ed25519.publicRaw.length, 32);
  // The loaded private key is not extractable.
  await rejects(globalThis.crypto.subtle.exportKey('pkcs8', id.x25519.privateKey));
  await assert.rejects(I.makeBackup(rec, 'short'), /passphrase_too_short/);
  const blob = await I.makeBackup(rec, 'correct horse battery staple', { iterations: 1000 });
  assert.equal(blob.kdf, 'PBKDF2-SHA256');
  assert.equal(JSON.stringify(blob).includes(rec.x25519.priv), false, 'the backup holds no private key in clear');
  assert.deepEqual(await I.openBackup(blob, 'correct horse battery staple', 'user-1'), rec);
  await assert.rejects(I.openBackup(blob, 'wrong horse battery staple', 'user-1'), /wrong_passphrase/);
  await assert.rejects(I.openBackup(blob, 'correct horse battery staple', 'user-2'), /wrong_passphrase/);
  // The default is 600k iterations.
  assert.equal(P.PBKDF2_ITERATIONS, 600000);
});

test('sync manifest: sealed, signed, verified; forgery, edits and other projects refused', async () => {
  const ring = ringOf([[1, B.randomBytes(32)], [2, B.randomBytes(32)]]);
  const alice = await I.loadIdentityRecord(await I.generateIdentityRecord('alice'));
  const mallory = await I.loadIdentityRecord(await I.generateIdentityRecord('mallory'));
  const pub = { alice: alice.ed25519.publicB64, mallory: mallory.ed25519.publicB64 };
  const opts = { signerKeyOf: async (u) => pub[u] || null, isMember: async (u) => u === 'alice' };
  const manifest = { version: 1, gen: 'g', files: { k1: { path: 'Dosar/contract client.pdf', size: 10, mtime: 't' } }, folders: {} };
  const doc = await S.sealManifest(ring, alice, 'proj', manifest, 7);
  assert.equal(JSON.stringify(doc).includes('contract client'), false, 'no path in clear');
  assert.equal(S.isEncryptedManifest(doc), true);
  const opened = await S.openManifest(ring, 'proj', doc, opts);
  assert.equal(opened.seq, 7);
  assert.equal(opened.signerLeft, false);
  assert.equal(opened.manifest.files.k1.path, 'Dosar/contract client.pdf');
  // Edited fields break the signature.
  await assert.rejects(S.openManifest(ring, 'proj', { ...doc, seq: 8 }, opts), (e) => e.code === 'manifest_unverified');
  await assert.rejects(S.openManifest(ring, 'proj', { ...doc, kv: 1 }, opts), (e) => e.code === 'manifest_unverified');
  // Claiming to be alice with mallory's key / signature.
  const forged = await S.sealManifest(ring, mallory, 'proj', manifest, 9);
  await assert.rejects(S.openManifest(ring, 'proj', { ...forged, signer: 'alice' }, opts), (e) => e.code === 'manifest_unverified');
  await assert.rejects(S.openManifest(ring, 'proj', { ...forged, signer: 'alice', signerKey: pub.alice }, opts), (e) => e.code === 'manifest_unverified');
  // An unpublished signer.
  await assert.rejects(S.openManifest(ring, 'proj', doc, { ...opts, signerKeyOf: async () => null }), (e) => e.code === 'manifest_unverified');
  // Moved to another project.
  await assert.rejects(S.openManifest(ring, 'other', doc, opts), (e) => e.code === 'manifest_wrong_project');
  // A signer who has since left: read, flagged.
  const left = await S.openManifest(ring, 'proj', doc, { ...opts, isMember: async () => false });
  assert.equal(left.signerLeft, true);
  // A reader without the key version it was sealed with.
  await assert.rejects(S.openManifest(ringOf([[1, ring.keys.get(1)]]), 'proj', doc, opts));
});

test('sync files: per-file key, parts sealed one by one, order and totals bound', async () => {
  const ring = ringOf([[1, B.randomBytes(32)], [4, B.randomBytes(32)]]);
  const data = B.randomBytes(2500);
  const { entry, fileKey } = await S.newFileEntry(ring, 'proj', data.length, { partBytes: 1000 });
  assert.equal(entry.parts, 3); assert.equal(entry.kv, 4); assert.equal(entry.enc, 1);
  assert.match(entry.obj, /^[0-9a-f]{32}$/);
  assert.deepEqual(S.objectNamesOf('proj', entry), [0, 1, 2].map((i) => `proj/${entry.obj}.${i}`));
  const read = async (a, b) => data.subarray(a, b);
  const parts = [];
  for (let i = 0; i < entry.parts; i += 1) parts.push(await S.encryptFilePart(fileKey, 'proj', entry, i, read, data.length));
  assert.equal(parts[0].length, 1000 + E.PART_OVERHEAD);
  assert.equal(parts[2].length, 500 + E.PART_OVERHEAD);
  // Another device: the file key comes from the (manifest's) entry.
  const fk2 = await S.fileKeyOf(ring, 'proj', entry);
  const back = B.concat(...(await Promise.all(parts.map((p, i) => S.decryptFilePart(fk2, 'proj', entry, i, p)))));
  assert.ok(B.equalBytes(back, data));
  // Swapped parts, a cut-off file, another project: refused.
  await rejects(S.decryptFilePart(fk2, 'proj', entry, 0, parts[1]));
  await rejects(S.decryptFilePart(fk2, 'proj', { ...entry, parts: 2 }, 0, parts[0]));
  await rejects(S.decryptFilePart(fk2, 'other', entry, 0, parts[0]));
  await rejects(S.fileKeyOf(ring, 'proj', { ...entry, kid: 'x' }));
  await assert.rejects(S.fileKeyOf(ringOf([[1, ring.keys.get(1)]]), 'proj', entry), (e) => e.code === 'no_key');
  // An empty file is one empty part.
  const empty = await S.newFileEntry(ring, 'proj', 0);
  assert.equal(empty.entry.parts, 1);
  const ep = await S.encryptFilePart(empty.fileKey, 'proj', empty.entry, 0, read, 0);
  assert.equal((await S.decryptFilePart(empty.fileKey, 'proj', empty.entry, 0, ep)).length, 0);
});

test('folder seal: a key ring — v1 written as before 046, later versions marked and bound', () => {
  const k1 = Buffer.alloc(32, 1); const k2 = Buffer.alloc(32, 2);
  const onlyV1 = F.makeFolderKeyRing([{ version: 1, key: k1.toString('base64') }]);
  const s1 = F.sealForFolder(onlyV1, { a: 1 });
  assert.equal('kv' in s1, false, 'version 1 has no kv (an older build reads it)');
  assert.deepEqual(F.openFromFolder(k1, s1), { a: 1 }, 'a bare pre-046 key opens it');
  const ring = F.makeFolderKeyRing([{ version: 1, key: k1 }, { version: 2, key: k2 }]);
  assert.equal(ring.version, 2);
  const s2 = F.sealForFolder(ring, { b: 2 });
  assert.equal(s2.kv, 2);
  assert.deepEqual(F.openFromFolder(ring, s2), { b: 2 });
  assert.deepEqual(F.openFromFolder(ring, s1), { a: 1 }, 'the ring still reads version 1');
  assert.throws(() => F.openFromFolder(onlyV1, s2), 'a ring without v2 cannot read it');
  assert.throws(() => F.openFromFolder(ring, { ...s2, kv: 1 }));
  assert.throws(() => F.openFromFolder(ring, { ...s2, kv: undefined }));
  assert.equal(F.isFolderKey(ring), true);
  assert.equal(F.isFolderKey(k1), true);
  assert.equal(F.sameFolderKeys(ring, F.makeFolderKeyRing(F.folderRingToJson(ring))), true);
  assert.equal(F.sameFolderKeys(ring, onlyV1), false);
});
