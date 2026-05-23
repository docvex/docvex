import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static HTML export — the marketing site is served by GitHub Pages from
  // docs/ (docvex.ro root). `next build` emits a fully static site into out/,
  // which scripts/landing-deploy.mjs merges into docs/ (preserving the /app
  // web SPA and the SPA-fallback 404.html).
  output: "export",

  // GitHub Pages has no Next.js image optimizer, so next/image must emit the
  // original asset URLs untouched.
  images: { unoptimized: true },

  // Emit each route as a folder with index.html (e.g. /foo/index.html) so
  // static hosts resolve clean URLs without server rewrites.
  trailingSlash: true,

  // This project is an npm workspace member; its dependencies are hoisted into
  // the repo-root node_modules. Point the Turbopack root at the repo root so
  // those hoisted modules resolve — Turbopack won't resolve files outside root.
  turbopack: { root: path.join(__dirname, "..") },
};

export default nextConfig;
