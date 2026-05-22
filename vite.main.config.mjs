import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// Tiny inline plugin: copy the window-icon assets next to the bundled
// main.js so BrowserWindow({ icon: path.join(__dirname, …) }) resolves in
// both dev (`__dirname` = `.vite/build/`) and packaged (`__dirname` = the
// asar entry directory holding main.js). Without this, the dev-mode window
// shows the generic Electron icon; in packaged builds the .exe's embedded
// icon already wins on Windows so this is mostly a dev-mode polish + a
// belt-and-braces for macOS/Linux where BrowserWindow.icon does matter.
//   - appicon_desktop.png — the main window's taskbar / Alt-Tab thumbnail.
//   - favicon.ico         — the in-app file-viewer popup windows.
function copyMainIcon() {
  return {
    name: 'docvex-copy-main-icon',
    apply: 'build',
    closeBundle() {
      for (const file of ['appicon_desktop.png', 'favicon.ico']) {
        try {
          const src = resolve(__dirname, 'src', file);
          const dest = resolve(__dirname, '.vite/build', file);
          // Skip when the dest already matches (same byte size) — avoids
          // a needless rewrite on every dev rebuild, which is exactly
          // when the file is locked.
          let upToDate = false;
          try {
            if (statSync(dest).size === statSync(src).size) upToDate = true;
          } catch { /* dest missing — fall through to copy */ }
          if (upToDate) continue;
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(src, dest);
        } catch (err) {
          // EBUSY / EPERM: the running app holds the live window icon
          // open, so the dest is locked during a hot rebuild. The
          // existing copy is the same asset, so this is harmless — never
          // crash the whole Forge build over an icon copy. On a fresh
          // (packaged) build nothing holds the lock, so the copy lands.
          console.warn(`[copy-main-icon] skipped ${file}: ${err?.code || err}`);
        }
      }
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  plugins: [copyMainIcon()],
});
