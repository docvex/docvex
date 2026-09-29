// The encrypted per-user store (src/lib/secureStore) and a store built on it
// (src/lib/tabHistory), under plain Node:   npm test
// Bundled first (Vite-style modules), as the other suites are. The preload's
// bridge (window.electronAPI) is stubbed: `privateGet/Put/List` as the index's
// private table and `vaultGet` as the safeStorage probe.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let S; let S2; let H;

// A localStorage that behaves like the browser's, and records every write.
function memoryStorage() {
  const map = new Map();
  const writes = [];
  const store = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { writes.push(k); map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    clear: () => map.clear(),
    _writes: writes,
  };
  // Object.keys(localStorage) lists the keys, as in a browser.
  return new Proxy(store, {
    ownKeys: () => [...map.keys()],
    getOwnPropertyDescriptor: (t, k) => (map.has(k) ? { enumerable: true, configurable: true, value: map.get(k) } : undefined),
  });
}

// The index's private table, shared by every "window" (module instance).
function privateTable({ encryption = true, withPrivate = true } = {}) {
  const rows = new Map();            // `${user}\0${ns}\0${key}` → value
  const k = (a) => `${a.userId}\0${a.projectId}\0${a.key}`;
  const puts = [];
  const api = {
    vaultGet: async (id) => (encryption ? { data: null, id } : { error: 'no_encryption' }),
    vaultPut: async () => (encryption ? { ok: true } : { error: 'no_encryption' }),
  };
  if (withPrivate) {
    Object.assign(api, {
      privateGet: async (a) => ({ ok: true, value: rows.has(k(a)) ? rows.get(k(a)) : null }),
      privatePut: async (a) => {
        puts.push(a);
        if (a.value == null) rows.delete(k(a)); else rows.set(k(a), JSON.parse(JSON.stringify(a.value)));
        return { ok: true };
      },
      privateList: async (a) => ({
        ok: true,
        items: [...rows.entries()]
          .filter(([key]) => key.startsWith(`${a.userId}\0${a.projectId}\0${a.prefix || ''}`))
          .map(([key, value]) => ({ key: key.split('\0')[2], value })),
      }),
    });
  }
  return { api, rows, puts };
}

async function bundle(name, exportsLine) {
  const entry = path.join(os.tmpdir(), `docvex-secure-${name}-entry-${process.pid}.js`);
  writeFileSync(entry, exportsLine);
  const out = path.join(os.tmpdir(), `docvex-secure-${name}-${process.pid}.mjs`);
  await build({ entryPoints: [entry], outfile: out, format: 'esm', platform: 'node', bundle: true, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
}

before(async () => {
  const store = JSON.stringify(path.join(root, 'src/lib/secureStore.js'));
  S = await bundle('a', `export * from ${store};`);
  S2 = await bundle('b', `export * from ${store};`);      // a second window
  H = await bundle('h', `export * from ${JSON.stringify(path.join(root, 'src/lib/tabHistory.js'))};\nexport * as store from ${store};`);
});

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
  S._resetSecureStoreForTests();
  S2._resetSecureStoreForTests();
  H.store._resetSecureStoreForTests();
});

// Open channels keep Node alive: close them when done.
after(() => {
  S._resetSecureStoreForTests();
  S2._resetSecureStoreForTests();
  H.store._resetSecureStoreForTests();
});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('class-(b) writes never reach localStorage; they reach the encrypted table', async () => {
  const t = privateTable();
  assert.equal(await S.hydrateSecureStore('u1', { api: t.api }), true);
  assert.equal(S.secureStoreBackend(), 'index');
  S.secureSet('docvex:ai-data:v1:C:/Case/ci.jpg', JSON.stringify({ facets: { text: { data: 'CNP 1850101223344' } } }));
  S.secureStorage.setItem('docvex:history:anaf:v1', '[{"label":"SC Popescu SRL"}]');
  assert.equal(S.secureGet('docvex:history:anaf:v1'), '[{"label":"SC Popescu SRL"}]');
  await S.flushSecureStore();
  assert.equal(localStorage._writes.length, 0);
  assert.equal(localStorage.length, 0);
  const row = t.rows.get('u1\0_secure\0docvex:ai-data:v1:C:/Case/ci.jpg');
  assert.ok(row && /1850101223344/.test(row.s));
  // Removal reaches the table too.
  S.secureRemove('docvex:history:anaf:v1');
  await S.flushSecureStore();
  assert.equal(t.rows.has('u1\0_secure\0docvex:history:anaf:v1'), false);
  assert.equal(S.secureGet('docvex:history:anaf:v1'), null);
});

test('a store built on it (tabHistory) writes nothing to localStorage', async () => {
  const t = privateTable();
  await H.store.hydrateSecureStore('u1', { api: t.api });
  H.logHistory('anaf', { kind: 'search', label: 'CUI 2408422' });
  assert.equal(H.listHistory('anaf').length, 1);
  await H.store.flushSecureStore();
  assert.equal(localStorage._writes.length, 0);
  assert.ok(t.rows.get('u1\0_secure\0docvex:history:anaf:v1'));
});

test('migration: legacy localStorage keys move into the store and leave localStorage', async () => {
  localStorage.setItem('docvex:doc-viewer:conversation:c:/case/a.docx', '{"messages":[1]}');
  localStorage.setItem('docvex:source-cache:anaf:v1', '{"x":1}');
  localStorage.setItem('docvex.theme.u1', 'ink');                 // a preference: stays
  localStorage.setItem('sb-abc-auth-token', 'tok');               // not ours to move
  const t = privateTable();
  await S.hydrateSecureStore('u1', { api: t.api });
  assert.equal(S.secureGet('docvex:doc-viewer:conversation:c:/case/a.docx'), '{"messages":[1]}');
  assert.equal(S.secureGet('docvex:source-cache:anaf:v1'), '{"x":1}');
  await S.flushSecureStore();
  assert.equal(localStorage.getItem('docvex:doc-viewer:conversation:c:/case/a.docx'), null);
  assert.equal(localStorage.getItem('docvex:source-cache:anaf:v1'), null);
  assert.equal(localStorage.getItem('docvex.theme.u1'), 'ink');
  assert.equal(localStorage.getItem('sb-abc-auth-token'), 'tok');
  assert.deepEqual(t.rows.get('u1\0_secure\0docvex:source-cache:anaf:v1'), { s: '{"x":1}' });
});

test('migration keeps the stored value when the table already has one, and still clears localStorage', async () => {
  const t = privateTable();
  await t.api.privatePut({ projectId: '_secure', userId: 'u1', key: 'docvex:files:opened:v1', value: { s: '{"a":2}' } });
  localStorage.setItem('docvex:files:opened:v1', '{"old":1}');
  await S.hydrateSecureStore('u1', { api: t.api });
  assert.equal(S.secureGet('docvex:files:opened:v1'), '{"a":2}');
  assert.equal(localStorage.getItem('docvex:files:opened:v1'), null);
});

test('memory-only when safeStorage is unavailable: nothing to localStorage, nothing to disk, warned once', async () => {
  const t = privateTable({ encryption: false });
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    assert.equal(await S.hydrateSecureStore('u1', { api: t.api }), false);
    assert.equal(S.secureStoreBackend(), 'memory');
    S.secureSet('docvex.aichat.v3.u1.p1', '[{"id":"c1"}]');
    S.secureSet('docvex.aichat.v3.u1.p2', '[{"id":"c2"}]');
    await S.flushSecureStore();
    await sleep(300);
    assert.equal(S.secureGet('docvex.aichat.v3.u1.p1'), '[{"id":"c1"}]');
    assert.equal(localStorage._writes.length, 0);
    assert.equal(t.puts.length, 0);
    assert.equal(warns.filter((w) => /secureStore/.test(w)).length, 1);
  } finally { console.warn = orig; }
});

test('memory-only without a bridge at all (old preload / not Electron)', async () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await S.hydrateSecureStore('u1', { api: {} }), false);
    S.secureSet('docvex:legal-browser:v1', '{"tabs":[]}');
    assert.equal(S.secureGet('docvex:legal-browser:v1'), '{"tabs":[]}');
    assert.equal(localStorage._writes.length, 0);
  } finally { console.warn = orig; }
});

test('writes made before hydration are kept, merged where the store registered a merge', async () => {
  const t = privateTable();
  await t.api.privatePut({ projectId: '_secure', userId: 'u1', key: 'docvex:history:caen:v1', value: { s: JSON.stringify([{ id: 'old', label: '6201' }]) } });
  H.logHistory('caen', { kind: 'open', label: '4711' });          // before sign-in landed
  assert.equal(localStorage._writes.length, 0);
  await H.store.hydrateSecureStore('u1', { api: t.api });
  const labels = H.listHistory('caen').map((e) => e.label);
  assert.deepEqual(labels, ['6201', '4711']);
});

test('wipe: memory dropped, pending writes not written, legacy copies removed', async () => {
  const t = privateTable();
  await S.hydrateSecureStore('u1', { api: t.api });
  S.secureSet('docvex:case-timeline:v1:p1', '{"events":[]}');
  localStorage.setItem('docvex:ai-data:v1:x', 'plain');            // a straggler
  await S.wipeSecureStore({ persistent: true });
  assert.equal(S.secureGet('docvex:case-timeline:v1:p1'), null);
  assert.equal(S.isSecureStoreReady(), false);
  assert.equal(localStorage.getItem('docvex:ai-data:v1:x'), null);
  await sleep(300);
  assert.equal(t.puts.length, 0);
});

test('sign-out flushes then forgets; the next user sees nothing of the first', async () => {
  const t = privateTable();
  await S.hydrateSecureStore('u1', { api: t.api });
  S.secureSet('docvex.chat.cache.p1', '[{"body":"hi"}]');
  await S.wipeSecureStore();
  assert.ok(t.rows.get('u1\0_secure\0docvex.chat.cache.p1'));
  await S.hydrateSecureStore('u2', { api: t.api });
  assert.equal(S.secureGet('docvex.chat.cache.p1'), null);
  await S.wipeSecureStore();
  await S.hydrateSecureStore('u1', { api: t.api });
  assert.equal(S.secureGet('docvex.chat.cache.p1'), '[{"body":"hi"}]');
});

test('cross-window: the channel carries keys only; the other window re-reads its backend', async () => {
  const t = privateTable();
  const seen = [];
  const bc = new BroadcastChannel('docvex-secure-store');
  bc.onmessage = (ev) => seen.push(ev.data);
  await S.hydrateSecureStore('u1', { api: t.api });
  await S2.hydrateSecureStore('u1', { api: t.api });
  const changes = [];
  S2.subscribeSecureKeys('docvex:scan-tags:v1:', (k) => changes.push(k));
  S.secureSet('docvex:scan-tags:v1:C:/Case', '["a/"]');
  await S.flushSecureStore();
  await sleep(100);
  bc.close();
  assert.equal(S2.secureGet('docvex:scan-tags:v1:C:/Case'), '["a/"]');
  assert.deepEqual(changes, ['docvex:scan-tags:v1:C:/Case']);
  assert.ok(seen.length >= 1);
  for (const msg of seen) {
    assert.deepEqual(Object.keys(msg), ['keys']);
    assert.ok(!JSON.stringify(msg).includes('a/'));
  }
});

test('storageFor / readStoreForSync / writeStoreFromSync route by key', async () => {
  const t = privateTable();
  await S.hydrateSecureStore('u1', { api: t.api });
  S.writeStoreFromSync('docvex:doc-viewer:doc-theme:localfile://local/x', 'chancery');
  S.writeStoreFromSync('docvex.appPrefs.u1', '{"textSize":1}');
  assert.equal(localStorage.getItem('docvex:doc-viewer:doc-theme:localfile://local/x'), null);
  assert.equal(localStorage.getItem('docvex.appPrefs.u1'), '{"textSize":1}');
  assert.deepEqual(S.readStoreForSync('docvex:doc-viewer:doc-theme:'), { 'docvex:doc-viewer:doc-theme:localfile://local/x': 'chancery' });
  assert.equal(S.readKeyForSync('docvex.appPrefs.u1'), '{"textSize":1}');
  S.writeStoreFromSync('docvex:doc-viewer:doc-theme:localfile://local/x', null);
  assert.equal(S.secureGet('docvex:doc-viewer:doc-theme:localfile://local/x'), null);
  assert.equal(S.isSecureKey('docvex:insight-resolutions:v1:C:/x'), true);
  assert.equal(S.isSecureKey('docvex.theme.u1'), false);
});
