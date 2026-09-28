import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Dev-server config for the static marketing site (`npm run site:dev`).
// The site has no build — this only serves landing/home/.

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(__dirname, 'landing', 'home'),
  server: {
    port: 5175,
    strictPort: true,
  },
});
