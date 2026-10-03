// The chat store's merge (src/lib/advisorChats `mergeThreads`) — Research's
// chats must never be lost by a write: a stale or still-empty list is merged
// with what is stored, never written over it. Plain Node: npm test.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let M;

before(async () => {
  const out = path.join(os.tmpdir(), `docvex-chatstore-${process.pid}.mjs`);
  await build({ entryPoints: [path.join(root, 'src/lib/advisorChats.js')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
  M = await import(pathToFileURL(out).href);
});

const chat = (id, updatedAt, n = 1, extra = {}) => ({ id, updatedAt, messages: Array(n).fill({ who: 'me', text: 'x' }), ...extra });
const ids = (list) => list.map((t) => t.id);

test('a stale or empty list never drops stored chats', () => {
  assert.deepEqual(ids(M.mergeThreads([chat('a', 1)], [chat('a', 1), chat('b', 2), chat('c', 3)])), ['a', 'b', 'c']);
  assert.deepEqual(ids(M.mergeThreads([], [chat('a', 1), chat('b', 2)])), ['a', 'b']);
});

test('the newer copy of a chat wins, from either side', () => {
  assert.equal(M.mergeThreads([chat('a', 5, 3)], [chat('a', 2, 1)])[0].messages.length, 3);
  assert.equal(M.mergeThreads([chat('a', 2, 1)], [chat('a', 5, 3)])[0].messages.length, 3);
});

test('a closed chat stays closed unless touched after closing', () => {
  assert.deepEqual(ids(M.mergeThreads([chat('a', 1)], [chat('a', 1), chat('b', 2)], { b: 10 })), ['a']);
  assert.deepEqual(ids(M.mergeThreads([chat('b', 20)], [], { b: 10 })), ['b']);
});

test('one blank chat at most; pinned first', () => {
  const merged = M.mergeThreads([chat('x', 1, 0), chat('a', 1)], [chat('y', 1, 0), chat('p', 1, 1, { pinned: true })]);
  assert.deepEqual(ids(merged), ['p', 'x', 'a']);
});
