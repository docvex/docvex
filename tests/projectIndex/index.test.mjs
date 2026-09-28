// The project index (src/projectIndex/) end to end, on a real folder in the
// temp directory: linking a project, the reconcile (add / edit / rename /
// move / copy / delete / atomic save), ids.json (legacy sidecar import,
// conflict-copy merge), knowledge shards (write, read, merge, local kinds
// kept off disk), settings, private data, the watcher. Needs node:sqlite:
//   npm run test:index

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectIndexService } from '../../src/projectIndex/index.js';
import { IndexDb } from '../../src/projectIndex/db.js';
import { shardPath, hashFile } from '../../src/projectIndex/knowledge.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docvex-index-'));
const userData = path.join(tmp, 'userData');
const caseDir = path.join(tmp, 'Case');
const PID = '11111111-2222-3333-4444-555555555555';
const events = [];
let svc;

const write = (rel, data) => {
  const f = path.join(caseDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  return f;
};
const filesByRel = async () => {
  const res = await svc.projectFiles({ projectId: PID });
  assert.equal(res.ok, true);
  return new Map(res.files.map((r) => [r.rel, r]));
};
const lastDelta = () => [...events].reverse().find((e) => e.channel === 'project:delta')?.payload;
const idsJson = () => JSON.parse(fs.readFileSync(path.join(caseDir, '.docvex', 'ids.json'), 'utf8'));
const settle = async () => {
  // Let the debounced ids.json write land.
  await new Promise((r) => setTimeout(r, 600));
};

before(async () => {
  fs.mkdirSync(caseDir, { recursive: true });
  write('contract.docx', 'contract v1');
  write('Evidence/photo.jpg', 'jpegbytes');
  write('Evidence/.hidden', 'x');
  write('~$contract.docx', 'lock');
  write('Thumbs.db', 'x');
  // A legacy sidecar in a subfolder: its id must survive the import.
  fs.writeFileSync(path.join(caseDir, 'Evidence', '.docvex.json'), JSON.stringify({
    version: 1, projectId: PID, entries: { 'legacy-id-photo': { filename: 'photo.jpg', contentHash: null, mtime: null } },
  }));
  svc = createProjectIndexService({
    userDataDir: userData,
    broadcast: (channel, payload) => events.push({ channel, payload }),
  });
});

after(() => {
  svc?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('db: schema, and a corrupt file is set aside and rebuilt', () => {
  const file = path.join(tmp, 'x.db');
  const db = new IndexDb(file);
  assert.equal(db.getMeta('schema'), '1');
  db.putPrivate('u', 'k', { a: 1 }, 5);
  assert.deepEqual(db.getPrivate('u', 'k'), { value: { a: 1 }, at: 5 });
  db.close();
  const bad = path.join(tmp, 'bad.db');
  fs.writeFileSync(bad, 'this is not a database, just junk bytes '.repeat(200));
  const db2 = new IndexDb(bad);
  assert.equal(db2.rebuilt, true);
  assert.equal(db2.allFiles().length, 0);
  db2.close();
  assert.ok(fs.readdirSync(tmp).some((n) => n.startsWith('bad.db.corrupt-')));
});

test('db: face descriptors left by the removed face matching are deleted on open', () => {
  const file = path.join(tmp, 'faces.db');
  const db = new IndexDb(file);
  db.putKnowledge('a'.repeat(64), 'faces', { at: 1, data: [0.1, 0.2] }, true);
  db.putKnowledge('a'.repeat(64), 'text', { at: 1, data: { text: 'kept' } }, false);
  db.close();
  const again = new IndexDb(file);
  assert.deepEqual(Object.keys(again.knowledgeFor('a'.repeat(64))), ['text']);
  again.close();
});

test('projectOpen links the folder and writes the project file', async () => {
  const res = await svc.projectOpen({ projectId: PID, name: 'Case: Ion / Maria', dir: caseDir });
  assert.equal(res.ok, true);
  assert.equal(path.basename(res.projectFile), 'Case Ion Maria.docvex');
  const pf = JSON.parse(fs.readFileSync(res.projectFile, 'utf8'));
  assert.equal(pf.type, 'docvex/project');
  assert.equal(pf.projectId, PID);
  assert.deepEqual(await svc.projectLocate(PID), { dir: caseDir, projectFile: res.projectFile });
  // Opening again without a folder comes from the registry.
  const again = await svc.projectOpen({ projectId: PID });
  assert.equal(again.ok, true);
  assert.equal(again.dir, caseDir);
});

test('another project in the same folder is refused', async () => {
  const res = await svc.projectOpen({ projectId: 'other-project', name: 'Other', dir: caseDir });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'project_mismatch');
  assert.equal((await svc.projectOpen({ projectId: 'nope' })).error, 'not_found');
});

test('first reconcile lists what the Files tab lists, imports the sidecar', async () => {
  const r = await svc.projectReconcile({ projectId: PID });
  assert.equal(r.ok, true);
  const files = await filesByRel();
  assert.deepEqual([...files.keys()].sort(), ['Case Ion Maria.docvex', 'Evidence/photo.jpg', 'contract.docx']);
  const photo = files.get('Evidence/photo.jpg');
  assert.equal(photo.id, 'legacy-id-photo');
  assert.equal(photo.folderPath, 'Evidence');
  assert.equal(photo.mimeType, 'image/jpeg');
  assert.equal(photo.path, path.join(caseDir, 'Evidence', 'photo.jpg'));
  assert.ok(photo.fid && photo.mtimeIso && photo.sizeBytes === 9);
  assert.equal(fs.existsSync(path.join(caseDir, 'Evidence', '.docvex.json')), false, 'sidecar removed');
  const res = await svc.projectFiles({ projectId: PID });
  assert.deepEqual(res.dirs, ['Evidence']);
  await settle();
  assert.equal(idsJson().files['legacy-id-photo'].rel, 'Evidence/photo.jpg');
  const d = lastDelta();
  assert.equal(d.reconciled, true);
  assert.equal(d.projectId, PID);
});

test('rename, move, edit, copy, atomic save, delete', async () => {
  const before = await filesByRel();
  const contractId = before.get('contract.docx').id;
  const photoId = before.get('Evidence/photo.jpg').id;

  // Rename.
  fs.renameSync(path.join(caseDir, 'contract.docx'), path.join(caseDir, 'Contract final.docx'));
  await svc.projectReconcile({ projectId: PID });
  let files = await filesByRel();
  assert.equal(files.get('Contract final.docx').id, contractId);
  assert.equal(files.has('contract.docx'), false);
  let d = lastDelta();
  assert.deepEqual(d.removed, ['contract.docx']);
  assert.deepEqual(d.upserted.map((r) => r.rel), ['Contract final.docx']);

  // Move into a new folder.
  fs.mkdirSync(path.join(caseDir, 'Signed'));
  fs.renameSync(path.join(caseDir, 'Contract final.docx'), path.join(caseDir, 'Signed', 'Contract final.docx'));
  await svc.projectReconcile({ projectId: PID });
  files = await filesByRel();
  assert.equal(files.get('Signed/Contract final.docx').id, contractId);
  d = lastDelta();
  assert.deepEqual(d.dirsAdded, ['Signed']);

  // Edit in place.
  fs.appendFileSync(path.join(caseDir, 'Signed', 'Contract final.docx'), ' v2 with more text');
  await svc.projectReconcile({ projectId: PID });
  files = await filesByRel();
  assert.equal(files.get('Signed/Contract final.docx').id, contractId);
  assert.equal(files.get('Signed/Contract final.docx').sizeBytes, 'contract v1 v2 with more text'.length);

  // Copy: a new file, a new id.
  fs.copyFileSync(path.join(caseDir, 'Evidence', 'photo.jpg'), path.join(caseDir, 'Evidence', 'photo copy.jpg'));
  await svc.projectReconcile({ projectId: PID });
  files = await filesByRel();
  const copyId = files.get('Evidence/photo copy.jpg').id;
  assert.ok(copyId && copyId !== photoId);
  assert.equal(files.get('Evidence/photo.jpg').id, photoId);

  // Atomic save: a temp file renamed over the original — a new inode, the same document.
  const target = path.join(caseDir, 'Evidence', 'photo.jpg');
  const tmpFile = path.join(caseDir, 'Evidence', 'photo.jpg.saving');
  fs.writeFileSync(tmpFile, 'jpegbytes edited');
  fs.rmSync(target);
  fs.renameSync(tmpFile, target);
  await svc.projectReconcile({ projectId: PID });
  files = await filesByRel();
  assert.equal(files.get('Evidence/photo.jpg').id, photoId);
  assert.equal(files.has('Evidence/photo.jpg.saving'), false);

  // Delete a file and a whole folder.
  fs.rmSync(path.join(caseDir, 'Evidence', 'photo copy.jpg'));
  fs.rmSync(path.join(caseDir, 'Signed'), { recursive: true });
  await svc.projectReconcile({ projectId: PID });
  files = await filesByRel();
  assert.equal(files.has('Evidence/photo copy.jpg'), false);
  assert.equal(files.has('Signed/Contract final.docx'), false);
  d = lastDelta();
  assert.deepEqual(d.removed.sort(), ['Evidence/photo copy.jpg', 'Signed/Contract final.docx']);
  assert.deepEqual(d.dirsRemoved, ['Signed']);
  await settle();
  const ids = idsJson().files;
  assert.equal(ids[copyId], undefined);
  assert.equal(ids[photoId].rel, 'Evidence/photo.jpg');

  // A reconcile with nothing to do still says it finished, with no changes.
  const r = await svc.projectReconcile({ projectId: PID });
  assert.equal(r.changed, 0);
});

test('projectFileId / projectPathForId', async () => {
  const photo = path.join(caseDir, 'Evidence', 'photo.jpg');
  const { id } = await svc.projectFileId({ path: photo });
  assert.ok(id);
  assert.equal((await svc.projectPathForId({ projectId: PID, id })).path, photo);
  assert.equal((await svc.projectPathForId({ projectId: PID, id: 'nope' })).path, null);
  // A file the reconcile hasn't reached yet is indexed on the spot.
  const late = write('late.txt', 'late');
  const res = await svc.projectFileId({ path: late });
  assert.ok(res.id);
});

test('another machine: an unknown inode keeps its id through ids.json', async () => {
  // Rebuild the index from scratch (as on another computer): the ids must come back.
  const beforeIds = new Map([...(await filesByRel())].map(([rel, r]) => [rel, r.id]));
  await settle();
  svc.close();
  fs.rmSync(path.join(userData, 'project-index', `${PID}.db`));
  svc = createProjectIndexService({ userDataDir: userData, broadcast: (channel, payload) => events.push({ channel, payload }) });
  assert.equal((await svc.projectOpen({ projectId: PID })).ok, true);
  await svc.projectReconcile({ projectId: PID });
  for (const [rel, r] of await filesByRel()) assert.equal(r.id, beforeIds.get(rel), rel);
});

test('ids.json conflict copies are merged and removed', async () => {
  await settle();
  const folder = path.join(caseDir, '.docvex');
  fs.writeFileSync(path.join(folder, 'ids-DESKTOP-2.json'), JSON.stringify({
    v: 1, files: { 'remote-id': { rel: 'remote.pdf', size: 3, mtimeMs: 1, hash: null, at: Date.now() + 1000 } },
  }));
  svc.close();
  svc = createProjectIndexService({ userDataDir: userData, broadcast: (channel, payload) => events.push({ channel, payload }) });
  await svc.projectOpen({ projectId: PID });
  await svc.projectReconcile({ projectId: PID });
  await settle();
  assert.equal(fs.existsSync(path.join(folder, 'ids-DESKTOP-2.json')), false);
  assert.equal(idsJson().files['remote-id'].rel, 'remote.pdf');
  // The file then arrives with the id another machine gave it.
  write('remote.pdf', 'pdf');
  await svc.projectReconcile({ projectId: PID });
  assert.equal((await filesByRel()).get('remote.pdf').id, 'remote-id');
});

test('knowledge: shard written, local facets kept off disk, retired kinds refused, get / list / clear', async () => {
  const photo = path.join(caseDir, 'Evidence', 'photo.jpg');
  const sha = await hashFile(photo);
  events.length = 0;
  assert.equal((await svc.knowledgePut({ path: photo, kind: 'text', facet: { at: 10, engine: 'tesseract', data: { text: 'hi' } } })).ok, true);
  assert.equal((await svc.knowledgePut({ path: photo, kind: 'secret', facet: { at: 11, local: true, data: [1, 2, 3] } })).ok, true);
  // Face descriptors (the removed face matching) are refused outright.
  assert.equal((await svc.knowledgePut({ path: photo, kind: 'faces', facet: { at: 12, data: [4, 5, 6] } })).error, 'retired_kind');
  const shard = JSON.parse(fs.readFileSync(shardPath(caseDir, sha), 'utf8'));
  assert.equal(shard.name, 'photo.jpg');
  assert.deepEqual(Object.keys(shard.facets), ['text']);
  assert.equal(shard.facets.text.engine, 'tesseract');
  assert.equal(shard.facets.text.paid, false);
  assert.ok(events.some((e) => e.channel === 'knowledge:changed' && e.payload.kind === 'text' && e.payload.projectId === PID));

  const got = await svc.knowledgeGet({ path: photo });
  assert.deepEqual(Object.keys(got.facets).sort(), ['secret', 'text']);
  assert.deepEqual((await svc.knowledgeGet({ path: photo, kinds: ['secret'] })).facets.secret.data, [1, 2, 3]);

  // The same content elsewhere shares the knowledge; an edit leaves it behind.
  const copy = path.join(caseDir, 'photo again.jpg');
  fs.copyFileSync(photo, copy);
  assert.equal((await svc.knowledgeGet({ path: copy })).facets.text.data.text, 'hi');
  fs.appendFileSync(copy, 'changed');
  assert.deepEqual((await svc.knowledgeGet({ path: copy })).facets, {});

  const list = await svc.knowledgeList({ projectId: PID, kinds: ['text'] });
  const item = list.items.find((i) => i.rel === 'Evidence/photo.jpg');
  assert.ok(item?.id);
  assert.deepEqual(Object.keys(item.facets), ['text']);

  await svc.knowledgeClear({ path: photo, kind: 'text' });
  assert.equal(fs.existsSync(shardPath(caseDir, sha)), false, 'an empty shard is removed');
  assert.deepEqual(Object.keys((await svc.knowledgeGet({ path: photo })).facets), ['secret']);
});

test('knowledge: shard conflict copies and shards from another machine', async () => {
  const doc = write('brief.txt', 'the brief');
  const sha = await hashFile(doc);
  await svc.knowledgePut({ path: doc, kind: 'ocr', facet: { at: 100, data: 'mine' } });
  // A sync client's conflict copy holds a newer ocr and a kind we never wrote.
  const dir = path.dirname(shardPath(caseDir, sha));
  fs.writeFileSync(path.join(dir, `${sha}-LAPTOP.json`), JSON.stringify({
    v: 1, name: 'brief.txt', facets: { ocr: { kind: 'ocr', at: 200, data: 'theirs' }, summary: { kind: 'summary', at: 50, data: 's' } },
  }));
  // A shard for content this machine hasn't hashed yet (arrived with the folder).
  const other = write('Evidence/scan.png', 'scan bytes');
  const otherSha = await hashFile(other);
  fs.mkdirSync(path.dirname(shardPath(caseDir, otherSha)), { recursive: true });
  fs.writeFileSync(shardPath(caseDir, otherSha), JSON.stringify({ v: 1, name: 'scan.png', facets: { text: { kind: 'text', at: 1, data: 'scanned' } } }));
  await svc.projectReconcile({ projectId: PID });

  const list = await svc.knowledgeList({ projectId: PID });
  const brief = list.items.find((i) => i.rel === 'brief.txt');
  assert.equal(brief.facets.ocr.data, 'theirs');
  assert.equal(brief.facets.summary.data, 's');
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith(sha)).length, 1, 'copy merged away');
  assert.equal(list.items.find((i) => i.rel === 'Evidence/scan.png')?.facets.text.data, 'scanned');
});

test('settings and private data', async () => {
  events.length = 0;
  assert.equal((await svc.settingsPut({ projectId: PID, store: 'scan-tags', value: { a: ['x/'] } })).ok, true);
  assert.deepEqual((await svc.settingsGet({ projectId: PID, store: 'scan-tags' })).value, { a: ['x/'] });
  const file = path.join(caseDir, '.docvex', 'settings', 'scan-tags.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).value.a[0], 'x/');
  assert.ok(events.some((e) => e.channel === 'settings:changed' && e.payload.store === 'scan-tags'));
  // A newer copy on disk (another machine) wins.
  fs.writeFileSync(file, JSON.stringify({ v: 1, at: Date.now() + 60000, value: 'remote' }));
  assert.equal((await svc.settingsGet({ projectId: PID, store: 'scan-tags' })).value, 'remote');
  assert.equal((await svc.settingsGet({ projectId: PID, store: 'never' })).value, null);

  await svc.privatePut({ projectId: PID, userId: 'u1', key: 'chat:1', value: { t: 1 } });
  await svc.privatePut({ projectId: PID, userId: 'u1', key: 'chat:2', value: { t: 2 } });
  await svc.privatePut({ projectId: PID, userId: 'u2', key: 'chat:3', value: { t: 3 } });
  assert.deepEqual((await svc.privateGet({ projectId: PID, userId: 'u1', key: 'chat:1' })).value, { t: 1 });
  assert.deepEqual((await svc.privateList({ projectId: PID, userId: 'u1', prefix: 'chat:' })).items.map((i) => i.key), ['chat:1', 'chat:2']);
  await svc.privatePut({ projectId: PID, userId: 'u1', key: 'chat:1', value: undefined });
  assert.equal((await svc.privateGet({ projectId: PID, userId: 'u1', key: 'chat:1' })).value, null);
  // Nothing private is written into the case folder.
  assert.equal(fs.readdirSync(path.join(caseDir, '.docvex')).includes('private'), false);
});

test('loose files: knowledge in _loose.db, no shard', async () => {
  const outside = path.join(tmp, 'loose.txt');
  fs.writeFileSync(outside, 'free-standing');
  assert.equal((await svc.knowledgePut({ path: outside, kind: 'text', facet: { data: 'x' } })).ok, true);
  assert.equal((await svc.knowledgeGet({ path: outside })).facets.text.data, 'x');
  assert.equal(fs.existsSync(path.join(tmp, '.docvex')), false);
  assert.ok(fs.existsSync(path.join(userData, 'project-index', '_loose.db')));
  assert.equal((await svc.projectFileId({ path: outside })).id, null);
  await svc.privatePut({ projectId: null, userId: 'u', key: 'k', value: 1 });
  assert.equal((await svc.privateGet({ projectId: null, userId: 'u', key: 'k' })).value, 1);
});

test('calls never throw', async () => {
  assert.equal((await svc.knowledgeGet({ path: path.join(tmp, 'missing.bin') })).ok, false);
  assert.equal((await svc.knowledgePut({ path: path.join(caseDir, 'late.txt'), kind: 'bad kind!' })).error, 'bad_kind');
  assert.equal((await svc.projectFiles({})).ok, false);
});

test('the watcher sends a delta for a change on disk', async () => {
  const wait = (pred, ms = 4000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = events.find((e) => e.channel === 'project:delta' && pred(e.payload));
      if (hit) return resolve(hit.payload);
      if (Date.now() - t0 > ms) return reject(new Error('no delta'));
      setTimeout(tick, 50);
    };
    tick();
  });
  events.length = 0;
  write('Evidence/new note.txt', 'note');
  const d = await wait((p) => p.upserted.some((r) => r.rel === 'Evidence/new note.txt'));
  assert.equal(d.reconciled, undefined);
  events.length = 0;
  fs.renameSync(path.join(caseDir, 'Evidence', 'new note.txt'), path.join(caseDir, 'renamed note.txt'));
  const d2 = await wait((p) => p.upserted.some((r) => r.rel === 'renamed note.txt'));
  assert.ok(d2.removed.includes('Evidence/new note.txt'));
});

test('ids: an unknown file is matched by path+size+time, then hash, then path alone', async () => {
  const { IdStore } = await import('../../src/projectIndex/ids.js');
  const store = new IdStore(path.join(tmp, 'no-such-folder'));
  store.files = {
    a: { rel: 'x.pdf', size: 3, mtimeMs: 7, hash: 'h1', at: 1 },
    b: { rel: 'old/name.pdf', size: 5, mtimeMs: 1, hash: 'h2', at: 1 },
    c: { rel: 'edited.docx', size: 1, mtimeMs: 1, hash: 'h3', at: 1 },
  };
  assert.equal(store.candidatesFor({ rel: 'x.pdf', size: 3, mtimeMs: 7 }, new Set()).exact, 'a');
  assert.equal(store.candidatesFor({ rel: 'x.pdf', size: 3, mtimeMs: 7 }, new Set(['a'])).exact, null, 'claimed ids are not reused');
  assert.deepEqual(store.candidatesFor({ rel: 'moved.pdf', size: 5, mtimeMs: 9 }, new Set()).bySize, [['b', 'h2']]);
  assert.equal(store.candidatesFor({ rel: 'edited.docx', size: 99, mtimeMs: 2 }, new Set()).byRel, 'c');
});
