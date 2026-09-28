// Portable knowledge: `.docvex/knowledge/<ab>/<sha256>.json`, one small file
// per file CONTENT (see README.md), plus the streamed hashing that finds the
// shard for a file.
//
// Keyed by content on purpose: a rename, a move, a copy or another machine
// all land on the same shard, and an edit — the one change that makes derived
// knowledge stale — lands on a new one.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJsonAtomic } from './atomic.js';

// Kinds that must never leave this machine. `faces` holds face descriptors
// (biometric data): the AI data layer marks them `local: true` and account
// sync already leaves them out — a shard in the case folder would ship them
// with every copy of the folder instead.
export const LOCAL_KINDS = new Set(['faces']);

export const isShaHex = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    s.on('data', (chunk) => h.update(chunk));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

export const shardDir = (dir, sha) => path.join(dir, '.docvex', 'knowledge', sha.slice(0, 2));
export const shardPath = (dir, sha) => path.join(shardDir(dir, sha), `${sha}.json`);

const facetsOf = (json) => (json && typeof json.facets === 'object' && json.facets ? json.facets : {});

// Per facet, the one with the later `at`.
export function mergeFacets(a, b) {
  const out = { ...a };
  for (const [kind, f] of Object.entries(b || {})) {
    if (!f || typeof f !== 'object') continue;
    if (!out[kind] || (Number(f.at) || 0) > (Number(out[kind].at) || 0)) out[kind] = f;
  }
  return out;
}

// One shard at a time per file: two puts for the same content (the Doc Viewer
// saving OCR while the scan saves an understanding) would otherwise both read
// the old shard and the second write would drop the first facet.
const shardLocks = new Map();
function withShardLock(file, fn) {
  const prev = shardLocks.get(file) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  shardLocks.set(file, tail);
  tail.then(() => { if (shardLocks.get(file) === tail) shardLocks.delete(file); });
  return next;
}

// Read a shard, folding in the conflict copies a sync client left beside it
// ("<sha>-DESKTOP-1.json", "<sha> (1).json"); when there were any, the merged
// shard is written back and the copies removed. null when there is no shard.
async function readShardUnlocked(dir, sha, onWrite) {
  const folder = shardDir(dir, sha);
  let names;
  try { names = await fsp.readdir(folder); } catch { return null; }
  const main = `${sha}.json`;
  const mine = names.filter((n) => n.startsWith(sha) && n.toLowerCase().endsWith('.json') && !n.startsWith('.'));
  if (!mine.length) return null;
  let shard = null;
  for (const name of [main, ...mine.filter((n) => n !== main)]) {
    if (!mine.includes(name)) continue;
    const json = await readJson(path.join(folder, name));
    if (!json) continue;
    shard = shard
      ? { ...shard, name: shard.name || json.name || null, facets: mergeFacets(shard.facets, facetsOf(json)) }
      : { v: 1, name: json.name || null, facets: { ...facetsOf(json) } };
  }
  const copies = mine.filter((n) => n !== main);
  if (copies.length && shard) {
    const file = path.join(folder, main);
    onWrite?.(file);
    await writeJsonAtomic(file, shard);
    for (const n of copies) await fsp.unlink(path.join(folder, n)).catch(() => {});
  }
  return shard;
}

export function readShard(dir, sha, onWrite) {
  return withShardLock(shardPath(dir, sha), () => readShardUnlocked(dir, sha, onWrite));
}

// Set (facet) or remove (facet === null) one kind in a shard — read, merge,
// write, so facets another machine added are kept. A shard left with no
// facets is deleted. Local kinds are refused here as a last line of defence.
export function writeShardFacet(dir, sha, { name, kind, facet }, onWrite) {
  if (LOCAL_KINDS.has(kind) || facet?.local === true) return Promise.resolve(false);
  const file = shardPath(dir, sha);
  return withShardLock(file, async () => {
    const shard = (await readShardUnlocked(dir, sha, onWrite)) || { v: 1, name: null, facets: {} };
    if (name) shard.name = name;
    if (facet) shard.facets[kind] = facet;
    else delete shard.facets[kind];
    onWrite?.(file);
    if (!Object.keys(shard.facets).length) {
      await fsp.unlink(file).catch(() => {});
      return true;
    }
    await writeJsonAtomic(file, { v: 1, name: shard.name, facets: shard.facets });
    return true;
  });
}

// Every shard in the folder: [{ sha, file, mtimeMs }]. Cheap — one readdir per
// two-hex bucket, and only files that hold knowledge have a shard.
export async function listShards(dir) {
  const root = path.join(dir, '.docvex', 'knowledge');
  let buckets;
  try { buckets = await fsp.readdir(root); } catch { return []; }
  const out = [];
  for (const b of buckets) {
    if (!/^[0-9a-f]{2}$/.test(b)) continue;
    let names;
    try { names = await fsp.readdir(path.join(root, b)); } catch { continue; }
    const shas = new Set();
    for (const n of names) {
      const sha = n.slice(0, 64);
      if (isShaHex(sha) && n.toLowerCase().endsWith('.json') && !n.startsWith('.')) shas.add(sha);
    }
    for (const sha of shas) {
      let mtimeMs = 0;
      try { mtimeMs = (await fsp.stat(path.join(root, b, `${sha}.json`))).mtimeMs; } catch { /* only copies */ }
      out.push({ sha, mtimeMs });
    }
  }
  return out;
}

// A facet as stored: the contract's fields, plus whatever else the caller
// kept on it (the renderer's facets carry a `stamp`, for one).
export function normalizeFacet(kind, facet) {
  const f = facet && typeof facet === 'object' ? facet : { data: facet };
  return {
    ...f,
    kind,
    at: Number(f.at) || Date.now(),
    engine: f.engine ?? null,
    paid: !!f.paid,
    data: f.data === undefined ? null : f.data,
  };
}
