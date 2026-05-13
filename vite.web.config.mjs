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

export default defineConfig({
  root: '.',
  base: '/app/',
  plugins: [react()],
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
