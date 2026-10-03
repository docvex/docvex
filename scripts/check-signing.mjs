#!/usr/bin/env node
// scripts/check-signing.mjs — a release is SIGNED or it does not go out
// (security fix, 2026-10-01). Signing used to be optional: with the
// certificate variables unset, `npm run release:*` / `npm run publish`
// quietly shipped an unsigned Windows installer, which Windows SmartScreen
// flags and which nobody can tell apart from a tampered copy.
//
// Checked for THIS machine's platform (the one that builds the installer):
//   Windows — WINDOWS_CERTIFICATE_FILE (+ WINDOWS_CERTIFICATE_PASSWORD) or
//             WINDOWS_SIGN_WITH_PARAMS (a cloud / hardware-token signer),
//             read by forge.config.js's Squirrel maker.
//   macOS   — APPLE_SIGNING_IDENTITY plus one full set of notarization
//             credentials (APPLE_API_KEY / _KEY_ID / _ISSUER, or APPLE_ID /
//             APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID).
//
// `--mac` checks the macOS rule whatever the platform (publish-mac-zips uses
// it: a Mac build can only be Developer-ID signed ON a Mac).
//
// DOCVEX_ALLOW_UNSIGNED=1 lets an unsigned build through on purpose (a test
// release) and says so loudly. Exit code 1 = refused.

export function signingStatus(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const ok = !!(env.WINDOWS_CERTIFICATE_FILE || env.WINDOWS_SIGN_WITH_PARAMS);
    return {
      ok,
      what: 'Windows Authenticode',
      missing: ok ? '' : 'Set WINDOWS_CERTIFICATE_FILE (+ WINDOWS_CERTIFICATE_PASSWORD) or WINDOWS_SIGN_WITH_PARAMS.',
    };
  }
  if (platform === 'darwin') {
    const notary = (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
      || (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
    const ok = !!(env.APPLE_SIGNING_IDENTITY && notary);
    return {
      ok,
      what: 'Apple Developer ID + notarization',
      missing: ok ? '' : 'Set APPLE_SIGNING_IDENTITY and APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER (or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID).',
    };
  }
  return { ok: false, what: 'code signing', missing: `Releases are built on Windows or macOS, not ${platform}.` };
}

export const allowUnsigned = (env = process.env) => env.DOCVEX_ALLOW_UNSIGNED === '1';

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-signing.mjs');
if (isMain) {
  const platform = process.argv.includes('--mac') ? 'darwin' : process.platform;
  const s = signingStatus(platform);
  if (s.ok) {
    console.log(`[signing] ${s.what}: configured.`);
  } else if (allowUnsigned()) {
    console.warn(`[signing] WARNING: ${s.what} is NOT configured — building UNSIGNED because DOCVEX_ALLOW_UNSIGNED=1.`);
  } else {
    console.error(`[signing] Refusing to release unsigned: ${s.what} is not configured.\n[signing] ${s.missing}\n[signing] For a deliberate unsigned test build set DOCVEX_ALLOW_UNSIGNED=1.`);
    process.exit(1);
  }
}
