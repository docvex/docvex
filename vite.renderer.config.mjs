import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  // The renderer only ever runs in Electron's own Chromium (Electron 42 =
  // Chromium 14x), so nothing needs transpiling down: less code to parse at
  // every launch. Compressed-size reporting only slows the build.
  build: { target: 'chrome130', reportCompressedSize: false },
  // Web Workers as ES modules (lib/paddleOcr.worker.js): the OCR runtime inside
  // one uses `import.meta`, which a classic (iife) worker has no such thing as.
  worker: { format: 'es' },
});
