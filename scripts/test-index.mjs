// Runs the project-index tests (tests/projectIndex/) under Electron's own
// Node — they need node:sqlite, which the system Node this repo is built with
// (22.13) only has behind a flag, while Electron 42's Node 24 has it outright.
// ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node.
//   npm run test:index

import { spawnSync } from 'node:child_process';
import electronPath from 'electron';

const args = ['--test', '--test-concurrency=1', 'tests/projectIndex/*.test.mjs', ...process.argv.slice(2)];
const res = spawnSync(electronPath, args, {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
process.exit(res.status ?? 1);
