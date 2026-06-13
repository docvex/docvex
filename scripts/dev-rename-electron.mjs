// Dev-only cosmetic fix for the macOS dock label.
//
// `npm start` runs the app through the PREBUILT Electron binary in
// node_modules (`electron/dist/Electron.app`). macOS reads the dock tile's
// name + tooltip from that bundle's Info.plist CFBundleName, which ships as
// "Electron" — so in development the dock says "Electron" even though
// app.setName('DocVex') fixes the menu bar and app.getName(). (The PACKAGED
// build is unaffected: electron-packager stamps productName="DocVex" into its
// own bundle, so release apps already show "DocVex".)
//
// This rewrites CFBundleName/CFBundleDisplayName in the dev bundle to "DocVex".
// Editing a file inside a signed .app breaks its code signature, and on Apple
// Silicon the kernel SIGKILLs apps with an invalid signature ("Code Signature
// Invalid" — the same hazard CLAUDE.md documents for releases), so we ad-hoc
// re-sign the bundle afterwards to repair it.
//
// Idempotent: if the bundle is already named "DocVex" it exits immediately, so
// the patch+resign cost (a few seconds) is paid once per `npm install` of
// electron, not on every `npm start`. No-op on Windows/Linux. Best-effort —
// any failure is swallowed so it can never block `npm start`.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

if (process.platform !== 'darwin') process.exit(0);

const NAME = 'DocVex';
const PLIST_BUDDY = '/usr/libexec/PlistBuddy';

const require = createRequire(import.meta.url);
let exe;
try { exe = require('electron'); } catch { process.exit(0); }
if (typeof exe !== 'string') process.exit(0); // electron not installed / unexpected

// .../Electron.app/Contents/MacOS/Electron  ->  .../Electron.app
const appIdx = exe.indexOf('.app');
if (appIdx === -1) process.exit(0);
const appDir = exe.slice(0, appIdx + 4);
const plist = path.join(appDir, 'Contents', 'Info.plist');
if (!existsSync(PLIST_BUDDY) || !existsSync(plist)) process.exit(0);

const plistGet = (key) => {
  try {
    return execFileSync(PLIST_BUDDY, ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
  } catch { return null; }
};
const plistSet = (key) => {
  try {
    execFileSync(PLIST_BUDDY, ['-c', `Set :${key} ${NAME}`, plist], { stdio: 'ignore' });
  } catch {
    // Key absent (CFBundleDisplayName often is) — add it.
    try { execFileSync(PLIST_BUDDY, ['-c', `Add :${key} string ${NAME}`, plist], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
};

// Fast path: already renamed.
if (plistGet('CFBundleName') === NAME) process.exit(0);

plistSet('CFBundleName');
plistSet('CFBundleDisplayName');

// Repair the signature the edit just invalidated, or arm64 SIGKILLs the app.
try { execFileSync('xattr', ['-cr', appDir], { stdio: 'ignore' }); } catch { /* ignore */ }
try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appDir], { stdio: 'ignore' });
} catch { /* ignore — unsigned run may still work on Intel */ }

// Nudge LaunchServices so the dock picks up the new name without a logout.
try {
  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', appDir],
    { stdio: 'ignore' },
  );
} catch { /* ignore */ }

console.log(`[dev] Renamed dev Electron bundle -> "${NAME}" (dock label).`);
