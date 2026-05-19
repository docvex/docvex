#!/usr/bin/env node
// scripts/run-many.mjs
//
// Spawns N parallel `electron-forge start` children so a single
// `npm run start:multi` command boots multiple dev instances of the
// app — useful for testing realtime / multi-user / branching flows
// from one machine.
//
// Usage:
//   npm run start:multi          # defaults to 2 instances
//   npm run start:multi -- 3     # 3 instances
//
// Each child gets:
//   • DOCVEX_ALLOW_MULTI=1   → main.js skips requestSingleInstanceLock,
//                              so the second/third process actually
//                              gets a window instead of exiting.
//   • DOCVEX_INSTANCE=<n>    → 1-based label the renderer can read if
//                              we ever want to show "Instance 2" in
//                              dev. Not consumed today.
//
// Vite picks the next free port automatically when 5173 is taken, so
// the dev servers don't fight. The .vite/build temp dir IS shared
// across children — usually fine because each Vite plugin run writes
// fresh artifacts, but if you see file-lock errors on Windows, run
// the instances from separate `git worktree` checkouts instead.
//
// Caveat: the docvex:// protocol handler is a single OS-level
// registration, so OAuth callbacks land in whichever instance the OS
// picks first. Sign in via email/password in the extra instances, or
// reuse a session from before the parallel launch.

import { spawn } from 'node:child_process';

const RAW = process.argv[2];
const parsed = parseInt(RAW || '2', 10);
const count = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 8) : 2;

if (RAW && (!Number.isFinite(parsed) || parsed < 1)) {
  console.warn(`[start:multi] invalid count "${RAW}" — defaulting to 2.`);
}

console.log(`[start:multi] launching ${count} instance${count === 1 ? '' : 's'}…`);

const procs = [];
for (let i = 0; i < count; i++) {
  const child = spawn('npx', ['electron-forge', 'start'], {
    stdio: 'inherit',
    // shell:true on Windows so the `.cmd` shim for npx resolves
    // (Node 22 CVE-2024-27980 hardening blocks direct .cmd spawn).
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      DOCVEX_ALLOW_MULTI: '1',
      DOCVEX_INSTANCE: String(i + 1),
    },
  });
  child.on('exit', (code) => {
    console.log(`[start:multi] instance ${i + 1} exited with code ${code}`);
  });
  procs.push(child);
}

// Forward Ctrl+C to every child so a single ^C in the parent shell
// tears the whole fleet down instead of leaving orphan Electron
// processes the user has to Task-Manager-kill.
const cleanup = () => {
  for (const p of procs) {
    try { p.kill(); } catch { /* swallow */ }
  }
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);
