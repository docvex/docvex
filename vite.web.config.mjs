import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Web-target Vite config. Parallel to vite.renderer.config.mjs (which is
// owned by electron-forge's @electron-forge/plugin-vite for the Electron
// renderer). Both produce a React SPA; the key differences are:
//   - This config emits to dist-web/ (separate from .vite/build/).
//   - Asset URLs and HTML <base> are prefixed /app/ so the deployed app
//     can live under docvex.ro/app without any per-page rewrites.
//   - The HTML entry is index.web.html → src/web.jsx (BrowserRouter with
//     basename="/app") rather than index.html → src/renderer.jsx
//     (MemoryRouter, which only works inside Electron's file://).
//   - VITE_APP_VERSION is inlined from package.json so the adapter's
//     getAppVersion() returns a meaningful string on the web build.

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

// Vite (with rollup) preserves the source HTML filename verbatim in the
// output, regardless of whether you pass `input` as a string or as an
// object map. We need the deployed file to be named `index.html` (the
// only basename GitHub Pages auto-serves as a directory default — any
// other name results in a 404 at /app/) so we rewrite the emitted asset
// name in generateBundle. Mirrors the copyMainIcon pattern in
// vite.main.config.mjs.
function renameHtmlEntry() {
  return {
    name: 'docvex-rename-web-html',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const keys = Object.keys(bundle);
      const htmlKey = keys.find((k) => k.endsWith('index.web.html'));
      if (!htmlKey) {
        console.warn(`[rename-web-html] no index.web.html in bundle; keys: ${keys.join(', ')}`);
        return;
      }
      const asset = bundle[htmlKey];
      const DEST = 'index.html';
      asset.fileName = DEST;
      bundle[DEST] = asset;
      delete bundle[htmlKey];
      console.log(`[rename-web-html] ${htmlKey} → ${DEST}`);
    },
  };
}

export default defineConfig({
  root: '.',
  base: '/app/',
  plugins: [react(), renameHtmlEntry()],
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.web.html'),
    },
  },
  define: {
    // Inlined string literal — accessible as import.meta.env.VITE_APP_VERSION
    // inside src/lib/platform.js's getAppVersion() web fallback.
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  server: {
    // Dev port distinct from anything electron-forge would pick — lets you
    // run `npm start` (Electron, ~5173) and `npm run web:dev` (~5174) at
    // the same time without conflict.
    port: 5174,
    strictPort: true,
  },
});
