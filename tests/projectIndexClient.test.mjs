// The renderer's project-index client (src/lib/projectIndexClient.js) under
// plain Node: its cache, merge and migration logic, with window.electronAPI
// and localStorage mocked.
//   npm test

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let m;

// A localStorage that behaves like the browser's.
function memoryStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

// A fake main: knowledge per normalised path, settings per project/store.
function fakeMain({ stats = {} } = {}) {
  const knowledge = new Map();
  const settings = new Map();
  const handlers = {};
  const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  const api = {
    calls: [],
    knowledge,
    settings,
    emit: (name, ev) => handlers[name]?.(ev),
    async knowledgeGet({ path: p }) { api.calls.push(['get', p]); return { ok: true, facets: { ...(knowledge.get(norm(p)) || {}) } }; },
    async knowledgePut({ path: p, kind, facet }) {
      api.calls.push(['put', p, kind]);
      if (api.refuse) return { ok: false, error: 'nope' };
      knowledge.set(norm(p), { ...(knowledge.get(norm(p)) || {}), [kind]: facet });
      return { ok: true };
    },
    async knowledgeClear({ path: p, kind }) { const f = { ...(knowledge.get(norm(p)) || {}) }; delete f[kind]; knowledge.set(norm(p), f); return { ok: true }; },
    async knowledgeList() { return { items: [...knowledge.entries()].map(([p, facets]) => ({ path: p, facets })) }; },
    async projectLocate() { return { dir: 'C:\\Case' }; },
    async settingsGet({ projectId, store }) { return { value: settings.get(`${projectId}|${store}`) ?? null }; },
    async settingsPut({ projectId, store, value }) { settings.set(`${projectId}|${store}`, value); return { ok: true }; },
    async stat(p) { const s = stats[norm(p)]; return s ? { sizeBytes: s.size, mtimeIso: s.mtime } : { error: 'ENOENT' }; },
    onKnowledgeChanged: (cb) => { handlers.knowledge = cb; return () => {}; },
    onSettingsChanged: (cb) => { handlers.settings = cb; return () => {}; },
    onProjectDelta: (cb) => { handlers.delta = cb; return () => {}; },
  };
  return api;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

before(async () => {
  const out = path.join(os.tmpdir(), `docvex-project-index-client-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, 'src/lib/projectIndexClient.js')],
    outfile: out, format: 'esm', platform: 'node', bundle: true, logLevel: 'silent',
  });
  m = await import(pathToFileURL(out).href);
});

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
  globalThis.window = {};
  m._resetForTests();
});

test('without main, every read answers undefined (the stores fall back)', () => {
  assert.equal(m.indexAvailable(), false);
  assert.equal(m.peekFacet('C:\\a.jpg', 'text'), undefined);
  assert.equal(m.putFacet({ path: 'C:\\a.jpg' }, 'text', { data: 1 }), false);
  assert.equal(m.peekSetting('p1', 'scan-tags'), undefined);
});

test('a read of an unhydrated file starts hydration, then answers from memory', async () => {
  const api = fakeMain();
  api.knowledge.set('c:/case/a.jpg', { text: { kind: 'text', at: 1, data: { text: 'hi' } } });
  window.electronAPI = api;
  assert.equal(m.peekFacet('C:\\Case\\a.jpg', 'text'), undefined);
  await m.hydratePath('C:\\Case\\a.jpg');
  assert.equal(m.peekFacet('C:\\Case\\a.jpg', 'text').data.text, 'hi');
  // Another spelling of the same path is the same entry.
  assert.equal(m.peekFacet('c:/case/A.JPG', 'text').data.text, 'hi');
  assert.equal(m.peekFacet('C:\\Case\\a.jpg', 'ocr'), null);
});

test('a write is readable at once and a pending write survives a racing read', async () => {
  const api = fakeMain();
  window.electronAPI = api;
  const seen = [];
  m.subscribeIndex((ev) => seen.push(ev));
  assert.equal(m.putFacet({ path: 'C:\\Case\\b.pdf' }, 'ocr', { data: 'text' }), true);
  assert.equal(m.peekFacets('C:\\Case\\b.pdf').ocr.data, 'text');
  assert.ok(seen.some((e) => e.type === 'knowledge' && e.kind === 'ocr'));
  const e = { facets: { ocr: { data: 'mine' } }, pending: { ocr: 1 } };
  m.applyFacets(e, { ocr: { data: 'older' }, text: { data: 'x' } });
  assert.equal(e.facets.ocr.data, 'mine');
  assert.equal(e.facets.text.data, 'x');
});

test('a refused put calls onFail so the caller keeps its copy', async () => {
  const api = fakeMain();
  api.refuse = true;
  window.electronAPI = api;
  let failed = false;
  m.putFacet({ path: 'C:\\x.txt' }, 'captions', { data: { text: 'a' } }, { onFail: () => { failed = true; } });
  await tick(); await tick();
  assert.equal(failed, true);
});

test('project hydration covers every file in the folder', async () => {
  const api = fakeMain();
  api.knowledge.set('c:/case/a.jpg', { text: { kind: 'text', at: 1, data: 'x' } });
  window.electronAPI = api;
  await m.hydrateProject('p1');
  assert.equal(m.projectDirOf('p1'), 'C:\\Case');
  assert.equal(m.projectIdForDir('c:/case/'), 'p1');
  // A file with no knowledge is known too — no per-file call needed.
  const before = api.calls.filter((c) => c[0] === 'get').length;
  assert.deepEqual(m.peekFacets('C:\\Case\\sub\\none.docx'), {});
  assert.equal(api.calls.filter((c) => c[0] === 'get').length, before);
});

test('a delta marks a changed file stale; the next read refetches', async () => {
  const api = fakeMain();
  window.electronAPI = api;
  await m.hydrateProject('p1');
  api.knowledge.set('c:/case/a.jpg', { text: { kind: 'text', at: 1, data: 'old' } });
  await m.hydratePath('C:\\Case\\a.jpg', { force: true });
  api.knowledge.set('c:/case/a.jpg', {});
  m.applyDelta({ projectId: 'p1', upserted: [{ path: 'C:\\Case\\a.jpg', rel: 'a.jpg' }], removed: [] });
  // Served stale while it is re-read, then gone.
  assert.equal(m.peekFacet('C:\\Case\\a.jpg', 'text').data, 'old');
  await tick(); await tick(); await tick();
  assert.equal(m.peekFacet('C:\\Case\\a.jpg', 'text'), null);
});

test('legacy keys are parsed into facets (pure)', () => {
  const store = {
    'docvex:ai-data:v1:C:\\Case\\a.jpg': JSON.stringify({ path: 'C:\\Case\\a.jpg', facets: { text: { kind: 'text', at: 5, stamp: { size: 10 }, data: { text: 't' } } } }),
    'docvex:doc-viewer:metadata:C:\\Case\\b.pdf': JSON.stringify({ groups: [{ g: 1 }], extractedAt: 7, size: 3, mtime: '2024-01-01T00:00:00.000Z' }),
    'docvex:doc-viewer:captions:C:\\Case\\c.mp3': JSON.stringify({ text: 'hello', createdAt: 2 }),
    'docvex:doc-viewer:ocr-history:C:\\Case\\a.jpg': JSON.stringify([{ id: 'x', text: 'y', createdAt: 9 }]),
    [`docvex:doc-viewer:doc-theme:localfile://local/${encodeURIComponent('C:\\Case\\d.docx')}`]: 'chancery',
    [`docvex:doc-viewer:envelope:${encodeURIComponent(`localfile://local/${encodeURIComponent('C:\\Case\\c.mp3')}:120`)}`]: 'AAEC',
    [`docvex:doc-viewer:envelope:${encodeURIComponent(`localfile://local/${encodeURIComponent('C:\\Case\\c.mp3')}:60`)}`]: 'AAA=',
    'docvex:ai-file-index:v1': JSON.stringify({ 'C:\\Case\\b.pdf': { key: '3:2024-01-01T00:00:00.000Z:', desc: 'an invoice', at: 4 }, 'D:\\other.pdf': { key: '1:x:', desc: 'no', at: 1 } }),
    'docvex:doc-viewer:envelope:index': '[]',
    'unrelated': 'x',
  };
  const items = m.collectLegacy(Object.keys(store), (k) => store[k] ?? null, { inside: 'C:\\Case' });
  const kinds = items.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['captions', 'description', 'envelope', 'extraction', 'metadata', 'text', 'theme']);
  const env = items.find((i) => i.kind === 'envelope');
  assert.deepEqual(Object.keys(env.facet.data).sort(), ['120', '60']);
  assert.equal(env.keys.length, 2);
  const desc = items.find((i) => i.kind === 'description');
  assert.equal(desc.stamp.size, 3);
  assert.equal(desc.stamp.mtime, '2024-01-01T00:00:00.000Z');
  assert.equal(items.find((i) => i.kind === 'theme').facet.data.id, 'chancery');
});

test('migration moves a file\'s keys only after main accepts them, and drops stale ones', async () => {
  const api = fakeMain({ stats: { 'c:/case/a.jpg': { size: 10, mtime: '2024-01-01T00:00:00.000Z' } } });
  window.electronAPI = api;
  localStorage.setItem('docvex:ai-data:v1:C:\\Case\\a.jpg', JSON.stringify({ facets: { text: { kind: 'text', at: 5, stamp: { size: 10 }, data: 't' } } }));
  localStorage.setItem('docvex:doc-viewer:metadata:C:\\Case\\a.jpg', JSON.stringify({ groups: [1], size: 99 }));
  // A file that isn't there keeps its key.
  localStorage.setItem('docvex:doc-viewer:captions:C:\\Case\\gone.mp3', JSON.stringify({ text: 'x' }));
  const moved = await m.migrateLegacy({ dir: 'C:\\Case' });
  assert.equal(moved, 1);
  assert.equal(api.knowledge.get('c:/case/a.jpg').text.data, 't');
  assert.equal(api.knowledge.get('c:/case/a.jpg').metadata, undefined);   // stale by size: dropped
  assert.equal(localStorage.getItem('docvex:ai-data:v1:C:\\Case\\a.jpg'), null);
  assert.equal(localStorage.getItem('docvex:doc-viewer:metadata:C:\\Case\\a.jpg'), null);
  assert.notEqual(localStorage.getItem('docvex:doc-viewer:captions:C:\\Case\\gone.mp3'), null);

  // Refused → the key stays for next time.
  api.refuse = true;
  localStorage.setItem('docvex:doc-viewer:captions:C:\\Case\\a.jpg', JSON.stringify({ text: 'y' }));
  await m.migrateLegacy({ dir: 'C:\\Case' });
  assert.notEqual(localStorage.getItem('docvex:doc-viewer:captions:C:\\Case\\a.jpg'), null);
});

test('settings: read, write, and project-level migration of scan tags', async () => {
  const api = fakeMain();
  window.electronAPI = api;
  localStorage.setItem('docvex:scan-tags:v1:C:\\Case', JSON.stringify(['a/', '!a/b.jpg']));
  await m.hydrateProject('p1');
  assert.deepEqual(api.settings.get('p1|scan-tags'), ['a/', '!a/b.jpg']);
  assert.deepEqual(m.peekSetting('p1', 'scan-tags'), ['a/', '!a/b.jpg']);
  assert.equal(await m.putSetting('p1', 'web', { files: {} }), true);
  assert.deepEqual(m.peekSetting('p1', 'web'), { files: {} });
});

test('folder colours convert between absolute ids and paths inside the project', () => {
  const rel = m.folderColorsToRel({ 'dir:C:\\Case\\Acte': '#f00', 'dir:D:\\x': '#0f0', odd: '#00f' }, 'C:\\Case');
  assert.deepEqual(rel, { dirs: { Acte: '#f00' }, other: { 'dir:D:\\x': '#0f0', odd: '#00f' } });
  const back = m.folderColorsFromRel({ dirs: { Acte: '#f00', 'Sub/Deep': '#111' }, other: { odd: '#00f' } }, 'C:\\Case', { 'dir:c:/case/acte': '#999' });
  assert.deepEqual(back, { 'dir:c:/case/acte': '#f00', 'dir:C:\\Case\\Sub\\Deep': '#111', odd: '#00f' });
});

test('private list answers of any shape normalise to { key, value }', () => {
  assert.deepEqual(m.normalizePrivateList({ items: [{ key: 'a', value: 1 }] }), [{ key: 'a', value: 1, at: 0 }]);
  assert.deepEqual(m.normalizePrivateList([{ key: 'b', value: 2, at: 3 }]), [{ key: 'b', value: 2, at: 3 }]);
  assert.deepEqual(m.normalizePrivateList({ values: { c: 3 } }), [{ key: 'c', value: 3, at: 0 }]);
  assert.deepEqual(m.normalizePrivateList(null), []);
});
