import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// Tiny inline plugin: copy src/favicon.ico next to the bundled main.js so
// BrowserWindow({ icon: path.join(__dirname, 'favicon.ico') }) resolves in
// both dev (`__dirname` = `.vite/build/`) and packaged (`__dirname` = the
// asar entry directory holding main.js). Without this, the dev-mode window
// shows the generic Electron icon; in packaged builds the .exe's embedded
// icon already wins on Windows so this is mostly a dev-mode polish + a
// belt-and-braces for macOS/Linux where BrowserWindow.icon does matter.
function copyMainIcon() {
  return {
    name: 'docvex-copy-main-icon',
    apply: 'build',
    closeBundle() {
      const src = resolve(__dirname, 'src/favicon.ico');
      const dest = resolve(__dirname, '.vite/build/favicon.ico');
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  plugins: [copyMainIcon()],
});
