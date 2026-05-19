const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
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
