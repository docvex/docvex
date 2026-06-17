import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Marketing landing site (docvex.ro root). Same build solution as the rest of
// the repo: Vite + React (the Electron renderer and the web app under /app are
// also Vite). Tailwind 4 runs through @tailwindcss/vite instead of PostCSS.
//
// `npm run landing:build` emits dist/, which scripts/landing-deploy.mjs merges
// into docs/ (preserving the /app SPA and the SPA-fallback 404.html).

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // The previous marketing site now lives under docvex.ro/old/ (the new static
  // homepage in landing/home/ owns the root). Assets resolve at /old/assets/…
  base: "/old/",
  plugins: [react(), tailwindcss()],
  resolve: {
    // Mirror the "@/* -> src/*" path alias from tsconfig.json.
    alias: { "@": resolve(__dirname, "src") },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // Distinct from npm start (~5173) and web:dev (5174) so all three can run
    // at once.
    port: 5175,
    strictPort: true,
  },
});
