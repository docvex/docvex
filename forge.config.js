const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
    // Stamp a specific version into the bundle's Info.plist when building to
    // patch an existing release (scripts/fix-mac-release.mjs sets this to the
    // release's tag). Without it, electron-packager uses package.json#version.
    // Mismatched versions make the updater re-prompt forever, so the rebuilt
    // assets for vX must report vX.
    ...(process.env.DOCVEX_APP_VERSION ? { appVersion: process.env.DOCVEX_APP_VERSION } : {}),
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
      resetAdHocDarwinSignature: process.platform === 'darwin',
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
