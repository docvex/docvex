const path = require('node:path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// ── macOS Developer ID signing + notarization (opt-in via env) ──────────────
// When APPLE_SIGNING_IDENTITY is set (a "Developer ID Application: … (TEAMID)"
// certificate present in the login keychain), electron-packager signs the app
// with the Hardened Runtime + our entitlements and — if notarization creds are
// also present — submits it to Apple's notary service and staples the ticket.
// A notarized+stapled build launches WITHOUT the "Apple could not verify …"
// Gatekeeper block, even downloaded from the internet.
//
// When the identity is NOT set, everything below is a no-op and the build
// falls back to the existing ad-hoc-signed path (make-mac-zips.mjs re-signs
// ad-hoc; users must "Open Anyway" once). This keeps CI / non-Mac hosts and
// developers without an Apple Developer membership working unchanged.
//
// Ordering note: the FusesPlugin flips fuse bytes in the `packageAfterCopy`
// hook, which runs BEFORE electron-packager's signing step — so osxSign signs
// the already-fuse-flipped binary and the signature stays valid. That's why
// resetAdHocDarwinSignature is turned OFF on the Developer ID path (the proper
// signature replaces the ad-hoc one; no manual re-sign needed).
const APPLE_IDENTITY = process.env.APPLE_SIGNING_IDENTITY || null;
const SIGNING_MAC = process.platform === 'darwin' && !!APPLE_IDENTITY;

// Notarization credentials — support both notarytool auth forms. App-Store-
// Connect API key (APPLE_API_*) is preferred by CI; Apple-ID + app-specific
// password (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID) is simplest
// for a developer's own Mac. We only notarize if signing AND one full set of
// creds is present, so a sign-only run (e.g. offline) still works.
function resolveOsxNotarize() {
  if (!SIGNING_MAC) return undefined;
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    return {
      appleApiKey: APPLE_API_KEY,
      appleApiKeyId: APPLE_API_KEY_ID,
      appleApiIssuer: APPLE_API_ISSUER,
    };
  }
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    return {
      appleId: APPLE_ID,
      appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
      teamId: APPLE_TEAM_ID,
    };
  }
  console.warn(
    '[forge] APPLE_SIGNING_IDENTITY set but no notarization creds found — ' +
      'signing only (the build will still be Gatekeeper-blocked until notarized). ' +
      'Set APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER or ' +
      'APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID.',
  );
  return undefined;
}

const osxSign = SIGNING_MAC
  ? {
      identity: APPLE_IDENTITY,
      // Apply the Hardened Runtime + our entitlements to every code item
      // (@electron/osx-sign signs the frameworks/helpers bottom-up and uses
      // the inherit variant for children automatically).
      optionsForFile: () => ({
        hardenedRuntime: true,
        entitlements: path.resolve(__dirname, 'build/entitlements.mac.plist'),
      }),
    }
  : undefined;
const osxNotarize = resolveOsxNotarize();

if (SIGNING_MAC) {
  console.log(
    `[forge] macOS Developer ID signing ON (identity: ${APPLE_IDENTITY})` +
      (osxNotarize ? ' + notarization' : ' (no notarization creds — sign only)'),
  );
}

module.exports = {
  packagerConfig: {
    asar: true,
    // Stamp a specific version into the bundle's Info.plist when building to
    // patch an existing release (scripts/fix-mac-release.mjs sets this to the
    // release's tag). Without it, electron-packager uses package.json#version.
    // Mismatched versions make the updater re-prompt forever, so the rebuilt
    // assets for vX must report vX.
    ...(process.env.DOCVEX_APP_VERSION ? { appVersion: process.env.DOCVEX_APP_VERSION } : {}),
    // macOS code signing + notarization — only populated when
    // APPLE_SIGNING_IDENTITY is set (see the block above); otherwise both are
    // `undefined` and electron-packager skips signing entirely (ad-hoc path).
    ...(osxSign ? { osxSign } : {}),
    ...(osxNotarize ? { osxNotarize } : {}),
    // electron-packager picks the right extension for each target by
    // appending it to this basename:
    //   - Windows:  src/favicon.ico    ← committed
    //   - macOS:    src/favicon.icns   ← optional; falls back when missing
    //   - Linux:    src/favicon.png    ← optional; falls back when missing
    // The .ico carries multi-resolution frames (16/32/48/.../256), so the
    // .exe and Setup.exe both pick the right one.
    icon: 'src/favicon',
    protocols: [
      {
        name: 'Docvex Auth',
        schemes: ['docvex'],
      },
    ],
    // macOS "Open with DocVex": declare a catch-all document type in the
    // bundle's Info.plist so Finder offers DocVex in every file's Open With
    // menu (role Viewer — we never claim to be the default editor). The OS
    // then delivers opens via app.on('open-file') in src/main.js, which
    // routes them to a standalone Doc Viewer window. Windows needs no
    // packaging change — main.js writes the Explorer verb into HKCU at
    // runtime.
    extendInfo: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'Document',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['public.item', 'public.content', 'public.data'],
        },
      ],
    },
  },
  rebuildConfig: {},
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'petreluca1105-dotcom',
          name: 'docvex',
        },
        prerelease: false,
        draft: true,
      },
    },
  ],
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        // setupIcon = the icon embedded in Setup.exe.
        // iconUrl   = the icon Windows shows in Programs & Features after
        //             install; must be a real HTTPS URL the user-facing
        //             machine can fetch. Resolves once src/favicon.ico is
        //             pushed to the repo (next release commits it).
        setupIcon: 'src/favicon.ico',
        iconUrl: 'https://raw.githubusercontent.com/petreluca1105-dotcom/docvex/main/src/favicon.ico',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      // Real drag-to-Applications .dmg installer. appdmg is a macOS-only
      // native module, so this maker is scoped to darwin. `icon` is the
      // volume / installer-window icon shown in Finder; the .app bundle
      // itself gets its icon from packagerConfig.icon (src/favicon.icns).
      name: '@electron-forge/maker-dmg',
      config: {
        icon: 'src/favicon.icns',
      },
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
        // If you are familiar with Vite configuration, it will look really familiar.
        build: [
          {
            // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
            entry: 'src/main.js',
            config: 'vite.main.config.mjs',
            target: 'main',
          },
          {
            entry: 'src/preload.js',
            config: 'vite.preload.config.mjs',
            target: 'preload',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mjs',
          },
        ],
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application.
    //
    // `resetAdHocDarwinSignature` defaults to true for darwin/arm64
    // (the plugin's heuristic for "we just touched bytes, the signature
    // needs to be refreshed so Gatekeeper accepts the app on M-series
    // Macs"). That re-sign step shells out to the macOS-only `codesign`
    // binary, so on Windows / Linux it explodes inside @electron/fuses
    // with `Cannot read properties of undefined (reading 'toString')`
    // when spawnSync can't find the codesign binary. We disable it
    // when not on macOS so cross-platform `npm run make --platform=darwin`
    // produces the zips. Users on Apple Silicon will need to right-click
    // → Open the first time (or run `xattr -dr com.apple.quarantine`
    // on the .app) — for properly Gatekeeper-friendly arm64 builds,
    // run `make` on an actual Mac.
    new FusesPlugin({
      version: FuseVersion.V1,
      // On the Developer ID path, osxSign re-signs the fuse-flipped binary
      // AFTER this hook, so an ad-hoc reset here would just be overwritten —
      // turn it off. On the ad-hoc path (no identity) keep re-signing on macOS
      // so the fuse flip doesn't leave an invalid signature that Apple Silicon
      // SIGKILLs at launch.
      resetAdHocDarwinSignature: process.platform === 'darwin' && !SIGNING_MAC,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
